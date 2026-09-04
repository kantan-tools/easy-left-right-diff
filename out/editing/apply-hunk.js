"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyHunk = applyHunk;
const vscode = __importStar(require("vscode"));
const hunk_patch_1 = require("./hunk-patch");
const localization_1 = require("../localization");
/** WorkspaceEditを使い、コピー先だけを標準の未保存テキスト編集として変更します。 */
async function applyHunk(snapshot, hunk, direction, managedUris, expected) {
    const leftDocument = await vscode.workspace.openTextDocument(managedUris?.left ?? snapshot.left.uri);
    const rightDocument = await vscode.workspace.openTextDocument(managedUris?.right ?? snapshot.right.uri);
    if (expected && (leftDocument.version !== expected.leftVersion
        || rightDocument.version !== expected.rightVersion
        || leftDocument.getText() !== expected.leftText
        || rightDocument.getText() !== expected.rightText)) {
        throw new Error((0, localization_1.t)('コピー内容を適用する直前にファイルが変更されたため、古い差分位置を使用せず中止しました。'));
    }
    const targetDocument = direction === 'left-to-right' ? rightDocument : leftDocument;
    const targetEol = targetDocument.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const patch = (0, hunk_patch_1.buildHunkPatch)(hunk, direction, leftDocument.getText(), rightDocument.getText(), targetEol);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(targetDocument.uri, new vscode.Range(targetDocument.positionAt(patch.targetStartOffset), targetDocument.positionAt(patch.targetEndOffset)), patch.replacementText, {
        label: direction === 'left-to-right'
            ? (0, localization_1.t)('L・左側の現在の変更をR・右側へコピー')
            : (0, localization_1.t)('R・右側の現在の変更をL・左側へコピー'),
        needsConfirmation: false,
        description: (0, localization_1.t)('変更ブロック{0}', hunk.index),
    });
    return vscode.workspace.applyEdit(edit);
}
