import * as vscode from 'vscode';
import {
  createDistinguishingLocations,
  isSameOrDescendantUri,
  isSameUri,
  mapUriThroughRenames,
} from '../files/file-identity';
import { assessFile, formatByteSize } from '../files/file-safety';
import { GitDetector } from '../git/git-detection';
import { RECOVERY_SCHEME, type RecoveryDocumentProvider } from '../recovery/recovery-document-provider';
import type { RecoveryStore } from '../recovery/recovery-store';
import type {
  PendingRestoreFormatExpectedState,
  PendingRestoreFormatMutationResult,
  PersistedPendingRestoreFormat,
  WorkspaceStorage,
} from '../state/workspace-storage';
import type { RecentComparison, RecoverySnapshot } from '../shared-types';
import { revealFileWithPublicApi } from '../explorer/reveal-file';
import type { ExtensionOutput } from '../logging/output';
import { toUserFacingErrorDetail } from '../shared/errors';
import type {
  ComparisonCommandState,
  ComparisonMode,
  ComparisonSide,
  ComparisonSnapshot,
  CopyDirection,
  FileIdentity,
  LastCopyState,
} from '../shared-types';
import { ComparisonSession } from '../state/comparison-session';
import { createDiffHunks, navigationLineForHunk, type DiffHunk } from './diff-model';
import { detectEditorSide, type ManagedEditorUris } from './focus-probe';
import { resolveHunkAtLine } from './hunk-resolver';
import {
  EDITABLE_SCHEME,
  EditableComparisonProvider,
  type EditableWriteRequest,
} from './editable-document-provider';
import { ReadonlyComparisonProvider } from './readonly-document-provider';
import { applyHunk } from '../editing/apply-hunk';
import { applyWholeFile } from '../editing/apply-whole-file';
import { t } from '../localization';
import {
  createHunkCopyConfirmationDetail,
  createWholeFileConfirmationDetail,
  type CopyConfirmationStyle,
} from '../editing/copy-description';

export const CONTEXT_KEYS = Object.freeze({
  leftSelected: 'easyLeftRightDiff.leftSelected',
  rightSelected: 'easyLeftRightDiff.rightSelected',
  bothSelected: 'easyLeftRightDiff.bothSelected',
  comparisonOpen: 'easyLeftRightDiff.comparisonOpen',
  managedDiffActive: 'easyLeftRightDiff.managedDiffActive',
  sameName: 'easyLeftRightDiff.sameName',
  normalMode: 'easyLeftRightDiff.normalMode',
  readonlyMode: 'easyLeftRightDiff.readonlyMode',
  activeLeft: 'easyLeftRightDiff.activeLeft',
  activeRight: 'easyLeftRightDiff.activeRight',
  hasLastCopy: 'easyLeftRightDiff.hasLastCopy',
  leftDirty: 'easyLeftRightDiff.leftDirty',
  rightDirty: 'easyLeftRightDiff.rightDirty',
  stale: 'easyLeftRightDiff.stale',
  hasRecent: 'easyLeftRightDiff.hasRecent',
  hasRecovery: 'easyLeftRightDiff.hasRecovery',
  hasPendingRestoreFormat: 'easyLeftRightDiff.hasPendingRestoreFormat',
});

export const CONFIRMATION_ACTIONS = Object.freeze({
  compare: t('通常比較を開始'),
  readonly: t('読み取り専用で開始'),
  swap: t('左右を入れ替える'),
  cancel: t('やめる'),
});

const COPY_ACTIONS = Object.freeze({
  execute: t('この内容でコピーする'),
  cancel: t('コピーしない'),
});

const WHOLE_COPY_ACTIONS = Object.freeze({
  execute: t('ファイル全体をコピーする'),
  cancel: t('コピーしない'),
});

const SAVE_CANCEL_ACTION = t('保存しない');
const UNDO_ACTIONS = Object.freeze({ undo: t('コピー前の状態へ戻す'), cancel: t('元に戻さず閉じる') });
const POST_COPY_ACTIONS = Object.freeze({ keep: t('コピーしたまま続ける'), undo: t('コピー前の状態へ戻す') });
const EXTERNAL_CHANGE_ACTIONS = Object.freeze({
  reload: t('現在の内容で比較を更新'),
  close: t('閉じる'),
});
const RECOVERY_FILE_READ_RETRIES = 3;
const RECOVERY_FILE_READ_RETRY_MS = 40;
const RESTORE_FORMAT_WRITE_RETRIES = 3;
const RESTORE_FORMAT_WRITE_RETRY_MS = 60;
const RETRY_RESTORE_FORMAT_ACTION = t('形式の保存を再試行');
const PENDING_RESTORE_FORMAT_RECONCILE_RETRIES = 3;
const PENDING_RESTORE_FORMAT_RECONCILE_RETRY_MS = 60;

interface CopyTextSnapshot {
  readonly targetUri: vscode.Uri;
  readonly beforeText: string;
  readonly afterText: string;
}

interface PendingInternalTextChange {
  readonly expectedText: string;
  readonly expiresAt: number;
}

interface ReviewedRecoverySnapshot {
  readonly snapshotId: string;
  readonly comparisonId: string;
  readonly targetUri: vscode.Uri;
  readonly targetText: string;
  readonly reviewedAt: number;
}

interface PreparedTargetWrite {
  readonly recovery?: {
    readonly snapshotId: string;
    readonly targetUri: vscode.Uri;
    readonly beforeBytes: Uint8Array;
  };
}

interface RecoveryByteFormat {
  readonly bytes?: Uint8Array;
  readonly text?: string;
  readonly normalizedHash: string;
  readonly eol: vscode.EndOfLine;
  readonly hasBom: boolean;
}

interface PendingRestoreFormat {
  readonly recordId: string;
  readonly revision: number;
  readonly before: RecoveryByteFormat;
  readonly restored: RecoveryByteFormat;
  readonly current: { readonly normalizedHash: string; readonly eol: vscode.EndOfLine };
  readonly targetCtime: number;
  readonly identityState: 'verified' | 'rename-pending';
  readonly savedAt: string;
}

interface PendingRestoreTargetFound {
  readonly state: 'found';
  readonly stat: vscode.FileStat;
}

interface PendingRestoreTargetMissing {
  readonly state: 'missing';
}

interface PendingRestoreTargetUnavailable {
  readonly state: 'unavailable';
  readonly error: unknown;
}

type PendingRestoreTargetProbe = PendingRestoreTargetFound | PendingRestoreTargetMissing | PendingRestoreTargetUnavailable;

export function createTransientQuickPickOptions(title: string): vscode.QuickPickOptions {
  return {
    title,
    ignoreFocusOut: false,
  };
}

export interface ComparisonUi {
  showInformationMessage(
    message: string,
    options?: vscode.MessageOptions,
    ...items: string[]
  ): Thenable<string | undefined>;
  showWarningMessage(
    message: string,
    options?: vscode.MessageOptions,
    ...items: string[]
  ): Thenable<string | undefined>;
  showErrorMessage(
    message: string,
    options?: vscode.MessageOptions,
    ...items: string[]
  ): Thenable<string | undefined>;
  showOpenDialog(options?: vscode.OpenDialogOptions): Thenable<vscode.Uri[] | undefined>;
  showInputBox(options?: vscode.InputBoxOptions): Thenable<string | undefined>;
  showQuickPick?(items: readonly string[], options?: vscode.QuickPickOptions): Thenable<string | undefined>;
  createQuickPick?<T extends vscode.QuickPickItem>(): vscode.QuickPick<T>;
  showTextDocument(
    document: vscode.TextDocument,
    options?: vscode.TextDocumentShowOptions,
  ): Thenable<vscode.TextEditor>;
}


interface FocusedQuickPickItem extends vscode.QuickPickItem {
  readonly value: string;
}

/**
 * 標準QuickPickの表示順は維持したまま、指定された行だけを初期フォーカスします。
 * createQuickPickが利用できないテストUIでは従来のshowQuickPickへ安全にフォールバックします。
 */
async function showQuickPickWithInitialFocus(
  ui: ComparisonUi,
  items: readonly string[],
  initialFocus: string | undefined,
  options: vscode.QuickPickOptions,
): Promise<string | undefined> {
  if (!ui.createQuickPick) {
    return ui.showQuickPick ? await ui.showQuickPick(items, options) : undefined;
  }

  const quickPick = ui.createQuickPick<FocusedQuickPickItem>();
  const quickPickItems = items.map((value) => ({ label: value, value }));
  quickPick.items = quickPickItems;
  quickPick.title = options.title;
  quickPick.placeholder = options.placeHolder;
  quickPick.ignoreFocusOut = options.ignoreFocusOut ?? false;
  quickPick.matchOnDescription = options.matchOnDescription ?? false;
  quickPick.matchOnDetail = options.matchOnDetail ?? false;

  const focusedItem = initialFocus
    ? quickPickItems.find((item) => item.value === initialFocus)
    : undefined;
  if (focusedItem) quickPick.activeItems = [focusedItem];

  return await new Promise<string | undefined>((resolve) => {
    let completed = false;
    let acceptDisposable: vscode.Disposable | undefined;
    let hideDisposable: vscode.Disposable | undefined;
    const cleanup = () => {
      acceptDisposable?.dispose();
      hideDisposable?.dispose();
      quickPick.dispose();
    };
    acceptDisposable = quickPick.onDidAccept(() => {
      if (completed) return;
      completed = true;
      const selected = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
      resolve(selected?.value);
      quickPick.hide();
      cleanup();
    });
    hideDisposable = quickPick.onDidHide(() => {
      if (completed) return;
      completed = true;
      resolve(undefined);
      cleanup();
    });
    quickPick.show();
  });
}

export interface ComparisonControllerOptions {
  readonly editableProvider?: EditableComparisonProvider;
  readonly highlightFile?: (uri: vscode.Uri) => void;
  readonly refreshExplorerDecorations?: () => void;
  readonly storage?: WorkspaceStorage;
  readonly gitDetector?: GitDetector;
  readonly recoveryStore?: RecoveryStore;
  readonly recoveryProvider?: RecoveryDocumentProvider;
  readonly usageGuideUri?: vscode.Uri;
}


const DIALOG_PATH_DISPLAY_WIDTH = 36;

function dialogCharacterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  // ASCIIは1桁、日本語・全角文字・絵文字などは2桁として安全側に見積もります。
  return codePoint <= 0x7f ? 1 : 2;
}

function dialogTextWidth(value: string): number {
  return [...value].reduce((total, character) => total + dialogCharacterWidth(character), 0);
}

/**
 * Quick Pickは長い1行を折り返さないため、完全なアドレスを欠けなく複数行へ分割します。
 * 日本語の全角幅も考慮し、文字列は削除・省略しません。各行を連結すると元のアドレスへ戻ります。
 */
export function wrapDialogPath(pathValue: string, maxDisplayWidth = DIALOG_PATH_DISPLAY_WIDTH): readonly string[] {
  if (maxDisplayWidth < 16) throw new Error(t('アドレス表示の1行幅が短すぎます。'));
  if (pathValue.length === 0) return [''];

  const rows: string[] = [];
  let remaining = pathValue;
  while (dialogTextWidth(remaining) > maxDisplayWidth) {
    let width = 0;
    let cut = 0;
    let preferredSlashCut = 0;
    for (const character of remaining) {
      const nextWidth = width + dialogCharacterWidth(character);
      if (nextWidth > maxDisplayWidth) break;
      width = nextWidth;
      cut += character.length;
      if ((character === '\\' || character === '/') && width >= Math.floor(maxDisplayWidth / 2)) {
        preferredSlashCut = cut;
      }
    }
    const safeCut = preferredSlashCut > 0 ? preferredSlashCut : Math.max(cut, 1);
    rows.push(remaining.slice(0, safeCut));
    remaining = remaining.slice(safeCut);
  }
  rows.push(remaining);
  return rows;
}

export function createAddressRows(side: ComparisonSide, pathValue: string): readonly string[] {
  const label = side === 'left' ? t('L・左側') : t('R・右側');
  const chunks = wrapDialogPath(pathValue);
  return chunks.map((chunk, index) => index === 0
    ? t('{0}｜{1}', label, chunk)
    : t('{0}｜{1}', ' '.repeat(label.length), chunk));
}

function locationLines(
  identity: FileIdentity,
  distinguishingLocation: string,
  label?: string,
): string[] {
  const lines = [
    t('ファイル名：{0}', identity.displayName),
    t('見分ける場所：{0}', distinguishingLocation),
    t('ワークスペース：{0}', identity.workspaceName ?? t('ワークスペース外')),
    t('完全な場所：{0}', identity.uri.fsPath),
  ];
  if (label) lines.unshift(t('補助ラベル：{0}', label));
  return lines;
}

export function createLeftSelectedMessage(identity: FileIdentity): string {
  return t('L・左側を設定しました：{0}。次にR・右側を選んでください。', identity.displayName);
}

export function createComparisonConfirmationDetail(snapshot: ComparisonSnapshot): string {
  const distinct = createDistinguishingLocations(snapshot.left, snapshot.right);
  const sameNameWarning = snapshot.sameDisplayName
    ? [t('左右は同じファイル名です。違う場所を確認してください。'), '']
    : [];
  return [
    ...sameNameWarning,
    t('【L・左側】'),
    ...locationLines(snapshot.left, distinct.left, snapshot.leftLabel),
    '',
    t('【R・右側】'),
    ...locationLines(snapshot.right, distinct.right, snapshot.rightLabel),
    '',
    t('通常比較または読み取り専用を、この画面で選んで開始します。'),
  ].join('\n');
}


export function createAddressDialogDetail(snapshot: ComparisonSnapshot): string {
  const distinct = createDistinguishingLocations(snapshot.left, snapshot.right);
  return [
    t('【見分ける部分】'),
    t('┃L・左側┃〈{0}〉', distinct.left),
    t('┃R・右側┃〈{0}〉', distinct.right),
    '',
    t('━━━━━━━━━━━━━━━━━━━━━━━━'),
    '',
    t('【L・左側の完全なアドレス】'),
    t('〈{0}〉', snapshot.left.uri.fsPath),
    '',
    t('━━━━━━━━━━━━━━━━━━━━━━━━'),
    '',
    t('【R・右側の完全なアドレス】'),
    t('〈{0}〉', snapshot.right.uri.fsPath),
  ].join('\n');
}

/**
 * クリック外・Escで閉じられる一時一覧へ表示する左右ファイル情報です。
 * 表示専用の行と、左右確認ビューを開く操作を明確に分けます。
 */
export function createComparisonInfoItems(snapshot: ComparisonSnapshot): readonly string[] {
  const distinct = createDistinguishingLocations(snapshot.left, snapshot.right);
  return [
    t('【L・左側】'),
    t('ファイル名｜{0}', snapshot.left.displayName),
    t('見分ける場所｜{0}', distinct.left),
    t('ワークスペース｜{0}', snapshot.left.workspaceName ?? t('ワークスペース外')),
    t('完全なアドレス（省略なし）'),
    ...createAddressRows('left', snapshot.left.uri.fsPath),
    t('━━━━━━━━━━━━━━━━━━━━━━━━'),
    t('【R・右側】'),
    t('ファイル名｜{0}', snapshot.right.displayName),
    t('見分ける場所｜{0}', distinct.right),
    t('ワークスペース｜{0}', snapshot.right.workspaceName ?? t('ワークスペース外')),
    t('完全なアドレス（省略なし）'),
    ...createAddressRows('right', snapshot.right.uri.fsPath),
  ];
}

export interface DifferenceSummaryCounts {
  readonly total: number;
  readonly changed: number;
  readonly added: number;
  readonly deleted: number;
}

/** L→Rとして見た差分ブロック件数を、変更・追加・削除へ分類します。 */
export function summarizeDiffHunks(hunks: readonly DiffHunk[]): DifferenceSummaryCounts {
  let changed = 0;
  let added = 0;
  let deleted = 0;
  for (const hunk of hunks) {
    if (hunk.kind === 'replacement') changed += 1;
    else if (hunk.kind === 'right-only') added += 1;
    else deleted += 1;
  }
  return Object.freeze({ total: hunks.length, changed, added, deleted });
}

function displayLineRange(start: number, end: number): string {
  if (end <= start) return t('{0}行目付近', start + 1);
  if (end - start === 1) return t('{0}行目', start + 1);
  return t('{0}～{1}行目', start + 1, end);
}

/** 差分一覧の1行です。行数ではなく、既存の安全な差分ブロック単位で表示します。 */
export function createDifferenceHunkLabel(hunk: DiffHunk): string {
  const coarse = hunk.coarse ? t('｜大きな差分') : '';
  if (hunk.kind === 'right-only') {
    return t('差分{0}｜追加｜R {1}{2}', hunk.index, displayLineRange(hunk.rightStart, hunk.rightEnd), coarse);
  }
  if (hunk.kind === 'left-only') {
    return t('差分{0}｜削除｜L {1}{2}', hunk.index, displayLineRange(hunk.leftStart, hunk.leftEnd), coarse);
  }
  return t(
    '差分{0}｜変更｜L {1} ⇔ R {2}{3}',
    hunk.index,
    displayLineRange(hunk.leftStart, hunk.leftEnd),
    displayLineRange(hunk.rightStart, hunk.rightEnd),
    coarse,
  );
}

function isUri(value: unknown): value is vscode.Uri {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { toString?: unknown }).toString === 'function'
    && typeof (value as { scheme?: unknown }).scheme === 'string',
  );
}

function isNotFoundFileError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code.toLowerCase() : '';
  const name = typeof candidate.name === 'string' ? candidate.name.toLowerCase() : '';
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return code === 'filenotfound'
    || code === 'enoent'
    || name.includes('filenotfound')
    || name.includes('entrynotfound')
    || message === 'missing'
    || message.includes('file not found')
    || message.includes('enoent');
}

function isSameFileLocation(left: vscode.Uri, right: vscode.Uri): boolean {
  return isSameUri(left, right);
}

async function assertFileResource(uri: vscode.Uri): Promise<void> {
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    throw new Error(t('フォルダーではなく、比較するファイルを選択してください。'));
  }
}

function isTextDiffInput(value: unknown): value is { original: vscode.Uri; modified: vscode.Uri } {
  if (!value || typeof value !== 'object') return false;
  const input = value as { original?: unknown; modified?: unknown };
  return isUri(input.original) && isUri(input.modified);
}

function directionSides(direction: CopyDirection): { source: ComparisonSide; target: ComparisonSide } {
  return direction === 'left-to-right'
    ? { source: 'left', target: 'right' }
    : { source: 'right', target: 'left' };
}

function sideLabel(side: ComparisonSide): string {
  return side === 'left' ? t('L・左側') : t('R・右側');
}

function recoveryReasonLabel(reason: RecoverySnapshot['reason']): string {
  switch (reason) {
    case 'before-copy': return t('コピー前の自動保存');
    case 'before-hunk-copy': return t('変更箇所のコピー前の自動保存');
    case 'before-whole-copy': return t('ファイル全体のコピー前の自動保存');
    case 'before-save': return t('ファイルへ保存する前の自動保存');
    case 'before-restore': return t('復元前の自動保存');
  }
}

