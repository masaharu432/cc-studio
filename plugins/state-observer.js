// ==CCStudioPlugin==
// @name        state-observer
// @version     1.0.2
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
  // 送信/停止ボタン(class=sendButton_*)は生成中(busy.value)だけ子に stopIcon を描く。
  //   拡張ソース: p = e.busy.value && !o ? b(KG,{className:stopIcon}) : b(uXe,{className:sendIcon})
  //   → 子孫に class*="stopIcon" があれば処理中。生成が終わると sendIcon に戻り消える＝自動解除。
  //   stopIcon は SVG のため offsetParent が使えず、親 sendButton の中に在るかで判定する。
  function stopIconPresent() {
    try { return !!document.querySelector('button[class*="sendButton"] [class*="stopIcon"]'); }
    catch (_) { return false; }
  }
  function detectBusy() {
    // 1) sendButton 内に stopIcon＝生成中（拡張の busy フラグの DOM 表現）。
    if (stopIconPresent()) return 'stopIcon';
    // 2) フォールバック: ラベル付き停止/中断ボタン（他UI）。
    var nodes = document.querySelectorAll('button[aria-label],button[title]');
    for (var j = 0; j < nodes.length; j++) {
      var lbl = (nodes[j].getAttribute('aria-label') || nodes[j].getAttribute('title') || '').toLowerCase();
      if (!lbl) continue;
      if (/\b(stop|interrupt)\b/.test(lbl) || lbl.indexOf('中断') >= 0 || lbl.indexOf('停止') >= 0) {
        if (nodes[j].offsetParent !== null) return 'btn:' + lbl.slice(0, 20);
      }
    }
    return null;
  }
  var discMatch = '';
  function detectDisconnected() {
    discMatch = '';
    // 単独で拾うと誤検知しやすい 'reconnect'/'Connection' は避け、切断UIに出る明確な語のみ。
    var texts = ['Disconnected', 'Reconnecting', 'Cannot reconnect', 'lost connection', '接続が切断', '再接続'];
    // 個々の可視トースト/ダイアログのみ（コンテナ全体でなく item 単位）。
    var scopes = document.querySelectorAll(
      '.monaco-dialog-box, .notifications-toasts .notification-list-item, [role="dialog"], [role="alertdialog"]');
    for (var i = 0; i < scopes.length; i++) {
      var el = scopes[i];
      if (el.offsetParent === null) continue;
      var tx = el.textContent || '';
      for (var j = 0; j < texts.length; j++) {
        if (tx.indexOf(texts[j]) >= 0) {
          var cls = (typeof el.className === 'string' && el.className.split(/\s+/)[0]) || (el.tagName || '?').toLowerCase();
          discMatch = cls + ' «' + texts[j] + '» ' + tx.replace(/\s+/g, ' ').slice(0, 40);
          return 'overlay:' + texts[j];
        }
      }
    }
    return null;
  }
  function detectCancel() {
    try { return ((document.body && document.body.textContent) || '').indexOf("doesn't want to take this action") >= 0; }
    catch (_) { return false; }
  }

  // ---- DIAG: 処理中判定の内訳を1行で吐く（入力欄のあるチャット本体フレームのみ） ----
  var lastDiag = 0;
  function diagDump() {
    if (!diagOn()) return;
    var t = Date.now();
    if (t - lastDiag < DIAG_MS) return;
    lastDiag = t;
    var c; try { c = document.querySelector(COMPOSER_SEL); } catch (_) { c = null; }
    if (c) {   // 入力欄のあるチャット本体フレームだけ busy 内訳を出す
      emitLog('BUSY? ' + frameName() + ' stop=' + (stopIconPresent() ? 1 : 0) + ' => ' + (detectBusy() || 'null'));
    }
    // 切断オーバーレイは top ワークベンチ側に出るので、フレームを問わずマッチ内容を吐く。
    if (detectDisconnected()) emitLog('DISC? ' + frameName() + ' ' + discMatch);
  }

  // ---- トップフレーム: 全フレームの状態を集約してネイティブへ報告 ----
  var registry = {};   // frameId -> {b,d,m,t}
  // null = 未送信のセンチネル。起動後の初回集約で必ず1回ネイティブへ現在値を送り、
  // リロード前に残った stale な処理中/接続切れをクリアする。
  var lastB = null, lastD = null, offTimer = null, started = false;

  function ingest(id, b, d, m) { registry[id] = { b: !!b, d: !!d, m: m || '', t: Date.now() }; }

  function paintButton(busy, disc) {
    var btn = document.getElementById('ccstudio-menu-btn');
    if (!btn) return;
    if (disc) { btn.style.background = 'linear-gradient(180deg,#e53935,#b21f1a)'; btn.style.animation = 'none'; }
    else if (busy) { btn.style.background = 'linear-gradient(180deg,#2E90E8,#1c6fc0)'; btn.style.animation = 'ccstudioBusyPulse 2.4s ease-in-out infinite'; }
    else { btn.style.background = 'linear-gradient(180deg,#2E90E8,#1c6fc0)'; btn.style.animation = 'none'; }
  }
  function ensureKeyframes() {
    if (document.getElementById('ccstudio-state-kf')) return;
    var st = document.createElement('style'); st.id = 'ccstudio-state-kf';
    st.textContent = '@keyframes ccstudioBusyPulse{0%,100%{box-shadow:2px 0 10px rgba(46,144,232,.45)}' +
      '50%{box-shadow:2px 0 18px rgba(46,144,232,.95)}}';
    (document.head || document.documentElement).appendChild(st);
  }

  function computeState() {
    var t = Date.now(), busy = false, disc = false, matched = '';
    for (var k in registry) {
      if (!registry.hasOwnProperty(k)) continue;
      var f = registry[k];
      if (t - f.t > STALE_MS) { delete registry[k]; continue; }
      if (f.b) { busy = true; if (!matched) matched = f.m; }
      if (f.d) { disc = true; matched = f.m; }
    }
    return { busy: busy, disc: disc, matched: matched };
  }
  function doCommit(busy, disc, matched) {
    if (busy === lastB && disc === lastD) return;
    lastB = busy; lastD = disc;
    paintButton(busy, disc);
    hudLog('STATE b=' + (busy ? 1 : 0) + ' d=' + (disc ? 1 : 0) + ' ' + (matched || ''));
    try { if (window.CCStudio && window.CCStudio.setSessionState) window.CCStudio.setSessionState(busy, disc); } catch (_) {}
  }
  function aggregate() {
    var s = computeState();
    // 変化なし: 保留中の off タイマーがあれば取り消して安定状態に戻す。
    if (s.busy === lastB && s.disc === lastD) {
      if (offTimer) { clearTimeout(offTimer); offTimer = null; }
      return;
    }
    // on 方向（初回含む）は即時。off だけのときのみデバウンス。
    var goingOn = (lastB !== true && s.busy) || (lastD !== true && s.disc);
    if (goingOn) {
      if (offTimer) { clearTimeout(offTimer); offTimer = null; }
      doCommit(s.busy, s.disc, s.matched);
      return;
    }
    // off 方向: タイマーは「一度だけ」張る（毎tick貼り直すと 400ms<800ms で永遠に発火しないバグになる）。
    if (!offTimer) {
      offTimer = setTimeout(function () {
        offTimer = null;
        var s2 = computeState();          // 発火時点の最新値で確定
        doCommit(s2.busy, s2.disc, s2.matched);
      }, OFF_DEBOUNCE_MS);
    }
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
