import * as vscode from 'vscode';
import { isSameUri } from '../files/file-identity';
import type { ComparisonSide, ComparisonSnapshot } from '../shared-types';

export interface ManagedEditorUris {
  readonly left: vscode.Uri;
  readonly right: vscode.Uri;
}

/** 正式APIが返すTextEditorのdocument URIだけで左右を判定します。 */
export function detectEditorSide(
  editor: vscode.TextEditor | undefined,
  snapshot: ComparisonSnapshot,
  managedUris?: ManagedEditorUris,
): ComparisonSide | undefined {
  if (!editor) return undefined;
  const leftUri = managedUris?.left ?? snapshot.left.uri;
  const rightUri = managedUris?.right ?? snapshot.right.uri;
  if (isSameUri(editor.document.uri, leftUri)) return 'left';
  if (isSameUri(editor.document.uri, rightUri)) return 'right';
  return undefined;
}

/** 手動検証時に、正式APIが左右どちらのEditorを通知したか記録します。 */
export class FocusProbe {
  public constructor(private readonly output: vscode.OutputChannel) {}

  public record(
    editor: vscode.TextEditor | undefined,
    snapshot: ComparisonSnapshot | undefined,
    reason: string,
    managedUris?: ManagedEditorUris,
  ): void {
    const uri = editor?.document.uri.toString(true) ?? '(undefined)';
    const side = snapshot ? detectEditorSide(editor, snapshot, managedUris) ?? 'unknown' : 'no-session';
    this.output.appendLine(`[focus:${reason}] side=${side} uri=${uri}`);
  }
}
