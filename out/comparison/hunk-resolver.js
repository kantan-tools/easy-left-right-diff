"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveHunkAtLine = resolveHunkAtLine;
/** 実在する行を持つ側だけをカーソル照合し、ゼロ行側の位置を推測しません。 */
function containsLine(hunk, side, line) {
    const start = side === 'left' ? hunk.leftStart : hunk.rightStart;
    const end = side === 'left' ? hunk.leftEnd : hunk.rightEnd;
    return end > start && line >= start && line < end;
}
/** カーソル行から変更ブロックを一意に解決します。 */
function resolveHunkAtLine(hunks, side, line) {
    const matches = hunks.filter((hunk) => containsLine(hunk, side, line));
    if (matches.length === 1) {
        return { status: 'resolved', hunk: matches[0], matches };
    }
    return {
        status: matches.length === 0 ? 'not-found' : 'ambiguous',
        matches,
    };
}
