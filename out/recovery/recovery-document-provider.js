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
exports.RecoveryDocumentProvider = exports.RECOVERY_SCHEME = void 0;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
exports.RECOVERY_SCHEME = 'easy-left-right-diff-recovery';
/** 復元履歴と、比較開始時点の現在内容を読み取り専用で差分画面へ渡します。 */
class RecoveryDocumentProvider {
    store;
    emitter = new vscode.EventEmitter();
    currentContents = new Map();
    comparisonSnapshots = new Map();
    onDidChange = this.emitter.event;
    constructor(store) {
        this.store = store;
    }
    createHistoryUri(snapshotId, displayName, comparisonId = snapshotId) {
        return this.buildUri(snapshotId, comparisonId, displayName, 'history');
    }
    /** 旧呼び出しとの互換用。履歴側の読み取り専用URIを返します。 */
    createUri(snapshotId, displayName) {
        return this.createHistoryUri(snapshotId, displayName);
    }
    createCurrentUri(snapshotId, displayName, currentText, comparisonId = snapshotId) {
        this.currentContents.set(comparisonId, currentText);
        this.comparisonSnapshots.set(comparisonId, snapshotId);
        return this.buildUri(snapshotId, comparisonId, displayName, 'current');
    }
    /** 同じ履歴を複数回開いても、比較ごとの「開いた時点の内容」を混在させません。 */
    createComparisonUris(snapshotId, displayName, currentText) {
        const comparisonId = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
        this.currentContents.set(comparisonId, currentText);
        this.comparisonSnapshots.set(comparisonId, snapshotId);
        return {
            comparisonId,
            historyUri: this.buildUri(snapshotId, comparisonId, displayName, 'history'),
            currentUri: this.buildUri(snapshotId, comparisonId, displayName, 'current'),
        };
    }
    currentText(comparisonId) {
        return this.currentContents.get(comparisonId);
    }
    currentTextFromUri(uri) {
        const comparisonId = new URLSearchParams(uri.query).get('comparison');
        return comparisonId ? this.currentContents.get(comparisonId) : undefined;
    }
    release(snapshotId) {
        // 互換名を維持しますが、実装57以降は比較インスタンスIDを受け取ります。
        this.currentContents.delete(snapshotId);
        this.comparisonSnapshots.delete(snapshotId);
    }
    releaseSnapshot(snapshotId) {
        for (const [comparisonId, value] of this.comparisonSnapshots) {
            if (value === snapshotId)
                this.release(comparisonId);
        }
    }
    releaseExcept(activeComparisonIds) {
        for (const comparisonId of this.comparisonSnapshots.keys()) {
            if (!activeComparisonIds.has(comparisonId))
                this.release(comparisonId);
        }
    }
    releaseAll() {
        this.currentContents.clear();
        this.comparisonSnapshots.clear();
    }
    async provideTextDocumentContent(uri) {
        const parameters = new URLSearchParams(uri.query);
        const snapshotId = parameters.get('snapshot');
        if (!snapshotId)
            throw new Error((0, localization_1.t)('復元履歴の識別子がありません。'));
        const view = (parameters.get('view') ?? 'history');
        if (view === 'current') {
            const comparisonId = parameters.get('comparison');
            if (!comparisonId)
                throw new Error((0, localization_1.t)('復元履歴の比較識別子がありません。'));
            const currentText = this.currentContents.get(comparisonId);
            if (currentText === undefined)
                throw new Error((0, localization_1.t)('比較開始時点の現在内容が見つかりません。復元履歴を開き直してください。'));
            return currentText;
        }
        const bytes = await this.store.read(snapshotId);
        return new TextDecoder('utf-8').decode(bytes);
    }
    dispose() {
        this.currentContents.clear();
        this.comparisonSnapshots.clear();
        this.emitter.dispose();
    }
    buildUri(snapshotId, comparisonId, displayName, view) {
        return vscode.Uri.from({
            scheme: exports.RECOVERY_SCHEME,
            path: `/${encodeURIComponent(displayName)}`,
            query: `snapshot=${encodeURIComponent(snapshotId)}&comparison=${encodeURIComponent(comparisonId)}&view=${view}`,
        });
    }
}
exports.RecoveryDocumentProvider = RecoveryDocumentProvider;
