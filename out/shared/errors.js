"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtensionError = void 0;
exports.toErrorDetails = toErrorDetails;
exports.toUserFacingErrorDetail = toUserFacingErrorDetail;
const localization_1 = require("../localization");
/** 利用者向け文言と開発ログ用の詳細を分離して保持します。 */
class ExtensionError extends Error {
    code;
    userMessage;
    constructor(code, userMessage, message, options) {
        super(message, options);
        this.code = code;
        this.userMessage = userMessage;
        this.name = 'ExtensionError';
    }
}
exports.ExtensionError = ExtensionError;
function toErrorDetails(error) {
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
function toUserFacingErrorDetail(error, fallback = (0, localization_1.t)('詳しい原因は「かんたん左右ファイル比較」の出力ログに記録しました。')) {
    if (error instanceof ExtensionError)
        return error.userMessage;
    const detail = error instanceof Error ? error.message : String(error);
    return JAPANESE_TEXT_PATTERN.test(detail) ? detail : fallback;
}
