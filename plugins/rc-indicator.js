// ==CCStudioPlugin==
// @name        rc-indicator
// @version     0.13.1
// @description Hide the persistent "Remote Control is active" banner (RC stays on), and show a round "R" button at the bottom-left of the chat panel instead; tap it to toggle RC manually.
// @description:ja 常時表示の「Remote Control is active」バナーを非表示にし（RC は維持）、代わりにチャットパネル左下の丸い「R」ボタンで状態表示。タップで手動オン/オフ。
// @run-at      document-start
// @all-frames  true
// @setting     hideBanner boolean true RCバナーを隠す
// @setting:ja  hideBanner RCバナーを隠す（RC接続は維持）
// @setting     indicator boolean true 「R」ボタンでRC状態を表示
// @setting:ja  indicator 「R」ボタンでRC状態を表示
// @setting     holdToggle boolean true 「R」ボタンでRCを手動オン/オフ
// @setting:ja  holdToggle 「R」ボタンでRCを手動オン/オフ
// @setting     diag boolean false 診断ログを focus-hud に出す
// @setting:ja  diag 診断ログを focus-hud に出す
// ==/CCStudioPlugin==
// rc-indicator.js — RC バナーを CSS で非表示（DOM は残る＝RC 接続に無影響）にし、
// 「バナーが DOM に存在するか」を RC 状態の検知器として流用して「R」ボタンに表示する。
// タップで /remote-control を送信し手動トグル。× ボタンには一切触れない（クリック＝RC 切断）。
//
// v0.13: フレーム内完結へ回帰（確定）。検知・ボタン描画・タップ・送信のすべてが chat フレーム内で
// 完結する。v0.7〜0.12 で試した「ピルを top に描き、状態やトグル依頼をフレーム間で運ぶ」構成は、
// 経路自体は動いても可視判定・状態同期の信頼性が確保できず断念（詳細は設計文書 §4 の変遷）。
// フレーム内完結ならフレームが隠れればボタンも消えるため、「表示中セッションの状態だけが見える」を
// 構造的に満たし、通信も同期も不要になる。ボタンはチャットパネル左下（composer 直上）の
// 44×44 丸ボタン（モック 3 案からユーザー選定: 左下×丸）。
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
  var POLL_MS = 400;           // tick（検知・描画）。反映のチラつき抑制で短め
  var DEBOUNCE_MS = 1000;      // 誤ダブルタップ対策（フレーム内完結なので多重配達は存在しない）
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

  // ---- 診断: focus-hud 共有バッファへ 'RI ' プレフィックスで。クロスオリジンは top 中継 ----
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
  // top の役割は HUD ログ中継のみ
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
  // 「composer を含まないスクロール領域」の中に居る要素はトランスクリプト（会話の転記）である。
  // 転記メッセージは必ずメッセージ一覧のスクロール容器内に描画され、本物のバナーは composer と
  // 同じ入力エリア側（この容器の外）に居る、という DOM 構造上の不変条件で判別する。
  // テキスト長・li 除外などの内容ヒューリスティックは、短い転記＋行内ボタンの組み合わせを
  // すり抜けられた実測があるため、構造判定を主防壁とする。
  function inForeignScroller(el, composer) {
    var n = el;
    while (n && n !== document.body) {
      try {
        var cs = getComputedStyle(n);
        if (/(auto|scroll|overlay)/.test(cs.overflowY || '') && !n.contains(composer)) return true;
      } catch (_) {}
      n = n.parentElement;
    }
    return false;
  }
  function validBanner(cont, composer) {
    try {
      if (!cont || cont.contains(composer)) return false;
      if (cont.closest && cont.closest('li,[role="listitem"]')) return false;
      if (inForeignScroller(cont, composer)) return false;
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
      try { if (el.closest && el.closest('li,[role="listitem"]')) continue; } catch (_) {}
      // 祖先へは「テキスト量がバナー1行相当（≤300字）に収まる範囲」までしかタイトに登らない
      var cont = el;
      while (cont.parentElement && cont.parentElement !== document.body && !cont.parentElement.contains(composer)) {
        var pt = '';
        try { pt = cont.parentElement.textContent || ''; } catch (_) {}
        if (pt.length > 300) break;
        cont = cont.parentElement;
      }
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

  // ---- 「R」ボタン（chat フレーム内に描画。フレームごと隠れるので表示中セッションの状態だけが見える） ----
  var pill = null, fill = null;
  var reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) {}

  function ensureStyles() {
    if (document.getElementById('cc-ri-style')) return;
    var st = document.createElement('style'); st.id = 'cc-ri-style';
    // 位置: チャットパネル左下・composer の少し上。形状は ⋮ ボタンと同じ左端貼り付きタブ型を
    // さらに薄くしたもの（22×64・右側のみ角丸。ユーザー指定「三点ボタン形状でもっと薄く」）。
    // キーボード出現時はフレームごと縮むので bottom 基準で composer の上に追従する。
    st.textContent =
      '@keyframes ccRiDeny{0%,100%{opacity:1}50%{opacity:.25}}' +
      '#cc-ri-pill{position:fixed;left:0;bottom:120px;width:22px;height:64px;border:0;padding:0;' +
      'border-radius:0 11px 11px 0;z-index:2147483647;color:#9aa3b2;background:#3a4150;' +
      'display:none;align-items:center;justify-content:center;overflow:hidden;' +
      'box-shadow:2px 0 10px rgba(0,0,0,.45);' +
      'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;cursor:pointer;}' +
      '#cc-ri-pill *{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;}' +
      '#cc-ri-pill.cc-ri-on{color:#fff;background:linear-gradient(180deg,#34C77B,#1e9a58);box-shadow:2px 0 10px rgba(52,199,123,.5);}' +
      '#cc-ri-pill.cc-ri-deny{animation:ccRiDeny .18s 3;}' +
      '#cc-ri-fill{position:absolute;left:0;bottom:0;width:100%;height:0;background:rgba(255,255,255,.28);pointer-events:none;}' +
      '#cc-ri-glyph{position:relative;width:13px;height:19px;pointer-events:none;}';
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
    // pointerleave では killしない: 幅 30px では長押し中の指の揺れで leave が出る（0.7.0 の実害）
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

  // ---- タップ → 同一フレーム内で直接トグル（配達なし・同期なし＝実測で唯一信頼できた構成） ----
  var pressed = false, pressAt = 0;
  function resetFill() { if (fill) { try { fill.style.transition = 'none'; fill.style.height = '0'; } catch (_) {} } }
  function pressStart(e) {
    try { e.preventDefault(); } catch (_) {}
    if (!holdOn()) return;
    try { if (pill && e.pointerId !== undefined) pill.setPointerCapture(e.pointerId); } catch (_) {}
    pressed = true; pressAt = Date.now();
    emitLog('press down');
    if (!reduced && fill) { try { fill.style.transition = 'height 120ms linear'; fill.style.height = '100%'; } catch (_) {} }
  }
  function pressEnd(e) {
    try { e.preventDefault(); } catch (_) {}
    var fire = pressed; pressed = false; resetFill();
    if (!fire || !holdOn()) return;
    emitLog('tap fire dt=' + (Date.now() - pressAt));
    handleToggle();
  }
  function pressCancel(why) {
    var w = (why && why.type) ? why.type : (typeof why === 'string' ? why : 'cancel');
    if (pressed) { pressed = false; emitLog('press cancel ' + w + ' dt=' + (Date.now() - pressAt)); }
    resetFill();
  }

  var lastSendAt = 0;
  function deny(reason) { emitLog('toggle deny: ' + reason); denyBlink(); }
  function handleToggle() {
    var composer = findComposer();
    if (!composer || !chatFrame()) return;
    var busy = false;
    try { busy = !!document.querySelector(STOP_ICON_SEL); } catch (_) {}
    if (busy) { deny('busy'); return; }                      // 生成中は送信ボタン＝停止ボタン。触らない
    var now = Date.now();
    if (now - lastSendAt < DEBOUNCE_MS) { deny('debounce'); return; }
    lastSendAt = now;
    // 下書きは拒否せず退避 → コマンド送信後に復元する
    sendCommand(composer, composerText(composer));
  }
  // 送信手順は rc-autoconnect の実測確定手順を踏襲（insertText → 送信ボタンのクリックのみ。
  // ボタンが在るのに Enter も撃つと二重送信になる。未検出時のみ Enter フォールバック）。
  // draft が渡された場合は全選択→コマンドで置換して送信し、送信後に復元する。
  function sendCommand(composer, draft) {
    try { composer.focus(); } catch (_) {}
    if (draft) { try { document.execCommand('selectAll'); } catch (_) {} }
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
      if (draft) setTimeout(function () { restoreDraft(draft); }, 600);
    }, SUBMIT_DELAY_MS);
  }
  // 退避した下書きを composer が空になったのを確認してから書き戻す。空でない（送信失敗で
  // コマンドが残っている等）場合は継ぎ足しで壊さないよう復元を見送り、ログに残す。
  function restoreDraft(draft) {
    var c = findComposer();
    if (!c) { emitLog('draft restore skipped: composer gone'); return; }
    if (composerText(c)) { emitLog('draft restore skipped: not empty'); return; }
    try { c.focus(); } catch (_) {}
    var ok = false;
    try { ok = document.execCommand('insertText', false, draft); } catch (_) {}
    if (!ok) {
      try {
        c.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: draft, bubbles: true, cancelable: true }));
        c.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: draft, bubbles: true }));
      } catch (_) {}
    }
    emitLog('draft restored len=' + draft.length);
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
