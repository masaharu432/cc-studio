// ==CCStudioPlugin==
// @name        selectable-text
// @version     0.11.1
// @description Stock code-server won't let you select or copy chat replies or preview text on mobile. This plugin adds long-press selection with a copy button and adjustable handles.
// @description:ja 素の code-server ではチャットの返信やプレビューの文字をモバイルで選択・コピーできない。このプラグインは長押しでコピーボタンを出し、範囲を調整してコピーできるようにする。
// @run-at        document-start
// @all-frames    true
// ==/CCStudioPlugin==
// selectable-text.js — CC Studio プラグイン。実機診断(select-diag)で機構を確定:
//   - 長押しで window-capture の contextmenu が webview 本体フレームで発火する(CTXwin)。
//   - その時点で選択は読める(getSelection に selLen>0)。
//   - documentElement に append した position:fixed ボタンは画面内に可視で出る(btnrect visible)。
//   つまり「長押し→ボタン表示」は確実に動く。以前ボタンが出なかったのは selectionchange の自動非表示が
//   表示直後に消していたため。→ 自動非表示を撤去し、表示は無条件・消去はコピー時/一定時間後のみにする。
//   コピー: ボタンタップで document.execCommand('copy')(VS Code 自身と同じ・clipboard-write 許可済み)で
//   生きた選択(=ハンドルで調整後の範囲)をコピー。保険で clipboard API とトップ転送、長押し時点のテキスト保持。
//   非トップ(webview)では contextmenu を preventDefault+stopImmediatePropagation して VS Code メニュー転送を止める
//   (選択ハンドルは残る)。TOP(ファイル一覧/エディタの長押しメニュー)は温存するため iframe 限定。
//   保険として user-select も広く解放(Monaco 除外)。
(function () {
  'use strict';

  var STYLE_ID = 'cc-studio-selectable-text';
  var BTN_ID = 'cc-studio-copy-btn';
  var TOAST_ID = 'cc-studio-copy-toast';
  var COPY_MSG = '__cc_st_copy';
  var VER = '0.11.1';

  var ENABLE_COPY_UI = true;
  var BTN_TIMEOUT_MS = 9000;
  var GRACE_MS = 600;          // 表示直後はキャンセル判定をしない(長押し自身の余波で消えるのを防ぐ)
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
  var lastSelText = '';
  var shownAt = 0;

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
        b.id = BTN_ID; b.type = 'button'; b.textContent = '⧉ コピー';
        b.style.cssText =
          'position:fixed;z-index:2147483647;height:38px;padding:0 16px;border:0;border-radius:19px;' +
          'background:#1e88e5;color:#fff;font:14px/38px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.5);white-space:nowrap;';
        // 選択を保ったままコピーするため、押下のデフォルト(フォーカス移動=選択解除)を止める。
        b.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
        b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); doCopy(); }, true);
        root.appendChild(b);
      }
      var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 320;
      var bw = 116, bh = 38, gap = 16;
      var left = Math.min(Math.max((cx || 20) - bw / 2, 6), vw - bw - 6);
      var top = (cy || 60) - bh - gap;
      if (top < 6) top = (cy || 0) + gap + 22;   // 上に出せなければ指の下
      b.style.left = left + 'px';
      b.style.top = top + 'px';
      shownAt = Date.now();
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hideBtn, BTN_TIMEOUT_MS);
    } catch (_) {}
  }

  // キャンセル判定: 表示から grace 経過後、ボタン以外をタップしたら消す。
  // ネイティブの選択ハンドルはドラッグしても page に pointerdown を出さない(native UI)ので、
  // ここで消えるのは「実際のコンテンツを新たにタップした=やめた/別操作」時だけ。範囲調整は妨げない。
  function onDocPointerDown(e) {
    if (!document.getElementById(BTN_ID)) return;
    if (Date.now() - shownAt < GRACE_MS) return;
    var b = document.getElementById(BTN_ID);
    if (b && (e.target === b || (b.contains && b.contains(e.target)))) return;  // ボタン操作は除外
    hideBtn();
  }
  function onSelectionChange() {
    if (!document.getElementById(BTN_ID)) return;
    if (Date.now() - shownAt < GRACE_MS) return;
    var s; try { s = window.getSelection(); } catch (_) { s = null; }
    if (s && s.isCollapsed && !selText().trim()) hideBtn();
  }

  function doCopy() {
    var live = selText();                       // ハンドルで調整後の範囲(生きた選択)
    var text = (live && live.trim()) ? live : lastSelText;
    var done = false;
    try { done = !!(document.execCommand && document.execCommand('copy')); } catch (_) {}  // 生きた選択をコピー
    if (text && text.trim()) {
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {}); } catch (_) {}
      try { (window.top || window).postMessage(mkCopy(text), '*'); } catch (_) {}
    }
    toast(done || (text && text.trim()) ? 'コピーしました' : 'コピーできませんでした');
    hideBtn();
    log('copy execCommand=' + done + ' len=' + (text ? text.length : 0));
  }
  function mkCopy(text) { var o = { text: text }; o[COPY_MSG] = true; return o; }

  function onContextMenu(e) {
    if (isTop || !ENABLE_COPY_UI) return;
    try { e.preventDefault(); e.stopImmediatePropagation(); } catch (_) {}  // VS Code メニュー転送を止める
    lastSelText = selText();                     // 長押し時点のテキストを保険で保持
    showBtn(e.clientX, e.clientY);               // 無条件に表示(自動非表示はしない)
  }

  function installCopyUI() {
    if (isTop || !ENABLE_COPY_UI) return;
    try {
      window.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('selectionchange', onSelectionChange, false);
      log('copy UI installed');
    } catch (_) {}
  }

  // ===== トップ: コピー依頼の保険受け口 =====
  // document-start と DOMContentLoaded の二度呼びで message リスナが重複しないようフラグで冪等化
  //（重複するとクリップボードへ二重書き込みされる）。
  var relayInstalled = false;
  function installTopRelay() {
    if (!isTop || relayInstalled) return;
    relayInstalled = true;
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
      // 二重注入等で短時間に複数回呼ばれても1つだけ出す(早期 return せず抑止リスナ等は壊さない)。
      var now = Date.now();
      if (window.__ccStToastAt && now - window.__ccStToastAt < 600) return;
      window.__ccStToastAt = now;
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
  var observerInstalled = false;  // 二度呼び(document-start + DOMContentLoaded)で observer を重複させない
  function installObserver() {
    if (observerInstalled) return;
    try {
      var root = document.documentElement;
      if (!root) return;
      observerInstalled = true;
      new MutationObserver(function () { schedule(); }).observe(root, { childList: true, subtree: true });
    } catch (_) { observerInstalled = false; }
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
