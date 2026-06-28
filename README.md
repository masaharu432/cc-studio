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
- **組込みプラグイン `keyboard-suppress`** — 自動フォーカス時に暴発する**ソフトキーボードの自動表示を抑制**
  （ユーザーが自分でタップしたフォーカスは通す）。初回起動時に取り込み既定 ON。トグル・削除できる。
- **チャット欄のファイル添付（改善） / ダウンロード** — Claude のチャット入力欄の**添付（`<input type=file>`）**は
  素のモバイルブラウザだと不安定で開けないことがある。`WebChromeClient.onShowFileChooser` を実装して
  **Android の SAF ピッカーへ確実に接続**し、画像などを添付できるようにした。受け取り側は `blob:`/`data:` を
  `window.CCStudio` 経由で base64 化して端末の Downloads へ保存する。

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
までを冪等に行う。HTTPS は前段ホストで `tailscale serve` を一度設定する。詳細は
[server/provision/README.md](server/provision/README.md)。

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
│   ├── plugins.html            # 全画面 Plugins システムスクリーン（リッチカード）
│   └── keyboard-suppress.js    # 組込みプラグイン（自動表示抑制）
├── java/app/ccstudio/
│   ├── MainActivity.kt         # 複数 WebView コンテナ・ファクトリ・switcher・プラグイン同期
│   ├── KeepAliveService.kt     # Foreground Service（接続維持）
│   ├── CcBridge.kt             # window.CCStudio（@JavascriptInterface）
│   ├── ExtensionRuntime.kt     # document-start×全フレーム注入の土台
│   ├── Screen.kt / ScreenManager.kt / ScreenStore.kt / ScreenState.kt
│   ├── ScreenUrl.kt            # ?folder= → フォルダ名/パス
│   ├── ScreensJson.kt          # switcher へ渡す JSON
│   ├── PluginStore.kt          # プラグインの取り込み・有効集合・組込み・メタ解析
│   └── PluginMeta.kt           # .js メタヘッダ解析
server/
├── provision/   …  code-server ブリングアップ（setup.sh / 推奨設定 / 拡張 / systemd テンプレ）
└── code-server/ …  上流 code-server（submodule・無改変）
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
