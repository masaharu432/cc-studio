# md-preview-width Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Markdown プレビュー本文の左右余白を詰めて全幅表示する新規プラグイン `md-preview-width` を追加する（余白量は ⚙ で調整、既定 12px）。

**Architecture:** cc-studio の既存プラグイン方式に従い、workbench の各フレームへ注入される単一の `.js` を追加する。プレビューのコンテンツフレームだけを厳密に判定し、本文コンテナの左右 padding（と効いていれば max-width 制約）を `<style>` 1枚で上書きする。`gutter` は `@setting number` として宣言し、`ccstudio:setting` を購読してライブ反映する。「デフォルトに戻す」は ⚙ 共通ボタンが同じ経路で発火するため追加実装なし。

**Tech Stack:** Vanilla JS（userscript 風メタ + 設定ランタイム）、CSS 注入、検証は workbench-probe スキル（実機 code-server / CDP）と focus-hud 診断。

## Global Constraints

- 設計典拠: `docs/specs/2026-07-23-md-preview-width-design.md`（本ブランチにコミット済み）。
- 効果範囲は **Markdown プレビューのみ**。エディタ本体・チャット webview の余白は変えない。
- メタ: `@run-at document-start` / `@all-frames true`。
- 設定宣言: `@setting gutter number 12 0 80 4 プレビュー本文の左右ガター(px)`（既定 12 / min 0 / max 80 / step 4）。
- 設定 namespace = `@name` = `md-preview-width`。永続化はネイティブ側。プラグインで保存処理は書かない。
- server/code-server サブモジュールは触らない・典拠にしない（実行中サーバと差異があるため、結論は workbench-probe の実測で取る）。
- すべての DOM 操作は try/catch で保護し、判定外フレームでは副作用ゼロ。
- 既存プラグインのメタ/コメント文体・命名（例: ui-zoom.js）に合わせる。

---

### Task 1: プレビューのフレーム判定マーカーと本文セレクタを実機で確定する

grep では過去に外した実績があるため、CSS を書く前に実機の DOM/computed style を workbench-probe で確定する。**このタスクの成果物は「確定した3つの値」を書き留めたメモ**であり、Task 2 のコードがそれを使う。

**Files:**
- 変更なし（調査のみ）。必要なら発見内容を `docs/specs/2026-07-23-md-preview-width-design.md` の「実装時の必須確認」節に追記する。

**Interfaces:**
- Produces（Task 2 が消費する確定値）:
  - `PREVIEW_FRAME_TEST`: 注入先ドキュメントが Markdown プレビューか否かを判定する安定条件（例: プレビュー固有の `<meta>`/`<link>`/ルート要素の有無。実測で確定）。
  - `BODY_SELECTOR`: 左右 padding を持つ本文コンテナのセレクタ（例: `body` あるいはその内側のラッパ。実測で確定）。
  - `DEFAULT_PADDING_NOTE`: 既定の左右 padding 値とその出どころ（プレビュー標準スタイルシート由来か等）、および効いている `max-width` の有無。

- [ ] **Step 1: code-server が起動しているか確認し、無ければ起こす**

`vsserver` スキルで https://agent1.taildf47.ts.net/ の code-server 稼働を確認・起動する。

- [ ] **Step 2: `.md` を開いてプレビューを表示した状態を作る**

workbench-probe スキルで、リポジトリ内の任意の `.md`（例 `README.md`）を開き「Open Preview」した状態にする。

- [ ] **Step 3: プレビューのコンテンツフレームを特定し、本文コンテナの computed style を採取する**

workbench-probe で全フレームを列挙し、Markdown プレビューのフレームを見分ける安定マーカー（`PREVIEW_FRAME_TEST` の候補）を探す。そのフレーム内で、実際に左右 padding を生んでいる要素を特定し、`getComputedStyle` の `padding-left` / `padding-right` / `max-width` / `box-sizing` を採取する。

