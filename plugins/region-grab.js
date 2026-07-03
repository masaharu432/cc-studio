// ==CCStudioPlugin==
// @name        region-grab
// @version     0.1.0
// @description Stock code-server has no way to bulk-copy text from read-only areas on mobile. This plugin adds a □ button: trace a rectangle with your finger and everything inside is copied at once.
// @description:ja 素の code-server では編集できない画面の文字をまとめてコピーする手段がない。このプラグインは左端の □ ボタンから指で範囲を囲うと、中の文字を一括コピーできるようにする。
// @run-at        document-start
// @all-frames    true
// ==/CCStudioPlugin==
// region-grab.js — CC Studio プラグイン（selectable-text とは別アプローチ・独立）
// 背景: Android WebView の選択 ActionMode が webview iframe(チャット/プレビュー)で起動せず、
//   user-select 解放(CSS)も JS プログラム選択(Selection API)もネイティブ選択 UI を呼べなかった。
//   → ネイティブ選択を一切使わず、自前オーバーレイで矩形選択し DOM テキストを収集してコピーする。
// 設計(詳細は docs/specs/2026-06-29-region-grab-design.md):
//   - クロスフレーム座標マッピングは避ける。各フレームが「自分のオーバーレイ」をローカル座標で処理する。
//   - FAB はトップフレームのみ(⋮ の直上に定位置)。タップで選択モードを全フレームへ配信。
//   - ユーザーがドラッグしたフレームだけが、その矩形に重なるテキストノードを収集して連結。
//   - クリップボード書き込みはトップフレームに集約(secure context・最も権限がある)。execCommand フォールバック付き。
//   - 収集側フレームは自前トーストで「コピーしました」を表示。
// メッセージ protocol(window.top 経由, タグ __cc_rg): enter / exit / exitAll / copy。
(function () {
  'use strict';

  var Z = 2147483647;
  var FAB_ID = 'cc-rg-fab';
  var OVERLAY_ID = 'cc-rg-overlay';
  var RECT_ID = 'cc-rg-rect';
  var TOAST_ID = 'cc-rg-toast';
  var TAG = '__cc_rg';
  var VER = '0.1.0';

  var MOVE_MIN_PX = 8;       // これ未満のドラッグは「タップ＝キャンセル」とみなす
  var ROW_TOL_PX = 6;        // 連結時、行が変わったと判断する縦差
  var DIAG = false;

  var isTop;
  try { isTop = (window === window.top); } catch (_) { isTop = false; }

  function log(m) { if (DIAG) { try { console.debug('[region-grab] ' + m); } catch (_) {} } }

  // ---------- メッセージ ----------
  function postTop(type, data) {
    try { (window.top || window).postMessage(mkMsg(type, data), '*'); } catch (_) {}
  }
  function mkMsg(type, data) { var o = { type: type, data: data }; o[TAG] = true; return o; }
  function broadcastDown(type, data) {
    try {
      for (var i = 0; i < window.frames.length; i++) {
        try { window.frames[i].postMessage(mkMsg(type, data), '*'); } catch (_) {}
      }
    } catch (_) {}
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object' || m[TAG] !== true) return;
    switch (m.type) {
      case 'enter': showOverlay(); broadcastDown('enter'); break;
      case 'exit':  hideOverlay(); broadcastDown('exit'); break;
      case 'exitAll': if (isTop) { hideOverlay(); broadcastDown('exit'); } break;
      case 'copy': if (isTop) writeClipboard(m.data && m.data.text); break;
    }
  }, false);

  // ---------- クリップボード(トップフレームで実行) ----------
  function writeClipboard(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () { execCopy(text); });
        return;
      }
    } catch (_) {}
    execCopy(text);
  }
  function execCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      ta.parentNode.removeChild(ta);
    } catch (_) {}
  }

  // ---------- FAB(トップのみ・⋮ の直上に定位置) ----------
  function ensureFab() {
    if (!isTop) return;
    try {
      if (document.getElementById(FAB_ID)) return;
      var body = document.body || document.documentElement;
      if (!body) return;
      var b = document.createElement('button');
      b.id = FAB_ID;
      b.type = 'button';
      b.setAttribute('aria-label', 'Region grab');
      b.textContent = '▢';
      // ⋮ は left:0; bottom:22%; height:84px。その直上に置く。
      b.style.cssText =
        'position:fixed;z-index:' + (Z - 1) + ';left:0;bottom:calc(22% + 92px);' +
        'width:30px;height:44px;border:0;border-radius:0 8px 8px 0;' +
        'background:rgba(30,136,229,.85);color:#fff;font-size:16px;line-height:44px;' +
        'padding:0;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.4);';
      b.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        toggleMode();
      });
      body.appendChild(b);
      log('fab placed');
    } catch (_) {}
  }

  var modeOn = false;
  function toggleMode() {
    modeOn = !modeOn;
    if (modeOn) { showOverlay(); broadcastDown('enter'); }
    else { hideOverlay(); broadcastDown('exit'); }
  }

  // ---------- オーバーレイ(各フレーム・ローカル座標) ----------
  var drag = null;

  function isLeafFrame() {
    // 子 iframe を持つフレームでオーバーレイを出すと子フレームを覆い隠してしまう。
    // 実テキストがある最深(葉)フレームだけが描画する。親はタッチを葉へ貫通させる。
    try { return window.frames.length === 0; } catch (_) { return true; }
  }

  function showOverlay() {
    try {
      if (!isLeafFrame()) return;                  // 親/中間フレームは覆わない
      if (document.getElementById(OVERLAY_ID)) return;
      var body = document.body || document.documentElement;
      if (!body) return;
      var ov = document.createElement('div');
      ov.id = OVERLAY_ID;
      ov.style.cssText =
        'position:fixed;inset:0;z-index:' + Z + ';background:rgba(0,0,0,.04);' +
        'touch-action:none;cursor:crosshair;';
      var rect = document.createElement('div');
      rect.id = RECT_ID;
      rect.style.cssText =
        'position:fixed;border:1.5px dashed #1e88e5;background:rgba(30,136,229,.12);' +
        'left:0;top:0;width:0;height:0;display:none;pointer-events:none;z-index:' + Z + ';';
      ov.appendChild(rect);

      ov.addEventListener('pointerdown', onDown, true);
      ov.addEventListener('pointermove', onMove, true);
      ov.addEventListener('pointerup', onUp, true);
      ov.addEventListener('pointercancel', onCancel, true);
      body.appendChild(ov);
      log('overlay shown');
    } catch (_) {}
  }

  function hideOverlay() {
    try {
      drag = null;
      var ov = document.getElementById(OVERLAY_ID);
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    } catch (_) {}
  }

  function setRect(x1, y1, x2, y2) {
    var r = document.getElementById(RECT_ID);
    if (!r) return;
    var left = Math.min(x1, x2), top = Math.min(y1, y2);
    var w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    r.style.left = left + 'px'; r.style.top = top + 'px';
    r.style.width = w + 'px'; r.style.height = h + 'px';
    r.style.display = 'block';
  }

  function onDown(e) {
    try {
      e.preventDefault(); e.stopPropagation();
      drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      setRect(drag.x0, drag.y0, drag.x0, drag.y0);
    } catch (_) {}
  }
  function onMove(e) {
    if (!drag) return;
    try {
      e.preventDefault(); e.stopPropagation();
      drag.x1 = e.clientX; drag.y1 = e.clientY;
      setRect(drag.x0, drag.y0, drag.x1, drag.y1);
    } catch (_) {}
  }
  function onCancel() { drag = null; var r = document.getElementById(RECT_ID); if (r) r.style.display = 'none'; }

  function onUp(e) {
    if (!drag) { postTop('exitAll'); return; }
    try { e.preventDefault(); e.stopPropagation(); } catch (_) {}
    var d = drag; drag = null;
    var moved = Math.abs(d.x1 - d.x0) >= MOVE_MIN_PX || Math.abs(d.y1 - d.y0) >= MOVE_MIN_PX;
    if (!moved) { postTop('exitAll'); return; }   // タップ＝キャンセル
    var sel = {
      left: Math.min(d.x0, d.x1), top: Math.min(d.y0, d.y1),
      right: Math.max(d.x0, d.x1), bottom: Math.max(d.y0, d.y1)
    };
    var text = harvest(sel);
    if (text) {
      postTop('copy', { text: text });             // クリップボードはトップで
      toast('コピーしました');
    } else {
      toast('テキストなし');
    }
    postTop('exitAll');
  }

  // ---------- テキスト収集(自フレーム・ローカル座標) ----------
  function intersects(a, b) {
    return !(b.left > a.right || b.right < a.left || b.top > a.bottom || b.bottom < a.top);
  }
  function harvest(sel) {
    var out = [];
    try {
      var root = document.body || document.documentElement;
      if (!root) return '';
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = w.nextNode())) {
        var v = n.nodeValue;
        if (!v || !v.trim()) continue;
        var range = document.createRange();
        range.selectNodeContents(n);
        var rects = range.getClientRects();
        var hit = false, top = Infinity, left = Infinity;
        for (var i = 0; i < rects.length; i++) {
          if (intersects(sel, rects[i])) {
            hit = true;
            if (rects[i].top < top) top = rects[i].top;
            if (rects[i].left < left) left = rects[i].left;
          }
        }
        if (hit) out.push({ text: v.trim(), top: top, left: left });
      }
    } catch (_) {}
    out.sort(function (a, b) {
      return (Math.abs(a.top - b.top) > ROW_TOL_PX) ? (a.top - b.top) : (a.left - b.left);
    });
    var res = '', prevTop = null;
    for (var j = 0; j < out.length; j++) {
      if (prevTop !== null) res += (out[j].top - prevTop > ROW_TOL_PX) ? '\n' : ' ';
      res += out[j].text;
      prevTop = out[j].top;
    }
    return res.trim();
  }

  // ---------- トースト(自フレーム) ----------
  function toast(msg) {
    try {
      var old = document.getElementById(TOAST_ID);
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var body = document.body || document.documentElement;
      if (!body) return;
      var t = document.createElement('div');
      t.id = TOAST_ID;
      t.textContent = msg;
      t.style.cssText =
        'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:' + Z + ';' +
        'background:rgba(0,0,0,.82);color:#fff;font-size:13px;padding:8px 14px;border-radius:16px;' +
        'pointer-events:none;white-space:nowrap;';
      body.appendChild(t);
      setTimeout(function () { try { if (t.parentNode) t.parentNode.removeChild(t); } catch (_) {} }, 1400);
    } catch (_) {}
  }

  // ---------- 起動 ----------
  function start() {
    ensureFab();
    // FAB が再描画で消えても復活させる(トップのみ)。
    if (isTop) {
      var elapsed = 0;
      var id = setInterval(function () {
        elapsed += 1000; ensureFab();
        if (elapsed >= 15000) clearInterval(id);
      }, 1000);
      try {
        var mo = new MutationObserver(function () { ensureFab(); });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (_) {}
    }
    log('v' + VER + ' started (top=' + isTop + ')');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
