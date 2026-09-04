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
exports.normalizeWholeFileEol = normalizeWholeFileEol;
exports.applyWholeFile = applyWholeFile;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
function normalizeWholeFileEol(text, targetEol) {
    return text.replace(/\r\n|\r|\n/g, targetEol);
}
/** ファイル全体を、コピー先だけが未保存になる標準WorkspaceEditとして適用します。 */
async function applyWholeFile(snapshot, direction, managedUris, expected) {
    const leftDocument = await vscode.workspace.openTextDocument(managedUris?.left ?? snapshot.left.uri);
    const rightDocument = await vscode.workspace.openTextDocument(managedUris?.right ?? snapshot.right.uri);
    if (expected && (leftDocument.version !== expected.leftVersion
        || rightDocument.version !== expected.rightVersion
        || leftDocument.getText() !== expected.leftText
        || rightDocument.getText() !== expected.rightText)) {
        throw new Error((0, localization_1.t)('ファイル全体コピーを適用する直前に内容が変更されたため、確認済みでない内容はコピーしませんでした。'));
    }
    const sourceDocument = direction === 'left-to-right' ? leftDocument : rightDocument;
    const targetDocument = direction === 'left-to-right' ? rightDocument : leftDocument;
    const targetEol = targetDocument.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const sourceText = normalizeWholeFileEol(sourceDocument.getText(), targetEol);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(targetDocument.uri, new vscode.Range(targetDocument.positionAt(0), targetDocument.positionAt(targetDocument.getText().length)), sourceText, {
        label: direction === 'left-to-right'
            ? (0, localization_1.t)('L・左側ファイル全体をR・右側へコピー')
            : (0, localization_1.t)('R・右側ファイル全体をL・左側へコピー'),
        needsConfirmation: false,
        description: (0, localization_1.t)('ファイル全体コピー'),
    });
    const applied = await vscode.workspace.applyEdit(edit);
    return { applied, sourceVersion: sourceDocument.version, targetDocument };
}
