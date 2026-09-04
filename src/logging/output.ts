import * as vscode from 'vscode';
import { t } from '../localization';

export const OUTPUT_CHANNEL_NAME = t('かんたん左右ファイル比較');

/** 利用者向け通知と混同しない、ローカル開発ログの最小ラッパーです。 */
export class ExtensionOutput implements vscode.Disposable {
  private disposed = false;

  public constructor(private readonly channel: vscode.OutputChannel) {}

  public info(message: string): void {
    if (!this.disposed) {
      this.channel.appendLine(`[info] ${message}`);
    }
  }

  public error(message: string, error?: unknown): void {
    if (this.disposed) {
      return;
    }
    this.channel.appendLine(`[error] ${message}`);
    if (error instanceof Error) {
      this.channel.appendLine(`${error.name}: ${error.message}`);
    } else if (error !== undefined) {
      this.channel.appendLine(String(error));
    }
  }

  public show(preserveFocus = true): void {
    if (!this.disposed) {
      this.channel.show(preserveFocus);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.channel.dispose();
  }
}

export function createExtensionOutput(): ExtensionOutput {
  return new ExtensionOutput(vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME));
}
