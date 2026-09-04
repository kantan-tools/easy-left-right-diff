/** 行単位差分の1変更ブロックです。endは半開区間です。 */
export interface DiffHunk {
  readonly index: number;
  readonly leftStart: number;
  readonly leftEnd: number;
  readonly rightStart: number;
  readonly rightEnd: number;
  readonly leftLines: readonly string[];
  readonly rightLines: readonly string[];
  readonly kind: 'left-only' | 'right-only' | 'replacement';
  /** 大きく複雑な区間を安全のため1ブロックへまとめた場合にtrueです。 */
  readonly coarse?: boolean;
}

/** 小区間だけに使用するLCS表の最大セル数。4byte整数で約8MBです。 */
export const DIFF_DP_CELL_LIMIT = 2_000_000;
/** これを超える巨大区間は、再帰や巨大索引を避けて安全な粗い1ブロックへまとめます。 */
export const DIFF_INDEX_LINE_LIMIT = 100_000;

/** CRLF・LF・CRを同じ論理行区切りとして分割し、末尾空行も保持します。 */
export function splitLogicalLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

interface MutableHunk {
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
  leftLines: string[];
  rightLines: string[];
  coarse?: boolean;
}

interface Anchor {
  readonly left: number;
  readonly right: number;
}

function pushHunk(
  target: MutableHunk[],
  left: readonly string[],
  right: readonly string[],
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
  coarse = false,
): void {
  if (leftStart === leftEnd && rightStart === rightEnd) return;
  const next: MutableHunk = {
    leftStart,
    leftEnd,
    rightStart,
    rightEnd,
    leftLines: left.slice(leftStart, leftEnd),
    rightLines: right.slice(rightStart, rightEnd),
    coarse: coarse || undefined,
  };
  const previous = target.at(-1);
  if (
    previous
    && previous.leftEnd === next.leftStart
    && previous.rightEnd === next.rightStart
  ) {
    previous.leftEnd = next.leftEnd;
    previous.rightEnd = next.rightEnd;
    previous.leftLines.push(...next.leftLines);
    previous.rightLines.push(...next.rightLines);
    previous.coarse = previous.coarse || next.coarse || undefined;
    return;
  }
  target.push(next);
}

