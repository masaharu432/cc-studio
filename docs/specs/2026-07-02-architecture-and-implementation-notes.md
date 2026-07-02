# CC Studio — アーキテクチャと実装メモ

README から移した設計・実装レベルの記述をまとめる。利用者向けの説明は
[README.md](../../README.md)、インストール手順は [INSTALL.md](../../INSTALL.md) を参照。

## なぜ「VS Code をアプリ化」したのか

1. **スマホで Claude Code を使いたい。** 公式 Remote Control（チャットのみ）では、フォルダを選んで開く →
   チャット → 過去セッション再開、までが一画面で完結しない。素の **code-server に Claude Code 公式拡張**を
   載せれば一画面ワークベンチになる（認証・PWA・ドキュメント・既知 issue がこのエコシステム前提で厚い）。
2. **ただしブラウザのタブには致命的な弱点がある。** バックグラウンドに入ると OS がソケット通信を抑制し、
   サーバ側で Claude のターンが走っていても VS Code が ~20 秒で切断 → ユーザーが慌てて「Reload Window」して
   実行中タスクを殺す。**専用 Android アプリの WebView なら Foreground Service を持てる** — OS への正規の
   「このプロセスを生かせ」シグナルで、無音オーディオ等のハック無しに接続を維持できる。これが cc-studio の発端。
3. **モバイル固有の摩擦も WebView の外側から補正できる。** 自動フォーカスでソフトキーボードが暴発する／
   コピペがしづらい／チャット欄のファイル添付が開けない等を、**アプリのプラグイン土台**（`window.CCStudio`
   ブリッジ＋document-start 注入）や WebView のネイティブ連携（SAF ファイルピッカー）から被せる。

つまり cc-studio は **サーバ（code-server + 公式拡張 + 推奨設定 + notify-relay）** と
**Android ガワ（接続維持・複数スクリーン・プラグイン・通知）** を 1 つに束ねている。
**上流の code-server / VS Code / Claude Code 拡張のソースコードは一切改変しない** — 修正はすべて
プラグイン（JS 注入）・独自サーバ・サーバ側設定・小さな補助拡張で外側から行う。

## プラグイン注入ランタイム

- 有効なプラグインは `androidx.webkit` の `addDocumentStartJavaScript` で**全フレーム × document-start** に
  登録する（ブラウザ拡張の content script 相当）。VS Code 内のサブフレームにもページ自身より先に効く。
  反映タイミングは**スクリーン単位のリロード**（`@setting` のトグル変更のみライブ反映）。
- 一次資料: [2026-06-28-webview-extension-runtime-design.md](2026-06-28-webview-extension-runtime-design.md)、
  [2026-06-28-js-injection-plugin-design.md](2026-06-28-js-injection-plugin-design.md)

### プラグインのメタヘッダ仕様

`.js` 先頭に userscript / ブラウザ拡張風のヘッダを書くと、Plugins 画面に名前・バージョン・説明が出る。

```js
// ==CCStudioPlugin==
// @name        my-plugin
// @version     0.1.0
// @description 何をするプラグインか（全文表示される）
// @setting     visible boolean true HUD を表示    ← ⚙ 設定画面にトグルを出す（ライブ反映）
// @run-at      document-start   // document-start（既定）| document-idle
// @all-frames  true             // true（既定）| false（トップフレームのみ）
// ==/CCStudioPlugin==
```

一次資料: [2026-06-28-plugin-manifest-design.md](2026-06-28-plugin-manifest-design.md)

## 個別機能の実装メモ

- **keyboard-suppress** — VS Code webview は `document.open()/write()` で中身を書き換える際に
  document-start で張ったリスナを消すため、設置済みフラグを `documentElement` に付けて**書き換えのたびに
  張り直す**。スクロールは touchstart 後 10px 超の移動で判定して blur。キーボード拒否は繰り返し blur ではなく
  `inputmode="none"` ＋ ワンショット blur（フォーカス取り合いの回避）。
  設計: [2026-06-28-keyboard-suppress-plugin-design.md](2026-06-28-keyboard-suppress-plugin-design.md)
- **chat-link-open** — チャット本文フレームには VS Code の api が無いため、webview 本体フレーム
  （`__vscode_post_message__` を持つ枠）へ **BroadcastChannel**（`cc-clo`）で橋渡しして拡張ホストの
  `open_file` を送る。
- **コピー（selectable-text / region-grab）** — Android WebView のネイティブ選択（ActionMode）は
  code-server の webview iframe 内では発火しない（CSS `user-select` 解放でも JS `Selection` API でも
  呼び出せない）。そのため長押しの `contextmenu` を iframe 内でだけ横取りして独自「⧉ コピー」ボタンを
  出す方式（selectable-text）と、ネイティブ選択を使わず矩形内の DOM テキストを収集する方式
  （region-grab）の 2 系統を用意。クリップボード書き込みはトップフレーム（secure context）に集約し、
  `navigator.clipboard.writeText` → 隠し textarea + `execCommand('copy')` の順でフォールバック。
  Kotlin 側（ClipboardManager）は使っていない。
  設計: [2026-06-29-selectable-text-design.md](2026-06-29-selectable-text-design.md)、
  [2026-06-29-region-grab-design.md](2026-06-29-region-grab-design.md)
