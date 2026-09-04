import type { ComparisonSide } from '../shared-types';
import type { DiffHunk } from '../comparison/diff-model';

export interface HunkPatch {
  readonly targetStartOffset: number;
  readonly targetEndOffset: number;
  readonly replacementText: string;
}

/** 各論理行の開始オフセットを、CRLF・LF・CRを壊さず取得します。 */
export function getLineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\r') {
      if (text[index + 1] === '\n') {
        index += 1;
      }
      offsets.push(index + 1);
    } else if (char === '\n') {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function lineStartOffset(text: string, offsets: readonly number[], line: number): number {
  return line >= offsets.length ? text.length : offsets[line]!;
}

/** 改行形式だけをコピー先へ合わせ、行内容と末尾改行の有無はソース範囲に従います。 */
function normalizeEol(text: string, targetEol: '\n' | '\r\n'): string {
  return text.replace(/\r\n|\r|\n/g, targetEol);
}

/** 指定方向の変更ブロックを、コピー先テキストへ適用するための安全な範囲へ変換します。 */
export function buildHunkPatch(
  hunk: DiffHunk,
  direction: 'left-to-right' | 'right-to-left',
  leftText: string,
  rightText: string,
  targetEol: '\n' | '\r\n',
): HunkPatch {
  const sourceSide: ComparisonSide = direction === 'left-to-right' ? 'left' : 'right';
  const sourceText = sourceSide === 'left' ? leftText : rightText;
  const targetText = sourceSide === 'left' ? rightText : leftText;
  const sourceStart = sourceSide === 'left' ? hunk.leftStart : hunk.rightStart;
  const sourceEnd = sourceSide === 'left' ? hunk.leftEnd : hunk.rightEnd;
  const targetStart = sourceSide === 'left' ? hunk.rightStart : hunk.leftStart;
  const targetEnd = sourceSide === 'left' ? hunk.rightEnd : hunk.leftEnd;
  const sourceOffsets = getLineStartOffsets(sourceText);
  const targetOffsets = getLineStartOffsets(targetText);

  const sourceStartOffset = lineStartOffset(sourceText, sourceOffsets, sourceStart);
  const sourceEndOffset = lineStartOffset(sourceText, sourceOffsets, sourceEnd);
  const targetStartOffset = lineStartOffset(targetText, targetOffsets, targetStart);
  const targetEndOffset = lineStartOffset(targetText, targetOffsets, targetEnd);

  return {
    targetStartOffset,
    targetEndOffset,
    replacementText: normalizeEol(sourceText.slice(sourceStartOffset, sourceEndOffset), targetEol),
  };
}
