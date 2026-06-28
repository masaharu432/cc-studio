# session-list-readable プラグイン 設計

- 日付: 2026-06-28
- 状態: 実装着手

## 目的

モバイル表示で Claude Code 拡張の「セッション一覧」のタイトルが横幅に収まらず
途中で切れて読めない（例: 「チャット入…」「Bootstrap …」）。
**フォント縮小＋最大2行折返し**で、タイトル全体を読めるようにする。

## 方式

- 既存の `focus-hud` / `keyboard-suppress` と同じ **単体 CC Studio プラグイン**として新規追加。
  開発中は repo の `plugins/session-list-readable.js` に置き、端末の Plugins 画面
  「＋ Add plugin」で取り込む（APK 再ビルド不要）。固まったら `PluginStore.BUNDLED` へ登録。
- `@run-at document-start` / `@all-frames true`。各フレームに常駐し、セッション一覧が
  存在するフレームだけにスタイルを当てる。他フレームでは no-op。

## セレクタに依存しない行検出（この実装の肝）

公式拡張の DOM クラス名は未知かつ不安定。代わりに **相対時刻テキスト**を手掛かりにする。

- 各セッション行には `4m` / `5h` / `18h` / `3d` 等の相対時刻が必ず付く。
  正規表現 `^\d+\s*(s|m|h|d|w|mo|y|秒|分|時間|日|週|月|年)$` に一致する**末端テキストノード**を
  TreeWalker で収集（`querySelectorAll('*')` を避け軽量化）。
- 各時刻ノードから上方向へ最大5階層たどり、**時刻以外の長いテキスト（＝タイトル）も含む行コンテナ**を特定。
- 行内で時刻以外の最長テキストを持つ要素を**タイトル要素**とする。
- **誤爆防止**: 同一親の下に時刻付き行が2つ以上ある（＝リスト）場合のみ対象化。孤立した `4m` は無視。

検出した要素に自前クラス（`ccst-sess-row` / `ccst-sess-title` / `ccst-sess-time`）を付与し、
注入した `<style>`（`!important`）で見た目だけを上書きする。拡張の DOM 構造には手を入れない。

## 注入するスタイル

- タイトル: `font-size` 縮小、`white-space:normal`、`-webkit-line-clamp:2`（最大2行クランプ）、
  `word-break:break-word`、行間詰め。1行 ellipsis を解除。
- 時刻: 小さめ・薄め。行: 上揃え・高さ auto。
- すべて行コンテナ配下に限定し、他の VS Code UI へ波及させない。

## 堅牢性

- 冪等: `<style id>` と各クラスの有無をチェックしてから付与。多重注入でも安全。
- 再注入: VS Code の `document.write`/再描画で DOM・style が消えても復活するよう、
  `documentElement` への MutationObserver（デバウンス〜250ms）＋ 起動直後の周期ポーリングで再走査・再注入。
- セレクタ（時刻パターン）に一致する行が無ければ完全に no-op。既存 UI を壊さない。

## 診断

- `window.top.__ccStudioFocusLog`（focus-hud 共有バッファ）へ `SLR matched N rows …` を出す。
  実機スクショで「何行マッチしたか／どのフレームか」を確認できる。`DIAG=false` で停止。

## 検証

- WebView UI のため自動テストより**実機スクショの before/after**が主。
  Plugins 画面でトグルし、長いタイトルが2行で読めること・他 UI が崩れないことを確認。
