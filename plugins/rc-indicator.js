// ==CCStudioPlugin==
// @name        rc-indicator
// @version     0.3.0
// @description Hide the persistent "Remote Control is active" banner (RC stays on), and show a compact "R" pill above the ⋮ button instead; tap the pill to toggle RC manually (tap is provisional while verifying delivery; will return to long-press).
// @description:ja 常時表示の「Remote Control is active」バナーを非表示にし（RC は維持）、代わりに ⋮ ボタン直上の「R」ピルで状態表示。ピルのタップで手動オン/オフ（経路検証のための暫定。確認後に長押しへ戻す）。
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
// 「バナーが DOM に存在するか」を RC 状態の検知器として流用して ⋮ ボタン直上の「R」ピルに表示する。
// ピルのタップで /remote-control を送信し手動トグル（v0.3 暫定: 配信経路の検証のため。確認後に
// 長押し 600ms へ戻す）。× ボタンには一切触れない（クリック＝RC 切断のため）。
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

  // ---- RC 状態を top へ報告(変化時 + ハートビート)。フレーム識別子つき ----
  //   0.1.0 は最後の報告が勝つ方式で、新規セッション時に新旧 composer フレームが相反する状態を
  //   交互に上書きしてピルが点滅した。フレーム別に報告し top 側で集約する(state-observer と同方式)。
  function frameTag() {
    try {
      if (isTop) return 'top';
      var p = (location && location.pathname) || '';
      return (decodeURIComponent(p.split('/').filter(Boolean).pop() || (location && location.host) || 'sub')).slice(0, 12);
    } catch (_) { return 'xo'; }
  }
  var TAG = frameTag() + '~' + Math.random().toString(36).slice(2, 6);   // 同一パスのフレーム衝突も避ける
  var tickCount = 0, lastActive = null;
  function report(active) {
    try { window.top.postMessage({ k: MSG_STATE, tag: TAG, active: !!active }, '*'); } catch (_) {}
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

  // ---- composer フレーム側: トグル依頼の実行（設計 §7 ガード） ----
  var lastSendAt = 0;
  function denyReply(reason) {
    emitLog('toggle deny: ' + reason);
    try { window.top.postMessage({ k: MSG_DENY, reason: reason }, '*'); } catch (_) {}
  }
  function handleToggle() {
    var composer = findComposer();
    if (!composer) return;                                   // 非 composer フレームは黙って無視
    emitLog('toggle recv');                                  // 依頼がこのフレームまで届いた証跡
    if (!holdOn()) return;                                   // 設定 OFF（top 側でも弾くが二重で守る）
    if (composerText(composer)) { denyReply('draft'); return; }        // 下書きを壊さない
    var busy = false;
    try { busy = !!document.querySelector(STOP_ICON_SEL); } catch (_) {}
    if (busy) { denyReply('busy'); return; }                 // 生成中は送信ボタン＝停止ボタン。触らない
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

  // ---- 設定のライブ反映（hideBanner の ON/OFF 即時切替） ----
  try {
    window.addEventListener('ccstudio:setting', function (e) {
      var d = e && e.detail;
      if (!d || d.plugin !== NAME) return;
      if (d.key === 'hideBanner') { var c = findComposer(); if (c) applyHide(findBanner(c)); }
      if (isTop && (d.key === 'indicator' || d.key === 'holdToggle')) renderPill();
    });
  } catch (_) {}

  // ---- top フレーム側: 「R」ピル（設計 §6。⋮ ボタン #ccstudio-menu-btn の直上に固定配置。
  //   0.1.0 の直下配置は composer に近くキーボード誤出現を招いたため上へ移動） ----
  var pill = null, fill = null;
  var reg = {};   // フレーム別の状態レジストリ: tag → { active, t }
  var reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) {}

  function ensureStyles() {
    if (document.getElementById('cc-ri-style')) return;
    var st = document.createElement('style'); st.id = 'cc-ri-style';
    st.textContent =
      '@keyframes ccRiDeny{0%,100%{opacity:1}50%{opacity:.25}}' +
      '#cc-ri-pill{position:fixed;left:0;bottom:calc(22% + 92px);width:30px;height:68px;border:0;padding:0;' +
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
    // 「R」はテキストノードにすると Android の長押しで文字選択が発動し、pointercancel で
    // 長押し判定ごと潰される（0.1.0 の実害）。選択対象が存在しない SVG ストロークで描く。
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
    pill.addEventListener('click', function (ev) { try { ev.preventDefault(); } catch (_) {} });   // 単タップは無反応
    try { document.body.appendChild(pill); } catch (_) { pill = null; }
    return pill;
  }
  function renderPill() {
    if (!isTop) return;
    var p = ensurePill();
    if (!p) return;
    // フレーム別レジストリを集約: 鮮度内の報告が 1 つでも active なら有効（last-writer-wins だと
    // 新規セッション時に新旧フレームの相反報告でピルが点滅する）。
    var now = Date.now(), any = false, active = false;
    for (var k in reg) {
      var r = reg[k];
      if (now - r.t >= STALE_MS) { delete reg[k]; continue; }
      any = true; if (r.active) active = true;
    }
    if (!indOn() || !any) { p.style.display = 'none'; return; }   // 非チャット画面・報告途絶は非表示
    p.style.display = 'flex';
    if (active) p.classList.add('cc-ri-on'); else p.classList.remove('cc-ri-on');
  }
  function denyBlink() {
    if (!pill) return;
    try { pill.classList.remove('cc-ri-deny'); void pill.offsetWidth; pill.classList.add('cc-ri-deny'); } catch (_) {}
  }

  // ---- top: タップ判定（v0.3 暫定。長押し経路の不発を切り分けるため、まずタップで配信を検証。
  //   確認が取れたら HOLD_MS の長押しへ戻す予定。押下中はフィルで押下状態を可視化） ----
  var pressed = false;
  function resetFill() { if (fill) { try { fill.style.transition = 'none'; fill.style.height = '0'; } catch (_) {} } }
  function pressStart(e) {
    try { e.preventDefault(); } catch (_) {}
    if (!holdOn()) return;
    pressed = true;
    if (!reduced && fill) { try { fill.style.transition = 'height 120ms linear'; fill.style.height = '100%'; } catch (_) {} }
  }
  function pressEnd(e) {
    try { e.preventDefault(); } catch (_) {}
    var fire = pressed; pressed = false; resetFill();
    if (!fire || !holdOn()) return;
    emitLog('tap fire');
    fireToggle();
  }
  function pressCancel() { pressed = false; resetFill(); }
  // 配信は「状態報告をくれた composer フレームの e.source へ直接返す」を第一とする。
  //   0.2.0 まではフレームツリーの再帰探索（window.length / 添字アクセス）だけだったが、
  //   webview の多層構造で届かない可能性の切り分けができないため、確実な返信路を主にした。
  function fireToggle() {
    var msg = { k: MSG_TOGGLE };
    var now = Date.now(), sent = 0;
    for (var k in reg) {
      var r = reg[k];
      if (now - r.t >= STALE_MS || !r.src) continue;
      try { r.src.postMessage(msg, '*'); sent++; } catch (_) {}
    }
    emitLog('fire sent=' + sent);
    if (!sent) broadcast(window, msg);   // 報告元が取れていない時だけ再帰探索へフォールバック
  }
  function broadcast(win, msg) {
    try { win.postMessage(msg, '*'); } catch (_) {}
    var n = 0; try { n = win.length; } catch (_) {}
    for (var i = 0; i < n; i++) { try { broadcast(win[i], msg); } catch (_) {} }
  }

  // ---- top: composer フレームからの報告受信 ----
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (!m) return;
        if (m.k === MSG_STATE) { reg[typeof m.tag === 'string' ? m.tag : 'f'] = { active: !!m.active, t: Date.now(), src: e.source || null }; renderPill(); }
        else if (m.k === MSG_DENY) { denyBlink(); emitLog('deny ' + (m.reason || '')); }
        else if (m.k === MSG_HUD && typeof m.log === 'string') pushShared(m.log);
      }, false);
    } catch (_) {}
  }

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
