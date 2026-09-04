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
exports.LatestFileDecorationRegistration = void 0;
exports.activateBuiltInGitBeforeDecorations = activateBuiltInGitBeforeDecorations;
exports.decorationSelectionKey = decorationSelectionKey;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
/**
 * VS Codeは複数のFileDecorationProviderを同じ優先度で合成し、
 * 後から登録されたProviderを先に評価します。
 * 組み込みGitが存在する場合は先に起動を完了させ、本ツールを後から登録します。
 */
async function activateBuiltInGitBeforeDecorations(output) {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension)
        return;
    try {
        if (!gitExtension.isActive)
            await gitExtension.activate();
        output?.info((0, localization_1.t)('組み込みGitの装飾登録後にL・R装飾を登録します。'));
    }
    catch (error) {
        // Gitが利用できない環境でも比較機能とL/Rバッジは成立するため、起動失敗にはしません。
        output?.info((0, localization_1.t)('組み込みGitの事前起動を省略しました。reason={0}', error instanceof Error ? error.message : String(error)));
    }
}
/**
 * 本ツールのProviderを現在の登録列の先頭へ戻すための管理クラスです。
 * L/R選択が変わった時だけ再登録し、通常のフォーカス更新では再登録しません。
 */
class LatestFileDecorationRegistration {
    provider;
    registration;
    constructor(provider) {
        this.provider = provider;
    }
    registerLatest() {
        this.registration?.dispose();
        this.registration = vscode.window.registerFileDecorationProvider(this.provider);
        this.provider.refresh();
    }
    dispose() {
        this.registration?.dispose();
        this.registration = undefined;
    }
}
exports.LatestFileDecorationRegistration = LatestFileDecorationRegistration;
function decorationSelectionKey(left, right) {
    return `${left?.toString(true) ?? ''}\u0000${right?.toString(true) ?? ''}`;
}
