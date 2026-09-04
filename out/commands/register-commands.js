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
exports.registerCommands = registerCommands;
const vscode = __importStar(require("vscode"));
const command_ids_1 = require("./command-ids");
const localization_1 = require("../localization");
/**
 * VS Code／Cursor側までPromise拒否を漏らすと、英語の汎用エラー通知が表示されます。
 * すべての公開コマンドをここで収束させ、利用者には日本語通知、詳細は出力ログへ分離します。
 */
function registerSafeCommand(comparison, commandId, action, handler) {
    return vscode.commands.registerCommand(commandId, async (...args) => {
        try {
            return await handler(...args);
        }
        catch (error) {
            comparison.reportUnexpectedCommandError(action, error);
            return false;
        }
    });
}
/** 実装2〜18の公開コマンドと、Extension Host確認用の非公開コマンドを登録します。 */
function registerCommands(dependencies) {
    const comparison = dependencies.comparison;
    const safe = (commandId, action, handler) => (registerSafeCommand(comparison, commandId, action, handler));
    return vscode.Disposable.from(vscode.commands.registerCommand(command_ids_1.INTERNAL_COMMAND_IDS.healthCheck, () => dependencies.getHealth()), vscode.commands.registerCommand(command_ids_1.INTERNAL_COMMAND_IDS.selectionState, () => comparison.getState()), safe(command_ids_1.PUBLIC_COMMAND_IDS.setLeft, (0, localization_1.t)('L・左側の設定'), (resource) => comparison.setLeft(resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.compareWithRight, (0, localization_1.t)('R・右側の設定と比較開始'), (resource) => comparison.compareWithRight(resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.compareSelectedFiles, (0, localization_1.t)('選択した2ファイルを左右比較'), (resource, selected) => comparison.compareSelectedFiles(resource, selected)), safe(command_ids_1.PUBLIC_COMMAND_IDS.changeLeft, (0, localization_1.t)('L・左側の変更'), (resource) => comparison.changeSide('left', resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.changeRight, (0, localization_1.t)('R・右側の変更'), (resource) => comparison.changeSide('right', resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.clearLeft, (0, localization_1.t)('L・左側の解除'), () => comparison.clearSide('left')), safe(command_ids_1.PUBLIC_COMMAND_IDS.clearRight, (0, localization_1.t)('R・右側の解除'), () => comparison.clearSide('right')), safe(command_ids_1.PUBLIC_COMMAND_IDS.clearAll, (0, localization_1.t)('L・Rの全解除'), () => comparison.clearAll()), safe(command_ids_1.PUBLIC_COMMAND_IDS.setLeftLabel, (0, localization_1.t)('L・左側の補助ラベル設定'), () => comparison.setLabel('left')), safe(command_ids_1.PUBLIC_COMMAND_IDS.setRightLabel, (0, localization_1.t)('R・右側の補助ラベル設定'), () => comparison.setLabel('right')), safe(command_ids_1.PUBLIC_COMMAND_IDS.revealLeft, (0, localization_1.t)('L・左側の場所表示'), () => comparison.revealSide('left')), safe(command_ids_1.PUBLIC_COMMAND_IDS.revealRight, (0, localization_1.t)('R・右側の場所表示'), () => comparison.revealSide('right')), safe(command_ids_1.PUBLIC_COMMAND_IDS.openLeft, (0, localization_1.t)('L・左側ファイルの表示'), () => comparison.openSide('left')), safe(command_ids_1.PUBLIC_COMMAND_IDS.openRight, (0, localization_1.t)('R・右側ファイルの表示'), () => comparison.openSide('right')), safe(command_ids_1.PUBLIC_COMMAND_IDS.swapSides, (0, localization_1.t)('L・Rの入れ替え'), () => comparison.swapSides()), safe(command_ids_1.PUBLIC_COMMAND_IDS.switchMode, (0, localization_1.t)('比較方法の切り替え'), () => comparison.switchMode()), safe(command_ids_1.PUBLIC_COMMAND_IDS.switchToReadonly, (0, localization_1.t)('読み取り専用比較への切り替え'), () => comparison.switchMode('readonly')), safe(command_ids_1.PUBLIC_COMMAND_IDS.switchToNormal, (0, localization_1.t)('通常比較への切り替え'), () => comparison.switchMode('normal')), safe(command_ids_1.PUBLIC_COMMAND_IDS.showInfo, (0, localization_1.t)('左右ファイル情報の表示'), () => comparison.showComparisonInfo()), safe(command_ids_1.PUBLIC_COMMAND_IDS.showAddresses, (0, localization_1.t)('左右アドレスの表示'), () => comparison.showAddressDialog()), safe(command_ids_1.PUBLIC_COMMAND_IDS.showUsageGuide, (0, localization_1.t)('使い方の表示'), () => comparison.showUsageGuide()), safe(command_ids_1.PUBLIC_COMMAND_IDS.reopenComparison, (0, localization_1.t)('比較の更新'), () => comparison.reopenComparison()), safe(command_ids_1.PUBLIC_COMMAND_IDS.endComparison, (0, localization_1.t)('比較の終了'), () => comparison.endComparison()), safe(command_ids_1.PUBLIC_COMMAND_IDS.copyHunkLeftToRight, (0, localization_1.t)('LからRへの変更箇所コピー'), () => comparison.copyCurrentHunk('left-to-right')), safe(command_ids_1.PUBLIC_COMMAND_IDS.copyHunkRightToLeft, (0, localization_1.t)('RからLへの変更箇所コピー'), () => comparison.copyCurrentHunk('right-to-left')), safe(command_ids_1.PUBLIC_COMMAND_IDS.copyFileLeftToRight, (0, localization_1.t)('LからRへのファイル全体コピー'), () => comparison.copyWholeFile('left-to-right')), safe(command_ids_1.PUBLIC_COMMAND_IDS.copyFileRightToLeft, (0, localization_1.t)('RからLへのファイル全体コピー'), () => comparison.copyWholeFile('right-to-left')), safe(command_ids_1.PUBLIC_COMMAND_IDS.undoLastCopy, (0, localization_1.t)('直前コピーの復元'), () => comparison.undoLastCopy()), safe(command_ids_1.PUBLIC_COMMAND_IDS.saveLeft, (0, localization_1.t)('L・左側の保存'), () => comparison.saveSide('left')), safe(command_ids_1.PUBLIC_COMMAND_IDS.saveRight, (0, localization_1.t)('R・右側の保存'), () => comparison.saveSide('right')), safe(command_ids_1.PUBLIC_COMMAND_IDS.nextDifference, (0, localization_1.t)('次の差分への移動'), () => comparison.moveToNextDifference()), safe(command_ids_1.PUBLIC_COMMAND_IDS.showDifferenceSummary, (0, localization_1.t)('差分サマリーの表示'), () => comparison.showDifferenceSummary()), safe(command_ids_1.PUBLIC_COMMAND_IDS.showRecentComparisons, (0, localization_1.t)('最近の比較の表示'), () => comparison.showRecentComparisons()), safe(command_ids_1.PUBLIC_COMMAND_IDS.manageRecovery, (0, localization_1.t)('復元履歴の管理'), () => comparison.manageRecovery()), safe(command_ids_1.PUBLIC_COMMAND_IDS.manageFileRecovery, (0, localization_1.t)('このファイルの復元履歴の表示'), (resource) => comparison.manageFileRecovery(resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.recoveryExplain, (0, localization_1.t)('復元履歴の比較画面の説明'), (resource) => comparison.showRecoveryComparisonHelp(resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.recoveryRestore, (0, localization_1.t)('復元履歴から現在のファイルへ戻す'), (resource) => comparison.restoreRecoveryFromComparison(resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.recoverySaveAs, (0, localization_1.t)('復元履歴を別ファイルとして保存'), (resource) => comparison.saveRecoveryFromComparison(resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.recoveryOpenCurrent, (0, localization_1.t)('復元履歴の対象ファイルを開く'), (resource) => comparison.openRecoveryTarget(resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.recoveryShowTargetInfo, (0, localization_1.t)('復元履歴の対象ファイル情報を表示'), (resource) => comparison.showRecoveryTargetInfo(resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.recoveryDelete, (0, localization_1.t)('復元履歴の削除'), (resource) => comparison.deleteRecoveryFromComparison(resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.retryRestoreFormat, (0, localization_1.t)('復元形式の保存再試行'), (resource) => comparison.retryRestoreFormat(resource)), safe(command_ids_1.PUBLIC_COMMAND_IDS.resetRecoveryStorage, (0, localization_1.t)('復元履歴保存領域の初期化'), () => comparison.resetRecoveryStorage()), safe(command_ids_1.PUBLIC_COMMAND_IDS.openControlMenu, (0, localization_1.t)('左右確認メニューの表示'), () => comparison.openControlMenu()), safe(command_ids_1.PUBLIC_COMMAND_IDS.enableExplorerColors, (0, localization_1.t)('ExplorerのL/R色表示設定'), () => comparison.enableExplorerDecorationColors()));
}