function selectionLine(editor: vscode.TextEditor): number {
  return editor.selection.active.line;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function normalizeTextEol(value: string): string {
  return value.replace(/\r\n|\r/g, '\n');
}

function recoveryByteFormat(bytes: Uint8Array): RecoveryByteFormat {
  const hasBom = bytes.byteLength >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf;
  const body = hasBom ? bytes.slice(3) : bytes;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const lfCount = (text.match(/(?<!\r)\n/g) ?? []).length;
  const normalizedText = normalizeTextEol(text);
  return {
    bytes: Uint8Array.from(bytes),
    text,
    normalizedHash: normalizedTextHash(normalizedText),
    eol: crlfCount > lfCount ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF,
    hasBom,
  };
}

function normalizedTextHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function reliableFileCtime(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function createPendingRestoreRecordId(): string {
  return `restore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function bytesForDocumentFormat(document: vscode.TextDocument, hasBom: boolean): Uint8Array {
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const body = new TextEncoder().encode(normalizeTextEol(document.getText()).replace(/\n/g, eol));
  if (!hasBom) return body;
  const result = new Uint8Array(body.byteLength + 3);
  result.set([0xef, 0xbb, 0xbf], 0);
  result.set(body, 3);
  return result;
}

/** 実装2〜18の比較、安全補助、セッション、状態変化、大容量・文字コード、利用案内を管理します。 */
export class ComparisonController implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<ComparisonCommandState>();
  private diffOpenedValue = false;
  private activeSideValue: ComparisonSide | undefined;
  private managedDiffActiveValue = false;
  private lastCopyValue: LastCopyState | undefined;
  private lastUndoneCopyValue: LastCopyState | undefined;
  private lastCopyTextValue: CopyTextSnapshot | undefined;
  private lastUndoneCopyTextValue: CopyTextSnapshot | undefined;
  private leftDirtyValue = false;
  private rightDirtyValue = false;
  private locallyEditedUris = new Set<string>();
  private managedEditorUrisValue: ManagedEditorUris | undefined;
  private autoRevealTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAutoRevealKey: string | undefined;
  private staleReasonValue: string | undefined;
  private recentComparisonsValue: readonly RecentComparison[] = [];
  private recoveryCountValue = 0;
  private differenceCountValue: number | undefined;
  private differenceSummaryRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private differenceSummaryRefreshGeneration = 0;
  private internalEditDepth = 0;
  private pendingInternalTextChanges = new Map<string, PendingInternalTextChange>();
  private expectedSaveUris = new Set<string>();
  private tabReconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private tabReconcileGeneration = 0;
  private internalTabOperationDepth = 0;
  private reviewedRecoveryValue: ReviewedRecoverySnapshot | undefined;
  private pendingRestoreFormats = new Map<string, PendingRestoreFormat>();
  private pendingRestoreFormatCandidates = new Map<string, PersistedPendingRestoreFormat>();
  private pendingRestorePersistenceQueue: Promise<void> = Promise.resolve();
  public readonly onDidChangeState = this.stateEmitter.event;

  private readonly session: ComparisonSession;
  private readonly output: ExtensionOutput;
  private readonly readonlyProvider: ReadonlyComparisonProvider;
  private readonly editableProvider: EditableComparisonProvider;
  private readonly ui: ComparisonUi;
  private readonly options: ComparisonControllerOptions;

  public constructor(
    session: ComparisonSession,
    output: ExtensionOutput,
    readonlyProviderOrUi: ReadonlyComparisonProvider | ComparisonUi = new ReadonlyComparisonProvider(),
    uiOrOptions: ComparisonUi | ComparisonControllerOptions = vscode.window,
    options: ComparisonControllerOptions = {},
  ) {
    this.session = session;
    this.output = output;
    if ('createUri' in readonlyProviderOrUi && 'setContent' in readonlyProviderOrUi) {
      this.readonlyProvider = readonlyProviderOrUi;
      this.ui = uiOrOptions as ComparisonUi;
      this.options = options;
    } else {
      this.readonlyProvider = new ReadonlyComparisonProvider();
      this.ui = readonlyProviderOrUi;
      this.options = uiOrOptions as ComparisonControllerOptions;
    }
    this.editableProvider = this.options.editableProvider ?? new EditableComparisonProvider();
    this.editableProvider.setSafeWriteHandler((request) => this.handleEditableSafeWrite(request));
  }

  private persistedPendingRestoreFormat(sourceUri: string, pending: PendingRestoreFormat): PersistedPendingRestoreFormat {
    const legacy = pending as PendingRestoreFormat & {
      readonly before: RecoveryByteFormat & { readonly normalizedText?: string };
      readonly restored: RecoveryByteFormat & { readonly normalizedText?: string };
    };
    const beforeNormalizedHash = pending.before.normalizedHash
      ?? normalizedTextHash(normalizeTextEol(pending.before.text ?? legacy.before.normalizedText ?? ''));
    const restoredNormalizedHash = pending.restored.normalizedHash
      ?? normalizedTextHash(normalizeTextEol(pending.restored.text ?? legacy.restored.normalizedText ?? ''));
    return {
      sourceUri,
      recordId: pending.recordId ?? createPendingRestoreRecordId(),
      revision: pending.revision ?? 1,
      targetCtime: pending.targetCtime,
      beforeNormalizedHash,
      beforeEol: pending.before.eol,
      beforeHasBom: pending.before.hasBom,
      restoredNormalizedHash,
      restoredEol: pending.restored.eol,
      restoredHasBom: pending.restored.hasBom,
      currentNormalizedHash: pending.current?.normalizedHash ?? restoredNormalizedHash,
      currentEol: pending.current?.eol ?? pending.restored.eol,
      identityState: pending.identityState ?? 'verified',
      savedAt: pending.savedAt,
    };
  }

  private expectedPendingRestoreRevision(key: string): { readonly recordId: string; readonly revision: number } | null {
    const active = this.pendingRestoreFormats.get(key);
    if (active) return { recordId: active.recordId, revision: active.revision };
    const candidate = this.pendingRestoreFormatCandidates.get(key);
    return candidate ? { recordId: candidate.recordId, revision: candidate.revision } : null;
  }

  private syncPendingRestoreRecordFromPersisted(record: PersistedPendingRestoreFormat | undefined): void {
    if (!record) return;
    const key = record.sourceUri;
    this.pendingRestoreFormats.delete(key);
    this.pendingRestoreFormatCandidates.set(key, record);
  }

  private pendingRestoreFormatKey(sourceUri: vscode.Uri): string {
    for (const key of this.pendingRestoreFormats.keys()) {
      if (isSameUri(vscode.Uri.parse(key, true), sourceUri)) return key;
    }
    for (const key of this.pendingRestoreFormatCandidates.keys()) {
      if (isSameUri(vscode.Uri.parse(key, true), sourceUri)) return key;
    }
    return sourceUri.toString(true);
  }

  private mutatePersistedPendingRestoreFormats(
    upserts: readonly PersistedPendingRestoreFormat[],
    deletedSourceUris: readonly string[],
    expected: PendingRestoreFormatExpectedState = {},
  ): Promise<PendingRestoreFormatMutationResult | undefined> {
    const storage = this.options.storage;
    if (!storage || (upserts.length === 0 && deletedSourceUris.length === 0)) return Promise.resolve(undefined);
    let result: PendingRestoreFormatMutationResult | undefined;
    const operation = async (): Promise<void> => {
      const compatibleStorage = storage as WorkspaceStorage & {
        mutatePendingRestoreFormats?: (
          upserts: readonly PersistedPendingRestoreFormat[],
          deletedSourceUris: readonly string[],
          expected?: PendingRestoreFormatExpectedState,
        ) => Promise<PendingRestoreFormatMutationResult>;
      };
      const update = async (): Promise<void> => {
        if (typeof compatibleStorage.mutatePendingRestoreFormats === 'function') {
          result = await compatibleStorage.mutatePendingRestoreFormats(upserts, deletedSourceUris, expected);
          return;
        }
        const records = new Map(storage.loadPendingRestoreFormats().map((record) => [record.sourceUri, record]));
        const conflicts: string[] = [];
        const matches = (sourceUri: string): boolean => {
          const condition = expected[sourceUri];
          const current = records.get(sourceUri);
          if (condition === undefined) return true;
          if (condition === null) return current === undefined;
          return current?.recordId === condition.recordId && current.revision === condition.revision;
        };
        for (const sourceUri of deletedSourceUris) {
          if (matches(sourceUri)) records.delete(sourceUri);
          else conflicts.push(sourceUri);
        }
        for (const record of upserts) {
          if (matches(record.sourceUri)) records.set(record.sourceUri, record);
          else conflicts.push(record.sourceUri);
        }
        await storage.savePendingRestoreFormats([...records.values()]);
        result = {
          state: { schemaVersion: 3, generation: 0, records: [...records.values()] },
          conflicts,
        };
      };
      if (this.options.recoveryStore) await this.options.recoveryStore.runSharedTransaction(update);
      else await update();
    };
    const queued = this.pendingRestorePersistenceQueue.then(operation, operation);
    this.pendingRestorePersistenceQueue = queued.then(() => undefined, () => undefined);
    return queued.then(() => result);
  }


  private async updatePendingRestoreFormatContext(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      CONTEXT_KEYS.hasPendingRestoreFormat,
      this.pendingRestoreFormats.size > 0 || this.pendingRestoreFormatCandidates.size > 0,
    );
  }

  private async setPendingRestoreFormat(
    sourceUri: vscode.Uri,
    pending: Omit<PendingRestoreFormat, 'recordId' | 'revision'> & Partial<Pick<PendingRestoreFormat, 'recordId' | 'revision'>>,
  ): Promise<void> {
    const key = this.pendingRestoreFormatKey(sourceUri);
    const expectedRevision = this.expectedPendingRestoreRevision(key);
    const next: PendingRestoreFormat = {
      ...pending,
      recordId: pending.recordId ?? expectedRevision?.recordId ?? createPendingRestoreRecordId(),
      revision: (expectedRevision?.revision ?? 0) + 1,
    };
    const result = await this.mutatePersistedPendingRestoreFormats(
      [this.persistedPendingRestoreFormat(key, next)],
      [],
      { [key]: expectedRevision },
    );
    if (result?.conflicts.includes(key)) {
      this.syncPendingRestoreRecordFromPersisted(result.state.records.find((record) => record.sourceUri === key));
      await this.updatePendingRestoreFormatContext();
      throw new Error(t('別のウィンドウで復元形式情報が更新されたため、古い状態では上書きせず停止しました。もう一度対象を確認してください。'));
    }
    this.pendingRestoreFormatCandidates.delete(key);
    this.pendingRestoreFormats.set(key, next);
    await this.updatePendingRestoreFormatContext();
  }

  private async deletePendingRestoreFormat(sourceUri: vscode.Uri): Promise<void> {
    const key = this.pendingRestoreFormatKey(sourceUri);
    const expectedRevision = this.expectedPendingRestoreRevision(key);
    if (!expectedRevision) return;
    const result = await this.mutatePersistedPendingRestoreFormats([], [key], { [key]: expectedRevision });
    if (result?.conflicts.includes(key)) {
      const latest = result.state.records.find((record) => record.sourceUri === key);
      if (latest) this.syncPendingRestoreRecordFromPersisted(latest);
      await this.updatePendingRestoreFormatContext();
      return;
    }
    this.pendingRestoreFormats.delete(key);
    this.pendingRestoreFormatCandidates.delete(key);
    await this.updatePendingRestoreFormatContext();
  }

  private async updatePendingRestoreCandidate(
    current: PersistedPendingRestoreFormat,
    changes: Omit<Partial<PersistedPendingRestoreFormat>, 'sourceUri' | 'recordId' | 'revision'>,
  ): Promise<PersistedPendingRestoreFormat | undefined> {
    const next: PersistedPendingRestoreFormat = {
      ...current,
      ...changes,
      revision: current.revision + 1,
    };
    const expected = { [current.sourceUri]: { recordId: current.recordId, revision: current.revision } };
    const result = await this.mutatePersistedPendingRestoreFormats([next], [], expected);
    if (result?.conflicts.includes(current.sourceUri)) {
      this.syncPendingRestoreRecordFromPersisted(result.state.records.find((record) => record.sourceUri === current.sourceUri));
      return undefined;
    }
    this.pendingRestoreFormatCandidates.set(current.sourceUri, next);
    return next;
  }

  private pendingRestoreFormatFromPersisted(item: PersistedPendingRestoreFormat): PendingRestoreFormat {
    return {
      recordId: item.recordId,
      revision: item.revision,
      before: {
        normalizedHash: item.beforeNormalizedHash,
        eol: item.beforeEol,
        hasBom: item.beforeHasBom,
      },
      restored: {
        normalizedHash: item.restoredNormalizedHash,
        eol: item.restoredEol,
        hasBom: item.restoredHasBom,
      },
      current: {
        normalizedHash: item.currentNormalizedHash ?? item.restoredNormalizedHash,
        eol: item.currentEol ?? item.restoredEol,
      },
      targetCtime: item.targetCtime,
      identityState: item.identityState ?? 'verified',
      savedAt: item.savedAt,
    };
  }

  private async probePendingRestoreTarget(sourceUri: vscode.Uri): Promise<PendingRestoreTargetProbe> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PENDING_RESTORE_FORMAT_RECONCILE_RETRIES; attempt += 1) {
      try {
        return { state: 'found', stat: await vscode.workspace.fs.stat(sourceUri) };
      } catch (error) {
        if (isNotFoundFileError(error)) return { state: 'missing' };
        lastError = error;
        if (attempt + 1 < PENDING_RESTORE_FORMAT_RECONCILE_RETRIES) {
          await new Promise<void>((resolve) => setTimeout(resolve, PENDING_RESTORE_FORMAT_RECONCILE_RETRY_MS));
        }
      }
    }
    return { state: 'unavailable', error: lastError };
  }

  private documentMatchesPersistedRestoreFormat(
    document: vscode.TextDocument,
    item: PersistedPendingRestoreFormat,
  ): boolean {
    const currentHash = normalizedTextHash(normalizeTextEol(document.getText()));
    const matchesCurrent = currentHash === item.currentNormalizedHash && document.eol === item.currentEol;
    const matchesRestored = currentHash === item.restoredNormalizedHash && document.eol === item.restoredEol;
    const matchesBefore = currentHash === item.beforeNormalizedHash && document.eol === item.beforeEol;
    return matchesCurrent || matchesRestored || matchesBefore;
  }

  private async reconcilePendingRestoreFormatCandidate(
    item: PersistedPendingRestoreFormat,
    preferredDocument?: vscode.TextDocument,
  ): Promise<'active' | 'waiting' | 'discarded'> {
    const sourceUri = vscode.Uri.parse(item.sourceUri, true);
    const key = this.pendingRestoreFormatKey(sourceUri);
    if (sourceUri.scheme !== 'file') return 'discarded';
    const target = await this.probePendingRestoreTarget(sourceUri);
    if (target.state === 'unavailable') return 'waiting';
    if (item.identityState === 'rename-pending') {
      if (target.state !== 'found' || !reliableFileCtime(target.stat.ctime)) return 'waiting';
      const updated = await this.updatePendingRestoreCandidate(item, {
        targetCtime: target.stat.ctime,
        identityState: 'verified',
        savedAt: new Date().toISOString(),
      });
      if (!updated) return 'waiting';
      item = updated;
    } else if (target.state === 'missing' || !reliableFileCtime(target.stat.ctime) || target.stat.ctime !== item.targetCtime) {
      return 'discarded';
    }
    const relatedDocuments = vscode.workspace.textDocuments.filter((document) =>
      isSameUri(this.sourceUriForDocument(document), sourceUri));
    if (preferredDocument
      && isSameUri(this.sourceUriForDocument(preferredDocument), sourceUri)
      && !relatedDocuments.includes(preferredDocument)) {
      relatedDocuments.unshift(preferredDocument);
    }
    if (relatedDocuments.length === 0) return 'waiting';
    const matching = relatedDocuments.filter((document) => this.documentMatchesPersistedRestoreFormat(document, item));
    if (matching.length === 0) {
      // Hot Exitの未保存内容だけでなく、形式書込みだけ失敗して本文は保存済みの文書も再照合します。
      // 同じ対象識別でも本文が保存時の識別ハッシュと一致しない場合は、古い形式情報を適用しません。
      return 'discarded';
    }
    this.pendingRestoreFormatCandidates.delete(key);
    this.pendingRestoreFormats.set(key, this.pendingRestoreFormatFromPersisted(item));
    return 'active';
  }

  private async restorePendingRestoreFormatsFromStorage(): Promise<void> {
    const storage = this.options.storage;
    if (!storage) return;
    const compatibleStorage = storage as WorkspaceStorage & {
      loadPendingRestoreFormatsFresh?: () => Promise<{ readonly records: readonly PersistedPendingRestoreFormat[] }>;
    };
    const state = typeof compatibleStorage.loadPendingRestoreFormatsFresh === 'function'
      ? await compatibleStorage.loadPendingRestoreFormatsFresh()
      : { records: storage.loadPendingRestoreFormats() };
    const persisted = state.records;
    this.pendingRestoreFormatCandidates.clear();
    for (const item of persisted) this.pendingRestoreFormatCandidates.set(item.sourceUri, item);
    for (const item of persisted) {
      if (await this.reconcilePendingRestoreFormatCandidate(item) === 'discarded') {
        await this.deletePendingRestoreFormat(vscode.Uri.parse(item.sourceUri, true));
      }
    }
  }

  public async handleTextDocumentOpened(document: vscode.TextDocument): Promise<void> {
    const sourceUri = this.sourceUriForDocument(document);
    const candidate = this.pendingRestoreFormatCandidates.get(this.pendingRestoreFormatKey(sourceUri));
    if (!candidate) return;
    const result = await this.reconcilePendingRestoreFormatCandidate(candidate, document);
    if (result === 'discarded') await this.deletePendingRestoreFormat(vscode.Uri.parse(candidate.sourceUri, true));
    await this.updatePendingRestoreFormatContext();
  }

  public async initialize(): Promise<void> {
    const staleRecoveryTabs = this.recoveryComparisonTabCount();
    if (staleRecoveryTabs > 0) {
      if (await this.closeRecoveryComparisonTabs()) {
        void this.ui.showInformationMessage(
          t('前回のセッションから復元された古い復元履歴の比較タブを{0}件閉じました。必要な履歴をもう一度開いてください。', staleRecoveryTabs),
        );
      } else {
        void this.ui.showWarningMessage(
          t('前回のセッションから復元された古い復元履歴の比較タブを閉じられませんでした。手動で閉じてから履歴を開き直してください。'),
        );
      }
    }
    const storage = this.options.storage;
    if (storage) {
      const persisted = storage.load();
      this.recentComparisonsValue = persisted.recentComparisons;
      // 比較画面がないのにL・Rだけが残る混乱を避けるため、前回セッションは復元しません。
      if (persisted.previousSession) await storage.saveSession(undefined);
      await this.restorePendingRestoreFormatsFromStorage();
    }
    if (this.options.recoveryStore) {
      await this.options.recoveryStore.initialize();
      const integrity = await this.options.recoveryStore.getIntegrityStatus();
      this.recoveryCountValue = await this.options.recoveryStore.count();
      if (!integrity.available) {
        void this.ui.showWarningMessage(
          t('復元履歴の保存情報を安全に読み取れないため、復元履歴機能を停止しました。比較の表示は利用できますが、ファイル内容を変更する操作は安全な復元履歴を作成できないため実行できません。'),
        );
      } else {
        if (integrity.restoredFromBackup) {
          void this.ui.showInformationMessage(t('復元履歴の保存情報をバックアップから復旧しました。'));
        }
        if (integrity.quarantinedCount > 0) {
          void this.ui.showWarningMessage(
            t('破損または不正な復元履歴を{0}件使用停止しました。他の正常な復元履歴は保持しています。', integrity.quarantinedCount),
          );
        }
      }
    }
    await this.publishState();
  }

  public getSessionSnapshot(): ComparisonSnapshot | undefined {
    try {
      return this.session.snapshot();
    } catch {
      return undefined;
    }
  }

  public getManagedEditorUris(): ManagedEditorUris | undefined {
    return this.managedEditorUrisValue;
  }

  public getState(): ComparisonCommandState {
    const left = this.session.left;
    const right = this.session.right;
    return Object.freeze({
      left,
      right,
      leftLabel: this.session.leftLabel,
      rightLabel: this.session.rightLabel,
      sameDisplayName: Boolean(left && right && left.displayName === right.displayName),
      mode: this.session.mode,
      diffOpened: this.diffOpenedValue,
      activeSide: this.activeSideValue,
      lastCopy: this.lastCopyValue,
      leftDirty: this.leftDirtyValue,
      rightDirty: this.rightDirtyValue,
      staleReason: this.staleReasonValue,
      recentComparisonCount: this.recentComparisonsValue.length,
      recoveryCount: this.recoveryCountValue,
      differenceCount: this.differenceCountValue,
    });
  }

  public async handleActiveEditor(editor: vscode.TextEditor | undefined, reason: string): Promise<void> {
    const snapshot = this.getSessionSnapshot();
    const next = snapshot ? detectEditorSide(editor, snapshot, this.managedEditorUrisValue) : undefined;
    const nextManagedDiffActive = Boolean(snapshot && this.diffOpenedValue && this.isManagedDiffTabActive(snapshot));
    if (next === this.activeSideValue && nextManagedDiffActive === this.managedDiffActiveValue) return;
    this.activeSideValue = next;
    this.managedDiffActiveValue = nextManagedDiffActive;
    await this.publishState();
    this.output.info(t('現在操作中の側を更新しました。reason={0} side={1} managed={2}', reason, next ?? t('判定待ち'), nextManagedDiffActive));
    // 比較を開いた直後のactive-editor通知や定期確認ではExplorerへフォーカスを奪いません。
    // 自動場所表示は、利用者が実際にカーソル移動またはスクロールした時だけ実行します。
    if (
      this.internalTabOperationDepth === 0
      && (reason === 'selection' || reason === 'visible-ranges')
    ) this.scheduleAutoReveal(next);
  }

  public async setLeft(resource?: unknown): Promise<boolean> {
    try {
      const uri = await this.resolveFileResource(resource, t('L・左側に設定するファイルを選択'));
      if (!uri) return false;
      await assertFileResource(uri);

      // 現在のLをもう一度選んだだけなら、比較タブと管理状態をそのまま維持します。
      if (this.session.left && isSameUri(this.session.left.uri, uri)) return true;
      if (!await this.confirmReplacingExistingSession(uri)) return false;

      this.session.setLeft(uri);
      this.resetManagedState();
      await this.refreshDirtyState();
      await this.publishState();
      const identity = this.session.left;
      if (!identity) throw new Error(t('L・左側ファイルの状態を確認できませんでした。'));
      this.output.info(t('L・左側を設定しました。uri={0}', identity.uri.toString(true)));
      vscode.window.setStatusBarMessage(createLeftSelectedMessage(identity), 5000);
      return true;
    } catch (error) {
      this.reportError(t('L・左側を設定できませんでした。'), error);
      return false;
    }
  }

  public async compareWithRight(resource?: unknown): Promise<boolean> {
    try {
      const uri = await this.resolveFileResource(resource, t('R・右側に設定するファイルを選択'));
      if (!uri) return false;
      await assertFileResource(uri);

      if (this.session.left && isSameUri(this.session.left.uri, uri)) {
        throw new Error(t('L・左側とR・右側に同じファイルは設定できません。'));
      }
      // すでに比較中なら、古いタブを管理外へ残さず「Rを変更」と同じ安全経路を使います。
      if (this.session.right) {
        if (isSameUri(this.session.right.uri, uri)) return true;
        return await this.changeSide('right', uri);
      }

      this.session.setRight(uri);
      this.resetManagedState();
      await this.refreshDirtyState();
      await this.publishState();
      return await this.confirmAndOpen();
    } catch (error) {
      this.reportError(t('R・右側を設定して比較できませんでした。'), error);
      return false;
    }
  }

  /** Explorerの複数選択またはファイル選択画面から2ファイルを受け取り、利用者がLを明示してから比較します。 */
  public async compareSelectedFiles(resource?: unknown, selectedResources?: unknown): Promise<boolean> {
    try {
      const candidates: vscode.Uri[] = [];
      const append = (value: unknown): void => {
        if (isUri(value)) candidates.push(value);
        else if (Array.isArray(value)) {
          for (const item of value) if (isUri(item)) candidates.push(item);
        }
      };
      append(selectedResources);
      append(resource);
      let unique = candidates.filter((uri, index, values) =>
        values.findIndex((other) => isSameUri(other, uri)) === index
      );

      // 単一ファイルの右クリックから起動した場合は、そのファイルを1つ目として維持し、
      // 利用者には比較相手となるもう1ファイルだけを選んでもらいます。
      if (unique.length === 1) {
        const firstFile = unique[0] as vscode.Uri;
        const proceed = await this.ui.showInformationMessage(
          t('1個目のファイルは選択済みです。'),
          {
            modal: true,
            detail: [
              t('1個目：{0}', firstFile.fsPath),
              '',
              t('次のファイル選択画面では、比較する2個目のファイルを1つ選んでください。'),
            ].join('\n'),
          },
          t('2個目のファイルを選ぶ'),
          t('やめる'),
        );
        if (proceed !== t('2個目のファイルを選ぶ')) return false;

        const selected = await this.ui.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: t('2個目として比較するファイルを選択'),
          title: t('2個目のファイルを選択してください（1個目は選択済みです）'),
        });
        if (!selected) return false;
        unique = [...unique, ...selected].filter((uri, index, values) =>
          values.findIndex((other) => isSameUri(other, uri)) === index
        );
      } else if (unique.length !== 2) {
        const selected = await this.ui.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: t('比較する2ファイルを選択'),
          title: t('左右比較する2ファイルを選択してください'),
        });
        if (!selected) return false;
        unique = selected.filter((uri, index, values) =>
          values.findIndex((other) => isSameUri(other, uri)) === index
        );
      }
      if (unique.length !== 2) {
        throw new Error(t('比較する2ファイルを正しく取得できませんでした。同じフォルダー内などでは、Ctrlを押しながら比較する2ファイルだけを選択してから、もう一度実行してください。選択がうまくいかない場合や別フォルダーのファイルを比較する場合は、L・左側とR・右側を1ファイルずつ設定してください。'));
      }
      await Promise.all(unique.map((uri) => assertFileResource(uri)));
      const [first, second] = unique as [vscode.Uri, vscode.Uri];
      const firstLabel = t('L・左側にする：{0}', first.fsPath);
      const secondLabel = t('L・左側にする：{0}', second.fsPath);
      const choice = this.ui.showQuickPick
        ? await this.ui.showQuickPick(
          [firstLabel, secondLabel, t('やめる')],
          createTransientQuickPickOptions(t('どちらをL・左側にするか選択')),
        )
        : undefined;
      if (!choice || choice === t('やめる')) return false;
      const left = choice === firstLabel ? first : second;
      const right = choice === firstLabel ? second : first;

      const current = this.getSessionSnapshot();
      if (current) {
        const action = await this.ui.showWarningMessage(
          t('現在の左右比較を終了して、選択した2ファイルの比較を開始しますか？'),
          { modal: true, detail: t('現在：L｜{0} ⇔ R｜{1}', current.left.relativePath, current.right.relativePath) },
          t('現在の比較を終了して開始'),
          t('やめる'),
        );
        if (action !== t('現在の比較を終了して開始')) return false;
        if (!await this.closeCurrentManagedDiffTabs()) return false;
      }
      this.session.clear();
      this.session.setLeft(left);
      this.session.setRight(right);
      this.resetManagedState();
      await this.refreshDirtyState();
      await this.publishState();
      return await this.confirmAndOpen();
    } catch (error) {
      this.reportError(t('選択した2ファイルを左右比較できませんでした。'), error);
      return false;
    }
  }

  public async changeSide(side: ComparisonSide, resource?: unknown): Promise<boolean> {
    try {
      const uri = await this.resolveFileResource(
        resource,
        side === 'left' ? t('L・左側に変更するファイルを選択') : t('R・右側に変更するファイルを選択'),
      );
      if (!uri) return false;
      await assertFileResource(uri);

      const current = side === 'left' ? this.session.left : this.session.right;
      const opposite = side === 'left' ? this.session.right : this.session.left;
      // 同じ側を再選択しただけなら、現在の比較を閉じたり状態を初期化したりしません。
      if (current && isSameUri(current.uri, uri)) return true;
      // 反対側と同じファイルは、現在の比較タブを閉じる前に拒否します。
      if (opposite && isSameUri(opposite.uri, uri)) {
        throw new Error(t('L・左側とR・右側に同じファイルは設定できません。'));
      }

      if (!await this.closeCurrentManagedDiffTabs()) return false;
      if (side === 'left') this.session.setLeft(uri);
      else this.session.setRight(uri);
      this.resetManagedState();
      await this.publishState();
      this.output.info(t('{0}ファイルを変更しました。', sideLabel(side)));
      if (this.session.left && this.session.right) return this.confirmAndOpen();
      return true;
    } catch (error) {
      this.reportError(t('{0}を変更できませんでした。', sideLabel(side)), error);
      return false;
    }
  }

  public async clearSide(side: ComparisonSide): Promise<void> {
    if (!await this.closeCurrentManagedDiffTabs()) return;
    this.session.clearSide(side);
    this.resetManagedState();
    await this.publishState();
    this.output.info(t('{0}の設定を解除しました。', sideLabel(side)));
  }

  public async clearAll(): Promise<void> {
    if (!await this.closeCurrentManagedDiffTabs()) return;
    this.session.clear();
    this.resetManagedState();
    await this.publishState();
    this.output.info(t('L・R設定をすべて解除しました。'));
  }

  public async setLabel(side: ComparisonSide): Promise<boolean> {
    try {
      const current = side === 'left' ? this.session.leftLabel : this.session.rightLabel;
      const value = await this.ui.showInputBox({
        title: t('{0}の補助ラベル', sideLabel(side)),
        prompt: t('識別しやすくする補助表示です。比較処理の判断には使用しません。空欄で解除します。'),
        placeHolder: t('修正前、修正後、元、新、バックアップ など'),
        value: current ?? '',
        ignoreFocusOut: false,
      });
      if (value === undefined) return false;
      const reopen = this.diffOpenedValue;
      if (reopen && !await this.closeCurrentManagedDiffTabs()) return false;
      if (reopen) this.resetManagedState();
      this.session.setLabel(side, value);
      await this.publishState();
      if (this.session.left && this.session.right && reopen) return await this.openDiff();
      return true;
    } catch (error) {
      this.reportError(t('補助ラベルを設定できませんでした。'), error);
      return false;
    }
  }

  public async swapSides(): Promise<boolean> {
    try {
      const reopen = this.diffOpenedValue;
      if (reopen && !await this.closeCurrentManagedDiffTabs()) return false;
      if (reopen) this.resetManagedState();
      this.session.swap();
      this.activeSideValue = undefined;
      this.clearCopyHistory();
      await this.publishState();
      this.output.info(t('L・左側とR・右側を入れ替えました。'));
      if (reopen) return await this.openDiff();
      return true;
    } catch (error) {
      this.reportError(t('左右を入れ替えられませんでした。'), error);
      return false;
    }
  }

  public async switchMode(targetMode?: ComparisonMode): Promise<boolean> {
    if (!this.session.left || !this.session.right) return false;
    const next: ComparisonMode = targetMode ?? (this.session.mode === 'normal' ? 'readonly' : 'normal');
    if (next === this.session.mode) return true;
    const reopen = this.diffOpenedValue;
    if (reopen && !await this.closeCurrentManagedDiffTabs()) return false;
    if (reopen) this.resetManagedState();
    this.session.setMode(next);
    this.clearCopyHistory();
    const opened = await this.openDiff();
    if (!opened) return false;
    vscode.window.setStatusBarMessage(
      next === 'readonly' ? t('左右比較を読み取り専用へ切り替えました。') : t('左右比較を通常比較へ切り替えました。'),
      4000,
    );
    return true;
  }

  public async reopenComparison(): Promise<boolean> {
    try {
      return await this.openDiff();
    } catch (error) {
      this.reportError(t('比較を開き直せませんでした。'), error);
      return false;
    }
  }

  public async showComparisonInfo(): Promise<boolean> {
    try {
      const snapshot = this.session.snapshot();
      const openViewLabel = t('左右確認ビューを開く');
      const items = [...createComparisonInfoItems(snapshot), openViewLabel];
      const initialFocus = this.activeSideValue === 'right'
        ? t('【R・右側】')
        : t('【L・左側】');
      const action = await showQuickPickWithInitialFocus(this.ui, items, initialFocus, {
        ...createTransientQuickPickOptions(t('左右ファイル情報を表示')),
        placeHolder: t('確認だけの場合は、Escまたは他の場所をクリックして閉じます。'),
      });
      if (action === openViewLabel) {
        await vscode.commands.executeCommand('easyLeftRightDiff.leftRightView.focus');
      }
      return true;
    } catch (error) {
      this.reportError(t('左右ファイル情報を表示できませんでした。'), error);
      return false;
    }
  }


  public async showAddressDialog(): Promise<boolean> {
    try {
      const snapshot = this.session.snapshot();
      const openViewLabel = t('左右確認ビューも開く');
      const items = [
        t('【L・左側の完全なアドレス｜省略なし】'),
        ...createAddressRows('left', snapshot.left.uri.fsPath),
        t('━━━━━━━━━━━━━━━━━━━━━━━━'),
        t('【R・右側の完全なアドレス｜省略なし】'),
        ...createAddressRows('right', snapshot.right.uri.fsPath),
        openViewLabel,
      ];
      const action = this.ui.showQuickPick
        ? await this.ui.showQuickPick(items, {
          ...createTransientQuickPickOptions(t('左右のアドレスを確認')),
          placeHolder: t('確認だけの場合は、Escまたは他の場所をクリックして閉じます。'),
        })
        : undefined;
      if (action === openViewLabel) {
        await vscode.commands.executeCommand('easyLeftRightDiff.leftRightView.focus');
      }
      return true;
    } catch (error) {
      this.reportError(t('左右のアドレスを表示できませんでした。'), error);
      return false;
    }
  }

  public async showUsageGuide(): Promise<boolean> {
    const usageGuideUri = this.options.usageGuideUri;
    if (!usageGuideUri) return false;
    try {
      const document = await vscode.workspace.openTextDocument(usageGuideUri);
      try {
        await vscode.commands.executeCommand('markdown.showPreview', document.uri);
      } catch {
        await this.ui.showTextDocument(document, { preview: false, preserveFocus: false });
      }
      return true;
    } catch (error) {
      this.reportError(t('使い方を表示できませんでした。'), error);
      return false;
    }
  }

  public async revealSide(side: ComparisonSide): Promise<boolean> {
    try {
      const identity = this.requireIdentity(side);
      const result = await revealFileWithPublicApi(identity.uri);
      if (result.workspaceScope === 'inside-workspace') this.options.highlightFile?.(identity.uri);
      this.output.info(t('{0}の場所表示を実行しました。status={1}', sideLabel(side), result.status));
      return true;
    } catch (error) {
      this.reportError(t('ファイルの場所を表示できませんでした。'), error);
      return false;
    }
  }

  public async openSide(side: ComparisonSide): Promise<boolean> {
    try {
      const identity = this.requireIdentity(side);
      // 「ファイルを開く」は比較表示用の代理文書ではなく、実際の元ファイルを通常エディターで開きます。
      const document = await vscode.workspace.openTextDocument(identity.uri);
      await this.ui.showTextDocument(document, { preview: false, preserveFocus: false });
      return true;
    } catch (error) {
      this.reportError(t('ファイルを開けませんでした。'), error);
      return false;
    }
  }

  /** 左下の左右確認ビューを開き、全操作を確認できる状態にします。 */
  public async openControlMenu(): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('easyLeftRightDiff.leftRightView.focus');
      return true;
    } catch (error) {
      this.reportError(t('左右確認メニューを開けませんでした。'), error);
      return false;
    }
  }

  /**
   * ExplorerのFileDecoration色・バッジ設定を確認し、利用者が選んだ場合だけ有効化します。
   * VS Code／Cursor側で色表示が無効な場合、Providerが正しく色を返していてもL/R色は表示されません。
   */
  public async enableExplorerDecorationColors(): Promise<boolean> {
    try {
      const resource = this.session.left?.uri ?? this.session.right?.uri ?? vscode.window.activeTextEditor?.document.uri;
      const configuration = vscode.workspace.getConfiguration('explorer', resource);
      const colorsEnabled = configuration.get<boolean>('decorations.colors', true);
      const badgesEnabled = configuration.get<boolean>('decorations.badges', true);

      if (colorsEnabled && badgesEnabled) {
        this.options.refreshExplorerDecorations?.();
        await this.ui.showInformationMessage(
          t('ExplorerのL/R色表示とバッジ表示は、VS Code／Cursorの設定で有効になっています。テーマによって色の見え方は異なります。'),
        );
        return true;
      }

      const enableLabel = t('L/R色表示を有効にする');
      const cancelLabel = t('変更しない');
      const action = await this.ui.showWarningMessage(
        t('ExplorerのL/R色表示が、VS Code／Cursorの設定で無効になっています。'),
        {
          modal: true,
          detail: [
            t('色表示：{0}', colorsEnabled ? t('有効') : t('無効')),
            t('L/Rバッジ表示：{0}', badgesEnabled ? t('有効') : t('無効')),
            '',
            t('有効にすると、ExplorerのL・左側ファイルとR・右側ファイルへ補助色とL/Rバッジを表示します。'),
            t('比較内容やファイル内容は変更しません。'),
          ].join('\n'),
        },
        enableLabel,
        cancelLabel,
      );
      if (action !== enableLabel) return false;

      await this.enableEffectiveConfigurationValue(configuration, 'decorations.colors');
      await this.enableEffectiveConfigurationValue(configuration, 'decorations.badges');

      // 上位スコープのfalseが残っていないか、更新後の実効値を必ず再確認します。
      const refreshed = vscode.workspace.getConfiguration('explorer', resource);
      const effectiveColors = refreshed.get<boolean>('decorations.colors', true);
      const effectiveBadges = refreshed.get<boolean>('decorations.badges', true);
      if (!effectiveColors || !effectiveBadges) {
        await this.ui.showWarningMessage(
          t('ExplorerのL/R色表示設定を有効にできませんでした。ワークスペースまたはフォルダー固有の設定を確認してください。'),
        );
        return false;
      }

      this.options.refreshExplorerDecorations?.();
      await this.ui.showInformationMessage(
        t('ExplorerのL/R色表示を有効にしました。表示が更新されない場合は、Explorerを一度閉じて開くか、ウィンドウを再読み込みしてください。'),
      );
      return true;
    } catch (error) {
      this.reportError(t('ExplorerのL/R色表示設定を変更できませんでした。'), error);
      return false;
    }
  }

  private async enableEffectiveConfigurationValue(
    configuration: vscode.WorkspaceConfiguration,
    key: 'decorations.colors' | 'decorations.badges',
  ): Promise<void> {
    const inspected = configuration.inspect<boolean>(key);
    if (inspected?.workspaceFolderValue === false) {
      await configuration.update(key, true, vscode.ConfigurationTarget.WorkspaceFolder);
      return;
    }
    if (inspected?.workspaceValue === false) {
      await configuration.update(key, true, vscode.ConfigurationTarget.Workspace);
      return;
    }
    if (inspected?.globalValue === false || configuration.get<boolean>(key, true) === false) {
      await configuration.update(key, true, vscode.ConfigurationTarget.Global);
    }
  }

  public async copyCurrentHunk(direction: CopyDirection): Promise<boolean> {
    let prepared: PreparedTargetWrite | undefined;
    let targetDocument: vscode.TextDocument | undefined;
    let targetTextBeforeEdit: string | undefined;
    try {
      this.assertNormalMode();
      const snapshot = this.session.snapshot();
      const editor = vscode.window.activeTextEditor;
      const activeSide = detectEditorSide(editor, snapshot, this.managedEditorUrisValue);
      if (!editor || !activeSide || !this.isManagedDiffTabActive(snapshot)) {
        throw new Error(t('本ツールで開いた標準差分画面のL・左側またはR・右側をクリックし、コピーする変更箇所へカーソルを置いてください。'));
      }

      const leftDocument = await this.openComparisonDocument('left', snapshot);
      const rightDocument = await this.openComparisonDocument('right', snapshot);
      const leftText = leftDocument.getText();
      const rightText = rightDocument.getText();
      const hunks = createDiffHunks(leftText, rightText);
      const resolution = resolveHunkAtLine(hunks, activeSide, selectionLine(editor));
      if (resolution.status !== 'resolved' || !resolution.hunk) {
        throw new Error(
          resolution.status === 'ambiguous'
            ? t('現在のカーソル位置から変更箇所を一意に特定できないため、安全のためコピーしませんでした。')
            : t('カーソルが変更箇所の中にありません。コピーする変更箇所へカーソルを移動してください。'),
        );
      }

      const hunk = resolution.hunk;
      const style = vscode.workspace.getConfiguration('easyLeftRightDiff').get<CopyConfirmationStyle>(
        'copyConfirmation',
        'compact',
      );
      const action = await this.ui.showWarningMessage(
        direction === 'left-to-right'
          ? t('L・左側の現在の変更をR・右側へコピーしますか？')
          : t('R・右側の現在の変更をL・左側へコピーしますか？'),
        { modal: true, detail: createHunkCopyConfirmationDetail(snapshot, hunk, direction, style) },
        COPY_ACTIONS.execute,
        COPY_ACTIONS.cancel,
      );
      if (action !== COPY_ACTIONS.execute) return false;

      const latestLeft = await this.openComparisonDocument('left', snapshot);
      const latestRight = await this.openComparisonDocument('right', snapshot);
      if (
        latestLeft.version !== leftDocument.version
        || latestRight.version !== rightDocument.version
        || latestLeft.getText() !== leftText
        || latestRight.getText() !== rightText
      ) {
        throw new Error(t('確認中にファイル内容が変更されたため、古い差分情報は使用せずコピーを停止しました。'));
      }

      const confirmedCopyState = Object.freeze({
        leftText,
        rightText,
        leftVersion: latestLeft.version,
        rightVersion: latestRight.version,
      });
      const { source, target } = directionSides(direction);
      const sourceDocument = source === 'left' ? latestLeft : latestRight;
      targetDocument = target === 'left' ? latestLeft : latestRight;
      targetTextBeforeEdit = target === 'left' ? confirmedCopyState.leftText : confirmedCopyState.rightText;
      const preparation = await this.prepareTargetWrite(target, targetDocument, 'before-hunk-copy');
      if (!preparation) return false;
      prepared = preparation;
      await this.assertConfirmedCopyState(snapshot, confirmedCopyState, t('コピー準備中にファイル内容が変更されたため、確認済みでない内容はコピーしませんでした。'));
      this.internalEditDepth += 1;
      let applied = false;
      try {
        applied = await applyHunk(snapshot, hunk, direction, this.managedEditorUrisValue, confirmedCopyState);
      } finally {
        this.internalEditDepth -= 1;
      }
      if (!applied) throw new Error(t('VS Codeの標準編集APIが変更を適用できませんでした。'));
      await this.commitPreparedRecovery(prepared);
      prepared = undefined;
      const targetTextAfterEdit = targetDocument.getText();
      this.expectInternalTextChange(targetDocument, targetTextAfterEdit);
      this.lastCopyValue = {
        targetSide: target,
        targetUri: targetDocument.uri,
        targetVersionAfterEdit: targetDocument.version,
        sourceVersionAtEdit: sourceDocument.version,
        kind: 'hunk',
        hunkIndex: hunk.index,
      };
      this.lastCopyTextValue = { targetUri: targetDocument.uri, beforeText: targetTextBeforeEdit, afterText: targetTextAfterEdit };
      this.lastUndoneCopyValue = undefined;
      this.lastUndoneCopyTextValue = undefined;
      this.setDirtyState(target, targetDocument.isDirty);
      await this.publishState();
      const afterHunks = createDiffHunks(latestLeft.getText(), latestRight.getText());
      await this.showPostCopyActions(direction, hunk, afterHunks.length < hunks.length);
      return true;
    } catch (error) {
      if (prepared) {
        try {
          await this.rollbackOrKeepPreparedRecovery(
            prepared,
            targetDocument !== undefined && targetTextBeforeEdit !== undefined && targetDocument.getText() !== targetTextBeforeEdit,
          );
        } catch (recoveryError) {
          this.output.error(t('操作失敗後の復元履歴を整理できませんでした。'), recoveryError);
        }
      }
      this.reportError(t('現在の変更箇所をコピーできませんでした。'), error);
      return false;
    }
  }

  public async copyWholeFile(direction: CopyDirection): Promise<boolean> {
    let prepared: PreparedTargetWrite | undefined;
    let targetDocument: vscode.TextDocument | undefined;
    let targetTextBeforeEdit: string | undefined;
    try {
      this.assertNormalMode();
      const snapshot = this.session.snapshot();
      const leftDocument = await this.openComparisonDocument('left', snapshot);
      const rightDocument = await this.openComparisonDocument('right', snapshot);
      const sourceDocument = direction === 'left-to-right' ? leftDocument : rightDocument;
      targetDocument = direction === 'left-to-right' ? rightDocument : leftDocument;
      const leftText = leftDocument.getText();
      const rightText = rightDocument.getText();
      const action = await this.ui.showWarningMessage(
        direction === 'left-to-right'
          ? t('L・左側ファイル全体をR・右側へコピーしますか？')
          : t('R・右側ファイル全体をL・左側へコピーしますか？'),
        {
          modal: true,
          detail: createWholeFileConfirmationDetail(
            snapshot,
            direction,
            sourceDocument.getText().length,
            targetDocument.getText().length,
          ),
        },
        WHOLE_COPY_ACTIONS.execute,
        WHOLE_COPY_ACTIONS.cancel,
      );
      if (action !== WHOLE_COPY_ACTIONS.execute) return false;
      if (
        leftDocument.getText() !== leftText
        || rightDocument.getText() !== rightText
      ) {
        throw new Error(t('確認中にファイル内容が変更されたため、ファイル全体コピーを停止しました。'));
      }
      const confirmedCopyState = Object.freeze({
        leftText,
        rightText,
        leftVersion: leftDocument.version,
        rightVersion: rightDocument.version,
      });
      const targetSide = directionSides(direction).target;
      targetTextBeforeEdit = targetSide === 'left' ? confirmedCopyState.leftText : confirmedCopyState.rightText;
      const preparation = await this.prepareTargetWrite(targetSide, targetDocument, 'before-whole-copy');
      if (!preparation) return false;
      prepared = preparation;
      await this.assertConfirmedCopyState(snapshot, confirmedCopyState, t('ファイル全体コピーの準備中に内容が変更されたため、確認済みでない内容はコピーしませんでした。'));
      this.internalEditDepth += 1;
      let result;
      try {
        result = await applyWholeFile(snapshot, direction, this.managedEditorUrisValue, confirmedCopyState);
      } finally {
        this.internalEditDepth -= 1;
      }
      if (!result.applied) throw new Error(t('VS Codeの標準編集APIが変更を適用できませんでした。'));
      await this.commitPreparedRecovery(prepared);
      prepared = undefined;
      const targetTextAfterEdit = result.targetDocument.getText();
      this.expectInternalTextChange(result.targetDocument, targetTextAfterEdit);
      this.lastCopyValue = {
        targetSide,
        targetUri: result.targetDocument.uri,
        targetVersionAfterEdit: result.targetDocument.version,
        sourceVersionAtEdit: result.sourceVersion,
        kind: 'whole-file',
        hunkIndex: undefined,
      };
      this.lastCopyTextValue = { targetUri: result.targetDocument.uri, beforeText: targetTextBeforeEdit, afterText: targetTextAfterEdit };
      this.lastUndoneCopyValue = undefined;
      this.lastUndoneCopyTextValue = undefined;
      this.setDirtyState(targetSide, result.targetDocument.isDirty);
      await this.publishState();
      await this.showPostCopyActions(direction, undefined, true);
      return true;
    } catch (error) {
      if (prepared) {
        try {
          await this.rollbackOrKeepPreparedRecovery(
            prepared,
            targetDocument !== undefined && targetTextBeforeEdit !== undefined && targetDocument.getText() !== targetTextBeforeEdit,
          );
        } catch (recoveryError) {
          this.output.error(t('操作失敗後の復元履歴を整理できませんでした。'), recoveryError);
        }
      }
      this.reportError(t('ファイル全体をコピーできませんでした。'), error);
      return false;
    }
  }

  public async undoLastCopy(): Promise<boolean> {
    return this.restoreLastCopy(true);
  }

  /**
   * 直前のコピーだけを、記録済みのコピー前全文へ戻します。
   * 汎用Undoコマンド・アクティブタブ・VS Code／Cursor固有のUndo履歴順には依存しません。
   */
  private async restoreLastCopy(confirmBeforeRestore: boolean): Promise<boolean> {
    try {
      const last = this.lastCopyValue;
      const copiedText = this.lastCopyTextValue;
      if (!last || !copiedText || !isSameUri(last.targetUri, copiedText.targetUri)) {
        throw new Error(t('本ツールで元に戻せる直前のコピーがありません。'));
      }
      const document = await vscode.workspace.openTextDocument(last.targetUri);
      // VS Code／Cursorでは、表示更新や内部同期だけで文書versionが進む場合があります。
      // 現在の全文がコピー直後の全文と完全一致していれば、別内容への変更は起きていないため安全に戻せます。
      if (document.getText() !== copiedText.afterText) {
        throw new Error(t('現在の内容がコピー直後の内容と一致しないため、直前のコピーだけを安全に元へ戻せません。対象ファイルの現在内容を確認してください。'));
      }

      if (confirmBeforeRestore) {
        const identity = last.targetSide === 'left' ? this.session.left : this.session.right;
        const action = await this.ui.showWarningMessage(
          t('{0}へコピーした変更を、コピー前の状態へ戻しますか？', sideLabel(last.targetSide)),
          {
            modal: true,
            detail: [
              t('元に戻す対象：{0}', sideLabel(last.targetSide)),
              identity?.relativePath ?? document.uri.fsPath,
              '',
              t('本ツールがコピー直前に記録した内容へ、このコピーだけを正確に戻します。'),
              t('VS Code／Cursorの汎用Ctrl+Zは呼び出しません。ほかの編集履歴やタブを変更しません。'),
              ...this.saveBehaviorLines(document.uri),
              t('［元に戻さず閉じる］、Esc、または画面右上の×で閉じた場合は、内容・未保存状態・L／R設定・比較状態を変更しません。'),
            ].join('\n'),
          },
          UNDO_ACTIONS.undo,
          UNDO_ACTIONS.cancel,
        );
        if (action !== UNDO_ACTIONS.undo) return false;
      }

      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, fullRange, copiedText.beforeText);
      this.internalEditDepth += 1;
      let applied = false;
      try {
        applied = await vscode.workspace.applyEdit(edit);
      } finally {
        this.internalEditDepth -= 1;
      }
      if (!applied || !await this.waitForDocumentText(document, copiedText.beforeText)) {
        throw new Error(t('コピー前の内容を正確に復元できなかったため、元に戻す処理を完了できませんでした。'));
      }
      this.expectInternalTextChange(document, copiedText.beforeText);

      this.lastCopyValue = undefined;
      this.lastCopyTextValue = undefined;
      this.lastUndoneCopyValue = { ...last, targetVersionAfterEdit: document.version };
      this.lastUndoneCopyTextValue = copiedText;
      this.setDirtyState(last.targetSide, document.isDirty);
      await this.publishState();
      void this.ui.showInformationMessage([
        t('直前にコピーした変更を、コピー前の状態へ戻しました。'),
        ...this.saveBehaviorLines(document.uri),
      ].join('\n'));
      return true;
    } catch (error) {
      this.reportError(t('直前にコピーした変更を元に戻せませんでした。'), error);
      return false;
    }
  }

  private async handleEditableSafeWrite(request: EditableWriteRequest): Promise<void> {
    let prepared: PreparedTargetWrite | undefined;
    try {
      const side = this.sideForUri(request.sourceUri);
      if (!side) {
        throw new Error(t('比較対象を確認できないため、安全な復元履歴を作成できず保存を中止しました。'));
      }
      const preparation = await this.prepareTargetWrite(side, request.sourceDocument, 'before-save');
      if (!preparation) throw new Error(t('保存を中止しました。'));
      prepared = preparation;
      const uriKey = request.sourceUri.toString(true);
      this.expectedSaveUris.add(uriKey);
      try {
        await request.apply();
      } finally {
        setTimeout(() => this.expectedSaveUris.delete(uriKey), 1500);
      }
      await this.commitPreparedRecovery(prepared);
      prepared = undefined;
    } catch (error) {
      if (prepared) {
        try {
          await this.rollbackOrKeepPreparedRecovery(prepared, await this.savedTargetChanged(prepared));
        } catch (recoveryError) {
          this.output.error(t('保存失敗後の復元履歴を整理できませんでした。'), recoveryError);
        }
      }
      throw error;
    }
  }

  public async saveSide(side: ComparisonSide): Promise<boolean> {
    try {
      this.assertNormalMode();
      const identity = this.requireIdentity(side);
      const snapshot = this.session.snapshot();
      const document = await this.openComparisonDocument(side, snapshot);
      if (!document.isDirty) {
        void this.ui.showInformationMessage(t('{0}ファイルに未保存の変更はありません。保存する必要はありません。', sideLabel(side)));
        this.setDirtyState(side, false);
        await this.publishState();
        return false;
      }
      const saveAction = t('{0}の変更をファイルへ保存する', sideLabel(side));
      const action = await this.ui.showWarningMessage(
        t('{0}の未保存変更をファイルへ保存しますか？', sideLabel(side)),
        {
          modal: true,
          detail: [
            t('保存対象：{0}', sideLabel(side)),
            t('{0}｜{1}', identity.workspaceName ?? t('ワークスペース外'), identity.relativePath),
            '',
            t('現在の未保存内容を、実際のファイルへ書き込みます。'),
            t('保存後はVS Code／Cursorを閉じても、この変更がファイルに残ります。'),
            t('［保存しない］を選んだ場合は、ファイルへ書き込みません。'),
          ].join('\n'),
        },
        saveAction,
        SAVE_CANCEL_ACTION,
      );
      if (action !== saveAction) return false;
      // Ctrl+S・メニュー保存・自動保存と同じEditableComparisonProvider経路を使い、
      // 保存前履歴の作成を一箇所へ集約して二重作成を防ぎます。
      const saved = await document.save();
      if (!saved) throw new Error(t('VS Codeがファイルを保存できませんでした。'));
      this.setDirtyState(side, false);
      const leftDocument = await this.openComparisonDocument('left', snapshot);
      const rightDocument = await this.openComparisonDocument('right', snapshot);
      this.leftDirtyValue = leftDocument?.isDirty ?? false;
      this.rightDirtyValue = rightDocument?.isDirty ?? false;
      await this.publishState();
      void this.ui.showInformationMessage([
        t('保存が完了しました：{0}｜{1}', sideLabel(side), identity.relativePath),
        t('L：{0}', leftDocument?.isDirty ? t('未保存変更あり') : t('保存済み')),
        t('R：{0}', rightDocument?.isDirty ? t('未保存変更あり') : t('保存済み')),
      ].join('｜'));
      return true;
    } catch (error) {
      this.reportError(t('ファイルを保存できませんでした。'), error);
      return false;
    }
  }

  private async ensurePendingRestoreTargetIdentity(
    sourceUri: vscode.Uri,
    pending: PendingRestoreFormat,
  ): Promise<PendingRestoreFormat> {
    const target = await this.probePendingRestoreTarget(sourceUri);
    if (target.state === 'unavailable') {
      throw new Error(t('復元形式の対象ファイル識別情報を一時的に確認できないため、形式情報を保持して停止しました。'));
    }
    if (pending.identityState === 'rename-pending') {
      if (target.state !== 'found' || !reliableFileCtime(target.stat.ctime)) {
        throw new Error(t('移動後の復元形式対象をまだ確認できないため、形式情報を保持して停止しました。'));
      }
      const updated: PendingRestoreFormat = { ...pending, targetCtime: target.stat.ctime, identityState: 'verified' };
      await this.setPendingRestoreFormat(sourceUri, updated);
      return updated;
    }
    if (target.state === 'missing' || !reliableFileCtime(target.stat.ctime) || target.stat.ctime !== pending.targetCtime) {
      await this.deletePendingRestoreFormat(sourceUri);
      throw new Error(t('復元形式の対象が別ファイルへ置き換わったため、古いBOM・改行形式を適用せず停止しました。'));
    }
    return pending;
  }

  private async enforcePendingRestoreFormat(document: vscode.TextDocument): Promise<void> {
    const sourceUri = this.sourceUriForDocument(document);
    const key = this.pendingRestoreFormatKey(sourceUri);
    let pending = this.pendingRestoreFormats.get(key);
    if (!pending || sourceUri.scheme !== 'file') return;

    pending = await this.ensurePendingRestoreTargetIdentity(sourceUri, pending);
    const normalizedText = normalizeTextEol(document.getText());
    const currentHash = normalizedTextHash(normalizedText);
    let desiredBytes: Uint8Array;
    if (currentHash === pending.restored.normalizedHash && document.eol === pending.restored.eol) {
      desiredBytes = pending.restored.bytes ?? bytesForDocumentFormat(document, pending.restored.hasBom);
    } else if (currentHash === pending.before.normalizedHash && document.eol === pending.before.eol) {
      // 標準Undoで復元前へ戻した場合は、復元前のBOM・改行形式も戻します。
      desiredBytes = pending.before.bytes ?? bytesForDocumentFormat(document, pending.before.hasBom);
    } else {
      // 復元後に追加入力した場合も、履歴側のBOM形式を維持します。
      desiredBytes = bytesForDocumentFormat(document, pending.restored.hasBom);
    }

    const expectedStandardSaveBytes = bytesForDocumentFormat(document, pending.before.hasBom);
    const initial = await this.readDiskBytesForRecovery(sourceUri);
    if (initial.state === 'missing') {
      await this.deletePendingRestoreFormat(sourceUri);
      throw new Error(t('復元形式を保存する対象ファイルが見つかりません。'));
    }
    if (!sameBytes(initial.content, desiredBytes)) {
      if (!sameBytes(initial.content, expectedStandardSaveBytes)) {
        throw new Error(t('BOM・改行形式を確定する前にファイルが別の操作で変更されたため、外部変更を上書きせず停止しました。'));
      }
      await this.writeRestoreFormatSafely(sourceUri, pending, expectedStandardSaveBytes, desiredBytes, document.getText());
    }
    await this.ensurePendingRestoreTargetIdentity(sourceUri, pending);
    await this.deletePendingRestoreFormat(sourceUri);
  }

  private async writeRestoreFormatSafely(
    sourceUri: vscode.Uri,
    pending: PendingRestoreFormat,
    expectedCurrentBytes: Uint8Array,
    desiredBytes: Uint8Array,
    expectedText: string,
  ): Promise<void> {
    const key = sourceUri.toString(true);
    let lastError: unknown;
    for (let attempt = 0; attempt < RESTORE_FORMAT_WRITE_RETRIES; attempt += 1) {
      await this.ensurePendingRestoreTargetIdentity(sourceUri, pending);
      const latest = await this.readDiskBytesForRecovery(sourceUri);
      if (latest.state === 'missing') {
        await this.deletePendingRestoreFormat(sourceUri);
        throw new Error(t('復元形式を保存する対象ファイルが見つかりません。'));
      }
      if (sameBytes(latest.content, desiredBytes)) return;
      if (!sameBytes(latest.content, expectedCurrentBytes)) {
        throw new Error(t('BOM・改行形式を確定する直前にファイルが別の操作で変更されたため、外部変更を上書きせず停止しました。'));
      }
      this.editableProvider.expectSourceWrite(sourceUri, expectedText);
      this.expectedSaveUris.add(key);
      try {
        await vscode.workspace.fs.writeFile(sourceUri, desiredBytes);
        await this.ensurePendingRestoreTargetIdentity(sourceUri, pending);
        const written = await this.readDiskBytesForRecovery(sourceUri);
        if (written.state === 'found' && sameBytes(written.content, desiredBytes)) return;
        if (written.state === 'found' && !sameBytes(written.content, expectedCurrentBytes)) {
          throw new Error(t('BOM・改行形式の保存中にファイルが別の操作で変更されたため、再書込みせず停止しました。'));
        }
        lastError = new Error(t('BOM・改行形式の書込み結果を確認できませんでした。'));
      } catch (error) {
        lastError = error;
      } finally {
        setTimeout(() => this.expectedSaveUris.delete(key), 1500);
      }
      if (attempt + 1 < RESTORE_FORMAT_WRITE_RETRIES) {
        await new Promise<void>((resolve) => setTimeout(resolve, RESTORE_FORMAT_WRITE_RETRY_MS));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(t('BOM・改行形式を保存できませんでした。'));
  }

  private relatedDocumentsForSource(sourceUri: vscode.Uri): vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter((candidate) =>
      isSameUri(this.sourceUriForDocument(candidate), sourceUri));
  }

  private documentRestoreSignature(document: vscode.TextDocument): string {
    return `${normalizedTextHash(normalizeTextEol(document.getText()))}:${document.eol}`;
  }

  private selectPendingRestoreFormatDocument(
    sourceUri: vscode.Uri,
    resource?: unknown,
  ): vscode.TextDocument | undefined {
    const related = this.relatedDocumentsForSource(sourceUri);
    const active = vscode.window.activeTextEditor?.document;
    if (active && related.includes(active)) return active;

    if (isUri(resource)) {
      const exact = related.find((document) => isSameUri(document.uri, resource));
      if (exact) return exact;
    }

    const dirty = related.filter((document) => document.isDirty);
    if (dirty.length === 1) return dirty[0];
    if (dirty.length > 1) {
      const signatures = new Set(dirty.map((document) => this.documentRestoreSignature(document)));
      if (signatures.size > 1) {
        throw new Error(t('同じファイルに対応する複数の未保存文書の内容が異なるため、形式の保存対象を自動選択できません。対象の差分側をクリックしてからもう一度実行してください。'));
      }
      return dirty.find((document) => document.uri.scheme === EDITABLE_SCHEME) ?? dirty[0];
    }

    if (related.length > 1) {
      const signatures = new Set(related.map((document) => this.documentRestoreSignature(document)));
      if (signatures.size > 1) {
        throw new Error(t('同じファイルに対応する文書の内容が異なるため、形式の保存対象を自動選択できません。対象の文書をクリックしてからもう一度実行してください。'));
      }
    }
    return related.find((document) => document.uri.scheme === EDITABLE_SCHEME) ?? related[0];
  }

  private async retryPendingRestoreFormat(document: vscode.TextDocument): Promise<boolean> {
    const sourceUri = this.sourceUriForDocument(document);
    if (!this.pendingRestoreFormats.has(this.pendingRestoreFormatKey(sourceUri))) {
      void this.ui.showInformationMessage(t('このファイルには、BOM・改行形式の保存を再試行する復元情報がありません。'));
      return false;
    }
    try {
      await this.enforcePendingRestoreFormat(document);
      if (this.pendingRestoreFormats.has(this.pendingRestoreFormatKey(sourceUri))) {
        throw new Error(t('復元形式の保存結果を確定できませんでした。'));
      }
      void this.ui.showInformationMessage(t('復元履歴どおりのBOM・改行形式を保存しました。'));
      return true;
    } catch (error) {
      this.output.error(t('復元履歴どおりのBOM・改行形式を再保存できませんでした。'), error);
      void this.ui.showErrorMessage(t('BOM・改行形式を再保存できませんでした。ファイルが別の操作で変更されていないか確認してください。'));
      return false;
    }
  }

  public async retryRestoreFormat(resource?: unknown): Promise<boolean> {
    const resourceUri = isUri(resource)
      ? this.editableProvider.sourceUri(resource)
      : vscode.window.activeTextEditor
        ? this.sourceUriForDocument(vscode.window.activeTextEditor.document)
        : undefined;
    if (!resourceUri || resourceUri.scheme !== 'file') {
      void this.ui.showInformationMessage(t('形式の保存を再試行する対象ファイルを開くか、右クリックしてください。'));
      return false;
    }

    const persistedCandidate = this.pendingRestoreFormatCandidates.get(this.pendingRestoreFormatKey(resourceUri));
    if (persistedCandidate) {
      const preferred = vscode.window.activeTextEditor?.document;
      const result = await this.reconcilePendingRestoreFormatCandidate(persistedCandidate, preferred);
      if (result === 'discarded') await this.deletePendingRestoreFormat(vscode.Uri.parse(persistedCandidate.sourceUri, true));
      await this.updatePendingRestoreFormatContext();
    }
    if (!this.pendingRestoreFormats.has(this.pendingRestoreFormatKey(resourceUri))) {
      void this.ui.showInformationMessage(t('このファイルの復元形式情報は文書の復元または対象状態の確認待ちです。未保存の復元内容を開いてからもう一度実行してください。'));
      return false;
    }

    let document: vscode.TextDocument | undefined;
    try {
      document = this.selectPendingRestoreFormatDocument(resourceUri, resource);
    } catch (error) {
      this.reportError(t('形式の保存対象を選べませんでした。'), error);
      return false;
    }
    if (!document) {
      document = await vscode.workspace.openTextDocument(resourceUri);
      await this.handleTextDocumentOpened(document);
    }
    return this.retryPendingRestoreFormat(document);
  }

  public async handleTextDocumentSaved(document: vscode.TextDocument): Promise<void> {
    try {
      await this.enforcePendingRestoreFormat(document);
    } catch (error) {
      this.output.error(t('復元履歴どおりのBOM・改行形式を保存できませんでした。'), error);
      const action = await this.ui.showErrorMessage(
        t('復元した文字内容は保存されましたが、BOMまたは改行形式を履歴どおりに保存できませんでした。外部変更を上書きせず停止しています。'),
        {},
        RETRY_RESTORE_FORMAT_ACTION,
      );
      if (action === RETRY_RESTORE_FORMAT_ACTION) await this.retryPendingRestoreFormat(document);
    }
    const side = this.sideForUri(document.uri);
    if (!side) return;
    this.locallyEditedUris.delete(document.uri.toString(true));
    this.setDirtyState(side, false);
    // 保存・自動保存は内容を変えないため、直前コピーの復元記録を消しません。
    // 保存イベントは内容変更ではありません。自動保存を含め、直前コピーの復元記録を維持します。
    await this.publishState();
  }

  /** 現在の比較文書から差分ブロックを再計算します。表示用でも既存の安全な差分モデルだけを使用します。 */
  private async currentDiffHunks(): Promise<DiffHunk[]> {
    const snapshot = this.session.snapshot();
    const [leftDocument, rightDocument] = await Promise.all([
      this.openComparisonDocument('left', snapshot),
      this.openComparisonDocument('right', snapshot),
    ]);
    return createDiffHunks(leftDocument.getText(), rightDocument.getText());
  }

  /** 比較開始時など、件数を直ちに画面へ反映する必要がある場合に使用します。 */
  private async refreshDifferenceCountNow(): Promise<boolean> {
    if (!this.session.left || !this.session.right || !this.diffOpenedValue) {
      const changed = this.differenceCountValue !== undefined;
      this.differenceCountValue = undefined;
      return changed;
    }
    const next = (await this.currentDiffHunks()).length;
    const changed = next !== this.differenceCountValue;
    this.differenceCountValue = next;
    return changed;
  }

  /** 文字入力のたびに重い差分計算を連続実行しないよう、短時間まとめて件数だけ更新します。 */
  private scheduleDifferenceCountRefresh(): void {
    if (!this.diffOpenedValue || !this.session.left || !this.session.right) return;
    const generation = ++this.differenceSummaryRefreshGeneration;
    if (this.differenceSummaryRefreshTimer) clearTimeout(this.differenceSummaryRefreshTimer);
    this.differenceSummaryRefreshTimer = setTimeout(() => {
      this.differenceSummaryRefreshTimer = undefined;
      void (async () => {
        try {
          const hunks = await this.currentDiffHunks();
          if (
            generation !== this.differenceSummaryRefreshGeneration
            || !this.diffOpenedValue
            || !this.session.left
            || !this.session.right
          ) return;
          const next = hunks.length;
          const changed = next !== this.differenceCountValue;
          this.differenceCountValue = next;
          if (changed) await this.publishState();
        } catch (error) {
          // 件数表示だけの失敗で比較・編集機能を停止させません。詳細はローカル出力へ残します。
          this.output.error(t('差分件数を更新できませんでした。'), error);
        }
      })();
    }, 120);
  }

  private async moveToDifferenceHunk(hunk: DiffHunk): Promise<boolean> {
    const snapshot = this.session.snapshot();
    let editor = vscode.window.activeTextEditor;
    let side = detectEditorSide(editor, snapshot, this.managedEditorUrisValue) ?? this.activeSideValue;
    if (!editor || !side || !this.diffOpenedValue) {
      if (!await this.openDiff()) return false;
      editor = vscode.window.activeTextEditor;
      side = detectEditorSide(editor, snapshot, this.managedEditorUrisValue) ?? this.activeSideValue;
    }
    if (!editor || !side) {
      throw new Error(t('標準差分画面のL・左側またはR・右側を一度クリックしてから、差分を選択してください。'));
    }
    const activeDocument = side === 'left'
      ? await this.openComparisonDocument('left', snapshot)
      : await this.openComparisonDocument('right', snapshot);
    const line = navigationLineForHunk(hunk, side, activeDocument.lineCount);
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  }

  /** 左右確認ビューの「差分：○件」から、内訳と各差分位置を開きます。 */
  public async showDifferenceSummary(): Promise<boolean> {
    try {
      if (!this.session.left || !this.session.right) return false;
      if (!this.diffOpenedValue && !await this.openDiff()) return false;
      const hunks = await this.currentDiffHunks();
      const summary = summarizeDiffHunks(hunks);
      if (this.differenceCountValue !== summary.total) {
        this.differenceCountValue = summary.total;
        await this.publishState();
      }

      const summaryLabel = t(
        '合計：{0}件｜変更：{1}件｜追加：{2}件｜削除：{3}件',
        summary.total,
        summary.changed,
        summary.added,
        summary.deleted,
      );
      const guidanceLabel = summary.total > 0
        ? t('下の差分を選ぶと、その位置へ移動します。')
        : t('L・左側とR・右側の内容は同じです。');
      const hunkLabels = hunks.map(createDifferenceHunkLabel);
      const items = [summaryLabel, guidanceLabel, ...(summary.total > 0 ? [t('━━━━━━━━━━━━━━━━━━━━━━━━'), ...hunkLabels] : [])];
      const selected = this.ui.showQuickPick
        ? await this.ui.showQuickPick(items, {
          ...createTransientQuickPickOptions(t('差分サマリー')),
          placeHolder: t('確認だけの場合は、Escまたは他の場所をクリックして閉じます。'),
        })
        : undefined;
      if (!selected) return true;
      const selectedHunkIndex = hunkLabels.indexOf(selected);
      if (selectedHunkIndex < 0) return true;
      return await this.moveToDifferenceHunk(hunks[selectedHunkIndex]!);
    } catch (error) {
      this.reportError(t('差分サマリーを表示できませんでした。'), error);
      return false;
    }
  }

  public async moveToNextDifference(): Promise<boolean> {
    try {
      const snapshot = this.session.snapshot();
      let editor = vscode.window.activeTextEditor;
      let side = detectEditorSide(editor, snapshot, this.managedEditorUrisValue);
      if (!editor || !side) {
        if (!await this.openDiff()) return false;
        editor = vscode.window.activeTextEditor;
        side = detectEditorSide(editor, snapshot, this.managedEditorUrisValue);
      }
      if (!editor || !side) throw new Error(t('標準差分画面のL・左側またはR・右側をクリックしてください。'));
      const leftDocument = await this.openComparisonDocument('left', snapshot);
      const rightDocument = await this.openComparisonDocument('right', snapshot);
      const hunks = createDiffHunks(leftDocument.getText(), rightDocument.getText());
      if (hunks.length === 0) throw new Error(t('移動できる差分がありません。'));
      const activeDocument = side === 'left' ? leftDocument : rightDocument;
      const currentLine = editor.selection.active.line;
      const next = hunks.find((hunk) =>
        navigationLineForHunk(hunk, side!, activeDocument.lineCount) > currentLine
      ) ?? hunks[0];
      const line = navigationLineForHunk(next!, side, activeDocument.lineCount);
      const position = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return true;
    } catch (error) {
      this.reportError(t('次の差分へ移動できませんでした。'), error);
      return false;
    }
  }

  public async endComparison(): Promise<boolean> {
    if (!this.session.left && !this.session.right) return true;
    // 未保存変更の保存確認でキャンセルされた場合は、比較もL・Rもそのまま維持します。
    if (!await this.closeCurrentManagedDiffTabs()) return false;
    this.session.clear();
    this.resetManagedState();
    await this.options.storage?.saveSession(undefined);
    await this.publishState();
    vscode.window.setStatusBarMessage(t('左右比較を終了し、L・R設定を解除しました。'), 4000);
    return true;
  }


  public async showRecentComparisons(): Promise<boolean> {
    const storage = this.options.storage;
    if (!storage) return false;
    const recent = storage.load().recentComparisons;
    if (recent.length === 0) {
      void this.ui.showInformationMessage(t('最近の比較はまだありません。'));
      return false;
    }
    const labels = recent.map((item, index) => {
      const left = vscode.Uri.parse(item.leftUri, true);
      const right = vscode.Uri.parse(item.rightUri, true);
      return t('{0}. L｜{1} ⇔ R｜{2}', index + 1, left.fsPath, right.fsPath);
    });
    const selected = this.ui.showQuickPick
      ? await this.ui.showQuickPick(labels, createTransientQuickPickOptions(t('最近の比較を選択')))
      : undefined;
    if (!selected) return false;
    const index = labels.indexOf(selected);
    const item = recent[index];
    if (!item) return false;
    try {
      const left = vscode.Uri.parse(item.leftUri, true);
      const right = vscode.Uri.parse(item.rightUri, true);
      await Promise.all([vscode.workspace.fs.stat(left), vscode.workspace.fs.stat(right)]);
      if (!await this.closeCurrentManagedDiffTabs()) return false;
      this.session.restore(item);
      this.resetManagedState();
      await this.publishState();
      return await this.confirmAndOpen();
    } catch (error) {
      this.reportError(t('最近の比較を開けませんでした。ファイルが移動または削除されている可能性があります。'), error);
      return false;
    }
  }

  public async manageRecovery(): Promise<boolean> {
    const store = this.options.recoveryStore;
    if (!store) return false;
    const integrity = await store.getIntegrityStatus();
    if (!integrity.available) {
      const resetAction = t('復元履歴の保存領域を安全に初期化');
      const action = await this.ui.showWarningMessage(
        t('復元履歴の保存情報を安全に読み取れないため、復元履歴機能を停止しました。'),
        {
          modal: true,
          detail: t('比較対象の元ファイルには触れず、拡張機能用の復元履歴保存領域だけを初期化できます。履歴データは元に戻せません。'),
        },
        resetAction,
        t('閉じる'),
      );
      return action === resetAction ? this.resetRecoveryStorage() : false;
    }
    const snapshots = await store.list();
    if (snapshots.length === 0 && integrity.quarantinedCount === 0 && integrity.deletionPendingCount === 0) {
      void this.ui.showInformationMessage(t('復元履歴はまだありません。'));
      return false;
    }
    const labels = snapshots.map((snapshot, index) => {
      const time = new Date(snapshot.createdAt).toLocaleString();
      const targetLabel = snapshot.targetState === 'available'
        ? snapshot.targetUri.fsPath
        : snapshot.targetState === 'verification-pending'
          ? t('移動先の確認待ち｜現在の場所：{0}', snapshot.targetUri.fsPath)
          : t('対象ファイルなし｜以前の場所：{0}', snapshot.targetUri.fsPath);
      return t('{0}. {1}｜{2}｜{3}', index + 1, targetLabel, time, recoveryReasonLabel(snapshot.reason));
    });
    const clearAllLabel = integrity.quarantinedCount > 0 || integrity.deletionPendingCount > 0
      ? t('すべての復元履歴と使用停止データを削除（履歴{0}件・使用停止{1}件・削除待ち{2}件）', snapshots.length, integrity.quarantinedCount, integrity.deletionPendingCount)
      : t('すべての復元履歴を削除（{0}件）', snapshots.length);
    const selected = this.ui.showQuickPick
      ? await this.ui.showQuickPick([clearAllLabel, ...labels], createTransientQuickPickOptions(t('復元履歴を選択')))
      : undefined;
    if (!selected) return false;
    if (selected === clearAllLabel) {
      const confirmed = await this.ui.showWarningMessage(
        t('すべての復元履歴を削除しますか？'),
        {
          modal: true,
          detail: [
            t('復元履歴：{0}件', snapshots.length),
            t('使用停止データ：{0}件', integrity.quarantinedCount),
            t('削除待ちデータ：{0}件（{1}）', integrity.deletionPendingCount, formatByteSize(integrity.deletionPendingBytes)),
            '',
            t('拡張機能用ローカルストレージにある復元履歴と使用停止データだけを削除します。'),
            t('比較対象の元ファイルや現在のファイルは削除・変更しません。'),
            t('削除した復元履歴と使用停止データは元に戻せません。'),
          ].join('\n'),
        },
        t('すべて削除する'),
        t('やめる'),
      );
      if (confirmed !== t('すべて削除する')) return false;
      if (!await this.closeRecoveryComparisonTabs()) {
        throw new Error(t('開いている復元履歴の比較タブを閉じられなかったため、履歴の削除を中止しました。'));
      }
      const deletedCount = await store.clearAll();
      this.recoveryCountValue = 0;
      await this.publishState();
      void this.ui.showInformationMessage(
        integrity.quarantinedCount > 0 || integrity.deletionPendingCount > 0
          ? t('復元履歴を{0}件、使用停止データを{1}件、削除待ちデータを{2}件処理しました。元ファイルは変更していません。', deletedCount, integrity.quarantinedCount, integrity.deletionPendingCount)
          : t('復元履歴を{0}件削除しました。元ファイルは変更していません。', deletedCount),
      );
      return true;
    }
    const index = labels.indexOf(selected);
    if (index < 0) return false;
    const snapshot = snapshots[index];
    if (!snapshot) return false;
    return this.chooseRecoveryAction(snapshot);
  }

  public async resetRecoveryStorage(): Promise<boolean> {
    const store = this.options.recoveryStore;
    if (!store) return false;
    const first = await this.ui.showWarningMessage(
      t('復元履歴の保存領域を初期化しますか？'),
      {
        modal: true,
        detail: [
          t('拡張機能用ローカルストレージの復元履歴・使用停止データ・削除待ちデータだけを削除します。'),
          t('比較対象の元ファイルや現在のファイルは削除・変更しません。'),
          t('削除した復元履歴データは元に戻せません。'),
        ].join('\n'),
      },
      t('初期化の確認へ進む'),
      t('やめる'),
    );
    if (first !== t('初期化の確認へ進む')) return false;
    const second = await this.ui.showWarningMessage(
      t('本当に復元履歴の保存領域を初期化しますか？'),
      { modal: true, detail: t('この操作は取り消せません。元ファイルへは触れません。') },
      t('復元履歴保存領域を初期化する'),
      t('やめる'),
    );
    if (second !== t('復元履歴保存領域を初期化する')) return false;
    if (!await this.closeRecoveryComparisonTabs()) {
      throw new Error(t('開いている復元履歴の比較タブを閉じられなかったため、初期化を中止しました。'));
    }
    await store.resetStorage();
    const persisted = await this.options.storage?.loadPendingRestoreFormatsFresh();
    const records = persisted?.records ?? [];
    const deletedKeys = records.map((record) => record.sourceUri);
    const expected: PendingRestoreFormatExpectedState = Object.fromEntries(records.map((record) => [
      record.sourceUri,
      { recordId: record.recordId, revision: record.revision },
    ]));
    const storage = this.options.storage as (WorkspaceStorage & {
      resetPendingRestoreFormats?: (expected?: PendingRestoreFormatExpectedState) => Promise<PendingRestoreFormatMutationResult>;
    }) | undefined;
    let mutation: PendingRestoreFormatMutationResult | undefined;
    const resetFormats = async (): Promise<void> => {
      if (storage?.resetPendingRestoreFormats) mutation = await storage.resetPendingRestoreFormats(expected);
      else mutation = await this.mutatePersistedPendingRestoreFormats([], deletedKeys, expected);
    };
    if (this.options.recoveryStore) await this.options.recoveryStore.runSharedTransaction(resetFormats);
    else await resetFormats();
    if (mutation && mutation.conflicts.length > 0) {
      throw new Error(t('別のウィンドウで復元形式情報が更新されたため、安全初期化を確定できませんでした。もう一度実行してください。'));
    }
    this.pendingRestoreFormats.clear();
    this.pendingRestoreFormatCandidates.clear();
    await this.updatePendingRestoreFormatContext();
    this.recoveryCountValue = 0;
    await this.publishState();
    void this.ui.showInformationMessage(t('復元履歴の保存領域を初期化しました。比較対象の元ファイルは変更していません。'));
    return true;
  }

  public async manageFileRecovery(resource?: unknown): Promise<boolean> {
    const store = this.options.recoveryStore;
    if (!store) return false;
    const targetUri = this.fileUriFromResource(resource);
    if (!targetUri) {
      void this.ui.showInformationMessage(t('通常のファイルを右クリックして、このファイルの復元履歴を開いてください。'));
      return false;
    }
    const snapshots = await store.list(targetUri);
    const showHistoryAction = t('復元履歴を表示');
    const showInfoAction = t('対象ファイルの情報を表示');
    const closeAction = t('閉じる');
    const buttons = snapshots.length > 0
      ? [showHistoryAction, showInfoAction, closeAction]
      : [showInfoAction, closeAction];
    const action = await this.ui.showInformationMessage(
      t('このファイルの復元履歴'),
      {
        modal: true,
        detail: [
          t('「かんたん左右ファイル比較」が、このファイルについて自動保存した復元履歴のみを表示します。'),
          t('このツールが自動保存していない履歴や、Git・VS Codeの変更履歴は表示されません。'),
          '',
          t('ファイル名：{0}', targetUri.path.split('/').pop() ?? targetUri.fsPath),
          t('完全な場所：{0}', targetUri.fsPath),
          t('復元履歴：{0}件', snapshots.length),
          ...(snapshots.length === 0 ? ['', t('このファイルについて、本ツールが作成した復元履歴はありません。')] : []),
        ].join('\n'),
      },
      ...buttons,
    );
    if (action === showInfoAction) return this.showRecoveryTargetInfoDialog(targetUri, snapshots[0]);
    if (action !== showHistoryAction || snapshots.length === 0) return false;
    const labels = snapshots.map((snapshot, index) => {
      const time = new Date(snapshot.createdAt).toLocaleString();
      return t('{0}. {1}｜{2}', index + 1, time, recoveryReasonLabel(snapshot.reason));
    });
    const selected = this.ui.showQuickPick
      ? await this.ui.showQuickPick(labels, createTransientQuickPickOptions(t('このファイルの復元履歴を選択')))
      : undefined;
    if (!selected) return false;
    const snapshot = snapshots[labels.indexOf(selected)];
    if (!snapshot) return false;
    return this.chooseRecoveryAction(snapshot);
  }

  public async showRecoveryComparisonHelp(resource?: unknown): Promise<boolean> {
    const snapshot = await this.recoverySnapshotFromResource(resource);
    const comparisonId = this.recoveryComparisonIdFromResource(resource);
    const currentText = comparisonId
      ? this.options.recoveryProvider?.currentText(comparisonId)
      : this.reviewedRecoveryValue?.snapshotId === snapshot.id
        ? this.reviewedRecoveryValue.targetText
        : undefined;
    if (currentText === undefined) {
      throw new Error(t('この比較画面の情報を確認できません。復元履歴一覧から開き直してください。'));
    }
    return this.showRecoveryGuide(snapshot, currentText);
  }

  public async restoreRecoveryFromComparison(resource?: unknown): Promise<boolean> {
    const snapshot = await this.recoverySnapshotFromResource(resource);
    const comparisonId = this.recoveryComparisonIdFromResource(resource);
    const currentText = comparisonId
      ? this.options.recoveryProvider?.currentText(comparisonId)
      : this.reviewedRecoveryValue?.snapshotId === snapshot.id
        ? this.reviewedRecoveryValue.targetText
        : undefined;
    if (currentText === undefined) {
      throw new Error(t('比較開始時点の現在内容が見つかりません。復元履歴一覧から開き直してください。'));
    }
    return this.restoreRecoverySnapshot(snapshot, currentText);
  }

  public async saveRecoveryFromComparison(resource?: unknown): Promise<boolean> {
    return this.saveRecoverySnapshotAs(await this.recoverySnapshotFromResource(resource));
  }

  public async openRecoveryTarget(resource?: unknown): Promise<boolean> {
    const snapshot = await this.requireAvailableRecoverySnapshot(await this.recoverySnapshotFromResource(resource));
    const document = await vscode.workspace.openTextDocument(snapshot.targetUri);
    await this.ui.showTextDocument(document, { preview: false, preserveFocus: false });
    return true;
  }

  public async showRecoveryTargetInfo(resource?: unknown): Promise<boolean> {
    const snapshot = await this.recoverySnapshotFromResource(resource);
    return this.showRecoveryTargetInfoDialog(snapshot.targetUri, snapshot);
  }

  public async deleteRecoveryFromComparison(resource?: unknown): Promise<boolean> {
    return this.deleteRecoverySnapshot(await this.recoverySnapshotFromResource(resource));
  }

  private ensureRecoveryTargetAvailable(snapshot: RecoverySnapshot): void {
    if (snapshot.targetState === 'verification-pending') {
      throw new Error(t('この復元履歴の移動先ファイルを現在確認できないため、直接復元を安全停止しました。しばらくしてからもう一度実行するか、「別ファイルとして保存」を使用してください。'));
    }
    if (snapshot.targetState === 'missing') {
      throw new Error(t('この復元履歴の対象ファイルは移動先を追跡できず、現在は存在しません。現在のファイルへの直接復元はできません。「別ファイルとして保存」を使用してください。'));
    }
  }

  private async requireAvailableRecoverySnapshot(snapshot: RecoverySnapshot): Promise<RecoverySnapshot> {
    const latest = await this.options.recoveryStore?.get(snapshot.id);
    if (!latest) throw new Error(t('指定した復元履歴が見つかりません。'));
    this.ensureRecoveryTargetAvailable(latest);
    return latest;
  }

  private recoverySnapshotIdFromUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== RECOVERY_SCHEME) return undefined;
    return new URLSearchParams(uri.query).get('snapshot') ?? undefined;
  }

  private recoveryComparisonIdFromUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== RECOVERY_SCHEME) return undefined;
    return new URLSearchParams(uri.query).get('comparison') ?? undefined;
  }

  private recoveryComparisonIdFromResource(resource?: unknown): string | undefined {
    const uri = isUri(resource) ? resource : vscode.window.activeTextEditor?.document.uri;
    return uri ? this.recoveryComparisonIdFromUri(uri) : this.reviewedRecoveryValue?.comparisonId;
  }

  private recoveryComparisonTabCount(): number {
    let count = 0;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!isTextDiffInput(tab.input)) continue;
        if (
          tab.input.original.scheme === RECOVERY_SCHEME
          || tab.input.modified.scheme === RECOVERY_SCHEME
        ) count += 1;
      }
    }
    return count;
  }

  /** 履歴の復元・削除後に古い比較タブと比較開始時点の一時内容を同時に解放します。 */
  private async closeRecoveryComparisonTabs(snapshotIds?: readonly string[]): Promise<boolean> {
    const requested = snapshotIds ? new Set(snapshotIds) : undefined;
    const tabs: vscode.Tab[] = [];
    const comparisonIds = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!isTextDiffInput(tab.input)) continue;
        const originalId = this.recoverySnapshotIdFromUri(tab.input.original);
        const modifiedId = this.recoverySnapshotIdFromUri(tab.input.modified);
        const ids = [originalId, modifiedId].filter((value): value is string => Boolean(value));
        if (ids.length === 0) continue;
        if (!requested || ids.some((id) => requested.has(id))) {
          tabs.push(tab);
          const originalComparison = this.recoveryComparisonIdFromUri(tab.input.original);
          const modifiedComparison = this.recoveryComparisonIdFromUri(tab.input.modified);
          if (originalComparison) comparisonIds.add(originalComparison);
          if (modifiedComparison) comparisonIds.add(modifiedComparison);
        }
      }
    }
    const closed = tabs.length === 0 || await vscode.window.tabGroups.close(tabs, true);
    if (!closed) {
      this.output.error(t('復元履歴の比較タブを閉じられませんでした。'));
      return false;
    }
    if (requested) {
      for (const comparisonId of comparisonIds) this.options.recoveryProvider?.release(comparisonId);
      for (const snapshotId of requested) this.options.recoveryProvider?.releaseSnapshot(snapshotId);
      if (this.reviewedRecoveryValue && requested.has(this.reviewedRecoveryValue.snapshotId)) {
        this.reviewedRecoveryValue = undefined;
      }
    } else {
      this.options.recoveryProvider?.releaseAll();
      this.reviewedRecoveryValue = undefined;
    }
    return true;
  }

  private async chooseRecoveryAction(snapshot: RecoverySnapshot): Promise<boolean> {
    const compareAction = t('現在の内容と見比べる');
    const restoreAction = t('この履歴の内容に戻す');
    const saveAsAction = t('別ファイルとして保存');
    const targetInfoAction = t('対象ファイルの情報を表示');
    const deleteAction = t('この履歴を削除');
    const actions = snapshot.targetState === 'available'
      ? [compareAction, restoreAction, saveAsAction, targetInfoAction, deleteAction, t('やめる')]
      : [saveAsAction, targetInfoAction, deleteAction, t('やめる')];
    const action = this.ui.showQuickPick
      ? await this.ui.showQuickPick(actions, createTransientQuickPickOptions(t('復元履歴の操作')))
      : undefined;
    if (!action || action === t('やめる')) return false;
    if (action === compareAction) return this.openRecoveryComparison(snapshot);
    if (action === restoreAction) return this.restoreRecoverySnapshot(snapshot);
    if (action === saveAsAction) return this.saveRecoverySnapshotAs(snapshot);
    if (action === targetInfoAction) return this.showRecoveryTargetInfoDialog(snapshot.targetUri, snapshot);
    if (action === deleteAction) return this.deleteRecoverySnapshot(snapshot);
    return false;
  }

  private async openRecoveryComparison(snapshot: RecoverySnapshot): Promise<boolean> {
    snapshot = await this.requireAvailableRecoverySnapshot(snapshot);
    const provider = this.options.recoveryProvider;
    if (!provider) return false;
    const targetDocument = await vscode.workspace.openTextDocument(snapshot.targetUri);
    const currentText = targetDocument.getText();
    const displayName = snapshot.targetUri.path.split('/').pop() ?? 'recovery.txt';
    const comparison = provider.createComparisonUris(snapshot.id, displayName, currentText);
    await vscode.commands.executeCommand(
      'vscode.diff',
      comparison.historyUri,
      comparison.currentUri,
      t('履歴の内容 ⇔ 比較を開いた時点の内容｜{0}', snapshot.targetUri.fsPath),
      { preview: false },
    );
    this.reviewedRecoveryValue = {
      snapshotId: snapshot.id,
      comparisonId: comparison.comparisonId,
      targetUri: snapshot.targetUri,
      targetText: currentText,
      reviewedAt: Date.now(),
    };
    return this.showRecoveryGuide(snapshot, currentText);
  }

  private async showRecoveryGuide(snapshot: RecoverySnapshot, comparedCurrentText: string): Promise<boolean> {
    const action = await this.ui.showInformationMessage(
      t('復元履歴と現在の内容を見比べています。'),
      {
        modal: true,
        detail: [
          t('左：選択した復元履歴の内容'),
          t('右：比較を開いた時点の現在内容'),
          '',
          t('比較を開いた後に元ファイルが変わっても、右側は開いた時点の内容を表示し続けます。'),
          t('この比較画面は左右とも読み取り専用です。'),
          t('この画面を見たり閉じたりするだけでは、ファイルは変更・保存されません。'),
          t('案内を閉じた後も、比較画面の右クリックから復元や別ファイル保存を実行できます。'),
        ].join('\n'),
      },
      t('見比べるだけ'),
      t('この履歴の内容に戻す'),
      t('別ファイルとして保存'),
    );
    if (action === t('この履歴の内容に戻す')) return this.restoreRecoverySnapshot(snapshot, comparedCurrentText);
    if (action === t('別ファイルとして保存')) return this.saveRecoverySnapshotAs(snapshot);
    return true;
  }

  private saveBehaviorLines(uri: vscode.Uri, operation: '変更' | '復元' = '変更'): readonly string[] {
    const autoSave = vscode.workspace.getConfiguration('files', uri).get<string>('autoSave', 'off');
    const confirmLine = operation === '復元'
      ? t('復元後に内容を確認し、問題がなければ保存してください。')
      : t('変更内容を確認し、問題がなければ保存してください。');
    const delayedLine = operation === '復元'
      ? t('復元後、設定されている時間が経過すると自動保存されることがあります。')
      : t('変更後、設定されている時間が経過すると自動保存されることがあります。');
    const changedContent = operation === '復元' ? t('復元した内容') : t('変更内容');
    if (autoSave === 'off') {
      return [
        t('本ツールは保存操作を行いません。'),
        t('自動保存：オフ'),
        confirmLine,
      ];
    }
    if (autoSave === 'afterDelay') {
      return [
        t('本ツールは保存操作を行いません。'),
        t('自動保存：一定時間後'),
        delayedLine,
      ];
    }
    if (autoSave === 'onFocusChange') {
      return [
        t('本ツールは保存操作を行いません。'),
        t('自動保存：エディターからフォーカスが外れたとき'),
        t('別のエディターへ移動すると、{0}が自動保存されることがあります。', changedContent),
      ];
    }
    if (autoSave === 'onWindowChange') {
      return [
        t('本ツールは保存操作を行いません。'),
        t('自動保存：ウィンドウからフォーカスが外れたとき'),
        t('別のアプリへ移動すると、{0}が自動保存されることがあります。', changedContent),
      ];
    }
    return [
      t('本ツールは保存操作を行いません。'),
      t('自動保存：オン'),
      t('VS Code／Cursorの設定により、{0}が自動保存されることがあります。', changedContent),
    ];
  }

  private async restoreRecoverySnapshot(snapshot: RecoverySnapshot, expectedCurrentText?: string): Promise<boolean> {
    snapshot = await this.requireAvailableRecoverySnapshot(snapshot);
    const store = this.options.recoveryStore;
    if (!store) return false;
    let prepared: PreparedTargetWrite | undefined;
    let latestDocument: vscode.TextDocument | undefined;
    let beforeText: string | undefined;
    let reopenManagedComparison = false;
    try {
      latestDocument = await vscode.workspace.openTextDocument(snapshot.targetUri);
      beforeText = latestDocument.getText();
      if (expectedCurrentText !== undefined && beforeText !== expectedCurrentText) {
        throw new Error(t('比較画面を開いた後に現在のファイルが変わったため、復元履歴を開き直して内容を確認してください。'));
      }
      const confirmed = await this.ui.showWarningMessage(
        t('現在のファイルを、この履歴の内容に戻しますか？'),
        {
          modal: true,
          detail: [
            snapshot.targetUri.fsPath,
            '',
            t('現在の内容は、新しい復元履歴として残します。'),
            ...this.saveBehaviorLines(snapshot.targetUri, '復元'),
          ].join('\n'),
        },
        t('この履歴の内容に戻す'),
        t('戻さない'),
      );
      if (confirmed !== t('この履歴の内容に戻す')) return false;
      // 確認画面を表示している間に同じ場所が別ファイルへ置き換わっていないか、識別を再確認します。
      snapshot = await this.requireAvailableRecoverySnapshot(snapshot);
      const confirmedDocument = await vscode.workspace.openTextDocument(snapshot.targetUri);
      const confirmedText = confirmedDocument.getText();
      if (expectedCurrentText !== undefined && confirmedText !== expectedCurrentText) {
        throw new Error(t('復元確認中に現在のファイルが変わったため、復元履歴を開き直して内容を確認してください。'));
      }
      latestDocument = confirmedDocument;
      beforeText = confirmedText;
      // 復元内容を適用する前に比較タブを閉じ、成功後に古い「比較開始時点の内容」が残る余地をなくします。
      if (!await this.closeRecoveryComparisonTabs([snapshot.id])) {
        throw new Error(t('復元履歴の比較タブを閉じられなかったため、復元を中止しました。'));
      }
      const activeComparison = this.getSessionSnapshot();
      reopenManagedComparison = Boolean(
        activeComparison
        && this.diffOpenedValue
        && (isSameUri(activeComparison.left.uri, snapshot.targetUri) || isSameUri(activeComparison.right.uri, snapshot.targetUri)),
      );
      if (reopenManagedComparison) {
        if (!await this.closeCurrentManagedDiffTabs()) {
          throw new Error(t('通常比較の未保存状態を確定できなかったため、復元を中止しました。'));
        }
        this.resetManagedState();
        snapshot = await this.requireAvailableRecoverySnapshot(snapshot);
        latestDocument = await vscode.workspace.openTextDocument(snapshot.targetUri);
        if (latestDocument.getText() !== confirmedText) {
          throw new Error(t('通常比較を閉じる間に現在のファイルが変わったため、復元を中止しました。'));
        }
      }
      const beforeBytes = await this.bytesForRecovery(latestDocument, snapshot.targetUri, 'before-restore');
      const beforeRestoreSnapshot = await store.begin(snapshot.targetUri, beforeBytes, 'before-restore');
      prepared = {
        recovery: {
          snapshotId: beforeRestoreSnapshot.id,
          targetUri: snapshot.targetUri,
          beforeBytes,
        },
      };
      const beforeFormat = recoveryByteFormat(beforeBytes);
      const restoredFormat = recoveryByteFormat(await store.read(snapshot.id));
      const restoredText = restoredFormat.text ?? '';
      const expectedRestoredText = restoredFormat.eol === vscode.EndOfLine.CRLF
        ? restoredText.replace(/\n/g, '\r\n')
        : restoredText;
      // WorkspaceEditを適用する直前にも同じ対象識別と内容を再確認し、確認後の置換を防ぎます。
      snapshot = await this.requireAvailableRecoverySnapshot(snapshot);
      latestDocument = await vscode.workspace.openTextDocument(snapshot.targetUri);
      if (latestDocument.getText() !== confirmedText) {
        throw new Error(t('復元内容を適用する直前に現在のファイルが変わったため、復元を中止しました。'));
      }
      beforeText = confirmedText;
      const fullRange = new vscode.Range(latestDocument.positionAt(0), latestDocument.positionAt(beforeText.length));
      const edit = new vscode.WorkspaceEdit();
      const textEditApi = vscode.TextEdit as typeof vscode.TextEdit | undefined;
      if (typeof edit.set === 'function' && typeof textEditApi?.replace === 'function' && typeof textEditApi.setEndOfLine === 'function') {
        edit.set(latestDocument.uri, [
          textEditApi.replace(fullRange, restoredText),
          textEditApi.setEndOfLine(restoredFormat.eol),
        ]);
      } else {
        edit.replace(latestDocument.uri, fullRange, restoredText);
      }
      this.internalEditDepth += 1;
      let applied = false;
      try {
        applied = await vscode.workspace.applyEdit(edit);
      } finally {
        this.internalEditDepth -= 1;
      }
      if (
        !applied
        || !await this.waitForDocumentText(latestDocument, expectedRestoredText)
        || latestDocument.eol !== restoredFormat.eol
      ) {
        throw new Error(t('復元内容と改行形式を適用できませんでした。'));
      }
      const targetStat = await vscode.workspace.fs.stat(snapshot.targetUri);
      if (!reliableFileCtime(targetStat.ctime)) {
        throw new Error(t('復元形式の対象ファイル識別情報を確認できないため、復元を中止しました。'));
      }
      await this.setPendingRestoreFormat(snapshot.targetUri, {
        before: beforeFormat,
        restored: restoredFormat,
        current: { normalizedHash: restoredFormat.normalizedHash, eol: restoredFormat.eol },
        targetCtime: targetStat.ctime,
        identityState: 'verified',
        savedAt: new Date().toISOString(),
      });
      await this.commitPreparedRecovery(prepared);
      prepared = undefined;
      this.expectInternalTextChange(latestDocument, expectedRestoredText);
      this.recoveryCountValue = await store.count();
      await this.publishState();
      if (reopenManagedComparison && this.session.left && this.session.right) {
        if (!await this.openDiff()) {
          void this.ui.showWarningMessage(t('復元は完了しましたが、通常比較を現在内容で開き直せませんでした。L・R設定から比較を開き直してください。'));
        }
      } else {
        await this.ui.showTextDocument(latestDocument, { preview: false, preserveFocus: false });
      }
      const postAction = await this.ui.showInformationMessage(
        t('選択した履歴の内容に戻しました。'),
        {
          modal: true,
          detail: [
            t('復元する直前の内容は、「復元前の自動保存」という新しい復元履歴に残しています。'),
            t('復元前の状態へ戻したい場合は、その履歴を開いて「この履歴の内容に戻す」を選んでください。'),
            '',
            ...this.saveBehaviorLines(snapshot.targetUri, '復元'),
          ].join('\n'),
        },
        t('復元前の履歴を開く'),
        t('現在の内容を確認する'),
      );
      if (postAction === t('復元前の履歴を開く')) {
        return this.openRecoveryComparison(beforeRestoreSnapshot);
      }
      return true;
    } catch (error) {
      if (prepared) {
        try {
          await this.rollbackOrKeepPreparedRecovery(
            prepared,
            latestDocument !== undefined && beforeText !== undefined && latestDocument.getText() !== beforeText,
          );
        } catch (recoveryError) {
          this.output.error(t('復元失敗後の復元履歴を整理できませんでした。'), recoveryError);
        }
      }
      throw error;
    }
  }

  private async saveRecoverySnapshotAs(snapshot: RecoverySnapshot): Promise<boolean> {
    const store = this.options.recoveryStore;
    if (!store) return false;
    const fileName = snapshot.targetUri.path.split('/').pop() ?? 'recovery.txt';
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = snapshot.targetState === 'available'
      ? vscode.Uri.file(`${snapshot.targetUri.fsPath}.recovered`)
      : workspaceRoot
        ? vscode.Uri.joinPath(workspaceRoot, `${fileName}.recovered`)
        : undefined;
    const destination = await vscode.window.showSaveDialog({
      title: t('復元履歴を別ファイルとして保存'),
      ...(defaultUri ? { defaultUri } : {}),
      saveLabel: t('別ファイルとして保存'),
    });
    if (!destination) return false;
    if (isSameFileLocation(destination, snapshot.targetUri)) {
      throw new Error(t('「別ファイルとして保存」では、復元履歴の元ファイル自身を保存先にできません。別の新しいファイル名を指定してください。'));
    }
    try {
      await vscode.workspace.fs.stat(destination);
      throw new Error(t('既に存在するファイルは上書きできません。存在しない新しいファイル名を指定してください。'));
    } catch (error) {
      if (!isNotFoundFileError(error)) throw error;
    }
    const content = await store.read(snapshot.id);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(destination, { overwrite: false, ignoreIfExists: false, contents: content });
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new Error(t('保存先が既に作成されたため、上書きせずに中止しました。別の新しいファイル名を指定してください。'));
    }
    const document = await vscode.workspace.openTextDocument(destination);
    await this.ui.showTextDocument(document, { preview: false, preserveFocus: false });
    return true;
  }

  private async deleteRecoverySnapshot(snapshot: RecoverySnapshot): Promise<boolean> {
    const store = this.options.recoveryStore;
    if (!store) return false;
    const confirmed = await this.ui.showWarningMessage(
      t('この復元履歴を削除しますか？'),
      { modal: true, detail: snapshot.targetUri.fsPath },
      t('削除する'),
      t('やめる'),
    );
    if (confirmed !== t('削除する')) return false;
    if (!await this.closeRecoveryComparisonTabs([snapshot.id])) {
      throw new Error(t('対応する復元履歴の比較タブを閉じられなかったため、履歴の削除を中止しました。'));
    }
    await store.delete(snapshot.id);
    this.recoveryCountValue = await store.count();
    await this.publishState();
    return true;
  }

  private fileUriFromResource(resource?: unknown): vscode.Uri | undefined {
    const uri = isUri(resource) ? resource : vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' ? uri : undefined;
  }

  private async showRecoveryTargetInfoDialog(
    targetUri: vscode.Uri,
    snapshot?: RecoverySnapshot,
  ): Promise<boolean> {
    const inspected = snapshot
      ? await this.options.recoveryStore?.inspectTarget(snapshot.id) ?? 'unavailable'
      : await this.inspectFileForDisplay(targetUri);
    const exists = inspected === 'available';
    const statusLabel = inspected === 'available'
      ? t('ファイルは存在します')
      : inspected === 'missing'
        ? t('対象ファイルなし（現在のファイルへ直接復元できません）')
        : t('現在は対象ファイルの状態を確認できません（関連付けは変更していません）');
    const workspace = vscode.workspace.getWorkspaceFolder(targetUri);
    const openDocument = vscode.workspace.textDocuments.find((document) => isSameUri(document.uri, targetUri));
    const lines = [
      t('ファイル名：{0}', targetUri.path.split('/').pop() ?? targetUri.fsPath),
      t('完全な場所：{0}', targetUri.fsPath),
      t('ワークスペース：{0}', workspace?.name ?? t('ワークスペース外')),
      t('現在の状態：{0}', statusLabel),
      t('未保存の変更：{0}', openDocument?.isDirty ? t('あります') : t('ありません')),
    ];
    if (snapshot) {
      lines.push(
        '',
        t('履歴の作成日時：{0}', new Date(snapshot.createdAt).toLocaleString()),
        t('履歴の作成理由：{0}', recoveryReasonLabel(snapshot.reason)),
      );
    }
    const openAction = t('対象ファイルを通常画面で開く');
    const revealAction = t('エクスプローラーで場所を表示');
    const closeAction = t('閉じる');
    const actions = exists ? [openAction, revealAction, closeAction] : [closeAction];
    const action = await this.ui.showInformationMessage(
      t('この復元履歴の対象ファイル'),
      { modal: true, detail: lines.join('\n') },
      ...actions,
    );
    if (action === openAction) {
      const document = await vscode.workspace.openTextDocument(targetUri);
      await this.ui.showTextDocument(document, { preview: false, preserveFocus: false });
      return true;
    }
    if (action === revealAction) {
      this.options.highlightFile?.(targetUri);
      await revealFileWithPublicApi(targetUri);
      return true;
    }
    return false;
  }

  private async inspectFileForDisplay(targetUri: vscode.Uri): Promise<'available' | 'missing' | 'unavailable'> {
    for (let attempt = 0; attempt < RECOVERY_FILE_READ_RETRIES; attempt += 1) {
      try {
        await vscode.workspace.fs.stat(targetUri);
        return 'available';
      } catch (error) {
        if (isNotFoundFileError(error)) return 'missing';
        if (attempt + 1 < RECOVERY_FILE_READ_RETRIES) {
          await new Promise<void>((resolve) => setTimeout(resolve, RECOVERY_FILE_READ_RETRY_MS));
        }
      }
    }
    return 'unavailable';
  }

  private async recoverySnapshotFromResource(resource?: unknown): Promise<RecoverySnapshot> {
    const store = this.options.recoveryStore;
    if (!store) throw new Error(t('復元履歴を利用できません。'));
    const uri = isUri(resource) ? resource : vscode.window.activeTextEditor?.document.uri;
    const snapshotId = uri?.scheme === RECOVERY_SCHEME
      ? new URLSearchParams(uri.query).get('snapshot')
      : this.reviewedRecoveryValue?.snapshotId;
    if (!snapshotId) throw new Error(t('この比較画面に対応する復元履歴が見つかりません。'));
    const snapshot = (await store.list()).find((item) => item.id === snapshotId);
    if (!snapshot) throw new Error(t('指定した復元履歴が見つかりません。'));
    return snapshot;
  }

  public handleTextDocumentClosed(_document: vscode.TextDocument): void {
    // タブを閉じただけでは、形式書込みの再試行情報を破棄しません。
    // 明示Revert・対象削除／置換・形式確定成功だけが削除入口です。
    void this.updatePendingRestoreFormatContext();
  }

  public async handleTabsChanged(): Promise<void> {
    this.releaseClosedRecoveryComparisons();
    const snapshot = this.getSessionSnapshot();
    const nextManagedDiffActive = Boolean(snapshot && this.diffOpenedValue && this.isManagedDiffTabActive(snapshot));
    if (nextManagedDiffActive !== this.managedDiffActiveValue) {
      this.managedDiffActiveValue = nextManagedDiffActive;
      await this.publishState();
    }
    if (this.tabReconcileTimer) clearTimeout(this.tabReconcileTimer);
    const generation = ++this.tabReconcileGeneration;
    if (!this.diffOpenedValue || this.internalTabOperationDepth > 0) return;
    // タブを別グループへドラッグした一瞬、ダイアログの開閉、エディター再描画中の一時的な一覧変化を「比較終了」と誤判定しません。
    this.tabReconcileTimer = setTimeout(() => {
      void this.reconcileManagedTabs(generation);
    }, 300);
  }

  private releaseClosedRecoveryComparisons(): void {
    const provider = this.options.recoveryProvider;
    if (!provider) return;
    const active = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!isTextDiffInput(tab.input)) continue;
        const original = this.recoveryComparisonIdFromUri(tab.input.original);
        const modified = this.recoveryComparisonIdFromUri(tab.input.modified);
        if (original) active.add(original);
        if (modified) active.add(modified);
      }
    }
    provider.releaseExcept(active);
  }

  private async reconcileManagedTabs(generation: number): Promise<void> {
    this.tabReconcileTimer = undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (generation !== this.tabReconcileGeneration || !this.diffOpenedValue || this.internalTabOperationDepth > 0) return;
      const snapshot = this.getSessionSnapshot();
      if (!snapshot || this.hasManagedDiffTab(snapshot)) return;
      if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    if (generation !== this.tabReconcileGeneration || !this.diffOpenedValue || this.internalTabOperationDepth > 0) return;
    const snapshot = this.getSessionSnapshot();
    if (!snapshot || this.hasManagedDiffTab(snapshot)) return;
    this.session.clear();
    this.resetManagedState();
    await this.options.storage?.saveSession(undefined);
    await this.publishState();
    this.output.info(t('標準差分タブが実際に閉じられたことを複数回確認したため、L・R設定も自動解除しました。'));
  }

  public async handleCreatedFiles(event: vscode.FileCreateEvent): Promise<void> {
    await this.clearPendingRestoreFormatsForAffectedUris(event.files);
    try {
      const recoveryIds = await this.options.recoveryStore?.markReplacedTargetsMissing(event.files) ?? [];
      if (recoveryIds.length > 0) await this.closeRecoveryComparisonTabs(recoveryIds);
    } catch (error) {
      this.output.error(t('新しく作成された対象から古い復元履歴を切り離せませんでした。'), error);
    }
  }

  public async handleRenamedFiles(event: vscode.FileRenameEvent): Promise<void> {
    await this.movePendingRestoreFormatsThroughRenames(event.files);
    try {
      const recoveryIds = await this.options.recoveryStore?.updateTargetsForRenames(event.files) ?? [];
      if (recoveryIds.length > 0) await this.closeRecoveryComparisonTabs(recoveryIds);
    } catch (error) {
      this.output.error(t('復元履歴の対象アドレスを移動後へ更新できませんでした。'), error);
    }
    const left = this.session.left;
    const right = this.session.right;
    const updates: { left?: vscode.Uri; right?: vscode.Uri } = {};
    if (left) updates.left = mapUriThroughRenames(left.uri, event.files);
    if (right) updates.right = mapUriThroughRenames(right.uri, event.files);
    if (!updates.left && !updates.right) return;

    const changed = [
      updates.left && left ? t('L・左側：{0}\n　　→ {1}', left.uri.fsPath, updates.left.fsPath) : undefined,
      updates.right && right ? t('R・右側：{0}\n　　→ {1}', right.uri.fsPath, updates.right.fsPath) : undefined,
    ].filter((value): value is string => Boolean(value));
    const action = await this.ui.showWarningMessage(
      changed.length === 2 ? t('L・Rファイルを含む場所が変更されました。') : t('比較中のファイルの場所が変更されました。'),
      { modal: true, detail: changed.join('\n\n') },
      t('新しい場所で比較を続ける'),
      t('比較を終了する'),
    );
    if (action !== t('新しい場所で比較を続ける')) {
      await this.stopForInvalidFiles(t('比較中のファイルが移動されたため比較を終了しました。'));
      return;
    }

    try {
      await Promise.all([updates.left, updates.right].filter((uri): uri is vscode.Uri => Boolean(uri)).map(assertFileResource));
      const reopen = this.diffOpenedValue;
      if (!await this.closeCurrentManagedDiffTabs()) {
        this.staleReasonValue = t('ファイル移動後の比較更新がキャンセルされました。未保存変更を確認し、比較を更新してください。');
        this.clearCopyHistory();
        await this.publishState();
        return;
      }
      // 1つのファイル操作で両側が移動しても、中間状態を公開せず一度に置き換えます。
      this.session.replaceUris(updates);
      this.resetManagedState();
      await this.publishState();
      if (reopen && this.session.left && this.session.right) await this.openDiff();
    } catch (error) {
      await this.stopForInvalidFiles(t('ファイルの移動後状態を確認できないため比較を停止しました。'), error);
    }
  }

  public async handleDeletedFiles(event: vscode.FileDeleteEvent): Promise<void> {
    await this.clearPendingRestoreFormatsForAffectedUris(event.files);
    try {
      const recoveryIds = await this.options.recoveryStore?.markTargetsMissing(event.files) ?? [];
      if (recoveryIds.length > 0) await this.closeRecoveryComparisonTabs(recoveryIds);
    } catch (error) {
      this.output.error(t('削除された対象の復元履歴を切り離せませんでした。'), error);
    }
    const affected: ComparisonSide[] = [];
    for (const side of ['left', 'right'] as const) {
      const identity = side === 'left' ? this.session.left : this.session.right;
      if (identity && event.files.some((deleted) => isSameOrDescendantUri(identity.uri, deleted))) {
        affected.push(side);
      }
    }
    if (affected.length === 0) return;
    const labels = affected.map(sideLabel).join('・');
    await this.stopForInvalidFiles(t('{0}ファイルまたはその親フォルダーが削除されたため比較を停止しました。', labels));
  }

  public async handleTextDocumentChanged(event: vscode.TextDocumentChangeEvent): Promise<void> {
    if (event.contentChanges.length === 0) return;
    const sourceUri = this.sourceUriForDocument(event.document);
    const sourceKey = this.pendingRestoreFormatKey(sourceUri);
    const pendingRestoreFormat = this.pendingRestoreFormats.get(sourceKey);
    if (event.document.isDirty && pendingRestoreFormat) {
      const updated: PendingRestoreFormat = {
        ...pendingRestoreFormat,
        current: {
          normalizedHash: normalizedTextHash(normalizeTextEol(event.document.getText())),
          eol: event.document.eol,
        },
        savedAt: new Date().toISOString(),
      };
      try {
        await this.setPendingRestoreFormat(sourceUri, updated);
      } catch (error) {
        this.output.error(t('復元形式情報の現在内容を永続化できませんでした。'), error);
      }
    }
    if (!event.document.isDirty && this.pendingRestoreFormats.has(sourceKey)) {
      // 保存せず閉じる／Revert／外部再読込みで復元内容が破棄された場合、
      // 後の無関係な保存へ古いBOM・改行形式を適用しません。
      await this.deletePendingRestoreFormat(sourceUri);
    }
    const side = this.sideForUri(event.document.uri);
    if (!side) return;

    const uriKey = event.document.uri.toString(true);
    const currentText = event.document.getText();
    this.setDirtyState(side, event.document.isDirty);
    this.scheduleDifferenceCountRefresh();

    // 編集可能な代理URIの保存を元ファイルへ転送した際の変更通知です。
    // workspace.fsによる外部書き換えではなく、正式なTextDocument編集・保存として処理し、
    // 本ツール自身の保存を外部変更警告へ流しません。
    if (this.editableProvider.consumeExpectedSourceTextChange(event.document)) {
      await this.publishState();
      return;
    }

    // 本ツール自身のコピー・明示Undo・復元を、代理比較外の元文書変更判定より先に確認します。
    // URIと全文が期待値に一致する変更だけを内部変更として除外するため、本当の外部変更は隠しません。
    if (this.consumeExpectedInternalTextChange(event.document)) {
      await this.publishState();
      return;
    }
    if (this.internalEditDepth > 0) {
      await this.publishState();
      return;
    }

    // 代理URIで通常比較中に元ファイル側が別タブ・別処理で変更された場合は、
    // 代理文書との内容が分岐するため、通常のローカル入力として無視せず安全停止します。
    if (this.isSourceDocumentOutsideEditableComparison(event.document.uri, side)) {
      await this.handleExternalDocumentChange(side, event.document);
      return;
    }

    const matchesCurrentCopyResult = Boolean(
      this.lastCopyValue
      && this.lastCopyTextValue
      && isSameUri(this.lastCopyValue.targetUri, event.document.uri)
      && currentText === this.lastCopyTextValue.afterText
    );
    const matchesCopiedUndo = Boolean(
      this.lastCopyValue
      && this.lastCopyTextValue
      && isSameUri(this.lastCopyValue.targetUri, event.document.uri)
      && currentText === this.lastCopyTextValue.beforeText
    );
    const matchesCopiedRedo = Boolean(
      this.lastUndoneCopyValue
      && this.lastUndoneCopyTextValue
      && isSameUri(this.lastUndoneCopyValue.targetUri, event.document.uri)
      && currentText === this.lastUndoneCopyTextValue.afterText
    );

    // コピー操作の通知が遅延・重複し、文書versionだけ進んだ場合も、
    // 全文がコピー直後と一致している限り復元記録を維持します。
    if (matchesCurrentCopyResult) {
      await this.publishState();
      return;
    }

    // reasonの有無やUndo／Redoの呼び出し元に依存せず、記録したコピー前後の全文一致を最優先します。
    if (matchesCopiedUndo) {
      this.lastUndoneCopyValue = this.lastCopyValue;
      this.lastUndoneCopyTextValue = this.lastCopyTextValue;
      this.lastCopyValue = undefined;
      this.lastCopyTextValue = undefined;
      await this.publishState();
      return;
    }
    if (matchesCopiedRedo) {
      this.lastCopyValue = {
        ...this.lastUndoneCopyValue!,
        targetVersionAfterEdit: event.document.version,
      };
      this.lastCopyTextValue = this.lastUndoneCopyTextValue;
      this.lastUndoneCopyValue = undefined;
      this.lastUndoneCopyTextValue = undefined;
      await this.publishState();
      return;
    }
    // 標準Ctrl+Z／Ctrl+Shift+Zは通常のエディター操作です。外部変更確認へ流しません。
    if (event.reason === vscode.TextDocumentChangeReason.Undo || event.reason === vscode.TextDocumentChangeReason.Redo) {
      if (
        (this.lastCopyValue && isSameUri(this.lastCopyValue.targetUri, event.document.uri))
        || (this.lastUndoneCopyValue && isSameUri(this.lastUndoneCopyValue.targetUri, event.document.uri))
      ) this.clearCopyHistory();
      this.locallyEditedUris.add(uriKey);
      await this.publishState();
      return;
    }

    // 通常の文字入力など、エディター内の編集は外部変更ではありません。
    if (event.document.isDirty) {
      this.locallyEditedUris.add(uriKey);
      if (this.lastCopyValue && isSameUri(this.lastCopyValue.targetUri, event.document.uri)) {
        this.lastCopyValue = undefined;
        this.lastCopyTextValue = undefined;
      }
      this.lastUndoneCopyValue = undefined;
      this.lastUndoneCopyTextValue = undefined;
      await this.publishState();
      return;
    }
    if (this.locallyEditedUris.delete(uriKey)) {
      this.clearCopyHistory();
      await this.publishState();
      return;
    }

    if (this.expectedSaveUris.has(uriKey) || this.staleReasonValue) {
      await this.publishState();
      return;
    }

    await this.handleExternalDocumentChange(side, event.document);
  }

  private isSourceDocumentOutsideEditableComparison(uri: vscode.Uri, side: ComparisonSide): boolean {
    const snapshot = this.getSessionSnapshot();
    const managed = this.managedEditorUrisValue;
    if (!snapshot || snapshot.mode !== 'normal' || !managed) return false;
    const managedUri = side === 'left' ? managed.left : managed.right;
    const sourceUri = side === 'left' ? snapshot.left.uri : snapshot.right.uri;
    return managedUri.scheme === EDITABLE_SCHEME && isSameUri(uri, sourceUri);
  }

  private async handleExternalDocumentChange(side: ComparisonSide, document: vscode.TextDocument): Promise<void> {
    if (this.staleReasonValue) {
      await this.publishState();
      return;
    }
    this.staleReasonValue = t('{0}ファイルが比較開始後に別の操作で変更されました。', sideLabel(side));
    this.clearCopyHistory();
    await this.publishState();
    const action = await this.ui.showWarningMessage(
      t('{0}ファイルの内容が別の操作で変わったため、コピーを停止しました。', sideLabel(side)),
      {
        detail: [
          `${sideLabel(side)}｜${this.sourceUriForDocument(document).fsPath}`,
          '',
          t('ファイル内容とL・R設定、比較画面はそのまま維持しています。'),
          t('古い差分情報で誤ってコピーしないよう、コピー操作だけを停止しました。'),
          t('［現在の内容で比較を更新］を選ぶと、現在の内容で差分を作り直します。'),
          t('［閉じる］、Esc、右上の×、または通知を無視した場合も、比較を終了せずL・Rを解除しません。'),
        ].join('\n'),
      },
      EXTERNAL_CHANGE_ACTIONS.reload,
      EXTERNAL_CHANGE_ACTIONS.close,
    );
    if (action === EXTERNAL_CHANGE_ACTIONS.reload) await this.openDiff();
  }


  private async confirmReplacingExistingSession(nextLeft: vscode.Uri): Promise<boolean> {
    const current = this.getSessionSnapshot();
    if (!current || isSameUri(current.left.uri, nextLeft)) return true;
    const action = await this.ui.showWarningMessage(
      t('現在の左右比較を終了して、新しい比較を開始しますか？'),
      {
        modal: true,
        detail: t('現在：L｜{0} ⇔ R｜{1}', current.left.relativePath, current.right.relativePath),
      },
      t('現在の比較を終了して開始'),
      t('現在の比較へ戻る'),
      t('やめる'),
    );
    if (action !== t('現在の比較を終了して開始')) return false;
    if (!await this.closeCurrentManagedDiffTabs()) return false;
    this.session.clear();
    this.resetManagedState();
    await this.publishState();
    return true;
  }

  private async applyFileSafetyMode(): Promise<boolean> {
    const snapshot = this.session.snapshot();
    const [left, right] = await Promise.all([assessFile(snapshot.left.uri), assessFile(snapshot.right.uri)]);
    const assessments = [
      { side: t('L・左側'), identity: snapshot.left, value: left },
      { side: t('R・右側'), identity: snapshot.right, value: right },
    ];
    const unsupported = assessments.filter((item) => item.value.level === 'unsupported');
    if (unsupported.length > 0) {
      throw new Error(
        unsupported.map((item) => t('{0}｜{1}：{2}', item.side, item.identity.relativePath, item.value.reasons.join(' '))).join('\n'),
      );
    }
    const forced = assessments.filter((item) => item.value.level === 'readonly');
    if (forced.length > 0) {
      this.session.setMode('readonly');
      await this.ui.showWarningMessage(
        t('安全のため読み取り専用比較へ切り替えます。'),
        {
          modal: true,
          detail: forced.map((item) => [
            t('{0}｜{1}', item.side, item.identity.relativePath),
            t('サイズ：{0}／行数：{1}', formatByteSize(item.value.sizeBytes), item.value.lineCount),
            ...item.value.reasons,
          ].join('\n')).join('\n\n'),
        },
        t('読み取り専用で比較する'),
      );
      return true;
    }
    const warnings = assessments.filter((item) => item.value.level === 'warning');
    if (warnings.length > 0 && this.session.mode === 'normal') {
      const action = await this.ui.showWarningMessage(
        t('大容量ファイルを通常比較しますか？'),
        {
          modal: true,
          detail: warnings.map((item) => [
            t('{0}｜{1}', item.side, item.identity.relativePath),
            t('サイズ：{0}／行数：{1}', formatByteSize(item.value.sizeBytes), item.value.lineCount),
            ...item.value.reasons,
          ].join('\n')).join('\n\n'),
        },
        t('通常比較を続ける'),
        t('読み取り専用で比較'),
        t('やめる'),
      );
      if (action === t('読み取り専用で比較')) this.session.setMode('readonly');
      else if (action !== t('通常比較を続ける')) return false;
    }
    return true;
  }

  private async prepareTargetWrite(
    side: ComparisonSide,
    document: vscode.TextDocument,
    reason: RecoverySnapshot['reason'],
  ): Promise<PreparedTargetWrite | false> {
    if (this.staleReasonValue) throw new Error(t('{0}\n比較を更新してから操作してください。', this.staleReasonValue));
    const detector = this.options.gitDetector;
    const store = this.options.recoveryStore;
    if (!store) return {};
    const sourceUri = this.sourceUriForDocument(document);
    const status = detector ? await detector.detect(sourceUri) : 'unknown';
    const storage = this.options.storage;
    const warningMode = vscode.workspace.getConfiguration('easyLeftRightDiff').get<
      'workspace-once' | 'always' | 'never'
    >('unmanagedWarning', 'workspace-once');
    const acknowledged = storage?.load().unmanagedWarningAcknowledged === true;
    const shouldWarn = status !== 'managed'
      && (warningMode === 'always' || (warningMode === 'workspace-once' && !acknowledged));
    if (shouldWarn) {
      const action = await this.ui.showWarningMessage(
        t('このファイルはGitで管理されていない、またはGit管理状態を確認できません。'),
        {
          modal: true,
          detail: [
            t('{0}｜{1}', sideLabel(side), sourceUri.fsPath),
            '',
            t('この操作を元に戻せるよう、現在の内容を復元履歴として自動保存します。'),
          ].join('\n'),
        },
        t('このまま続ける'),
        t('読み取り専用へ切り替える'),
        t('やめる'),
      );
      if (action === t('読み取り専用へ切り替える')) {
        await this.switchMode('readonly');
        return false;
      }
      if (action !== t('このまま続ける')) return false;
      if (warningMode === 'workspace-once') await storage?.setUnmanagedWarningAcknowledged(true);
    }
    const beforeBytes = await this.bytesForRecovery(document, sourceUri, reason);
    const snapshot = await store.begin(sourceUri, beforeBytes, reason);
    return { recovery: { snapshotId: snapshot.id, targetUri: sourceUri, beforeBytes } };
  }

  private async commitPreparedRecovery(prepared: PreparedTargetWrite): Promise<void> {
    const recovery = prepared.recovery;
    const store = this.options.recoveryStore;
    if (!recovery || !store) return;
    await store.commit(recovery.snapshotId);
    this.recoveryCountValue = await store.count();
    await this.publishState();
  }

  private async rollbackOrKeepPreparedRecovery(
    prepared: PreparedTargetWrite | undefined,
    contentChanged: boolean,
  ): Promise<void> {
    const recovery = prepared?.recovery;
    const store = this.options.recoveryStore;
    if (!recovery || !store) return;
    if (contentChanged) await store.commit(recovery.snapshotId);
    else await store.rollback(recovery.snapshotId);
    this.recoveryCountValue = await store.count();
    await this.publishState();
  }

  private async savedTargetChanged(prepared: PreparedTargetWrite | undefined): Promise<boolean> {
    const recovery = prepared?.recovery;
    if (!recovery) return false;
    if (recovery.targetUri.scheme !== 'file') return false;
    try {
      const current = await vscode.workspace.fs.readFile(recovery.targetUri);
      if (current.byteLength !== recovery.beforeBytes.byteLength) return true;
      return current.some((value, index) => value !== recovery.beforeBytes[index]);
    } catch {
      // 保存を試みた後に対象を読み取れない場合は、内容または存在状態が変わった可能性を優先して履歴を残します。
      return true;
    }
  }

  private async bytesForRecovery(
    document: vscode.TextDocument,
    sourceUri: vscode.Uri,
    reason: RecoverySnapshot['reason'],
  ): Promise<Uint8Array> {
    if (reason === 'before-save' && sourceUri.scheme === 'file') {
      const disk = await this.readDiskBytesForRecovery(sourceUri);
      if (disk.state === 'found') return disk.content;
      // 新規ファイルでディスク上にまだ存在しない場合だけ、現在内容を保存前履歴として使用します。
    }
    const current = new TextEncoder().encode(document.getText());
    if (sourceUri.scheme !== 'file') return current;
    const disk = await this.readDiskBytesForRecovery(sourceUri);
    if (disk.state === 'missing') {
      throw new Error(t('対象ファイルが見つからないため、正しい復元履歴を作成できず操作を中止しました。'));
    }
    const hasBom = disk.content.length >= 3
      && disk.content[0] === 0xef
      && disk.content[1] === 0xbb
      && disk.content[2] === 0xbf;
    if (!hasBom) return current;
    const result = new Uint8Array(current.length + 3);
    result.set([0xef, 0xbb, 0xbf], 0);
    result.set(current, 3);
    return result;
  }

  private async readDiskBytesForRecovery(
    sourceUri: vscode.Uri,
  ): Promise<{ readonly state: 'found'; readonly content: Uint8Array } | { readonly state: 'missing' }> {
    for (let attempt = 0; attempt < RECOVERY_FILE_READ_RETRIES; attempt += 1) {
      try {
        return { state: 'found', content: await vscode.workspace.fs.readFile(sourceUri) };
      } catch (error) {
        if (isNotFoundFileError(error)) return { state: 'missing' };
        if (attempt + 1 < RECOVERY_FILE_READ_RETRIES) {
          await new Promise<void>((resolve) => setTimeout(resolve, RECOVERY_FILE_READ_RETRY_MS));
          continue;
        }
        throw new Error(t('ディスク上の変更前内容を一時的に読み取れないため、正しい復元履歴を作成できず操作を中止しました。'));
      }
    }
    throw new Error(t('ディスク上の変更前内容を読み取れませんでした。'));
  }

  private async assertConfirmedCopyState(
    snapshot: ComparisonSnapshot,
    expected: {
      readonly leftText: string;
      readonly rightText: string;
      readonly leftVersion: number;
      readonly rightVersion: number;
    },
    message: string,
  ): Promise<void> {
    const [leftDocument, rightDocument] = await Promise.all([
      this.openComparisonDocument('left', snapshot),
      this.openComparisonDocument('right', snapshot),
    ]);
    if (
      leftDocument.version !== expected.leftVersion
      || rightDocument.version !== expected.rightVersion
      || leftDocument.getText() !== expected.leftText
      || rightDocument.getText() !== expected.rightText
    ) {
      throw new Error(message);
    }
  }

  private async seedEditableDocumentFromDirtySource(
    managedDocument: vscode.TextDocument,
    sourceDocument: vscode.TextDocument,
  ): Promise<void> {
    if (!sourceDocument.isDirty || managedDocument.getText() === sourceDocument.getText()) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      managedDocument.uri,
      new vscode.Range(
        managedDocument.positionAt(0),
        managedDocument.positionAt(managedDocument.getText().length),
      ),
      sourceDocument.getText(),
    );
    this.internalEditDepth += 1;
    try {
      if (!await vscode.workspace.applyEdit(edit)) {
        throw new Error(t('未保存内容を比較画面へ引き継げなかったため、比較を開始しませんでした。'));
      }
    } finally {
      this.internalEditDepth -= 1;
    }
  }

  private async clearPendingRestoreFormatsForAffectedUris(affectedUris: readonly vscode.Uri[]): Promise<void> {
    const storage = this.options.storage;
    const persistedRecords = storage
      ? (typeof (storage as WorkspaceStorage & { loadPendingRestoreFormatsFresh?: () => Promise<{ readonly records: readonly PersistedPendingRestoreFormat[] }> }).loadPendingRestoreFormatsFresh === 'function'
        ? (await (storage as WorkspaceStorage & { loadPendingRestoreFormatsFresh: () => Promise<{ readonly records: readonly PersistedPendingRestoreFormat[] }> }).loadPendingRestoreFormatsFresh()).records
        : storage.loadPendingRestoreFormats())
      : [];
    const records = new Map<string, PersistedPendingRestoreFormat>();
    for (const [key, pending] of this.pendingRestoreFormats.entries()) {
      records.set(key, this.persistedPendingRestoreFormat(key, pending));
    }
    for (const [key, record] of this.pendingRestoreFormatCandidates.entries()) records.set(key, record);
    for (const record of persistedRecords) records.set(record.sourceUri, record);
    for (const record of records.values()) {
      const pendingUri = vscode.Uri.parse(record.sourceUri, true);
      if (!affectedUris.some((affected) => isSameOrDescendantUri(pendingUri, affected))) continue;
      const key = this.pendingRestoreFormatKey(pendingUri);
      if (!this.pendingRestoreFormats.has(key) && !this.pendingRestoreFormatCandidates.has(key)) {
        this.pendingRestoreFormatCandidates.set(record.sourceUri, record);
      }
      await this.deletePendingRestoreFormat(pendingUri);
    }
    await this.updatePendingRestoreFormatContext();
  }

  private async movePendingRestoreFormatsThroughRenames(
    renames: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[],
  ): Promise<void> {
    const entries: Array<{ readonly key: string; readonly record: PersistedPendingRestoreFormat; readonly active: boolean }> = [
      ...[...this.pendingRestoreFormats.entries()].map(([key, pending]) => ({
        key,
        record: this.persistedPendingRestoreFormat(key, pending),
        active: true,
      })),
      ...[...this.pendingRestoreFormatCandidates.entries()].map(([key, record]) => ({ key, record, active: false })),
    ];
    for (const entry of entries) {
      const nextUri = mapUriThroughRenames(vscode.Uri.parse(entry.key, true), renames);
      if (!nextUri) continue;
      const probe = await this.probePendingRestoreTarget(nextUri);
      const nextKey = nextUri.toString(true);
      const nextRecord: PersistedPendingRestoreFormat = {
        ...entry.record,
        sourceUri: nextKey,
        revision: entry.record.revision + 1,
        targetCtime: probe.state === 'found' && reliableFileCtime(probe.stat.ctime)
          ? probe.stat.ctime
          : entry.record.targetCtime,
        identityState: probe.state === 'found' && reliableFileCtime(probe.stat.ctime)
          ? 'verified'
          : 'rename-pending',
        savedAt: new Date().toISOString(),
      };
      const sameStorageKey = entry.key === nextKey;
      const expected: PendingRestoreFormatExpectedState = sameStorageKey
        ? { [entry.key]: { recordId: entry.record.recordId, revision: entry.record.revision } }
        : {
          [entry.key]: { recordId: entry.record.recordId, revision: entry.record.revision },
          [nextKey]: null,
        };
      const result = await this.mutatePersistedPendingRestoreFormats(
        [nextRecord],
        sameStorageKey ? [] : [entry.key],
        expected,
      );
      if (result?.conflicts.some((key) => key === entry.key || key === nextKey)) {
        const latest = result.state.records.find((record) => record.sourceUri === entry.key || record.sourceUri === nextKey);
        if (latest) this.syncPendingRestoreRecordFromPersisted(latest);
        continue;
      }
      this.pendingRestoreFormats.delete(entry.key);
      this.pendingRestoreFormatCandidates.delete(entry.key);
      if (entry.active) this.pendingRestoreFormats.set(nextKey, this.pendingRestoreFormatFromPersisted(nextRecord));
      else this.pendingRestoreFormatCandidates.set(nextKey, nextRecord);
    }
    await this.updatePendingRestoreFormatContext();
  }

  private sideForUri(uri: vscode.Uri): ComparisonSide | undefined {
    if (this.session.left && isSameUri(this.session.left.uri, uri)) return 'left';
    if (this.session.right && isSameUri(this.session.right.uri, uri)) return 'right';
    const managed = this.managedEditorUrisValue;
    if (managed && isSameUri(managed.left, uri)) return 'left';
    if (managed && isSameUri(managed.right, uri)) return 'right';
    return undefined;
  }

  private hasManagedDiffTab(snapshot: ComparisonSnapshot): boolean {
    const managed = this.managedEditorUrisValue;
    const left = managed?.left ?? snapshot.left.uri;
    const right = managed?.right ?? snapshot.right.uri;
    return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => {
      if (!isTextDiffInput(tab.input)) return false;
      return isSameUri(tab.input.original, left) && isSameUri(tab.input.modified, right);
    }));
  }

  private async stopForInvalidFiles(message: string, error?: unknown): Promise<void> {
    if (!await this.closeCurrentManagedDiffTabs()) {
      this.staleReasonValue = t('{0}\n比較タブを閉じる操作がキャンセルされたため、コピーと保存を安全停止しています。', message);
      this.clearCopyHistory();
      await this.publishState();
      if (error) this.output.error(message, error);
      void this.ui.showErrorMessage(this.staleReasonValue);
      return;
    }
    this.session.clear();
    this.resetManagedState();
    this.staleReasonValue = message;
    await this.options.storage?.saveSession(undefined);
    await this.publishState();
    if (error) this.output.error(message, error);
    void this.ui.showErrorMessage(message);
  }


  private isManagedDiffTabActive(snapshot: ComparisonSnapshot): boolean {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!isTextDiffInput(input)) return false;
    const managed = this.managedEditorUrisValue;
    const left = managed?.left ?? snapshot.left.uri;
    const right = managed?.right ?? snapshot.right.uri;
    return isSameUri(input.original, left) && isSameUri(input.modified, right);
  }

  private requireIdentity(side: ComparisonSide): FileIdentity {
    const identity = side === 'left' ? this.session.left : this.session.right;
    if (!identity) throw new Error(t('{0}ファイルが設定されていません。', sideLabel(side)));
    return identity;
  }

  private managedUriForSide(side: ComparisonSide, snapshot: ComparisonSnapshot): vscode.Uri {
    const managed = this.managedEditorUrisValue;
    if (managed) return side === 'left' ? managed.left : managed.right;
    return side === 'left' ? snapshot.left.uri : snapshot.right.uri;
  }

  private async openComparisonDocument(side: ComparisonSide, snapshot: ComparisonSnapshot): Promise<vscode.TextDocument> {
    return vscode.workspace.openTextDocument(this.managedUriForSide(side, snapshot));
  }

  private sourceUriForDocument(document: vscode.TextDocument): vscode.Uri {
    return this.editableProvider.sourceUri(document.uri);
  }

  private async resolveFileResource(resource: unknown, openLabel: string): Promise<vscode.Uri | undefined> {
    if (isUri(resource)) return resource;
    if (resource !== undefined) throw new Error(t('エクスプローラーで比較するファイルを右クリックしてください。'));
    const selected = await this.ui.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel,
      title: openLabel,
    });
    return selected?.[0];
  }

  private async cancelPendingComparison(reason: string): Promise<void> {
    this.session.clear();
    this.resetManagedState();
    await this.publishState();
    this.output.info(t('{0} L・R設定も解除しました。', reason));
    vscode.window.setStatusBarMessage(t('比較を開始しなかったため、L・R設定を解除しました。'), 5000);
  }

  private async confirmAndOpen(): Promise<boolean> {
    while (true) {
      const snapshot = this.session.snapshot();
      const action = await this.ui.showInformationMessage(
        t('左右と比較方法を確認してください'),
        { modal: true, detail: createComparisonConfirmationDetail(snapshot) },
        CONFIRMATION_ACTIONS.compare,
        CONFIRMATION_ACTIONS.readonly,
        CONFIRMATION_ACTIONS.swap,
        CONFIRMATION_ACTIONS.cancel,
      );
      if (action === CONFIRMATION_ACTIONS.swap) {
        this.session.swap();
        await this.publishState();
        this.output.info(t('比較開始前にL・左側とR・右側を入れ替えました。'));
        continue;
      }
      if (action !== CONFIRMATION_ACTIONS.compare && action !== CONFIRMATION_ACTIONS.readonly) {
        await this.cancelPendingComparison(t('比較開始前の確認をキャンセルしました。'));
        return false;
      }
      this.session.setMode(action === CONFIRMATION_ACTIONS.readonly ? 'readonly' : 'normal');
      if (!await this.applyFileSafetyMode()) {
        await this.cancelPendingComparison(t('ファイル安全確認で比較開始を取りやめました。'));
        return false;
      }
      const confirmed = this.session.snapshot();
      if (confirmed.mode === 'normal' && !await this.confirmEditingRisks(confirmed)) {
        await this.cancelPendingComparison(t('編集状態の確認で比較開始を取りやめました。'));
        return false;
      }
      return await this.openDiff();
    }
  }

  private comparisonAutoSaveRiskLine(side: ComparisonSide, uri: vscode.Uri): string | undefined {
    const autoSave = vscode.workspace.getConfiguration('files', uri).get<string>('autoSave', 'off');
    if (autoSave === 'off') return undefined;
    if (autoSave === 'afterDelay') return t('{0}：一定時間後に自動保存', sideLabel(side));
    if (autoSave === 'onFocusChange') {
      return t('{0}：エディターからフォーカスが外れたときに自動保存', sideLabel(side));
    }
    if (autoSave === 'onWindowChange') {
      return t('{0}：ウィンドウからフォーカスが外れたときに自動保存', sideLabel(side));
    }
    return t('{0}：自動保存オン', sideLabel(side));
  }

  private async confirmEditingRisks(snapshot: ComparisonSnapshot): Promise<boolean> {
    const leftDocument = await vscode.workspace.openTextDocument(snapshot.left.uri);
    const rightDocument = await vscode.workspace.openTextDocument(snapshot.right.uri);
    const dirty = [
      leftDocument.isDirty ? t('L・左側') : undefined,
      rightDocument.isDirty ? t('R・右側') : undefined,
    ].filter((value): value is string => Boolean(value));
    const warnAutoSave = vscode.workspace.getConfiguration('easyLeftRightDiff').get<boolean>(
      'warnWhenAutoSaveEnabled',
      true,
    );
    const autoSaveRisks = warnAutoSave
      ? [
        this.comparisonAutoSaveRiskLine('left', snapshot.left.uri),
        this.comparisonAutoSaveRiskLine('right', snapshot.right.uri),
      ].filter((value): value is string => Boolean(value))
      : [];
    if (dirty.length === 0 && autoSaveRisks.length === 0) return true;

    const details: string[] = [];
    if (dirty.length > 0) details.push(t('{0}に未保存変更があります。', dirty.join(t('、'))));
    if (autoSaveRisks.length > 0) {
      details.push(...autoSaveRisks);
      details.push(t('コピー後、上記の対象側の変更が自動的に保存されることがあります。'));
    }
    details.push(t('本ツールは既存変更や自動保存設定を変更しません。'));

    const actions = dirty.length > 0
      ? [t('このまま比較する'), t('先に未保存ファイルを保存する'), t('比較をやめる')]
      : [t('このまま比較する'), t('比較をやめる')];
    const action = await this.ui.showWarningMessage(
      t('編集状態に注意が必要です。'),
      { modal: true, detail: details.join('\n') },
      ...actions,
    );
    if (action === t('先に未保存ファイルを保存する')) {
      for (const [side, document] of [['left', leftDocument], ['right', rightDocument]] as const) {
        if (document.isDirty && !await this.saveDirtyDocumentBeforeComparison(side, document)) return false;
      }
      return true;
    }
    return action === t('このまま比較する');
  }

  private async saveDirtyDocumentBeforeComparison(
    side: ComparisonSide,
    document: vscode.TextDocument,
  ): Promise<boolean> {
    let prepared: PreparedTargetWrite | undefined;
    try {
      const preparation = await this.prepareTargetWrite(side, document, 'before-save');
      if (!preparation) return false;
      prepared = preparation;
      const sourceUri = this.sourceUriForDocument(document);
      const key = sourceUri.toString(true);
      this.expectedSaveUris.add(key);
      try {
        if (!await document.save()) throw new Error(t('VS Codeが未保存ファイルを保存できませんでした。'));
      } finally {
        setTimeout(() => this.expectedSaveUris.delete(key), 1500);
      }
      await this.commitPreparedRecovery(prepared);
      prepared = undefined;
      return true;
    } catch (error) {
      if (prepared) {
        try {
          await this.rollbackOrKeepPreparedRecovery(prepared, await this.savedTargetChanged(prepared));
        } catch (recoveryError) {
          this.output.error(t('比較開始前の保存失敗後に復元履歴を整理できませんでした。'), recoveryError);
        }
      }
      this.reportError(t('{0}ファイルを比較開始前に安全保存できませんでした。', sideLabel(side)), error);
      return false;
    }
  }

  private async openDiff(): Promise<boolean> {
    const confirmed = this.session.snapshot();
    const hadManagedDiff = this.diffOpenedValue || Boolean(this.managedEditorUrisValue);
    if (hadManagedDiff) {
      if (!await this.closeCurrentManagedDiffTabs()) return false;
      // 保存・破棄・キャンセルの結果が確定した後にだけ、旧代理文書と表示状態を破棄します。
      this.resetManagedState();
    }

    let leftUri = confirmed.left.uri;
    let rightUri = confirmed.right.uri;
    const leftSourceDocument = await vscode.workspace.openTextDocument(confirmed.left.uri);
    const rightSourceDocument = await vscode.workspace.openTextDocument(confirmed.right.uri);

    if (confirmed.mode === 'readonly') {
      leftUri = this.readonlyProvider.createUri(confirmed, 'left');
      rightUri = this.readonlyProvider.createUri(confirmed, 'right');
      // 読み取り専用へ切り替える前に閉じる確認で「保存しない」を選んだ場合、
      // 破棄された代理文書の内容を再利用せず、確定済みの元文書から作り直します。
      this.readonlyProvider.setContent(leftUri, confirmed.left.uri, leftSourceDocument.getText());
      this.readonlyProvider.setContent(rightUri, confirmed.right.uri, rightSourceDocument.getText());
    } else {
      // 未保存変更の有無にかかわらず通常比較は書き込み可能な専用URIを使用します。
      // 未保存内容は代理文書へ未保存編集として引き継ぎ、Ctrl+S・メニュー保存・自動保存を
      // 必ずEditableComparisonProviderの復元履歴付き保存経路へ通します。
      leftUri = this.editableProvider.createUri(confirmed.left, 'left');
      rightUri = this.editableProvider.createUri(confirmed.right, 'right');
    }

    this.internalTabOperationDepth += 1;
    try {
      this.managedEditorUrisValue = { left: leftUri, right: rightUri };
      if (confirmed.mode === 'normal' && leftUri.scheme === EDITABLE_SCHEME) {
        const [leftManagedDocument, rightManagedDocument] = await Promise.all([
          vscode.workspace.openTextDocument(leftUri),
          vscode.workspace.openTextDocument(rightUri),
        ]);
        if (leftManagedDocument.languageId !== leftSourceDocument.languageId) {
          await vscode.languages.setTextDocumentLanguage(leftManagedDocument, leftSourceDocument.languageId);
        }
        if (rightManagedDocument.languageId !== rightSourceDocument.languageId) {
          await vscode.languages.setTextDocumentLanguage(rightManagedDocument, rightSourceDocument.languageId);
        }
        await this.seedEditableDocumentFromDirtySource(leftManagedDocument, leftSourceDocument);
        await this.seedEditableDocumentFromDirtySource(rightManagedDocument, rightSourceDocument);
      }
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, confirmed.title, {
        preview: false,
        preserveFocus: false,
      });
    } catch (error) {
      // 差分画面を開けなかった場合、半端な代理URIや「比較中」状態を残しません。
      this.resetManagedState();
      await this.publishState();
      throw error;
    } finally {
      this.internalTabOperationDepth -= 1;
    }

    this.diffOpenedValue = true;
    this.staleReasonValue = undefined;
    this.clearCopyHistory();
    await this.refreshDirtyState();
    await this.refreshDifferenceCountNow();
    if (this.options.storage) {
      const recentLimit = vscode.workspace.getConfiguration('easyLeftRightDiff').get<number>('recentComparisonLimit', 5);
      await this.options.storage.addRecent(confirmed, recentLimit);
      this.recentComparisonsValue = this.options.storage.load().recentComparisons;
    }
    await this.handleActiveEditor(vscode.window.activeTextEditor, 'open-diff');
    await this.publishState();
    this.output.info(t('標準差分画面を開きました。mode={0} title={1}', confirmed.mode, confirmed.title));
    return true;
  }

  private async closeCurrentManagedDiffTabs(): Promise<boolean> {
    if (!this.diffOpenedValue && !this.managedEditorUrisValue) return true;
    this.internalTabOperationDepth += 1;
    try {
      return await this.closeManagedDiffTabs();
    } catch (error) {
      this.reportError(t('比較タブを閉じられませんでした。'), error);
      return false;
    } finally {
      this.internalTabOperationDepth -= 1;
    }
  }

  private async closeManagedDiffTabs(): Promise<boolean> {
    const snapshot = this.getSessionSnapshot();
    const managed = this.managedEditorUrisValue;
    if (!snapshot && !managed) return true;

    const leftCandidates = [snapshot?.left.uri, managed?.left].filter((uri): uri is vscode.Uri => Boolean(uri));
    const rightCandidates = [snapshot?.right.uri, managed?.right].filter((uri): uri is vscode.Uri => Boolean(uri));
    if (leftCandidates.length === 0 || rightCandidates.length === 0) return true;

    const matchingTabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!isTextDiffInput(input)) continue;
        const direct = leftCandidates.some((left) => isSameUri(input.original, left))
          && rightCandidates.some((right) => isSameUri(input.modified, right));
        const swapped = rightCandidates.some((right) => isSameUri(input.original, right))
          && leftCandidates.some((left) => isSameUri(input.modified, left));
        if (direct || swapped) matchingTabs.push(tab);
      }
    }
    if (matchingTabs.length === 0) return true;
    const closed = await vscode.window.tabGroups.close(matchingTabs, true);
    return closed !== false;
  }

  private assertNormalMode(): void {
    if (this.staleReasonValue) {
      throw new Error(t('{0}\n比較を更新してから操作してください。', this.staleReasonValue));
    }
    if (this.session.mode === 'readonly') {
      throw new Error(t('読み取り専用比較ではコピーや保存を実行できません。通常比較へ切り替えてください。'));
    }
  }

  private async showPostCopyActions(
    direction: CopyDirection,
    hunk: DiffHunk | undefined,
    differenceResolved: boolean,
  ): Promise<void> {
    const targetSide = directionSides(direction).target;
    const sourceSide = directionSides(direction).source;
    const targetIdentity = this.requireIdentity(targetSide);
    const message = hunk
      ? t('変更箇所{0}を{1}から{2}へコピーしました。', hunk.index, sideLabel(sourceSide), sideLabel(targetSide))
      : t('{0}ファイル全体を{1}へコピーしました。', sideLabel(sourceSide), sideLabel(targetSide));
    this.output.info(`${message} target=${targetIdentity.relativePath} resolved=${differenceResolved}`);
    const statusBarEnabled = vscode.workspace.getConfiguration('easyLeftRightDiff').get<boolean>(
      'copyNotification',
      true,
    );
    if (statusBarEnabled) vscode.window.setStatusBarMessage(message, 5000);

    const action = await this.ui.showInformationMessage(
      t('{0} このコピーを元に戻しますか？', message),
      {
        modal: true,
        detail: [
          t('変更された側：{0}', sideLabel(targetSide)),
          targetIdentity.relativePath,
          '',
          ...this.saveBehaviorLines(targetIdentity.uri),
          t('［コピー前の状態へ戻す］：今行ったコピーだけを正確に戻します。'),
          t('［コピーしたまま続ける］：コピー結果を残して比較を続けます。'),
          t('Escまたは右上の×で閉じた場合も、コピー結果を残し、比較とL・Rを維持します。'),
        ].join('\n'),
      },
      // 先頭を主動線として強調表示し、復元は2番目の補助ボタンとしてキャンセル系の見た目にします。
      // Esc／×を復元へ割り当てず、閉じた場合はコピー結果を残す従来動作を維持します。
      POST_COPY_ACTIONS.keep,
      POST_COPY_ACTIONS.undo,
    );
    if (action === POST_COPY_ACTIONS.undo) {
      await this.restoreLastCopy(false);
      return;
    }
    const autoMove = vscode.workspace.getConfiguration('easyLeftRightDiff').get<boolean>(
      'autoMoveAfterCopy',
      false,
    );
    if (autoMove) await this.moveToNextDifference();
  }

  private scheduleAutoReveal(side: ComparisonSide | undefined): void {
    if (this.autoRevealTimer) clearTimeout(this.autoRevealTimer);
    if (!side) return;
    const mode = vscode.workspace.getConfiguration('easyLeftRightDiff').get<string>('autoReveal', 'button');
    if (mode !== 'active-side') return;
    const identity = side === 'left' ? this.session.left : this.session.right;
    if (!identity || identity.outsideWorkspace) return;
    const key = `${side}:${identity.uri.toString(true)}`;
    if (key === this.lastAutoRevealKey) return;
    this.autoRevealTimer = setTimeout(() => {
      this.lastAutoRevealKey = key;
      void this.revealSide(side);
    }, 350);
  }

  private async waitForDocumentText(document: vscode.TextDocument, expectedText: string): Promise<boolean> {
    // workspace.applyEditの完了直後でも、VS Code／Cursor側の文書反映が次のイベントループになる場合があります。
    // 短時間だけ正式TextDocumentの全文を再確認し、反映待ちを失敗と誤判定しません。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (document.getText() === expectedText) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    const latest = await vscode.workspace.openTextDocument(document.uri);
    return latest.getText() === expectedText;
  }

  private expectInternalTextChange(document: vscode.TextDocument, expectedText: string): void {
    const key = document.uri.toString(true);
    const pending: PendingInternalTextChange = {
      expectedText,
      expiresAt: Date.now() + 3000,
    };
    // VS Code／Cursorは、同じ編集結果について変更通知を遅延または複数回通知する場合があります。
    // 1回目だけで期待値を消さず、同じ全文の通知を有効時間内はすべて本ツール操作として扱います。
    this.pendingInternalTextChanges.set(key, pending);
    setTimeout(() => {
      if (this.pendingInternalTextChanges.get(key) === pending) this.pendingInternalTextChanges.delete(key);
    }, 3100);
  }

  private consumeExpectedInternalTextChange(document: vscode.TextDocument): boolean {
    const key = document.uri.toString(true);
    const pending = this.pendingInternalTextChanges.get(key);
    if (!pending) return false;
    if (Date.now() > pending.expiresAt) {
      this.pendingInternalTextChanges.delete(key);
      return false;
    }
    // VS Code／Cursorでは同じ編集結果の通知でもversionが進む場合があります。
    // 有効時間内かつ全文が期待結果と完全一致する通知だけを、本ツール自身の編集として除外します。
    // 全文が違う後続編集は除外しないため、安全条件は弱めません。
    return document.getText() === pending.expectedText;
  }


  private clearCopyHistory(): void {
    this.lastCopyValue = undefined;
    this.lastCopyTextValue = undefined;
    this.lastUndoneCopyValue = undefined;
    this.lastUndoneCopyTextValue = undefined;
  }

  private resetManagedState(): void {
    this.tabReconcileGeneration += 1;
    if (this.tabReconcileTimer) {
      clearTimeout(this.tabReconcileTimer);
      this.tabReconcileTimer = undefined;
    }
    this.differenceSummaryRefreshGeneration += 1;
    if (this.differenceSummaryRefreshTimer) {
      clearTimeout(this.differenceSummaryRefreshTimer);
      this.differenceSummaryRefreshTimer = undefined;
    }
    this.differenceCountValue = undefined;
    this.diffOpenedValue = false;
    this.managedEditorUrisValue = undefined;
    this.activeSideValue = undefined;
    this.managedDiffActiveValue = false;
    this.clearCopyHistory();
    this.reviewedRecoveryValue = undefined;
    this.pendingInternalTextChanges.clear();
    this.leftDirtyValue = false;
    this.rightDirtyValue = false;
    this.locallyEditedUris.clear();
    this.lastAutoRevealKey = undefined;
    this.staleReasonValue = undefined;
    this.readonlyProvider.clear();
    this.editableProvider.clear();
  }

  private setDirtyState(side: ComparisonSide, dirty: boolean): void {
    if (side === 'left') this.leftDirtyValue = dirty;
    else this.rightDirtyValue = dirty;
  }

  private async refreshDirtyState(): Promise<void> {
    const snapshot = this.getSessionSnapshot();
    if (!snapshot) {
      this.leftDirtyValue = false;
      this.rightDirtyValue = false;
      return;
    }
    const [leftDocument, rightDocument] = await Promise.all([
      this.openComparisonDocument('left', snapshot),
      this.openComparisonDocument('right', snapshot),
    ]);
    this.leftDirtyValue = leftDocument.isDirty;
    this.rightDirtyValue = rightDocument.isDirty;
  }

  private async publishState(): Promise<void> {
    const state = this.getState();
    await Promise.all([
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.leftSelected, Boolean(state.left)),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.rightSelected, Boolean(state.right)),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.bothSelected, Boolean(state.left && state.right)),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.comparisonOpen, state.diffOpened),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.managedDiffActive, this.managedDiffActiveValue),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.sameName, state.sameDisplayName),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.normalMode, state.mode === 'normal'),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.readonlyMode, state.mode === 'readonly'),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.activeLeft, state.activeSide === 'left'),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.activeRight, state.activeSide === 'right'),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.hasLastCopy, Boolean(state.lastCopy)),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.leftDirty, state.leftDirty),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.rightDirty, state.rightDirty),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.stale, Boolean(state.staleReason)),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.hasRecent, state.recentComparisonCount > 0),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.hasRecovery, state.recoveryCount > 0),
      vscode.commands.executeCommand('setContext', CONTEXT_KEYS.hasPendingRestoreFormat, this.pendingRestoreFormats.size > 0 || this.pendingRestoreFormatCandidates.size > 0),
    ]);
    this.stateEmitter.fire(state);
  }

  private reportError(prefix: string, error: unknown): void {
    const detail = toUserFacingErrorDetail(error);
    this.output.error(prefix, error);
    void this.ui.showErrorMessage(`${prefix}\n${detail}`);
  }

  /** コマンド登録層まで漏れた例外も、日本語通知とローカル出力へ安全に収束させます。 */
  public reportUnexpectedCommandError(action: string, error: unknown): void {
    this.reportError(t('{0}を実行できませんでした。', action), error);
  }

  public dispose(): void {
    if (this.autoRevealTimer) clearTimeout(this.autoRevealTimer);
    if (this.tabReconcileTimer) clearTimeout(this.tabReconcileTimer);
    if (this.differenceSummaryRefreshTimer) clearTimeout(this.differenceSummaryRefreshTimer);
    this.stateEmitter.dispose();
  }
}
