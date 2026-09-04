import { t } from '../localization';
/** 利用者向け文言と開発ログ用の詳細を分離して保持します。 */
export class ExtensionError extends Error {
  public constructor(
    public readonly code: string,
    public readonly userMessage: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExtensionError';
  }
}

export interface ErrorDetails {
  readonly name: string;
  readonly message: string;
}

export function toErrorDetails(error: unknown): ErrorDetails {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'UnknownError', message: String(error) };
}


const JAPANESE_TEXT_PATTERN = /[\u3040-\u30ff\u3400-\u9fff]/;

/**
 * VS Code／CursorやOS由来の英語エラーを、そのまま利用者向け通知へ出しません。
 * 詳細な原文は出力ログに保持し、画面には日本語の安全な説明だけを返します。
 */
export function toUserFacingErrorDetail(
  error: unknown,
  fallback = t('詳しい原因は「かんたん左右ファイル比較」の出力ログに記録しました。'),
): string {
  if (error instanceof ExtensionError) return error.userMessage;
  const detail = error instanceof Error ? error.message : String(error);
  return JAPANESE_TEXT_PATTERN.test(detail) ? detail : fallback;
}