- **Markdown / HTML のタブ内プレビュー既定** — `workbench.editorAssociations` で `*.md` →
  `vscode.markdown.preview.editor`、`*.html` → `aios.htmlPreview`（カスタムエディタ。Live Preview は
  `ViewColumn.Beside` 固定で横分割になるため不採用）。ただしチャットのリンクは Claude Code 拡張の
  `open_file` が `showTextDocument`（テキスト固定）で開くため `editorAssociations` を無視する。
  webview 内の injected JS からは関連付けを尊重した open を叩けない（web の code-server では
  `code-oss://` 系 URI が `isSupportedLink` の web ゲートで弾かれ、`command:` も無効）。そこで:
  - `.md` → 極小拡張 **cc-open**（[server/provision/cc-open](../../server/provision/cc-open)）が
    「テキストで開かれた `.md` を `toggleEditorType` で同じタブのままプレビューへ切替」える。
    設定 `cc-open.autoPreview.markdown`（既定 ON）。
  - `.html` → 拡張 **kyledunne.aios-html-auto-preview** が同様に自動プレビュー化。
    設定 `htmlPreview.enabled`（既定 ON）／ コマンド `AIOS: Toggle HTML Auto-Preview`。
- **外部リンクを外部ブラウザへ** — `WebViewClient.shouldOverrideUrlLoading` で workbench（code-server）
  以外のホストへのナビゲーションを横取りし、Android の `Intent`（既定ブラウザ）へ渡す。拡張では実現不可 —
  外部 URI を別アプリで開くのは Android OS の領分で、サーバ側の拡張ホストからは端末の別アプリを起動できない。
- **ダウンロード** — `blob:`/`data:` URL は `window.CCStudio` 経由でチャンク分割 base64 化して端末の
  Downloads へ保存（bootstrap.js のフック + `MainActivity.downloadBegin/Chunk/End`）。素の http(s) は
  Android の DownloadManager。
- **通知（notify-relay）** — Claude Code の user スコープ hooks（`Stop` / `Notification`）が
  `http://127.0.0.1:8770/cc-notify` へ POST → `server/notify-relay/relay.mjs` が WebSocket で配信 →
  アプリの `KeepAliveService` が `wss://<host>/cc-notify/ws` を購読して OS 通知を出す。
  表示中スクリーンと同じ cwd のイベントは抑制（`NotifyDecision`）。同じエンドポイントが
  state-observer の永続ログ（`type:"cc-observer"` バッチ）も受けて `data/observer.jsonl` に追記する。
  設計: [2026-06-30-session-state-observer-design.md](2026-06-30-session-state-observer-design.md)、
  [2026-07-01-observer-log-persistence-design.md](2026-07-01-observer-log-persistence-design.md)、
  [2026-07-02-observer-log-server-phase2-design.md](2026-07-02-observer-log-server-phase2-design.md)

## code-server の入手方法（submodule は使わない）

インストールは公式のプレビルド配布（`code-server.dev/install.sh --method standalone`）を使う。
リポジトリ同梱の [`server/code-server/`](../../server/code-server) submodule は開発中に上流ソースを
読むための参照として置いているだけで、そこからビルドはしない。pin と稼働バージョンが別物である経緯は
[../notes/2026-06-29-vscode-source-and-version-findings.md](../notes/2026-06-29-vscode-source-and-version-findings.md)。

## リポジトリ構成

```
app/src/main/
├── assets/
│   ├── bootstrap.js            # ⋮ ボタンを描く（タップで switcher を開く）+ ダウンロードフック
│   ├── switcher.html           # 全画面 Screens 切替（フォルダ帯リスト・スワイプ削除・リロード確認）
│   ├── plugins.html            # 全画面 Plugins システムスクリーン（リッチカード）
│   ├── plugin-settings.html    # プラグイン個別設定（@setting トグル・ライブ反映）
│   ├── notify.html             # 通知設定（種類ごと ON/OFF）
│   └── log.html                # 観測ログビューア（↻ 更新・⬇ ダウンロード）
├── java/app/ccstudio/
│   ├── MainActivity.kt         # 複数 WebView コンテナ・ファクトリ・switcher・プラグイン同期
│   ├── KeepAliveService.kt     # Foreground Service（接続維持・通知 WS 購読・ログアップロード）
│   ├── KeepAliveText.kt / NotifyState.kt / NotifyDecision.kt / NotifyPrefs.kt
│   ├── CcBridge.kt             # window.CCStudio（@JavascriptInterface）
│   ├── ExtensionRuntime.kt     # document-start×全フレーム注入の土台
│   ├── Screen.kt / ScreenManager.kt / ScreenStore.kt / ScreenState.kt
│   ├── ScreenUrl.kt            # ?folder= → フォルダ名/パス
│   ├── ScreensJson.kt          # switcher へ渡す JSON
│   ├── PluginStore.kt / PluginMeta.kt / PluginSettings.kt
│   └── ObserverLogStore.kt / ObserverRecord.kt / UploadDelta.kt   # 観測ログ永続化
plugins/        …  同梱プラグイン（8 本。README の一覧参照）。＋ Add plugin で取り込む
server/
├── provision/   …  code-server ブリングアップ（setup.sh / 推奨設定 / 拡張 / cc-open / 通知 / systemd テンプレ）
├── notify-relay/…  通知ブロードキャスト + 観測ログ収集サーバ（relay.mjs, :8770）
└── code-server/ …  上流 code-server（submodule・無改変）。開発時にソースを読むための参照のみ
.claude/skills/vsserver/   …  サーバ起動を駆動するリポ同梱スキル
scripts/check-clean.sh     …  公開前に個人情報の混入を検出するガード
docs/
├── specs/   …  設計（本ドキュメント / ラッパー / 拡張ランタイム / Screens+Plugins / サーバ ほか）
├── plans/   …  実装プラン
├── notes/   …  調査ノート
└── design/  …  デザインモック（previews/ は git 追跡外）
```

## 版数

固定の意味版数は持たない。`versionName` はビルド時刻 `yyMMdd-HHmm`（APK 名・︙→Plugins の build チップに
出る一意ラベル）、`versionCode` は epoch 分（単調増加なので上書きインストールが常に通る）。
