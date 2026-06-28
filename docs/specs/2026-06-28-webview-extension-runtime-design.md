# CC Studio: WebView 拡張ランタイム 設計

最終更新: 2026-06-28（v2: スコープ改定）
関連:
- [JS注入プラグイン機能 設計](2026-06-28-js-injection-plugin-design.md)（v0.2 の器。本書はその注入土台を作り替える）
- [キーボード抑制プラグイン 設計](2026-06-28-keyboard-suppress-plugin-design.md)（本ランタイム上の最初で唯一の機能）
- cc-web リポ `cc-web-helper`（ブラウザ拡張。判定ロジックの移植元）

> ## スコープ改定 (v2)
> 当初は「cc-web-helper を丸ごと動かす完全な拡張ランタイム（chrome.* シム / 全フレームメッセージ橋 /
> lift / copy / HUD）」を構想したが、方針を確定した:
> - **採用する**: プラグインの**土台をブラウザ拡張と同等にする**こと
>   ＝ **全フレーム×document-start の content script 注入**（`addDocumentStartJavaScript`）。
>   ユーザープラグインも組込み機能も等しくこの土台に載る（§3）。これは**実装済み**。
> - **採用しない（非ゴール）**: cc-web-helper の機能を丸ごと載せること。とくに **lift（入力欄せり上がり）は
>   WebView 側で解決済みのため不要**。`chrome.*` シム / `addWebMessageListener` 全フレーム橋 / copy / HUD /
>   manifest/actions も当面**作らない**（純DOMの機能には不要。必要になったら本書 §4・§3.1–§3.2 を将来案として参照）。
> - 現時点で土台に載る機能は **キーボード抑制（組込み・常時ON）のみ**。
>
> 以降の §3.1（chrome.* シム）/§3.2（メッセージ橋）/§4（パッケージ manifest）/§9③④ は**将来案**であり、
> v2 の実装範囲ではない。v2 で実装したのは §2.1・§3 の注入土台と §5 の反映タイミングのみ。

> 本書のスコープは **注入ランタイム土台**。Control Center（Plugins/Settings 等のUIパネル, bootstrap.js）は
> **並列セッションが担当**（UI 実装には踏み込まない）。プラグイン土台の設計は本セッションが担当する。

