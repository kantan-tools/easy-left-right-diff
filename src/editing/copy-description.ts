import type { DiffHunk } from '../comparison/diff-model';
import type { CopyDirection, ComparisonSnapshot } from '../shared-types';
import { t } from '../localization';

export type CopyConfirmationStyle = 'detailed' | 'compact';

function sideName(direction: CopyDirection, role: 'source' | 'target'): string {
  const sourceIsLeft = direction === 'left-to-right';
  if (role === 'source') return sourceIsLeft ? t('L・左側') : t('R・右側');
  return sourceIsLeft ? t('R・右側') : t('L・左側');
}

function operationDescription(hunk: DiffHunk, direction: CopyDirection): string {
  const sourceLines = direction === 'left-to-right' ? hunk.leftLines : hunk.rightLines;
  const targetLines = direction === 'left-to-right' ? hunk.rightLines : hunk.leftLines;
  if (sourceLines.length === 0 && targetLines.length > 0) {
    return t('{0}から{1}行を削除し、{2}と同じ内容にします。', sideName(direction, 'target'), targetLines.length, sideName(direction, 'source'));
  }
  if (sourceLines.length > 0 && targetLines.length === 0) {
    return t('{0}にだけある{1}行を{2}へ追加します。', sideName(direction, 'source'), sourceLines.length, sideName(direction, 'target'));
  }
  return t('{0}の{1}行を{2}の{3}行へ置き換えます。', sideName(direction, 'source'), sourceLines.length, sideName(direction, 'target'), targetLines.length);
}

function preview(lines: readonly string[]): string {
  const limited = lines.slice(0, 6);
  const text = limited.map((line) => t('  {0}', line || t('␀ 空行'))).join('\n');
  return lines.length > limited.length ? t('{0}\n  …ほか{1}行', text, lines.length - limited.length) : text || t('  （行なし）');
}

export function createHunkCopyConfirmationDetail(
  snapshot: ComparisonSnapshot,
  hunk: DiffHunk,
  direction: CopyDirection,
  style: CopyConfirmationStyle,
): string {
  const source = direction === 'left-to-right' ? snapshot.left : snapshot.right;
  const target = direction === 'left-to-right' ? snapshot.right : snapshot.left;
  const sourceLines = direction === 'left-to-right' ? hunk.leftLines : hunk.rightLines;
  const sourceStart = direction === 'left-to-right' ? hunk.leftStart : hunk.rightStart;
  const targetStart = direction === 'left-to-right' ? hunk.rightStart : hunk.leftStart;
  const base = [
    t('コピー元：{0}', sideName(direction, 'source')),
    t('{0}｜{1}', source.workspaceName ?? t('ワークスペース外'), source.relativePath),
    '',
    t('コピー先・書き換わるファイル：{0}', sideName(direction, 'target')),
    t('{0}｜{1}', target.workspaceName ?? t('ワークスペース外'), target.relativePath),
    '',
    t('対象：変更箇所{0}', hunk.index),
    t('操作：{0}', operationDescription(hunk, direction)),
  ];
  if (style === 'compact') return base.join('\n');
  return [
    ...base,
    '',
    t('コピー元の行付近：{0}行目', sourceStart + 1),
    t('コピー先の行付近：{0}行目', targetStart + 1),
    '',
    t('コピーする内容：'),
    preview(sourceLines),
  ].join('\n');
}

export function createWholeFileConfirmationDetail(
  snapshot: ComparisonSnapshot,
  direction: CopyDirection,
  sourceLength: number,
  targetLength: number,
): string {
  const source = direction === 'left-to-right' ? snapshot.left : snapshot.right;
  const target = direction === 'left-to-right' ? snapshot.right : snapshot.left;
  return [
    t('ファイル全体コピーです。変更箇所だけではありません。'),
    '',
    t('コピー元：{0}', sideName(direction, 'source')),
    t('{0}｜{1}', source.workspaceName ?? t('ワークスペース外'), source.relativePath),
    t('文字数：{0}', sourceLength),
    '',
    t('コピー先・書き換わるファイル：{0}', sideName(direction, 'target')),
    t('{0}｜{1}', target.workspaceName ?? t('ワークスペース外'), target.relativePath),
    t('現在の文字数：{0}', targetLength),
    '',
    t('コピー先の全内容を、コピー元の全内容へ置き換えます。'),
  ].join('\n');
}
