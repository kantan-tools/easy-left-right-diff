import * as vscode from 'vscode';

export const EXTENSION_HOST_TEST_RUN_ID_ENV = 'EASY_LEFT_RIGHT_DIFF_TEST_RUN_ID';
export type ExtensionHostEnvironment = Readonly<Record<string, string | undefined>>;

function runtimeEnvironment(): ExtensionHostEnvironment {
  const runtime = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env ?? {};
}

/**
 * 自動Extension Hostテストであることを、VS Codeの実行モードだけで推測しません。
 * Development/Testかつ、テストランナーが実行ごとに発行した明示的なRun IDがある場合だけ有効です。
 */
export function isAutomatedExtensionHostTest(
  extensionMode: vscode.ExtensionMode,
  env: ExtensionHostEnvironment = runtimeEnvironment(),
): boolean {
  const runId = env[EXTENSION_HOST_TEST_RUN_ID_ENV]?.trim();
  if (!runId) return false;
  return extensionMode === vscode.ExtensionMode.Development
    || extensionMode === vscode.ExtensionMode.Test;
}
