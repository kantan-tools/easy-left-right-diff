import * as vscode from 'vscode';
import type { ComparisonController } from '../comparison/comparison-controller';
import type { ComparisonCommandState, ComparisonSide, FileIdentity } from '../shared-types';
import { PUBLIC_COMMAND_IDS } from '../commands/command-ids';
import { createDistinguishingLocations } from '../files/file-identity';
import { t } from '../localization';

export const LEFT_RIGHT_VIEW_ID = 'easyLeftRightDiff.leftRightView';

type NodeKind = 'guidance' | 'side' | 'detail' | 'action' | 'warning' | 'mode' | 'status' | 'operation';

interface ViewNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly side?: ComparisonSide;
  readonly icon?: string;
  readonly command?: vscode.Command;
  readonly children?: readonly ViewNode[];
}

function sideLabel(side: ComparisonSide): string {
  return side === 'left' ? t('L｜左側') : t('R｜右側');
}

function sideColor(side: ComparisonSide): vscode.ThemeColor {
  return new vscode.ThemeColor(side === 'left' ? 'easyLeftRightDiff.leftBadge' : 'easyLeftRightDiff.rightBadge');
}

function workspaceLabel(identity: FileIdentity): string {
  return identity.workspaceName ?? t('ワークスペース外');
}

function command(id: string, title: string): vscode.Command {
  return { command: id, title };
}

