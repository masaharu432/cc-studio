# view-width プラグイン 設計（旧 md-preview-width）

> v0.3.0 で `md-preview-width` を汎用の `view-width` へ改称し、ターゲット別に独立ガターを持つ多ターゲット
> 構成へ発展させた。以下は当初の Markdown プレビュー設計に、Claude 拡張チャットのターゲットを追記したもの。
> 末尾「Claude 拡張チャット ターゲット」節を参照。

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
- **本文セレクタ / 余白源**: 左右余白は **html と body の二段の padding**（各 `0 26px`）。body だけ 0 にしても html の
  26px が残る（実機報告→gutter=0 でボックスモデル実測: html padL/R=26px, body.left=26px）。子の `.markdown-body` は
  padding/margin 0 で寄与しない。**html=0 / body=gutter に固定**し総インセットを gutter に一致させる
  （実測: gutter=0→content left=0（全幅）, gutter=12→content left=12）。
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

### 実機検証結果（code-server 4.126.0 / mobile 412px / CDP・2026-07-23）

プラグイン（gutter=12）＋検証ハーネスを注入し README.md プレビューを開いて body padding を計測。すべて PASS。

- 全幅化: プレビュー body の左右 padding = **12px/12px**（プラグイン無しの実測 26px から詰まる＝基本ルールを上書き）。
- スコープ限定: 非プレビュー2フレーム（ワークベンチ外殻 `agent-status-enabled…` / 空 body のフレーム）の padding は **0/0 のまま不変**。プラグインはプレビューフレームだけに作用。
- ライブ反映（重要な追加知見）: `ccstudio:setting` の postMessage 連鎖は**深くネストした Markdown プレビュー
  葉フレームまで届かない**（実機報告「リロードしないと反映されない」を CDP で再現：本物のランタイムを全
  フレーム注入しトップだけで `__ccApplyPluginSetting` を呼ぶと、プレビューフレームは `evt=0`＝イベント未達）。
  対策として **ui-zoom と同じ postMessage 照会方式（プル型）** に統一：真実はトップ一元
  （ネイティブが main フレームの `window.__ccPluginSettings` を直接更新し常に最新）。葉（プレビュー）は
  `window.top` へ `MSG_Q` を投げ、トップが現在 gutter を `MSG_V` で返信 → 葉が適用。1s ポーリング＋
  （届く場合の）`ccstudio:setting` で再照会し、document.open 対策でリスナを毎 tick 再武装する。
  postMessage はクロスオリジン webview 葉でも通るため、`window.top` 直読み（同一オリジン限定）より堅牢で
  規約整合。実測：本物のランタイムを全フレーム注入しトップだけ apply(40)→プレビューは `evt=0`（イベント未達）
  のまま照会/返信で padding 12→40 に追従。
- 「デフォルトに戻す」相当: 同経路（`setSetting` がトップ設定を更新）で tick が拾い 12px へ復帰。
- `@media(min-width:914px)` の大余白ルールも同じ `body` セレクタ・非 `!important` のため、`padding-left/right !important` の longhand が同様に勝つ（上書き機構が実測でプレビュー body に効くことを確認済み＝カバー）。

## 成果物

- `plugins/md-preview-width.js`（新規・本数 11→12）
- `plugins/README.md` / README(日英) の本数・一覧更新
- 本設計ドキュメント

## Claude 拡張チャット ターゲット（view-width v0.3.0 で追加）

Claude Code 公式拡張のチャット webview は、広い幅で会話コンテンツ列が中央の帯に固定され左右が大きく余る
（「横幅が全然使えてない」の実機報告）。汎用化した `view-width` に 2 つ目のターゲットとして追加した。

### 実機確定値（code-server 4.126.0 / Claude 拡張 2.1.218 / CDP 実測・2026-07-24）

workbench-probe スキルの手順（folder 付き URL → Workspace Trust 付与 → アクティビティバーの Claude アイコン
クリック → webview は同一オリジンなので `contentWindow` で葉フレームへ潜る。テンプレ
[claude-view-template.js](../../.claude/skills/workbench-probe/claude-view-template.js)）で会話フレームを実測。

- **フレーム判定**: Claude webview 葉フレームは `<html>` に CSS 変数 `--app-claude-orange`（`#d97757`）を持つ。
  `getComputedStyle(html).getPropertyValue('--app-claude-orange')` が非空なら Claude フレーム。プレビュー・エディタ等
  とは別物として綺麗に分離できる。
- **幅の制約源**: 会話コンテンツ列 `[class*=inputWrapper]` が `max-width:680px` ＋ auto マージンで中央寄せ
  （実測: 幅 1052px で列 680px・左右 169px ずつ余る）。狭い幅（〜412px 等）では 680 未満のため余白は出ないが、
  ui-zoom 縮小・横向き・広ペインで幅が 680 を超えると左右が余る。
  ※ クラス名はハッシュ付き（`inputWrapper_cKsPxg` 等・ビルドで変動）なので **`[class*=inputWrapper]` の前方一致**
  で拾う（バージョン差に強い）。
- **上書き**: `[class*=inputWrapper]{ max-width: <chatGutter=0 なら none／>0 なら calc(100% - 2*gutter px)> !important }`。
  gutter=0 で全幅、>0 で左右 gutter px の中央寄せ。auto マージンはそのまま（中央寄せ維持）。

### 設定・検証

- 設定は **ターゲット別に独立**: `@setting previewGutter number 12 0 80 4` / `@setting chatGutter number 0 0 200 8`
  （chat 既定 0 = 全幅）。判定は webview 葉フレームで高々 1 ターゲットに一致し、その `<style>`（`cc-vw-preview` /
  `cc-vw-chat`）に適用。ライブ反映・「デフォルトに戻す」はプレビューと同一の ui-zoom 同型 postMessage 照会経路。
- 実機検証（幅 1052px・プラグイン注入）: chatGutter=0 → `max-width:none`・列 680→**1019px 全幅**。chatGutter=40 →
  `calc(100% - 80px)`・中央寄せ。previewGutter=0 → プレビュー本文 left=0（全幅維持・退行なし）。
