import * as vscode from 'vscode';
import { t } from '../localization';
import type { ComparisonSide, ComparisonSnapshot } from '../shared-types';

export const READONLY_SCHEME = 'easy-left-right-diff-readonly';

interface ReadonlyEntry {
  readonly sourceUri: vscode.Uri;
  readonly text: string;
}

function encodeSource(uri: vscode.Uri): string {
  return encodeURIComponent(uri.toString(true));
}

function sideFileName(snapshot: ComparisonSnapshot, side: ComparisonSide): string {
  const identity = side === 'left' ? snapshot.left : snapshot.right;
  return identity.displayName || `${side}.txt`;
}

/** 実ファイルを変更できない標準差分表示用の仮想文書を提供します。 */
export class ReadonlyComparisonProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly entries = new Map<string, ReadonlyEntry>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.emitter.event;

  public createUri(snapshot: ComparisonSnapshot, side: ComparisonSide): vscode.Uri {
    const identity = side === 'left' ? snapshot.left : snapshot.right;
    const fileName = sideFileName(snapshot, side);
    return vscode.Uri.from({
      scheme: READONLY_SCHEME,
      path: `/${side}/${fileName}`,
      query: `source=${encodeSource(identity.uri)}&side=${side}`,
    });
  }

  public setContent(uri: vscode.Uri, sourceUri: vscode.Uri, text: string): void {
    this.entries.set(uri.toString(true), { sourceUri, text });
    this.emitter.fire(uri);
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const entry = this.entries.get(uri.toString(true));
    if (!entry) {
      throw new Error(t('読み取り専用比較の内容を取得できませんでした。比較を開き直してください。'));
    }
    return entry.text;
  }

  public clear(): void {
    this.entries.clear();
  }

  public dispose(): void {
    this.entries.clear();
    this.emitter.dispose();
  }
}
