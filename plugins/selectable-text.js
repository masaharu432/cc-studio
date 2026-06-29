// ==CCStudioPlugin==
// @name        selectable-text
// @version     0.7.0
// @description チャットの返信やプレビューなど、編集できない文字を選択してコピーできるようにします。文字を長押しすると「コピー」ボタンが出ます。ハンドルで範囲を調整してからコピーできます。
// @run-at        document-start
// @all-frames    true
// ==/CCStudioPlugin==
// selectable-text.js — CC Studio プラグイン。実機診断 + webview ソース(pre/index.html)で確定した真因に基づく。
//   構造: webview は OUTER(pre/index.html) が INNER(チャット/プレビュー本体)にリスナを張る二層。
//   - INNER の contextmenu を OUTER の転送リスナが拾い、e.defaultPrevented なら何もせず、さもなくば
//     preventDefault(native バーを殺す) + ホストへ転送(VS Code メニューを開く)。
//   - この WebView は nested iframe の選択に native の選択 Copy バー(ActionMode)を出さない(実機 B)。
//   - だが pre/index.html は webview に clipboard-write を許可し、VS Code 自身 execCommand('copy') で
//     webview の選択をコピーしている。→ INNER フレームで document.execCommand('copy') は確実に効く。
//   対処(非トップ=webview フレーム):
//   - 長押し(contextmenu)で「コピー」ボタンを無条件に表示(選択文字列が読めるかに依存しない。v0.5 はこのゲートで失敗)。
//   - contextmenu は preventDefault + stopImmediatePropagation して VS Code メニュー転送を止める(選択ハンドルは残る)。
//   - ボタンタップで document.execCommand('copy')(生きた選択をコピー)。保険で clipboard API とトップ転送も。
//   - ハンドルで範囲調整→タップすれば調整後の範囲がコピーされる。
//   TOP(ファイル一覧/エディタの長押しメニュー)は温存するため iframe 限定。保険で user-select 解放(Monaco 除外)。
(function () {
  'use strict';

  var STYLE_ID = 'cc-studio-selectable-text';
  var BTN_ID = 'cc-studio-copy-btn';
  var TOAST_ID = 'cc-studio-copy-toast';
  var COPY_MSG = '__cc_st_copy';
  var VER = '0.7.0';

  var ENABLE_COPY_UI = true;     // 非トップ(webview)で長押し→コピーボタン
  var BTN_TIMEOUT_MS = 8000;     // 操作されなければ自動で消す
  var DEBOUNCE_MS = 250;
  var POLL_MS = 1000;
  var POLL_FOR_MS = 15000;
  var DIAG = false;

  var isTop;
  try { isTop = (window === window.top); } catch (_) { isTop = false; }
  function log(m) { if (DIAG) { try { console.debug('[selectable-text] ' + m); } catch (_) {} } }
  function selText() { try { return (window.getSelection && window.getSelection().toString()) || ''; } catch (_) { return ''; } }

  // ===== 非トップ(webview): 長押し→「コピー」ボタン =====
  var hideTimer = null;

  function hideBtn() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    var b = document.getElementById(BTN_ID);
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  function showBtn(cx, cy) {
    try {
      var root = document.documentElement || document.body;
      if (!root) return;
      var b = document.getElementById(BTN_ID);
      if (!b) {
        b = document.createElement('button');
        b.id = BTN_ID;
        b.type = 'button';
        b.textContent = '⧉ コピー';
        b.style.cssText =
          'position:fixed;z-index:2147483647;height:38px;padding:0 16px;border:0;border-radius:19px;' +
          'background:#1e88e5;color:#fff;font:13px/38px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.5);white-space:nowrap;';
        // 選択を保ったままコピーするため、押下のデフォルト(フォーカス移動=選択解除)を止める。
        b.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
        b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); doCopy(); }, true);
        root.appendChild(b);
      }
      var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 320;
      var bw = 116, bh = 38, gap = 14;
      var left = Math.min(Math.max((cx || 20) - bw / 2, 6), vw - bw - 6);
      var top = (cy || 60) - bh - gap;
      if (top < 6) top = (cy || 0) + gap + 20;
      b.style.left = left + 'px';
      b.style.top = top + 'px';
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hideBtn, BTN_TIMEOUT_MS);
    } catch (_) {}
  }

  function doCopy() {
    var done = false;
    // 1) 生きた選択をそのまま execCommand でコピー(VS Code と同じ・clipboard-write 許可済み)。
    try { done = !!(document.execCommand && document.execCommand('copy')); } catch (_) {}
    // 2) 保険: 文字列が読めるならクリップボード API / トップ転送でも。
    var text = selText();
    if (text && text.trim()) {
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {}); } catch (_) {}
      try { (window.top || window).postMessage(mkCopy(text), '*'); } catch (_) {}
    }
    toast(done || (text && text.trim()) ? 'コピーしました' : 'コピーできませんでした');
    hideBtn();
    log('copy execCommand=' + done + ' len=' + (text ? text.length : 0));
  }
  function mkCopy(text) { var o = { text: text }; o[COPY_MSG] = true; return o; }

  // 長押しで発火する contextmenu を、VS Code メニュー転送の抑止 + ボタン表示トリガに使う。
  function onContextMenu(e) {
    if (isTop || !ENABLE_COPY_UI) return;
    // 転送リスナ(pre/index.html)は e.defaultPrevented なら何もしない。両方掛けて確実に止める。
    try { e.preventDefault(); e.stopImmediatePropagation(); } catch (_) {}
    showBtn(e.clientX, e.clientY);   // 無条件に表示(選択確定は後でよい。コピーは execCommand で生きた選択を拾う)
  }

  // 選択が完全に消えたらボタンも消す(best-effort)。
  function onSelectionChange() {
    if (!document.getElementById(BTN_ID)) return;
    var s;
    try { s = window.getSelection(); } catch (_) { s = null; }
    // 何も選択されていない & テキストも空 → 消す
    if (s && s.isCollapsed && !selText()) hideBtn();
  }

  function installCopyUI() {
    if (isTop || !ENABLE_COPY_UI) return;
    try {
      window.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('selectionchange', onSelectionChange, false);
      log('copy UI installed (iframe)');
    } catch (_) {}
  }

  // ===== トップ: コピー依頼の保険受け口 =====
  function installTopRelay() {
    if (!isTop) return;
    try {
      window.addEventListener('message', function (e) {
        var m = e.data;
        if (!m || typeof m !== 'object' || m[COPY_MSG] !== true) return;
        var text = m.text || '';
        if (!text) return;
        try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).catch(function () { execCopy(text); }); return; } } catch (_) {}
        execCopy(text);
      }, false);
    } catch (_) {}
  }
  function execCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.focus(); ta.select(); document.execCommand('copy'); ta.parentNode.removeChild(ta);
    } catch (_) {}
  }

  function toast(msg) {
    try {
      var old = document.getElementById(TOAST_ID);
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var body = document.body || document.documentElement;
      if (!body) return;
      var t = document.createElement('div');
      t.id = TOAST_ID; t.textContent = msg;
      t.style.cssText =
        'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483647;' +
        'background:rgba(0,0,0,.82);color:#fff;font-size:13px;padding:8px 14px;border-radius:16px;' +
        'pointer-events:none;white-space:nowrap;';
      body.appendChild(t);
      setTimeout(function () { try { if (t.parentNode) t.parentNode.removeChild(t); } catch (_) {} }, 1300);
    } catch (_) {}
  }

  // ===== user-select 広域解放(保険) =====
  var CSS =
    '*:not(input):not(textarea){' +
      '-webkit-user-select:text !important;' +
      'user-select:text !important;' +
      '-webkit-touch-callout:default !important;' +
    '}' +
    '.monaco-editor,.monaco-editor *{' +
      '-webkit-user-select:none !important;' +
      'user-select:none !important;' +
    '}';
  function ensureStyle() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      var head = document.head || document.documentElement;
      if (!head) return;
      var el = document.createElement('style');
      el.id = STYLE_ID; el.textContent = CSS;
      head.appendChild(el);
    } catch (_) {}
  }
  var pending = false;
  function schedule() { if (pending) return; pending = true; setTimeout(function () { pending = false; ensureStyle(); }, DEBOUNCE_MS); }
  function installObserver() {
    try {
      var root = document.documentElement;
      if (!root) return;
      new MutationObserver(function () { schedule(); }).observe(root, { childList: true, subtree: true });
    } catch (_) {}
  }

  function start() {
    ensureStyle();
    installObserver();
    installCopyUI();
    installTopRelay();
    var elapsed = 0;
    var id = setInterval(function () { elapsed += POLL_MS; ensureStyle(); if (elapsed >= POLL_FOR_MS) clearInterval(id); }, POLL_MS);
    log('v' + VER + ' started (top=' + isTop + ')');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    try { if (document.documentElement) { ensureStyle(); installObserver(); installCopyUI(); installTopRelay(); } } catch (_) {}
  } else {
    start();
  }
})();
