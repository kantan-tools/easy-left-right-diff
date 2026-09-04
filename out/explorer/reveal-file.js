"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.REVEAL_IN_EXPLORER_COMMAND = void 0;
exports.revealFileWithPublicApi = revealFileWithPublicApi;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
/**
 * `vscode.commands.executeCommand` は正式な Extension API です。
 * `revealInExplorer` は VS Code 本体が提供する組み込みコマンドのため、
 * 実行前に現在の環境へ登録されていることを必ず確認します。
 */
exports.REVEAL_IN_EXPLORER_COMMAND = 'revealInExplorer';
function getWorkspaceScope(uri) {
    return vscode.workspace.getWorkspaceFolder(uri)
        ? 'inside-workspace'
        : 'outside-workspace';
}
async function openOutsideWorkspace(uri, commandAvailable) {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    void vscode.window.showInformationMessage((0, localization_1.t)('ワークスペース外のファイルのため、標準エクスプローラー内の選択ではなく対象ファイルを開きました。'));
    return {
        status: 'outside-workspace-opened',
        commandAvailable,
        workspaceScope: 'outside-workspace',
        uri,
    };
}
async function openFallback(uri, failure) {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    void vscode.window.showWarningMessage((0, localization_1.t)('標準エクスプローラーでの場所表示を実行できなかったため、対象ファイルを通常のエディターで開きました。'));
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
async function revealFileWithPublicApi(uri) {
    const commands = await vscode.commands.getCommands(true);
    const commandAvailable = commands.includes(exports.REVEAL_IN_EXPLORER_COMMAND);
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
        await vscode.commands.executeCommand(exports.REVEAL_IN_EXPLORER_COMMAND, uri);
        return {
            status: 'command-executed',
            commandAvailable: true,
            workspaceScope: getWorkspaceScope(uri),
            uri,
        };
    }
    catch (error) {
        return openFallback(uri, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
}
