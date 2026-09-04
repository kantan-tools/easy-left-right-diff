# プライバシー / Privacy

## 日本語

かんたん左右ファイル比較は、完全ローカル動作を基本とします。

### 外部へ送信しないもの

- ファイル内容
- 差分内容
- ファイル名・ファイルパス
- 利用状況
- エラー情報

製品機能としてネットワーク通信、テレメトリ、AIサービス、アカウント登録を使用しません。

### ローカルへ保存するもの

- 最近の比較：L・RのファイルURI、補助ラベル、比較モード、使用日時
- Git管理外警告の確認状態
- 復元履歴：対象ファイルURI、保存日時、理由、本ツールが変更する直前のファイル内容（Git管理状態を問いません）

最近の比較はVS Code／Cursorのワークスペース状態へ保存します。復元履歴は拡張機能用ローカルストレージへ保存します。

復元履歴は暗号化されません。秘密情報を含むファイルを扱った場合、その内容もローカルの復元履歴に含まれる可能性があります。Git・VS Codeの変更履歴は収集・保存しません。

保持上限は、同じファイル3件、全体30件、合計60MBです。上限を超えた古い情報は自動削除されます。利用者は管理画面から1件または全件を削除できます。

開発時の依存パッケージ取得やVS Codeテスト版の取得は、拡張機能を利用する製品動作とは別です。

## English

Easy Left Right Diff is designed to run locally.

### Data not transmitted

- File contents
- Diff contents
- File names and paths
- Usage activity
- Error information

Product features do not use network requests, telemetry, AI services, or account registration.

### Data stored locally

- Recent comparisons: L/R file URIs, optional labels, comparison mode, and last-used time
- Acknowledgement state for the unmanaged-file warning
- Recovery history created before extension-initiated changes, regardless of Git status: target URI, time, reason, and previous file content

Recent comparisons are stored in VS Code/Cursor workspace state. Recovery data is stored in extension-local storage.

Recovery data is not encrypted. Files containing secrets may therefore leave those contents in local recovery data.

Limits are three records per file, thirty records total, and 60 MB total. Older records beyond these limits are automatically removed. Users can delete one or all records from the management UI.

Downloading development dependencies or a VS Code test build is separate from normal extension operation.

## 対象ファイルがない復元履歴

対象ファイルの削除・置換を検出した復元履歴は、別ファイルへ誤って再接続せず、ローカルストレージ内で「対象ファイルなし」として保持します。利用者は別ファイルとして保存するか、1件ずつまたは全件を削除できます。ネットワーク送信は行いません。
