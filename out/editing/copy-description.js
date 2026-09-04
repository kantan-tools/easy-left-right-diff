"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHunkCopyConfirmationDetail = createHunkCopyConfirmationDetail;
exports.createWholeFileConfirmationDetail = createWholeFileConfirmationDetail;
const localization_1 = require("../localization");
function sideName(direction, role) {
    const sourceIsLeft = direction === 'left-to-right';
    if (role === 'source')
        return sourceIsLeft ? (0, localization_1.t)('L・左側') : (0, localization_1.t)('R・右側');
    return sourceIsLeft ? (0, localization_1.t)('R・右側') : (0, localization_1.t)('L・左側');
}
function operationDescription(hunk, direction) {
    const sourceLines = direction === 'left-to-right' ? hunk.leftLines : hunk.rightLines;
    const targetLines = direction === 'left-to-right' ? hunk.rightLines : hunk.leftLines;
    if (sourceLines.length === 0 && targetLines.length > 0) {
        return (0, localization_1.t)('{0}から{1}行を削除し、{2}と同じ内容にします。', sideName(direction, 'target'), targetLines.length, sideName(direction, 'source'));
    }
    if (sourceLines.length > 0 && targetLines.length === 0) {
        return (0, localization_1.t)('{0}にだけある{1}行を{2}へ追加します。', sideName(direction, 'source'), sourceLines.length, sideName(direction, 'target'));
    }
    return (0, localization_1.t)('{0}の{1}行を{2}の{3}行へ置き換えます。', sideName(direction, 'source'), sourceLines.length, sideName(direction, 'target'), targetLines.length);
}
function preview(lines) {
    const limited = lines.slice(0, 6);
    const text = limited.map((line) => (0, localization_1.t)('  {0}', line || (0, localization_1.t)('␀ 空行'))).join('\n');
    return lines.length > limited.length ? (0, localization_1.t)('{0}\n  …ほか{1}行', text, lines.length - limited.length) : text || (0, localization_1.t)('  （行なし）');
}
function createHunkCopyConfirmationDetail(snapshot, hunk, direction, style) {
    const source = direction === 'left-to-right' ? snapshot.left : snapshot.right;
    const target = direction === 'left-to-right' ? snapshot.right : snapshot.left;
    const sourceLines = direction === 'left-to-right' ? hunk.leftLines : hunk.rightLines;
    const sourceStart = direction === 'left-to-right' ? hunk.leftStart : hunk.rightStart;
    const targetStart = direction === 'left-to-right' ? hunk.rightStart : hunk.leftStart;
    const base = [
        (0, localization_1.t)('コピー元：{0}', sideName(direction, 'source')),
        (0, localization_1.t)('{0}｜{1}', source.workspaceName ?? (0, localization_1.t)('ワークスペース外'), source.relativePath),
        '',
        (0, localization_1.t)('コピー先・書き換わるファイル：{0}', sideName(direction, 'target')),
        (0, localization_1.t)('{0}｜{1}', target.workspaceName ?? (0, localization_1.t)('ワークスペース外'), target.relativePath),
        '',
        (0, localization_1.t)('対象：変更箇所{0}', hunk.index),
        (0, localization_1.t)('操作：{0}', operationDescription(hunk, direction)),
    ];
    if (style === 'compact')
        return base.join('\n');
    return [
        ...base,
        '',
        (0, localization_1.t)('コピー元の行付近：{0}行目', sourceStart + 1),
        (0, localization_1.t)('コピー先の行付近：{0}行目', targetStart + 1),
        '',
        (0, localization_1.t)('コピーする内容：'),
        preview(sourceLines),
    ].join('\n');
}
function createWholeFileConfirmationDetail(snapshot, direction, sourceLength, targetLength) {
    const source = direction === 'left-to-right' ? snapshot.left : snapshot.right;
    const target = direction === 'left-to-right' ? snapshot.right : snapshot.left;
    return [
        (0, localization_1.t)('ファイル全体コピーです。変更箇所だけではありません。'),
        '',
        (0, localization_1.t)('コピー元：{0}', sideName(direction, 'source')),
        (0, localization_1.t)('{0}｜{1}', source.workspaceName ?? (0, localization_1.t)('ワークスペース外'), source.relativePath),
        (0, localization_1.t)('文字数：{0}', sourceLength),
        '',
        (0, localization_1.t)('コピー先・書き換わるファイル：{0}', sideName(direction, 'target')),
        (0, localization_1.t)('{0}｜{1}', target.workspaceName ?? (0, localization_1.t)('ワークスペース外'), target.relativePath),
        (0, localization_1.t)('現在の文字数：{0}', targetLength),
        '',
        (0, localization_1.t)('コピー先の全内容を、コピー元の全内容へ置き換えます。'),
    ].join('\n');
}
