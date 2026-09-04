import * as vscode from 'vscode';
import type { ComparisonController } from '../comparison/comparison-controller';
import type { ExtensionHealth } from '../testing/extension-api';
import { INTERNAL_COMMAND_IDS, PUBLIC_COMMAND_IDS } from './command-ids';
import { t } from '../localization';

export interface CommandDependencies {
  readonly getHealth: () => ExtensionHealth;
  readonly comparison: ComparisonController;
}

type CommandHandler = (...args: unknown[]) => unknown | Thenable<unknown>;

/**
 * VS Code／Cursor側までPromise拒否を漏らすと、英語の汎用エラー通知が表示されます。
 * すべての公開コマンドをここで収束させ、利用者には日本語通知、詳細は出力ログへ分離します。
 */
function registerSafeCommand(
  comparison: ComparisonController,
  commandId: string,
  action: string,
  handler: CommandHandler,
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
    try {
      return await handler(...args);
    } catch (error) {
      comparison.reportUnexpectedCommandError(action, error);
      return false;
    }
  });
}

/** 実装2〜18の公開コマンドと、Extension Host確認用の非公開コマンドを登録します。 */
export function registerCommands(dependencies: CommandDependencies): vscode.Disposable {
  const comparison = dependencies.comparison;
  const safe = (commandId: string, action: string, handler: CommandHandler): vscode.Disposable => (
    registerSafeCommand(comparison, commandId, action, handler)
  );

  return vscode.Disposable.from(
    vscode.commands.registerCommand(INTERNAL_COMMAND_IDS.healthCheck, () => dependencies.getHealth()),
    vscode.commands.registerCommand(INTERNAL_COMMAND_IDS.selectionState, () => comparison.getState()),
    safe(PUBLIC_COMMAND_IDS.setLeft, t('L・左側の設定'), (resource?: unknown) => comparison.setLeft(resource)),
    safe(PUBLIC_COMMAND_IDS.compareWithRight, t('R・右側の設定と比較開始'), (resource?: unknown) => comparison.compareWithRight(resource)),
    safe(PUBLIC_COMMAND_IDS.compareSelectedFiles, t('選択した2ファイルを左右比較'), (resource?: unknown, selected?: unknown) => comparison.compareSelectedFiles(resource, selected)),
    safe(PUBLIC_COMMAND_IDS.changeLeft, t('L・左側の変更'), (resource?: unknown) => comparison.changeSide('left', resource)),
    safe(PUBLIC_COMMAND_IDS.changeRight, t('R・右側の変更'), (resource?: unknown) => comparison.changeSide('right', resource)),
    safe(PUBLIC_COMMAND_IDS.clearLeft, t('L・左側の解除'), () => comparison.clearSide('left')),
    safe(PUBLIC_COMMAND_IDS.clearRight, t('R・右側の解除'), () => comparison.clearSide('right')),
    safe(PUBLIC_COMMAND_IDS.clearAll, t('L・Rの全解除'), () => comparison.clearAll()),
    safe(PUBLIC_COMMAND_IDS.setLeftLabel, t('L・左側の補助ラベル設定'), () => comparison.setLabel('left')),
    safe(PUBLIC_COMMAND_IDS.setRightLabel, t('R・右側の補助ラベル設定'), () => comparison.setLabel('right')),
    safe(PUBLIC_COMMAND_IDS.revealLeft, t('L・左側の場所表示'), () => comparison.revealSide('left')),
    safe(PUBLIC_COMMAND_IDS.revealRight, t('R・右側の場所表示'), () => comparison.revealSide('right')),
    safe(PUBLIC_COMMAND_IDS.openLeft, t('L・左側ファイルの表示'), () => comparison.openSide('left')),
    safe(PUBLIC_COMMAND_IDS.openRight, t('R・右側ファイルの表示'), () => comparison.openSide('right')),
    safe(PUBLIC_COMMAND_IDS.swapSides, t('L・Rの入れ替え'), () => comparison.swapSides()),
    safe(PUBLIC_COMMAND_IDS.switchMode, t('比較方法の切り替え'), () => comparison.switchMode()),
    safe(PUBLIC_COMMAND_IDS.switchToReadonly, t('読み取り専用比較への切り替え'), () => comparison.switchMode('readonly')),
    safe(PUBLIC_COMMAND_IDS.switchToNormal, t('通常比較への切り替え'), () => comparison.switchMode('normal')),
    safe(PUBLIC_COMMAND_IDS.showInfo, t('左右ファイル情報の表示'), () => comparison.showComparisonInfo()),
    safe(PUBLIC_COMMAND_IDS.showAddresses, t('左右アドレスの表示'), () => comparison.showAddressDialog()),
    safe(PUBLIC_COMMAND_IDS.showUsageGuide, t('使い方の表示'), () => comparison.showUsageGuide()),
    safe(PUBLIC_COMMAND_IDS.reopenComparison, t('比較の更新'), () => comparison.reopenComparison()),
    safe(PUBLIC_COMMAND_IDS.endComparison, t('比較の終了'), () => comparison.endComparison()),
    safe(PUBLIC_COMMAND_IDS.copyHunkLeftToRight, t('LからRへの変更箇所コピー'), () => comparison.copyCurrentHunk('left-to-right')),
    safe(PUBLIC_COMMAND_IDS.copyHunkRightToLeft, t('RからLへの変更箇所コピー'), () => comparison.copyCurrentHunk('right-to-left')),
    safe(PUBLIC_COMMAND_IDS.copyFileLeftToRight, t('LからRへのファイル全体コピー'), () => comparison.copyWholeFile('left-to-right')),
    safe(PUBLIC_COMMAND_IDS.copyFileRightToLeft, t('RからLへのファイル全体コピー'), () => comparison.copyWholeFile('right-to-left')),
    safe(PUBLIC_COMMAND_IDS.undoLastCopy, t('直前コピーの復元'), () => comparison.undoLastCopy()),
    safe(PUBLIC_COMMAND_IDS.saveLeft, t('L・左側の保存'), () => comparison.saveSide('left')),
    safe(PUBLIC_COMMAND_IDS.saveRight, t('R・右側の保存'), () => comparison.saveSide('right')),
    safe(PUBLIC_COMMAND_IDS.nextDifference, t('次の差分への移動'), () => comparison.moveToNextDifference()),
    safe(PUBLIC_COMMAND_IDS.showDifferenceSummary, t('差分サマリーの表示'), () => comparison.showDifferenceSummary()),
    safe(PUBLIC_COMMAND_IDS.showRecentComparisons, t('最近の比較の表示'), () => comparison.showRecentComparisons()),
    safe(PUBLIC_COMMAND_IDS.manageRecovery, t('復元履歴の管理'), () => comparison.manageRecovery()),
    safe(PUBLIC_COMMAND_IDS.manageFileRecovery, t('このファイルの復元履歴の表示'), (resource?: unknown) => comparison.manageFileRecovery(resource)),
    safe(PUBLIC_COMMAND_IDS.recoveryExplain, t('復元履歴の比較画面の説明'), (resource?: unknown) => comparison.showRecoveryComparisonHelp(resource)),
    safe(PUBLIC_COMMAND_IDS.recoveryRestore, t('復元履歴から現在のファイルへ戻す'), (resource?: unknown) => comparison.restoreRecoveryFromComparison(resource)),
    safe(PUBLIC_COMMAND_IDS.recoverySaveAs, t('復元履歴を別ファイルとして保存'), (resource?: unknown) => comparison.saveRecoveryFromComparison(resource)),
    safe(PUBLIC_COMMAND_IDS.recoveryOpenCurrent, t('復元履歴の対象ファイルを開く'), (resource?: unknown) => comparison.openRecoveryTarget(resource)),
    safe(PUBLIC_COMMAND_IDS.recoveryShowTargetInfo, t('復元履歴の対象ファイル情報を表示'), (resource?: unknown) => comparison.showRecoveryTargetInfo(resource)),
    safe(PUBLIC_COMMAND_IDS.recoveryDelete, t('復元履歴の削除'), (resource?: unknown) => comparison.deleteRecoveryFromComparison(resource)),
    safe(PUBLIC_COMMAND_IDS.retryRestoreFormat, t('復元形式の保存再試行'), (resource?: unknown) => comparison.retryRestoreFormat(resource)),
    safe(PUBLIC_COMMAND_IDS.resetRecoveryStorage, t('復元履歴保存領域の初期化'), () => comparison.resetRecoveryStorage()),
    safe(PUBLIC_COMMAND_IDS.openControlMenu, t('左右確認メニューの表示'), () => comparison.openControlMenu()),
    safe(PUBLIC_COMMAND_IDS.enableExplorerColors, t('ExplorerのL/R色表示設定'), () => comparison.enableExplorerDecorationColors()),
  );
}
