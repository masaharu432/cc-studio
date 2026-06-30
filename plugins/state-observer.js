// ==CCStudioPlugin==
// @name        state-observer
// @version     0.1.0
// @description Claude Code が処理中か / code-server の接続が切れているかを各スクリーンで検知し、スクリーン一覧の行・常駐通知・左端の ︙ ボタンに「処理中 / 接続切れ」を表示します。停止ボタンや再接続表示を監視するだけで、操作はしません。
// @run-at        document-start
// @all-frames    true
// ==/CCStudioPlugin==
// state-observer.js — 処理中/接続切れの状態を観測してネイティブへ報告するプラグイン。
//   claude-code の停止ボタンは code-server の webview iframe 内に居る（[[selectable-text]] と同じ）。
//   メインフレーム専用の evaluateJavascript では届かないので、all-frames document-start で全フレームに
//   注入し、非トップフレームは postMessage でトップへ {busy,disc,matched} を送る。トップフレームだけが
//   集約して window.CCStudio.setSessionState を呼び、左端 ︙ ボタンを塗り、window.__ccStudioFocusLog へ
//   遷移(STATE)とキャンセル(CANCEL)を時刻付きで積む（接続メモの相関用）。
//   セレクタは実機調整前提なので detectBusy/detectDisconnected に集約し、何にマッチしたか(matched)を残す。冪等。
(function () {
  'use strict';
  if (window.__ccStateObserver) return;
  window.__ccStateObserver = true;

  var MSG = '__cc_session';
  var POLL_MS = 1000;          // フォールバックポーリング
  var THROTTLE_MS = 200;       // MutationObserver 連打をまとめる
  var OFF_DEBOUNCE_MS = 800;   // off 方向の遷移はばたつき防止に遅延確定
  var STALE_MS = 3500;         // この時間ハートビートが無いフレーム登録は捨てる（iframe 除去対策）
  var AGG_MS = 400;            // トップの集約間隔

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }
  var myId = 'fr_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e9).toString(36);

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

  // ---- 共有ヘルパ ----
  function focusLog(entry) {
    try {
      var a = window.__ccStudioFocusLog || (window.__ccStudioFocusLog = []);
      a.push(entry); if (a.length > 500) a.splice(0, a.length - 500);
    } catch (_) {}
  }
  function ensureKeyframes() {
    if (document.getElementById('ccstudio-state-kf')) return;
    var st = document.createElement('style'); st.id = 'ccstudio-state-kf';
    st.textContent = '@keyframes ccstudioBusyPulse{0%,100%{box-shadow:2px 0 10px rgba(46,144,232,.45)}' +
      '50%{box-shadow:2px 0 18px rgba(46,144,232,.95)}}';
    (document.head || document.documentElement).appendChild(st);
  }
  function paintButton(busy, disc) {
    var btn = document.getElementById('ccstudio-menu-btn');
    if (!btn) return;
    if (disc) { btn.style.background = 'linear-gradient(180deg,#e53935,#b21f1a)'; btn.style.animation = 'none'; }
    else if (busy) { btn.style.background = 'linear-gradient(180deg,#2E90E8,#1c6fc0)'; btn.style.animation = 'ccstudioBusyPulse 1s ease-in-out infinite'; }
    else { btn.style.background = 'linear-gradient(180deg,#2E90E8,#1c6fc0)'; btn.style.animation = 'none'; }
  }

  // ---- トップフレーム: 全フレームの状態を集約してネイティブへ報告 ----
  var registry = {};   // frameId -> {b,d,m,t}
  var lastB = false, lastD = false, offTimer = null;

  function ingest(id, b, d, m) { registry[id] = { b: !!b, d: !!d, m: m || '', t: Date.now() }; }

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
      focusLog({ t: Date.now(), tag: 'STATE', busy: busy, disconnected: disc, matched: matched });
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
      if (m.cancel) { focusLog({ t: Date.now(), tag: 'CANCEL', busy: lastB, disconnected: lastD, matched: 'stop-signal' }); return; }
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
    var c = detectCancel();   // キャンセルは立ち上がりエッジのみ通知
    if (c && !lastCancel) {
      if (isTop) focusLog({ t: Date.now(), tag: 'CANCEL', busy: lastB, disconnected: lastD, matched: 'stop-signal' });
      else { try { window.top.postMessage({ k: MSG, id: myId, cancel: true }, '*'); } catch (_) {} }
    }
    lastCancel = c;
  }

  var throttle = null;
  function schedule() { if (throttle) return; throttle = setTimeout(function () { throttle = null; scanLocal(); }, THROTTLE_MS); }

  var started = false;
  function start() {
    if (started) return; started = true;
    if (isTop) startTop();
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
