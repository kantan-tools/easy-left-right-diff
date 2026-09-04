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
exports.LeftRightFileDecorationProvider = void 0;
exports.describeDecoration = describeDecoration;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
function normalizeUriPath(uri) {
    return uri.path.replace(/\/+$/, '');
}
function isAncestor(candidate, file) {
    if (candidate.scheme !== file.scheme || candidate.authority !== file.authority) {
        return false;
    }
    const candidatePath = `${normalizeUriPath(candidate)}/`;
    return normalizeUriPath(file).startsWith(candidatePath);
}
function identityTooltip(side, identity, highlighted) {
    const workspace = identity.workspaceName ?? (0, localization_1.t)('ワークスペース外');
    const highlight = highlighted ? (0, localization_1.t)('\n\n場所を表示しました。') : '';
    return (0, localization_1.t)('{0}に設定中\n\nワークスペース：{1}\n場所：{2}{3}', side, workspace, identity.relativePath, highlight);
}
/** 実ファイルは強いL/R、親フォルダーは弱いL/R/LRを返します。 */
function describeDecoration(uri, session, highlightedUriKey, showParentFolders = true) {
    const left = session.left;
    const right = session.right;
    const uriKey = uri.toString(true);
    const highlighted = highlightedUriKey === uriKey;
    if (left && uriKey === left.uri.toString(true)) {
        return {
            badge: highlighted ? 'L!' : 'L',
            tooltip: identityTooltip((0, localization_1.t)('L・左側'), left, highlighted),
            // 通常比較は専用URIを使うため、実ファイルの識別色が差分タブへ波及しません。
            // 仕様どおり、実ファイルは青系、場所表示直後は強い青系で識別します。
            colorId: highlighted ? 'easyLeftRightDiff.leftHighlight' : 'easyLeftRightDiff.leftBadge',
            propagate: false,
        };
    }
    if (right && uriKey === right.uri.toString(true)) {
        return {
            badge: highlighted ? 'R!' : 'R',
            tooltip: identityTooltip((0, localization_1.t)('R・右側'), right, highlighted),
            // 仕様どおり、実ファイルは紫系、場所表示直後は強い紫系で識別します。
            colorId: highlighted ? 'easyLeftRightDiff.rightHighlight' : 'easyLeftRightDiff.rightBadge',
            propagate: false,
        };
    }
    if (!showParentFolders)
        return undefined;
    const containsLeft = left ? isAncestor(uri, left.uri) : false;
    const containsRight = right ? isAncestor(uri, right.uri) : false;
    if (!containsLeft && !containsRight) {
        return undefined;
    }
    return {
        badge: containsLeft && containsRight ? 'LR' : containsLeft ? 'L' : 'R',
        tooltip: containsLeft && containsRight
            ? (0, localization_1.t)('L・左側とR・右側の対象ファイルを含むフォルダー')
            : containsLeft
                ? (0, localization_1.t)('L・左側の対象ファイルを含むフォルダー')
                : (0, localization_1.t)('R・右側の対象ファイルを含むフォルダー'),
        // 親フォルダーは弱い表示とし、文字色はテーマ標準へ任せます。
        // 実ファイルだけにL青／R紫の強い補助色を使用します。
        colorId: undefined,
        propagate: false,
    };
}
/** 標準エクスプローラーへ正式APIでL・R装飾を提供します。 */
class LeftRightFileDecorationProvider {
    session;
    emitter = new vscode.EventEmitter();
    highlightedUriKey;
    highlightTimer;
    onDidChangeFileDecorations = this.emitter.event;
    constructor(session) {
        this.session = session;
    }
    provideFileDecoration(uri) {
        const showParentFolders = vscode.workspace.getConfiguration('easyLeftRightDiff').get('showParentFolderDecorations', true);
        const descriptor = describeDecoration(uri, this.session, this.highlightedUriKey, showParentFolders);
        if (!descriptor) {
            return undefined;
        }
        const decoration = new vscode.FileDecoration(descriptor.badge, descriptor.tooltip, descriptor.colorId ? new vscode.ThemeColor(descriptor.colorId) : undefined);
        decoration.propagate = descriptor.propagate;
        return decoration;
    }
    refresh() {
        this.emitter.fire(undefined);
    }
    highlight(uri, durationMs = 1800) {
        if (this.highlightTimer)
            clearTimeout(this.highlightTimer);
        this.highlightedUriKey = uri.toString(true);
        this.refresh();
        this.highlightTimer = setTimeout(() => {
            this.highlightedUriKey = undefined;
            this.highlightTimer = undefined;
            this.refresh();
        }, durationMs);
    }
    dispose() {
        if (this.highlightTimer)
            clearTimeout(this.highlightTimer);
        this.highlightTimer = undefined;
        this.emitter.dispose();
    }
}
exports.LeftRightFileDecorationProvider = LeftRightFileDecorationProvider;
