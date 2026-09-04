"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FocusProbe = void 0;
exports.detectEditorSide = detectEditorSide;
const file_identity_1 = require("../files/file-identity");
/** 正式APIが返すTextEditorのdocument URIだけで左右を判定します。 */
function detectEditorSide(editor, snapshot, managedUris) {
    if (!editor)
        return undefined;
    const leftUri = managedUris?.left ?? snapshot.left.uri;
    const rightUri = managedUris?.right ?? snapshot.right.uri;
    if ((0, file_identity_1.isSameUri)(editor.document.uri, leftUri))
        return 'left';
    if ((0, file_identity_1.isSameUri)(editor.document.uri, rightUri))
        return 'right';
    return undefined;
}
/** 手動検証時に、正式APIが左右どちらのEditorを通知したか記録します。 */
class FocusProbe {
    output;
    constructor(output) {
        this.output = output;
    }
    record(editor, snapshot, reason, managedUris) {
        const uri = editor?.document.uri.toString(true) ?? '(undefined)';
        const side = snapshot ? detectEditorSide(editor, snapshot, managedUris) ?? 'unknown' : 'no-session';
        this.output.appendLine(`[focus:${reason}] side=${side} uri=${uri}`);
    }
}
exports.FocusProbe = FocusProbe;