## 1. 背景：なぜ作り替えるか
現状の注入は `onPageFinished` で `enabledScripts().forEach { evaluateJavascript(...) }`
（[MainActivity.kt:89](../../app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt#L89)）。
`evaluateJavascript` は**メインフレームのみ**で走る。claude-code(code-server) の入力欄は
**サブフレーム（VS Code webview iframe）**に居るため、フレーム挙動へ介入するプラグインは
自前で iframe 降下→MutationObserver→ポーリングで追いかけるしかなく、**タイミング依存で flaky・
クロスオリジンフレームに届かない**。キーボード抑制が「効いたり効かなかったり」する根本原因。

ブラウザ拡張が確実なのは `all_frames:true` + `run_at:document_start` で
**全フレームの生成時にページのスクリプトより先に** content script が入るから。追いかけ不要。

## 2. 方針：cc-studio を「WebView 拡張ホスト」にする
Android WebView の AndroidX API は、拡張の content script ランタイムをほぼ再現できる:

| ブラウザ拡張 | WebView 等価物 |
| --- | --- |
| content script (`all_frames`/`document_start`) | `WebViewCompat.addDocumentStartJavaScript(webView, script, ["*"])` |
| content script ↔ background のメッセージング / `chrome.*` | `WebViewCompat.addWebMessageListener(webView, "CCStudioNative", ["*"], …)`（**全フレーム**に注入される postMessage 橋） |
| `chrome.storage` / options ページ | ネイティブ設定(SharedPreferences) ＋ 上記メッセージ橋経由の `chrome.storage` シム |
| 拡張パッケージ（manifest + bundle） | プラグインパッケージ（manifest + 単一 content.js） |

これを土台に、**プラグイン＝WebView 版 content script** と定義する。cc-web-helper の
content.js（既に all_frames 前提で書かれている）を**シム越しにほぼ無改変で丸ごと動かす**のが到達点。
以後の機能追加を「毎回ちまちま移植」から「拡張をそのまま載せる」に変える。

### 2.1 注入の二系統（拡張 content script の2側面の写像）
- **常駐型 (content)** = `addDocumentStartJavaScript`。登録すると以後の全ナビ・全フレームで自動実行。
  キーボード抑制/リフト/コピー監視などフレーム挙動に介入するもの。**大半はこれ。**
- **一回実行型 (action)** = `evaluateJavascript`。今のページに今すぐ1回（メインフレーム）。
  「最後の応答をコピー」等のボタン起点アクション。

## 3. アーキテクチャ
```
┌─ MainActivity (onCreate, loadUrl の前に土台を組む) ───────────────────────┐
│  ExtensionRuntime.install(webView):                                      │
│   1) addWebMessageListener("CCStudioNative", ["*"], NativeRouter)        │ ← 全フレーム橋
│   2) addDocumentStartJavaScript(runtimePrelude, ["*"])                   │ ← 最初に shim を定義
│   3) 有効プラグインごとに addDocumentStartJavaScript(content.js, ["*"])    │ ← prelude の後
│  （DOCUMENT_START_SCRIPT 非対応端末は §7 のフォールバックへ）              │
│  その後 webView.loadUrl(...) → 初回ロードから全フレームに document-start  │
└──────────────────────────────────────────────────────────────────────────┘
        │ register/remove(ScriptHandler)         ▲ onPostMessage / replyProxy
        ▼                                        │
┌─ ExtensionRuntime ───────────┐      ┌─ NativeRouter (メッセージ橋の受け) ───┐
│ install(webView)             │      │  settings.get/set/watch              │
│ setEnabled(name, on):        │      │  clipboard.write / read              │
│   register/remove handler    │      │  download.save (既存 saveBase64 へ)   │
│   + 有効化時は現フレーム即時   │      │  plugin.list / pick / remove (UI用)   │
│ handlers: Map<name,Handler>  │      │  → reply は replyProxy.postMessage()  │
└──────────────────────────────┘      └───────────────────────────────────────┘
        │ uses
        ▼
┌─ PluginStore (現行を拡張) ────────────────────────────────────────────────┐
│ list()/script()/enable()/remove()  … 既存                                 │
│ + manifest(name): PluginManifest?  （任意。無ければ単一JSプラグイン扱い）   │
│ + settings(name) / setSetting(name,k,v) （per-plugin 設定; SharedPreferences）│
└───────────────────────────────────────────────────────────────────────────┘

assets/
  runtime-prelude.js           # 全フレームに最初に入る。chrome.* シム + CCStudio API を定義
  plugins/cc-web-helper.js     # cc-web-helper/src を1枚にバンドルした既定プラグイン（content）
```

### 3.1 runtime-prelude.js（全フレーム・最初に実行）
役割: `CCStudioNative`（メッセージ橋）を待ち受け、その上に **`chrome.*` シム** と **`window.CCStudio` API**
を構築して、後続の content script から拡張と同じ感覚で使えるようにする。
- `chrome.storage.local/sync.get/set` → `settings.get/set`(per-plugin 名前空間) にマップ。`onChanged` は
  `settings.changed` ブロードキャストを購読。cc-web-helper の `settings.js`(loadSettings/watchSettings) が
  そのまま動く（非同期前提なので往復で問題なし。解決まで DEFAULTS を使う既存挙動を活かす）。
- `chrome.runtime.getURL` → null を返す（options ページはネイティブUIが担うため。cc-web-helper は
  null 時に ⚙ ボタンを隠す実装済み）。`chrome.runtime.id` 等は最小スタブ。
- `CCStudio.clipboard/download` → メッセージ橋へ委譲（橋はトップ/サブ全フレームにある）。
- **タイミング**: document-start で `CCStudioNative` がまだ未注入のことがあるため、prelude は
  橋オブジェクト出現を待ってから解決する小さなブートストラップにする（poll/Promise）。

### 3.2 NativeRouter（メッセージ橋の受け口, Kotlin）
`onPostMessage(view, message, sourceOrigin, isMainFrame, replyProxy)` で JSON コマンドを処理し、
`replyProxy.postMessage(jsonReply)` で返す。型:
- `settings.get {plugin}` → `{values}` / `settings.set {plugin,key,value}` → 保存し全フレームへ
  `settings.changed {plugin,values}` をブロードキャスト（`view.postWebMessageToMainFrame` 相当 + 各フレーム配信）。
- `clipboard.write {text}` / `clipboard.read` → ネイティブ ClipboardManager（サブフレームの権限問題を回避）。
- `download.save {name,mime,base64}` → 既存 `saveBase64Download` に委譲。
- `plugin.list/pick/remove` → 既存 `listPlugins/pickPlugin/removePlugin` 相当（UI 用。`window.CCStudio`
  の addJavascriptInterface 経由のままでも可。下記 3.3 参照）。

### 3.3 UI 橋（トップフレームのみ・既存維持）
Control Center パネル（bootstrap.js, トップフレーム）は同期 API が扱いやすいので、現行の
`addJavascriptInterface(CcBridge,"CCStudio")` を**そのまま維持**（`listPlugins/setEnabled/removePlugin/
pickPlugin/saveBase64`）。全フレーム橋(`CCStudioNative`)は content script 専用。2つは併存する。
> これにより並列セッションの UI 実装は橋契約を変えずに済む（§6）。

## 4. プラグインパッケージ
- **最小（現行互換）**: 単一 `.js`。manifest 無し → `{name, type:"content", all_frames:true, run_at:"document_start"}`
  を既定とみなす。今ある SAF 取り込みはそのまま使える。
- **拡張（任意）**: `manifest.json` を伴うパッケージ。フィールド:
  - `name, version, description`
  - `content_scripts: [{ js, all_frames?, run_at? }]`（既定 all_frames:true / document_start）
  - `actions: [{ id, label, js }]`（ボタン起点の一回実行型）
  - `settings_schema: [{ key, type, default, label }]`（Control Center の Settings が描画）
  - `permissions: ["clipboard","download"]`（橋コマンドの可否。当面は記録のみ）
- **既定の組込みプラグイン**: `assets/plugins/cc-web-helper.js`（cc-web-helper/src のバンドル）を
  type:content / all_frames で同梱し、初期 ON。これ1枚で 抑制＋リフト＋コピー＋HUD が揃う。

## 5. ON/OFF の反映（ブラウザの思想を踏襲＝再発明しない）
- **有効化**: prelude（未登録なら）＋当該 content の `ScriptHandler` を登録（以後のロード・全フレームで自動）。
  併せて**現在ロード済みのフレームへ一回注入**して体感を補う（ブラウザが拡張インストール時に既存タブへ
  注入するのに相当。`evaluateJavascript` はメインフレームのみなので、完全反映は次ロードから）。
- **無効化**: `ScriptHandler.remove()`。既に走ったインスタンスは次ロードまで残る（拡張と同じく走行中は剥がせない）。
- **強制 reload はしない**。UI は必要に応じ「再読込で完全反映」を示すだけ（実装は並列セッション任意）。

## 6. 並列セッション（Control Center UI）との契約
UI 側が依存してよい/すべき点を固定する:
- **橋API（UI, トップフレーム）**: `CCStudio.listPlugins()/setEnabled(name,on)/removePlugin(name)/pickPlugin()`
  は維持。`listPlugins()` の JSON に `enabled`, （あれば）`version/description/hasSettings` を含める。
- **設定**: per-plugin 設定は `settings.get/set`（橋）と SharedPreferences に集約。Settings タブはスキーマ
  （`settings_schema`）を読んでトグル/入力を描画し、`setSetting` で保存。content script へは
  `settings.changed` ブロードキャストで届く（cc-web-helper の watchSettings がそのまま反応）。
- **反映タイミングの意味論変更**（重要）: 旧「ONで即メインフレーム注入」→ 新「ONでハンドル登録＋
  現フレーム即時注入、完全反映は次ロード」。UI は ON 直後に「再読込で全画面に反映」を出すか自動 reload を
  選べる（本土台はどちらも許容）。

## 7. フォールバック / 対応端末
- 必要 feature: `DOCUMENT_START_SCRIPT`, `WEB_MESSAGE_LISTENER`。`WebViewFeature.isFeatureSupported` で判定。
- 非対応端末: 旧方式（onPageFinished + `evaluateJavascript` メインフレーム + プラグイン側の降下/observer/poll）
  に退避。プラグインは「全フレーム前提（prelude あり）」と「メインフレーム降下版」の双方で動くよう、
  自分の document への設置を最初に行い降下は冪等な保険とする（現キーボード抑制が既にこの形）。

## 8. リスクと検証項目
- **origin `["*"]` と不透明オリジン**: クロスオリジン `vscode-webview://` に加え、`srcdoc`/`blob` 由来の
  不透明オリジンフレームに document-start / web message が入るか実機検証（拡張は `match_origin_as_fallback`
  でこれを担保していた）。入らない場合の保険として降下版を残す（§7）。
- **document-start 時の DOM 未整備**: prelude / content は top-level で DOM 依存処理をしない、または
  DOMContentLoaded まで遅延する（cc-web-helper は `if(!document.body)return` 等で既に防御的）。
- **メッセージ橋の出現タイミング**: prelude は `CCStudioNative` 出現待ちにする（§3.1）。
- **cc-web-helper バンドルの取り込み**: src を1枚に束ねる手順（esbuild。cc-web-helper の scripts/package.mjs
  を流用）。リポ間結合を避けるため、生成物 `cc-web-helper.js` を cc-studio の assets に**ベンダリング**して持つ
  （更新時に再バンドル）。chrome.* シムが満たす API は cc-web-helper が実際に使う storage/runtime.getURL に限定。
- **クリップボード**: サブフレームの `navigator.clipboard` は権限/フォーカス制約が出やすいので、橋
  （ネイティブ ClipboardManager）経由を既定にする。

## 9. 段階導入（実装フェーズの目安。実装は別途）
1. **土台**: `ExtensionRuntime`（addDocumentStartJavaScript + addWebMessageListener）と `runtime-prelude.js`、
   NativeRouter（settings/clipboard/download）。既存単一JSプラグインを document-start 全フレームで動かす。
   → キーボード抑制を prelude 不要の純DOM content として最小化、flaky 解消を実機確認。
2. **設定**: per-plugin settings ＋ settings_schema ＋ `settings.changed` ブロードキャスト。
3. **cc-web-helper 丸ごと**: バンドルを既定プラグインとして同梱し、抑制＋リフト＋コピー＋HUD を一括移植。
4. **manifest/actions**: パッケージ manifest と action(ボタン起点)対応。

## 10. ゴール / 非ゴール
**ゴール**: 全フレーム×document-start の注入土台、全フレーム橋(chrome.* シム)、cc-web-helper を
シム越しに丸ごと動かせること、現行の複数プラグイン基盤・UI 橋契約との互換。
**非ゴール（当面）**: 任意拡張の無改変インストール（chrome.* の全面実装）、ストア機構、署名/権限の強制。
