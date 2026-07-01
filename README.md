# CC Studio

スマホから Claude Code を「思い立ったら即」使うための、**自前ホストの Claude 専用ワークベンチを
丸ごと束ねた単独アプリ**。土台はオープンソースの VS Code サーバ（code-server / Code-OSS, MIT）と
Anthropic 公式の Claude Code 拡張で、これを**ネイティブ Android アプリの WebView で包み**、モバイルで
使うと顔を出す公式ソースの不具合（裏で接続が切れる／自動でキーボードが暴発する 等）を**アプリ側で回収・
改善**する。

UI 語彙は **Screen / スクリーン** と **Plugin / プラグイン** の2語に統一している。

## なぜ「VS Code をアプリ化」したのか

1. **スマホで Claude Code を使いたい。** 公式 Remote Control（チャットのみ）では、フォルダを選んで開く →
   チャット → 過去セッション再開、までが一画面で完結しない。素の **code-server に Claude Code 公式拡張**を
   載せれば一画面ワークベンチになる（認証・PWA・ドキュメント・既知 issue がこのエコシステム前提で厚い）。
2. **ただしブラウザのタブには致命的な弱点がある。** バックグラウンドに入ると OS がソケット通信を抑制し、
   サーバ側で Claude のターンが走っていても VS Code が ~20 秒で切断 → ユーザーが慌てて「Reload Window」して
   実行中タスクを殺す。**専用 Android アプリの WebView なら Foreground Service を持てる** — OS への正規の
   「このプロセスを生かせ」シグナルで、無音オーディオ等のハック無しに接続を維持できる。これが cc-studio の発端。
3. **モバイル固有の摩擦も WebView の外側から補正できる。** 自動フォーカスでソフトキーボードが暴発する／
   コピペがしづらい／**チャット欄のファイル添付が開けない**等を、**アプリのプラグイン土台**（`window.CCStudio`
   ブリッジ＋document-start 注入）や WebView のネイティブ連携（SAF ファイルピッカー）から被せる。

つまり cc-studio は **サーバ（code-server + 公式拡張 + 推奨設定）** と **Android ガワ（接続維持・複数スクリーン・
プラグイン）** を 1 つに束ねている。サーバ側のセットアップは [`server/provision/`](server/provision/) に同梱。

## 機能

- **接続維持** — `KeepAliveService`（Foreground Service + 常駐通知）で、裏／画面オフでも WebSocket を生かす。
  ブラウザのタブで起きていた「裏に回ると実行中ターンが切れる」問題の根本対策（無音オーディオ不要）。
- **Screens（複数スクリーンの切替）** — 別フォルダで開いた複数の VS Code を「スクリーン」として
  **生きたまま並行保持**し、ブラウザのタブグリッドのように切り替える。
  - 左端の `⋮` から**全画面オーバービュー**（switcher）を開く。各スクリーンは**フォルダ名＋パスの帯**で並ぶ。
  - **タップで切替／⟳ でリロードして起動／左スワイプで2段階削除**。リロードは実行中の中断を確認ダイアログで警告。
    「＋ New screen」で増やす。
  - 開いていたスクリーンの URL とアクティブ位置を保存し、**再起動で復元**。既定フォルダは起動ユーザーのホーム。
- **Plugins（消せないシステムスクリーン）** — プラグイン管理を窮屈なパネルでなく**全画面**で行う。
  - 各プラグインは **ON/OFF トグル・バージョン・説明（全文）・⚙ 個別設定の呼び出し口・✕ 削除**（組込みも削除可）。
  - `＋ Add plugin` で `.js` を取り込む。
- **拡張同等のプラグイン注入** — 有効なプラグインは `androidx.webkit` の `addDocumentStartJavaScript` で
  **全フレーム × document-start** に登録する（ブラウザ拡張の content script 相当）。VS Code 内のサブフレームにも
  ページ自身より先に効く。反映タイミングは**スクリーン単位のリロード**。
