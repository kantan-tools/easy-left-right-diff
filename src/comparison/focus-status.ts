import * as vscode from 'vscode';
import { detectEditorSide, type ManagedEditorUris } from './focus-probe';
import type { ComparisonSide, ComparisonSnapshot, FileIdentity } from '../shared-types';
import { t } from '../localization';

export interface FocusStatusDescriptor {
  readonly text: string;
  readonly tooltip: string;
  readonly colorId: string | undefined;
}

function sideLabel(side: ComparisonSide): string {
  return side === 'left' ? t('L・左側') : t('R・右側');
}

function sessionTooltip(snapshot: ComparisonSnapshot): string {
  return [
    t('かんたん左右ファイル比較'),
    t('L・左側：{0}｜{1}', snapshot.left.workspaceName ?? t('ワークスペース外'), snapshot.left.relativePath),
    t('R・右側：{0}｜{1}', snapshot.right.workspaceName ?? t('ワークスペース外'), snapshot.right.relativePath),
  ].join('\n');
}

/** 正式APIで判定した現在操作中の側を、見逃しにくい固定文言で表します。 */
export function describeFocusStatus(
  editor: vscode.TextEditor | undefined,
  snapshot: ComparisonSnapshot | undefined,
  left: FileIdentity | undefined,
  managedUris?: ManagedEditorUris,
  detectedSideOverride?: ComparisonSide | 'unknown',
): FocusStatusDescriptor | undefined {
  if (!snapshot) {
    if (!left) return undefined;
    return {
      text: t('$(arrow-left) 【L・左側を設定済み】次はR・右側'),
      tooltip: t('L・左側：{0}｜{1}\n次にR・右側を設定してください。', left.workspaceName ?? t('ワークスペース外'), left.relativePath),
      colorId: 'easyLeftRightDiff.leftBadge',
    };
  }

  const side = detectedSideOverride === 'unknown'
    ? undefined
    : detectedSideOverride ?? detectEditorSide(editor, snapshot, managedUris);
  if (!side) {
    return {
      text: t('$(question) 操作中の側：判定できません'),
      tooltip: t('{0}\n本ツールの差分画面のL・左側またはR・右側をクリックしてください。', sessionTooltip(snapshot)),
      colorId: undefined,
    };
  }

  return {
    text: side === 'left'
      ? t('$(arrow-left) L・左側 操作中')
      : t('R・右側 操作中 $(arrow-right)'),
    tooltip: t('{0}\n現在操作中：{1}\n「現在操作中」はコピー元・保存先を意味しません。', sessionTooltip(snapshot), sideLabel(side)),
    colorId: side === 'left' ? 'easyLeftRightDiff.leftBadge' : 'easyLeftRightDiff.rightBadge',
  };
}

/** 画面下のステータスバーへ、現在操作中の側を常時わかる形で反映します。 */
export class FocusStatusIndicator implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  public constructor() {
    this.item = vscode.window.createStatusBarItem(
      'easyLeftRightDiff.activeSide',
      vscode.StatusBarAlignment.Left,
      10000,
    );
    this.item.name = t('かんたん左右比較｜現在操作中の側');
    this.item.command = 'easyLeftRightDiff.showInfo';
  }

  public refresh(
    editor: vscode.TextEditor | undefined,
    snapshot: ComparisonSnapshot | undefined,
    left: FileIdentity | undefined,
    managedUris?: ManagedEditorUris,
    detectedSideOverride?: ComparisonSide | 'unknown',
  ): void {
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

  public dispose(): void {
    this.item.dispose();
  }
}
