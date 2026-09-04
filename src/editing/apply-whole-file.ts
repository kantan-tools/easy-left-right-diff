import * as vscode from 'vscode';
import type { ComparisonSnapshot, CopyDirection } from '../shared-types';
import type { ManagedEditorUris } from '../comparison/focus-probe';
import { t } from '../localization';

export function normalizeWholeFileEol(text: string, targetEol: '\n' | '\r\n'): string {
  return text.replace(/\r\n|\r|\n/g, targetEol);
}

/** ファイル全体を、コピー先だけが未保存になる標準WorkspaceEditとして適用します。 */
export async function applyWholeFile(
  snapshot: ComparisonSnapshot,
  direction: CopyDirection,
  managedUris?: ManagedEditorUris,
  expected?: {
    readonly leftText: string;
    readonly rightText: string;
    readonly leftVersion: number;
    readonly rightVersion: number;
  },
): Promise<{ applied: boolean; sourceVersion: number; targetDocument: vscode.TextDocument }> {
  const leftDocument = await vscode.workspace.openTextDocument(managedUris?.left ?? snapshot.left.uri);
  const rightDocument = await vscode.workspace.openTextDocument(managedUris?.right ?? snapshot.right.uri);
  if (expected && (
    leftDocument.version !== expected.leftVersion
    || rightDocument.version !== expected.rightVersion
    || leftDocument.getText() !== expected.leftText
    || rightDocument.getText() !== expected.rightText
  )) {
    throw new Error(t('ファイル全体コピーを適用する直前に内容が変更されたため、確認済みでない内容はコピーしませんでした。'));
  }
  const sourceDocument = direction === 'left-to-right' ? leftDocument : rightDocument;
  const targetDocument = direction === 'left-to-right' ? rightDocument : leftDocument;
  const targetEol = targetDocument.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const sourceText = normalizeWholeFileEol(sourceDocument.getText(), targetEol);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    targetDocument.uri,
    new vscode.Range(targetDocument.positionAt(0), targetDocument.positionAt(targetDocument.getText().length)),
    sourceText,
    {
      label: direction === 'left-to-right'
        ? t('L・左側ファイル全体をR・右側へコピー')
        : t('R・右側ファイル全体をL・左側へコピー'),
      needsConfirmation: false,
      description: t('ファイル全体コピー'),
    },
  );
  const applied = await vscode.workspace.applyEdit(edit);
  return { applied, sourceVersion: sourceDocument.version, targetDocument };
}