- **同梱プラグイン（[`plugins/`](plugins/)）** — モバイル特有の使いにくさを潰す `.js` を同梱。`＋ Add plugin` で取り込む:
  - **`keyboard-suppress`** — **チャット入力欄・テキストエディタ（monaco）への自動フォーカスで暴発するソフトキーボードを抑制**。
    「自動で出る」のを止め、**入力欄／エディタを“タップ”した時だけ**キーボードを出す。判定は座標ベース:
    タップ位置がその入力欄の枠内なら許可（コンテナ/プレースホルダ余白も吸収）、**新セッションの「+」やファイルを開く操作・
    スクロール（ドラッグ）は許可しない**ので、キーボードは出ない。単行の検索/リネーム欄には触らない。
    実装メモ: VS Code webview は `document.open()/write()` で中身を書き換える際に document-start で張ったリスナを消すため、
    設置済みフラグを `documentElement` に付けて**書き換えのたびに張り直す**。スクロールは touchstart 後 10px 超の移動で判定して blur。
  - **`session-list-readable`** — Claude Code 公式拡張の**セッション一覧のタイトルがモバイルで途切れて読めない**問題を、
    **フォント縮小＋最大2行折返し**で読めるようにする（クラス名に依存せず相対時刻を手掛かりに行を特定し、見た目だけ上書き）。
  - **`focus-hud`** — どの要素／フレームにフォーカス・タップが入ったかを画面上部に時系列表示する診断オーバーレイ（スクショ共有用）。
  - **`chat-link-open`** — チャットの返信に出る**ファイルリンク**（例 `foo.md` / `src/bar.ts`）のタップを横取りし、
    真っ白／Not found にせず**エディタのタブで開く**。チャット本文フレームには VS Code の api が無いため、
    webview 本体フレーム（`__vscode_post_message__` を持つ枠）へ **BroadcastChannel** で橋渡しして拡張ホストの
    `open_file` を送る。`.md` のプレビュー化はサーバ側の **`cc-open`** 拡張、`.html` は **`aios-html-auto-preview`** 拡張が担当（下記「Markdown / HTML …」）。
- **チャット欄のファイルアップ（添付）／ダウンロード（改善）** — Claude のチャット入力欄の**添付（`<input type=file>`）**は
  素のモバイルブラウザだと不安定で開けないことがある。`WebChromeClient.onShowFileChooser` を実装して
  **Android の SAF ピッカーへ確実に接続**し、画像などを**アップロード（添付）**できるようにした。**ダウンロード**側は
  `blob:`/`data:` を `window.CCStudio` 経由で base64 化して端末の Downloads へ保存する。
- **外部リンクは外部ブラウザで開く** — チャットの調査結果やホームページなどの**外部 http(s) リンク**を
  タップすると、アプリ内 WebView で開いて workbench を離れてしまい、戻るとリロードになる。そこで
  `WebViewClient.shouldOverrideUrlLoading` で **workbench（code-server）以外のホストへのナビゲーションを横取りし、
  Android の `Intent`（既定ブラウザ）へ渡す**。workbench 内の遷移はそのままアプリ内。
  （拡張では実現不可 — 外部 URI を別アプリで開くのは Android OS の領分で、サーバ側の拡張ホストからは端末の別アプリを起動できないため。）
