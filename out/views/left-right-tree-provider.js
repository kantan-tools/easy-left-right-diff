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
exports.LeftRightTreeProvider = exports.LEFT_RIGHT_VIEW_ID = void 0;
exports.createViewNodes = createViewNodes;
const vscode = __importStar(require("vscode"));
const command_ids_1 = require("../commands/command-ids");
const file_identity_1 = require("../files/file-identity");
const localization_1 = require("../localization");
exports.LEFT_RIGHT_VIEW_ID = 'easyLeftRightDiff.leftRightView';
function sideLabel(side) {
    return side === 'left' ? (0, localization_1.t)('L｜左側') : (0, localization_1.t)('R｜右側');
}
function sideColor(side) {
    return new vscode.ThemeColor(side === 'left' ? 'easyLeftRightDiff.leftBadge' : 'easyLeftRightDiff.rightBadge');
}
function workspaceLabel(identity) {
    return identity.workspaceName ?? (0, localization_1.t)('ワークスペース外');
}
function command(id, title) {
    return { command: id, title };
}
function createSideNode(side, identity, label, activeSide, distinguishingLocation, mode, dirty, canSelectRight = false) {
    if (!identity) {
        const setCommand = side === 'left' ? command_ids_1.PUBLIC_COMMAND_IDS.setLeft : canSelectRight ? command_ids_1.PUBLIC_COMMAND_IDS.compareWithRight : undefined;
        const wording = side === 'left'
            ? (0, localization_1.t)('L・左側ファイルを選ぶ')
            : canSelectRight ? (0, localization_1.t)('R・右側ファイルを選んで比較') : (0, localization_1.t)('先にL・左側ファイルを設定してください');
        return {
            id: `side-${side}-empty`,
            kind: 'side',
            side,
            label: sideLabel(side),
            description: (0, localization_1.t)('未設定'),
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
    const revealCommand = side === 'left' ? command_ids_1.PUBLIC_COMMAND_IDS.revealLeft : command_ids_1.PUBLIC_COMMAND_IDS.revealRight;
    const openCommand = side === 'left' ? command_ids_1.PUBLIC_COMMAND_IDS.openLeft : command_ids_1.PUBLIC_COMMAND_IDS.openRight;
    const changeCommand = side === 'left' ? command_ids_1.PUBLIC_COMMAND_IDS.changeLeft : command_ids_1.PUBLIC_COMMAND_IDS.changeRight;
    const labelCommand = side === 'left' ? command_ids_1.PUBLIC_COMMAND_IDS.setLeftLabel : command_ids_1.PUBLIC_COMMAND_IDS.setRightLabel;
    const saveCommand = side === 'left' ? command_ids_1.PUBLIC_COMMAND_IDS.saveLeft : command_ids_1.PUBLIC_COMMAND_IDS.saveRight;
    const isActive = activeSide === side;
    const children = [
        {
            id: `side-${side}-filename`,
            kind: 'detail',
            side,
            label: (0, localization_1.t)('ファイル名：{0}', identity.displayName),
            tooltip: identity.displayName,
            icon: 'file-code',
        },
        {
            id: `side-${side}-distinguishing`,
            kind: 'detail',
            side,
            label: (0, localization_1.t)('違う場所：{0}', distinguishingLocation ?? identity.relativePath),
            tooltip: (0, localization_1.t)('左右を見分けるために必要な場所です。\n{0}', identity.relativePath),
            icon: 'symbol-folder',
        },
        {
            id: `side-${side}-active`,
            kind: 'status',
            side,
            label: isActive ? (0, localization_1.t)('▶▶ 【現在操作中：{0}】', side === 'left' ? (0, localization_1.t)('L・左側') : (0, localization_1.t)('R・右側')) : (0, localization_1.t)('現在操作中ではありません'),
            description: isActive ? (0, localization_1.t)('操作中') : undefined,
            tooltip: (0, localization_1.t)('最後にカーソル移動またはスクロールを検出した側です。コピー元・保存先・採用側を意味しません。'),
            icon: isActive ? 'circle-filled' : 'circle-outline',
        },
        {
            id: `side-${side}-save-status`,
            kind: dirty ? 'warning' : 'status',
            side,
            label: dirty ? (0, localization_1.t)('未保存変更があります') : (0, localization_1.t)('現在の内容は保存済みです'),
            description: dirty ? (0, localization_1.t)('まだ実際のファイルへ書き込まれていません') : undefined,
            tooltip: dirty
                ? (0, localization_1.t)('画面上では変更されていますが、まだ実際のファイルへ保存されていません。保存すると、VS Code／Cursorを閉じても変更が残ります。')
                : (0, localization_1.t)('現在表示している内容は、実際のファイルへ保存済みです。'),
            icon: dirty ? 'circle-large-outline' : 'pass',
        },
        {
            id: `side-${side}-workspace`,
            kind: 'detail',
            side,
            label: identity.outsideWorkspace ? (0, localization_1.t)('ワークスペース外') : (0, localization_1.t)('ワークスペース'),
            description: workspaceLabel(identity),
            tooltip: identity.outsideWorkspace
                ? (0, localization_1.t)('現在開いているワークスペースの外にあるファイルです。\n{0}', identity.uri.fsPath)
                : workspaceLabel(identity),
            icon: identity.outsideWorkspace ? 'globe' : 'root-folder',
        },
        {
            id: `side-${side}-path`,
            kind: 'detail',
            side,
            label: (0, localization_1.t)('完全な場所：{0}', identity.uri.fsPath),
            tooltip: identity.uri.fsPath,
            icon: 'file',
        },
        {
            id: `side-${side}-label`,
            kind: 'action',
            side,
            label: label ? (0, localization_1.t)('補助ラベル：{0}', label) : (0, localization_1.t)('補助ラベルを設定'),
            description: label ? (0, localization_1.t)('変更') : undefined,
            tooltip: (0, localization_1.t)('補助ラベルは識別支援だけに使い、比較処理の判断には使用しません。'),
            icon: 'tag',
            command: command(labelCommand, (0, localization_1.t)('補助ラベルを設定')),
        },
        {
            id: `side-${side}-reveal`,
            kind: 'action',
            side,
            label: identity.outsideWorkspace ? (0, localization_1.t)('ファイルを表示') : (0, localization_1.t)('エクスプローラーで場所を表示'),
            icon: 'go-to-file',
            command: command(revealCommand, (0, localization_1.t)('場所を表示')),
        },
        {
            id: `side-${side}-open`,
            kind: 'action',
            side,
            label: (0, localization_1.t)('{0}ファイルを開く', side === 'left' ? (0, localization_1.t)('L・左側') : (0, localization_1.t)('R・右側')),
            icon: 'open-preview',
            command: command(openCommand, (0, localization_1.t)('{0}ファイルを開く', side === 'left' ? (0, localization_1.t)('L・左側') : (0, localization_1.t)('R・右側'))),
        },
        ...(mode === 'normal' && dirty ? [{
                id: `side-${side}-save`,
                kind: 'operation',
                side,
                label: (0, localization_1.t)('{0}の変更をファイルへ保存', side === 'left' ? (0, localization_1.t)('L・左側') : (0, localization_1.t)('R・右側')),
                description: (0, localization_1.t)('未保存変更を確定'),
                tooltip: (0, localization_1.t)('現在の未保存内容を実際のファイルへ書き込みます。保存前に対象ファイルを確認します。'),
                icon: 'save',
                command: command(saveCommand, (0, localization_1.t)('{0}を保存', side === 'left' ? (0, localization_1.t)('L・左側') : (0, localization_1.t)('R・右側'))),
            }] : []),
        {
            id: `side-${side}-change`,
            kind: 'action',
            side,
            label: (0, localization_1.t)('{0}を変更', side === 'left' ? (0, localization_1.t)('L・左側') : (0, localization_1.t)('R・右側')),
            icon: 'replace',
            command: command(changeCommand, (0, localization_1.t)('ファイルを変更')),
        },
    ];
    return {
        id: `side-${side}`,
        kind: 'side',
        side,
        label: (0, localization_1.t)('{0}｜{1}', sideLabel(side), identity.displayName),
        description: label ? (0, localization_1.t)('補助ラベル：{0}', label) : undefined,
        tooltip: (0, localization_1.t)('{0}\n{1}\n{2}', sideLabel(side), workspaceLabel(identity), identity.relativePath),
        icon: side === 'left' ? 'arrow-left' : 'arrow-right',
        children,
    };
}
function copyOperationNodes(state) {
    if (!state.left || !state.right)
        return [];
    if (state.staleReason) {
        return [{
                id: 'stale-copy-disabled',
                kind: 'warning',
                label: (0, localization_1.t)('ファイル状態が変わったためコピーは停止中です'),
                description: (0, localization_1.t)('比較を開き直してください'),
                tooltip: state.staleReason,
                icon: 'warning',
                command: command(command_ids_1.PUBLIC_COMMAND_IDS.reopenComparison, (0, localization_1.t)('比較を更新する')),
            }];
    }
    if (state.mode === 'readonly') {
        return [{
                id: 'readonly-copy-disabled',
                kind: 'warning',
                label: (0, localization_1.t)('読み取り専用のためコピーは無効です'),
                description: (0, localization_1.t)('通常比較へ切り替えてください'),
                icon: 'lock',
                command: command(command_ids_1.PUBLIC_COMMAND_IDS.switchMode, (0, localization_1.t)('通常比較へ切り替える')),
            }];
    }
    const nodes = [
        {
            id: 'copy-hunk-ltr',
            kind: 'operation',
            label: (0, localization_1.t)('L・左側の現在の変更をR・右側へコピー'),
            icon: 'arrow-right',
            command: command(command_ids_1.PUBLIC_COMMAND_IDS.copyHunkLeftToRight, (0, localization_1.t)('変更箇所をLからRへコピー')),
        },
        {
            id: 'copy-hunk-rtl',
            kind: 'operation',
            label: (0, localization_1.t)('R・右側の現在の変更をL・左側へコピー'),
            icon: 'arrow-left',
            command: command(command_ids_1.PUBLIC_COMMAND_IDS.copyHunkRightToLeft, (0, localization_1.t)('変更箇所をRからLへコピー')),
        },
        {
            id: 'copy-file-ltr',
            kind: 'operation',
            label: (0, localization_1.t)('L・左側ファイル全体をR・右側へコピー'),
            icon: 'files',
            command: command(command_ids_1.PUBLIC_COMMAND_IDS.copyFileLeftToRight, (0, localization_1.t)('ファイル全体をLからRへコピー')),
        },
        {
            id: 'copy-file-rtl',
            kind: 'operation',
            label: (0, localization_1.t)('R・右側ファイル全体をL・左側へコピー'),
            icon: 'files',
            command: command(command_ids_1.PUBLIC_COMMAND_IDS.copyFileRightToLeft, (0, localization_1.t)('ファイル全体をRからLへコピー')),
        },
        {
            id: 'next-difference',
            kind: 'operation',
            label: (0, localization_1.t)('次の差分へ移動'),
            icon: 'arrow-down',
            command: command(command_ids_1.PUBLIC_COMMAND_IDS.nextDifference, (0, localization_1.t)('次の差分へ移動')),
        },
    ];
    if (state.lastCopy) {
        nodes.push({
            id: 'undo-last-copy',
            kind: 'operation',
            label: (0, localization_1.t)('直前にコピーした変更を元に戻す'),
            description: state.lastCopy.kind === 'hunk' ? (0, localization_1.t)('変更箇所{0}', state.lastCopy.hunkIndex ?? 0) : (0, localization_1.t)('ファイル全体'),
            tooltip: (0, localization_1.t)('この拡張機能で直前に行ったコピーだけを、記録済みのコピー前全文へ正確に戻します。汎用Ctrl+Zは使用せず、ほかの編集履歴やタブを変更しません。本ツールは保存操作を行いません。自動保存がオンの場合は、元に戻した後に自動的に保存されることがあります。'),
            icon: 'discard',
            command: command(command_ids_1.PUBLIC_COMMAND_IDS.undoLastCopy, (0, localization_1.t)('直前にコピーした変更を元に戻す')),
        });
    }
    return nodes;
}
function createViewNodes(state) {
    const nodes = [];
    if (!state.left) {
        nodes.push({
            id: 'guidance-step-1',
            kind: 'guidance',
            label: (0, localization_1.t)('① 最初にL・左側ファイルを設定してください'),
            description: (0, localization_1.t)('ファイルの右クリック、またはここをクリック'),
            tooltip: (0, localization_1.t)('1つ目のファイルをL・左側として設定します。'),
            icon: 'info',
            command: command(command_ids_1.PUBLIC_COMMAND_IDS.setLeft, (0, localization_1.t)('L・左側ファイルを選ぶ')),
        }, {
            id: 'guidance-compare-selected-files',
            kind: 'guidance',
            label: (0, localization_1.t)('または：選択した2ファイルを左右比較'),
            description: (0, localization_1.t)('同じフォルダー内など、2ファイルを同時に選びやすい場合'),
            tooltip: (0, localization_1.t)('同じフォルダー内など、2ファイルを同時に選びやすい場合に便利です。選択がうまくいかない場合や別フォルダーのファイルを比較する場合は、L・左側とR・右側を1ファイルずつ設定してください。'),
            icon: 'files',
            command: command(command_ids_1.PUBLIC_COMMAND_IDS.compareSelectedFiles, (0, localization_1.t)('選択した2ファイルを左右比較')),
        }, {
            id: 'guidance-compare-selected-files-note',
            kind: 'guidance',
            label: (0, localization_1.t)('確実に比較する場合：L・Rを1ファイルずつ設定'),
            description: (0, localization_1.t)('別フォルダーや同時選択がうまくいかない場合'),
            tooltip: (0, localization_1.t)('最初にL・左側ファイルを設定し、次にR・右側ファイルを設定すると、別フォルダーのファイルでも確実に選択できます。'),
            icon: 'info',
        });
    }
    else if (!state.right) {
        nodes.push({
            id: 'guidance-step-2',
            kind: 'guidance',
            label: (0, localization_1.t)('② 次にR・右側ファイルを設定してください'),
            description: (0, localization_1.t)('比較するもう一方を選択'),
            tooltip: (0, localization_1.t)('2つ目のファイルをR・右側として設定し、L・Rの確認画面を開きます。'),
            icon: 'info',
            command: command(command_ids_1.PUBLIC_COMMAND_IDS.compareWithRight, (0, localization_1.t)('R・右側ファイルを選ぶ')),
        });
    }
    else if (!state.diffOpened) {
        nodes.push({
            id: 'guidance-step-3',
            kind: 'guidance',
            label: (0, localization_1.t)('③ L・Rを確認して比較を開始してください'),
            description: (0, localization_1.t)('通常比較または読み取り専用'),
            tooltip: (0, localization_1.t)('L・Rのファイルと場所を確認して、比較画面を開きます。'),
            icon: 'info',
            command: command(command_ids_1.PUBLIC_COMMAND_IDS.reopenComparison, (0, localization_1.t)('比較を開始する')),
        });
    }
    else {
        nodes.push({
            id: 'guidance-comparing',
            kind: 'guidance',
            label: (0, localization_1.t)('差分を確認してください'),
            description: (0, localization_1.t)('必要な場合だけコピー操作を使用'),
            tooltip: (0, localization_1.t)('コピーする場合は、変更箇所へ文字入力カーソルを置き、L→RまたはR→Lの方向を確認して実行します。'),
            icon: 'diff',
        });
    }
    const distinct = state.left && state.right
        ? (0, file_identity_1.createDistinguishingLocations)(state.left, state.right)
        : undefined;
    // 比較中は案内を先頭に保ち、その直後へ現在操作中の側だけを短く強調します。
    // L/Rの実ファイル名は下の青いL／紫のRノードで確認できるため、長い対応表は重複表示しません。
    if (state.left && state.right) {
        const insertionIndex = nodes.findIndex((node) => node.id.startsWith('guidance-')) + 1;
        nodes.splice(insertionIndex > 0 ? insertionIndex : 0, 0, {
            id: 'active-side-summary',
            kind: 'status',
            side: state.activeSide,
            label: state.activeSide
                ? (0, localization_1.t)('▶ {0} 操作中', state.activeSide === 'left' ? (0, localization_1.t)('L・左側') : (0, localization_1.t)('R・右側'))
                : (0, localization_1.t)('操作中の側：判定できません'),
            tooltip: (0, localization_1.t)('最後にカーソル移動またはスクロールを検出した側です。コピー元・保存先・採用側を意味しません。'),
            icon: state.activeSide === 'left' ? 'arrow-left' : state.activeSide === 'right' ? 'arrow-right' : 'question',
        }, {
            id: 'difference-summary',
            kind: 'status',
            label: state.differenceCount === undefined
                ? (0, localization_1.t)('差分：計算中')
                : (0, localization_1.t)('差分：{0}件', state.differenceCount),
            description: state.differenceCount === 0 ? (0, localization_1.t)('内容は同じです') : (0, localization_1.t)('クリックで内訳・一覧'),
            tooltip: (0, localization_1.t)('現在のL・左側とR・右側を、既存の安全な差分ブロック単位で数えています。クリックすると変更・追加・削除の内訳と各差分位置を表示します。'),
            icon: 'diff',
            command: state.diffOpened
                ? command(command_ids_1.PUBLIC_COMMAND_IDS.showDifferenceSummary, (0, localization_1.t)('差分サマリーを表示'))
                : undefined,
        }, {
            id: 'comparison-kind',
            kind: 'status',
            label: state.diffOpened ? (0, localization_1.t)('【本ツールの左右比較画面】') : (0, localization_1.t)('左右比較画面は閉じています'),
            description: state.diffOpened ? (0, localization_1.t)('1つの差分タブ｜L固定・R固定') : (0, localization_1.t)('L・Rは自動解除されます'),
            tooltip: state.diffOpened
                ? (0, localization_1.t)('これは通常ファイル2枚の横並びではなく、1つの標準差分タブです。タブをドラッグしても比較全体が移動するだけで、L・Rは入れ替わりません。')
                : (0, localization_1.t)('本ツールの差分タブを閉じると、L・R設定とエクスプローラーの印も自動解除されます。'),
            icon: state.diffOpened ? 'diff' : 'eye-closed',
        });
    }
    if (state.staleReason) {
        nodes.push({
            id: 'stale-warning',
            kind: 'warning',
            label: (0, localization_1.t)('比較対象の状態が変更されています'),
            description: (0, localization_1.t)('古い差分情報は使用しません'),
            tooltip: state.staleReason,
            icon: 'warning',
            command: state.left && state.right ? command(command_ids_1.PUBLIC_COMMAND_IDS.reopenComparison, (0, localization_1.t)('比較を更新する')) : undefined,
        });
    }
    if (state.sameDisplayName) {
        nodes.push({
            id: 'same-name-warning',
            kind: 'warning',
            label: (0, localization_1.t)('左右は同じファイル名です'),
            description: (0, localization_1.t)('所属フォルダーを確認してください'),
            tooltip: (0, localization_1.t)('ファイル名だけで判断せず、L・Rそれぞれのワークスペースと場所を確認してください。'),
            icon: 'warning',
        });
    }
    nodes.push(createSideNode('left', state.left, state.leftLabel, state.activeSide, distinct?.left, state.mode, state.leftDirty ?? false), createSideNode('right', state.right, state.rightLabel, state.activeSide, distinct?.right, state.mode, state.rightDirty ?? false, Boolean(state.left)), {
        id: 'show-file-information',
        kind: 'action',
        label: (0, localization_1.t)('左右ファイル情報を表示'),
        description: (0, localization_1.t)('名前・場所・完全なアドレス'),
        tooltip: (0, localization_1.t)('L・左側とR・右側のファイル情報を、他の場所クリックまたはEscで閉じられる一時一覧に表示します。'),
        icon: 'info',
        command: state.left && state.right ? command(command_ids_1.PUBLIC_COMMAND_IDS.showInfo, (0, localization_1.t)('左右ファイル情報を表示')) : undefined,
    }, {
        id: 'show-addresses',
        kind: 'action',
        label: (0, localization_1.t)('左右のアドレスを表示'),
        description: (0, localization_1.t)('LとRを区切って確認'),
        tooltip: (0, localization_1.t)('左右の見分ける部分と完全なアドレスを、明確な区切り付きのダイアログで表示します。'),
        icon: 'list-tree',
        command: state.left && state.right ? command(command_ids_1.PUBLIC_COMMAND_IDS.showAddresses, (0, localization_1.t)('左右のアドレスを表示')) : undefined,
    }, {
        id: 'comparison-mode',
        kind: 'mode',
        label: state.mode === 'readonly'
            ? (0, localization_1.t)('現在：読み取り専用｜通常比較に切り替える')
            : (0, localization_1.t)('現在：通常比較｜読み取り専用に切り替える'),
        tooltip: state.mode === 'readonly'
            ? (0, localization_1.t)('差分確認のみ行い、左右コピーと実ファイルの編集を無効にしています。クリックすると「読み取り専用」と「通常比較」が切り替わります。')
            : (0, localization_1.t)('差分確認、左右コピー、標準編集を利用できます。クリックすると「通常比較」と「読み取り専用」が切り替わります。'),
        icon: state.mode === 'readonly' ? 'lock' : 'edit',
        command: state.left && state.right ? command(command_ids_1.PUBLIC_COMMAND_IDS.switchMode, (0, localization_1.t)('比較モードを切り替える')) : undefined,
    }, {
        id: 'comparison-status',
        kind: 'status',
        label: (0, localization_1.t)('差分画面'),
        description: state.diffOpened ? (0, localization_1.t)('開いています') : state.left && state.right ? (0, localization_1.t)('開始前') : (0, localization_1.t)('未開始'),
        icon: state.diffOpened ? 'eye' : 'eye-closed',
        command: state.left && state.right && !state.diffOpened
            ? command(command_ids_1.PUBLIC_COMMAND_IDS.reopenComparison, (0, localization_1.t)('比較を開き直す'))
            : undefined,
    }, ...copyOperationNodes(state), {
        id: 'recent-comparisons',
        kind: 'action',
        label: (0, localization_1.t)('最近の比較'),
        description: (0, localization_1.t)('{0}件', state.recentComparisonCount),
        tooltip: (0, localization_1.t)('過去に比較したL・Rの組み合わせを選び、同じ比較をもう一度開きます。'),
        icon: 'history',
        command: command(command_ids_1.PUBLIC_COMMAND_IDS.showRecentComparisons, (0, localization_1.t)('最近の比較を開く')),
    }, {
        id: 'temporary-recovery',
        kind: 'action',
        label: (0, localization_1.t)('復元履歴'),
        description: (0, localization_1.t)('{0}件', state.recoveryCount),
        tooltip: (0, localization_1.t)('コピー・保存・復元の前に自動作成された履歴を、現在の内容と見比べる、元に戻す、別ファイルとして保存する、削除する操作ができます。1ファイル3件・全体30件・合計60MBを超えた古い履歴は自動削除されます。'),
        icon: 'archive',
        command: command(command_ids_1.PUBLIC_COMMAND_IDS.manageRecovery, (0, localization_1.t)('復元履歴を開く・管理する')),
    }, {
        id: 'usage-guide',
        kind: 'action',
        label: (0, localization_1.t)('使い方・困ったとき'),
        description: (0, localization_1.t)('最短手順と安全な操作'),
        tooltip: (0, localization_1.t)('初めての比較、コピー方向、読み取り専用、最近の比較、復元履歴、よくある困りごとを表示します。'),
        icon: 'question',
        command: command(command_ids_1.PUBLIC_COMMAND_IDS.showUsageGuide, (0, localization_1.t)('使い方・困ったときを開く')),
    });
    return nodes;
}
/** エクスプローラー内の小さな左右確認ビューです。ワークスペース全体のツリーは複製しません。 */
class LeftRightTreeProvider {
    controller;
    emitter = new vscode.EventEmitter();
    state;
    stateSubscription;
    onDidChangeTreeData = this.emitter.event;
    constructor(controller) {
        this.controller = controller;
        this.state = controller.getState();
        this.stateSubscription = controller.onDidChangeState((state) => {
            this.state = state;
            this.emitter.fire(undefined);
        });
    }
    getTreeItem(element) {
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
    getChildren(element) {
        return element?.children ? [...element.children] : createViewNodes(this.state);
    }
    dispose() {
        this.stateSubscription.dispose();
        this.emitter.dispose();
    }
}
exports.LeftRightTreeProvider = LeftRightTreeProvider;
