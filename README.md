# CC Studio

スマホから Claude Code を「思い立ったら即」使うための、**自前ホスト型 Claude 専用ワークベンチ（cc-web）を
ネイティブ Android アプリの WebView でラップ**した薄いアプリ。`https://<tailnet-host>/` を
全画面で開き、Foreground Service で裏に回っても接続を維持する。通信は端末の公式 Tailscale VPN に乗る
（アプリ内 Tailscale は無し）。

UI 語彙は **Screen / スクリーン** と **Plugin / プラグイン** の2語に統一している。

## なぜ「VS Code をアプリ化」したのか

オープンソースの VS Code（code-server / Code-OSS, MIT）をわざわざ自前ホストしてアプリで包んでいるのには、
段階的な理由がある。経緯の一次資料は cc-web リポにある（下記「関連リポ」）。

1. **スマホで Claude Code を使いたい。** 公式 Remote Control（チャットのみ）と cc-hub（tmux ランチャ）に
   分断されていた起動〜操作を、1つのブラウザ画面に統合したい。→ **cc-web** は code-server に
   Anthropic 公式 Claude Code 拡張と自前の「プロジェクト選択」拡張を載せ、**フォルダを選んで開く → チャット →
   過去セッション再開**までを一画面にまとめた Claude 専用ワークベンチ。素の code-server を選んだのは
   認証・PWA・ドキュメント・既知 issue がこのエコシステム前提で厚いから。
2. **ブラウザだとモバイル特有の摩擦がある。** 自動フォーカスでソフトキーボードが暴発する／音声入力 UI の裏に
   入力欄が隠れる（"lift" 問題）／コピペがしづらい、等。これを DOM 外側から補正する MV3 拡張が
   **cc-web-helper**。
3. **致命的だったのが「裏に回ると切れる」問題。** ブラウザのタブはバックグラウンドに入ると OS が
   ソケット通信を抑制し、サーバ側で Claude のターンが走っていても VS Code が ~20 秒で切断 → ユーザーが
   慌てて「Reload Window」して実行中タスクを殺す。当初は無音オーディオを流す MediaSession ハックで凌いだが
   副作用（音声フォーカス競合・データ量）が大きい。
   → **専用 Android アプリの WebView なら Foreground Service を持てる**。これは OS への正規の
   「このプロセスを生かせ」シグナルで、ダミー音声ハックが丸ごと不要になる。これが **cc-studio** の発端。

つまり **cc-web = サーバ側（code-server + 拡張）**、**cc-studio = Android ガワ側**、と役割が分かれている。
当初は cc-web ツリー内 `vc-studio/` で着手し、`cc-studio` に改名のうえ履歴ごと独立リポへ分離した。
ブラウザ拡張(cc-web-helper)がやっていたフォーカス対策なども、**ブラウザ拡張なしで WebView に被せられる**よう
アプリ側のプラグイン土台へ移しつつある。

## 機能

- **接続維持** — `KeepAliveService`（Foreground Service + 常駐通知）で、裏／画面オフでも WebSocket を生かす。
  ブラウザのタブで起きていた「裏に回ると実行中ターンが切れる」問題の根本対策（無音オーディオ不要）。
- **Screens（複数スクリーンの切替）** — 別フォルダで開いた複数の VS Code を「スクリーン」として
  **生きたまま並行保持**し、ブラウザのタブグリッドのように切り替える。
  - 左端の `⋮` から**全画面オーバービュー**（switcher）を開く。各スクリーンは**フォルダ名＋パスの帯**で並ぶ
    （サムネは持たない）。
  - **タップで切替（そのまま）／⟳ でリロードして起動／左スワイプで2段階削除**。リロードは実行中の中断を
    確認ダイアログで警告する。「＋ New screen」で増やす。
  - 開いていたスクリーンの URL とアクティブ位置を保存し、**再起動で復元**。既定フォルダは起動ユーザーの
    ホーム（`?folder=$HOME`）。
