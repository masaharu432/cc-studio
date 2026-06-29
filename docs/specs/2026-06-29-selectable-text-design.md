# selectable-text プラグイン 設計

- 日付: 2026-06-29
- 種別: 同梱プラグイン（`plugins/selectable-text.js`）
- 関連: [session-list-readable](2026-06-28-session-list-readable-design.md) / [webview-extension-runtime](2026-06-28-webview-extension-runtime-design.md) / [region-grab](2026-06-29-region-grab-design.md)（フォールバック候補）

## 目的

モバイルの WebView 上で、**入力できない読み取り専用テキスト領域**——特に
**Claude Code 拡張のチャット本文**と **Markdown/HTML プレビューの描画テキスト**——に対して、
スマホ標準の**ネイティブ選択（長押し→選択ハンドル→“コピー”バブル）**を生かしてコピーできるようにする。

VS Code は chrome 全般に `user-select: none` を当てて選択を殺しているため、素のモバイルブラウザでは
これらの領域を長押ししても選択ハンドルが出ない。本プラグインは `user-select` を解放して
ネイティブ選択 UI を復活させる。region-grab（矩形ドラッグ収集）より**最小・ネイティブ UX・custom UI ゼロ**。

## なぜプラグイン層か

Claude Code のチャットも Markdown/HTML プレビューも **webview iframe**（拡張 webview）の中にある
（→ [裏取り](#サーバソース裏取りcode-server--vs-code-稼働版)）。プラグインは全フレームの
ページコンテキストに注入されるため、本体フレームも webview フレームも CSS を上書きできる。
VS Code 拡張からはワークベンチ chrome や他拡張（Claude Code）の webview の DOM に触れず、本機能は実装できない
（[region-grab](2026-06-29-region-grab-design.md) の対比表と同じ理由）。

## サーバソース裏取り（code-server / VS Code 稼働版）

> **重要・バージョン整合**: cc-studio の `server/code-server` submodule（pin `dd48f775`）とその `lib/vscode`
> （pin `7e7950df`、独自の `src/vs/sessions/mobile` 入り）は、**実際に稼働しているサーバとは別物**。
> provision は `code-server.dev/install.sh --method standalone` で**プレビルド release を入れる**ため
> （[setup.sh](../../server/provision/setup.sh)）、稼働中は **code-server 4.126.0 / 同梱 VS Code 1.126.0
> （commit `2c06497c`、vanilla 上流）**。よって裏取りは **submodule ではなく稼働ビルド
> `~/.local/lib/code-server-4.126.0/lib/vscode/out` の実体**に対して行った。

- **`user-select: none !important` は稼働ビルド全体で 0 件**（`text !important` は 8件＝diffEditor 等、VS Code が
  意図的に付けたもので text 解放と衝突しない）。`user-select:none` はすべて素。
  → 本プラグインの **`!important` 付き解放は特異度に関係なく全部に勝つ**。広域 `*` セレクタで十分、が稼働版で確定。
- **チャット/プレビューは拡張 webview（iframe）**。稼働ビルドに組込みの `sessions/mobile` チャットは**存在しない**
  （submodule 固有のツリーだった）。webview は同一オリジン自己ホスト（`patches/webview.diff`、`pre/index.html`
  の CSP は `style-src 'unsafe-inline'` 許可）で、`@all-frames` 注入がカバーする。
- **クリップボード配線は不要**。`patches/clipboard.diff` が足すのは `_remoteCLI.setClipboard`
  （CLI → *サーバ側* `IClipboardService.writeText`）でブラウザのコピーとは別物。ネイティブ選択の
  "コピー" バブルは **Android の OS クリップボードへ直接書く**ので、本プラグインは CSS のみで完結する。
- **エディタ除外の正当性**: Monaco は選択を独自描画で管理し、エディタの DOM `user-select` は通常 `none`。よって
  `.monaco-editor *` を `none !important` で固定＝**Monaco の通常状態のまま**で、独自選択（ポインタ駆動）に干渉しない。
- **実績**: `session-list-readable` が webview フレーム内へ `<style>(!important)` を
  `createElement('style')`→`appendChild`＋`getElementById` 冪等＋`MutationObserver`/`setInterval` 再注入で
  注入して成立。本プラグインは同じ作法をなぞる（検出ロジックが無い分さらに単純）。

### 残存リスク（実機スパイクで判定）

VS Code core 側には `user-select:none !important` も無く CSS 解放を阻む要素は無い。一方チャット/プレビューは
**Claude Code 拡張の webview**で、その**内部 DOM/CSS・選択ハンドリングは拡張側のコード**（パッケージ済みで
ここからは読めない）。よって残る不確実点は：

- 拡張 webview が**自前で `user-select:none` を当てているか**（素なら我々の `!important` で勝つ。万一
  `none !important` を使っていれば特異度勝負になり、より高特異度の上書きが要る）。
- 拡張 webview が**長押し/選択を JS で横取りしているか**（あれば段階2 で対象 webview に限定して抑止）。

いずれも稼働サーバ上の実機スパイクで白黒つく。

## 方式

単一の `.js`（`@all-frames true` / `@run-at document-start`、既存3本と同じ作法）。

### 段階1（MVP）: CSS による user-select 解放

注入する `<style>`（`!important`）で、**広く解放＋エディタ除外**：

```css
*:not(input):not(textarea) {
  -webkit-user-select: text !important;
  user-select: text !important;
}
/* Monaco の独自選択と喧嘩しないため、エディタ本文は対象外 */
.monaco-editor, .monaco-editor * {
  -webkit-user-select: none !important;
  user-select: none !important;
}
```

- 方針は **広く解放＋エディタ除外**。クラス名に依存せず、チャット/プレビューを取りこぼさない
  （UI ラベルまで選択可になるが無害）。`session-list-readable` と同じく「見た目/挙動の最小上書き」に留める。
- フォーム入力（`input`/`textarea`）は元から選択可なので素通し。
- `.monaco-editor` 配下のみ `user-select:none` を維持して除外（ネイティブ選択は当てにならない既知の難所＝諦め領域）。
- `document.write`/再描画で `<style>` が消えても、`MutationObserver` + 起動直後の周期ポーリングで**冪等に再注入**（session-list-readable と同方式）。多重注入されても 1 つに収束（固定 `id`）。

### 段階2（フォールバック・既定 OFF）: 拡張 webview の選択横取り回避

実機スパイクで「チャット/プレビュー webview は CSS 解放してもネイティブ選択が出ない」と判明した場合のレバー。
原因は VS Code core ではなく **Claude Code 拡張 webview 自身の選択ハンドリング**（[残存リスク](#残存リスク実機スパイクで判定)参照）。
プラグインは webview フレームにも注入されるので、**対象 webview に限定して**長押し/`selectstart`/`contextmenu` の
横取りを capture フェーズで無力化（VS Code 拡張リスナへの伝播のみ止め、`preventDefault` はせずネイティブ選択を通す）。

- 副作用（webview 側の長押しアクションを潰す）リスクがあるため**既定 OFF**。段階1 で足りなければ有効化。
- 実装は実機で横取りの出方（どのイベントか・どの要素か）を見てから確定する。
- 将来 `@settings true` で ON/OFF を出す余地を残す（実体は将来フェーズ）。MVP では定数フラグ。

## メタヘッダ

```js
// ==CCStudioPlugin==
// @name        selectable-text
// @version     0.1.0
// @description 入力できない読み取り専用領域（Claude Code のチャット本文・Markdown/HTML プレビュー等）で、スマホ標準のネイティブ選択→コピーを生かす。user-select を広く解放し、Monaco エディタ本文のみ除外。全フレームに document-start で常駐し、再描画にも冪等再注入。
// @run-at      document-start
// @all-frames  true
// ==/CCStudioPlugin==
```

## 検証

- **実機が主**（ネイティブ選択ハンドル＋“コピー”が出るかはユニットテスト不可）。確認項目：
  1. クロードのチャット本文を長押し → 選択ハンドルが出て範囲選択でき、“コピー”でクリップボードに入る。
  2. Markdown/HTML プレビューの描画テキストで同上。
  3. **Monaco エディタ本文**は従来どおり（独自選択のまま壊れていない）。
  4. webview iframe 内（チャット/一覧）でも効く＝全フレーム注入の確認。
- 段階1 で 1・2 が満たせなければ段階2 を有効化して再確認（どの領域が乗っ取りかをメモ）。
- 純ロジックは薄い（冪等注入の単発テスト程度）。挙動の核は実機チェックリストへ（README 状態欄の運用に合わせる）。

## スコープ外（YAGNI）

- Monaco エディタ本文のネイティブ選択（独自選択管理のため不可。必要なら別途検討）。
- 矩形ドラッグでの収集（それは [region-grab](2026-06-29-region-grab-design.md)。本プラグインで足りない領域のフォールバック）。
- 設定 UI（MVP は定数フラグ。段階2 が常用化したら `@settings` 化を検討）。