/** 小さな区間だけを従来と同じ決定規則のLCSで厳密に差分化します。 */
function appendExactLcs(
  target: MutableHunk[],
  left: readonly string[],
  right: readonly string[],
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): void {
  const leftLength = leftEnd - leftStart;
  const rightLength = rightEnd - rightStart;
  const columns = rightLength + 1;
  const table = Array.from(
    { length: leftLength + 1 },
    () => new Uint32Array(columns),
  );

  for (let i = leftLength - 1; i >= 0; i -= 1) {
    const row = table[i]!;
    const nextRow = table[i + 1]!;
    for (let j = rightLength - 1; j >= 0; j -= 1) {
      row[j] = left[leftStart + i] === right[rightStart + j]
        ? 1 + nextRow[j + 1]!
        : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }

  let i = 0;
  let j = 0;
  let currentLeftStart = -1;
  let currentRightStart = -1;
  const flush = (): void => {
    if (currentLeftStart < 0) return;
    pushHunk(
      target,
      left,
      right,
      leftStart + currentLeftStart,
      leftStart + i,
      rightStart + currentRightStart,
      rightStart + j,
    );
    currentLeftStart = -1;
    currentRightStart = -1;
  };

  while (i < leftLength || j < rightLength) {
    if (
      i < leftLength
      && j < rightLength
      && left[leftStart + i] === right[rightStart + j]
    ) {
      flush();
      i += 1;
      j += 1;
      continue;
    }
    if (currentLeftStart < 0) {
      currentLeftStart = i;
      currentRightStart = j;
    }
    const takeLeft = i < leftLength && (
      j >= rightLength
      || table[i + 1]![j]! >= table[i]![j + 1]!
    );
    if (takeLeft) i += 1;
    else if (j < rightLength) j += 1;
  }
  flush();
}

/** 両側で1回だけ現れる同一行を安全なアンカーとして抽出し、交差しない最長列にします。 */
function uniqueAnchors(
  left: readonly string[],
  right: readonly string[],
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): Anchor[] {
  const leftCounts = new Map<string, { count: number; index: number }>();
  const rightCounts = new Map<string, { count: number; index: number }>();
  for (let index = leftStart; index < leftEnd; index += 1) {
    const value = left[index]!;
    const current = leftCounts.get(value);
    if (current) current.count += 1;
    else leftCounts.set(value, { count: 1, index });
  }
  for (let index = rightStart; index < rightEnd; index += 1) {
    const value = right[index]!;
    const current = rightCounts.get(value);
    if (current) current.count += 1;
    else rightCounts.set(value, { count: 1, index });
  }

  const candidates: Anchor[] = [];
  for (const [value, leftEntry] of leftCounts) {
    const rightEntry = rightCounts.get(value);
    if (leftEntry.count === 1 && rightEntry?.count === 1) {
      candidates.push({ left: leftEntry.index, right: rightEntry.index });
    }
  }
  candidates.sort((a, b) => a.left - b.left);
  if (candidates.length <= 1) return candidates;

  const tails: number[] = [];
  const tailCandidateIndexes: number[] = [];
  const previous = new Int32Array(candidates.length);
  previous.fill(-1);

  for (let index = 0; index < candidates.length; index += 1) {
    const rightIndex = candidates[index]!.right;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tails[middle]! < rightIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tailCandidateIndexes[low - 1]!;
    tails[low] = rightIndex;
    tailCandidateIndexes[low] = index;
  }

  const result: Anchor[] = [];
  let cursor = tailCandidateIndexes[tails.length - 1] ?? -1;
  while (cursor >= 0) {
    result.push(candidates[cursor]!);
    cursor = previous[cursor]!;
  }
  result.reverse();
  return result;
}

function appendSegment(
  target: MutableHunk[],
  left: readonly string[],
  right: readonly string[],
  initialLeftStart: number,
  initialLeftEnd: number,
  initialRightStart: number,
  initialRightEnd: number,
  depth = 0,
): void {
  let leftStart = initialLeftStart;
  let leftEnd = initialLeftEnd;
  let rightStart = initialRightStart;
  let rightEnd = initialRightEnd;

  while (
    leftStart < leftEnd
    && rightStart < rightEnd
    && left[leftStart] === right[rightStart]
  ) {
    leftStart += 1;
    rightStart += 1;
  }
  while (
    leftStart < leftEnd
    && rightStart < rightEnd
    && left[leftEnd - 1] === right[rightEnd - 1]
  ) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  if (leftStart === leftEnd || rightStart === rightEnd) {
    pushHunk(target, left, right, leftStart, leftEnd, rightStart, rightEnd);
    return;
  }
  if (depth >= 64) {
    // 特殊な並びでアンカー分割が深く連鎖しても、JavaScriptの呼出しスタックを使い切りません。
    pushHunk(target, left, right, leftStart, leftEnd, rightStart, rightEnd, true);
    return;
  }

  const leftLength = leftEnd - leftStart;
  const rightLength = rightEnd - rightStart;
  const cells = (leftLength + 1) * (rightLength + 1);
  if (cells <= DIFF_DP_CELL_LIMIT) {
    appendExactLcs(target, left, right, leftStart, leftEnd, rightStart, rightEnd);
    return;
  }

  if (leftLength + rightLength > DIFF_INDEX_LINE_LIMIT) {
    pushHunk(target, left, right, leftStart, leftEnd, rightStart, rightEnd, true);
    return;
  }

  const anchors = uniqueAnchors(left, right, leftStart, leftEnd, rightStart, rightEnd);
  if (anchors.length === 0) {
    // 共通の安全なアンカーがない巨大区間は、精度のために巨大表を作らず1変更として扱います。
    pushHunk(target, left, right, leftStart, leftEnd, rightStart, rightEnd, true);
    return;
  }

  let currentLeft = leftStart;
  let currentRight = rightStart;
  for (const anchor of anchors) {
    appendSegment(target, left, right, currentLeft, anchor.left, currentRight, anchor.right, depth + 1);
    currentLeft = anchor.left + 1;
    currentRight = anchor.right + 1;
  }
  appendSegment(target, left, right, currentLeft, leftEnd, currentRight, rightEnd, depth + 1);
}

/**
 * 小区間は従来互換のLCS、大区間はPatienceアンカーと安全な粗粒度フォールバックで差分化します。
 * 全行×全行の無制限な二次元表を作らないため、大量差分でもメモリ使用量を制限できます。
 */
export function createDiffHunks(leftText: string, rightText: string): DiffHunk[] {
  const left = splitLogicalLines(leftText);
  const right = splitLogicalLines(rightText);
  const mutable: MutableHunk[] = [];
  appendSegment(mutable, left, right, 0, left.length, 0, right.length);
  return mutable.map((hunk, index) => ({
    index: index + 1,
    leftStart: hunk.leftStart,
    leftEnd: hunk.leftEnd,
    rightStart: hunk.rightStart,
    rightEnd: hunk.rightEnd,
    leftLines: hunk.leftLines,
    rightLines: hunk.rightLines,
    kind: hunk.leftLines.length === 0
      ? 'right-only'
      : hunk.rightLines.length === 0
        ? 'left-only'
        : 'replacement',
    coarse: hunk.coarse,
  }));
}

/** 0行側の追加差分でも、エディター上の実在行へ安全に移動する位置を返します。 */
export function navigationLineForHunk(
  hunk: DiffHunk,
  side: 'left' | 'right',
  documentLineCount: number,
): number {
  const start = side === 'left' ? hunk.leftStart : hunk.rightStart;
  const end = side === 'left' ? hunk.leftEnd : hunk.rightEnd;
  if (end > start) return Math.max(0, Math.min(start, Math.max(0, documentLineCount - 1)));
  // 追加位置が末尾の仮想行を指す場合は、直前の実在行へ移動します。
  return Math.max(0, Math.min(start, Math.max(0, documentLineCount - 1)));
}
