# rc-indicator プラグイン実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RC バナーを CSS 非表示にし、⋮ ボタン直下の「R」ピルで RC 状態を常時表示、長押しで手動トグルする単体プラグイン `plugins/rc-indicator.js` を作る。

**Architecture:** `@all-frames true × document-start` の単一 IIFE。composer フレーム側がバナー検知（＝RC 状態検知）・非表示・トグル送信を担い、top フレーム側がピル描画と長押し判定を担う。フレーム間は postMessage（composer→top: 状態/拒否/HUD ログ、top→全フレーム: トグル依頼の再帰ブロードキャスト）。

**Tech Stack:** 素の ES5 風 JavaScript（既存プラグインと同一様式）。ビルド・依存なし。

**仕様書:** `docs/specs/2026-07-21-rc-indicator-plugin-design.md`（本計画の唯一の典拠）

## Global Constraints

- 既存プラグイン様式に従う: 'use strict' IIFE、`window.__ccRcIndicator` で冪等、全 DOM 操作 try/catch、クラス名依存禁止（許容済み例外: `sendButton`/`stopIcon` の部分一致は state-observer 実績箇所）。
- バナーの × ボタンに触れるコードを書かない（クリック＝RC 切断）。`click()` を発するのは送信ボタンとテスト用途のみ。
- 自動テスト基盤なし。各タスクの機械検証は `node --check` の構文チェックのみ。挙動検証は最終タスクの実機チェックリスト。
- 設定キー: `hideBanner` / `indicator` / `holdToggle` / `diag`（boolean、既定は順に true/true/true/false）。
- 定数（仕様確定値）: POLL_MS=700, HOLD_MS=600, DEBOUNCE_MS=3000, STALE_MS=6000, SUBMIT_DELAY_MS=300。
- コミットは公開リポ前提の日本語 conventional commit（例: `feat(plugins): ...`）。

---

### Task 1: プラグイン骨格（メタヘッダ・設定・診断中継・起動ループ）

**Files:**
- Create: `plugins/rc-indicator.js`

**Interfaces:**
- Produces: `setting(key,dflt)` / `hideOn()` / `indOn()` / `holdOn()` / `diagOn()`、`emitLog(s)`（'RI ' プレフィックスで focus-hud 共有バッファへ、クロスオリジンは top 中継）、`isTop`、定数群、`start()`（`tick()` を 700ms ポーリング＋ MutationObserver の 150ms デバウンス）。`tick()` と top 用 `renderPill()` は後続タスクが実装（本タスクでは空関数）。

- [ ] **Step 1: ファイル作成**

