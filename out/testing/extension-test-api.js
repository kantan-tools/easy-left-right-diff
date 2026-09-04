"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtensionHostTestUi = void 0;
exports.createExtensionHostTestApi = createExtensionHostTestApi;
/**
 * Extension Host自動テスト専用UIです。
 * Productionでは生成せず、通常利用者のダイアログや設定へ影響させません。
 */
class ExtensionHostTestUi {
    delegate;
    informationResponseIndexes = [];
    warningResponseIndexes = [];
    quickPickResponseIndexes = [];
    recordsValue = [];
    constructor(delegate) {
        this.delegate = delegate;
    }
    setPlan(plan = {}) {
        this.informationResponseIndexes = [...(plan.informationResponseIndexes ?? [])];
        this.warningResponseIndexes = [...(plan.warningResponseIndexes ?? [])];
        this.quickPickResponseIndexes = [...(plan.quickPickResponseIndexes ?? [])];
    }
    clearRecords() {
        this.recordsValue.length = 0;
    }
    records() {
        return Object.freeze(this.recordsValue.map((item) => Object.freeze({ ...item, items: Object.freeze([...item.items]) })));
    }
    select(items, queue) {
        const index = queue.shift();
        if (index === undefined)
            return undefined;
        return index >= 0 && index < items.length ? items[index] : undefined;
    }
    async showInformationMessage(message, _options, ...items) {
        this.recordsValue.push({ kind: 'information', message, items: [...items] });
        return this.select(items, this.informationResponseIndexes);
    }
    async showWarningMessage(message, _options, ...items) {
        this.recordsValue.push({ kind: 'warning', message, items: [...items] });
        return this.select(items, this.warningResponseIndexes);
    }
    async showErrorMessage(message, _options, ...items) {
        this.recordsValue.push({ kind: 'error', message, items: [...items] });
        return undefined;
    }
    async showOpenDialog(_options) {
        return undefined;
    }
    async showInputBox(_options) {
        return undefined;
    }
    async showQuickPick(items, _options) {
        this.recordsValue.push({ kind: 'quick-pick', message: '', items: [...items] });
        return this.select(items, this.quickPickResponseIndexes);
    }
    showTextDocument(document, options) {
        return this.delegate.showTextDocument(document, options);
    }
}
exports.ExtensionHostTestUi = ExtensionHostTestUi;
function createExtensionHostTestApi(controller, recoveryStore, ui) {
    return Object.freeze({
        setDialogPlan: (plan) => ui.setPlan(plan),
        clearDialogRecords: () => ui.clearRecords(),
        getDialogRecords: () => ui.records(),
        setLeft: (uri) => controller.setLeft(uri),
        compareWithRight: (uri) => controller.compareWithRight(uri),
        reopenComparison: () => controller.reopenComparison(),
        clearAll: () => controller.clearAll(),
        copyCurrentHunk: (direction) => controller.copyCurrentHunk(direction),
        copyWholeFile: (direction) => controller.copyWholeFile(direction),
        undoLastCopy: () => controller.undoLastCopy(),
        saveSide: (side) => controller.saveSide(side),
        getSessionSnapshot: () => controller.getSessionSnapshot(),
        getManagedEditorUris: () => controller.getManagedEditorUris(),
        getState: () => controller.getState(),
        getRecoveryCount: async (targetUri) => (await recoveryStore.list(targetUri)).length,
        clearRecoveryStorage: () => recoveryStore.clearAll(),
    });
}
