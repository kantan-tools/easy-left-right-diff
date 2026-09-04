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
exports.EditableComparisonProvider = exports.EDITABLE_SCHEME = void 0;
const vscode = __importStar(require("vscode"));
const localization_1 = require("../localization");
exports.EDITABLE_SCHEME = 'easy-left-right-diff-editable';
function encodeSource(uri) {
    return encodeURIComponent(uri.toString());
}
function decodeSource(uri) {
    const params = new URLSearchParams(uri.query);
    const serialized = params.get('source');
    if (!serialized)
        throw vscode.FileSystemError.FileNotFound(uri);
    // URLSearchParamsが外側のエンコードを1回だけ戻します。
    // ここで再度decodeURIComponentすると、ファイル名に含まれる%20等を空白へ誤変換するため行いません。
    return vscode.Uri.parse(serialized, true);
}
function normalizePath(value) {
    return value.replace(/\\/g, '/').replace(/^\/+/, '');
}
function displayPath(identity) {
    const workspace = identity.workspaceName ?? (0, localization_1.t)('ワークスペース外');
    const path = identity.outsideWorkspace ? identity.uri.fsPath : identity.relativePath;
    return `/${workspace}/${normalizePath(path)}`;
}
function parentUri(uri) {
    const path = uri.path.replace(/\/+$/, '');
    const index = path.lastIndexOf('/');
    return uri.with({ path: index > 0 ? path.slice(0, index) : '/', query: '', fragment: '' });
}
function baseName(uri) {
    const path = uri.path.replace(/\/+$/, '');
    const index = path.lastIndexOf('/');
    return index >= 0 ? path.slice(index + 1) : path;
}
function noPermissions(message, uri) {
    const unavailable = vscode.FileSystemError.Unavailable;
    return unavailable ? unavailable(message) : new Error(`${message}\n${uri.toString(true)}`);
}
/**
 * 通常比較をVS Code標準差分のまま編集可能に保ちつつ、実ファイルURI由来の
 * 薄い補足説明へ表示を依存しないための書き込み可能な代理ファイルシステムです。
 *
 * 重要：保存時にworkspace.fs.writeFileで実ファイルを直接書き換えません。
 * 実ファイルのTextDocumentへWorkspaceEditを適用してから標準saveを行います。
 * これにより、VS Code／Cursorが本ツール自身の保存を「ディスク上の外部変更」と
 * 誤認して「ファイルが変更されています」と警告する経路を防ぎます。
 */