```js
// ==CCStudioPlugin==
// @name        rc-indicator
// @version     0.1.0
// @description Hide the persistent "Remote Control is active" banner (RC stays on), and show a compact "R" pill under the ⋮ button instead; long-press the pill to toggle RC manually.
// @description:ja 常時表示の「Remote Control is active」バナーを非表示にし（RC は維持）、代わりに ⋮ ボタン直下の「R」ピルで状態表示。ピルの長押しで手動オン/オフ。
// @run-at      document-start
// @all-frames  true
// @setting     hideBanner boolean true RCバナーを隠す
// @setting:ja  hideBanner RCバナーを隠す（RC接続は維持）
// @setting     indicator boolean true 「R」ピルでRC状態を表示
// @setting:ja  indicator 「R」ピルでRC状態を表示
// @setting     holdToggle boolean true ピルの長押しでRCを手動オン/オフ
// @setting:ja  holdToggle ピルの長押しでRCを手動オン/オフ
// @setting     diag boolean false 診断ログを focus-hud に出す
// @setting:ja  diag 診断ログを focus-hud に出す
// ==/CCStudioPlugin==
// rc-indicator.js — RC バナーを CSS で非表示（DOM は残る＝RC 接続に無影響）にし、
// 「バナーが DOM に存在するか」を RC 状態の検知器として流用して ⋮ ボタン直下の「R」ピルに表示する。
// ピルの長押し（600ms・フィル表示）で /remote-control を送信し手動トグル。× ボタンには一切触れない
// （クリック＝RC 切断のため）。設計: docs/specs/2026-07-21-rc-indicator-plugin-design.md
(function () {
  'use strict';
  if (window.__ccRcIndicator) return;   // フレームごとに 1 度だけ武装
  window.__ccRcIndicator = true;

  var NAME = 'rc-indicator';
  var BANNER_TEXT = 'Remote Control is active';
  var CMD = '/remote-control';
  var COMPOSER_SELS = ['[aria-label="Message input"]', '[role="textbox"][aria-multiline="true"]'];
  var SEND_BTN_SEL = 'button[class*="sendButton"]';
  var STOP_ICON_SEL = 'button[class*="sendButton"] [class*="stopIcon"]';   // 在=生成中（state-observer と同一判定）
  var TRANSCRIPT_SEL = '[data-testid*="message"]';   // 会話本文（誤ヒット除外）
  var MARK = 'data-cc-ri-banner';
  var MSG_STATE = 'cc-ri-state';
  var MSG_TOGGLE = 'cc-ri-toggle';
  var MSG_DENY = 'cc-ri-deny';
  var MSG_HUD = 'cc-ri-hud';
  var POLL_MS = 700;
  var HB_TICKS = 3;            // 状態ハートビートの送信間隔（tick 数 ≒ 2.1s）
  var STALE_MS = 6000;         // top 側: 報告途絶でピルを隠すまで
  var HOLD_MS = 600;           // 長押し発火時間
  var DEBOUNCE_MS = 3000;      // トグル連続送信の抑止
  var SUBMIT_DELAY_MS = 300;   // 文字挿入〜送信までの待ち

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }

  // ---- 設定 ----
  function setting(key, dflt) {
    try { var s = window.__ccPluginSettings && window.__ccPluginSettings[NAME]; if (s && typeof s[key] === 'boolean') return s[key]; }
    catch (_) {}
    return dflt;
  }
  function hideOn() { return setting('hideBanner', true); }
  function indOn() { return setting('indicator', true); }
  function holdOn() { return setting('holdToggle', true); }
  function diagOn() { return setting('diag', false); }

  // ---- 診断: focus-hud 共有バッファへ 'RI ' プレフィックスで（少量のため専用バッファ無し）。
  //   クロスオリジンフレームは window.top へ直書きできないので postMessage 中継（rc-autoconnect と同型）。
  function pushShared(line) {
    try {
      var a = window.__ccStudioFocusLog || (window.__ccStudioFocusLog = []);
      if (a[a.length - 1] === line) return;
      a.push(line); while (a.length > 200) a.shift();
    } catch (_) {}
  }
  var lastLog = '';
  function emitLog(s) {
    if (!diagOn()) return;
    var line = 'RI ' + s;
    if (line === lastLog) return; lastLog = line;
    if (isTop) { pushShared(line); return; }
    try { window.top.postMessage({ k: MSG_HUD, log: line }, '*'); } catch (_) {}
  }

  // ---- 後続タスクが実装する本体（Task 2: composer 側 / Task 3: top 側） ----
  function tick() {}
  function renderPill() {}

  // ---- 起動 ----
  var pending = false;
  function scheduleTick() {
    if (pending) return; pending = true;
    setTimeout(function () { pending = false; tick(); }, 150);   // 変異の嵐を 150ms に集約
  }
  var started = false;
  function start() {
    if (started) return; started = true;
    try { new MutationObserver(scheduleTick).observe(document.documentElement || document.body, { subtree: true, childList: true }); } catch (_) {}
    setInterval(tick, POLL_MS);
    if (isTop) setInterval(renderPill, 2000);   // 報告途絶→非表示の劣化はポーリングで拾う
    tick();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    try { if (document.documentElement) start(); } catch (_) {}
  } else {
    start();
  }
})();
```

- [ ] **Step 2: 構文チェック**

Run: `node --check plugins/rc-indicator.js`
Expected: 出力なし（exit 0）

- [ ] **Step 3: コミット**

```bash
git add plugins/rc-indicator.js
git commit -m "feat(plugins): rc-indicator 骨格（メタ・設定・診断中継・起動ループ）"
```

---

### Task 2: バナー検知・非表示・RC 状態報告（composer フレーム側）

**Files:**
- Modify: `plugins/rc-indicator.js`（Task 1 の `function tick() {}` を置き換え、直前に本体関数群を挿入）

**Interfaces:**
- Consumes: Task 1 の定数・`setting` 系・`emitLog`。
- Produces: `findComposer()` → Element|null、`composerText(el)` → string、`findBanner(composer)` → Element|null（認定時に `data-cc-ri-banner` 属性付与）、`applyHide(banner)`（hideBanner 設定に応じ display:none/復元）、`tick()`（実体）。top へ `{k:'cc-ri-state', active:boolean}` を変化時＋3 tick ごとに postMessage。`ccstudio:setting` リスナー（hideBanner のライブ反映）。

