import * as vscode from 'vscode';
import { t } from '../localization';
import type { RecoveryStore } from './recovery-store';

export const RECOVERY_SCHEME = 'easy-left-right-diff-recovery';

type RecoveryView = 'history' | 'current';

export interface RecoveryComparisonUris {
  readonly comparisonId: string;
  readonly historyUri: vscode.Uri;
  readonly currentUri: vscode.Uri;
}

/** 復元履歴と、比較開始時点の現在内容を読み取り専用で差分画面へ渡します。 */
export class RecoveryDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly currentContents = new Map<string, string>();
  private readonly comparisonSnapshots = new Map<string, string>();
  public readonly onDidChange = this.emitter.event;

  public constructor(private readonly store: RecoveryStore) {}

  public createHistoryUri(snapshotId: string, displayName: string, comparisonId = snapshotId): vscode.Uri {
    return this.buildUri(snapshotId, comparisonId, displayName, 'history');
  }

  /** 旧呼び出しとの互換用。履歴側の読み取り専用URIを返します。 */
  public createUri(snapshotId: string, displayName: string): vscode.Uri {
    return this.createHistoryUri(snapshotId, displayName);
  }

  public createCurrentUri(
    snapshotId: string,
    displayName: string,
    currentText: string,
    comparisonId = snapshotId,
  ): vscode.Uri {
    this.currentContents.set(comparisonId, currentText);
    this.comparisonSnapshots.set(comparisonId, snapshotId);
    return this.buildUri(snapshotId, comparisonId, displayName, 'current');
  }

  /** 同じ履歴を複数回開いても、比較ごとの「開いた時点の内容」を混在させません。 */
  public createComparisonUris(snapshotId: string, displayName: string, currentText: string): RecoveryComparisonUris {
    const comparisonId = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    this.currentContents.set(comparisonId, currentText);
    this.comparisonSnapshots.set(comparisonId, snapshotId);
    return {
      comparisonId,
      historyUri: this.buildUri(snapshotId, comparisonId, displayName, 'history'),
      currentUri: this.buildUri(snapshotId, comparisonId, displayName, 'current'),
    };
  }

  public currentText(comparisonId: string): string | undefined {
    return this.currentContents.get(comparisonId);
  }

  public currentTextFromUri(uri: vscode.Uri): string | undefined {
    const comparisonId = new URLSearchParams(uri.query).get('comparison');
    return comparisonId ? this.currentContents.get(comparisonId) : undefined;
  }

  public release(snapshotId: string): void {
    // 互換名を維持しますが、実装57以降は比較インスタンスIDを受け取ります。
    this.currentContents.delete(snapshotId);
    this.comparisonSnapshots.delete(snapshotId);
  }

  public releaseSnapshot(snapshotId: string): void {
    for (const [comparisonId, value] of this.comparisonSnapshots) {
      if (value === snapshotId) this.release(comparisonId);
    }
  }

  public releaseExcept(activeComparisonIds: ReadonlySet<string>): void {
    for (const comparisonId of this.comparisonSnapshots.keys()) {
      if (!activeComparisonIds.has(comparisonId)) this.release(comparisonId);
    }
  }

  public releaseAll(): void {
    this.currentContents.clear();
    this.comparisonSnapshots.clear();
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parameters = new URLSearchParams(uri.query);
    const snapshotId = parameters.get('snapshot');
    if (!snapshotId) throw new Error(t('復元履歴の識別子がありません。'));
    const view = (parameters.get('view') ?? 'history') as RecoveryView;
    if (view === 'current') {
      const comparisonId = parameters.get('comparison');
      if (!comparisonId) throw new Error(t('復元履歴の比較識別子がありません。'));
      const currentText = this.currentContents.get(comparisonId);
      if (currentText === undefined) throw new Error(t('比較開始時点の現在内容が見つかりません。復元履歴を開き直してください。'));
      return currentText;
    }
    const bytes = await this.store.read(snapshotId);
    return new TextDecoder('utf-8').decode(bytes);
  }

  public dispose(): void {
    this.currentContents.clear();
    this.comparisonSnapshots.clear();
    this.emitter.dispose();
  }

  private buildUri(snapshotId: string, comparisonId: string, displayName: string, view: RecoveryView): vscode.Uri {
    return vscode.Uri.from({
      scheme: RECOVERY_SCHEME,
      path: `/${encodeURIComponent(displayName)}`,
      query: `snapshot=${encodeURIComponent(snapshotId)}&comparison=${encodeURIComponent(comparisonId)}&view=${view}`,
    });
  }
}
