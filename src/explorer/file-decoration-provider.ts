import * as vscode from 'vscode';
import type { FileIdentity } from '../shared-types';
import type { ComparisonSession } from '../state/comparison-session';
import { t } from '../localization';

export interface DecorationDescriptor {
  readonly badge: string;
  readonly tooltip: string;
  readonly colorId?: string;
  readonly propagate: boolean;
}

function normalizeUriPath(uri: vscode.Uri): string {
  return uri.path.replace(/\/+$/, '');
}

function isAncestor(candidate: vscode.Uri, file: vscode.Uri): boolean {
  if (candidate.scheme !== file.scheme || candidate.authority !== file.authority) {
    return false;
  }
  const candidatePath = `${normalizeUriPath(candidate)}/`;
  return normalizeUriPath(file).startsWith(candidatePath);
}

function identityTooltip(side: string, identity: FileIdentity, highlighted: boolean): string {
  const workspace = identity.workspaceName ?? t('ワークスペース外');
  const highlight = highlighted ? t('\n\n場所を表示しました。') : '';
  return t('{0}に設定中\n\nワークスペース：{1}\n場所：{2}{3}', side, workspace, identity.relativePath, highlight);
}

/** 実ファイルは強いL/R、親フォルダーは弱いL/R/LRを返します。 */
export function describeDecoration(
  uri: vscode.Uri,
  session: ComparisonSession,
  highlightedUriKey?: string,
  showParentFolders = true,
): DecorationDescriptor | undefined {
  const left = session.left;
  const right = session.right;
  const uriKey = uri.toString(true);
  const highlighted = highlightedUriKey === uriKey;

  if (left && uriKey === left.uri.toString(true)) {
    return {
      badge: highlighted ? 'L!' : 'L',
      tooltip: identityTooltip(t('L・左側'), left, highlighted),
      // 通常比較は専用URIを使うため、実ファイルの識別色が差分タブへ波及しません。
      // 仕様どおり、実ファイルは青系、場所表示直後は強い青系で識別します。
      colorId: highlighted ? 'easyLeftRightDiff.leftHighlight' : 'easyLeftRightDiff.leftBadge',
      propagate: false,
    };
  }
  if (right && uriKey === right.uri.toString(true)) {
    return {
      badge: highlighted ? 'R!' : 'R',
      tooltip: identityTooltip(t('R・右側'), right, highlighted),
      // 仕様どおり、実ファイルは紫系、場所表示直後は強い紫系で識別します。
      colorId: highlighted ? 'easyLeftRightDiff.rightHighlight' : 'easyLeftRightDiff.rightBadge',
      propagate: false,
    };
  }

  if (!showParentFolders) return undefined;

  const containsLeft = left ? isAncestor(uri, left.uri) : false;
  const containsRight = right ? isAncestor(uri, right.uri) : false;
  if (!containsLeft && !containsRight) {
    return undefined;
  }
  return {
    badge: containsLeft && containsRight ? 'LR' : containsLeft ? 'L' : 'R',
    tooltip: containsLeft && containsRight
      ? t('L・左側とR・右側の対象ファイルを含むフォルダー')
      : containsLeft
        ? t('L・左側の対象ファイルを含むフォルダー')
        : t('R・右側の対象ファイルを含むフォルダー'),
    // 親フォルダーは弱い表示とし、文字色はテーマ標準へ任せます。
    // 実ファイルだけにL青／R紫の強い補助色を使用します。
    colorId: undefined,
    propagate: false,
  };
}

/** 標準エクスプローラーへ正式APIでL・R装飾を提供します。 */
export class LeftRightFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  private highlightedUriKey: string | undefined;
  private highlightTimer: ReturnType<typeof setTimeout> | undefined;
  public readonly onDidChangeFileDecorations = this.emitter.event;

  public constructor(private readonly session: ComparisonSession) {}

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const showParentFolders = vscode.workspace.getConfiguration('easyLeftRightDiff').get<boolean>(
      'showParentFolderDecorations',
      true,
    );
    const descriptor = describeDecoration(uri, this.session, this.highlightedUriKey, showParentFolders);
    if (!descriptor) {
      return undefined;
    }
    const decoration = new vscode.FileDecoration(
      descriptor.badge,
      descriptor.tooltip,
      descriptor.colorId ? new vscode.ThemeColor(descriptor.colorId) : undefined,
    );
    decoration.propagate = descriptor.propagate;
    return decoration;
  }

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public highlight(uri: vscode.Uri, durationMs = 1800): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightedUriKey = uri.toString(true);
    this.refresh();
    this.highlightTimer = setTimeout(() => {
      this.highlightedUriKey = undefined;
      this.highlightTimer = undefined;
      this.refresh();
    }, durationMs);
  }

  public dispose(): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = undefined;
    this.emitter.dispose();
  }
}
