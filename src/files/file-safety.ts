import * as vscode from 'vscode';
import type { FileSafetyAssessment } from '../shared-types';
import { t } from '../localization';

export const NORMAL_SIZE_LIMIT = 5 * 1024 * 1024;
export const READONLY_SIZE_LIMIT = 20 * 1024 * 1024;
export const READONLY_LINE_LIMIT = 200_000;

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function containsNullByte(bytes: Uint8Array): boolean {
  return bytes.some((value) => value === 0);
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 1;
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

/** バイト列だけから安全判定できる純粋関数です。 */
export function assessFileBytes(bytes: Uint8Array): FileSafetyAssessment {
  const sizeBytes = bytes.byteLength;
  const reasons: string[] = [];
  if (containsNullByte(bytes)) {
    return {
      sizeBytes,
      lineCount: 0,
      encoding: 'binary',
      level: 'unsupported',
      reasons: [t('バイナリデータを検出しました。')],
      readonlyPermission: false,
    };
  }

  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return {
      sizeBytes,
      lineCount: 0,
      encoding: 'non-utf8',
      level: 'readonly',
      reasons: [t('UTF-8として安全に読み取れないため、編集を無効にします。')],
      readonlyPermission: false,
    };
  }

  const lineCount = countLines(text);
  let level: FileSafetyAssessment['level'] = 'normal';
  if (sizeBytes > READONLY_SIZE_LIMIT) {
    level = 'readonly';
    reasons.push(t('20MBを超えるため、変更箇所コピーとファイル全体コピーを無効にします。'));
  } else if (sizeBytes > NORMAL_SIZE_LIMIT) {
    level = 'warning';
    reasons.push(t('5MBを超えるため、差分表示や差分特定に時間がかかる可能性があります。'));
  }
  if (lineCount > READONLY_LINE_LIMIT) {
    level = 'readonly';
    reasons.push(t('行数が安全上限を超えるため、読み取り専用比較へ切り替えます。'));
  }

  return {
    sizeBytes,
    lineCount,
    encoding: hasUtf8Bom(bytes) ? 'utf8-bom' : 'utf8',
    level,
    reasons,
    readonlyPermission: false,
  };
}

/** VS Code FileSystem APIだけを使って対象ファイルを評価します。 */
export async function assessFile(uri: vscode.Uri): Promise<FileSafetyAssessment> {
  const [bytes, stat] = await Promise.all([
    vscode.workspace.fs.readFile(uri),
    vscode.workspace.fs.stat(uri),
  ]);
  const base = assessFileBytes(bytes);
  const readonlyPermission = Boolean(
    stat.permissions !== undefined
    && (stat.permissions & vscode.FilePermission.Readonly) === vscode.FilePermission.Readonly
  );
  if (!readonlyPermission) return base;
  const reasons = [...base.reasons, t('ファイルシステムが読み取り専用としているため、編集を無効にします。')];
  return {
    ...base,
    level: base.level === 'unsupported' ? 'unsupported' : 'readonly',
    reasons,
    readonlyPermission: true,
  };
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}