- [ ] **Step 1: `function tick() {}` を以下で置き換える**

```js
  // ---- composer フレーム側: バナー検知＝RC 状態検知 ----
  function findComposer() {
    for (var i = 0; i < COMPOSER_SELS.length; i++) {
      try { var el = document.querySelector(COMPOSER_SELS[i]); if (el) return el; } catch (_) {}
    }
    return null;
  }
  function composerText(el) { try { return (el.textContent || el.value || '').trim(); } catch (_) { return ''; } }

  // バナー容器の特定（設計 §5）。認定済み要素が生きていれば再走査しない。
  //   1) TreeWalker で BANNER_TEXT を含むテキストノードを探す（transcript サブツリーは REJECT で丸ごと除外）
  //   2) composer を含まない最上位の祖先へ登る（composer 巻き込み事故の構造的防止）
  //   3) claude.ai リンクか button を内包することを確認（欠けば誤ヒットとして無視）
  function findBanner(composer) {
    var marked = null;
    try { marked = document.querySelector('[' + MARK + ']'); } catch (_) {}
    if (marked && document.contains(marked)) return marked;
    if (!document.body) return null;
    var walker;
    try {
      walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (n.nodeType === 1) {
            try { if (n.matches && n.matches(TRANSCRIPT_SEL)) return NodeFilter.FILTER_REJECT; } catch (_) {}
            return NodeFilter.FILTER_SKIP;
          }
          return (n.nodeValue && n.nodeValue.indexOf(BANNER_TEXT) >= 0) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      });
    } catch (_) { return null; }
    var node;
    while ((node = walker.nextNode())) {
      var el = node.parentElement;
      if (!el) continue;
      var cont = el;
      while (cont.parentElement && cont.parentElement !== document.body && !cont.parentElement.contains(composer)) cont = cont.parentElement;
      if (cont.contains(composer)) continue;   // 安全弁: composer を巻き込む容器は絶対に採らない
      var parts = false;
      try { parts = !!(cont.querySelector('a[href*="claude.ai"]') || cont.querySelector('button')); } catch (_) {}
      if (!parts) continue;
      try { cont.setAttribute(MARK, '1'); } catch (_) {}
      emitLog('banner found');
      return cont;
    }
    return null;
  }

  function applyHide(banner) {
    if (!banner) return;
    try {
      if (hideOn()) {
        if (banner.style.display !== 'none') { banner.style.display = 'none'; emitLog('banner hidden'); }
      } else if (banner.style.display === 'none') {
        banner.style.removeProperty('display'); emitLog('banner restored');
      }
    } catch (_) {}
  }

  // ---- RC 状態を top へ報告（変化時 + ハートビート） ----
  var tickCount = 0, lastActive = null;
  function report(active) {
    try { window.top.postMessage({ k: MSG_STATE, active: !!active }, '*'); } catch (_) {}
  }
  function tick() {
    var composer = findComposer();
    if (!composer) return;               // composer 不在フレームは対象外（top も通常ここで抜ける）
    var banner = findBanner(composer);
    applyHide(banner);
    var active = !!banner;
    tickCount++;
    if (active !== lastActive || tickCount % HB_TICKS === 0) { lastActive = active; report(active); }
  }

  // ---- 設定のライブ反映（hideBanner の ON/OFF 即時切替） ----
  try {
    window.addEventListener('ccstudio:setting', function (e) {
      var d = e && e.detail;
      if (!d || d.plugin !== NAME) return;
      if (d.key === 'hideBanner') { var c = findComposer(); if (c) applyHide(findBanner(c)); }
    });
  } catch (_) {}
```

- [ ] **Step 2: 構文チェック**

Run: `node --check plugins/rc-indicator.js`
Expected: 出力なし（exit 0）

- [ ] **Step 3: 検知ロジックの卓上テスト（jsdom 不使用・Node 単体の簡易 DOM もどきは作らない）**

自動テスト基盤が無いため、ここでは grep による整合確認のみ:

Run: `grep -c "click()" plugins/rc-indicator.js`
Expected: `0`（この時点で click を発するコードが無い＝× 誤爆の余地なし）

- [ ] **Step 4: コミット**

```bash
git add plugins/rc-indicator.js
git commit -m "feat(plugins): rc-indicator バナー検知・CSS非表示・RC状態報告"
```

---

### Task 3: 「R」ピル描画と状態反映（top フレーム側）