- **Markdown / HTML をタブ内プレビュー既定で開く** — Claude Code がソースを編集するので、その**レンダリング結果**を
  すぐ確認したい。だが VS Code 標準のプレビュー（特に Live Preview）は**横分割**で開き、小さなスマホ画面に収まらない。
  そこで `*.md`・`*.html` を**分割せず同じタブグループにフルサイズで開く**よう code-server 側で設定する
  （[server/provision/settings.json](server/provision/settings.json) の `editorAssociations`。
  HTML はタブ内表示できるカスタムエディタ拡張 `aios.htmlPreview` を使う）。
  さらに、**チャットのリンクから開いた `.md`／`.html` もプレビューになる**よう、種類ごとに補助拡張を入れる。
  チャットのリンクは Claude Code 拡張の `open_file` が `showTextDocument`（テキスト固定）で開くため
  `editorAssociations` を無視する。webview 内の injected JS からは関連付けを尊重した open を叩けない
  （web の code-server では `code-oss://` 系 URI が `isSupportedLink` の web ゲートで弾かれ、`command:` も無効）。そこで:
  - **`.md`** → 極小拡張 **`cc-open`**（[server/provision/cc-open](server/provision/cc-open)）が「テキストで開かれた `.md` を
    `toggleEditorType` で**同じタブのままプレビューへ切替**」える。ON/OFF は設定 `cc-open.autoPreview.markdown`（既定 ON）。
  - **`.html`** → 専用拡張 **`kyledunne.aios-html-auto-preview`** が同様に自動プレビュー化する。
    ON/OFF は設定 `htmlPreview.enabled`（既定 ON）／ コマンド `AIOS: Toggle HTML Auto-Preview`。

## 状態

- 接続維持・WebView ラップ: **実機で動作確認済み**（長時間バックグラウンドでも切断ポップなし）。
- Screens / Plugins システムスクリーン: ビルド＆ユニットテストはグリーン。**実機での総合確認は項目チェック中**
  （[docs/plans/2026-06-28-screens-and-plugins.md](docs/plans/2026-06-28-screens-and-plugins.md) のチェックリスト参照）。

## サーバ側（code-server）の用意

アプリが開くワークベンチ（code-server + Claude Code 拡張 + 推奨設定）は 1 コマンドで用意できる:

```bash
./server/provision/setup.sh
```

install → `config.yaml` 生成 → systemd ユーザサービス常駐 → 推奨 User 設定の非破壊 merge → 拡張インストール、
までを冪等に行う。詳細は [server/provision/README.md](server/provision/README.md)。

**インストールは公式のプレビルド配布を使う**（Microsoft の VS Code をパッケージした、今動いている方法）。
`setup.sh` は `code-server.dev/install.sh --method standalone` で**プレビルド release を取得**する
（[server/provision/setup.sh](server/provision/setup.sh)）。リポジトリ同梱の [`server/code-server/`](server/code-server)
**submodule はこのインストールには使わない** — 開発中に上流ソースを読むための参照として置いているだけで、
そこからビルドはしない（pin と稼働バージョンが別物である経緯は
[docs/notes/2026-06-29-vscode-source-and-version-findings.md](docs/notes/2026-06-29-vscode-source-and-version-findings.md)）。

**HTTPS 必須** — **Claude Code 公式拡張は HTTPS でないと機能が正常に動かない**（セキュアコンテキスト前提）。
素の HTTP で開かず、前段ホストで `tailscale serve` を一度設定して **HTTPS 経由で開く**:

```bash
tailscale serve --bg 127.0.0.1:8088   # → https://<your-tailnet-host>/
```

WSL の場合 `tailscale serve` は Windows 側で実行する。

## ビルド（WSL）

前提: JDK 17、Android SDK cmdline-tools。

```bash
sudo apt-get install -y openjdk-17-jdk unzip
export ANDROID_HOME="$HOME/Android/sdk"   # 永続化するなら ~/.bashrc に追記
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

アプリが既定で開くワークベンチ URL は**コミットしない**。`local.properties`（gitignore 済み）に各自書く:

```properties
ccstudio.targetUrl=https://<your-tailnet-host>/?folder=/path/to/open
```

未設定なら `https://localhost/` にフォールバックする。ユニットテストと debug APK:

```bash
./gradlew testDebugUnitTest      # PluginMeta / ScreenUrl / ScreenState / ScreensJson
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/cc-studio-debug-<ビルド時刻>.apk
```

