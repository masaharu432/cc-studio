# JSプラグイン選択ピッカーをチャット＋と同じUIに揃える

## 背景・問題

︙フローティングメニューの「JSプラグインを選ぶ」が開くファイル選択画面では `.js`
ファイルが選べず、写真やドキュメントしか出てこなかった。原因は `pickJs` が
`ActivityResultContracts.OpenDocument()`（`ACTION_OPEN_DOCUMENT`）を MIME フィルタ
`["application/javascript", "text/*", "*/*"]` 付きで使っているため。`ACTION_OPEN_DOCUMENT`
は MIME フィルタを厳密に適用するので、端末側で `.js` の MIME が
`text/javascript` / `application/octet-stream` / 未登録 のいずれかだとフィルタから漏れて
選択できなかった。

一方、チャット欄の＋（VS Code の `<input type="file">` → `onShowFileChooser`）は
`ACTION_GET_CONTENT` + `*/*` を使うため、Samsung One UI の「マイファイル」等の実ファイル
ブラウザが開き、JS でも ZIP でも拡張子に関係なく選べる。

## 目的

︙メニューの「JSプラグインを選ぶ」ピッカーを、チャット＋と同じシステムピッカーUIにし、
`.js` が選べるようにする。

## 変更内容

`app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt` の `pickJs`:

- コントラクトを `ActivityResultContracts.OpenDocument()` →
  `ActivityResultContracts.GetContent()` に変更（`ACTION_GET_CONTENT` を使う＝チャット＋
  と同じピッカーUIが開く）。
- 起動時引数を `arrayOf("application/javascript", "text/*", "*/*")` → `"*/*"` に変更。
- コールバックは `Uri?` のままで、`store.installFromUri(uri)` の既存処理を維持。
  `installFromUri` は `Uri` を受け取りその場で読み込んでコピーするだけなので、
  `GetContent` が永続権限を取らなくても問題ない。

## スコープ外（今回やらない）

- ZIP を選んだ場合の展開・中の `.js` 抽出。ピッカーには表示されるが、選んでも展開せず
  そのまま読み込む（JS を選ぶ運用前提）。
- チャット＋・ダウンロード経路は変更しない。

## 検証

- ビルドが通ること。
- 実機で ︙ →「JSプラグインを選ぶ」がチャット＋と同じピッカーを開き、`.js` が選べること
  （ユーザー実機確認）。