function createSideNode(
  side: ComparisonSide,
  identity: FileIdentity | undefined,
  label: string | undefined,
  activeSide: ComparisonSide | undefined,
  distinguishingLocation: string | undefined,
  mode: ComparisonCommandState['mode'],
  dirty: boolean,
  canSelectRight = false,
): ViewNode {
  if (!identity) {
    const setCommand = side === 'left' ? PUBLIC_COMMAND_IDS.setLeft : canSelectRight ? PUBLIC_COMMAND_IDS.compareWithRight : undefined;
    const wording = side === 'left'
      ? t('L・左側ファイルを選ぶ')
      : canSelectRight ? t('R・右側ファイルを選んで比較') : t('先にL・左側ファイルを設定してください');
    return {
      id: `side-${side}-empty`,
      kind: 'side',
      side,
      label: sideLabel(side),
      description: t('未設定'),
      tooltip: wording,
      icon: side === 'left' ? 'arrow-left' : 'arrow-right',
      children: [{
        id: `side-${side}-empty-guidance`,
        kind: 'action',
        side,
        label: wording,
        icon: 'folder-opened',
        command: setCommand ? command(setCommand, wording) : undefined,
      }],
    };
  }

  const revealCommand = side === 'left' ? PUBLIC_COMMAND_IDS.revealLeft : PUBLIC_COMMAND_IDS.revealRight;
  const openCommand = side === 'left' ? PUBLIC_COMMAND_IDS.openLeft : PUBLIC_COMMAND_IDS.openRight;
  const changeCommand = side === 'left' ? PUBLIC_COMMAND_IDS.changeLeft : PUBLIC_COMMAND_IDS.changeRight;
  const labelCommand = side === 'left' ? PUBLIC_COMMAND_IDS.setLeftLabel : PUBLIC_COMMAND_IDS.setRightLabel;
  const saveCommand = side === 'left' ? PUBLIC_COMMAND_IDS.saveLeft : PUBLIC_COMMAND_IDS.saveRight;
  const isActive = activeSide === side;

  const children: ViewNode[] = [
    {
      id: `side-${side}-filename`,
      kind: 'detail',
      side,
      label: t('ファイル名：{0}', identity.displayName),
      tooltip: identity.displayName,
      icon: 'file-code',
    },
    {
      id: `side-${side}-distinguishing`,
      kind: 'detail',
      side,
      label: t('違う場所：{0}', distinguishingLocation ?? identity.relativePath),
      tooltip: t('左右を見分けるために必要な場所です。\n{0}', identity.relativePath),
      icon: 'symbol-folder',
    },
    {
      id: `side-${side}-active`,
      kind: 'status',
      side,
      label: isActive ? t('▶▶ 【現在操作中：{0}】', side === 'left' ? t('L・左側') : t('R・右側')) : t('現在操作中ではありません'),
      description: isActive ? t('操作中') : undefined,
      tooltip: t('最後にカーソル移動またはスクロールを検出した側です。コピー元・保存先・採用側を意味しません。'),
      icon: isActive ? 'circle-filled' : 'circle-outline',
    },
    {
      id: `side-${side}-save-status`,
      kind: dirty ? 'warning' : 'status',
      side,
      label: dirty ? t('未保存変更があります') : t('現在の内容は保存済みです'),
      description: dirty ? t('まだ実際のファイルへ書き込まれていません') : undefined,
      tooltip: dirty
        ? t('画面上では変更されていますが、まだ実際のファイルへ保存されていません。保存すると、VS Code／Cursorを閉じても変更が残ります。')
        : t('現在表示している内容は、実際のファイルへ保存済みです。'),
      icon: dirty ? 'circle-large-outline' : 'pass',
    },
    {
      id: `side-${side}-workspace`,
      kind: 'detail',
      side,
      label: identity.outsideWorkspace ? t('ワークスペース外') : t('ワークスペース'),
      description: workspaceLabel(identity),
      tooltip: identity.outsideWorkspace
        ? t('現在開いているワークスペースの外にあるファイルです。\n{0}', identity.uri.fsPath)
        : workspaceLabel(identity),
      icon: identity.outsideWorkspace ? 'globe' : 'root-folder',
    },
    {
      id: `side-${side}-path`,
      kind: 'detail',
      side,
      label: t('完全な場所：{0}', identity.uri.fsPath),
      tooltip: identity.uri.fsPath,
      icon: 'file',
    },
    {
      id: `side-${side}-label`,
      kind: 'action',
      side,
      label: label ? t('補助ラベル：{0}', label) : t('補助ラベルを設定'),
      description: label ? t('変更') : undefined,
      tooltip: t('補助ラベルは識別支援だけに使い、比較処理の判断には使用しません。'),
      icon: 'tag',
      command: command(labelCommand, t('補助ラベルを設定')),
    },
    {
      id: `side-${side}-reveal`,
      kind: 'action',
      side,
      label: identity.outsideWorkspace ? t('ファイルを表示') : t('エクスプローラーで場所を表示'),
      icon: 'go-to-file',
      command: command(revealCommand, t('場所を表示')),
    },
    {
      id: `side-${side}-open`,
      kind: 'action',
      side,
      label: t('{0}ファイルを開く', side === 'left' ? t('L・左側') : t('R・右側')),
      icon: 'open-preview',
      command: command(openCommand, t('{0}ファイルを開く', side === 'left' ? t('L・左側') : t('R・右側'))),
    },
    ...(mode === 'normal' && dirty ? [{
      id: `side-${side}-save`,
      kind: 'operation' as const,
      side,
      label: t('{0}の変更をファイルへ保存', side === 'left' ? t('L・左側') : t('R・右側')),
      description: t('未保存変更を確定'),
      tooltip: t('現在の未保存内容を実際のファイルへ書き込みます。保存前に対象ファイルを確認します。'),
      icon: 'save',
      command: command(saveCommand, t('{0}を保存', side === 'left' ? t('L・左側') : t('R・右側'))),
    }] : []),
    {
      id: `side-${side}-change`,
      kind: 'action',
      side,
      label: t('{0}を変更', side === 'left' ? t('L・左側') : t('R・右側')),
      icon: 'replace',
      command: command(changeCommand, t('ファイルを変更')),
    },
  ];

  return {
    id: `side-${side}`,
    kind: 'side',
    side,
    label: t('{0}｜{1}', sideLabel(side), identity.displayName),
    description: label ? t('補助ラベル：{0}', label) : undefined,
    tooltip: t('{0}\n{1}\n{2}', sideLabel(side), workspaceLabel(identity), identity.relativePath),
    icon: side === 'left' ? 'arrow-left' : 'arrow-right',
    children,
  };
}

