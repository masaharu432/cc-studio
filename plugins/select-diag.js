// ==CCStudioPlugin==
// @name        select-diag
// @version     0.3.0
// @description 不具合調査用の診断ツールです。長押しした時に赤いテストボタンとマーカーを出し、記録を取ります。右端の「DIAG」ボタンを押すと内容をコピーできます。調査が終わったら削除してください。
// @run-at        document-start
// @all-frames    true
// ==/CCStudioPlugin==
// select-diag.js — 一時診断用。selectable-text のコピーボタンが出ない原因の切り分け。
//   切り分けたい点:
//     (1) contextmenu が本体(チャット/プレビュー)フレームで発火しているか
//     (2) window capture と document capture で発火が違うか(selectable-text は window を使用)
//     (3) append したボタンが実際に画面に見えるか(transform/クリップで飛んでいないか)
//   長押し時、window/document 両方の contextmenu 発火を記録し、指の位置に赤い「TESTBTN」と、
//   固定位置(右上)に「CTX✓」マーカーを出し、ボタンの実座標(getBoundingClientRect)も記録する。
//   非トップ(webview)では selectable-text と同様に preventDefault+stopImmediatePropagation して VS Code メニューを止める。
(function () {
  'use strict';

  var TAG = '__cc_diag';
  var BTN_ID = 'cc-diag-btn';
  var TESTBTN_ID = 'cc-diag-testbtn';
  var MARK_ID = 'cc-diag-mark';
  var isTop;
  try { isTop = (window === window.top); } catch (_) { isTop = false; }

  function frameId() {
    try {
      if (isTop) return 'TOP';
      var u = location.href || '';
      if (/vscode-webview|webview/.test(u)) return 'WV';
      var p = location.pathname.split('/').filter(Boolean);
      return (p[p.length - 1] || 'frame').slice(0, 14);
    } catch (_) { return 'frame'; }
  }
  function selLen() { try { return (window.getSelection && window.getSelection().toString() || '').length; } catch (_) { return -1; } }
  function mk(type, data) { var o = { type: type, data: data }; o[TAG] = true; return o; }
  function send(line) { try { (window.top || window).postMessage(mk('log', '[' + frameId() + '] ' + line), '*'); } catch (_) {} }

  // ---- 長押し(contextmenu)の発火計測 + テストボタン/マーカー ----
  function appendTestUI(cx, cy) {
    try {
      var root = document.documentElement || document.body;
      if (!root) { send('NO root for testbtn'); return; }
      // 固定マーカー(位置に依存せず「append が見えるか」を確認)
      var mark = document.getElementById(MARK_ID);
      if (!mark) {
        mark = document.createElement('div');
        mark.id = MARK_ID;
        mark.textContent = 'CTX✓';
        mark.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#e53935;color:#fff;font:bold 12px monospace;padding:4px 8px;border-radius:6px;pointer-events:none;';
        root.appendChild(mark);
      }
      // 指の位置のテストボタン(位置計算/transform の影響を確認)
      var tb = document.getElementById(TESTBTN_ID);
      if (!tb) {
        tb = document.createElement('button');
        tb.id = TESTBTN_ID; tb.type = 'button'; tb.textContent = 'TESTBTN';
        tb.style.cssText = 'position:fixed;z-index:2147483647;height:40px;padding:0 14px;border:0;border-radius:8px;background:#e53935;color:#fff;font:bold 14px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.6);';
        root.appendChild(tb);
      }
      var top = (cy || 60) - 54; if (top < 4) top = (cy || 0) + 24;
      tb.style.left = Math.max(4, (cx || 20) - 50) + 'px';
      tb.style.top = top + 'px';
      // 実座標を報告
      setTimeout(function () {
        try {
          var r = tb.getBoundingClientRect();
          var cs = getComputedStyle(tb);
          send('btnrect x=' + Math.round(r.left) + ' y=' + Math.round(r.top) + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) +
               ' disp=' + cs.display + ' vis=' + cs.visibility + ' op=' + cs.opacity);
        } catch (_) {}
      }, 80);
      // しばらくで自動消去
      setTimeout(function () { try { if (tb.parentNode) tb.parentNode.removeChild(tb); if (mark.parentNode) mark.parentNode.removeChild(mark); } catch (_) {} }, 6000);
    } catch (e) { send('appendTestUI ERR ' + (e && e.message)); }
  }

  function onCtxWin(e) {
    send('CTXwin cx=' + e.clientX + ' cy=' + e.clientY + ' selLen=' + selLen());
    if (!isTop) { try { e.preventDefault(); e.stopImmediatePropagation(); } catch (_) {} appendTestUI(e.clientX, e.clientY); }
  }
  function onCtxDoc(e) { send('CTXdoc cx=' + e.clientX + ' cy=' + e.clientY + ' selLen=' + selLen()); }
  function onSelStart(e) { send('selectstart selLen=' + selLen()); }
  function onPtrDown(e) { if (e.pointerType === 'mouse') return; send('pointerdown selLen=' + selLen()); }

  function install() {
    try {
      window.addEventListener('contextmenu', onCtxWin, true);
      document.addEventListener('contextmenu', onCtxDoc, true);
      document.addEventListener('selectstart', onSelStart, true);
      document.addEventListener('pointerdown', onPtrDown, true);
      send('installed (' + (location.href || '').slice(0, 50) + ')');
    } catch (_) {}
  }

  // ---- バッファ + コピー(トップのみ) ----
  var buf = [];
  function pushLine(s) { buf.push(s); if (buf.length > 400) buf = buf.slice(-400); updateBadge(); }
  function copyBuf() {
    var text = buf.join('\n');
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(function () { toast('diag コピー: ' + buf.length + '行'); }, function () { execCopy(text); }); return; } } catch (_) {}
    execCopy(text);
  }
  function execCopy(text) {
    try { var ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'; (document.body || document.documentElement).appendChild(ta); ta.focus(); ta.select(); document.execCommand('copy'); ta.parentNode.removeChild(ta); toast('diag コピー: ' + buf.length + '行'); } catch (_) { toast('コピー失敗'); }
  }
  var btn;
  function ensureButton() {
    if (!isTop) return;
    if (document.getElementById(BTN_ID)) { btn = document.getElementById(BTN_ID); return; }
    var body = document.body || document.documentElement; if (!body) return;
    btn = document.createElement('button');
    btn.id = BTN_ID; btn.type = 'button'; btn.textContent = 'DIAG 0';
    btn.style.cssText = 'position:fixed;z-index:2147483647;right:0;top:40%;min-width:22px;height:58px;border:0;border-radius:8px 0 0 8px;background:rgba(180,60,60,.85);color:#fff;font:10px/1.2 monospace;padding:2px 3px;box-shadow:0 1px 4px rgba(0,0,0,.4);writing-mode:vertical-rl;';
    btn.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); copyBuf(); }, true);
    var ht = null;
    btn.addEventListener('pointerdown', function () { ht = setTimeout(function () { buf = []; updateBadge(); toast('diag クリア'); }, 800); }, true);
    btn.addEventListener('pointerup', function () { if (ht) { clearTimeout(ht); ht = null; } }, true);
    body.appendChild(btn);
  }
  function updateBadge() { if (btn) btn.textContent = 'DIAG ' + buf.length; }
  function toast(msg) {
    try { var t = document.createElement('div'); t.textContent = msg; t.style.cssText = 'position:fixed;right:30px;top:42%;z-index:2147483647;background:rgba(0,0,0,.85);color:#fff;font:11px/1.3 monospace;padding:6px 10px;border-radius:8px;pointer-events:none;white-space:nowrap;'; (document.body || document.documentElement).appendChild(t); setTimeout(function () { try { if (t.parentNode) t.parentNode.removeChild(t); } catch (_) {} }, 1500); } catch (_) {}
  }
  if (isTop) {
    window.addEventListener('message', function (e) { var m = e.data; if (!m || typeof m !== 'object' || m[TAG] !== true) return; if (m.type === 'log') pushLine(m.data); }, false);
  }

  function start() {
    install();
    if (isTop) { ensureButton(); var el = 0; var id = setInterval(function () { el += 1000; ensureButton(); updateBadge(); if (el >= 15000) clearInterval(id); }, 1000); }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    try { if (document.documentElement) install(); } catch (_) {}
  } else { start(); }
})();