版数は**ビルド時刻 `yyMMdd-HHmm`** のみ（`versionName` と APK 名、︙→Plugins の build チップに出る一意ラベル）。
固定の意味版数は持たない。

端末へ入れる: 共有フォルダ上の APK をスマホからダウンロード → OS が自動インストール。または `adb install -r ...`:

```bash
adb install -r app/build/outputs/apk/debug/cc-studio-debug-*.apk
```

## 構成

```
app/src/main/
├── assets/
│   ├── bootstrap.js            # ⋮ ボタンを描く（タップで switcher を開く）+ ダウンロードフック
│   ├── switcher.html           # 全画面 Screens 切替（フォルダ帯リスト・スワイプ削除・リロード確認）
│   └── plugins.html            # 全画面 Plugins システムスクリーン（リッチカード）
├── java/app/ccstudio/
│   ├── MainActivity.kt         # 複数 WebView コンテナ・ファクトリ・switcher・プラグイン同期
│   ├── KeepAliveService.kt     # Foreground Service（接続維持）
│   ├── CcBridge.kt             # window.CCStudio（@JavascriptInterface）
│   ├── ExtensionRuntime.kt     # document-start×全フレーム注入の土台
│   ├── Screen.kt / ScreenManager.kt / ScreenStore.kt / ScreenState.kt
│   ├── ScreenUrl.kt            # ?folder= → フォルダ名/パス
│   ├── ScreensJson.kt          # switcher へ渡す JSON
│   ├── PluginStore.kt          # プラグインの取り込み・有効集合・メタ解析
│   └── PluginMeta.kt           # .js メタヘッダ解析
plugins/        …  同梱プラグイン（keyboard-suppress / session-list-readable / focus-hud）。＋ Add plugin で取り込む
server/
├── provision/   …  code-server ブリングアップ（setup.sh / 推奨設定 / 拡張 / systemd テンプレ）
└── code-server/ …  上流 code-server（submodule・無改変）。開発時にソースを読むための参照のみ。
                    インストールには使わず、実体は公式プレビルド release（standalone）を入れる
.claude/skills/vsserver/   …  サーバ起動を駆動するリポ同梱スキル
scripts/check-clean.sh     …  公開前に個人情報の混入を検出するガード
docs/
├── specs/   …  設計（ラッパー / 拡張ランタイム / Screens+Plugins / サーバ・ブリングアップ ほか）
├── plans/   …  実装プラン
└── design/  …  デザインモック（previews/ は git 追跡外）
```

## 使い方

- **スクリーンを増やす/切り替える**: 左端 `⋮` → switcher。`＋ New screen` で新規（既定フォルダで開く）。
  VS Code 側で目的のフォルダを開けば、そのスクリーンの見出し（フォルダ名）が変わる。帯タップで切替、
  `⟳` でリロード反映、左スワイプ→`削除`で閉じる。
- **プラグインを入れる**: `⋮` → switcher 下部 SYSTEM の **Plugins** → `＋ Add plugin` で `.js` を選ぶ。
  トグルで ON にしたら、switcher に戻り反映したいスクリーンを `⟳` でリロード（実行中スクリーンはそのまま）。

### プラグインのメタヘッダ

`.js` 先頭に userscript / ブラウザ拡張風のヘッダを書くと、一覧に名前・バージョン・説明が出る。

```js
// ==CCStudioPlugin==
// @name        my-plugin
// @version     0.1.0
// @description 何をするプラグインか（全文表示される）
// @settings    true            // ⚙ 設定ボタンを出す（設定の実体は将来フェーズ）
// @run-at      document-start   // document-start（既定）| document-idle
// @all-frames  true             // true（既定）| false（トップフレームのみ）
// ==/CCStudioPlugin==
```

## ネットワーク

通信は端末の公式 Tailscale VPN に乗る（アプリ内 Tailscale は無し）。サーバは tailnet ホスト上の
code-server で、HTTPS は `tailscale serve` が前段に立つ。
