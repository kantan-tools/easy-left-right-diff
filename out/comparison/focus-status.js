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
exports.FocusStatusIndicator = void 0;
exports.describeFocusStatus = describeFocusStatus;
const vscode = __importStar(require("vscode"));
const focus_probe_1 = require("./focus-probe");
const localization_1 = require("../localization");
function sideLabel(side) {
    return side === 'left' ? (0, localization_1.t)('L・左側') : (0, localization_1.t)('R・右側');
}
function sessionTooltip(snapshot) {
    return [
        (0, localization_1.t)('かんたん左右ファイル比較'),
        (0, localization_1.t)('L・左側：{0}｜{1}', snapshot.left.workspaceName ?? (0, localization_1.t)('ワークスペース外'), snapshot.left.relativePath),
        (0, localization_1.t)('R・右側：{0}｜{1}', snapshot.right.workspaceName ?? (0, localization_1.t)('ワークスペース外'), snapshot.right.relativePath),
    ].join('\n');
}
/** 正式APIで判定した現在操作中の側を、見逃しにくい固定文言で表します。 */
function describeFocusStatus(editor, snapshot, left, managedUris, detectedSideOverride) {
    if (!snapshot) {
        if (!left)
            return undefined;
        return {
            text: (0, localization_1.t)('$(arrow-left) 【L・左側を設定済み】次はR・右側'),
            tooltip: (0, localization_1.t)('L・左側：{0}｜{1}\n次にR・右側を設定してください。', left.workspaceName ?? (0, localization_1.t)('ワークスペース外'), left.relativePath),
            colorId: 'easyLeftRightDiff.leftBadge',
        };
    }
    const side = detectedSideOverride === 'unknown'
        ? undefined
        : detectedSideOverride ?? (0, focus_probe_1.detectEditorSide)(editor, snapshot, managedUris);
    if (!side) {
        return {
            text: (0, localization_1.t)('$(question) 操作中の側：判定できません'),
            tooltip: (0, localization_1.t)('{0}\n本ツールの差分画面のL・左側またはR・右側をクリックしてください。', sessionTooltip(snapshot)),
            colorId: undefined,
        };
    }
    return {
        text: side === 'left'
            ? (0, localization_1.t)('$(arrow-left) L・左側 操作中')
            : (0, localization_1.t)('R・右側 操作中 $(arrow-right)'),
        tooltip: (0, localization_1.t)('{0}\n現在操作中：{1}\n「現在操作中」はコピー元・保存先を意味しません。', sessionTooltip(snapshot), sideLabel(side)),
        colorId: side === 'left' ? 'easyLeftRightDiff.leftBadge' : 'easyLeftRightDiff.rightBadge',
    };
}
/** 画面下のステータスバーへ、現在操作中の側を常時わかる形で反映します。 */
class FocusStatusIndicator {
    item;
    constructor() {
        this.item = vscode.window.createStatusBarItem('easyLeftRightDiff.activeSide', vscode.StatusBarAlignment.Left, 10000);
        this.item.name = (0, localization_1.t)('かんたん左右比較｜現在操作中の側');
        this.item.command = 'easyLeftRightDiff.showInfo';
    }
    refresh(editor, snapshot, left, managedUris, detectedSideOverride) {
        const descriptor = describeFocusStatus(editor, snapshot, left, managedUris, detectedSideOverride);
        if (!descriptor) {
            this.item.hide();
            return;
        }
        this.item.text = descriptor.text;
        this.item.tooltip = descriptor.tooltip;
        // ステータスバー背景はテーマやウィンドウ状態で青系になるため、L/R識別色を文字色へ直接適用しません。
        // VS Code標準の前景色へ任せ、どのテーマでも文字とのコントラストを確保します。
        this.item.color = undefined;
        this.item.show();
    }
    dispose() {
        this.item.dispose();
    }
}
exports.FocusStatusIndicator = FocusStatusIndicator;
