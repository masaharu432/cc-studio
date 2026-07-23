# ui-zoom プラグイン Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠ 方式変更済み**: 本プランの埋め込みコード（v0.1.0）の「CSS zoom＋currentCSSZoom 実測」方式は
> 実機・実証で不成立と判明（currentCSSZoom はドキュメント境界を越えない／CSS zoom は VS Code の
> innerWidth ベースのレイアウトと座標系に噛み合わない）。現行方式は spec 最新版（v0.3:
> viewport meta の initial-scale 書き換え＋top→葉の postMessage 倍率配布）を正とし、
> 本プランのコードは再実行しないこと。

**Goal:** workbench の外枠 UI（アクティビティバー等）を CSS zoom で縮小し、チャット等のコンテンツフレームは等倍に保つプラグイン `ui-zoom` を追加する。

**Architecture:** `@all-frames true × document-start` の単一 JS。トップフレームは `documentElement.style.zoom = 0.75` を適用、非トップの葉フレーム（自文書に iframe を持たない）は `currentCSSZoom` で継承倍率を実測して逆倍率で等倍へ戻す。中間ラッパーフレームは何もしない。詳細は spec 参照。

**Tech Stack:** 素の JS（ES5 風 var 構文・IIFE）。ビルド無し。テストは `node --check` の構文検査＋実機スクリーン検証。

**Spec:** `docs/specs/2026-07-22-ui-zoom-plugin-design.md`

## Global Constraints

- プラグイン規約は `plugins/README.md` に従う（メタヘッダ・設定ランタイム・フレーム作法・診断作法）。
- DOM 特定に code-server / 拡張のクラス名を使わない（構造ルールと標準 API のみ）。
- ネイティブブリッジ `window.CCStudio.*` は使わない。
- コード様式は既存プラグイン（rc-autoconnect.js 等）踏襲: IIFE・`'use strict'`・`var`・全 API 呼び出しを try/catch・二重注入ガード。
- 倍率定数 `Z = 0.75`（チューニングは `@version` bump で行う）。
- 自動テスト基盤は無い。各タスクの検証は `node --check` と実機スクリーン（DIAG ログ）で行う。

---

### Task 1: plugins/ui-zoom.js 本体

**Files:**
- Create: `plugins/ui-zoom.js`

**Interfaces:**
- Consumes: 設定ランタイム `window.__ccPluginSettings['ui-zoom']` / `ccstudio:setting` イベント（アプリが注入）。
- Produces: focus-hud 共有バッファ `window.top.__ccStudioFocusLog` への `UZ ` プレフィックス行（Task 3 の実機検証がこのログを読む）。

- [ ] **Step 1: プラグイン本体を作成**

以下の内容で `plugins/ui-zoom.js` を新規作成する（全文）:

