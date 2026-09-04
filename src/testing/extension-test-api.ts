import * as vscode from 'vscode';
import type {
  ComparisonCommandState,
  ComparisonSide,
  ComparisonSnapshot,
  CopyDirection,
} from '../shared-types';
import type { ManagedEditorUris } from '../comparison/focus-probe';
import type { ComparisonController, ComparisonUi } from '../comparison/comparison-controller';
import type { RecoveryStore } from '../recovery/recovery-store';

export interface ExtensionHostDialogPlan {
  readonly informationResponseIndexes?: readonly number[];
  readonly warningResponseIndexes?: readonly number[];
  readonly quickPickResponseIndexes?: readonly number[];
}

export interface ExtensionHostDialogRecord {
  readonly kind: 'information' | 'warning' | 'error' | 'quick-pick';
  readonly message: string;
  readonly items: readonly string[];
}

/**
 * Extension Host自動テスト専用UIです。
 * Productionでは生成せず、通常利用者のダイアログや設定へ影響させません。
 */
export class ExtensionHostTestUi implements ComparisonUi {
  private informationResponseIndexes: number[] = [];
  private warningResponseIndexes: number[] = [];
  private quickPickResponseIndexes: number[] = [];
  private readonly recordsValue: ExtensionHostDialogRecord[] = [];

  public constructor(private readonly delegate: ComparisonUi) {}

  public setPlan(plan: ExtensionHostDialogPlan = {}): void {
    this.informationResponseIndexes = [...(plan.informationResponseIndexes ?? [])];
    this.warningResponseIndexes = [...(plan.warningResponseIndexes ?? [])];
    this.quickPickResponseIndexes = [...(plan.quickPickResponseIndexes ?? [])];
  }

  public clearRecords(): void {
    this.recordsValue.length = 0;
  }

  public records(): readonly ExtensionHostDialogRecord[] {
    return Object.freeze(this.recordsValue.map((item) => Object.freeze({ ...item, items: Object.freeze([...item.items]) })));
  }

  private select(items: readonly string[], queue: number[]): string | undefined {
    const index = queue.shift();
    if (index === undefined) return undefined;
    return index >= 0 && index < items.length ? items[index] : undefined;
  }

  public async showInformationMessage(
    message: string,
    _options?: vscode.MessageOptions,
    ...items: string[]
  ): Promise<string | undefined> {
    this.recordsValue.push({ kind: 'information', message, items: [...items] });
    return this.select(items, this.informationResponseIndexes);
  }

  public async showWarningMessage(
    message: string,
    _options?: vscode.MessageOptions,
    ...items: string[]
  ): Promise<string | undefined> {
    this.recordsValue.push({ kind: 'warning', message, items: [...items] });
    return this.select(items, this.warningResponseIndexes);
  }

  public async showErrorMessage(
    message: string,
    _options?: vscode.MessageOptions,
    ...items: string[]
  ): Promise<string | undefined> {
    this.recordsValue.push({ kind: 'error', message, items: [...items] });
    return undefined;
  }

  public async showOpenDialog(_options?: vscode.OpenDialogOptions): Promise<vscode.Uri[] | undefined> {
    return undefined;
  }

  public async showInputBox(_options?: vscode.InputBoxOptions): Promise<string | undefined> {
    return undefined;
  }

  public async showQuickPick(
    items: readonly string[],
    _options?: vscode.QuickPickOptions,
  ): Promise<string | undefined> {
    this.recordsValue.push({ kind: 'quick-pick', message: '', items: [...items] });
    return this.select(items, this.quickPickResponseIndexes);
  }

  public showTextDocument(
    document: vscode.TextDocument,
    options?: vscode.TextDocumentShowOptions,
  ): Thenable<vscode.TextEditor> {
    return this.delegate.showTextDocument(document, options);
  }
}

export interface ExtensionHostTestApi {
  setDialogPlan(plan?: ExtensionHostDialogPlan): void;
  clearDialogRecords(): void;
  getDialogRecords(): readonly ExtensionHostDialogRecord[];
  setLeft(uri: vscode.Uri): Promise<boolean>;
  compareWithRight(uri: vscode.Uri): Promise<boolean>;
  reopenComparison(): Promise<boolean>;
  clearAll(): Promise<void>;
  copyCurrentHunk(direction: CopyDirection): Promise<boolean>;
  copyWholeFile(direction: CopyDirection): Promise<boolean>;
  undoLastCopy(): Promise<boolean>;
  saveSide(side: ComparisonSide): Promise<boolean>;
  getSessionSnapshot(): ComparisonSnapshot | undefined;
  getManagedEditorUris(): ManagedEditorUris | undefined;
  getState(): ComparisonCommandState;
  getRecoveryCount(targetUri?: vscode.Uri): Promise<number>;
  clearRecoveryStorage(): Promise<number>;
}

export function createExtensionHostTestApi(
  controller: ComparisonController,
  recoveryStore: RecoveryStore,
  ui: ExtensionHostTestUi,
): ExtensionHostTestApi {
  return Object.freeze({
    setDialogPlan: (plan?: ExtensionHostDialogPlan) => ui.setPlan(plan),
    clearDialogRecords: () => ui.clearRecords(),
    getDialogRecords: () => ui.records(),
    setLeft: (uri: vscode.Uri) => controller.setLeft(uri),
    compareWithRight: (uri: vscode.Uri) => controller.compareWithRight(uri),
    reopenComparison: () => controller.reopenComparison(),
    clearAll: () => controller.clearAll(),
    copyCurrentHunk: (direction: CopyDirection) => controller.copyCurrentHunk(direction),
    copyWholeFile: (direction: CopyDirection) => controller.copyWholeFile(direction),
    undoLastCopy: () => controller.undoLastCopy(),
    saveSide: (side: ComparisonSide) => controller.saveSide(side),
    getSessionSnapshot: () => controller.getSessionSnapshot(),
    getManagedEditorUris: () => controller.getManagedEditorUris(),
    getState: () => controller.getState(),
    getRecoveryCount: async (targetUri?: vscode.Uri) => (await recoveryStore.list(targetUri)).length,
    clearRecoveryStorage: () => recoveryStore.clearAll(),
  });
}