**Files:**
- Modify: `plugins/rc-indicator.js`（Task 1 の `function renderPill() {}` を置き換え、top 用リスナーを追加）

**Interfaces:**
- Consumes: Task 1 の `isTop`・`pushShared`・定数、Task 2 の `MSG_STATE`。
- Produces: `ensurePill()` → HTMLButtonElement|null（`#cc-ri-pill`、フィル `#cc-ri-fill`・ラベル内包）、`renderPill()`（実体: indicator 設定・報告鮮度・active で表示/色を決定）、`denyBlink()`、`lastReport` 変数、top の message リスナー（MSG_STATE / MSG_DENY / MSG_HUD）。`holdStart`/`holdCancel` は Task 4 が実装するため、このタスクでは pill にリスナーを付けない。

- [ ] **Step 1: `function renderPill() {}` を以下で置き換える**

```js
  // ---- top フレーム側: 「R」ピル（設計 §6。⋮ ボタン #ccstudio-menu-btn の直下に固定配置） ----
  var pill = null, fill = null;
  var lastReport = { active: false, t: 0 };
  var reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) {}

  function ensureStyles() {
    if (document.getElementById('cc-ri-style')) return;
    var st = document.createElement('style'); st.id = 'cc-ri-style';
    st.textContent =
      '@keyframes ccRiDeny{0%,100%{opacity:1}50%{opacity:.25}}' +
      '#cc-ri-pill{position:fixed;left:0;bottom:calc(22% - 42px);width:30px;height:34px;border:0;padding:0;' +
      'border-radius:0 10px 10px 0;z-index:2147483647;color:#9aa3b2;background:#3a4150;' +
      'font:bold 15px sans-serif;display:none;align-items:center;justify-content:center;overflow:hidden;' +
      'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;cursor:pointer;}' +
      '#cc-ri-pill.cc-ri-on{color:#fff;background:linear-gradient(180deg,#34C77B,#1e9a58);box-shadow:2px 0 10px rgba(52,199,123,.45);}' +
      '#cc-ri-pill.cc-ri-deny{animation:ccRiDeny .18s 3;}' +
      '#cc-ri-fill{position:absolute;left:0;bottom:0;width:100%;height:0;background:rgba(255,255,255,.28);pointer-events:none;}' +
      '#cc-ri-label{position:relative;}';
    try { (document.head || document.documentElement).appendChild(st); } catch (_) {}
  }
  function ensurePill() {
    if (pill && document.contains(pill)) return pill;
    if (!document.body) return null;
    ensureStyles();
    pill = document.createElement('button');
    pill.id = 'cc-ri-pill';
    pill.type = 'button';
    fill = document.createElement('div'); fill.id = 'cc-ri-fill';
    var label = document.createElement('span'); label.id = 'cc-ri-label'; label.textContent = 'R';
    pill.appendChild(fill); pill.appendChild(label);
    try { document.body.appendChild(pill); } catch (_) { pill = null; }
    return pill;
  }
  function renderPill() {
    if (!isTop) return;
    var p = ensurePill();
    if (!p) return;
    var fresh = (Date.now() - lastReport.t) < STALE_MS;
    if (!indOn() || !fresh) { p.style.display = 'none'; return; }   // 非チャット画面・報告途絶は非表示
    p.style.display = 'flex';
    if (lastReport.active) p.classList.add('cc-ri-on'); else p.classList.remove('cc-ri-on');
  }
  function denyBlink() {
    if (!pill) return;
    try { pill.classList.remove('cc-ri-deny'); void pill.offsetWidth; pill.classList.add('cc-ri-deny'); } catch (_) {}
  }

  // ---- top: composer フレームからの報告受信 ----
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (!m) return;
        if (m.k === MSG_STATE) { lastReport = { active: !!m.active, t: Date.now() }; renderPill(); }
        else if (m.k === MSG_DENY) { denyBlink(); emitLog('deny ' + (m.reason || '')); }
        else if (m.k === MSG_HUD && typeof m.log === 'string') pushShared(m.log);
      }, false);
    } catch (_) {}
  }
```

- [ ] **Step 2: ccstudio:setting リスナーに indicator のライブ反映を足す**

Task 2 で追加したリスナーの `if (d.key === 'hideBanner') ...` 行の直後に追加:

```js
      if (isTop && (d.key === 'indicator' || d.key === 'holdToggle')) renderPill();
```

- [ ] **Step 3: 構文チェック**

Run: `node --check plugins/rc-indicator.js`
Expected: 出力なし（exit 0）