Expected: 左右に大きめの padding（あるいは content 側 `max-width`）が実測される（＝問題の再現）。採取値を `BODY_SELECTOR` / `DEFAULT_PADDING_NOTE` として記録する。

- [ ] **Step 4: エディタ本体・チャット webview のフレームでは `PREVIEW_FRAME_TEST` が false になることを確認する**

同じ probe セッションで、エディタタブとチャット webview のドキュメントに対し `PREVIEW_FRAME_TEST` 候補を評価し、**false** になることを確認する（スコープ誤爆の防止）。

Expected: プレビュー以外のフレームでは判定条件が成立しない。成立してしまう場合は、より限定的なマーカーへ差し替えて再確認する。

- [ ] **Step 5: 確定した3値をメモとして残す**

`PREVIEW_FRAME_TEST` / `BODY_SELECTOR` / `DEFAULT_PADDING_NOTE` を確定し、設計ドキュメントの「実装時の必須確認」節へ追記してコミットする。

```bash
git add docs/specs/2026-07-23-md-preview-width-design.md
git commit -m "docs(specs): md-preview-width のフレーム判定/本文セレクタを実機で確定"
```

---

### Task 2: `md-preview-width.js` プラグイン本体を実装する

Task 1 で確定した値を使い、プラグインを実装する。ライブ反映（`ccstudio:setting`）と「デフォルトに戻す」追従までを含める。

**Files:**
- Create: `plugins/md-preview-width.js`

**Interfaces:**
- Consumes（Task 1 の確定値）: `PREVIEW_FRAME_TEST` / `BODY_SELECTOR` / `DEFAULT_PADDING_NOTE`。
- Produces: `<style id="md-preview-width">` を注入する挙動。管理スクリーンに現れる `@name md-preview-width` と `@setting gutter`。

- [ ] **Step 1: メタヘッダと定数、設定読取ヘルパを書く**

Task 1 の確定値を、コード先頭の3定数に埋める（下記の `PREVIEW_FRAME_TEST` / `BODY_SELECTOR` は Task 1 の実測に置き換える）。

```js
// ==CCStudioPlugin==
// @name        md-preview-width
// @version     0.1.0
// @description Markdown プレビュー本文の左右余白を詰めて全幅表示する（余白量は ⚙ で調整）。
// @run-at      document-start
// @all-frames  true
// @setting     gutter number 12 0 80 4 プレビュー本文の左右ガター(px)
// ==/CCStudioPlugin==
(function () {
  'use strict';
  var NS = 'md-preview-width';
  var STYLE_ID = 'md-preview-width';
  var DEFAULT_GUTTER = 12;           // メタの @setting default と一致させる
  var MIN = 0, MAX = 80;             // クランプ用（メタと一致）

  // --- Task 1 で確定した値に置き換える ---
  // 注入先ドキュメントが Markdown プレビューか判定する（プレビュー以外では false）。
  function isPreviewFrame(doc) {
    try { return /* PREVIEW_FRAME_TEST */ false; } catch (_) { return false; }
  }
  // 左右 padding を持つ本文コンテナのセレクタ。
  var BODY_SELECTOR = /* BODY_SELECTOR */ 'body';
  // ---------------------------------------

  function readGutter() {
    var conf = (window.__ccPluginSettings || {})[NS] || {};
    var v = conf.gutter;
    v = (v == null || isNaN(+v)) ? DEFAULT_GUTTER : +v;
    return Math.max(MIN, Math.min(MAX, v));
  }
})();
```

- [ ] **Step 2: スタイル注入 `applyGutter(px)` を書く**

`<style id="md-preview-width">` を1枚だけ head に置き、無ければ作る／あれば textContent を書き換える。左右 padding のみ上書き（上下は据え置き）。効いていれば `max-width` 制約も解除する（`DEFAULT_PADDING_NOTE` に応じて）。

