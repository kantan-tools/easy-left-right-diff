import * as vscode from 'vscode';
import { isSameOrDescendantUri, isSameUri, mapUriThroughRenames, uriIdentityKey } from '../files/file-identity';
import { t } from '../localization';
import type { RecoverySnapshot } from '../shared-types';

const MANIFEST_FILE = 'manifest.json';
const MANIFEST_BACKUP_FILE = 'manifest.backup.json';
const SHARED_LOCK_FILE = 'manifest.lock';
const SHARED_LOCK_RECOVERY_FILE = 'manifest.lock.recovery';
const SHARED_LOCK_HEARTBEAT_PREFIX = 'manifest.lock.heartbeat';
const CREATION_JOURNAL_FILE = 'creation-journal.json';
const QUARANTINE_DIRECTORY = 'quarantine';
const MANIFEST_SCHEMA_VERSION = 6;
const MAX_PER_FILE = 3;
const MAX_TOTAL = 30;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const LOCK_LEASE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_WAIT_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 25;
const MANIFEST_READ_RETRIES = 3;
const FILE_READ_RETRIES = 3;
const FILE_READ_RETRY_MS = 40;
const MAX_QUARANTINE_FILES = 30;
const MAX_QUARANTINE_BYTES = 60 * 1024 * 1024;
const MAX_DELETION_PENDING_FILES = 30;
const MAX_DELETION_PENDING_BYTES = 60 * 1024 * 1024;
const MAX_LOCK_FUTURE_MS = 5 * 60_000;
const INVALID_LOCK_RECOVERY_GRACE_MS = LOCK_LEASE_MS + (LOCK_HEARTBEAT_MS * 2);
const LOCK_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTENT_HASH_PATTERN = /^fnv1a64:[0-9a-f]{16}$/;

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

type RecoveryTargetState = RecoverySnapshot['targetState'];
type RecoveryRecordState = 'pending' | 'committed' | 'quarantine-pending' | 'deletion-pending';

interface StoredRecoveryRecord {
  readonly id: string;
  readonly targetUri: string;
  readonly targetState: RecoveryTargetState;
  readonly targetCtime: number | undefined;
  readonly recordState: RecoveryRecordState;
  readonly createdAt: string;
  readonly reason: RecoverySnapshot['reason'];
  readonly byteLength: number;
  readonly contentFile: string;
  readonly contentHash: string | undefined;
}

interface RecoveryManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly generation: number;
  readonly records: readonly StoredRecoveryRecord[];
}

interface InvalidSafeContentRecord {
  readonly id: string;
  readonly contentFile: string;
  readonly createdAt: string;
}

interface ParsedRecords {
  readonly records: readonly StoredRecoveryRecord[];
  readonly invalidRecordCount: number;
  readonly invalidSafeContentRecords: readonly InvalidSafeContentRecord[];
}

interface ParsedManifest {
  readonly manifest: RecoveryManifest;
  readonly invalidRecordCount: number;
  readonly invalidSafeContentRecords: readonly InvalidSafeContentRecord[];
  readonly sourceSchemaVersion: number;
}

interface ManifestCandidateValid {
  readonly state: 'valid';
  readonly parsed: ParsedManifest;
}

interface ManifestCandidateMissing {
  readonly state: 'missing';
}

interface ManifestCandidateCorrupt {
  readonly state: 'corrupt';
}

interface ManifestCandidateError {
  readonly state: 'error';
  readonly error: unknown;
}

type ManifestCandidate = ManifestCandidateValid
  | ManifestCandidateMissing
  | ManifestCandidateCorrupt
  | ManifestCandidateError;

interface ManifestLoadResult {
  readonly manifest: RecoveryManifest;
  readonly invalidRecordCount: number;
  readonly invalidSafeContentRecords: readonly InvalidSafeContentRecord[];
  readonly sourceSchemaVersion: number;
  readonly restoredFromBackup: boolean;
}

interface CreationJournalEntry {
  readonly id: string;
  readonly contentFile: string;
  readonly createdAt: string;
  readonly byteLength: number;
}

interface PruneResult {
  readonly kept: readonly StoredRecoveryRecord[];
  readonly removed: readonly StoredRecoveryRecord[];
}

interface IntegrityIssue {
  readonly record: StoredRecoveryRecord;
  readonly content: Uint8Array | undefined;
}

interface IntegrityInspection {
  readonly records: readonly StoredRecoveryRecord[];
  readonly issues: readonly IntegrityIssue[];
}

interface QuarantineCopy {
  readonly issue: IntegrityIssue;
  readonly targetUri: vscode.Uri;
}

interface QuarantineResult {
  readonly copied: readonly QuarantineCopy[];
  readonly failed: readonly IntegrityIssue[];
  readonly discardedCount: number;
}

interface SharedLockPayload {
  readonly owner: string;
  readonly token: string;
  readonly updatedAt: number | undefined;
  readonly expiresAt: number;
}

interface ActiveSharedLease {
  readonly owner: string;
  readonly token: string;
  lost: boolean;
}

interface QuarantineEntry {
  readonly name: string;
  readonly uri: vscode.Uri;
  readonly byteLength: number;
  readonly modifiedAt: number;
}

interface RetriedFileReadFound {
  readonly state: 'found';
  readonly content: Uint8Array;
}

interface RetriedFileReadMissing {
  readonly state: 'missing';
}

type RetriedFileRead = RetriedFileReadFound | RetriedFileReadMissing;

interface RetriedStatFound {
  readonly state: 'found';
  readonly stat: vscode.FileStat;
}

interface RetriedStatMissing {
  readonly state: 'missing';
}

interface RetriedStatUnavailable {
  readonly state: 'unavailable';
  readonly error: unknown;
}

type RetriedStat = RetriedStatFound | RetriedStatMissing;
type ProbedStat = RetriedStat | RetriedStatUnavailable;

export type RecoveryTargetInspection = 'available' | 'verification-pending' | 'missing' | 'unavailable';

export interface RecoveryIntegrityStatus {
  readonly available: boolean;
  readonly quarantinedCount: number;
  readonly quarantinedBytes: number;
  readonly deletionPendingCount: number;
  readonly deletionPendingBytes: number;
  readonly restoredFromBackup: boolean;
}

const EMPTY_MANIFEST: RecoveryManifest = Object.freeze({
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  generation: 0,
  records: [],
});

function toSnapshot(record: StoredRecoveryRecord): RecoverySnapshot {
  return {
    id: record.id,
    targetUri: vscode.Uri.parse(record.targetUri, true),
    targetState: record.targetState,
    createdAt: record.createdAt,
    reason: record.reason,
    byteLength: record.byteLength,
  };
}

function isRecoveryReason(value: unknown): value is RecoverySnapshot['reason'] {
  return value === 'before-copy'
    || value === 'before-hunk-copy'
    || value === 'before-whole-copy'
    || value === 'before-save'
    || value === 'before-restore';
}

function isSafeRecoveryId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
}

function isSafeContentFile(id: string, value: string): boolean {
  return isSafeRecoveryId(id)
    && value === `${id}.bin`
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('..');
}

function isValidTargetUri(value: string): boolean {
  try {
    const uri = vscode.Uri.parse(value, true);
    return uri.scheme.length > 0;
  } catch {
    return false;
  }
}

function safeRecords(value: unknown, sourceSchemaVersion: number): ParsedRecords {
  if (!Array.isArray(value)) return { records: [], invalidRecordCount: 0, invalidSafeContentRecords: [] };
  const records: StoredRecoveryRecord[] = [];
  const invalidSafeContentRecords: InvalidSafeContentRecord[] = [];
  let invalidRecordCount = 0;
  for (const record of value) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      invalidRecordCount += 1;
      continue;
    }
    const item = record as Partial<StoredRecoveryRecord>;
    const validBase = typeof item.id === 'string'
      && typeof item.targetUri === 'string'
      && typeof item.createdAt === 'string'
      && !Number.isNaN(Date.parse(item.createdAt))
      && isRecoveryReason(item.reason)
      && typeof item.byteLength === 'number'
      && Number.isInteger(item.byteLength)
      && item.byteLength >= 0
      && Number.isSafeInteger(item.byteLength)
      && typeof item.contentFile === 'string'
      && isSafeRecoveryId(item.id)
      && isSafeContentFile(item.id, item.contentFile)
      && isValidTargetUri(item.targetUri)
      && (sourceSchemaVersion < 5
        || (typeof item.contentHash === 'string' && CONTENT_HASH_PATTERN.test(item.contentHash)));
    if (!validBase) {
      invalidRecordCount += 1;
      if (
        typeof item.id === 'string'
        && typeof item.contentFile === 'string'
        && isSafeContentFile(item.id, item.contentFile)
      ) {
        invalidSafeContentRecords.push({
          id: item.id,
          contentFile: item.contentFile,
          createdAt: typeof item.createdAt === 'string' && !Number.isNaN(Date.parse(item.createdAt))
            ? item.createdAt
            : new Date(0).toISOString(),
        });
      }
      continue;
    }
    const targetCtime = typeof item.targetCtime === 'number' && Number.isFinite(item.targetCtime)
      ? item.targetCtime
      : undefined;
    const targetState: RecoveryTargetState = item.targetState === 'verification-pending'
      ? 'verification-pending'
      : item.targetState === 'missing' || !reliableCtime(targetCtime)
        ? 'missing'
        : 'available';
    const recordState: RecoveryRecordState = item.recordState === 'pending'
      ? 'pending'
      : item.recordState === 'quarantine-pending'
        ? 'quarantine-pending'
        : item.recordState === 'deletion-pending'
          ? 'deletion-pending'
          : 'committed';
    const contentHash = typeof item.contentHash === 'string' && CONTENT_HASH_PATTERN.test(item.contentHash)
      ? item.contentHash
      : undefined;
    records.push({
      id: item.id,
      targetUri: item.targetUri,
      targetState,
      targetCtime,
      recordState,
      createdAt: item.createdAt,
      reason: item.reason,
      byteLength: item.byteLength,
      contentFile: item.contentFile,
      contentHash,
    });
  }
  return { records, invalidRecordCount, invalidSafeContentRecords };
}

