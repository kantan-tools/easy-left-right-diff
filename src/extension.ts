import * as vscode from 'vscode';
import { registerCommands } from './commands/register-commands';
import { ComparisonController } from './comparison/comparison-controller';
import { EDITABLE_SCHEME, EditableComparisonProvider } from './comparison/editable-document-provider';
import { FocusStatusIndicator } from './comparison/focus-status';
import { READONLY_SCHEME, ReadonlyComparisonProvider } from './comparison/readonly-document-provider';
import { LeftRightFileDecorationProvider } from './explorer/file-decoration-provider';
import {
  activateBuiltInGitBeforeDecorations,
  decorationSelectionKey,
  LatestFileDecorationRegistration,
} from './explorer/decoration-registration';
import { GitDetector } from './git/git-detection';
import { createExtensionOutput } from './logging/output';
import { RECOVERY_SCHEME, RecoveryDocumentProvider } from './recovery/recovery-document-provider';
import { RecoveryStore } from './recovery/recovery-store';
import { ComparisonSession } from './state/comparison-session';
import { CURRENT_STATE_SCHEMA_VERSION } from './state/extension-state';
import { WorkspaceStorage } from './state/workspace-storage';
import {
  createExtensionApi,
  type ExtensionApi,
  type ExtensionHealth,
} from './testing/extension-api';
import { createExtensionHostTestApi, ExtensionHostTestUi } from './testing/extension-test-api';
import { isAutomatedExtensionHostTest } from './testing/extension-test-mode';
import { LeftRightTreeProvider, LEFT_RIGHT_VIEW_ID } from './views/left-right-tree-provider';
import { t } from './localization';

function packageString(context: vscode.ExtensionContext, key: string, fallback: string): string {
  const value = (context.extension.packageJSON as Record<string, unknown>)[key];
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  if (!normalized || /^%[^%]+%$/.test(normalized)) return fallback;
  return normalized;
}

export function usageGuideFileName(language: string): 'USAGE.md' | 'USAGE.en.md' {
  return language.toLowerCase().startsWith('ja') ? 'USAGE.md' : 'USAGE.en.md';
}

/** 実装2〜18の統合基盤です。 */
export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const output = createExtensionOutput();
  const storage = new WorkspaceStorage(context.workspaceState, context.storageUri, vscode.workspace.fs);
  const state = storage.load();
  const health: ExtensionHealth = Object.freeze({
    activated: true,
    version: packageString(context, 'version', '0.18.20'),
    productName: packageString(context, 'displayName', t('かんたん左右ファイル比較')),
    stateSchemaVersion: state.schemaVersion,
  });
  const extensionHostTestMode = isAutomatedExtensionHostTest(context.extensionMode);
  const extensionHostTestUi = extensionHostTestMode ? new ExtensionHostTestUi(vscode.window) : undefined;
  const comparisonUi = extensionHostTestUi ?? vscode.window;
  const session = new ComparisonSession();
  const editableProvider = new EditableComparisonProvider();
  const editableRegistration = vscode.workspace.registerFileSystemProvider(EDITABLE_SCHEME, editableProvider, {
    isCaseSensitive: false,
    isReadonly: false,
  });
  const readonlyProvider = new ReadonlyComparisonProvider();
  const readonlyRegistration = vscode.workspace.registerTextDocumentContentProvider(READONLY_SCHEME, readonlyProvider);
  const recoveryStore = new RecoveryStore(context.globalStorageUri);
  const recoveryProvider = new RecoveryDocumentProvider(recoveryStore);
  const recoveryRegistration = vscode.workspace.registerTextDocumentContentProvider(RECOVERY_SCHEME, recoveryProvider);
  const decorationProvider = new LeftRightFileDecorationProvider(session);
  const decorationRegistration = new LatestFileDecorationRegistration(decorationProvider);
  const comparison = new ComparisonController(session, output, readonlyProvider, comparisonUi, {
    editableProvider,
    highlightFile: (uri) => decorationProvider.highlight(uri),
    refreshExplorerDecorations: () => decorationRegistration.registerLatest(),
    storage,
    gitDetector: new GitDetector(),
    recoveryStore,
    recoveryProvider,
    usageGuideUri: vscode.Uri.joinPath(context.extensionUri, usageGuideFileName(vscode.env.language)),
  });
  const testing = extensionHostTestUi
    ? createExtensionHostTestApi(comparison, recoveryStore, extensionHostTestUi)
    : undefined;
  const api = createExtensionApi(health, testing);
  const treeProvider = new LeftRightTreeProvider(comparison);
  const focusStatus = new FocusStatusIndicator();

  const refreshFocusStatus = (): void => {
    const state = comparison.getState();
    focusStatus.refresh(
      vscode.window.activeTextEditor,
      comparison.getSessionSnapshot(),
      state.left,
      comparison.getManagedEditorUris(),
      state.activeSide ?? 'unknown',
    );
  };

  const openedDuringInitialization = new Set<vscode.TextDocument>();
  let comparisonInitialized = false;
  const documentOpenListener = vscode.workspace.onDidOpenTextDocument?.((document) => {
    if (!comparisonInitialized) openedDuringInitialization.add(document);
    else void comparison.handleTextDocumentOpened(document);
  }) ?? { dispose() {} };

  await comparison.initialize();
  comparisonInitialized = true;
  for (const document of new Set([...(vscode.workspace.textDocuments ?? []), ...openedDuringInitialization])) {
    await comparison.handleTextDocumentOpened(document);
  }
  const commandRegistration = registerCommands({ getHealth: api.getHealth, comparison });
  await activateBuiltInGitBeforeDecorations(output);
  decorationRegistration.registerLatest();
  const treeView = vscode.window.createTreeView(LEFT_RIGHT_VIEW_ID, {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });
  let lastDecorationSelectionKey = decorationSelectionKey(
    comparison.getState().left?.uri,
    comparison.getState().right?.uri,
  );
  const refreshDecorationsAndStatus = comparison.onDidChangeState((state) => {
    const nextDecorationSelectionKey = decorationSelectionKey(state.left?.uri, state.right?.uri);
    if (nextDecorationSelectionKey !== lastDecorationSelectionKey) {
      lastDecorationSelectionKey = nextDecorationSelectionKey;
      // GitのリポジトリProviderが起動後に追加された場合でも、L/R選択時に本ツールを最後に再登録します。
      decorationRegistration.registerLatest();
    } else {
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
  (focusPollTimer as { unref?: () => void }).unref?.();
  const focusPollDisposable = { dispose: (): void => clearInterval(focusPollTimer) };
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
  context.subscriptions.push(
    output,
    comparison,
    commandRegistration,
    editableRegistration,
    editableProvider,
    readonlyRegistration,
    readonlyProvider,
    recoveryRegistration,
    recoveryProvider,
    decorationRegistration,
    decorationProvider,
    treeProvider,
    treeView,
    focusStatus,
    refreshDecorationsAndStatus,
    activeEditorListener,
    selectionListener,
    visibleRangesListener,
    focusPollDisposable,
    tabListener,
    createListener,
    renameListener,
    deleteListener,
    documentOpenListener,
    documentChangeListener,
    documentSaveListener,
    documentCloseListener,
    configurationListener,
  );
  output.info(
    t('実装2〜18の統合基盤を起動しました。version={0} stateSchema={1}', health.version, CURRENT_STATE_SCHEMA_VERSION),
  );
  return api;
}

export function deactivate(): void {
  // 登録したリソースはExtensionContext.subscriptionsが破棄します。
}
