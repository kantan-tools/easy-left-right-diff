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
exports.ReadonlyComparisonProvider = exports.READONLY_SCHEME = void 0;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
exports.READONLY_SCHEME = 'easy-left-right-diff-readonly';
function encodeSource(uri) {
    return encodeURIComponent(uri.toString(true));
}
function sideFileName(snapshot, side) {
    const identity = side === 'left' ? snapshot.left : snapshot.right;
    return identity.displayName || `${side}.txt`;
}
/** 実ファイルを変更できない標準差分表示用の仮想文書を提供します。 */
class ReadonlyComparisonProvider {
    entries = new Map();
    emitter = new vscode.EventEmitter();
    onDidChange = this.emitter.event;
    createUri(snapshot, side) {
        const identity = side === 'left' ? snapshot.left : snapshot.right;
        const fileName = sideFileName(snapshot, side);
        return vscode.Uri.from({
            scheme: exports.READONLY_SCHEME,
            path: `/${side}/${fileName}`,
            query: `source=${encodeSource(identity.uri)}&side=${side}`,
        });
    }
    setContent(uri, sourceUri, text) {
        this.entries.set(uri.toString(true), { sourceUri, text });
        this.emitter.fire(uri);
    }
    provideTextDocumentContent(uri) {
        const entry = this.entries.get(uri.toString(true));
        if (!entry) {
            throw new Error((0, localization_1.t)('読み取り専用比較の内容を取得できませんでした。比較を開き直してください。'));
        }
        return entry.text;
    }
    clear() {
        this.entries.clear();
    }
    dispose() {
        this.entries.clear();
        this.emitter.dispose();
    }
}
exports.ReadonlyComparisonProvider = ReadonlyComparisonProvider;