function copyOperationNodes(state: ComparisonCommandState): ViewNode[] {
  if (!state.left || !state.right) return [];
  if (state.staleReason) {
    return [{
      id: 'stale-copy-disabled',
      kind: 'warning',
      label: t('ファイル状態が変わったためコピーは停止中です'),
      description: t('比較を開き直してください'),
      tooltip: state.staleReason,
      icon: 'warning',
      command: command(PUBLIC_COMMAND_IDS.reopenComparison, t('比較を更新する')),
    }];
  }
  if (state.mode === 'readonly') {
    return [{
      id: 'readonly-copy-disabled',
      kind: 'warning',
      label: t('読み取り専用のためコピーは無効です'),
      description: t('通常比較へ切り替えてください'),
      icon: 'lock',
      command: command(PUBLIC_COMMAND_IDS.switchMode, t('通常比較へ切り替える')),
    }];
  }

  const nodes: ViewNode[] = [
    {
      id: 'copy-hunk-ltr',
      kind: 'operation',
      label: t('L・左側の現在の変更をR・右側へコピー'),
      icon: 'arrow-right',
      command: command(PUBLIC_COMMAND_IDS.copyHunkLeftToRight, t('変更箇所をLからRへコピー')),
    },
    {
      id: 'copy-hunk-rtl',
      kind: 'operation',
      label: t('R・右側の現在の変更をL・左側へコピー'),
      icon: 'arrow-left',
      command: command(PUBLIC_COMMAND_IDS.copyHunkRightToLeft, t('変更箇所をRからLへコピー')),
    },
    {
      id: 'copy-file-ltr',
      kind: 'operation',
      label: t('L・左側ファイル全体をR・右側へコピー'),
      icon: 'files',
      command: command(PUBLIC_COMMAND_IDS.copyFileLeftToRight, t('ファイル全体をLからRへコピー')),
    },
    {
      id: 'copy-file-rtl',
      kind: 'operation',
      label: t('R・右側ファイル全体をL・左側へコピー'),
      icon: 'files',
      command: command(PUBLIC_COMMAND_IDS.copyFileRightToLeft, t('ファイル全体をRからLへコピー')),
    },
    {
      id: 'next-difference',
      kind: 'operation',
      label: t('次の差分へ移動'),
      icon: 'arrow-down',
      command: command(PUBLIC_COMMAND_IDS.nextDifference, t('次の差分へ移動')),
    },
  ];
  if (state.lastCopy) {
    nodes.push({
      id: 'undo-last-copy',
      kind: 'operation',
      label: t('直前にコピーした変更を元に戻す'),
      description: state.lastCopy.kind === 'hunk' ? t('変更箇所{0}', state.lastCopy.hunkIndex ?? 0) : t('ファイル全体'),
      tooltip: t('この拡張機能で直前に行ったコピーだけを、記録済みのコピー前全文へ正確に戻します。汎用Ctrl+Zは使用せず、ほかの編集履歴やタブを変更しません。本ツールは保存操作を行いません。自動保存がオンの場合は、元に戻した後に自動的に保存されることがあります。'),
      icon: 'discard',
      command: command(PUBLIC_COMMAND_IDS.undoLastCopy, t('直前にコピーした変更を元に戻す')),
    });
  }
  return nodes;
}