class EditableComparisonProvider {
    emitter = new vscode.EventEmitter();
    watchers = new Set();
    sourceTextAtLastRead = new Map();
    pendingSourceWrites = new Map();
    safeWriteHandler;
    onDidChangeFile = this.emitter.event;
    setSafeWriteHandler(handler) {
        this.safeWriteHandler = handler;
    }
    createUri(identity, _side) {
        return vscode.Uri.from({
            scheme: exports.EDITABLE_SCHEME,
            authority: 'source',
            path: displayPath(identity),
            query: `source=${encodeSource(identity.uri)}`,
        });
    }
    sourceUri(uri) {
        return uri.scheme === exports.EDITABLE_SCHEME ? decodeSource(uri) : uri;
    }
    isEditableUri(uri) {
        return uri.scheme === exports.EDITABLE_SCHEME;
    }
    watch(uri, _options) {
        const source = this.sourceUri(uri);
        if (typeof vscode.workspace.createFileSystemWatcher !== 'function' || typeof vscode.RelativePattern !== 'function') {
            return { dispose() { } };
        }
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(parentUri(source), baseName(source)));
        const emitUnlessInternal = async (type) => {
            if (await this.shouldSuppressPendingSourceWrite(source))
                return;
            this.sourceTextAtLastRead.delete(uri.toString(true));
            this.emitter.fire([{ type, uri }]);
        };
        const disposables = [
            watcher,
            watcher.onDidChange(() => { void emitUnlessInternal(vscode.FileChangeType.Changed); }),
            watcher.onDidCreate(() => { void emitUnlessInternal(vscode.FileChangeType.Created); }),
            watcher.onDidDelete(() => { void emitUnlessInternal(vscode.FileChangeType.Deleted); }),
        ];
        const result = vscode.Disposable.from(...disposables);
        this.watchers.add(result);
        return {
            dispose: () => {
                this.watchers.delete(result);
                result.dispose();
            },
        };
    }
    async stat(uri) {
        return vscode.workspace.fs.stat(this.sourceUri(uri));
    }
    async readDirectory(_uri) {
        return [];
    }
    async createDirectory(uri) {
        throw vscode.FileSystemError.NoPermissions(uri);
    }
    async readFile(uri) {
        const source = this.sourceUri(uri);
        const bytes = await vscode.workspace.fs.readFile(source);
        try {
            const document = await vscode.workspace.openTextDocument(source);
            this.sourceTextAtLastRead.set(uri.toString(true), document.getText());
        }
        catch {
            this.sourceTextAtLastRead.set(uri.toString(true), new TextDecoder().decode(bytes));
        }
        return bytes;
    }
    async writeFile(uri, content, _options) {
        const source = this.sourceUri(uri);
        const proxyKey = uri.toString(true);
        const nextText = new TextDecoder().decode(content);
        const sourceDocument = await vscode.workspace.openTextDocument(source);
        const currentText = sourceDocument.getText();
        const expectedSourceText = this.sourceTextAtLastRead.get(proxyKey);
        // 代理文書を開いた後に、元ファイルが別タブ・別処理で変更されていた場合は上書きしません。
        if (expectedSourceText !== undefined
            && currentText !== expectedSourceText
            && currentText !== nextText) {
            throw noPermissions((0, localization_1.t)('元ファイルが比較開始後に別の操作で変更されたため、安全のため保存しませんでした。比較を更新してください。'), source);
        }
        const apply = async () => {
            const latestDocument = await vscode.workspace.openTextDocument(source);
            const latestText = latestDocument.getText();
            if (latestText !== currentText && latestText !== nextText) {
                throw noPermissions((0, localization_1.t)('保存準備中に元ファイルが別の操作で変更されたため、安全のため保存しませんでした。比較を更新してください。'), source);
            }
            this.expectSourceWrite(source, nextText);
            if (latestText !== nextText) {
                const edit = new vscode.WorkspaceEdit();
                edit.replace(latestDocument.uri, new vscode.Range(latestDocument.positionAt(0), latestDocument.positionAt(latestText.length)), nextText);
                if (!await vscode.workspace.applyEdit(edit)) {
                    this.pendingSourceWrites.delete(source.toString(true));
                    throw noPermissions((0, localization_1.t)('元ファイルへ変更を適用できなかったため、保存しませんでした。'), source);
                }
            }
            if (sourceDocument.isDirty && !await sourceDocument.save()) {
                this.pendingSourceWrites.delete(source.toString(true));
                throw noPermissions((0, localization_1.t)('元ファイルを保存できませんでした。'), source);
            }
            this.sourceTextAtLastRead.set(proxyKey, nextText);
        };
        if (this.safeWriteHandler) {
            await this.safeWriteHandler({
                proxyUri: uri,
                sourceUri: source,
                sourceDocument,
                currentText,
                nextText,
                apply,
            });
        }
        else {
            await apply();
        }
        // 代理文書自身は、今完了したsave処理によって同じ内容を保持しています。
        // ここでonDidChangeFileを重ねて発火すると、保存直後の文書へ外部変更通知が戻り、
        // VS Code／Cursorの「ファイルが変更されています」を誘発するため発火しません。
    }
    /**
     * 代理文書の保存を元ファイルへ反映した際に発生するTextDocument変更通知を識別します。
     * 同じ全文の遅延・重複通知は有効時間内すべて内部変更として扱います。
     */
    consumeExpectedSourceTextChange(document) {
        const pending = this.pendingSourceWrites.get(document.uri.toString(true));
        if (!pending)
            return false;
        if (Date.now() > pending.expiresAt) {
            this.pendingSourceWrites.delete(document.uri.toString(true));
            return false;
        }
        return document.getText() === pending.expectedText;
    }
    async delete(uri, _options) {
        throw vscode.FileSystemError.NoPermissions(uri);
    }
    async rename(oldUri, _newUri, _options) {
        throw vscode.FileSystemError.NoPermissions(oldUri);
    }
    clear() {
        this.sourceTextAtLastRead.clear();
        this.pendingSourceWrites.clear();
    }
    dispose() {
        for (const watcher of this.watchers)
            watcher.dispose();
        this.watchers.clear();
        this.clear();
        this.emitter.dispose();
    }
    expectSourceWrite(source, expectedText) {
        const key = source.toString(true);
        const pending = {
            expectedText,
            expiresAt: Date.now() + 4000,
        };
        this.pendingSourceWrites.set(key, pending);
        setTimeout(() => {
            if (this.pendingSourceWrites.get(key) === pending)
                this.pendingSourceWrites.delete(key);
        }, 4100);
    }
    async shouldSuppressPendingSourceWrite(source) {
        const key = source.toString(true);
        const pending = this.pendingSourceWrites.get(key);
        if (!pending)
            return false;
        if (Date.now() > pending.expiresAt) {
            this.pendingSourceWrites.delete(key);
            return false;
        }
        // 有効時間だけで一律に抑止すると、その間に別アプリが行った本当の外部変更まで隠れます。
        // ディスク上の全文が本ツール自身の保存結果と一致する場合だけ内部変更として抑止します。
        try {
            const bytes = await vscode.workspace.fs.readFile(source);
            if (new TextDecoder().decode(bytes) === pending.expectedText)
                return true;
        }
        catch {
            // 読み取り不能・削除は外部変更として上位へ通知します。
        }
        this.pendingSourceWrites.delete(key);
        return false;
    }
}
exports.EditableComparisonProvider = EditableComparisonProvider;
