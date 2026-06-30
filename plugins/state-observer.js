// ==CCStudioPlugin==
// @name        state-observer
// @version     0.2.0
// @description Claude Code が処理中か / code-server の接続が切れているかを各スクリーンで検知し、スクリーン一覧の行・常駐通知・左端の ︙ ボタンに「処理中 / 接続切れ」を表示します。停止ボタンや再接続表示を監視するだけで、操作はしません。
// @run-at        document-start
// @all-frames    true
// @setting     diag boolean true 診断ログを focus-hud に出す（停止ボタン候補のダンプ）
// ==/CCStudioPlugin==
// state-observer.js — 処理中/接続切れの状態を観測してネイティブへ報告するプラグイン。
//   claude-code の停止ボタンは code-server の webview iframe 内に居る（[[selectable-text]] と同じ）。
//   メインフレーム専用の evaluateJavascript では届かないので all-frames × document-start で全フレームに
//   注入し、非トップフレームは postMessage でトップへ送る。トップだけが集約して
//   window.CCStudio.setSessionState を呼び、左端 ︙ ボタンを塗る。
//
//   ログは focus-hud の共有バッファ window.top.__ccStudioFocusLog に **文字列** で積む
//   （focus-hud は文字列を join 表示するため。オブジェクトだと [object Object] になり読めない）。
//   DIAG=true の間は、停止ボタンのセレクタを実機で確定するため、各フレームの可視ボタンの
//   ラベル候補を 'DIAG ...' 行としてダンプする。確定したら diag 設定を OFF にする。冪等。
(function () {
  'use strict';
  if (window.__ccStateObserver) return;
  window.__ccStateObserver = true;

  var MSG = '__cc_session';
  var COMPOSER_SEL = '[role="textbox"][aria-multiline="true"]';
  var POLL_MS = 1000;
  var THROTTLE_MS = 200;
  var OFF_DEBOUNCE_MS = 800;
  var STALE_MS = 3500;
  var AGG_MS = 400;
  var DIAG_MS = 2000;
  var MAX_LOG = 16;

  function diagOn() {
    try { var s = window.__ccPluginSettings && window.__ccPluginSettings['state-observer']; return !(s && s.diag === false); }
    catch (_) { return true; }
  }

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }
  var myId = 'fr_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36);
  function frameName() {
    try {
      if (isTop) return 'top';
      var p = (location && location.pathname) || '';
      return (decodeURIComponent(p.split('/').filter(Boolean).pop() || (location && location.host) || 'sub')).slice(0, 14);
    } catch (_) { return 'xo'; }
  }

  // ---- focus-hud 共有バッファへ文字列で積む（トップフレームのみ直接、他は postMessage 経由） ----
  function hudLog(s) {
    try {
      var a = window.__ccStudioFocusLog || (window.__ccStudioFocusLog = []);
      if (a[a.length - 1] === s) return;
      a.push(s);
      while (a.length > MAX_LOG) a.shift();
    } catch (_) {}
  }
  function emitLog(s) {
    if (isTop) hudLog(s);
    else { try { window.top.postMessage({ k: MSG, log: s }, '*'); } catch (_) {} }
  }

  // ---- 検知ヒューリスティック（実機調整前提・matched を残す） ----
  function detectBusy() {
    var nodes = document.querySelectorAll(
      'button[aria-label],button[title],[role="button"][aria-label],a[aria-label]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var lbl = (n.getAttribute('aria-label') || n.getAttribute('title') || '').toLowerCase();
      if (!lbl) continue;
      if (/\b(stop|interrupt|cancel)\b/.test(lbl) ||
          lbl.indexOf('中断') >= 0 || lbl.indexOf('停止') >= 0) {
        if (n.offsetParent !== null) return 'btn:' + lbl.slice(0, 30);
      }
    }
    return null;
  }
  function detectDisconnected() {
    var texts = ['Disconnected', 'Reconnecting', 'reconnect', 'Connection lost', '接続が切断', '再接続'];
    var scopes = document.querySelectorAll(
      '.monaco-dialog-box, .notifications-toasts, .monaco-workbench .dialog-message, [role="dialog"], [role="alertdialog"]');
    for (var i = 0; i < scopes.length; i++) {
      var el = scopes[i];
      if (el.offsetParent === null) continue;
      var tx = el.textContent || '';
      for (var j = 0; j < texts.length; j++) if (tx.indexOf(texts[j]) >= 0) return 'overlay:' + texts[j];
    }
    return null;
  }
  function detectCancel() {
    try { return ((document.body && document.body.textContent) || '').indexOf("doesn't want to take this action") >= 0; }
    catch (_) { return false; }
  }

  // ---- DIAG: このフレームの可視ボタン候補をダンプ（停止ボタンの正体を特定する） ----
  var lastDiag = 0;
  function diagDump() {
    if (!diagOn()) return;
    var t = Date.now();
    if (t - lastDiag < DIAG_MS) return;
    lastDiag = t;
    var hasComposer = false;
    try { hasComposer = !!document.querySelector(COMPOSER_SEL); } catch (_) {}
    var nodes = document.querySelectorAll('button,[role="button"],a[aria-label]');
    var out = [], n = 0;
    for (var i = 0; i < nodes.length && out.length < 10; i++) {
      var el = nodes[i];
      if (el.offsetParent === null) continue;
      n++;
      var lbl = (el.getAttribute('aria-label') || el.getAttribute('title') ||
                 (el.textContent || '').replace(/\s+/g, ' ').trim() || '∅').slice(0, 18);
      out.push(lbl);
    }
    // 入力欄のあるフレーム(=チャット本体)を優先的に見たいので印を付ける
    emitLog('DIAG ' + frameName() + (hasComposer ? '*' : '') + ' vis=' + n + ': ' + out.join(' | '));
  }

  // ---- トップフレーム: 全フレームの状態を集約してネイティブへ報告 ----
  var registry = {};   // frameId -> {b,d,m,t}
  var lastB = false, lastD = false, offTimer = null, started = false;

  function ingest(id, b, d, m) { registry[id] = { b: !!b, d: !!d, m: m || '', t: Date.now() }; }

  function paintButton(busy, disc) {
    var btn = document.getElementById('ccstudio-menu-btn');
    if (!btn) return;
    if (disc) { btn.style.background = 'linear-gradient(180deg,#e53935,#b21f1a)'; btn.style.animation = 'none'; }
    else if (busy) { btn.style.background = 'linear-gradient(180deg,#2E90E8,#1c6fc0)'; btn.style.animation = 'ccstudioBusyPulse 1s ease-in-out infinite'; }
    else { btn.style.background = 'linear-gradient(180deg,#2E90E8,#1c6fc0)'; btn.style.animation = 'none'; }
  }
  function ensureKeyframes() {
    if (document.getElementById('ccstudio-state-kf')) return;
    var st = document.createElement('style'); st.id = 'ccstudio-state-kf';
    st.textContent = '@keyframes ccstudioBusyPulse{0%,100%{box-shadow:2px 0 10px rgba(46,144,232,.45)}' +
      '50%{box-shadow:2px 0 18px rgba(46,144,232,.95)}}';
    (document.head || document.documentElement).appendChild(st);
  }

  function aggregate() {
    var t = Date.now(), busy = false, disc = false, matched = '';
    for (var k in registry) {
      if (!registry.hasOwnProperty(k)) continue;
      var f = registry[k];
      if (t - f.t > STALE_MS) { delete registry[k]; continue; }
      if (f.b) { busy = true; if (!matched) matched = f.m; }
      if (f.d) { disc = true; matched = f.m; }
    }
    var goingOff = (lastB && !busy) || (lastD && !disc);
    function commit() {
      if (busy === lastB && disc === lastD) return;
      lastB = busy; lastD = disc;
      paintButton(busy, disc);
      hudLog('STATE b=' + (busy ? 1 : 0) + ' d=' + (disc ? 1 : 0) + ' ' + (matched || ''));
      try { if (window.CCStudio && window.CCStudio.setSessionState) window.CCStudio.setSessionState(busy, disc); } catch (_) {}
    }
    if (offTimer) { clearTimeout(offTimer); offTimer = null; }
    if (goingOff) offTimer = setTimeout(commit, OFF_DEBOUNCE_MS); else commit();
  }

  function startTop() {
    ensureKeyframes();
    window.addEventListener('message', function (e) {
      var m = e.data;
      if (!m || typeof m !== 'object' || m.k !== MSG) return;
      if (m.log) { hudLog(m.log); return; }
      if (m.cancel) { hudLog('CANCEL (b=' + (lastB ? 1 : 0) + ')'); return; }
      ingest(m.id, m.b, m.d, m.m);
    }, false);
    setInterval(aggregate, AGG_MS);
  }

  // ---- 各フレーム: ローカル検知を集約系へ渡す ----
  var lastCancel = false;
  function scanLocal() {
    var bm = detectBusy(), dm = detectDisconnected();
    if (isTop) ingest(myId, !!bm, !!dm, bm || dm || '');
    else { try { window.top.postMessage({ k: MSG, id: myId, b: !!bm, d: !!dm, m: bm || dm || '' }, '*'); } catch (_) {} }
    var c = detectCancel();
    if (c && !lastCancel) {
      if (isTop) hudLog('CANCEL (b=' + (lastB ? 1 : 0) + ')');
      else { try { window.top.postMessage({ k: MSG, id: myId, cancel: true }, '*'); } catch (_) {} }
    }
    lastCancel = c;
    diagDump();
  }

  var throttle = null;
  function schedule() { if (throttle) return; throttle = setTimeout(function () { throttle = null; scanLocal(); }, THROTTLE_MS); }

  function start() {
    if (started) return; started = true;
    if (isTop) startTop();
    emitLog('OBS start ' + frameName());   // フレーム到達確認（HUD に出れば注入できている）
    try {
      new MutationObserver(schedule).observe(document.documentElement || document.body,
        { subtree: true, childList: true, attributes: true,
          attributeFilter: ['aria-label', 'title', 'class', 'style', 'disabled'] });
    } catch (_) {}
    setInterval(scanLocal, POLL_MS);
    scanLocal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    try { if (document.documentElement) start(); } catch (_) {}
  } else {
    start();
  }
})();