```js
// ==CCStudioPlugin==
// @name        ui-zoom
// @version     0.1.0
// @description Shrink the workbench chrome via CSS zoom while keeping webview content (chat etc.) at 1x.
// @description:ja workbench の外枠 UI を CSS zoom で縮小し、チャット等の文字サイズは等倍に保つ。
// @run-at      document-start
// @all-frames  true
// @setting     enabled boolean true 外枠 UI（アクティビティバー等）を縮小表示する
// @setting:ja  enabled 外枠 UI（アクティビティバー等）を縮小表示する
// @setting     diag boolean true 診断ログを focus-hud に出す
// @setting:ja  diag 診断ログを focus-hud に出す
// ==/CCStudioPlugin==
// ui-zoom.js — CC Studio プラグイン。
//
//   スマホ縦画面ではアクティビティバー等の外枠 UI が横幅を食う。window.zoomLevel は Electron 専用で
//   code-server Web 版では効かないため、トップフレームへ CSS zoom を注入して外枠ごと縮小する
//   （transform と違いレイアウトごと縮むので、空いた幅にサイドバー/エディタが詰まる）。
//
//   CSS zoom は iframe 内へ継承される（css-viewport 標準, Chromium 128+）。チャット等のコンテンツ
//   フレーム（＝自文書に iframe を持たない葉フレーム）は currentCSSZoom で継承倍率を実測し、逆倍率を
//   掛けて等倍へ戻す。実測ベースなので、継承されない環境では補正ゼロ（誤って拡大しない）に倒れる。
//   iframe を抱える中間ラッパーフレームは何もしない。ロード途中で iframe が現れたら（＝実は中間
//   フレームだった）補正を解除する。
//
//   フレーム判定は構造ルールのみ（クラス名非依存）。倍率 Z はファイル先頭定数、変更は版数 bump。
//
//   設計: docs/specs/2026-07-22-ui-zoom-plugin-design.md
(function () {
  'use strict';
  if (window.__ccUiZoom) return;          // フレームごとに 1 度だけ武装
  window.__ccUiZoom = true;

  var NAME = 'ui-zoom';
  var Z = 0.75;                           // 外枠縮小倍率（チューニングは @version bump とセットで変更）
  var POLL_MS = 1000;                     // 低頻度の自己校正（トップのトグル追従・iframe 出現検知の保険）
  var EPS = 0.001;
  var HUD_MSG = 'cc-uz-hud';              // クロスオリジンフレーム → top へのログ中継種別

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }

  // ---- 設定 ----
  function setting(key, dflt) {
    try { var s = window.__ccPluginSettings && window.__ccPluginSettings[NAME]; if (s && typeof s[key] === 'boolean') return s[key]; }
    catch (_) {}
    return dflt;
  }
  function enabled() { return setting('enabled', true); }
  function diagOn() { return setting('diag', true); }

  // ---- HUD ログ: focus-hud 共有バッファへ 'UZ ' プレフィックスで（変化時のみ・低量）。
  //   クロスオリジン(webview)フレームは window.top へ直書きできないので postMessage で top へ中継する。
  function pushShared(line) {
    try {
      var t = window.top;
      var a = t.__ccStudioFocusLog || (t.__ccStudioFocusLog = []);
      if (a[a.length - 1] === line) return;
      a.push(line); while (a.length > 200) a.shift();
    } catch (_) {}
  }
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (m && m.k === HUD_MSG && typeof m.log === 'string') pushShared(m.log);
      }, false);
    } catch (_) {}
  }
  var lastLog = '';
  function emitLog(s) {
    if (!diagOn()) return;
    var line = 'UZ ' + s;
    if (line === lastLog) return; lastLog = line;
    if (isTop) { pushShared(line); return; }
    try { window.top.__ccStudioFocusLog.length; pushShared(line); }   // 同一オリジンなら直書き
    catch (_) {
      try { window.top.postMessage({ k: HUD_MSG, log: line }, '*'); }
      catch (__) { try { console.debug('[cc-' + NAME + ']', s); } catch (___) {} }
    }
  }

  // ---- 役割判定・倍率適用 ----
  function hasIframe() {
    try { return !!document.querySelector('iframe,frame'); } catch (_) { return true; }
  }
  // documentElement の実効 zoom（自分に掛けた分も含む積）。API 未実装なら null。
  function effZoom() {
    try {
      var de = document.documentElement;
      if (de && typeof de.currentCSSZoom === 'number') return de.currentCSSZoom;
    } catch (_) {}
    return null;
  }

  // トップ: enabled に応じて Z を適用/除去するだけ。
  function applyTop() {
    try {
      var de = document.documentElement; if (!de) return;
      var want = enabled() ? String(Z) : '';
      if (de.style.zoom !== want) {
        de.style.zoom = want;
        emitLog('top zoom=' + (want || '1'));
      }
    } catch (_) {}
  }

  // 非トップ: 葉フレームなら継承倍率を実測して逆倍率で等倍へ。中間フレームなら補正解除。
  //   own = 自分が掛けている zoom（初期 1）。継承分 = currentCSSZoom / own。
  //   enabled は読まない: OFF でトップが zoom を外せば継承が 1 に戻り、次の校正で補正も自然に消える。
  var own = 1;
  var apiLogged = false;
  function applyFrame() {
    try {
      var de = document.documentElement; if (!de) return;
      if (hasIframe()) {                  // 実は中間ラッパーフレームだった → 補正解除して以後何もしない
        if (own !== 1) { de.style.zoom = ''; own = 1; emitLog('wrapper: comp removed'); }
        return;
      }
      var cz = effZoom();
      if (cz === null) {
        if (!apiLogged) { apiLogged = true; emitLog('leaf: no currentCSSZoom API (no comp)'); }
        return;                           // 補正しない＝全体縮小のまま（拡大方向には倒れない）
      }
      var inherited = cz / own;
      if (!isFinite(inherited) || inherited <= 0) return;
      var k = 1 / inherited;
      if (Math.abs(k - own) <= EPS) return;
      if (Math.abs(k - 1) <= EPS) { de.style.zoom = ''; own = 1; }
      else { de.style.zoom = String(k); own = k; }
      emitLog('leaf inh=' + inherited.toFixed(3) + ' comp=' + own.toFixed(3));
    } catch (_) {}
  }

  function tick() { if (isTop) applyTop(); else applyFrame(); }

  // ---- 起動 ----
  function start() {
    tick();                               // document-start で即適用（フラッシュ防止）
    try { window.addEventListener('ccstudio:setting', function (e) {
      var d = e && e.detail;
      if (d && d.plugin === NAME) tick(); // enabled/diag のライブ反映
    }, false); } catch (_) {}
    try { new MutationObserver(tick).observe(document.documentElement, { subtree: true, childList: true }); } catch (_) {}
    try { setInterval(tick, POLL_MS); } catch (_) {}
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
```