```js
  function css(px) {
    return BODY_SELECTOR + '{' +
      'padding-left:' + px + 'px !important;' +
      'padding-right:' + px + 'px !important;' +
      'max-width:none !important;' +
      'box-sizing:border-box !important;' +
    '}';
  }
  function applyGutter(px) {
    var doc = document;
    if (!isPreviewFrame(doc)) return;               // プレビュー以外では何もしない
    try {
      var st = doc.getElementById(STYLE_ID);
      if (!st) {
        st = doc.createElement('style');
        st.id = STYLE_ID;
        (doc.head || doc.documentElement).appendChild(st);
      }
      st.textContent = css(px);
    } catch (_) {}
  }
```

- [ ] **Step 3: 初回適用と、webview の document 差し替えへの張り直しを書く**

webview は起動時に `document.open()/write()` で葉文書を書き換えることがあり、`<style>` とリスナが消える（ui-zoom v0.5.1 の既知事例）。名前付き関数を tick で再適用し、`<style>` が消えていれば張り直す。

```js
  function tick() {
    if (!isPreviewFrame(document)) return;
    if (!document.getElementById(STYLE_ID)) applyGutter(readGutter());
  }
  applyGutter(readGutter());                        // 初回
  var iv = setInterval(tick, 1000);                 // 差し替え検知の保険（軽量・存在チェックのみ）
```

- [ ] **Step 4: ライブ反映（⚙ 変更・デフォルトに戻すの両方）を書く**

`ccstudio:setting` を名前付きハンドラで購読し、同一参照で毎 tick 再登録（webview 差し替え後もゾンビ化しないため）。「デフォルトに戻す」も `setSetting` 経由で同イベントを発火するので、これだけで追従する。

```js
  function onSetting(e) {
    var d = e && e.detail; if (!d || d.plugin !== NS || d.key !== 'gutter') return;
    var v = (d.value == null || isNaN(+d.value)) ? DEFAULT_GUTTER : +d.value;
    applyGutter(Math.max(MIN, Math.min(MAX, v)));
  }
  function bind() {
    try { window.removeEventListener('ccstudio:setting', onSetting); } catch (_) {}
    try { window.addEventListener('ccstudio:setting', onSetting); } catch (_) {}
  }
  bind();
  var iv2 = setInterval(bind, 1000);                // 差し替えでリスナが消えた場合の再登録
```

（上記 3・4 の setInterval は 1 本に統合してよい。統合する場合は `tick()` 内で `bind()` も呼ぶ。）

- [ ] **Step 5: メタ検証（app 側の既存テスト）を走らせて登録可能なメタであることを確認する**

Run: `./gradlew :app:testDebugUnitTest --tests 'app.ccstudio.PluginMeta*' --tests 'app.ccstudio.PluginSettings*'`
Expected: PASS（number 設定 `gutter 12 0 80 4` を含むメタが既存パーサで解釈できること。パースは汎用なので通常グリーン）。

- [ ] **Step 6: コミット**

```bash
git add plugins/md-preview-width.js
git commit -m "feat(plugins): md-preview-width v0.1.0 プレビュー本文を全幅化（⚙で左右ガター調整）"
```

---

### Task 3: 実機で全幅化・スコープ限定・ライブ反映・リセットを検証する

**Files:**
- 変更なし（検証のみ）。必要に応じてセレクタ/判定を Task 2 のコードへ微修正して再コミット。

**Interfaces:**
- Consumes: `plugins/md-preview-width.js`（Task 2）。

- [ ] **Step 1: プラグインを取り込み、ON にする**

実機（またはエミュレータ）のプラグイン管理スクリーンから `md-preview-width.js` を Add plugin → ON にする。

- [ ] **Step 2: プレビューが全幅化することを確認する（workbench-probe）**

`.md` を開いてプレビュー表示し、workbench-probe で本文コンテナの computed `padding-left/right` が `12px`（＝現行 gutter）になり、実効本文幅が拡大していることを確認する。

