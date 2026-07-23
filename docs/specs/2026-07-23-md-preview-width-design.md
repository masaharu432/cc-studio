# md-preview-width プラグイン 設計

- 日付: 2026-07-23
- 対象: cc-studio / plugins
- ブランチ: `worktree-md-preview-width`（既存の空ワークツリーを再利用）

## 背景 / 問題

VS Code の Markdown **プレビュー**は、狭いスマホ画面でも本文の左右に大きな余白（padding）を
取る。結果、本文はその内側の細い幅にしか入らず、画面の横スペースが大きく無駄になる
（実機スクリーンショットで確認済み）。編集は Claude に任せ VS Code は成果物のビューワーとして
使う cc-studio の性格上、プレビューの可読領域が狭いのは体験を直接損なう。

## ゴール

- Markdown プレビュー本文を、スマホ画面の横幅ほぼいっぱいまで広げる。
- 左右ガター（余白 px）は ⚙ から後調整できる。
- 効果範囲は **Markdown プレビューのみ**。エディタ本体・チャット webview の余白は変えない。
- 「デフォルトに戻す」で初期ガターへ即戻せる。

### 非ゴール（YAGNI）

- エディタ内の折り返し幅やチャット表示幅の変更。
- 上下方向の余白調整。
- テーマ別・ファイル別の個別設定。

## 方式

既存 11 本と同じ「workbench の各フレームへ `.js` を1本注入するプラグイン」方式。新規に
`plugins/md-preview-width.js` を追加し、プラグイン管理スクリーンから Add plugin → ON/OFF・削除できる。

### メタヘッダ

```js
// ==CCStudioPlugin==
// @name        md-preview-width
// @version     0.1.0
// @description Markdown プレビュー本文の左右余白を詰めて全幅表示する（余白量は ⚙ で調整）。
// @run-at      document-start
// @all-frames  true
// @setting     gutter number 12 0 80 4 プレビュー本文の左右ガター(px)
// ==/CCStudioPlugin==
```

- `@all-frames true`: プレビュー本文はネストしたコンテンツフレーム内で描画されるため、全フレーム注入が必要。
- `@setting gutter number 12 0 80 4`: 既定 12px（ほぼ全幅）/ min 0 / max 80 / step 4。⚙ に −/+ ステッパーで表示・ライブ反映される。

## 構成 / 責務

単一ファイル・単一責務。役割は3つの小さな部品に分かれる。

1. **フレーム判定（isMarkdownPreviewFrame）**
   - 注入先ドキュメントが Markdown プレビューのフレームかを判定する。プレビュー特有の
     DOM マーカー（実機で確定する。VS Code のプレビュー本文はエディタ・チャットとは別構造）で
     絞り込み、該当しないフレームでは**何もしない**。
   - 依存: なし（DOM のみ）。誤判定するとエディタ／チャットの余白まで変わるため、ここを厳密にする。

2. **スタイル注入（applyGutter(px)）**
   - プレビュー本文コンテナの左右 padding（および効いていれば `max-width` 制約）を `px` で上書きする
     `<style id="md-preview-width">` を head に1枚差し込む／書き換える。`!important` 付き、上下は据え置き。
   - 依存: 1 の判定結果と、現在の `gutter` 値。

3. **設定連携（read + subscribe）**
   - 初回: `window.__ccPluginSettings['md-preview-width'].gutter` を読み、`applyGutter` を呼ぶ
     （未設定時はメタの default 12 にフォールバック）。
   - 追従: `ccstudio:setting`（`{plugin,key,value}`）を購読し、`plugin==='md-preview-width' && key==='gutter'`
     のとき `applyGutter(value)` を再実行（リロード不要のライブ反映）。
   - 依存: 設定ランタイム（アプリがプラグインより先に注入）。

## データフロー

```
起動 → 各フレームへ注入 → isMarkdownPreviewFrame?
        ├ no  → 何もしない
        └ yes → 設定読取(gutter) → applyGutter(gutter)
⚙ で gutter 変更 / 「デフォルトに戻す」押下
        → setSetting → ccstudio:setting 発火 → applyGutter(newValue)
```

