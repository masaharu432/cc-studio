// ==CCStudioPlugin==
// @name        chat-link-open
// @version     1.0.0
// @description チャットの返信に出るファイルリンク（例: foo.md / src/bar.ts）をタップしたとき、真っ白／Not found にならず、エディタのタブで開きます。.md はサーバ側の cc-open 拡張がプレビュー表示に切り替えます。
// @run-at        document-start
// @all-frames    true
// ==/CCStudioPlugin==
// chat-link-open.js — CC Studio プラグイン（表示側）。
//
// チャット本文のファイルリンク（相対/絶対パス、:line/#Lxx 付き）のタップを横取りし、拡張ホストの
// open_file(showTextDocument) でエディタのタブに開く。チャット本文フレームには VS Code の api が無いため、
// webview 本体フレーム(frame W: __vscode_post_message__ 保持)へ BroadcastChannel で橋渡しして送る。
// .md をプレビューにするのはサーバ側の cc-open 拡張（テキストで開かれた .md を既定エディタ=プレビューへ切替）。
(function () {
  'use strict';

  // ── frame W: __vscode_post_message__ と channelId を捕捉 ──
  var pmFunc = null, channelId = null;
  function wrapPmf(real) {
    pmFunc = real;
    return function (command, data) {
      try {
        if (command === 'onmessage') {
          var msg = data && data.message;
          if (msg && typeof msg === 'object' && typeof msg.channelId === 'string' && msg.channelId) channelId = msg.channelId;
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
  function sendOpen(p) {
    if (!isOpener()) return false;
    try {
      pmFunc('onmessage', {
        message: {
          type: 'request', channelId: channelId,
          requestId: 'cl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
          request: { type: 'open_file', filePath: p.filePath, location: { startLine: p.startLine, endLine: p.endLine } },
        },
        transfer: undefined,
      });
      return true;
    } catch (_) { return false; }
  }

  // ── BroadcastChannel 中継（active-frame → frame W）──
  var bc = null, seenOpen = {};
  try { bc = new BroadcastChannel('cc-clo'); } catch (_) { bc = null; }
  function bcPost(o) { try { if (bc) bc.postMessage(o); } catch (_) {} }
  if (bc) {
    bc.onmessage = function (e) {
      var m = e && e.data;
      if (!m || typeof m !== 'object' || m.t !== 'open') return;
      if (seenOpen[m.id]) return; seenOpen[m.id] = 1;
      if (isOpener()) sendOpen(m.p);
    };
  }
  function relayOpen(p) {
    var id = 'o-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    seenOpen[id] = 1;
    bcPost({ t: 'open', id: id, p: p });
  }

  function parsePath(href) {
    var m = /^([^#]*?)(?:[:#]L?(\d+)(?:-L?(\d+))?)?$/.exec(href);
    if (!m) return null;
    var n = (m[1] || '').trim(); if (!n) return null;
    return { filePath: n, startLine: m[2] ? parseInt(m[2], 10) : undefined, endLine: m[3] ? parseInt(m[3], 10) : undefined };
  }
  var SCHEME = /^[a-z][a-z0-9+.-]*:/i;   // http: https: mailto: 等 scheme 付きはファイルでない

  function onClick(ev) {
    try {
      var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return;   // 純フラグメントは触らない
      if (SCHEME.test(href)) return;                 // 外部 URL 等は既定に委ねる
      var p = parsePath(href); if (!p) return;
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (!(isOpener() && sendOpen(p))) relayOpen(p);
    } catch (_) {}
  }
  document.addEventListener('click', onClick, true);   // capture: 拡張の onClick より先に拾う
})();
