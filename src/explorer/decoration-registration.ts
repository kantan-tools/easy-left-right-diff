import * as vscode from 'vscode';
import { t } from '../localization';

export interface DecorationRegistrationOutput {
  info(message: string): void;
}

/**
 * VS Codeは複数のFileDecorationProviderを同じ優先度で合成し、
 * 後から登録されたProviderを先に評価します。
 * 組み込みGitが存在する場合は先に起動を完了させ、本ツールを後から登録します。
 */
export async function activateBuiltInGitBeforeDecorations(
  output?: DecorationRegistrationOutput,
): Promise<void> {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) return;

  try {
    if (!gitExtension.isActive) await gitExtension.activate();
    output?.info(t('組み込みGitの装飾登録後にL・R装飾を登録します。'));
  } catch (error) {
    // Gitが利用できない環境でも比較機能とL/Rバッジは成立するため、起動失敗にはしません。
    output?.info(
      t('組み込みGitの事前起動を省略しました。reason={0}', error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * 本ツールのProviderを現在の登録列の先頭へ戻すための管理クラスです。
 * L/R選択が変わった時だけ再登録し、通常のフォーカス更新では再登録しません。
 */
export class LatestFileDecorationRegistration implements vscode.Disposable {
  private registration: vscode.Disposable | undefined;

  public constructor(private readonly provider: vscode.FileDecorationProvider & { refresh(): void }) {}

  public registerLatest(): void {
    this.registration?.dispose();
    this.registration = vscode.window.registerFileDecorationProvider(this.provider);
    this.provider.refresh();
  }

  public dispose(): void {
    this.registration?.dispose();
    this.registration = undefined;
  }
}

export function decorationSelectionKey(
  left: vscode.Uri | undefined,
  right: vscode.Uri | undefined,
): string {
  return `${left?.toString(true) ?? ''}\u0000${right?.toString(true) ?? ''}`;
}
