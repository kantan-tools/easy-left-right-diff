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
exports.usageGuideFileName = usageGuideFileName;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const register_commands_1 = require("./commands/register-commands");
const comparison_controller_1 = require("./comparison/comparison-controller");
const editable_document_provider_1 = require("./comparison/editable-document-provider");
const focus_status_1 = require("./comparison/focus-status");
const readonly_document_provider_1 = require("./comparison/readonly-document-provider");
const file_decoration_provider_1 = require("./explorer/file-decoration-provider");
const decoration_registration_1 = require("./explorer/decoration-registration");
const git_detection_1 = require("./git/git-detection");
const output_1 = require("./logging/output");
const recovery_document_provider_1 = require("./recovery/recovery-document-provider");
const recovery_store_1 = require("./recovery/recovery-store");
const comparison_session_1 = require("./state/comparison-session");
const extension_state_1 = require("./state/extension-state");
const workspace_storage_1 = require("./state/workspace-storage");
const extension_api_1 = require("./testing/extension-api");
const extension_test_api_1 = require("./testing/extension-test-api");
const extension_test_mode_1 = require("./testing/extension-test-mode");
const left_right_tree_provider_1 = require("./views/left-right-tree-provider");
const localization_1 = require("./localization");
function packageString(context, key, fallback) {
    const value = context.extension.packageJSON[key];
    if (typeof value !== 'string')
        return fallback;
    const normalized = value.trim();
    if (!normalized || /^%[^%]+%$/.test(normalized))
        return fallback;
    return normalized;
}
function usageGuideFileName(language) {
    return language.toLowerCase().startsWith('ja') ? 'USAGE.md' : 'USAGE.en.md';
}
/** 実装2〜18の統合基盤です。 */
async function activate(context) {
    const output = (0, output_1.createExtensionOutput)();
    const storage = new workspace_storage_1.WorkspaceStorage(context.workspaceState, context.storageUri, vscode.workspace.fs);
    const state = storage.load();
    const health = Object.freeze({
        activated: true,
        version: packageString(context, 'version', '0.18.20'),
        productName: packageString(context, 'displayName', (0, localization_1.t)('かんたん左右ファイル比較')),
        stateSchemaVersion: state.schemaVersion,
    });
    const extensionHostTestMode = (0, extension_test_mode_1.isAutomatedExtensionHostTest)(context.extensionMode);
    const extensionHostTestUi = extensionHostTestMode ? new extension_test_api_1.ExtensionHostTestUi(vscode.window) : undefined;
    const comparisonUi = extensionHostTestUi ?? vscode.window;
    const session = new comparison_session_1.ComparisonSession();
    const editableProvider = new editable_document_provider_1.EditableComparisonProvider();
    const editableRegistration = vscode.workspace.registerFileSystemProvider(editable_document_provider_1.EDITABLE_SCHEME, editableProvider, {
        isCaseSensitive: false,
        isReadonly: false,
    });
    const readonlyProvider = new readonly_document_provider_1.ReadonlyComparisonProvider();
    const readonlyRegistration = vscode.workspace.registerTextDocumentContentProvider(readonly_document_provider_1.READONLY_SCHEME, readonlyProvider);
    const recoveryStore = new recovery_store_1.RecoveryStore(context.globalStorageUri);
    const recoveryProvider = new recovery_document_provider_1.RecoveryDocumentProvider(recoveryStore);
    const recoveryRegistration = vscode.workspace.registerTextDocumentContentProvider(recovery_document_provider_1.RECOVERY_SCHEME, recoveryProvider);
    const decorationProvider = new file_decoration_provider_1.LeftRightFileDecorationProvider(session);
    const decorationRegistration = new decoration_registration_1.LatestFileDecorationRegistration(decorationProvider);
    const comparison = new comparison_controller_1.ComparisonController(session, output, readonlyProvider, comparisonUi, {
        editableProvider,
        highlightFile: (uri) => decorationProvider.highlight(uri),
        refreshExplorerDecorations: () => decorationRegistration.registerLatest(),
        storage,
        gitDetector: new git_detection_1.GitDetector(),
        recoveryStore,
        recoveryProvider,
        usageGuideUri: vscode.Uri.joinPath(context.extensionUri, usageGuideFileName(vscode.env.language)),
    });
    const testing = extensionHostTestUi
        ? (0, extension_test_api_1.createExtensionHostTestApi)(comparison, recoveryStore, extensionHostTestUi)
        : undefined;
    const api = (0, extension_api_1.createExtensionApi)(health, testing);
    const treeProvider = new left_right_tree_provider_1.LeftRightTreeProvider(comparison);
    const focusStatus = new focus_status_1.FocusStatusIndicator();
    const refreshFocusStatus = () => {
        const state = comparison.getState();
        focusStatus.refresh(vscode.window.activeTextEditor, comparison.getSessionSnapshot(), state.left, comparison.getManagedEditorUris(), state.activeSide ?? 'unknown');
    };
    const openedDuringInitialization = new Set();
    let comparisonInitialized = false;
    const documentOpenListener = vscode.workspace.onDidOpenTextDocument?.((document) => {
        if (!comparisonInitialized)
            openedDuringInitialization.add(document);
        else
            void comparison.handleTextDocumentOpened(document);
    }) ?? { dispose() { } };
    await comparison.initialize();
    comparisonInitialized = true;
    for (const document of new Set([...(vscode.workspace.textDocuments ?? []), ...openedDuringInitialization])) {
        await comparison.handleTextDocumentOpened(document);
    }
    const commandRegistration = (0, register_commands_1.registerCommands)({ getHealth: api.getHealth, comparison });
    await (0, decoration_registration_1.activateBuiltInGitBeforeDecorations)(output);
    decorationRegistration.registerLatest();
    const treeView = vscode.window.createTreeView(left_right_tree_provider_1.LEFT_RIGHT_VIEW_ID, {
        treeDataProvider: treeProvider,
        showCollapseAll: false,
    });
    let lastDecorationSelectionKey = (0, decoration_registration_1.decorationSelectionKey)(comparison.getState().left?.uri, comparison.getState().right?.uri);
    const refreshDecorationsAndStatus = comparison.onDidChangeState((state) => {
        const nextDecorationSelectionKey = (0, decoration_registration_1.decorationSelectionKey)(state.left?.uri, state.right?.uri);
        if (nextDecorationSelectionKey !== lastDecorationSelectionKey) {
            lastDecorationSelectionKey = nextDecorationSelectionKey;
            // GitのリポジトリProviderが起動後に追加された場合でも、L/R選択時に本ツールを最後に再登録します。
            decorationRegistration.registerLatest();
        }
        else {
            decorationProvider.refresh();
        }
        refreshFocusStatus();
    });
    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        void comparison.handleActiveEditor(editor, 'active-editor');
    });
    const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
        // 標準差分画面ではactiveTextEditorが片側へ固定される場合があるため、
        // イベントが知らせた実際のTextEditor URIでL/Rを判定します。
        void comparison.handleActiveEditor(event.textEditor, 'selection');
    });
    const visibleRangesListener = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        // 左右どちらをスクロールしたかも、正式APIが返すTextEditor URIから判定します。
        void comparison.handleActiveEditor(event.textEditor, 'visible-ranges');
    });
    const focusPollTimer = setInterval(() => {
        void comparison.handleActiveEditor(vscode.window.activeTextEditor, 'focus-poll');
    }, 300);
    focusPollTimer.unref?.();
    const focusPollDisposable = { dispose: () => clearInterval(focusPollTimer) };
    const tabListener = vscode.window.tabGroups.onDidChangeTabs(() => {
        void comparison.handleTabsChanged();
    });
    const createListener = vscode.workspace.onDidCreateFiles((event) => {
        void comparison.handleCreatedFiles(event);
    });
    const renameListener = vscode.workspace.onDidRenameFiles((event) => {
        void comparison.handleRenamedFiles(event);
    });
    const deleteListener = vscode.workspace.onDidDeleteFiles((event) => {
        void comparison.handleDeletedFiles(event);
    });
    const documentChangeListener = vscode.workspace.onDidChangeTextDocument((event) => {
        void comparison.handleTextDocumentChanged(event);
    });
    const documentSaveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        void comparison.handleTextDocumentSaved(document);
    });
    const documentCloseListener = vscode.workspace.onDidCloseTextDocument((document) => {
        comparison.handleTextDocumentClosed(document);
    });
    const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('easyLeftRightDiff.showParentFolderDecorations')) {
            decorationProvider.refresh();
        }
    });
    refreshFocusStatus();
    context.subscriptions.push(output, comparison, commandRegistration, editableRegistration, editableProvider, readonlyRegistration, readonlyProvider, recoveryRegistration, recoveryProvider, decorationRegistration, decorationProvider, treeProvider, treeView, focusStatus, refreshDecorationsAndStatus, activeEditorListener, selectionListener, visibleRangesListener, focusPollDisposable, tabListener, createListener, renameListener, deleteListener, documentOpenListener, documentChangeListener, documentSaveListener, documentCloseListener, configurationListener);
    output.info((0, localization_1.t)('実装2〜18の統合基盤を起動しました。version={0} stateSchema={1}', health.version, extension_state_1.CURRENT_STATE_SCHEMA_VERSION));
    return api;
}
function deactivate() {
    // 登録したリソースはExtensionContext.subscriptionsが破棄します。
}