## 「デフォルトに戻す」

追加実装は不要。⚙ の plugin-settings パネルには全プラグイン共通の「デフォルトに戻す」ボタンが
組み込み済みで（`app/src/main/assets/plugin-settings.html`）、押下時に宣言済み各 `@setting` を
schema の `default` に `setSetting` で戻す。これは −/+ ステッパーと同じ経路（保存＋`ccstudio:setting`
発火）を通るため、本プラグインが `ccstudio:setting` を購読していれば `gutter` が即 12px へ戻る。
したがって本設計では **`gutter` の default を正しく宣言し、live 反映ハンドラを持つ**ことだけで満たされる。

## エラー処理 / 堅牢性

- webview は起動時に `document.open()/write()` で葉文書を書き換え、window のリスナが消える実機挙動が
  既知（ui-zoom v0.5.1 で対処済みの事例）。本プラグインも
  - リスナは名前付き参照で保持し、必要なら tick で再登録（同一参照の addEventListener は冪等）。
  - `<style>` の存在を都度確認し、消えていれば張り直す（documentElement 差し替え検知）。
- すべての DOM 操作は try/catch で保護し、判定外フレームでは副作用ゼロ。

## 実装時の必須確認（重要）

- プレビュー本文の**正確なセレクタ・既定 padding の出どころ・フレーム判定マーカー**は、grep では
  過去に外した実績があるため（メモリ: workbench-probe 参照）、**workbench-probe スキルで実機の
  computed style / DOM 構造を確認してから** CSS とセレクタを確定する。server/code-server サブモジュールの
  ソースは実行中サーバと差異があり得るので典拠にしない。

### 実機確定値（code-server 4.126.0 / mobile 412px で CDP 実測・2026-07-23）

CDP で cc-studio を開き README.md をプレビュー表示し、全フレームへ診断注入 → console 経由で回収して確定。

- **フレーム判定マーカー（`PREVIEW_FRAME_TEST`）**: `!!document.getElementById('vscode-markdown-preview-data')`。
  プレビューには `<meta id="vscode-markdown-preview-data" data-settings data-strings data-state data-initial-md-content>`
  が必ず存在する。エディタ本体・ワークベンチ外殻・その他 webview には無く、`vscode-body` クラスも付かないため
  スコープが綺麗に分離できる（実測でプレビュー以外のフレームはすべて非該当）。
- **本文セレクタ（`BODY_SELECTOR`）**: `body`。左右余白は **body の padding** に乗る（`box-sizing: content-box`、margin 0）。
  子の `.markdown-body` は padding/margin 0・max-width none で**側余白に寄与しない**ため、上書き対象は body だけでよい。
- **既定 padding（`DEFAULT_PADDING_NOTE`）**: 基本 `body{ padding:0 26px }`（`.../extensions/github/markdown.css` 由来）。
  実機の大余白は `@media screen and (min-width:914px){ body{ padding:0 calc((100% - 862px)/2) } }` が正体
  （プレビュー内部幅が 914px 以上のとき中央 862px へ寄せる）。どちらのルールも `!important` ではないので、
  `body{ padding-left:<gutter>px !important; padding-right:<gutter>px !important }` で両方に確実に勝てる。
  `max-width` 制約は body・`.markdown-body` とも `none` のため上書き不要（防御目的で付けても無害）。

## テスト / 検証

- workbench-probe で `.md` をプレビューし、
  - 適用前後の本文コンテナの computed `padding-left/right`・実効本文幅を比較（全幅化を確認）。
  - エディタタブ・チャット webview の余白が**変わっていない**ことを確認（スコープ限定の検証）。
  - ⚙ で `gutter` を 12→40→0 と変え、リロードなしで追従することを確認。
  - 「デフォルトに戻す」で 12px に復帰することを確認。
- 実機スクリーンショットで、当初の無駄な左右余白が解消されていることを目視確認。

## 成果物

- `plugins/md-preview-width.js`（新規・本数 11→12）
- `plugins/README.md` / README(日英) の本数・一覧更新
- 本設計ドキュメント