- [ ] **Step 4: コミット**

```bash
git add plugins/rc-indicator.js
git commit -m "feat(plugins): rc-indicator Rピル描画とRC状態のライブ反映（top側）"
```

---

### Task 4: 長押しトグル（top: 長押し判定＋ブロードキャスト / composer: ガード付き送信）

**Files:**
- Modify: `plugins/rc-indicator.js`

**Interfaces:**
- Consumes: Task 2 の `findComposer`/`composerText`、Task 3 の `ensurePill`/`fill`/`reduced`/`denyBlink`、定数 HOLD_MS/DEBOUNCE_MS/SUBMIT_DELAY_MS、MSG_TOGGLE/MSG_DENY。
- Produces: `holdStart(e)`/`holdCancel()`/`resetFill()`/`broadcast(win,msg)`（top 側）、`handleToggle()`/`sendCommand(composer)`/`denyReply(reason)`（composer 側）、全フレームの MSG_TOGGLE リスナー。

- [ ] **Step 1: composer 側のトグル処理を Task 2 のコードブロック末尾（ccstudio:setting リスナーの前）に追加**

```js
  // ---- composer フレーム側: トグル依頼の実行（設計 §7 ガード） ----
  var lastSendAt = 0;
  function denyReply(reason) {
    emitLog('toggle deny: ' + reason);
    try { window.top.postMessage({ k: MSG_DENY, reason: reason }, '*'); } catch (_) {}
  }
  function handleToggle() {
    var composer = findComposer();
    if (!composer) return;                                   // 非 composer フレームは黙って無視
    if (!holdOn()) return;                                   // 設定 OFF（top 側でも弾くが二重で守る）
    if (composerText(composer)) { denyReply('draft'); return; }        // 下書きを壊さない
    var busy = false;
    try { busy = !!document.querySelector(STOP_ICON_SEL); } catch (_) {}
    if (busy) { denyReply('busy'); return; }                 // 停止ボタン誤爆の構造的回避
    var now = Date.now();
    if (now - lastSendAt < DEBOUNCE_MS) { denyReply('debounce'); return; }
    lastSendAt = now;
    sendCommand(composer);
  }
  // 送信手順は rc-autoconnect の実測確定手順を踏襲（insertText → 送信ボタンのクリックのみ。
  // ボタンが在るのに Enter も撃つと二重送信になる。未検出時のみ Enter フォールバック）。
  function sendCommand(composer) {
    try { composer.focus(); } catch (_) {}
    var inserted = false;
    try { inserted = document.execCommand('insertText', false, CMD); } catch (_) {}
    if (!inserted) {
      try {
        composer.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: CMD, bubbles: true, cancelable: true }));
        composer.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: CMD, bubbles: true }));
      } catch (_) {}
    }
    emitLog('toggle insert exec=' + (inserted ? 1 : 0));
    setTimeout(function () {
      var btn = null; try { btn = document.querySelector(SEND_BTN_SEL); } catch (_) {}
      if (btn) {
        try { btn.click(); } catch (_) {}
        emitLog('toggle submit btn');
      } else {
        var tgt = composer; try { tgt = document.activeElement || composer; } catch (_) {}
        ['keydown', 'keypress', 'keyup'].forEach(function (type) {
          try { tgt.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); } catch (_) {}
        });
        emitLog('toggle submit enter');
      }
    }, SUBMIT_DELAY_MS);
  }
  // 全フレームで依頼を受ける（composer 不在なら handleToggle が即 return）
  try {
    window.addEventListener('message', function (e) {
      var m = e && e.data;
      if (m && m.k === MSG_TOGGLE) handleToggle();
    }, false);
  } catch (_) {}
```

- [ ] **Step 2: top 側の長押し判定を Task 3 のコードブロック（`denyBlink` の後）に追加し、`ensurePill` にリスナー登録を足す**

`ensurePill()` 内の `pill.appendChild(fill); pill.appendChild(label);` の直後に追加:

```js
    pill.addEventListener('pointerdown', holdStart);
    pill.addEventListener('pointerup', holdCancel);
    pill.addEventListener('pointercancel', holdCancel);
    pill.addEventListener('pointerleave', holdCancel);
    pill.addEventListener('contextmenu', function (ev) { try { ev.preventDefault(); } catch (_) {} });
    pill.addEventListener('click', function (ev) { try { ev.preventDefault(); } catch (_) {} });   // 単タップは無反応
```

`denyBlink` 関数の後に追加:

