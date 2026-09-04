import * as vscode from 'vscode';
import { t } from '../localization';

/**
 * `vscode.commands.executeCommand` は正式な Extension API です。
 * `revealInExplorer` は VS Code 本体が提供する組み込みコマンドのため、
 * 実行前に現在の環境へ登録されていることを必ず確認します。
 */
export const REVEAL_IN_EXPLORER_COMMAND = 'revealInExplorer';

export type RevealWorkspaceScope = 'inside-workspace' | 'outside-workspace';

export interface RevealFileResult {
  status: 'command-executed' | 'outside-workspace-opened' | 'fallback-opened';
  commandAvailable: boolean;
  workspaceScope: RevealWorkspaceScope;
  uri: vscode.Uri;
  failure?: string;
}

function getWorkspaceScope(uri: vscode.Uri): RevealWorkspaceScope {
  return vscode.workspace.getWorkspaceFolder(uri)
    ? 'inside-workspace'
    : 'outside-workspace';
}

async function openOutsideWorkspace(uri: vscode.Uri, commandAvailable: boolean): Promise<RevealFileResult> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  void vscode.window.showInformationMessage(
    t('ワークスペース外のファイルのため、標準エクスプローラー内の選択ではなく対象ファイルを開きました。'),
  );
  return {
    status: 'outside-workspace-opened',
    commandAvailable,
    workspaceScope: 'outside-workspace',
    uri,
  };
}

async function openFallback(uri: vscode.Uri, failure: string): Promise<RevealFileResult> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  void vscode.window.showWarningMessage(
    t('標準エクスプローラーでの場所表示を実行できなかったため、対象ファイルを通常のエディターで開きました。'),
  );
  return {
    status: 'fallback-opened',
    commandAvailable: failure !== 'command-unavailable',
    workspaceScope: getWorkspaceScope(uri),
    uri,
    failure,
  };
}

/**
 * VS Code組み込みコマンドを、正式なcommands API経由で実行します。
 * コマンド未登録または実行失敗時だけ、安全な「対象ファイルを開く」動作へ戻します。
 *
 * 戻り値の `command-executed` は「コマンド呼び出しが正常終了した」ことを示します。
 * Explorer上の自動展開・スクロール・選択の見え方は公開APIから取得できないため、
 * VS Code／Cursorの画面で別途確認します。
 */
export async function revealFileWithPublicApi(uri: vscode.Uri): Promise<RevealFileResult> {
  const commands = await vscode.commands.getCommands(true);
  const commandAvailable = commands.includes(REVEAL_IN_EXPLORER_COMMAND);
  const workspaceScope = getWorkspaceScope(uri);

  // 標準エクスプローラーのツリーには、ワークスペース外ファイルの所属先がありません。
  // そのため、コマンドが無反応に見える状態を避け、正式APIで対象ファイルを直接開きます。
  if (workspaceScope === 'outside-workspace') {
    return openOutsideWorkspace(uri, commandAvailable);
  }
  if (!commandAvailable) {
    return openFallback(uri, 'command-unavailable');
  }

  try {
    await vscode.commands.executeCommand(REVEAL_IN_EXPLORER_COMMAND, uri);
    return {
      status: 'command-executed',
      commandAvailable: true,
      workspaceScope: getWorkspaceScope(uri),
      uri,
    };
  } catch (error) {
    return openFallback(
      uri,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}