Expected: Task 1 の初期実測より本文幅が明確に広がっている。

- [ ] **Step 3: スコープ限定を確認する**

同セッションで、エディタタブとチャット webview の余白・レイアウトが**変化していない**ことを probe / 目視で確認する。

Expected: プレビュー以外は不変。変化していたら `isPreviewFrame` を Task 1 のより限定的なマーカーへ直し、Task 2 を再コミットして本ステップに戻る。

- [ ] **Step 4: ライブ反映を確認する**

⚙ で `gutter` を 12 → 40 → 0 と変え、**リロードなし**でプレビュー左右余白が追従することを確認する。

Expected: 各変更が即時反映される。

- [ ] **Step 5: 「デフォルトに戻す」を確認する**

⚙ の「デフォルトに戻す」を押し、`gutter` が 12px に即戻ることを確認する。

Expected: 追加実装なしで 12px へ復帰（`ccstudio:setting` 経由）。

- [ ] **Step 6: スクリーンショットで最終確認する**

workbench-probe でプレビューのスクリーンショットを撮り、当初の無駄な左右余白が解消されていることを目視確認する。SendUserFile でユーザーに提示する。

---

### Task 4: README（プラグイン規約・日英）と本数を更新する

**Files:**
- Modify: `plugins/README.md`（本数 11→12・一覧/該当箇所）
- Modify: `README.md`（日本語・プラグイン本数/一覧に該当があれば）
- Modify: `README.en.md`（英語・同上）

**Interfaces:**
- Consumes: 完成した `md-preview-width` プラグインの名称・目的・設定。

- [ ] **Step 1: 現在の「11 本」表記と一覧箇所を洗い出す**

Run: `grep -rn -E '11 ?本|11 plugins|md-preview-width|ui-zoom' plugins/README.md README.md README.en.md`
Expected: 更新すべき箇所（本数表記・プラグイン一覧）が列挙される。

- [ ] **Step 2: 本数を 12 本へ、一覧に md-preview-width を追記する**

各ファイルの本数表記を 12 本 / 12 plugins に更新し、一覧へ `md-preview-width`（プレビュー本文を全幅化・⚙で左右ガター調整）を日英で追記する。他プラグインの記法に合わせる。

- [ ] **Step 3: コミット**

```bash
git add plugins/README.md README.md README.en.md
git commit -m "docs: md-preview-width を追記し本数を 12 本へ（README 日英・プラグイン規約）"
```

---

## Self-Review

- **Spec coverage:**
  - 全幅化 → Task 2（applyGutter）＋ Task 3 Step 2。
  - ⚙ で調整 → `@setting gutter`（Task 2 Step 1）＋ Task 3 Step 4。
  - スコープ限定 → `isPreviewFrame`（Task 1 で確定・Task 2 で実装・Task 3 Step 3 で検証）。
  - デフォルトに戻す → 追加実装なし（Task 2 Step 4 のライブ反映で追従・Task 3 Step 5 で検証）。
  - 堅牢性（document 差し替え）→ Task 2 Step 3・4。
  - workbench-probe 実機確定 → Task 1・Task 3。
  - 成果物（本数更新）→ Task 4。
  すべてタスクに対応済み。ギャップなし。
- **Placeholder scan:** コード内の `/* PREVIEW_FRAME_TEST */` `/* BODY_SELECTOR */` は Task 1 の実測値で置換する明示プレースホルダ（発見タスクの成果物）。それ以外に TBD/TODO・曖昧な「適切に処理」等はなし。
- **Type consistency:** `NS`/`STYLE_ID`/`DEFAULT_GUTTER`/`applyGutter`/`readGutter`/`isPreviewFrame`/`BODY_SELECTOR`/`onSetting`/`bind`/`tick` の名称は全タスクで一致。`@setting gutter number 12 0 80 4` と `DEFAULT_GUTTER=12`/`MIN=0`/`MAX=80` が一致。
