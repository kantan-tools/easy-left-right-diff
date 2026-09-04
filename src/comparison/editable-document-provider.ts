import * as vscode from 'vscode';
import type { ComparisonSide, FileIdentity } from '../shared-types';
import { t } from '../localization';

export const EDITABLE_SCHEME = 'easy-left-right-diff-editable';

interface PendingSourceWrite {
  readonly expectedText: string;
  readonly expiresAt: number;
}

export interface EditableWriteRequest {
  readonly proxyUri: vscode.Uri;
  readonly sourceUri: vscode.Uri;
  readonly sourceDocument: vscode.TextDocument;
  readonly currentText: string;
  readonly nextText: string;
  readonly apply: () => Promise<void>;
}

export type EditableSafeWriteHandler = (request: EditableWriteRequest) => Promise<void>;

function encodeSource(uri: vscode.Uri): string {
  return encodeURIComponent(uri.toString());
}

function decodeSource(uri: vscode.Uri): vscode.Uri {
  const params = new URLSearchParams(uri.query);
  const serialized = params.get('source');
  if (!serialized) throw vscode.FileSystemError.FileNotFound(uri);
  // URLSearchParamsが外側のエンコードを1回だけ戻します。
  // ここで再度decodeURIComponentすると、ファイル名に含まれる%20等を空白へ誤変換するため行いません。
  return vscode.Uri.parse(serialized, true);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function displayPath(identity: FileIdentity): string {
  const workspace = identity.workspaceName ?? t('ワークスペース外');
  const path = identity.outsideWorkspace ? identity.uri.fsPath : identity.relativePath;
  return `/${workspace}/${normalizePath(path)}`;
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  const path = uri.path.replace(/\/+$/, '');
  const index = path.lastIndexOf('/');
  return uri.with({ path: index > 0 ? path.slice(0, index) : '/', query: '', fragment: '' });
}

function baseName(uri: vscode.Uri): string {
  const path = uri.path.replace(/\/+$/, '');
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}

function noPermissions(message: string, uri: vscode.Uri): Error {
  const unavailable = (vscode.FileSystemError as typeof vscode.FileSystemError & {
    Unavailable?: (messageOrUri?: string | vscode.Uri) => Error;
  }).Unavailable;
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
export class EditableComparisonProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly watchers = new Set<vscode.Disposable>();
  private readonly sourceTextAtLastRead = new Map<string, string>();
  private readonly pendingSourceWrites = new Map<string, PendingSourceWrite>();
  private safeWriteHandler: EditableSafeWriteHandler | undefined;
  public readonly onDidChangeFile = this.emitter.event;

  public setSafeWriteHandler(handler: EditableSafeWriteHandler | undefined): void {
    this.safeWriteHandler = handler;
  }

  public createUri(identity: FileIdentity, _side: ComparisonSide): vscode.Uri {
    return vscode.Uri.from({
      scheme: EDITABLE_SCHEME,
      authority: 'source',
      path: displayPath(identity),
      query: `source=${encodeSource(identity.uri)}`,
    });
  }

  public sourceUri(uri: vscode.Uri): vscode.Uri {
    return uri.scheme === EDITABLE_SCHEME ? decodeSource(uri) : uri;
  }

  public isEditableUri(uri: vscode.Uri): boolean {
    return uri.scheme === EDITABLE_SCHEME;
  }

  public watch(uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
    const source = this.sourceUri(uri);
    if (typeof vscode.workspace.createFileSystemWatcher !== 'function' || typeof vscode.RelativePattern !== 'function') {
      return { dispose() {} };
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(parentUri(source), baseName(source)));
    const emitUnlessInternal = async (type: vscode.FileChangeType): Promise<void> => {
      if (await this.shouldSuppressPendingSourceWrite(source)) return;
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

  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return vscode.workspace.fs.stat(this.sourceUri(uri));
  }

  public async readDirectory(_uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return [];
  }

  public async createDirectory(uri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const source = this.sourceUri(uri);
    const bytes = await vscode.workspace.fs.readFile(source);
    try {
      const document = await vscode.workspace.openTextDocument(source);
      this.sourceTextAtLastRead.set(uri.toString(true), document.getText());
    } catch {
      this.sourceTextAtLastRead.set(uri.toString(true), new TextDecoder().decode(bytes));
    }
    return bytes;
  }

  public async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const source = this.sourceUri(uri);
    const proxyKey = uri.toString(true);
    const nextText = new TextDecoder().decode(content);
    const sourceDocument = await vscode.workspace.openTextDocument(source);
    const currentText = sourceDocument.getText();
    const expectedSourceText = this.sourceTextAtLastRead.get(proxyKey);

    // 代理文書を開いた後に、元ファイルが別タブ・別処理で変更されていた場合は上書きしません。
    if (
      expectedSourceText !== undefined
      && currentText !== expectedSourceText
      && currentText !== nextText
    ) {
      throw noPermissions(
        t('元ファイルが比較開始後に別の操作で変更されたため、安全のため保存しませんでした。比較を更新してください。'),
        source,
      );
    }

    const apply = async (): Promise<void> => {
      const latestDocument = await vscode.workspace.openTextDocument(source);
      const latestText = latestDocument.getText();
      if (latestText !== currentText && latestText !== nextText) {
        throw noPermissions(
          t('保存準備中に元ファイルが別の操作で変更されたため、安全のため保存しませんでした。比較を更新してください。'),
          source,
        );
      }

      this.expectSourceWrite(source, nextText);
      if (latestText !== nextText) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          latestDocument.uri,
          new vscode.Range(
            latestDocument.positionAt(0),
            latestDocument.positionAt(latestText.length),
          ),
          nextText,
        );
        if (!await vscode.workspace.applyEdit(edit)) {
          this.pendingSourceWrites.delete(source.toString(true));
          throw noPermissions(t('元ファイルへ変更を適用できなかったため、保存しませんでした。'), source);
        }
      }

      if (sourceDocument.isDirty && !await sourceDocument.save()) {
        this.pendingSourceWrites.delete(source.toString(true));
        throw noPermissions(t('元ファイルを保存できませんでした。'), source);
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
    } else {
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
  public consumeExpectedSourceTextChange(document: vscode.TextDocument): boolean {
    const pending = this.pendingSourceWrites.get(document.uri.toString(true));
    if (!pending) return false;
    if (Date.now() > pending.expiresAt) {
      this.pendingSourceWrites.delete(document.uri.toString(true));
      return false;
    }
    return document.getText() === pending.expectedText;
  }

  public async delete(uri: vscode.Uri, _options: { readonly recursive: boolean }): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  public async rename(
    oldUri: vscode.Uri,
    _newUri: vscode.Uri,
    _options: { readonly overwrite: boolean },
  ): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }

  public clear(): void {
    this.sourceTextAtLastRead.clear();
    this.pendingSourceWrites.clear();
  }

  public dispose(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers.clear();
    this.clear();
    this.emitter.dispose();
  }

  public expectSourceWrite(source: vscode.Uri, expectedText: string): void {
    const key = source.toString(true);
    const pending: PendingSourceWrite = {
      expectedText,
      expiresAt: Date.now() + 4000,
    };
    this.pendingSourceWrites.set(key, pending);
    setTimeout(() => {
      if (this.pendingSourceWrites.get(key) === pending) this.pendingSourceWrites.delete(key);
    }, 4100);
  }

  private async shouldSuppressPendingSourceWrite(source: vscode.Uri): Promise<boolean> {
    const key = source.toString(true);
    const pending = this.pendingSourceWrites.get(key);
    if (!pending) return false;
    if (Date.now() > pending.expiresAt) {
      this.pendingSourceWrites.delete(key);
      return false;
    }

    // 有効時間だけで一律に抑止すると、その間に別アプリが行った本当の外部変更まで隠れます。
    // ディスク上の全文が本ツール自身の保存結果と一致する場合だけ内部変更として抑止します。
    try {
      const bytes = await vscode.workspace.fs.readFile(source);
      if (new TextDecoder().decode(bytes) === pending.expectedText) return true;
    } catch {
      // 読み取り不能・削除は外部変更として上位へ通知します。
    }
    this.pendingSourceWrites.delete(key);
    return false;
  }
}
