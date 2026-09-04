import * as vscode from 'vscode';

export type LocalizeArgument = string | number | boolean;

/**
 * VS Codeの実行時ローカライズを使用します。
 * 単体テストの軽量vscodeモックにl10n APIがない場合だけ、日本語原文とプレースホルダー置換へ安全に戻します。
 */
export function t(message: string, ...args: readonly LocalizeArgument[]): string {
  const l10n = (vscode as typeof vscode & {
    l10n?: { t?: (value: string, ...parameters: LocalizeArgument[]) => string };
  }).l10n;
  if (typeof l10n?.t === 'function') return l10n.t(message, ...args);
  return message.replace(/\{(\d+)\}/g, (whole, indexText: string) => {
    const index = Number(indexText);
    return index >= 0 && index < args.length ? String(args[index]) : whole;
  });
}

export function sideLabel(side: 'left' | 'right'): string {
  return side === 'left' ? t('L・左側') : t('R・右側');
}
