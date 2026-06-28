# CC Studio: キーボード抑制プラグイン 設計

最終更新: 2026-06-28（v2: 組込み化 + document-start 全フレーム注入）
関連: [WebView 拡張ランタイム 設計](2026-06-28-webview-extension-runtime-design.md)（注入土台）/
[JS注入プラグイン機能 設計](2026-06-28-js-injection-plugin-design.md) / cc-web リポの `cc-web-helper`（移植元）。

## 1. 背景
実機の課題: claude-code チャットは、ページ読込／送信後／遷移／**タブ切替**のたびに入力欄へ
**プログラム的に自動フォーカス**する。スマホ WebView ではこれだけでソフトキーボードが毎回せり上がり、
画面が狭くなる。ユーザーが自分でタップしたとき以外はキーボードを出したくない。

判定ロジックの移植元は `cc-web-helper` の `src/focus.js`（純粋述語）と `src/content.js` の suppression 部分。

**v2 での変更**: 当初は SAF で選ぶユーザープラグイン（`active.js`）として実装し、メインフレームから
iframe を降下して追いかける方式だった。これはタイミング依存で flaky だったため、注入土台を
**全フレーム×document-start（ブラウザ拡張の content script 相当, [拡張ランタイム設計](2026-06-28-webview-extension-runtime-design.md)）**
に作り替え、本機能は **assets 同梱の組込み（常時ON）** へ移行した。

## 2. スコープ
**やること（最小）**:
- 入力欄が**プログラム的に**自動フォーカスされたら `blur()` してキーボードを抑制する。
- ユーザーが入力欄を**直接タップ**したフォーカスは通す（通常どおりキーボードを出す）。

**やらないこと（YAGNI）**:
- **キーボードリフト（入力欄のせり上がり）**: WebView 側で解決済みのため**実装しない**（cc-web-helper には
  あるが本アプリでは不要）。
- 最終応答コピー / 診断HUD / ON-OFF トグルUI。常時ON（組込み）。

## 3. 判定ルール（移植元踏襲）
- **入力欄（composer）**: `[role="textbox"][aria-multiline="true"]` に合致し、かつ
  `.monaco-editor` 配下では**ない**もの。
  - claude-code の prompt box は role=textbox / aria-multiline=true。
  - VS Code (monaco) のエディタや「検索」も同じ role を持つため `.monaco-editor` 配下を除外する
    （誤抑制の衝突回避。移植元 content.js のコメント参照）。
  - セッション rename や「Search sessions…」は単行 `<input>` で composer に合致しない＝抑制対象外。
- **タップ投票**: 直近の `pointerdown`/`touchstart`（capture）で
  - タップ時刻 `tapTime`
  - タップ先が composer だったか `tapWasComposer`
  を当該 document に記録する。
- **許可判定** `tapAllows`: `tapWasComposer == true` かつ `now - tapTime < 700ms` のときだけ true。
  - focusin で投票を**1回だけ消費**する（古い投票が後続のプログラム的フォーカスを許可しないように）。

## 4. 制御フロー
各 document に capture リスナを設置する:
1. `pointerdown` / `touchstart`（capture）: 上記の投票を記録。
2. `focusin`（capture）:
   - target が composer でなければ何もしない（他の入力欄は触らない）。
   - composer なら投票を消費し、`tapAllows` が false（＝プログラム的自動フォーカス）なら `target.blur()`。
   - true（＝ユーザータップ由来）ならそのまま通す。

## 5. 注入方式（v2: 全フレーム×document-start）
composer は cc-web(code-server) の各 Claude Code セッション iframe（VS Code webview）側に居る。
`WebView.evaluateJavascript` は**メインフレームのみ**なので、そこから iframe を降下して追いかける旧方式は
タブ切替で webview が作り直される瞬間に取りこぼし、flaky だった。

v2 は **`WebViewCompat.addDocumentStartJavaScript(webView, script, ["*"])`** で
**全フレーム×document-start** に登録する（拡張の content script = all_frames/document_start と等価）。
- 各フレームが**自分の document** に対して、ページ自身のスクリプトより**先に**リスナを張る
  （`installAll()` の最初の一手 `ensureSuppressor(document)`）。→ 自動フォーカスより確実に前に置ける。
- 新フレーム（タブ切替の webview 作り直し含む）も生成時に document-start で入る → **追いかけ不要**。
- 登録は `loadUrl` の**前**に行う（[MainActivity.kt] `ExtensionRuntime.registerDocumentStart`）ので
  初回ロードから効く。詳細は [拡張ランタイム設計](2026-06-28-webview-extension-runtime-design.md)。

### 5.1 フォールバック（document-start 非対応端末）
`WebViewFeature.isFeatureSupported(DOCUMENT_START_SCRIPT)` が false の端末では、`onPageFinished` で
`evaluateJavascript`（メインフレーム）注入に退避する。この経路でのみ、スクリプト内の
**iframe 降下 / MutationObserver / iframe `load` / `visibilitychange`・`focus`・`pageshow` / 1s ポーリング**
が子フレームを拾う。document-start 経路ではこれらは冪等な保険として残るだけ（無害）。
- 冪等性: 各 document / iframe 要素に設置済みフラグ（`doc.__ccStudioKbSup` / `el.__ccStudioKbLoad`）。

## 6. エラー処理
- iframe の `contentDocument` 取得・`querySelector`・`blur` はいずれも try/catch で握りつぶし、
  例外で全体を止めない（防御的に書く）。
- composer が見つからないフレームでもリスナは設置してよい（無害。後から composer が現れても拾える）。

## 7. 成果物 / 配置（v2: 組込み）
```
app/src/main/
├── assets/keyboard-suppress.js                     # 単体IIFE。依存なし。組込み（常時ON）。
└── java/net/<tailnet>/ccstudio/
    ├── ExtensionRuntime.kt                          # addDocumentStartJavaScript ラッパ（土台）
    └── MainActivity.kt                              # loadUrl 前に登録 / 非対応端末は onPageFinished 注入
```
- SAF 選択・トグルUIは不要（組込み・常時ON）。`plugins/keyboard-suppress.js`（旧ユーザープラグイン版）は廃止。

## 8. テスト方針
- 純粋述語 `tapAllows(tapTime, tapWasComposer, now, windowMs)`（窓内タップ=true / 窓外=false /
  非composerタップ=false / tapTime未設定=false）。移植元 `cc-web-helper/test/focus.test.js` と同じ観点。
- DOM / blur / 全フレーム注入の実挙動は実機で手動確認。特にタブ切替で漏れないことを確認する。
