# selectable-text プラグイン 設計

- 日付: 2026-06-29（実装確定: 2026-06-30）
- 種別: 同梱プラグイン（`plugins/selectable-text.js`）
- 状態: 実機確認済み（v0.8.0）
- 関連: [region-grab](2026-06-29-region-grab-design.md) / [session-list-readable](2026-06-28-session-list-readable-design.md) / [VS Code ソース調査メモ](../notes/2026-06-29-vscode-source-and-version-findings.md)

## 目的

モバイルの WebView 上で、**入力できない読み取り専用テキスト**——特に **Claude Code のチャット本文**と
**Markdown/HTML プレビューの描画テキスト**——を、長押しで選択し**コピー**できるようにする。

## なぜプラグイン層か

チャットも Markdown プレビューも **webview iframe（拡張 webview）の中**にある。プラグインは全フレームの
ページコンテキストに注入されるので各フレームに介入できる。VS Code 拡張からは他拡張（Claude Code）の
webview 内 DOM に触れず、本機能は実装できない（[region-grab](2026-06-29-region-grab-design.md) の対比表と同じ理由）。

## 根本原因（実機診断 + webview ソースで確定）

`select-diag` プラグインによる実機計測と `pre/index.html` のソース読解で、以下を確定した。

1. **選択自体はできている**。チャット `li`(us=text) / プレビュー `p.code-line`(us=auto) で、長押し時に
   `touchstart pd=no` / `selectstart pd=no`、`getSelection()` も非空（selLen>0＝読める）。ハンドルも出る。
2. **犯人は contextmenu**。webview の `pre/index.html` が INNER コンテンツに張る転送リスナ（1179行〜）が
   `e.preventDefault()`（＝ネイティブ選択バーを殺す）＋ホストへ転送（＝VS Code メニュー `context-view-block` を開く）
   を行う。この VS Code メニューが選択ハンドルの操作を奪い、「範囲が選べない／使えない Cut/Copy/Paste が出る」状態にしていた。
3. **この WebView は nested webview iframe の選択にネイティブの Copy バー（ActionMode）を出さない**（実機 B）。
   よって「contextmenu を止めるだけ」では選択はできてもコピー手段が無い。
4. **`document.execCommand('copy')` は webview フレーム内で動く**。`pre/index.html` は webview に
   `clipboard-write` を許可（1036行）し、VS Code 自身 `execCommand`（1261行）で webview の選択をコピーしている。

### 切り分けで否定した案（経緯の記録）

- **CSS で user-select 解放だけ**：chat/preview は元から選択可（us=text/auto）。解放しても native の Copy UI は出ない。
- **JS で Selection API によるプログラム選択**：ハンドル/Copy バーは出ない（ActionMode は JS から召喚できない）。
- **contextmenu を preventDefault**：VS Code メニューも native バーも消えるが、コピー手段が無くなる。
- **selectionchange で出すコピーボタン**：webview で発火が不安定。さらに**表示直後に selectionchange の自動非表示が
  消していた**（これが「ボタンが出ない」の真因。診断で append 自体は可視と確認 → 自動非表示の撤去で解決）。

## 方式（v0.8.0）

単一 `.js`（`@all-frames true` / `@run-at document-start`）。役割をフレームで分岐。

### 非トップ（webview）フレーム: 長押し → 「コピー」ボタン
- **トリガ**: `window` capture の `contextmenu`（長押しで確実に発火。診断で `CTXwin` を確認）。
  - `e.preventDefault()` + `e.stopImmediatePropagation()` で webview の転送リスナを止める
    （転送リスナは `e.defaultPrevented` なら何もしない実装。両方掛けて確実に止め、VS Code メニューを出さない）。
  - 長押し時点の選択テキストを保険として保持。
- **表示**: 指の位置（contextmenu の `clientX/clientY`＝ビューポート基準で transform の影響を受けない）に
  「⧉ コピー」ボタンを `documentElement` 直下へ `position:fixed` で出す。**無条件表示・自動非表示はしない**
  （消えるのはコピー時 or 一定時間 9s 経過のみ）。これによりハンドルで範囲調整してからタップできる。
- **コピー**: ボタンの `pointerdown` で `preventDefault`（フォーカス移動＝選択解除を防ぐ）→ `click` で
  `document.execCommand('copy')`（**生きた選択＝調整後の範囲**をコピー）。保険として
  `navigator.clipboard.writeText` と「トップフレームへ転送してコピー」も併用。

### トップフレーム
- iframe からのコピー依頼（`__cc_st_copy`）を受けてクリップボードへ書く保険受け口。
- TOP の chrome（ファイル一覧/エディタの長押しメニュー）は温存するため、contextmenu 抑止もボタンも **iframe 限定**。

### 共通（保険）
- `user-select` を広く解放（`*:not(input):not(textarea)` を text、`.monaco-editor *` は none 維持）。
  us=none の読み取り専用領域への保険。冪等注入＋`MutationObserver`/ポーリングで再描画にも復活。

## 検証

- **実機で確認済み**: チャット本文・Markdown プレビューで長押し → 「⧉ コピー」表示 → ハンドルで範囲調整 →
  タップでクリップボードへコピー。
- 機構の各リンク（contextmenu 発火・選択の可読性・ボタンの可視）は `select-diag` で個別に実測確認。
- `select-diag` は原因特定用の一時診断プラグイン（不具合調査時に再利用可）。

## スコープ外（YAGNI）

- Monaco エディタ本文の選択（独自選択管理のため対象外）。
- 矩形ドラッグでの収集は [region-grab](2026-06-29-region-grab-design.md)（本プラグインで足りない領域のフォールバック）。
- ネイティブ ActionMode バーの復活（この WebView では nested iframe に出ないため不可）。
