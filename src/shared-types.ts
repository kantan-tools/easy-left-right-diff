import type * as vscode from 'vscode';

/** L・左側またはR・右側を表す正式な内部値です。 */
export type ComparisonSide = 'left' | 'right';

/** 通常比較と、仮想文書を使う読み取り専用比較です。 */
export type ComparisonMode = 'normal' | 'readonly';

/** 変更箇所コピーの向きです。 */
export type CopyDirection = 'left-to-right' | 'right-to-left';

/** Git管理状態です。unknownは安全側でGit管理外と同等に確認します。 */
export type GitManagementStatus = 'managed' | 'unmanaged' | 'unknown';

/** ワークスペース情報を含む、比較対象ファイルの識別情報です。 */
export interface FileIdentity {
  readonly uri: vscode.Uri;
  readonly workspaceName: string | undefined;
  readonly workspaceRootUri: vscode.Uri | undefined;
  readonly relativePath: string;
  readonly displayName: string;
  readonly outsideWorkspace: boolean;
}

/** 1つの比較セッションが保持する比較状態です。 */
export interface ComparisonSnapshot {
  readonly left: FileIdentity;
  readonly right: FileIdentity;
  readonly leftLabel: string | undefined;
  readonly rightLabel: string | undefined;
  readonly sameDisplayName: boolean;
  readonly mode: ComparisonMode;
  readonly title: string;
}

/** 最後に本ツールが行った編集の安全なUndo確認情報です。 */
export interface LastCopyState {
  readonly targetSide: ComparisonSide;
  readonly targetUri: vscode.Uri;
  readonly targetVersionAfterEdit: number;
  readonly sourceVersionAtEdit: number;
  readonly kind: 'hunk' | 'whole-file';
  readonly hunkIndex: number | undefined;
}

/** ファイル安全評価です。 */
export interface FileSafetyAssessment {
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly encoding: 'utf8' | 'utf8-bom' | 'non-utf8' | 'binary';
  readonly level: 'normal' | 'warning' | 'readonly' | 'unsupported';
  readonly reasons: readonly string[];
  readonly readonlyPermission: boolean;
}

/** 本ツールが安全操作前に自動保存した復元履歴です。 */
export interface RecoverySnapshot {
  readonly id: string;
  readonly targetUri: vscode.Uri;
  readonly targetState: 'available' | 'verification-pending' | 'missing';
  readonly createdAt: string;
  readonly reason: 'before-copy' | 'before-hunk-copy' | 'before-whole-copy' | 'before-save' | 'before-restore';
  readonly byteLength: number;
}

/** 最近の比較へ保存する永続化可能な情報です。 */
export interface RecentComparison {
  readonly leftUri: string;
  readonly rightUri: string;
  readonly leftLabel: string | undefined;
  readonly rightLabel: string | undefined;
  readonly mode: ComparisonMode;
  readonly usedAt: string;
}

/** 左右確認ビューと内部確認コマンドへ返す現在状態です。 */
export interface ComparisonCommandState {
  readonly left: FileIdentity | undefined;
  readonly right: FileIdentity | undefined;
  readonly leftLabel: string | undefined;
  readonly rightLabel: string | undefined;
  readonly sameDisplayName: boolean;
  readonly mode: ComparisonMode;
  readonly diffOpened: boolean;
  readonly activeSide: ComparisonSide | undefined;
  readonly lastCopy: LastCopyState | undefined;
  readonly leftDirty: boolean;
  readonly rightDirty: boolean;
  readonly staleReason: string | undefined;
  readonly recentComparisonCount: number;
  readonly recoveryCount: number;
  /** 現在のL/R内容から計算した差分ブロック件数です。比較開始前はundefinedです。 */
  readonly differenceCount: number | undefined;
}
