// ==CCStudioPlugin==
// @name        chat-link-open
// @version     0.7.0-restore
// @description 【復元・動作確認用】チャットのファイルリンクを frame W 経由で open_file 送信して開く。BroadcastChannel 中継＋opener 数バッジ。
// @run-at        document-start
// @all-frames    true
// ==/CCStudioPlugin==
// chat-link-open.js — v0.7（ファイルが開けた版）をそのまま復元。切り分け用。
(function () {
  'use strict';

  var VER = '0.7.0-restore';
  var FRAME = 'f-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  var st = { pmf: false, ch: false, top: '', opnrs: 0, acks: 0, sent: 0 };
  try { st.top = (window === window.top) ? 'T' : 'I'; } catch (_) { st.top = '?'; }

  var pmFunc = null, channelId = null;

  function wrapPmf(real) {
    pmFunc = real; st.pmf = true;
    return function (command, data) {
      try {
        if (command === 'onmessage') {
          var msg = data && data.message;
          if (msg && typeof msg === 'object' && typeof msg.channelId === 'string' && msg.channelId) { channelId = msg.channelId; st.ch = true; }
        }
      } catch (_) {}
      return real.apply(this, arguments);
    };
  }
  (function hookPmf() {
    if (window.__ccPmfHooked) return;
    window.__ccPmfHooked = true;
    var PMF = '__vscode_post_message__';
    var cur = null; try { cur = window[PMF]; } catch (_) {}
    if (typeof cur === 'function') { try { window[PMF] = wrapPmf(cur); } catch (_) {} }
    else {
      var wrapped = null;
      try {
        Object.defineProperty(window, PMF, {
          configurable: true, get: function () { return wrapped; },
          set: function (v) { wrapped = (typeof v === 'function') ? wrapPmf(v) : v; },
        });
      } catch (_) {}
    }
  })();

  function isOpener() { return !!(pmFunc && channelId); }

  function parsePath(href) {
    var m = /^([^#]*?)(?:[:#]L?(\d+)(?:-L?(\d+))?)?$/.exec(href);
    if (!m) return null;
    var n = (m[1] || '').trim(); if (!n) return null;
    return { filePath: n, startLine: m[2] ? parseInt(m[2], 10) : undefined, endLine: m[3] ? parseInt(m[3], 10) : undefined };
  }
  var SCHEME = /^[a-z][a-z0-9+.-]*:/i;

  function sendOpen(p) {
    if (!isOpener()) return false;
    try {
      pmFunc('onmessage', { message: { type: 'request', channelId: channelId, requestId: 'cl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), request: { type: 'open_file', filePath: p.filePath, location: { startLine: p.startLine, endLine: p.endLine } } }, transfer: undefined });
      st.sent++;
      return true;
    } catch (_) { return false; }
  }

  var bc = null, openers = {}, seenOpen = {};
  try { bc = new BroadcastChannel('cc-clo'); } catch (_) { bc = null; }
  function bcPost(o) { try { if (bc) bc.postMessage(o); } catch (_) {} }
  if (bc) {
    bc.onmessage = function (e) {
      var m = e && e.data; if (!m || typeof m !== 'object') return;
      if (m.t === 'ping') { if (isOpener()) bcPost({ t: 'pong', from: FRAME }); return; }
      if (m.t === 'pong') { openers[m.from] = 1; st.opnrs = Object.keys(openers).length; return; }
      if (m.t === 'open') {
        if (seenOpen[m.id]) return; seenOpen[m.id] = 1;
        if (isOpener() && sendOpen(m.p)) bcPost({ t: 'ack', id: m.id, from: FRAME });
        return;
      }
      if (m.t === 'ack') { st.acks++; return; }
    };
  }
  function pingOpeners() { bcPost({ t: 'ping', from: FRAME }); }
  function relayOpen(p) {
    var id = 'o-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    seenOpen[id] = 1;
    bcPost({ t: 'open', id: id, p: p });
  }

  function onClick(ev) {
    try {
      var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return;
      if (SCHEME.test(href)) return;
      var p = parsePath(href); if (!p) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      var how;
      if (isOpener() && sendOpen(p)) how = 'OPEN(self)';
      else { relayOpen(p); how = 'BC-RELAY'; }
      toast(how + ' | ' + badgeText() + '\n' + href);
    } catch (e) { try { toast('ERR ' + e); } catch (_) {} }
  }

  function badgeText() {
    return 'CLO ' + st.top + ' op:' + (isOpener() ? 'y' : 'n') + ' opnrs:' + st.opnrs +
      ' pmf:' + (st.pmf ? 'y' : 'n') + ' ch:' + (st.ch ? 'y' : 'n') + ' snt:' + st.sent + ' acks:' + st.acks;
  }
  function paintBadge() {
    try {
      var b = document.body || document.documentElement; if (!b) return;
      var d = document.getElementById('cc-clo-badge');
      if (!d) {
        d = document.createElement('div'); d.id = 'cc-clo-badge';
        d.style.cssText = 'position:fixed;top:2px;right:2px;z-index:2147483647;background:rgba(30,136,229,.94);color:#fff;font:9px/1.35 monospace;padding:3px 6px;border-radius:6px;max-width:88vw;white-space:pre-wrap;word-break:break-all;pointer-events:none;';
        b.appendChild(d);
      }
      d.textContent = badgeText();
    } catch (_) {}
  }
  function toast(msg) {
    try {
      var old = document.getElementById('cc-clo-toast'); if (old && old.parentNode) old.parentNode.removeChild(old);
      var b = document.body || document.documentElement; if (!b) return;
      var t = document.createElement('div'); t.id = 'cc-clo-toast'; t.textContent = msg;
      t.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483647;background:rgba(0,0,0,.85);color:#fff;font:11px/1.5 monospace;padding:8px 12px;border-radius:12px;max-width:92vw;white-space:normal;word-break:break-all;pointer-events:none;';
      b.appendChild(t);
      setTimeout(function () { try { if (t.parentNode) t.parentNode.removeChild(t); } catch (_) {} }, 4500);
    } catch (_) {}
  }

  document.addEventListener('click', onClick, true);
  paintBadge(); pingOpeners();
  var ticks = 0;
  var iv = setInterval(function () { ticks++; if (ticks % 2 === 0) pingOpeners(); paintBadge(); if (ticks > 120) clearInterval(iv); }, 500);
})();
