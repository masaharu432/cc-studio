// ==CCStudioPlugin==
// @name        state-observer
// @version     0.4.0
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
    // 1) Claude Code の送信ボタン（アイコンのみ・class=sendButton_*）は生成中「停止」ボタンに変わる。
    //    送信(入力あり)と停止(生成中)はクラスが同じなので、「入力欄が空なのにボタンが有効＝生成中」で区別。
    //    実機 DIAG: アイドル空欄=sendButton!dis(無効) / 生成中=有効。
    try {
      var c = document.querySelector(COMPOSER_SEL);
      if (c) {
        var empty = !((c.textContent || '').trim());
        var sbs = document.querySelectorAll('button[class*="sendButton"]');
        for (var i = 0; i < sbs.length; i++) {
          var sb = sbs[i];
          if (sb.offsetParent === null) continue;
          if (!sb.disabled && empty) return 'stop:sendButton-enabled+empty';
        }
      }
    } catch (_) {}
    // 2) 明示ラベルのある停止/中断ボタン（他UI・将来用フォールバック）。
    var nodes = document.querySelectorAll('button[aria-label],button[title],[role="button"][aria-label]');
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      var lbl = (n.getAttribute('aria-label') || n.getAttribute('title') || '').toLowerCase();
      if (!lbl) continue;
      if (/\b(stop|interrupt)\b/.test(lbl) || lbl.indexOf('中断') >= 0 || lbl.indexOf('停止') >= 0) {
        if (n.offsetParent !== null) return 'btn:' + lbl.slice(0, 24);
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

  // ---- DIAG: 入力欄(=チャット本体)まわりのボタンを狙い撃ちでダンプし停止ボタンの正体を特定する ----
  // 停止ボタンは入力欄＝DOM 末尾にあるので、(1)入力欄直近のコンテナ内 (2)末尾から の2方向で拾う。
  // ラベルが無いアイコンボタンに備え class と disabled も出す。
  var lastDiag = 0;
  function btnDesc(el) {
    var lbl = (el.getAttribute('aria-label') || el.getAttribute('title') ||
               (el.textContent || '').replace(/\s+/g, ' ').trim() || '∅').slice(0, 16);
    var cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return lbl + (cls ? ('#' + cls.slice(0, 22)) : '') + (el.disabled ? '!dis' : '');
  }
  function composerArea() {
    var c; try { c = document.querySelector(COMPOSER_SEL); } catch (_) { c = null; }
    if (!c) return null;
    var p = c;
    for (var i = 0; i < 8 && p.parentElement; i++) p = p.parentElement;
    return p;
  }
  function diagDump() {
    if (!diagOn()) return;
    var t = Date.now();
    if (t - lastDiag < DIAG_MS) return;
    lastDiag = t;
    var area = composerArea();
    if (!area) return;   // 入力欄が無いフレームはノイズなので出さない
    // (1) 入力欄直近コンテナ内のボタン（送信/停止はここに居る）
    var o1 = [], b1 = area.querySelectorAll('button,[role="button"]');
    for (var i = 0; i < b1.length && o1.length < 12; i++) { if (b1[i].offsetParent === null) continue; o1.push(btnDesc(b1[i])); }
    emitLog('DIAGC ' + frameName() + ' ' + o1.join(' | '));
    // (2) フレーム全体の末尾から（コンテナ外に出ている場合の保険）
    var o2 = [], all = document.querySelectorAll('button,[role="button"]');
    for (var j = all.length - 1; j >= 0 && o2.length < 10; j--) { if (all[j].offsetParent === null) continue; o2.push(btnDesc(all[j])); }
    emitLog('DIAGT ' + frameName() + ' ' + o2.join(' | '));
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
