import * as vscode from 'vscode';
import type { DiffHunk } from '../comparison/diff-model';
import type { ComparisonSnapshot } from '../shared-types';
import type { ManagedEditorUris } from '../comparison/focus-probe';
import { buildHunkPatch } from './hunk-patch';
import { t } from '../localization';

/** WorkspaceEditを使い、コピー先だけを標準の未保存テキスト編集として変更します。 */
export async function applyHunk(
  snapshot: ComparisonSnapshot,
  hunk: DiffHunk,
  direction: 'left-to-right' | 'right-to-left',
  managedUris?: ManagedEditorUris,
  expected?: {
    readonly leftText: string;
    readonly rightText: string;
    readonly leftVersion: number;
    readonly rightVersion: number;
  },
): Promise<boolean> {
  const leftDocument = await vscode.workspace.openTextDocument(managedUris?.left ?? snapshot.left.uri);
  const rightDocument = await vscode.workspace.openTextDocument(managedUris?.right ?? snapshot.right.uri);
  if (expected && (
    leftDocument.version !== expected.leftVersion
    || rightDocument.version !== expected.rightVersion
    || leftDocument.getText() !== expected.leftText
    || rightDocument.getText() !== expected.rightText
  )) {
    throw new Error(t('コピー内容を適用する直前にファイルが変更されたため、古い差分位置を使用せず中止しました。'));
  }
  const targetDocument = direction === 'left-to-right' ? rightDocument : leftDocument;
  const targetEol = targetDocument.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const patch = buildHunkPatch(
    hunk,
    direction,
    leftDocument.getText(),
    rightDocument.getText(),
    targetEol,
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    targetDocument.uri,
    new vscode.Range(
      targetDocument.positionAt(patch.targetStartOffset),
      targetDocument.positionAt(patch.targetEndOffset),
    ),
    patch.replacementText,
    {
      label: direction === 'left-to-right'
        ? t('L・左側の現在の変更をR・右側へコピー')
        : t('R・右側の現在の変更をL・左側へコピー'),
      needsConfirmation: false,
      description: t('変更ブロック{0}', hunk.index),
    },
  );
  return vscode.workspace.applyEdit(edit);
}
