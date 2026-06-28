# CC Studio: JS注入プラグイン機能 設計 (v0.2)

最終更新: 2026-06-28
前提: v0.1（WebView + Foreground Service + 接続維持）が実機で動作確認済み。
関連: cc-web リポの `cc-web-helper`（ブラウザ拡張。フォーカス/コピペ対策の元ネタ。
本機能はその対策JSをアプリの WebView に注入する形で再利用することを狙う）。

## 1. 背景と動機
v0.1 の実機検証で、接続維持は成功した一方、**コピペがほぼ効かない / 入力欄の自動フォーカスで
ソフトキーボードが出る** という Web 版と同じ課題が残った。スマホのブラウザは拡張を入れられないため
cc-web-helper をスマホで効かせられないが、**アプリの WebView は `evaluateJavascript()` で
任意のJSを注入できる**。これを使い、ユーザーが用意した対策JSを「プラグイン」として注入する。

操作UIは、cc-web-helper が画面左端に出している bridge buttons と同じ場所・見た目の `︙` メニューとし、
将来のタブ/グリッド切替もこのメニューに後付けできる入れ物にする。

## 2. 確定した判断
- **2層注入**:
  - ① アプリ同梱の **bootstrap.js** が `︙` メニューを描く（これが無いと何も選べない）。
  - ② ユーザーが選ぶ **プラグインJS**（フォーカス/コピペ対策）。①のメニューから選んで注入。
- **`︙` の位置・見た目は cc-web-helper の bridge buttons を踏襲**:
  `position:fixed; z-index:2147483647; left:0; bottom:22%`、ボタン 44×44px、
  `border-radius:0 10px 10px 0`、`background:#1e88e5`、白文字、`box-shadow:0 2px 6px rgba(0,0,0,.4)`。
- **JS↔Android 橋 = JavaScriptInterface**（`@JavascriptInterface`、注入名 `window.CCStudio`）。
- **プラグイン方式（取り込み）**: 選んだJSを即 `filesDir/plugins/active.js` にコピー。
  元ファイルが移動/削除されても無関係、再起動後も確実に読める。
- **注入は手動+自動**: メニューに [今すぐ注入]（動作確認用）と [自動注入 ON/OFF]。
  自動は `WebViewClient.onPageFinished` で active.js を毎回注入。
- 注入JSの中身は本リポでは管理しない（ユーザーが外で編集し、SAFで選ぶ）。

## 3. ゴール / 非ゴール
**ゴール (v0.2)**:
- 起動・ページ遷移のたびに bootstrap.js を注入し、左端に `︙` メニューを出す。
- `︙` メニューから: [JSプラグインを選ぶ]（SAF→filesDirにコピー）/ [今すぐ注入] / [自動注入 ON/OFF]。
- 選んだプラグインを永続化し、再起動後も読める。自動注入ONなら onPageFinished で毎回注入。

**非ゴール（当面・YAGNI）**:
- JS のアプリ内編集。
- 複数プラグインの同時併用（当面 active 1枚。器はプラグイン的に作るが運用は1枚）。
- タブ/グリッド切替（次フェーズ。同じ `︙` メニューに後付けする）。

## 4. アーキテクチャ
```
┌─ MainActivity ────────────────────────────────────────────┐
│  WebView（既存）                                            │
│   onPageFinished:                                          │
│     1) bootstrap.js を必ず注入（︙ボタンを描く）            │
│     2) PluginStore.autoInject なら active.js も注入          │
│   addJavascriptInterface(CcBridge, "CCStudio")             │
│   SAF ランチャー（registerForActivityResult）で選択を受ける │
└───────────────────────────────────────────────────────────┘
        │ uses                         ▲ @JavascriptInterface
        ▼                              │
┌─ PluginStore ──────────────┐   ┌─ CcBridge (JSから呼ばれる) ─────┐
│ installFromUri(uri)         │   │  pickPlugin()  → SAF起動         │
│   → filesDir/plugins/active │   │  injectNow()   → active.js 注入  │
│ activeScript(): String?     │   │  setAuto(b:Boolean)             │
│ autoInject get/set (prefs)  │   │  getAuto(): Boolean             │
└─────────────────────────────┘   └─────────────────────────────────┘

assets/bootstrap.js  … ︙ボタンを bridge と同じ位置に描き、タップで
                        window.CCStudio.pickPlugin() / injectNow() / setAuto() を呼ぶ。
```

