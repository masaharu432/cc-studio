// ==CCStudioPlugin==
// @name        select-diag
// @version     0.2.0
// @description 不具合調査用の診断ツールです。タップした場所の情報を記録し、右端の「DIAG」ボタンを押すと内容をコピーできます。調査が終わったら削除してください。
// @run-at        document-start
// @all-frames    true
// ==/CCStudioPlugin==
// select-diag.js — 一時診断用(画面非占有版)。
//   各フレームが touchstart/pointerdown/selectstart/contextmenu を観測(capture, 介入なし)し、要点を
//   window.top のバッファへ送る。touchstart は dispatch 後に defaultPrevented を読み、VS Code(Gesture)等が
//   選択を殺しているかを可視化する。トップの小さなボタンでバッファをクリップボードへコピー → 貼り付けて共有。
(function () {
  'use strict';

  var TAG = '__cc_diag';
  var BTN_ID = 'cc-diag-btn';
  var isTop;
  try { isTop = (window === window.top); } catch (_) { isTop = false; }

  function frameId() {
    try {
      if (isTop) return 'TOP';
      var u = location.href || '';
      if (/vscode-webview|webview/.test(u)) return 'WV';
      var p = location.pathname.split('/').filter(Boolean);
      return (p[p.length - 1] || 'frame').slice(0, 12);
    } catch (_) { return 'frame'; }
  }

  function describe(el) {
    try {
      if (!el || el.nodeType !== 1) el = (el && el.parentElement) || document.body;
      if (!el) return '?';
      var tag = (el.tagName || '?').toLowerCase();
      var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).slice(0, 2).join('.');
      var ce = el.isContentEditable ? ' ce' : '';
      var us = '';
      try { var cs = getComputedStyle(el); us = cs.webkitUserSelect || cs.userSelect || ''; } catch (_) {}
      var sc = '';
      var n = el, hops = 0;
      while (n && n.nodeType === 1 && hops < 8) {
        try {
          var st = getComputedStyle(n);
          if (/(auto|scroll)/.test(st.overflowY + st.overflow)) {
            sc = (n.tagName || '').toLowerCase() + '.' + ((typeof n.className === 'string' ? n.className : '').trim().split(/\s+/)[0] || '');
            break;
          }
        } catch (_) {}
        n = n.parentElement; hops++;
      }
      return tag + (cls ? '.' + cls : '') + ce + ' us=' + us + (sc ? ' scroll<' + sc + '>' : '');
    } catch (_) { return '?'; }
  }

  function mk(type, data) { var o = { type: type, data: data }; o[TAG] = true; return o; }
  function send(line) { try { (window.top || window).postMessage(mk('log', '[' + frameId() + '] ' + line), '*'); } catch (_) {} }

  // ---- イベント観測(各フレーム, capture, 介入なし) ----
  function onTouch(e) {
    var info = describe(e.target);
    setTimeout(function () { send('touchstart pd=' + (e.defaultPrevented ? 'YES' : 'no') + ' ' + info); }, 0);
  }
  function onSelectStart(e) { send('selectstart pd=' + (e.defaultPrevented ? 'YES' : 'no') + ' ' + describe(e.target)); }
  function onContextMenu(e) { setTimeout(function () { send('contextmenu pd=' + (e.defaultPrevented ? 'YES' : 'no') + ' ' + describe(e.target)); }, 0); }
  function onPointerDown(e) { if (e.pointerType === 'mouse') return; send('pointerdown ' + describe(e.target)); }

  function install() {
    try {
      document.addEventListener('touchstart', onTouch, true);
      document.addEventListener('selectstart', onSelectStart, true);
      document.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      send('diag installed (' + (location.href || '').slice(0, 48) + ')');
    } catch (_) {}
  }

  // ---- バッファ + コピー(トップのみ) ----
  var buf = [];
  function pushLine(s) { buf.push(s); if (buf.length > 300) buf = buf.slice(-300); updateBadge(); }

  function copyBuf() {
    var text = buf.join('\n');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('diag コピー: ' + buf.length + '行'); },
          function () { execCopy(text); });
        return;
      }
    } catch (_) {}
    execCopy(text);
  }
  function execCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.focus(); ta.select(); document.execCommand('copy'); ta.parentNode.removeChild(ta);
      toast('diag コピー: ' + buf.length + '行');
    } catch (_) { toast('コピー失敗'); }
  }

  var btn;
  function ensureButton() {
    if (!isTop) return;
    if (document.getElementById(BTN_ID)) { btn = document.getElementById(BTN_ID); return; }
    var body = document.body || document.documentElement;
    if (!body) return;
    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'DIAG 0';
    btn.style.cssText =
      'position:fixed;z-index:2147483647;right:0;top:40%;min-width:22px;height:58px;border:0;' +
      'border-radius:8px 0 0 8px;background:rgba(180,60,60,.85);color:#fff;font:10px/1.2 monospace;' +
      'padding:2px 3px;box-shadow:0 1px 4px rgba(0,0,0,.4);writing-mode:vertical-rl;';
    btn.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); copyBuf(); }, true);
    // 長押しで全消去(リセット)
    var ht = null;
    btn.addEventListener('pointerdown', function () { ht = setTimeout(function () { buf = []; updateBadge(); toast('diag クリア'); }, 800); }, true);
    btn.addEventListener('pointerup', function () { if (ht) { clearTimeout(ht); ht = null; } }, true);
    body.appendChild(btn);
  }
  function updateBadge() { if (btn) btn.textContent = 'DIAG ' + buf.length; }

  function toast(msg) {
    try {
      var t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText =
        'position:fixed;right:30px;top:42%;z-index:2147483647;background:rgba(0,0,0,.85);color:#fff;' +
        'font:11px/1.3 monospace;padding:6px 10px;border-radius:8px;pointer-events:none;white-space:nowrap;';
      (document.body || document.documentElement).appendChild(t);
      setTimeout(function () { try { if (t.parentNode) t.parentNode.removeChild(t); } catch (_) {} }, 1500);
    } catch (_) {}
  }

  if (isTop) {
    window.addEventListener('message', function (e) {
      var m = e.data;
      if (!m || typeof m !== 'object' || m[TAG] !== true) return;
      if (m.type === 'log') pushLine(m.data);
    }, false);
  }

  function start() {
    install();
    if (isTop) {
      ensureButton();
      var elapsed = 0;
      var id = setInterval(function () { elapsed += 1000; ensureButton(); updateBadge(); if (elapsed >= 15000) clearInterval(id); }, 1000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    try { if (document.documentElement) install(); } catch (_) {}
  } else {
    start();
  }
})();