function parseManifest(value: unknown): ParsedManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { schemaVersion?: unknown; generation?: unknown; records?: unknown };
  if (
    candidate.schemaVersion !== 1
    && candidate.schemaVersion !== 2
    && candidate.schemaVersion !== 3
    && candidate.schemaVersion !== 4
    && candidate.schemaVersion !== 5
    && candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION
  ) return undefined;
  if (!Array.isArray(candidate.records)) return undefined;
  const generation = typeof candidate.schemaVersion === 'number' && candidate.schemaVersion >= 5
    && typeof candidate.generation === 'number'
    && Number.isSafeInteger(candidate.generation)
    && candidate.generation >= 0
    ? candidate.generation
    : 0;
  const parsed = safeRecords(candidate.records, candidate.schemaVersion);
  return {
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generation,
      records: parsed.records,
    },
    invalidRecordCount: parsed.invalidRecordCount,
    invalidSafeContentRecords: parsed.invalidSafeContentRecords,
    sourceSchemaVersion: candidate.schemaVersion,
  };
}

function snapshotId(uri: vscode.Uri, now: Date): string {
  const safe = uri.toString(true).replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'file';
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${now.getTime()}-${safe}-${nonce}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function reliableCtime(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function hashBytes(bytes: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (const value of bytes) {
    hash ^= BigInt(value);
    hash = (hash * FNV_PRIME_64) & UINT64_MASK;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function isNotFoundError(error: unknown): boolean {
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseSharedLock(bytes: Uint8Array, now = Date.now()): SharedLockPayload | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Partial<SharedLockPayload>;
    if (typeof candidate.owner !== 'string' || !LOCK_OWNER_PATTERN.test(candidate.owner)) return undefined;
    if (typeof candidate.token !== 'string' || !LOCK_OWNER_PATTERN.test(candidate.token)) return undefined;
    if (typeof candidate.expiresAt !== 'number' || !Number.isFinite(candidate.expiresAt) || !Number.isSafeInteger(candidate.expiresAt)) return undefined;
    const updatedAt = typeof candidate.updatedAt === 'number'
      && Number.isFinite(candidate.updatedAt)
      && Number.isSafeInteger(candidate.updatedAt)
      ? candidate.updatedAt
      : undefined;
    if (candidate.expiresAt <= 0 || candidate.expiresAt > now + MAX_LOCK_FUTURE_MS) return undefined;
    if (updatedAt !== undefined && (updatedAt <= 0 || updatedAt > now + MAX_LOCK_FUTURE_MS || candidate.expiresAt <= updatedAt)) return undefined;
    return { owner: candidate.owner, token: candidate.token, updatedAt, expiresAt: candidate.expiresAt };
  } catch {
    return undefined;
  }
}

/** 本ツールが作成した復元履歴を拡張機能用領域だけへ保存します。 */
export class RecoveryStore {
  private readonly rootUri: vscode.Uri;
  private readonly manifestUri: vscode.Uri;
  private readonly backupManifestUri: vscode.Uri;
  private readonly sharedLockUri: vscode.Uri;
  private readonly creationJournalUri: vscode.Uri;
  private readonly sharedLockRecoveryUri: vscode.Uri;
  private readonly quarantineUri: vscode.Uri;
  private readonly instanceOwner = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  private initialized = false;
  private unavailableError: Error | undefined;
  private quarantinedCountValue = 0;
  private quarantinedBytesValue = 0;
  private deletionPendingCountValue = 0;
  private deletionPendingBytesValue = 0;
  private disabledWithoutQuarantineCountValue = 0;
  private disabledWithoutQuarantineBytesValue = 0;
  private unreferencedCountValue = 0;
  private unreferencedBytesValue = 0;
  private restoredFromBackupValue = false;
  private operationQueue: Promise<void> = Promise.resolve();
  private activeSharedLease: ActiveSharedLease | undefined;

  public constructor(storageUri: vscode.Uri) {
    this.rootUri = vscode.Uri.joinPath(storageUri, 'temporary-recovery');
    this.manifestUri = vscode.Uri.joinPath(this.rootUri, MANIFEST_FILE);
    this.backupManifestUri = vscode.Uri.joinPath(this.rootUri, MANIFEST_BACKUP_FILE);
    this.sharedLockUri = vscode.Uri.joinPath(this.rootUri, SHARED_LOCK_FILE);
    this.creationJournalUri = vscode.Uri.joinPath(this.rootUri, CREATION_JOURNAL_FILE);
    this.sharedLockRecoveryUri = vscode.Uri.joinPath(this.rootUri, SHARED_LOCK_RECOVERY_FILE);
    this.quarantineUri = vscode.Uri.joinPath(this.rootUri, QUARANTINE_DIRECTORY);
  }

  public initialize(): Promise<void> {
    return this.runSerialized(async () => this.initializeInternal());
  }

  public getIntegrityStatus(): Promise<RecoveryIntegrityStatus> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      if (!this.unavailableError) {
        try {
          await this.retryDeletionPendingAndEnforceLimits();
        } catch {
          // 削除待ち上限などで安全停止した場合も、現在の件数を状態表示へ返します。
        }
        if (!this.unavailableError) await this.refreshQuarantineStats();
      }
      return Object.freeze({
        available: this.unavailableError === undefined,
        quarantinedCount: this.quarantinedCountValue,
        quarantinedBytes: this.quarantinedBytesValue,
        deletionPendingCount: this.deletionPendingCountValue,
        deletionPendingBytes: this.deletionPendingBytesValue,
        restoredFromBackup: this.restoredFromBackupValue,
      });
    });
  }

  public list(targetUri?: vscode.Uri): Promise<RecoverySnapshot[]> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      this.assertAvailable();
      const manifest = await this.reconcileAvailableTargetsInternal();
      const records = manifest.records.filter((record) => {
        if (record.recordState !== 'committed') return false;
        if (!targetUri) return true;
        return record.targetState === 'available' && isSameUri(vscode.Uri.parse(record.targetUri, true), targetUri);
      });
      return [...records]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(toSnapshot);
    });
  }

  public count(): Promise<number> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      if (this.unavailableError) return 0;
      return (await this.readManifest()).records.filter((record) => record.recordState === 'committed').length;
    });
  }

  public get(snapshotIdValue: string): Promise<RecoverySnapshot | undefined> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      this.assertAvailable();
      const manifest = await this.reconcileAvailableTargetsInternal();
      const record = manifest.records.find((item) => item.id === snapshotIdValue && item.recordState === 'committed');
      return record ? toSnapshot(record) : undefined;
    });
  }

  /** 表示専用の確認では保存状態を変更せず、存在・同一性・一時障害を区別します。 */
  public inspectTarget(snapshotIdValue: string): Promise<RecoveryTargetInspection> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      if (this.unavailableError) return 'unavailable';
      const manifest = await this.readManifest();
      const record = manifest.records.find((item) => item.id === snapshotIdValue && item.recordState === 'committed');
      if (!record) return 'missing';
      if (record.targetState === 'missing') return 'missing';
      const result = await this.probeStatWithRetry(vscode.Uri.parse(record.targetUri, true));
      if (result.state === 'unavailable') return 'unavailable';
      if (result.state === 'missing') return 'missing';
      if (!reliableCtime(record.targetCtime) || !reliableCtime(result.stat.ctime)) return 'missing';
      return record.targetCtime === result.stat.ctime ? 'available' : 'missing';
    });
  }

  /** 操作結果が確定するまで一覧・上限計算へ含めない仮履歴を作成します。 */
  public begin(
    targetUri: vscode.Uri,
    content: Uint8Array,
    reason: RecoverySnapshot['reason'],
    now = new Date(),
  ): Promise<RecoverySnapshot> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      this.assertAvailable();
      return this.beginInternal(targetUri, content, reason, now);
    });
  }

  /** 成功または実変更後の異常が確定した仮履歴だけを正式履歴へ昇格します。 */
  public commit(snapshotIdValue: string): Promise<RecoverySnapshot> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      this.assertAvailable();
      return this.commitInternal(snapshotIdValue);
    });
  }

  /** 内容変更前に失敗した操作の仮履歴を、既存履歴へ影響させず破棄します。 */
  public rollback(snapshotIdValue: string): Promise<boolean> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      this.assertAvailable();
      const manifest = await this.readManifest();
      const record = manifest.records.find((item) => item.id === snapshotIdValue && item.recordState === 'pending');
      if (!record) return false;
      await this.deleteRecordsTransaction(
        manifest,
        manifest.records.filter((item) => item.id !== snapshotIdValue),
        [record],
        t('失敗した操作の仮履歴内容を削除できなかったため、削除待ちとして保持しました。次回起動時に再試行します。'),
        true,
      );
      return true;
    });
  }

  /** 従来呼び出しとの互換用。作成から確定までを同じ直列処理内で完了します。 */
  public create(
    targetUri: vscode.Uri,
    content: Uint8Array,
    reason: RecoverySnapshot['reason'],
    now = new Date(),
  ): Promise<RecoverySnapshot> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      this.assertAvailable();
      const snapshot = await this.beginInternal(targetUri, content, reason, now);
      return this.commitInternal(snapshot.id);
    });
  }

  public read(snapshotIdValue: string): Promise<Uint8Array> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      this.assertAvailable();
      const manifest = await this.readManifest();
      const record = manifest.records.find((item) => item.id === snapshotIdValue && item.recordState === 'committed');
      if (!record) throw new Error(t('指定した復元履歴が見つかりません。'));
      const result = await this.readFileWithRetry(
        this.contentUri(record),
        t('復元履歴の内容を一時的に読み取れないため、安全のため復元履歴機能を停止しました。'),
      );
      if (result.state === 'missing') {
        await this.disableCorruptRecord(manifest, record, undefined);
        throw new Error(t('指定した復元履歴の内容が欠けているため、使用を停止しました。'));
      }
      const content = result.content;
      if (content.byteLength !== record.byteLength || (record.contentHash && hashBytes(content) !== record.contentHash)) {
        await this.disableCorruptRecord(manifest, record, content);
        throw new Error(t('指定した復元履歴の内容が破損しているため、使用を停止しました。'));
      }
      return content;
    });
  }

  public delete(snapshotIdValue: string): Promise<boolean> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      this.assertAvailable();
      const manifest = await this.readManifest();
      const record = manifest.records.find((item) => item.id === snapshotIdValue);
      if (!record) return false;
      await this.deleteRecordsTransaction(
        manifest,
        manifest.records.filter((item) => item.id !== snapshotIdValue),
        [record],
        t('復元履歴の内容ファイルを削除できなかったため、履歴を削除済みとして扱いません。次回起動時に再試行します。'),
        true,
      );
      return true;
    });
  }

  /** ファイルまたは親フォルダーの移動・改名へ、識別が一致する履歴だけを追従させます。 */
  public updateTargetsForRenames(
    renames: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[],
  ): Promise<readonly string[]> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      if (this.unavailableError || renames.length === 0) return [];
      const manifest = await this.readManifest();
      const affected: string[] = [];
      const records: StoredRecoveryRecord[] = [];
      for (const record of manifest.records) {
        if (record.recordState === 'quarantine-pending') {
          records.push(record);
          continue;
        }
        if (record.targetState === 'missing') {
          records.push(record);
          continue;
        }
        const currentUri = vscode.Uri.parse(record.targetUri, true);
        const nextUri = mapUriThroughRenames(currentUri, renames);
        if (nextUri) {
          affected.push(record.id);
          const probe = await this.probeStatWithRetry(nextUri);
          if (probe.state === 'unavailable') {
            records.push({ ...record, targetUri: nextUri.toString(true), targetState: 'verification-pending' });
          } else if (probe.state === 'found' && reliableCtime(probe.stat.ctime)) {
            // 正式な改名イベントは同じ対象の移動を示すため、コピー＋削除型のFSでctimeが変わっても新識別へ引き継ぎます。
            records.push({ ...record, targetUri: nextUri.toString(true), targetState: 'available', targetCtime: probe.stat.ctime });
          } else {
            records.push({ ...record, targetUri: nextUri.toString(true), targetState: 'missing' });
          }
          continue;
        }
        if (renames.some((rename) => isSameOrDescendantUri(currentUri, rename.newUri))) {
          affected.push(record.id);
          records.push({ ...record, targetState: 'missing' });
          continue;
        }
        records.push(record);
      }
      if (affected.length > 0) await this.writeNextManifest(manifest, records);
      return affected;
    });
  }

  /** 削除されたファイルまたは配下の履歴を「対象ファイルなし」にし、同じ場所の新規ファイルへ再接続しません。 */
  public markTargetsMissing(deletedUris: readonly vscode.Uri[]): Promise<readonly string[]> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      if (this.unavailableError) return [];
      return this.markAvailableTargetsMissingInternal(deletedUris);
    });
  }

  /** 新規作成された場所に残っていた旧履歴を切り離し、削除イベントを取り逃しても別ファイルへ再接続しません。 */
  public markReplacedTargetsMissing(createdUris: readonly vscode.Uri[]): Promise<readonly string[]> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      if (this.unavailableError) return [];
      return this.markAvailableTargetsMissingInternal(createdUris);
    });
  }

  /** 元ファイルには触れず、拡張機能用領域の復元履歴だけを全件削除します。 */
  public clearAll(): Promise<number> {
    return this.runSerialized(async () => {
      await this.initializeInternal();
      this.assertAvailable();
      const manifest = await this.readManifest();
      const committedCount = manifest.records.filter((record) => record.recordState === 'committed').length;
      await this.deleteRecordsTransaction(
        manifest,
        [],
        manifest.records,
        t('すべての復元履歴内容を削除できなかったため、削除待ちとして保持しました。次回起動時に再試行します。'),
        true,
      );
      await this.clearQuarantineContents();
      await this.writeCreationJournal([]);
      await this.clearRootRecoveryArtifacts();
      this.disabledWithoutQuarantineCountValue = 0;
      this.disabledWithoutQuarantineBytesValue = 0;
      this.unreferencedCountValue = 0;
      this.unreferencedBytesValue = 0;
      this.quarantinedCountValue = 0;
      this.quarantinedBytesValue = 0;
      this.deletionPendingCountValue = 0;
      this.deletionPendingBytesValue = 0;
      return committedCount;
    });
  }

  /** 保存情報が破損して通常操作を停止している場合も、拡張機能用領域だけを安全に初期化します。 */
  public resetStorage(): Promise<void> {
    return this.runSerialized(async () => {
      await vscode.workspace.fs.createDirectory(this.rootUri);
      const entries = await vscode.workspace.fs.readDirectory(this.rootUri);
      for (const [name] of entries) {
        if (name === SHARED_LOCK_FILE || name === SHARED_LOCK_RECOVERY_FILE || name.startsWith(`${SHARED_LOCK_HEARTBEAT_PREFIX}.`)) continue;
        const uri = vscode.Uri.joinPath(this.rootUri, name);
        try {
          await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw new Error(t('復元履歴の保存領域を完全に初期化できませんでした。削除できないファイルを確認してください。'));
          }
        }
      }
      await this.writeManifestFileAtomically(this.manifestUri, EMPTY_MANIFEST);
      await this.writeManifestFileAtomically(this.backupManifestUri, EMPTY_MANIFEST);
      const remaining = await vscode.workspace.fs.readDirectory(this.rootUri);
      const unexpected = remaining.filter(([name]) =>
        name !== SHARED_LOCK_FILE
        && name !== SHARED_LOCK_RECOVERY_FILE
        && !name.startsWith(`${SHARED_LOCK_HEARTBEAT_PREFIX}.`)
        && name !== MANIFEST_FILE
        && name !== MANIFEST_BACKUP_FILE);
      if (unexpected.length > 0) {
        throw new Error(t('復元履歴の保存領域に削除できないデータが残っているため、初期化を完了できませんでした。'));
      }
      this.unavailableError = undefined;
      this.initialized = true;
      this.quarantinedCountValue = 0;
      this.quarantinedBytesValue = 0;
      this.deletionPendingCountValue = 0;
      this.deletionPendingBytesValue = 0;
      this.disabledWithoutQuarantineCountValue = 0;
      this.disabledWithoutQuarantineBytesValue = 0;
      this.unreferencedCountValue = 0;
      this.unreferencedBytesValue = 0;
      this.restoredFromBackupValue = false;
    });
  }

  /** 復元履歴と同じ複数ウィンドウ排他で、関連する小さな永続状態を更新します。 */
  public runSharedTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.runSerialized(operation);
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(
      () => this.withSharedLock(operation),
      () => this.withSharedLock(operation),
    );
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private heartbeatUri(lease: Pick<ActiveSharedLease, 'owner' | 'token'>): vscode.Uri {
    return vscode.Uri.joinPath(this.rootUri, `${SHARED_LOCK_HEARTBEAT_PREFIX}.${lease.owner}.${lease.token}.json`);
  }

  private lockBytes(owner: string, token: string): Uint8Array {
    const updatedAt = Date.now();
    return new TextEncoder().encode(`${JSON.stringify({ owner, token, updatedAt, expiresAt: updatedAt + LOCK_LEASE_MS })}\n`);
  }

  private heartbeatBytes(lease: Pick<ActiveSharedLease, 'owner' | 'token'>): Uint8Array {
    const updatedAt = Date.now();
    return new TextEncoder().encode(`${JSON.stringify({ owner: lease.owner, token: lease.token, updatedAt, expiresAt: updatedAt + LOCK_LEASE_MS })}\n`);
  }

  private async withSharedLock<T>(operation: () => Promise<T>): Promise<T> {
    await vscode.workspace.fs.createDirectory(this.rootUri);
    const lease: ActiveSharedLease = {
      owner: `${this.instanceOwner}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      token: `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`,
      lost: false,
    };
    await this.acquireSharedLock(lease);
    this.activeSharedLease = lease;
    let heartbeatActive = true;
    let heartbeatQueue: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(() => {
      heartbeatQueue = heartbeatQueue.then(async () => {
        if (heartbeatActive && !await this.renewSharedLock(lease)) lease.lost = true;
      }, async () => {
        if (heartbeatActive && !await this.renewSharedLock(lease)) lease.lost = true;
      });
    }, LOCK_HEARTBEAT_MS);
    try {
      await this.assertSharedLockLease(lease);
      const result = await operation();
      await this.assertSharedLockLease(lease);
      return result;
    } finally {
      heartbeatActive = false;
      clearInterval(heartbeat);
      await heartbeatQueue;
      if (this.activeSharedLease === lease) this.activeSharedLease = undefined;
      await this.releaseSharedLock(lease);
    }
  }

  private async recoveryGuardExists(): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(this.sharedLockRecoveryUri);
      const now = Date.now();
      const timestamp = this.lockFileTimestamp(stat, now);
      if (now - timestamp <= INVALID_LOCK_RECOVERY_GRACE_MS) return true;
      await vscode.workspace.fs.delete(this.sharedLockRecoveryUri);
      return false;
    } catch (error) {
      return !isNotFoundError(error);
    }
  }

  private async acquireRecoveryGuard(owner: string): Promise<boolean> {
    const temp = vscode.Uri.joinPath(this.rootUri, `${SHARED_LOCK_RECOVERY_FILE}.${owner}.tmp`);
    await vscode.workspace.fs.writeFile(temp, this.lockBytes(owner, owner));
    try {
      await vscode.workspace.fs.rename(temp, this.sharedLockRecoveryUri, { overwrite: false });
      return true;
    } catch {
      await this.deleteUriQuietly(temp);
      return false;
    }
  }

  private async releaseRecoveryGuard(owner: string): Promise<void> {
    try {
      const current = parseSharedLock(await vscode.workspace.fs.readFile(this.sharedLockRecoveryUri));
      if (current?.owner === owner) await vscode.workspace.fs.delete(this.sharedLockRecoveryUri);
    } catch {
      // 既に回収済みです。
    }
  }

  private async acquireSharedLock(lease: ActiveSharedLease): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < LOCK_WAIT_TIMEOUT_MS) {
      if (await this.recoveryGuardExists()) {
        await delay(LOCK_RETRY_MS);
        continue;
      }
      const tempUri = vscode.Uri.joinPath(this.rootUri, `${SHARED_LOCK_FILE}.${lease.owner}.${lease.token}.tmp`);
      await vscode.workspace.fs.writeFile(tempUri, this.lockBytes(lease.owner, lease.token));
      try {
        await vscode.workspace.fs.rename(tempUri, this.sharedLockUri, { overwrite: false });
        await vscode.workspace.fs.writeFile(this.heartbeatUri(lease), this.heartbeatBytes(lease));
        await this.assertSharedLockLease(lease);
        return;
      } catch {
        await this.deleteUriQuietly(tempUri);
        await this.deleteUriQuietly(this.heartbeatUri(lease));
      }
      if (await this.removeStaleSharedLock()) continue;
      await delay(LOCK_RETRY_MS);
    }
    throw new Error(t('別のVS Codeウィンドウが復元履歴を更新中のため、処理を開始できませんでした。もう一度実行してください。'));
  }

  private async renewSharedLock(lease: ActiveSharedLease): Promise<boolean> {
    if (lease.lost) return false;
    try {
      const current = parseSharedLock(await vscode.workspace.fs.readFile(this.sharedLockUri));
      if (current?.owner !== lease.owner || current.token !== lease.token) return false;
      const heartbeatUri = this.heartbeatUri(lease);
      const tempUri = vscode.Uri.joinPath(
        this.rootUri,
        `${SHARED_LOCK_HEARTBEAT_PREFIX}.${lease.owner}.${lease.token}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
      );
      await vscode.workspace.fs.writeFile(tempUri, this.heartbeatBytes(lease));
      const confirmed = parseSharedLock(await vscode.workspace.fs.readFile(this.sharedLockUri));
      if (confirmed?.owner !== lease.owner || confirmed.token !== lease.token) {
        await this.deleteUriQuietly(tempUri);
        return false;
      }
      await vscode.workspace.fs.rename(tempUri, heartbeatUri, { overwrite: true });
      return true;
    } catch {
      return false;
    }
  }

  private async assertSharedLockLease(lease = this.activeSharedLease): Promise<void> {
    if (!lease || lease.lost) throw new Error(t('復元履歴の共有ロック所有権を失ったため、安全のため処理を停止しました。'));
    try {
      const current = parseSharedLock(await vscode.workspace.fs.readFile(this.sharedLockUri));
      if (current?.owner !== lease.owner || current.token !== lease.token) {
        lease.lost = true;
        throw new Error(t('復元履歴の共有ロック所有権を失ったため、安全のため処理を停止しました。'));
      }
      const heartbeat = parseSharedLock(await vscode.workspace.fs.readFile(this.heartbeatUri(lease)));
      if (heartbeat?.owner !== lease.owner || heartbeat.token !== lease.token || heartbeat.expiresAt <= Date.now()) {
        lease.lost = true;
        throw new Error(t('復元履歴の共有ロック更新を確認できないため、安全のため処理を停止しました。'));
      }
    } catch (error) {
      lease.lost = true;
      throw error instanceof Error ? error : new Error(t('復元履歴の共有ロックを確認できませんでした。'));
    }
  }

  private async releaseSharedLock(lease: ActiveSharedLease): Promise<void> {
    try {
      const current = parseSharedLock(await vscode.workspace.fs.readFile(this.sharedLockUri));
      if (current?.owner === lease.owner && current.token === lease.token) await vscode.workspace.fs.delete(this.sharedLockUri);
    } catch {
      // 既に回収済みです。
    }
    await this.deleteUriQuietly(this.heartbeatUri(lease));
  }

  private lockFileTimestamp(stat: vscode.FileStat, now = Date.now()): number {
    const raw = Number.isFinite(stat.mtime) && stat.mtime > 0
      ? stat.mtime
      : Number.isFinite(stat.ctime) && stat.ctime > 0
        ? stat.ctime
        : 0;
    if (raw > now + MAX_LOCK_FUTURE_MS) return 0;
    return raw;
  }

  private async lockHeartbeatIsFresh(lock: SharedLockPayload, now = Date.now()): Promise<boolean> {
    const heartbeatUri = this.heartbeatUri(lock);
    try {
      const bytes = await vscode.workspace.fs.readFile(heartbeatUri);
      const heartbeat = parseSharedLock(bytes, now);
      if (heartbeat?.owner !== lock.owner || heartbeat.token !== lock.token || heartbeat.expiresAt <= now) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async removeStaleSharedLock(): Promise<boolean> {
    const guardOwner = `${this.instanceOwner}-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!await this.acquireRecoveryGuard(guardOwner)) return false;
    const tombstone = vscode.Uri.joinPath(this.rootUri, `${SHARED_LOCK_FILE}.stale.${guardOwner}.tmp`);
    try {
      let firstBytes: Uint8Array;
      try {
        firstBytes = await vscode.workspace.fs.readFile(this.sharedLockUri);
      } catch (error) {
        return isNotFoundError(error);
      }
      const firstStat = await this.probeStatWithRetry(this.sharedLockUri);
      if (firstStat.state === 'missing') return true;
      if (firstStat.state === 'unavailable') return false;
      const now = Date.now();
      const firstParsed = parseSharedLock(firstBytes, now);
      if (firstParsed && await this.lockHeartbeatIsFresh(firstParsed, now)) return false;
      if (!firstParsed && now - this.lockFileTimestamp(firstStat.stat, now) < INVALID_LOCK_RECOVERY_GRACE_MS) return false;
      await delay(LOCK_RETRY_MS);
      const secondBytes = await vscode.workspace.fs.readFile(this.sharedLockUri);
      if (!sameBytes(firstBytes, secondBytes)) return false;
      const secondParsed = parseSharedLock(secondBytes);
      if (secondParsed && await this.lockHeartbeatIsFresh(secondParsed)) return false;
      await vscode.workspace.fs.rename(this.sharedLockUri, tombstone, { overwrite: false });
      const moved = await vscode.workspace.fs.readFile(tombstone);
      if (!sameBytes(secondBytes, moved)) {
        try { await vscode.workspace.fs.rename(tombstone, this.sharedLockUri, { overwrite: false }); } catch { /* 新所有者を上書きしません */ }
        return false;
      }
      if (secondParsed && await this.lockHeartbeatIsFresh(secondParsed)) {
        try { await vscode.workspace.fs.rename(tombstone, this.sharedLockUri, { overwrite: false }); } catch { /* 新所有者を上書きしません */ }
        return false;
      }
      await this.deleteUriQuietly(tombstone);
      if (secondParsed) await this.deleteUriQuietly(this.heartbeatUri(secondParsed));
      return true;
    } catch (error) {
      return isNotFoundError(error);
    } finally {
      await this.deleteUriQuietly(tombstone);
      await this.releaseRecoveryGuard(guardOwner);
    }
  }

  private stopRecoveryForSession(message: string, _cause: unknown): never {
    const error = new Error(message);
    this.unavailableError = error;
    throw error;
  }

  private async readFileWithRetry(uri: vscode.Uri, failureMessage: string): Promise<RetriedFileRead> {
    let lastError: unknown;
    for (let attempt = 0; attempt < FILE_READ_RETRIES; attempt += 1) {
      try {
        return { state: 'found', content: await vscode.workspace.fs.readFile(uri) };
      } catch (error) {
        if (isNotFoundError(error)) return { state: 'missing' };
        lastError = error;
        if (attempt + 1 < FILE_READ_RETRIES) await delay(FILE_READ_RETRY_MS);
      }
    }
    return this.stopRecoveryForSession(failureMessage, lastError);
  }

  private async statWithRetry(uri: vscode.Uri, failureMessage: string): Promise<RetriedStat> {
    const result = await this.probeStatWithRetry(uri);
    if (result.state !== 'unavailable') return result;
    return this.stopRecoveryForSession(failureMessage, result.error);
  }

  private async probeStatWithRetry(uri: vscode.Uri): Promise<ProbedStat> {
    let lastError: unknown;
    for (let attempt = 0; attempt < FILE_READ_RETRIES; attempt += 1) {
      try {
        return { state: 'found', stat: await vscode.workspace.fs.stat(uri) };
      } catch (error) {
        if (isNotFoundError(error)) return { state: 'missing' };
        lastError = error;
        if (attempt + 1 < FILE_READ_RETRIES) await delay(FILE_READ_RETRY_MS);
      }
    }
    return { state: 'unavailable', error: lastError };
  }

  private async readCreationJournal(): Promise<CreationJournalEntry[]> {
    for (let attempt = 0; attempt < MANIFEST_READ_RETRIES; attempt += 1) {
      try {
        const bytes = await vscode.workspace.fs.readFile(this.creationJournalUri);
        const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(t('復元履歴の作成途中台帳が破損しています。'));
        }
        const candidate = parsed as { schemaVersion?: unknown; entries?: unknown };
        if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.entries)) {
          throw new Error(t('復元履歴の作成途中台帳が破損しています。'));
        }
        const result: CreationJournalEntry[] = [];
        for (const item of candidate.entries) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(t('復元履歴の作成途中台帳が破損しています。'));
          }
          const entry = item as Partial<CreationJournalEntry>;
          if (
            typeof entry.id !== 'string'
            || typeof entry.contentFile !== 'string'
            || !isSafeContentFile(entry.id, entry.contentFile)
            || typeof entry.createdAt !== 'string'
            || Number.isNaN(Date.parse(entry.createdAt))
            || typeof entry.byteLength !== 'number'
            || !Number.isSafeInteger(entry.byteLength)
            || entry.byteLength < 0
          ) {
            throw new Error(t('復元履歴の作成途中台帳が破損しています。'));
          }
          result.push({
            id: entry.id,
            contentFile: entry.contentFile,
            createdAt: entry.createdAt,
            byteLength: entry.byteLength,
          });
        }
        return result;
      } catch (error) {
        if (isNotFoundError(error)) return [];
        if (error instanceof SyntaxError || (error instanceof Error && error.message.includes(t('復元履歴の作成途中台帳が破損しています。')))) throw error;
        if (attempt + 1 >= MANIFEST_READ_RETRIES) throw error;
        await delay(FILE_READ_RETRY_MS);
      }
    }
    return [];
  }

  private async writeCreationJournal(entries: readonly CreationJournalEntry[]): Promise<void> {
    await this.assertSharedLockLease();
    if (entries.length === 0) {
      try {
        await vscode.workspace.fs.delete(this.creationJournalUri);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      return;
    }
    const tempUri = vscode.Uri.joinPath(
      this.rootUri,
      `${CREATION_JOURNAL_FILE}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    const bytes = new TextEncoder().encode(`${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`);
    await vscode.workspace.fs.writeFile(tempUri, bytes);
    try {
      await vscode.workspace.fs.rename(tempUri, this.creationJournalUri, { overwrite: true });
    } catch (error) {
      await this.deleteUriQuietly(tempUri);
      throw error;
    }
  }

  private async appendCreationJournal(entry: CreationJournalEntry): Promise<void> {
    const entries = await this.readCreationJournal();
    await this.writeCreationJournal([...entries.filter((item) => item.id !== entry.id), entry]);
  }

  private async removeCreationJournalEntry(id: string): Promise<void> {
    const entries = await this.readCreationJournal();
    if (!entries.some((item) => item.id === id)) return;
    await this.writeCreationJournal(entries.filter((item) => item.id !== id));
  }

  private async recoverCreationJournal(manifest: RecoveryManifest): Promise<RecoveryManifest> {
    const entries = await this.readCreationJournal();
    if (entries.length === 0) return manifest;
    const existing = new Set(manifest.records.map((record) => record.id));
    const recovered: StoredRecoveryRecord[] = [];
    for (const entry of entries) {
      if (existing.has(entry.id)) continue;
      const uri = this.contentUriFromIdentity(entry.id, entry.contentFile);
      const read = await this.readFileWithRetry(
        uri,
        t('作成途中の復元履歴内容を一時的に確認できないため、安全のため復元履歴機能を停止しました。'),
      );
      if (read.state === 'missing') continue;
      recovered.push({
        id: entry.id,
        targetUri: 'file:///',
        targetState: 'missing',
        targetCtime: undefined,
        recordState: 'deletion-pending',
        createdAt: entry.createdAt,
        reason: 'before-copy',
        byteLength: read.content.byteLength,
        contentFile: entry.contentFile,
        contentHash: hashBytes(read.content),
      });
    }
    let next = manifest;
    if (recovered.length > 0) next = await this.writeNextManifest(manifest, [...manifest.records, ...recovered]);
    await this.writeCreationJournal([]);
    return next;
  }

  private async initializeInternal(): Promise<void> {
    if (this.initialized) return;
    await vscode.workspace.fs.createDirectory(this.rootUri);
    try {
      const loaded = await this.loadManifest();
      this.restoredFromBackupValue ||= loaded.restoredFromBackup;
      let workingManifest = await this.recoverCreationJournal(loaded.manifest);
      const recovered: StoredRecoveryRecord[] = [];
      const removed: StoredRecoveryRecord[] = [];
      for (const record of workingManifest.records) {
        let next = record;
        if (record.recordState === 'deletion-pending') {
          if (!await this.tryDeleteContentFile(record)) recovered.push(record);
          continue;
        }
        if (record.recordState === 'quarantine-pending') {
          recovered.push(record);
          continue;
        }
        if (record.recordState === 'pending') {
          if (await this.pendingTargetIsUnchanged(record)) {
            removed.push(record);
            continue;
          }
          next = { ...next, recordState: 'committed' };
        }
        next = await this.reconcileRecordTarget(next);
        recovered.push(next);
      }
      const inspected = await this.inspectContentIntegrity(recovered);
      const validIds = new Set(workingManifest.records.map((record) => record.id));
      const invalidSafeIssues: IntegrityIssue[] = loaded.invalidSafeContentRecords
        .filter((record) => !validIds.has(record.id))
        .map((record) => ({
          record: {
            id: record.id,
            targetUri: 'file:///',
            targetState: 'missing',
            targetCtime: undefined,
            recordState: 'committed',
            createdAt: record.createdAt,
            reason: 'before-copy',
            byteLength: 0,
            contentFile: record.contentFile,
            contentHash: undefined,
          },
          content: undefined,
        }));
      const pruned = this.prune(inspected.records);
      const quarantine = await this.quarantineIssues([...inspected.issues, ...invalidSafeIssues]);
      const quarantinePending = quarantine.failed.map((issue): StoredRecoveryRecord => ({
        ...issue.record,
        recordState: 'quarantine-pending',
        byteLength: issue.content?.byteLength ?? issue.record.byteLength,
        contentHash: issue.content ? hashBytes(issue.content) : issue.record.contentHash,
      }));
      const nextRecords = [...pruned.kept, ...quarantinePending];
      await this.deleteRecordsTransaction(
        workingManifest,
        nextRecords,
        [...removed, ...pruned.removed, ...quarantine.copied.map((item) => item.issue.record)],
        t('不要になった復元履歴内容を削除できなかったため、削除待ちとして保持しました。次回起動時に再試行します。'),
        false,
      );
      this.disabledWithoutQuarantineCountValue = Math.max(0, loaded.invalidRecordCount - invalidSafeIssues.length)
        + quarantine.discardedCount;
      this.disabledWithoutQuarantineBytesValue = 0;
      this.unreferencedCountValue = 0;
      this.unreferencedBytesValue = 0;
      const unreferenced = await this.cleanupUnreferencedFiles(nextRecords);
      this.unreferencedCountValue = unreferenced.count;
      this.unreferencedBytesValue = unreferenced.byteLength;
      await this.enforceQuarantineLimits();
      await this.retryDeletionPendingAndEnforceLimits();
      await this.refreshQuarantineStats();
    } catch (error) {
      this.unavailableError = error instanceof Error ? error : new Error(String(error));
    }
    this.initialized = true;
  }

  private assertAvailable(): void {
    if (!this.unavailableError) return;
    throw new Error(t('復元履歴の保存情報を安全に読み取れないため、復元履歴機能を停止しました。'));
  }

  private async beginInternal(
    targetUri: vscode.Uri,
    content: Uint8Array,
    reason: RecoverySnapshot['reason'],
    now: Date,
  ): Promise<RecoverySnapshot> {
    await this.retryDeletionPendingAndEnforceLimits();
    const currentManifest = await this.readManifest();
    await this.refreshUnreferencedStatus(currentManifest.records);
    const id = snapshotId(targetUri, now);
    const contentFile = `${id}.bin`;
    const contentUri = this.contentUriFromIdentity(id, contentFile);
    const journalEntry: CreationJournalEntry = {
      id,
      contentFile,
      createdAt: now.toISOString(),
      byteLength: content.byteLength,
    };
    await this.appendCreationJournal(journalEntry);
    try {
      await vscode.workspace.fs.writeFile(contentUri, content);
      const manifest = await this.readManifest();
      const targetCtime = await this.readTargetCtime(targetUri);
      const nextRecord: StoredRecoveryRecord = {
        id,
        targetUri: targetUri.toString(true),
        targetState: reliableCtime(targetCtime) ? 'available' : 'missing',
        targetCtime,
        recordState: 'pending',
        createdAt: now.toISOString(),
        reason,
        byteLength: content.byteLength,
        contentFile,
        contentHash: hashBytes(content),
      };
      await this.writeNextManifest(manifest, [nextRecord, ...manifest.records]);
      await this.removeCreationJournalEntry(id);
      return toSnapshot(nextRecord);
    } catch (error) {
      let deleted = false;
      try {
        await vscode.workspace.fs.delete(contentUri);
        deleted = true;
      } catch (deleteError) {
        deleted = isNotFoundError(deleteError);
      }
      if (deleted) {
        try { await this.removeCreationJournalEntry(id); } catch { /* 次回起動時に既登録・欠損を再整理 */ }
      }
      throw error;
    }
  }

  private async commitInternal(snapshotIdValue: string): Promise<RecoverySnapshot> {
    const manifest = await this.readManifest();
    const record = manifest.records.find((item) => item.id === snapshotIdValue);
    if (!record) throw new Error(t('確定する復元履歴が見つかりません。'));
    const currentCtime = await this.readTargetCtime(vscode.Uri.parse(record.targetUri, true));
    const records: StoredRecoveryRecord[] = [];
    for (const item of manifest.records) {
      if (item.targetState !== 'available' || !isSameUri(vscode.Uri.parse(item.targetUri, true), vscode.Uri.parse(record.targetUri, true))) {
        records.push(item.id === snapshotIdValue ? { ...item, recordState: 'committed' } : item);
        continue;
      }
      if (item.id === snapshotIdValue) {
        records.push({
          ...item,
          targetState: reliableCtime(currentCtime) ? 'available' : 'missing',
          targetCtime: currentCtime,
          recordState: 'committed',
        });
        continue;
      }
      const sameIdentityAtBegin = reliableCtime(item.targetCtime)
        && reliableCtime(record.targetCtime)
        && item.targetCtime === record.targetCtime;
      records.push(
        sameIdentityAtBegin && reliableCtime(currentCtime)
          ? { ...item, targetCtime: currentCtime }
          : { ...item, targetState: 'missing' },
      );
    }
    const pruned = this.prune(records);
    await this.deleteRecordsTransaction(
      manifest,
      pruned.kept,
      pruned.removed,
      t('保存上限を超えた古い復元履歴内容を削除できなかったため、削除待ちとして保持しました。次回起動時に再試行します。'),
      false,
    );
    const keptRecord = pruned.kept.find((item) => item.id === snapshotIdValue);
    if (!keptRecord) throw new Error(t('復元履歴の保存上限により、作成した履歴を保持できませんでした。'));
    return toSnapshot(keptRecord);
  }

  private async markAvailableTargetsMissingInternal(targetUris: readonly vscode.Uri[]): Promise<readonly string[]> {
    if (targetUris.length === 0) return [];
    const manifest = await this.readManifest();
    const affected: string[] = [];
    const records = manifest.records.map((record): StoredRecoveryRecord => {
      if (record.targetState === 'missing') return record;
      const targetUri = vscode.Uri.parse(record.targetUri, true);
      if (!targetUris.some((changedUri) => isSameOrDescendantUri(targetUri, changedUri))) return record;
      affected.push(record.id);
      return { ...record, targetState: 'missing' };
    });
    if (affected.length > 0) await this.writeNextManifest(manifest, records);
    return affected;
  }

  private async reconcileAvailableTargetsInternal(): Promise<RecoveryManifest> {
    const manifest = await this.readManifest();
    const records: StoredRecoveryRecord[] = [];
    let changed = false;
    for (const record of manifest.records) {
      const next = await this.reconcileRecordTarget(record);
      records.push(next);
      changed ||= next !== record;
    }
    if (!changed) return manifest;
    return this.writeNextManifest(manifest, records);
  }

  private async reconcileRecordTarget(record: StoredRecoveryRecord): Promise<StoredRecoveryRecord> {
    if (record.recordState === 'quarantine-pending' || record.recordState === 'deletion-pending') return record;
    if (record.targetState === 'missing') return record;
    if (!reliableCtime(record.targetCtime)) return { ...record, targetState: 'missing' };
    const targetUri = vscode.Uri.parse(record.targetUri, true);
    const result = await this.statWithRetry(
      targetUri,
      t('復元履歴の対象ファイルの状態を一時的に確認できないため、安全のため復元履歴機能を停止しました。'),
    );
    if (result.state === 'missing') return { ...record, targetState: 'missing' };
    if (!reliableCtime(result.stat.ctime) || record.targetCtime !== result.stat.ctime) {
      return { ...record, targetState: 'missing' };
    }
    return record.targetState === 'available' ? record : { ...record, targetState: 'available' };
  }

  private async pendingTargetIsUnchanged(record: StoredRecoveryRecord): Promise<boolean> {
    if (record.targetState !== 'available') return false;
    const before = await this.readFileWithRetry(
      this.contentUri(record),
      t('復元履歴の内容を一時的に読み取れないため、安全のため復元履歴機能を停止しました。'),
    );
    if (before.state === 'missing') return false;
    const current = await this.readFileWithRetry(
      vscode.Uri.parse(record.targetUri, true),
      t('復元履歴の対象ファイルを一時的に読み取れないため、安全のため復元履歴機能を停止しました。'),
    );
    return current.state === 'found' && sameBytes(before.content, current.content);
  }

  private async readTargetCtime(targetUri: vscode.Uri): Promise<number | undefined> {
    const result = await this.statWithRetry(
      targetUri,
      t('復元履歴の対象ファイルの状態を一時的に確認できないため、この操作を中止しました。'),
    );
    return result.state === 'found' ? result.stat.ctime : undefined;
  }

  private async inspectContentIntegrity(records: readonly StoredRecoveryRecord[]): Promise<IntegrityInspection> {
    const valid: StoredRecoveryRecord[] = [];
    const issues: IntegrityIssue[] = [];
    for (const record of records) {
      const contentUri = this.contentUri(record);
      if (record.recordState === 'deletion-pending') {
        valid.push(record);
        continue;
      }
      if (record.recordState === 'quarantine-pending') {
        const readResult = await this.readFileWithRetry(
          contentUri,
          t('復元履歴の内容を一時的に読み取れないため、安全のため復元履歴機能を停止しました。'),
        );
        issues.push({ record, content: readResult.state === 'found' ? readResult.content : undefined });
        continue;
      }
      const statResult = await this.statWithRetry(
        contentUri,
        t('復元履歴の内容を一時的に確認できないため、安全のため復元履歴機能を停止しました。'),
      );
      if (statResult.state === 'missing') {
        issues.push({ record, content: undefined });
        continue;
      }
      let content: Uint8Array | undefined;
      if (statResult.stat.type !== vscode.FileType.File || statResult.stat.size !== record.byteLength) {
        const readResult = await this.readFileWithRetry(
          contentUri,
          t('復元履歴の内容を一時的に読み取れないため、安全のため復元履歴機能を停止しました。'),
        );
        content = readResult.state === 'found' ? readResult.content : undefined;
        issues.push({ record, content });
        continue;
      }
      const readResult = await this.readFileWithRetry(
        contentUri,
        t('復元履歴の内容を一時的に読み取れないため、安全のため復元履歴機能を停止しました。'),
      );
      if (readResult.state === 'missing') {
        issues.push({ record, content: undefined });
        continue;
      }
      content = readResult.content;
      const contentHash = hashBytes(content);
      if (record.contentHash && record.contentHash !== contentHash) {
        issues.push({ record, content });
        continue;
      }
      valid.push(record.contentHash ? record : { ...record, contentHash });
    }
    return { records: valid, issues };
  }

  private async disableCorruptRecord(
    manifest: RecoveryManifest,
    record: StoredRecoveryRecord,
    content: Uint8Array | undefined,
  ): Promise<void> {
    const quarantine = await this.quarantineIssues([{ record, content }]);
    const failed = quarantine.failed.some((item) => item.record.id === record.id);
    const records = manifest.records.flatMap((item): StoredRecoveryRecord[] => {
      if (item.id !== record.id) return [item];
      return failed ? [{
        ...item,
        recordState: 'quarantine-pending',
        byteLength: content?.byteLength ?? item.byteLength,
        contentHash: content ? hashBytes(content) : item.contentHash,
      }] : [];
    });
    await this.deleteRecordsTransaction(
      manifest,
      records,
      quarantine.copied.map((item) => item.issue.record),
      t('使用停止した復元履歴の元内容を削除できなかったため、削除待ちとして保持しました。次回起動時に再試行します。'),
      false,
    );
    this.disabledWithoutQuarantineCountValue += quarantine.discardedCount;
    await this.enforceQuarantineLimits();
    await this.refreshQuarantineStats();
  }

  private async quarantineIssues(issues: readonly IntegrityIssue[]): Promise<QuarantineResult> {
    if (issues.length === 0) return { copied: [], failed: [], discardedCount: 0 };
    await vscode.workspace.fs.createDirectory(this.quarantineUri);
    const copied: QuarantineCopy[] = [];
    const failed: IntegrityIssue[] = [];
    let discardedCount = 0;
    for (const issue of issues) {
      let content = issue.content;
      const sourceUri = this.contentUri(issue.record);
      if (!content) {
        const readResult = await this.readFileWithRetry(
          sourceUri,
          t('復元履歴の内容を一時的に読み取れないため、安全のため復元履歴機能を停止しました。'),
        );
        if (readResult.state === 'missing') {
          discardedCount += 1;
          continue;
        }
        content = readResult.content;
      }
      const resolvedIssue: IntegrityIssue = { ...issue, content };
      const quarantineName = `${Date.now()}-${issue.record.id}-${Math.random().toString(36).slice(2, 8)}.bin`;
      const quarantineTarget = vscode.Uri.joinPath(this.quarantineUri, quarantineName);
      try {
        await vscode.workspace.fs.writeFile(quarantineTarget, content);
        copied.push({ issue: resolvedIssue, targetUri: quarantineTarget });
      } catch {
        // 隔離先へ保存できない場合も、保存領域外へは絶対に触れません。
        failed.push(resolvedIssue);
      }
    }
    return { copied, failed, discardedCount };
  }

  private async readQuarantineEntries(): Promise<readonly QuarantineEntry[]> {
    let entries: readonly [string, vscode.FileType][] | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < FILE_READ_RETRIES; attempt += 1) {
      try {
        entries = await vscode.workspace.fs.readDirectory(this.quarantineUri);
        break;
      } catch (error) {
        if (isNotFoundError(error)) return [];
        lastError = error;
        if (attempt + 1 < FILE_READ_RETRIES) await delay(FILE_READ_RETRY_MS);
      }
    }
    if (!entries) {
      return this.stopRecoveryForSession(
        t('使用停止データの件数と容量を一時的に確認できないため、安全のため復元履歴機能を停止しました。'),
        lastError,
      );
    }
    const result: QuarantineEntry[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      const uri = vscode.Uri.joinPath(this.quarantineUri, name);
      const stat = await this.statWithRetry(
        uri,
        t('使用停止データの容量を一時的に確認できないため、安全のため復元履歴機能を停止しました。'),
      );
      if (stat.state !== 'found') continue;
      result.push({
        name,
        uri,
        byteLength: Math.max(0, stat.stat.size),
        modifiedAt: Number.isFinite(stat.stat.mtime) && stat.stat.mtime > 0 ? stat.stat.mtime : stat.stat.ctime,
      });
    }
    return result;
  }

  private async enforceQuarantineLimits(): Promise<void> {
    const manifest = await this.readManifest();
    const entries = await this.readQuarantineEntries();
    const pending = await this.quarantinePendingCandidates(manifest);
    const stored = entries.map((entry) => ({
      kind: 'stored' as const,
      entry,
      byteLength: entry.byteLength,
      modifiedAt: entry.modifiedAt,
      name: entry.name,
    }));
    const candidates = [...pending, ...stored]
      .sort((left, right) => left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name));
    let totalCount = this.disabledWithoutQuarantineCountValue + this.unreferencedCountValue + candidates.length;
    let totalBytes = this.disabledWithoutQuarantineBytesValue + this.unreferencedBytesValue
      + candidates.reduce((sum, item) => sum + item.byteLength, 0);
    const removedPending: StoredRecoveryRecord[] = [];
    const removedStored: QuarantineEntry[] = [];
    while (totalCount > MAX_QUARANTINE_FILES || totalBytes > MAX_QUARANTINE_BYTES) {
      const oldest = candidates.shift();
      if (!oldest) break;
      totalCount = Math.max(this.disabledWithoutQuarantineCountValue + this.unreferencedCountValue, totalCount - 1);
      totalBytes = Math.max(this.disabledWithoutQuarantineBytesValue + this.unreferencedBytesValue, totalBytes - oldest.byteLength);
      if (oldest.kind === 'pending') removedPending.push(oldest.record);
      else removedStored.push(oldest.entry);
    }

    if (removedPending.length > 0) {
      const removedIds = new Set(removedPending.map((record) => record.id));
      await this.deleteRecordsTransaction(
        manifest,
        manifest.records.filter((record) => !removedIds.has(record.id)),
        removedPending,
        t('隔離待ちの復元履歴を保存上限内へ整理できないため、安全のため新しい復元履歴の追加を停止しました。'),
        true,
      );
    }
    for (const entry of removedStored) {
      await this.deleteUriRequired(
        entry.uri,
        t('使用停止データを保存上限内へ整理できないため、安全のため新しい復元履歴の追加を停止しました。'),
      );
    }
    if (
      this.disabledWithoutQuarantineCountValue + this.unreferencedCountValue > MAX_QUARANTINE_FILES
      || this.disabledWithoutQuarantineBytesValue + this.unreferencedBytesValue > MAX_QUARANTINE_BYTES
    ) {
      this.stopRecoveryForSession(
        t('使用停止領域へ移せない未参照データが保存上限を超えたため、安全のため新しい復元履歴の追加を停止しました。保存領域の安全な初期化を実行してください。'),
        undefined,
      );
    }
  }

  private async refreshQuarantineStats(): Promise<void> {
    const entries = await this.readQuarantineEntries();
    const manifest = await this.readManifest();
    const pending = await this.quarantinePendingCandidates(manifest);
    this.quarantinedCountValue = this.disabledWithoutQuarantineCountValue + this.unreferencedCountValue + entries.length + pending.length;
    this.quarantinedBytesValue = this.disabledWithoutQuarantineBytesValue + this.unreferencedBytesValue
      + entries.reduce((sum, entry) => sum + entry.byteLength, 0)
      + pending.reduce((sum, item) => sum + item.byteLength, 0);
  }

  private async clearQuarantineContents(): Promise<void> {
    let entries: readonly [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.quarantineUri);
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    for (const [name] of entries) {
      const uri = vscode.Uri.joinPath(this.quarantineUri, name);
      try {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
  }

  private contentUri(record: StoredRecoveryRecord): vscode.Uri {
    return this.contentUriFromIdentity(record.id, record.contentFile);
  }

  private contentUriFromIdentity(id: string, contentFile: string): vscode.Uri {
    if (!isSafeContentFile(id, contentFile)) {
      throw new Error(t('復元履歴の保存場所が不正なため、この履歴を使用できません。'));
    }
    return vscode.Uri.joinPath(this.rootUri, `${id}.bin`);
  }

  private async tryDeleteContentFile(record: StoredRecoveryRecord): Promise<boolean> {
    try {
      await vscode.workspace.fs.delete(this.contentUri(record));
      return true;
    } catch (error) {
      return isNotFoundError(error);
    }
  }

  private async deleteRecordsTransaction(
    expected: RecoveryManifest,
    keptRecords: readonly StoredRecoveryRecord[],
    recordsToDelete: readonly StoredRecoveryRecord[],
    failureMessage: string,
    throwOnFailure: boolean,
  ): Promise<RecoveryManifest> {
    const uniqueToDelete = [...new Map(recordsToDelete.map((record) => [record.id, record])).values()]
      .filter((record) => !keptRecords.some((kept) => kept.id === record.id));
    if (uniqueToDelete.length === 0) {
      if (expected.records === keptRecords) return expected;
      return this.writeNextManifest(expected, keptRecords);
    }
    const deletionPending = uniqueToDelete.map((record): StoredRecoveryRecord => ({
      ...record,
      recordState: 'deletion-pending',
    }));
    const marked = await this.writeNextManifest(expected, [...keptRecords, ...deletionPending]);
    const failed: StoredRecoveryRecord[] = [];
    for (const record of deletionPending) {
      if (!await this.tryDeleteContentFile(record)) failed.push(record);
    }
    const completed = await this.writeNextManifest(marked, [...keptRecords, ...failed]);
    if (failed.length > 0 && throwOnFailure) throw new Error(failureMessage);
    return completed;
  }

  private async retryDeletionPendingAndEnforceLimits(): Promise<void> {
    let manifest = await this.readManifest();
    const pending = manifest.records.filter((record) => record.recordState === 'deletion-pending');
    if (pending.length > 0) {
      const failed: StoredRecoveryRecord[] = [];
      for (const record of pending) {
        if (!await this.tryDeleteContentFile(record)) failed.push(record);
      }
      if (failed.length !== pending.length) {
        const ordinary = manifest.records.filter((record) => record.recordState !== 'deletion-pending');
        manifest = await this.writeNextManifest(manifest, [...ordinary, ...failed]);
      }
    }
    const candidates = await this.deletionPendingCandidates(manifest);
    this.deletionPendingCountValue = candidates.length;
    this.deletionPendingBytesValue = candidates.reduce((sum, item) => sum + item.byteLength, 0);
    if (
      this.deletionPendingCountValue > MAX_DELETION_PENDING_FILES
      || this.deletionPendingBytesValue > MAX_DELETION_PENDING_BYTES
    ) {
      this.stopRecoveryForSession(
        t('削除待ちの復元履歴データが保存上限を超えたため、安全のため新しい復元履歴の追加を停止しました。すべての復元履歴を削除する操作で再試行してください。'),
        undefined,
      );
    }
  }

  private async deletionPendingCandidates(manifest: RecoveryManifest): Promise<readonly {
    readonly record: StoredRecoveryRecord;
    readonly byteLength: number;
  }[]> {
    const result: { record: StoredRecoveryRecord; byteLength: number }[] = [];
    for (const record of manifest.records.filter((item) => item.recordState === 'deletion-pending')) {
      const stat = await this.statWithRetry(
        this.contentUri(record),
        t('削除待ちの復元履歴容量を一時的に確認できないため、安全のため新しい復元履歴の追加を停止しました。'),
      );
      if (stat.state === 'found') result.push({ record, byteLength: Math.max(0, stat.stat.size) });
    }
    return result;
  }

  private async quarantinePendingCandidates(manifest: RecoveryManifest): Promise<readonly {
    readonly kind: 'pending';
    readonly record: StoredRecoveryRecord;
    readonly byteLength: number;
    readonly modifiedAt: number;
    readonly name: string;
  }[]> {
    const result: {
      kind: 'pending';
      record: StoredRecoveryRecord;
      byteLength: number;
      modifiedAt: number;
      name: string;
    }[] = [];
    for (const record of manifest.records.filter((item) => item.recordState === 'quarantine-pending')) {
      const stat = await this.statWithRetry(
        this.contentUri(record),
        t('隔離待ちの復元履歴容量を一時的に確認できないため、安全のため新しい復元履歴の追加を停止しました。'),
      );
      result.push({
        kind: 'pending',
        record,
        byteLength: stat.state === 'found' ? Math.max(0, stat.stat.size) : 0,
        modifiedAt: Date.parse(record.createdAt) || 0,
        name: record.id,
      });
    }
    return result;
  }

  private async deleteUriQuietly(uri: vscode.Uri, recursive = false): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri, recursive ? { recursive: true, useTrash: false } : undefined);
    } catch {
      // 既に欠けている不要ファイルは、manifest整合性へ影響させません。
    }
  }

  private async deleteUriRequired(uri: vscode.Uri, failureMessage: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch (error) {
      if (isNotFoundError(error)) return;
      return this.stopRecoveryForSession(failureMessage, error);
    }
  }

  private prune(records: readonly StoredRecoveryRecord[]): PruneResult {
    const byFile = new Map<string, number>();
    const kept: StoredRecoveryRecord[] = [];
    const removed: StoredRecoveryRecord[] = [];
    let totalCommitted = 0;
    let totalBytes = 0;
    for (const record of records) {
      if (record.recordState === 'pending' || record.recordState === 'quarantine-pending' || record.recordState === 'deletion-pending') {
        kept.push(record);
        continue;
      }
      const fileKey = `${record.targetState}:${uriIdentityKey(vscode.Uri.parse(record.targetUri, true))}`;
      const perFile = byFile.get(fileKey) ?? 0;
      const allowed = perFile < MAX_PER_FILE
        && totalCommitted < MAX_TOTAL
        && totalBytes + record.byteLength <= MAX_TOTAL_BYTES;
      if (allowed) {
        kept.push(record);
        byFile.set(fileKey, perFile + 1);
        totalCommitted += 1;
        totalBytes += record.byteLength;
      } else {
        removed.push(record);
      }
    }
    return { kept, removed };
  }

  private async readManifest(): Promise<RecoveryManifest> {
    const loaded = await this.loadManifest();
    this.restoredFromBackupValue ||= loaded.restoredFromBackup;
    return loaded.manifest;
  }

  private async loadManifest(): Promise<ManifestLoadResult> {
    const main = await this.readManifestCandidate(this.manifestUri);
    if (main.state === 'error') throw main.error;
    const backup = await this.readManifestCandidate(this.backupManifestUri);
    const validMain = main.state === 'valid' ? main.parsed : undefined;
    const validBackup = backup.state === 'valid' ? backup.parsed : undefined;

    let selected: ParsedManifest | undefined;
    let restoredFromBackup = false;
    if (validMain && validBackup) {
      selected = validBackup.manifest.generation > validMain.manifest.generation ? validBackup : validMain;
      restoredFromBackup = selected === validBackup;
    } else if (validMain) {
      selected = validMain;
    } else if (validBackup && (main.state === 'missing' || main.state === 'corrupt')) {
      selected = validBackup;
      restoredFromBackup = true;
    }

    if (selected) {
      if (restoredFromBackup) await this.restoreMainManifest(selected.manifest);
      return {
        manifest: selected.manifest,
        invalidRecordCount: selected.invalidRecordCount,
        invalidSafeContentRecords: selected.invalidSafeContentRecords,
        sourceSchemaVersion: selected.sourceSchemaVersion,
        restoredFromBackup,
      };
    }

    if (main.state === 'missing' && backup.state === 'missing') {
      return {
        manifest: EMPTY_MANIFEST,
        invalidRecordCount: 0,
        invalidSafeContentRecords: [],
        sourceSchemaVersion: MANIFEST_SCHEMA_VERSION,
        restoredFromBackup: false,
      };
    }
    if (backup.state === 'error') throw backup.error;
    throw new Error(t('復元履歴の保存情報とバックアップの両方が破損しているため、安全のため復元履歴機能を停止しました。'));
  }

  private async readManifestCandidate(uri: vscode.Uri): Promise<ManifestCandidate> {
    for (let attempt = 0; attempt < MANIFEST_READ_RETRIES; attempt += 1) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        try {
          const parsedValue = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown;
          const parsed = parseManifest(parsedValue);
          return parsed ? { state: 'valid', parsed } : { state: 'corrupt' };
        } catch {
          return { state: 'corrupt' };
        }
      } catch (error) {
        if (isNotFoundError(error)) return { state: 'missing' };
        if (attempt + 1 >= MANIFEST_READ_RETRIES) return { state: 'error', error };
        await delay(LOCK_RETRY_MS);
      }
    }
    return { state: 'error', error: new Error(t('復元履歴の保存情報を読み取れませんでした。')) };
  }

  private async writeNextManifest(
    expected: RecoveryManifest,
    records: readonly StoredRecoveryRecord[],
  ): Promise<RecoveryManifest> {
    const latest = await this.loadManifest();
    if (latest.manifest.generation !== expected.generation) {
      throw new Error(t('別のVS Codeウィンドウで復元履歴が更新されたため、最新状態を読み直してもう一度実行してください。'));
    }
    const next: RecoveryManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generation: expected.generation + 1,
      records,
    };
    await this.replaceManifestTransaction(expected, next);
    return next;
  }

  private manifestBytes(manifest: RecoveryManifest): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  }

  private async replaceManifestTransaction(current: RecoveryManifest, next: RecoveryManifest): Promise<void> {
    const nextTemp = vscode.Uri.joinPath(
      this.rootUri,
      `${MANIFEST_FILE}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    await vscode.workspace.fs.writeFile(nextTemp, this.manifestBytes(next));
    try {
      await this.writeManifestFileAtomically(this.backupManifestUri, current);
      await vscode.workspace.fs.rename(nextTemp, this.manifestUri, { overwrite: true });
    } catch (error) {
      await this.deleteUriQuietly(nextTemp);
      try { await this.restoreMainManifest(current); } catch { /* 元状態の復旧失敗は元の例外を優先 */ }
      throw error;
    }
    // 主manifestが確定した後、バックアップも同じ世代へ更新します。
    // バックアップ更新だけが失敗しても主manifestの確定結果は取り消しません。
    try { await this.writeManifestFileAtomically(this.backupManifestUri, next); } catch { /* 次回更新時に再作成 */ }
  }

  private async restoreMainManifest(manifest: RecoveryManifest): Promise<void> {
    await this.writeManifestFileAtomically(this.manifestUri, manifest);
  }

  private async writeManifestFileAtomically(uri: vscode.Uri, manifest: RecoveryManifest): Promise<void> {
    await this.assertSharedLockLease();
    const tempUri = vscode.Uri.joinPath(
      this.rootUri,
      `${uri.path.split('/').pop() ?? MANIFEST_FILE}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    await vscode.workspace.fs.writeFile(tempUri, this.manifestBytes(manifest));
    try {
      await this.assertSharedLockLease();
      await vscode.workspace.fs.rename(tempUri, uri, { overwrite: true });
    } catch (error) {
      await this.deleteUriQuietly(tempUri);
      throw error;
    }
  }

  private async readDirectoryWithRetry(
    uri: vscode.Uri,
    failureMessage: string,
    missingAsEmpty = false,
  ): Promise<readonly [string, vscode.FileType][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < FILE_READ_RETRIES; attempt += 1) {
      try {
        return await vscode.workspace.fs.readDirectory(uri);
      } catch (error) {
        if (missingAsEmpty && isNotFoundError(error)) return [];
        lastError = error;
        if (attempt + 1 < FILE_READ_RETRIES) await delay(FILE_READ_RETRY_MS);
      }
    }
    return this.stopRecoveryForSession(failureMessage, lastError);
  }

  private async clearRootRecoveryArtifacts(): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(this.rootUri);
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      const isContent = name.endsWith('.bin') && SAFE_ID_PATTERN.test(name.slice(0, -4));
      const isTemporaryManifest = (name.startsWith(`${MANIFEST_FILE}.`) || name.startsWith(`${MANIFEST_BACKUP_FILE}.`))
        && name.endsWith('.tmp');
      const isTemporaryLock = name.startsWith(`${SHARED_LOCK_FILE}.`) && name.endsWith('.tmp');
      const isTemporaryJournal = name.startsWith(`${CREATION_JOURNAL_FILE}.`) && name.endsWith('.tmp');
      if (!isContent && !isTemporaryManifest && !isTemporaryLock && !isTemporaryJournal) continue;
      await this.deleteUriRequired(
        vscode.Uri.joinPath(this.rootUri, name),
        t('復元履歴の保存領域に削除できないデータが残ったため、すべて削除を完了できませんでした。'),
      );
    }
  }

  private async refreshUnreferencedStatus(records: readonly StoredRecoveryRecord[]): Promise<void> {
    const entries = await this.readDirectoryWithRetry(
      this.rootUri,
      t('復元履歴保存領域の未参照データを一時的に確認できないため、安全のため新しい復元履歴の追加を停止しました。'),
    );
    const referenced = new Set(records.map((record) => record.contentFile));
    let count = 0;
    let byteLength = 0;
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.bin')) continue;
      const id = name.slice(0, -4);
      if (!SAFE_ID_PATTERN.test(id) || referenced.has(name)) continue;
      const stat = await this.statWithRetry(
        vscode.Uri.joinPath(this.rootUri, name),
        t('未参照の復元履歴内容の容量を一時的に確認できないため、安全のため新しい復元履歴の追加を停止しました。'),
      );
      if (stat.state !== 'found') continue;
      count += 1;
      byteLength += Math.max(0, stat.stat.size);
    }
    this.unreferencedCountValue = count;
    this.unreferencedBytesValue = byteLength;
    if (count > MAX_QUARANTINE_FILES || byteLength > MAX_QUARANTINE_BYTES) {
      this.stopRecoveryForSession(
        t('未参照の復元履歴データが保存上限を超えたため、安全のため新しい復元履歴の追加を停止しました。保存領域の安全な初期化を実行してください。'),
        undefined,
      );
    }
  }

  private async cleanupUnreferencedFiles(
    records: readonly StoredRecoveryRecord[],
  ): Promise<{ readonly count: number; readonly byteLength: number }> {
    const entries = await this.readDirectoryWithRetry(
      this.rootUri,
      t('復元履歴保存領域の未参照データを一時的に確認できないため、安全のため復元履歴機能を停止しました。'),
    );
    const referenced = new Set(records.map((record) => record.contentFile));
    let unquarantinedCount = 0;
    let unquarantinedBytes = 0;
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      const isUnusedContent = SAFE_ID_PATTERN.test(name.slice(0, -4)) && name.endsWith('.bin') && !referenced.has(name);
      const isTemporaryManifest = (name.startsWith(`${MANIFEST_FILE}.`) || name.startsWith(`${MANIFEST_BACKUP_FILE}.`))
        && name.endsWith('.tmp');
      const isTemporaryLock = name.startsWith(`${SHARED_LOCK_FILE}.`) && name.endsWith('.tmp');
      const isTemporaryJournal = name.startsWith(`${CREATION_JOURNAL_FILE}.`) && name.endsWith('.tmp');
      const uri = vscode.Uri.joinPath(this.rootUri, name);
      if (isUnusedContent) {
        const read = await this.readFileWithRetry(
          uri,
          t('manifestから参照されていない復元履歴内容を一時的に確認できないため、安全のため復元履歴機能を停止しました。'),
        );
        if (read.state === 'missing') continue;
        await vscode.workspace.fs.createDirectory(this.quarantineUri);
        const quarantineTarget = vscode.Uri.joinPath(
          this.quarantineUri,
          `${Date.now()}-${name.slice(0, -4)}-${Math.random().toString(36).slice(2, 8)}.bin`,
        );
        let quarantined = false;
        try {
          await vscode.workspace.fs.writeFile(quarantineTarget, read.content);
          await this.deleteUriRequired(
            uri,
            t('未参照の復元履歴内容を使用停止領域へ移した後、元内容を削除できませんでした。'),
          );
          quarantined = true;
        } catch {
          await this.deleteUriQuietly(quarantineTarget);
        }
        if (!quarantined) {
          unquarantinedCount += 1;
          unquarantinedBytes += read.content.byteLength;
        }
        continue;
      }
      if (isTemporaryManifest || isTemporaryLock || isTemporaryJournal) await this.deleteUriQuietly(uri);
    }
    return { count: unquarantinedCount, byteLength: unquarantinedBytes };
  }

}