```js
  // ---- top: 長押し判定（設計 §7。押下中フィルが満ちる＝離せばキャンセル/満ちれば実行の可視化） ----
  var holdTimer = null;
  function resetFill() { if (fill) { try { fill.style.transition = 'none'; fill.style.height = '0'; } catch (_) {} } }
  function holdStart(e) {
    try { e.preventDefault(); } catch (_) {}
    if (!holdOn() || holdTimer) return;
    if (!reduced && fill) { try { fill.style.transition = 'height ' + HOLD_MS + 'ms linear'; fill.style.height = '100%'; } catch (_) {} }
    holdTimer = setTimeout(function () {
      holdTimer = null; resetFill();
      emitLog('hold fire');
      broadcast(window, { k: MSG_TOGGLE });
    }, HOLD_MS);
  }
  function holdCancel() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    resetFill();
  }
  // クロスオリジンでも window.length と添字アクセスは仕様上許可されるため、フレームツリーを再帰配信。
  function broadcast(win, msg) {
    try { win.postMessage(msg, '*'); } catch (_) {}
    var n = 0; try { n = win.length; } catch (_) {}
    for (var i = 0; i < n; i++) { try { broadcast(win[i], msg); } catch (_) {} }
  }
```

- [ ] **Step 3: 構文チェックと × 安全確認**

Run: `node --check plugins/rc-indicator.js && grep -n "\.click()" plugins/rc-indicator.js`
Expected: 構文エラーなし。`.click()` は送信ボタン（`btn.click()`）の 1 箇所のみ。

- [ ] **Step 4: コミット**

```bash
git add plugins/rc-indicator.js
git commit -m "feat(plugins): rc-indicator 長押しトグル（フィル可視化・下書き/生成中/連打ガード）"
```

---

### Task 5: プラグイン規約 README の更新

**Files:**
- Modify: `plugins/README.md`（冒頭の本数記述 2 箇所: 「このディレクトリの 9 本がその本体」「ここでは 9 本から抽出した共通規約」→ 10 本）

**Interfaces:**
- Consumes: なし。
- Produces: なし（文書のみ）。

- [ ] **Step 1: 本数を 9→10 に更新**

`plugins/README.md` の 2 箇所の「9 本」を「10 本」に置換する。

- [ ] **Step 2: 差分確認**

Run: `grep -n "10 本" plugins/README.md`
Expected: 2 行ヒット。「9 本」の残存が `grep -c "9 本" plugins/README.md` で 0。

- [ ] **Step 3: コミット**

```bash
git add plugins/README.md
git commit -m "docs(plugins): プラグイン本数を 10 に更新（rc-indicator 追加）"
```

---

### Task 6: 実機検証（ユーザー実施・チェックリスト）

**Files:** なし（検証のみ。修正が出たら該当タスクへ戻り `@version` を bump）

実機（CC Studio アプリ）でプラグイン管理スクリーンから `rc-indicator.js` をインポートして ON にし、仕様 §12 を検証する:

- [ ] hideBanner ON: RC 接続してもバナーが見えない。モバイルアプリから操作できる（RC 生存確認）
- [ ] 設定で hideBanner OFF → その場でバナー再表示。ON → 再度消える（リロード不要）
- [ ] indicator: RC 有効で R がグリーン、切断でグレー。チャット以外のスクリーンではピル非表示。リロード直後はグレー
- [ ] holdToggle: 未接続で長押し → RC 接続（R グリーン化）。接続中に長押し → 切断。単タップ・途中で離すと無反応
- [ ] 下書きあり/生成中は長押し完了しても送信されず明滅
- [ ] チャットで「Remote Control is active」を含む発言をしても本文が隠れない
- [ ] rc-autoconnect 併用: 新規セッションで自動接続 → バナー非表示・R グリーンまで一連動作
- [ ] 問題があれば diag を ON にし、focus-hud の `RI` 行をスクリーンショットで共有

検証完了後: `superpowers:finishing-a-development-branch` で main へのマージを判断。

## Self-Review 済み

- 仕様 §1〜§13 の各要件は Task 1〜6 のいずれかに対応（§5→T2、§6→T3、§7→T4、§8→T1、§9→T1/T2、§13→T5）。
- プレースホルダなし。型・関数名は各タスクの Interfaces で整合（`findComposer`/`renderPill`/`broadcast` 等）。
- クロスオリジンブロードキャスト（§11 リスク）は T6 の実機検証で確認。不達なら composer 側ポーリング型へ切替（その場合は本計画を改訂）。