### コンポーネント
- **assets/bootstrap.js**（新規）: DOMに `︙` フローティングボタンを1つ描く（既存なら再生成しない＝冪等）。
  タップで簡易メニュー（[JSプラグインを選ぶ]/[今すぐ注入]/[自動注入 ON/OFF]）を開き、各項目で
  `window.CCStudio.*` を呼ぶ。位置・見た目は §2 のCSSに従う。
- **CcBridge.kt**（新規）: `@JavascriptInterface` を持つクラス。`pickPlugin()`/`injectNow()`/
  `setAuto()`/`getAuto()`。JSスレッドから呼ばれるので、WebView操作は `Activity.runOnUiThread` で行う。
- **PluginStore.kt**（新規）: `installFromUri(uri)` が `contentResolver.openInputStream` で読み
  `filesDir/plugins/active.js` に書く。`activeScript()` がそのテキストを返す（無ければ null）。
  `autoInject` は SharedPreferences。
- **MainActivity.kt**（変更）: bootstrap注入 + bridge登録 + SAFランチャー保持 + onPageFinished注入。

### JavaScriptInterface 契約（JS から見えるAPI）
- `window.CCStudio.pickPlugin()` : SAF の `ACTION_OPEN_DOCUMENT`（MIME `application/javascript`,
  フォールバック `text/*` / `*/*`）を起動。結果は MainActivity の ActivityResult で受け、
  `PluginStore.installFromUri` を呼ぶ。成功/失敗はトースト。
- `window.CCStudio.injectNow()` : `active.js` を読み `webView.evaluateJavascript` で注入。未インストールはトースト。
- `window.CCStudio.setAuto(enabled: Boolean)` : 自動注入フラグを保存。
- `window.CCStudio.getAuto(): Boolean` : 現在のフラグ（メニューのトグル表示用）。

## 5. データフロー
1. ページ読込完了 → bootstrap.js 注入 → 左端に `︙` 出現。autoInjectなら active.js も注入。
2. `︙`タップ → メニュー → [JSプラグインを選ぶ] → `CCStudio.pickPlugin()` → SAF。
3. ファイル選択 → ActivityResult → `PluginStore.installFromUri` で `plugins/active.js` にコピー → トースト「インストールしました」。
4. [今すぐ注入] → `CCStudio.injectNow()` → active.js を evaluateJavascript。
5. [自動注入 ON] 以降は onPageFinished で毎回 active.js を注入。

## 6. エラー処理
- 未インストールで [今すぐ注入] / 自動注入 → トースト「先にJSプラグインを選んでください」、注入はスキップ。
- `openInputStream` / コピー失敗 → トースト「JSの読み込みに失敗しました」+ ログ。クラッシュさせない。
- active.js が空文字 → 何もしない。
- bootstrap.js は assets 同梱なので常に読める前提（読めなければログのみ）。
- `evaluateJavascript` のコールバックで例外文字列が来たらログ（UIは止めない）。

## 7. ファイル構成（cc-studio リポ）
```
app/src/main/
├── assets/bootstrap.js                          # 新規
├── java/net/<tailnet>/ccstudio/
│   ├── MainActivity.kt                           # 変更
│   ├── CcBridge.kt                               # 新規
│   ├── PluginStore.kt                            # 新規
│   └── KeepAliveService.kt                       # 変更なし
└── AndroidManifest.xml                           # 変更なし（新規permission不要: SAFは権限レス）
```

## 8. リスクと留意
- **JavaScriptInterface のセキュリティ**: 任意ページにブリッジを晒すと危険だが、本アプリは
  自分のtailnet上の cc-web のみを開く専用アプリなので許容。将来URLを増やすならオリジン確認を足す。
- **bootstrap.js の冪等性**: onPageFinished は複数回走り得る（リダイレクト等）。`︙` は
  「既にあれば作らない」で二重描画を防ぐ。
- **注入順序**: bootstrap → active の順。activeがbootstrapのDOMに依存しないよう、各JSは独立に冪等であること。
- **メニューの位置/見た目**: §2のCSSで cc-web-helper を踏襲するが、最終的な位置感は実機で微調整する。