- [ ] **Step 2: 構文検査**

Run: `node --check plugins/ui-zoom.js`
Expected: 出力なし・exit 0

- [ ] **Step 3: コミット**

```bash
git add plugins/ui-zoom.js
git commit -m "feat(plugins): ui-zoom v0.1.0 外枠 CSS zoom 縮小＋コンテンツフレーム等倍戻し"
```

---

### Task 2: plugins/README.md の本数更新

**Files:**
- Modify: `plugins/README.md:4-7`（プラグイン本数 9→10）

**Interfaces:**
- Consumes/Produces: なし（ドキュメントのみ）。

- [ ] **Step 1: 本数を更新**

`plugins/README.md` の 2 箇所を書き換える:

- `単体の `.js` ファイル。このディレクトリの 9 本がその本体。` → `… 10 本がその本体。`
- `ここでは 9 本から抽出した共通規約をまとめる` → `ここでは 10 本から抽出した共通規約をまとめる`

- [ ] **Step 2: コミット**

```bash
git add plugins/README.md
git commit -m "docs(plugins): README の本数を 10 本へ更新（ui-zoom 追加）"
```

（注: rc-indicator ブランチも同じ行を 10 本化しており合流時に 1 行競合し得る。合流側で 11 本に直す。）

---

### Task 3: 実機検証とチューニング

**Files:**
- Modify: `docs/specs/2026-07-22-ui-zoom-plugin-design.md`（末尾に「12. 実機検証結果」節を追記）
- Modify: `plugins/ui-zoom.js`（Z チューニングが要る場合のみ・@version bump とセット）

**Interfaces:**
- Consumes: Task 1 の DIAG ログ（`UZ top zoom=…` / `UZ leaf inh=… comp=…`）。focus-hud プラグインを ON にして読む。

- [ ] **Step 1: プラグインを実機に取り込む**

プラグイン管理スクリーンの「＋ Add plugin」で `plugins/ui-zoom.js` をインポートし ON。focus-hud も ON。対象スクリーンをリロード。

- [ ] **Step 2: 継承の有無と縮小効果を確認（最重要）**

focus-hud で以下を確認:
- `UZ top zoom=0.75` が出る（トップ適用）。
- `UZ leaf inh=0.750 comp=1.333` が出る（**zoom の iframe 継承あり＋逆倍率適用**）。
- 見た目: アクティビティバー・タブ・ステータスバーが縮小、チャット文字は等倍のまま。

`UZ leaf: no currentCSSZoom API` が出た場合: WebView が古い。全体縮小のまま動くことだけ確認し、spec §9 のリスク欄へ実機の WebView バージョンを記録して打ち切り（補正は将来課題）。

- [ ] **Step 3: 操作系のスモーク確認**

- サイドバー/パネルの開閉・境界ドラッグが正常。
- rc-indicator 等の他プラグインのタップ・長押しが正常（rc-indicator ブランチ環境なら）。
- ⚙ で enabled を OFF → 即座に等倍へ復帰し、チャットが**拡大表示にならない**こと。ON へ戻して再縮小。
- リロード → 設定どおりの状態で立ち上がる。

- [ ] **Step 4: 倍率チューニング（必要時のみ）**

0.75 で細さ不足/文字が潰れる等あれば `Z` を変更（0.7〜0.85 目安）し、`@version` を 0.1.1 へ bump。再取り込みして Step 2-3 を再確認。

- [ ] **Step 5: 検証結果を spec に追記してコミット**

`docs/specs/2026-07-22-ui-zoom-plugin-design.md` 末尾に追記:

```markdown
## 12. 実機検証結果 (YYYY-MM-DD)

- zoom の iframe 継承: あり/なし（leaf inh=… の実測値）
- 採用倍率 Z=…（見た目の妥当性）
- 操作系（サッシ・他プラグイン・ライブ OFF→ON・リロード）: 結果
```

```bash
git add docs/specs/2026-07-22-ui-zoom-plugin-design.md plugins/ui-zoom.js
git commit -m "docs(specs): ui-zoom 実機検証結果を追記"
```

---

## Self-Review 済み事項

- spec §1-§9 の要求は Task 1（本体・診断・エラー処理）/ Task 2（規約適合の README）/ Task 3（§10 テスト）で網羅。
- 逆倍率は `currentCSSZoom / own` の実測ベースで、二重補正・過剰拡大が起きない（spec §5.2 と一致）。
- 葉判定の遷移（中間フレームに後から iframe が入る）は MutationObserver＋1s ポーリングで収束（spec §4 と一致）。
