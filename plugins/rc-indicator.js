// ==CCStudioPlugin==
// @name        rc-indicator
// @version     0.6.0
// @description Hide the persistent "Remote Control is active" banner (RC stays on), and show a compact "R" pill at the left edge of the chat panel instead; long-press the pill (fill gauge) to toggle RC manually.
// @description:ja 常時表示の「Remote Control is active」バナーを非表示にし（RC は維持）、代わりにチャットパネル左端の「R」ピルで状態表示。ピルの長押し（ゲージが満ちたら発火）で手動オン/オフ。
// @run-at      document-start
// @all-frames  true
// @setting     hideBanner boolean true RCバナーを隠す
// @setting:ja  hideBanner RCバナーを隠す（RC接続は維持）
// @setting     indicator boolean true 「R」ピルでRC状態を表示
// @setting:ja  indicator 「R」ピルでRC状態を表示
// @setting     holdToggle boolean true ピルのタップでRCを手動オン/オフ
// @setting:ja  holdToggle ピルのタップでRCを手動オン/オフ
// @setting     diag boolean false 診断ログを focus-hud に出す
// @setting:ja  diag 診断ログを focus-hud に出す
// ==/CCStudioPlugin==
// rc-indicator.js — RC バナーを CSS で非表示（DOM は残る＝RC 接続に無影響）にし、
// 「バナーが DOM に存在するか」を RC 状態の検知器として流用して「R」ピルに表示する。
// ピルの長押し（600ms・フィルが満ちたら発火、途中で離すとキャンセル）で /remote-control を送信し
// 手動トグル。× ボタンには一切触れない（クリック＝RC 切断）。
//
// v0.5: 検知・ピル描画・タップ・送信の全ロジックを chat フレーム内に集約した
// （rc-autoconnect と同じ「フレーム内完結」パターン）。0.3/0.4 の top 描画＋postMessage 配達は
// top→フレーム方向の到達が確認できない事象（fire sent>0 なのに recv ゼロ）を解消できなかった。
// フレーム内完結なら配達が存在しないため確実で、ピルは自フレームごと隠れるので
// 「表示中セッションの状態だけを表示」も構造的に満たす。top の役割は HUD ログ中継のみ。
// ピルの位置は画面左端ではなくチャットパネル左端になる（構造上のトレードオフ・許容）。
// 設計: docs/specs/2026-07-21-rc-indicator-plugin-design.md
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
  var TRANSCRIPT_SEL = '[data-testid*="message"]';   // 会話本文（誤ヒット除外の第一段）
  var MARK = 'data-cc-ri-banner';
  var MSG_HUD = 'cc-ri-hud';
  var POLL_MS = 700;
  var HOLD_MS = 600;           // 長押し発火時間（フィルが満ちるまで）
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
  // top: クロスオリジンフレームからの HUD ログ中継（top の役割はこれだけ）
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (m && m.k === MSG_HUD && typeof m.log === 'string') pushShared(m.log);
      }, false);
    } catch (_) {}
  }

  // ---- chat フレーム判定 ----
  function findComposer() {
    for (var i = 0; i < COMPOSER_SELS.length; i++) {
      try { var el = document.querySelector(COMPOSER_SELS[i]); if (el) return el; } catch (_) {}
    }
    return null;
  }
  function composerText(el) { try { return (el.textContent || el.value || '').trim(); } catch (_) { return ''; } }
  // composer だけでは足りない。フォールバックセレクタ [role="textbox"][aria-multiline="true"] は
  // VS Code エディタ(Monaco)にもマッチするため、webview 固有の送信ボタンの存在も要求する。
  function chatFrame() {
    try { return !!document.querySelector(SEND_BTN_SEL); } catch (_) { return false; }
  }

  // ---- バナー検知＝RC 状態検知 ----
  // バナー容器の認定条件（設計 §5）:
  //   - composer を巻き込まない / BANNER_TEXT を含む
  //   - テキスト長 ≤300: 実バナーは 1 行(~80字)。会話履歴に残る RC システム転記（data-testid を
  //     持たず transcript 除外をすり抜ける）を巻き込んだ巨大容器は数千字になるので排除。
  //   - button 内包必須: 実バナーは × ボタンを持つ。転記はリンクだけでボタンが無い。
  function validBanner(cont, composer) {
    try {
      if (!cont || cont.contains(composer)) return false;
      var txt = cont.textContent || '';
      if (txt.indexOf(BANNER_TEXT) < 0) return false;
      if (txt.length > 300) return false;
      if (!cont.querySelector('button')) return false;
      return true;
    } catch (_) { return false; }
  }
  // 認定済み要素は毎回再検証し、外れていたら隠しを解除して認定を剥がす（誤認定の固着防止）。
  function findBanner(composer) {
    var marked = null;
    try { marked = document.querySelector('[' + MARK + ']'); } catch (_) {}
    if (marked && document.contains(marked)) {
      if (validBanner(marked, composer)) return marked;
      try { marked.style.removeProperty('display'); marked.removeAttribute(MARK); emitLog('banner unmark'); } catch (_) {}
    }
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
      if (!validBanner(cont, composer)) continue;
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

  // ---- 「R」ピル（chat フレーム内に描画。フレームごと隠れるので表示中セッションの状態だけが見える） ----
  var pill = null, fill = null;
  var reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) {}

  function ensureStyles() {
    if (document.getElementById('cc-ri-style')) return;
    var st = document.createElement('style'); st.id = 'cc-ri-style';
    st.textContent =
      '@keyframes ccRiDeny{0%,100%{opacity:1}50%{opacity:.25}}' +
      '#cc-ri-pill{position:fixed;left:0;bottom:22%;width:30px;height:68px;border:0;padding:0;' +
      'border-radius:0 10px 10px 0;z-index:2147483647;color:#9aa3b2;background:#3a4150;' +
      'display:none;align-items:center;justify-content:center;overflow:hidden;' +
      'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;cursor:pointer;}' +
      '#cc-ri-pill *{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;}' +
      '#cc-ri-pill.cc-ri-on{color:#fff;background:linear-gradient(180deg,#34C77B,#1e9a58);box-shadow:2px 0 10px rgba(52,199,123,.45);}' +
      '#cc-ri-pill.cc-ri-deny{animation:ccRiDeny .18s 3;}' +
      '#cc-ri-fill{position:absolute;left:0;bottom:0;width:100%;height:0;background:rgba(255,255,255,.28);pointer-events:none;}' +
      '#cc-ri-glyph{position:relative;width:15px;height:22px;pointer-events:none;}';
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
    // 「R」はテキストノードにすると Android の長押しで文字選択が発動するため SVG ストロークで描く
    var SVGNS = 'http://www.w3.org/2000/svg';
    var glyph = document.createElementNS(SVGNS, 'svg');
    glyph.setAttribute('id', 'cc-ri-glyph');
    glyph.setAttribute('viewBox', '5 4 14 20');
    glyph.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', 'M8 22 V6 H13 a4 4 0 0 1 0 8 H8 M13 14 L17 22');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    glyph.appendChild(path);
    pill.appendChild(fill); pill.appendChild(glyph);
    pill.addEventListener('pointerdown', pressStart);
    pill.addEventListener('pointerup', pressEnd);
    pill.addEventListener('pointercancel', pressCancel);
    pill.addEventListener('pointerleave', pressCancel);
    // ネイティブの長押しジェスチャ（選択・コンテキストメニュー・スクロール）を根元から抑止
    pill.addEventListener('touchstart', function (ev) { try { ev.preventDefault(); } catch (_) {} }, { passive: false });
    pill.addEventListener('selectstart', function (ev) { try { ev.preventDefault(); } catch (_) {} });
    pill.addEventListener('contextmenu', function (ev) { try { ev.preventDefault(); } catch (_) {} });
    pill.addEventListener('click', function (ev) { try { ev.preventDefault(); } catch (_) {} });
    try { document.body.appendChild(pill); } catch (_) { pill = null; }
    return pill;
  }
  function renderPill(active) {
    var p = ensurePill();
    if (!p) return;
    if (!indOn()) { p.style.display = 'none'; return; }
    p.style.display = 'flex';
    if (active) p.classList.add('cc-ri-on'); else p.classList.remove('cc-ri-on');
  }
  function denyBlink() {
    if (!pill) return;
    try { pill.classList.remove('cc-ri-deny'); void pill.offsetWidth; pill.classList.add('cc-ri-deny'); } catch (_) {}
  }

  // ---- 長押し → 同一フレーム内で直接トグル（配達なし＝rc-autoconnect と同じ確実系）。
  //   押下中フィルが HOLD_MS かけて満ちる＝離せばキャンセル/満ちれば実行の可視化。
  //   タップ経路は v0.5 で実証済み。単タップ（HOLD_MS 未満）は何もしない。 ----
  var holdTimer = null;
  function resetFill() { if (fill) { try { fill.style.transition = 'none'; fill.style.height = '0'; } catch (_) {} } }
  function pressStart(e) {
    try { e.preventDefault(); } catch (_) {}
    if (!holdOn() || holdTimer) return;
    if (!reduced && fill) { try { fill.style.transition = 'height ' + HOLD_MS + 'ms linear'; fill.style.height = '100%'; } catch (_) {} }
    holdTimer = setTimeout(function () {
      holdTimer = null; resetFill();
      emitLog('hold fire');
      handleToggle();
    }, HOLD_MS);
  }
  function pressEnd(e) {
    try { e.preventDefault(); } catch (_) {}
    pressCancel();
  }
  function pressCancel() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    resetFill();
  }

  var lastSendAt = 0;
  function deny(reason) { emitLog('toggle deny: ' + reason); denyBlink(); }
  function handleToggle() {
    var composer = findComposer();
    if (!composer || !chatFrame()) return;
    if (composerText(composer)) { deny('draft'); return; }              // 下書きを壊さない
    var busy = false;
    try { busy = !!document.querySelector(STOP_ICON_SEL); } catch (_) {}
    if (busy) { deny('busy'); return; }                                 // 生成中は送信ボタン＝停止ボタン。触らない
    var now = Date.now();
    if (now - lastSendAt < DEBOUNCE_MS) { deny('debounce'); return; }
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

  // ---- メインループ（chat フレームのみ実質動作） ----
  var frameLogged = false;
  function tick() {
    var composer = findComposer();
    if (!composer || !chatFrame()) return;
    if (!frameLogged) { frameLogged = true; emitLog('chat frame armed'); }
    var banner = findBanner(composer);
    applyHide(banner);
    renderPill(!!banner);
  }

  // ---- 設定のライブ反映 ----
  try {
    window.addEventListener('ccstudio:setting', function (e) {
      var d = e && e.detail;
      if (!d || d.plugin !== NAME) return;
      var c = findComposer();
      if (!c || !chatFrame()) return;
      if (d.key === 'hideBanner') applyHide(findBanner(c));
      if (d.key === 'indicator') renderPill(!!findBanner(c));
    });
  } catch (_) {}

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
    tick();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    try { if (document.documentElement) start(); } catch (_) {}
  } else {
    start();
  }
})();