export function createViewNodes(state: ComparisonCommandState): ViewNode[] {
  const nodes: ViewNode[] = [];
  if (!state.left) {
    nodes.push(
      {
        id: 'guidance-step-1',
        kind: 'guidance',
        label: t('① 最初にL・左側ファイルを設定してください'),
        description: t('ファイルの右クリック、またはここをクリック'),
        tooltip: t('1つ目のファイルをL・左側として設定します。'),
        icon: 'info',
        command: command(PUBLIC_COMMAND_IDS.setLeft, t('L・左側ファイルを選ぶ')),
      },
      {
        id: 'guidance-compare-selected-files',
        kind: 'guidance',
        label: t('または：選択した2ファイルを左右比較'),
        description: t('同じフォルダー内など、2ファイルを同時に選びやすい場合'),
        tooltip: t('同じフォルダー内など、2ファイルを同時に選びやすい場合に便利です。選択がうまくいかない場合や別フォルダーのファイルを比較する場合は、L・左側とR・右側を1ファイルずつ設定してください。'),
        icon: 'files',
        command: command(PUBLIC_COMMAND_IDS.compareSelectedFiles, t('選択した2ファイルを左右比較')),
      },
      {
        id: 'guidance-compare-selected-files-note',
        kind: 'guidance',
        label: t('確実に比較する場合：L・Rを1ファイルずつ設定'),
        description: t('別フォルダーや同時選択がうまくいかない場合'),
        tooltip: t('最初にL・左側ファイルを設定し、次にR・右側ファイルを設定すると、別フォルダーのファイルでも確実に選択できます。'),
        icon: 'info',
      },
    );
  } else if (!state.right) {
    nodes.push({
      id: 'guidance-step-2',
      kind: 'guidance',
      label: t('② 次にR・右側ファイルを設定してください'),
      description: t('比較するもう一方を選択'),
      tooltip: t('2つ目のファイルをR・右側として設定し、L・Rの確認画面を開きます。'),
      icon: 'info',
      command: command(PUBLIC_COMMAND_IDS.compareWithRight, t('R・右側ファイルを選ぶ')),
    });
  } else if (!state.diffOpened) {
    nodes.push({
      id: 'guidance-step-3',
      kind: 'guidance',
      label: t('③ L・Rを確認して比較を開始してください'),
      description: t('通常比較または読み取り専用'),
      tooltip: t('L・Rのファイルと場所を確認して、比較画面を開きます。'),
      icon: 'info',
      command: command(PUBLIC_COMMAND_IDS.reopenComparison, t('比較を開始する')),
    });
  } else {
    nodes.push({
      id: 'guidance-comparing',
      kind: 'guidance',
      label: t('差分を確認してください'),
      description: t('必要な場合だけコピー操作を使用'),
      tooltip: t('コピーする場合は、変更箇所へ文字入力カーソルを置き、L→RまたはR→Lの方向を確認して実行します。'),
      icon: 'diff',
    });
  }

  const distinct = state.left && state.right
    ? createDistinguishingLocations(state.left, state.right)
    : undefined;

  // 比較中は案内を先頭に保ち、その直後へ現在操作中の側だけを短く強調します。
  // L/Rの実ファイル名は下の青いL／紫のRノードで確認できるため、長い対応表は重複表示しません。
  if (state.left && state.right) {
    const insertionIndex = nodes.findIndex((node) => node.id.startsWith('guidance-')) + 1;
    nodes.splice(
      insertionIndex > 0 ? insertionIndex : 0,
      0,
      {
        id: 'active-side-summary',
        kind: 'status',
        side: state.activeSide,
        label: state.activeSide
          ? t('▶ {0} 操作中', state.activeSide === 'left' ? t('L・左側') : t('R・右側'))
          : t('操作中の側：判定できません'),
        tooltip: t('最後にカーソル移動またはスクロールを検出した側です。コピー元・保存先・採用側を意味しません。'),
        icon: state.activeSide === 'left' ? 'arrow-left' : state.activeSide === 'right' ? 'arrow-right' : 'question',
      },
      {
        id: 'difference-summary',
        kind: 'status',
        label: state.differenceCount === undefined
          ? t('差分：計算中')
          : t('差分：{0}件', state.differenceCount),
        description: state.differenceCount === 0 ? t('内容は同じです') : t('クリックで内訳・一覧'),
        tooltip: t('現在のL・左側とR・右側を、既存の安全な差分ブロック単位で数えています。クリックすると変更・追加・削除の内訳と各差分位置を表示します。'),
        icon: 'diff',
        command: state.diffOpened
          ? command(PUBLIC_COMMAND_IDS.showDifferenceSummary, t('差分サマリーを表示'))
          : undefined,
      },
      {
        id: 'comparison-kind',
        kind: 'status',
        label: state.diffOpened ? t('【本ツールの左右比較画面】') : t('左右比較画面は閉じています'),
        description: state.diffOpened ? t('1つの差分タブ｜L固定・R固定') : t('L・Rは自動解除されます'),
        tooltip: state.diffOpened
          ? t('これは通常ファイル2枚の横並びではなく、1つの標準差分タブです。タブをドラッグしても比較全体が移動するだけで、L・Rは入れ替わりません。')
          : t('本ツールの差分タブを閉じると、L・R設定とエクスプローラーの印も自動解除されます。'),
        icon: state.diffOpened ? 'diff' : 'eye-closed',
      },
    );
  }

  if (state.staleReason) {
    nodes.push({
      id: 'stale-warning',
      kind: 'warning',
      label: t('比較対象の状態が変更されています'),
      description: t('古い差分情報は使用しません'),
      tooltip: state.staleReason,
      icon: 'warning',
      command: state.left && state.right ? command(PUBLIC_COMMAND_IDS.reopenComparison, t('比較を更新する')) : undefined,
    });
  }

  if (state.sameDisplayName) {
    nodes.push({
      id: 'same-name-warning',
      kind: 'warning',
      label: t('左右は同じファイル名です'),
      description: t('所属フォルダーを確認してください'),
      tooltip: t('ファイル名だけで判断せず、L・Rそれぞれのワークスペースと場所を確認してください。'),
      icon: 'warning',
    });
  }

  nodes.push(
    createSideNode('left', state.left, state.leftLabel, state.activeSide, distinct?.left, state.mode, state.leftDirty ?? false),
    createSideNode('right', state.right, state.rightLabel, state.activeSide, distinct?.right, state.mode, state.rightDirty ?? false, Boolean(state.left)),
    {
      id: 'show-file-information',
      kind: 'action',
      label: t('左右ファイル情報を表示'),
      description: t('名前・場所・完全なアドレス'),
      tooltip: t('L・左側とR・右側のファイル情報を、他の場所クリックまたはEscで閉じられる一時一覧に表示します。'),
      icon: 'info',
      command: state.left && state.right ? command(PUBLIC_COMMAND_IDS.showInfo, t('左右ファイル情報を表示')) : undefined,
    },
    {
      id: 'show-addresses',
      kind: 'action',
      label: t('左右のアドレスを表示'),
      description: t('LとRを区切って確認'),
      tooltip: t('左右の見分ける部分と完全なアドレスを、明確な区切り付きのダイアログで表示します。'),
      icon: 'list-tree',
      command: state.left && state.right ? command(PUBLIC_COMMAND_IDS.showAddresses, t('左右のアドレスを表示')) : undefined,
    },
    {
      id: 'comparison-mode',
      kind: 'mode',
      label: state.mode === 'readonly'
        ? t('現在：読み取り専用｜通常比較に切り替える')
        : t('現在：通常比較｜読み取り専用に切り替える'),
      tooltip: state.mode === 'readonly'
        ? t('差分確認のみ行い、左右コピーと実ファイルの編集を無効にしています。クリックすると「読み取り専用」と「通常比較」が切り替わります。')
        : t('差分確認、左右コピー、標準編集を利用できます。クリックすると「通常比較」と「読み取り専用」が切り替わります。'),
      icon: state.mode === 'readonly' ? 'lock' : 'edit',
      command: state.left && state.right ? command(PUBLIC_COMMAND_IDS.switchMode, t('比較モードを切り替える')) : undefined,
    },
    {
      id: 'comparison-status',
      kind: 'status',
      label: t('差分画面'),
      description: state.diffOpened ? t('開いています') : state.left && state.right ? t('開始前') : t('未開始'),
      icon: state.diffOpened ? 'eye' : 'eye-closed',
      command: state.left && state.right && !state.diffOpened
        ? command(PUBLIC_COMMAND_IDS.reopenComparison, t('比較を開き直す'))
        : undefined,
    },
    ...copyOperationNodes(state),
    {
      id: 'recent-comparisons',
      kind: 'action',
      label: t('最近の比較'),
      description: t('{0}件', state.recentComparisonCount),
      tooltip: t('過去に比較したL・Rの組み合わせを選び、同じ比較をもう一度開きます。'),
      icon: 'history',
      command: command(PUBLIC_COMMAND_IDS.showRecentComparisons, t('最近の比較を開く')),
    },
    {
      id: 'temporary-recovery',
      kind: 'action',
      label: t('復元履歴'),
      description: t('{0}件', state.recoveryCount),
      tooltip: t('コピー・保存・復元の前に自動作成された履歴を、現在の内容と見比べる、元に戻す、別ファイルとして保存する、削除する操作ができます。1ファイル3件・全体30件・合計60MBを超えた古い履歴は自動削除されます。'),
      icon: 'archive',
      command: command(PUBLIC_COMMAND_IDS.manageRecovery, t('復元履歴を開く・管理する')),
    },
    {
      id: 'usage-guide',
      kind: 'action',
      label: t('使い方・困ったとき'),
      description: t('最短手順と安全な操作'),
      tooltip: t('初めての比較、コピー方向、読み取り専用、最近の比較、復元履歴、よくある困りごとを表示します。'),
      icon: 'question',
      command: command(PUBLIC_COMMAND_IDS.showUsageGuide, t('使い方・困ったときを開く')),
    },
  );
  return nodes;
}

/** エクスプローラー内の小さな左右確認ビューです。ワークスペース全体のツリーは複製しません。 */
export class LeftRightTreeProvider implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ViewNode | undefined>();
  private state: ComparisonCommandState;
  private readonly stateSubscription: vscode.Disposable;
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly controller: ComparisonController) {
    this.state = controller.getState();
    this.stateSubscription = controller.onDidChangeState((state) => {
      this.state = state;
      this.emitter.fire(undefined);
    });
  }

  public getTreeItem(element: ViewNode): vscode.TreeItem {
    const collapsibleState = element.children && element.children.length > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsibleState);
    item.id = element.id;
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = `easyLeftRightDiff.${element.kind}${element.side ? `.${element.side}` : ''}`;
    item.command = element.command;
    if (element.icon) {
      item.iconPath = element.side ? new vscode.ThemeIcon(element.icon, sideColor(element.side)) : new vscode.ThemeIcon(element.icon);
    }
    return item;
  }

  public getChildren(element?: ViewNode): ViewNode[] {
    return element?.children ? [...element.children] : createViewNodes(this.state);
  }

  public dispose(): void {
    this.stateSubscription.dispose();
    this.emitter.dispose();
  }
}