- **Plugins（消せないシステムスクリーン）** — プラグイン管理を窮屈なパネルでなく**全画面**で行う。
  - 各プラグインは **ON/OFF トグル・バージョン・説明（全文）・⚙ 個別設定の呼び出し口・✕ 削除**（組込みも削除可）。
  - `＋ Add plugin` で `.js` を取り込む。
- **拡張同等のプラグイン注入** — 有効なプラグインは `androidx.webkit` の `addDocumentStartJavaScript` で
  **全フレーム × document-start** に登録する（ブラウザ拡張の content script 相当）。VS Code 内のサブフレームにも
  ページ自身より先に効く。反映タイミングは**スクリーン単位のリロード**（拡張同様、登録は次ロードから効く）。
- **組込みプラグイン `keyboard-suppress`** — 自動フォーカス時に暴発する**ソフトキーボードの自動表示を抑制**
  （ユーザーが自分でタップしたフォーカスは通す）。初回起動時に取り込み既定 ON。他のプラグイン同様トグル・削除できる。
- **ダウンロード / ファイル選択** — `blob:`/`data:` を `window.CCStudio` 経由で base64 化して端末の Downloads へ保存。
  `<input type=file>` も SAF ピッカーで動く。

## 状態

- 接続維持・WebView ラップ: **実機で動作確認済み**（長時間バックグラウンドでも切断ポップなし）。
- Screens / Plugins システムスクリーン: ビルド＆ユニットテストはグリーン。**実機での総合確認は項目チェック中**
  （[docs/plans/2026-06-28-screens-and-plugins.md](docs/plans/2026-06-28-screens-and-plugins.md) のチェックリスト参照）。

## ビルド（WSL）

前提: JDK 17、Android SDK cmdline-tools。

```bash
sudo apt-get install -y openjdk-17-jdk unzip
export ANDROID_HOME="$HOME/Android/sdk"   # 永続化するなら ~/.bashrc に追記
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

ユニットテスト（純ロジック）と debug APK:

```bash
./gradlew testDebugUnitTest      # PluginMeta / ScreenUrl / ScreenState / ScreensJson
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/cc-studio-debug-<ビルド時刻>.apk
```

版数は**ビルド時刻 `yyMMdd-HHmm`** のみ（`versionName` と APK 名、︙→Plugins の build チップに出る一意ラベル）。
固定の意味版数は持たない。

端末へ入れる: 共有フォルダ上の APK をスマホからダウンロード → OS が自動インストール。または
`adb connect <tailnet-ip>:5555` で:

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
├── java/net/<tailnet>/ccstudio/
│   ├── MainActivity.kt         # 複数 WebView コンテナ・ファクトリ・switcher・プラグイン同期
│   ├── KeepAliveService.kt     # Foreground Service（接続維持）
│   ├── CcBridge.kt             # window.CCStudio（@JavascriptInterface）
│   ├── ExtensionRuntime.kt     # document-start×全フレーム注入の土台
│   ├── Screen.kt / ScreenManager.kt / ScreenStore.kt / ScreenState.kt
│   ├── ScreenUrl.kt            # ?folder= → フォルダ名/パス
│   ├── ScreensJson.kt          # switcher へ渡す JSON
│   ├── PluginStore.kt          # プラグインの取り込み・有効集合・組込み・メタ解析
│   └── PluginMeta.kt           # .js メタヘッダ解析
docs/
├── specs/   …  設計（v0.1 ラッパー / 拡張ランタイム / Screens+Plugins ほか）
├── plans/   …  実装プラン
└── design/  …  デザインモック（screens-mock.html 等。previews/ は git 追跡外）
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

## 関連リポ

- **cc-web** — サーバ側（code-server + Claude Code 拡張 + 自前プロジェクト拡張 + 設定/CSS）。
  動機と設計の一次資料: `cc-web/docs/superpowers/specs/2026-06-25-cc-web-design.md`、
  バックグラウンド切断の研究: `cc-web/docs/research/mobile-background-keepalive.md`、
  モバイル摩擦と対策: `cc-web/cc-web-helper/ARCHITECTURE.md`。
- ネットワークは Tailscale（`<tailnet-host>`）。端末の公式 Tailscale VPN にそのまま乗る。
