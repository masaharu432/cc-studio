// ==CCStudioPlugin==
// @name        chat-link-open
// @version     0.1.0
// @description チャットの返信に出るファイルリンク（例: foo.md や src/bar.ts）をタップしたとき、真っ白な空白画面になるのを防ぎ、エディタのタブとして開きます。
// @run-at        document-start
// @all-frames    true
// ==/CCStudioPlugin==
// chat-link-open.js — CC Studio プラグイン。
//
// 背景（拡張 webview/index.js の実機調査で確定）:
//   チャット本文の Markdown リンクは拡張が <a href=".." target="_blank"> として描画し、
//   onClick で pN(href) を呼ぶ。pN がファイル参照として解釈できた時だけ preventDefault して
//   fileOpener.open(filePath) する。解釈に失敗（pN→null）すると preventDefault されず、
//   target="_blank" の既定遷移が走り、相対 href が vscode-webview://<id>/<相対パス> に解決され、
//   存在しないリソースへ飛んで「真っ白な画面」になる。
//   （拡張ホストは {type:"request",channelId,requestId,request:{type:"open_file",filePath,location}}
//    を受け取ると showTextDocument でタブとして開く。cwd 相対解決＋曖昧検索つきで頑健。）
//
// 方針:
//   チャットは拡張 webview の iframe（acquireVsCodeApi が生える同一オリジン枠）。document-start で
//   acquireVsCodeApi をラップして (1) vscode API 本体 と (2) アプリが送る request の channelId を捕捉する。
//   クリックは capture 段でフックし、外部 URL（scheme:// 付き）・純フラグメント(#..) 以外の
//   「ワークスペース相対ファイルらしいリンク」を横取りして、白画面遷移を止め、捕捉した channel から
//   拡張の正規ルート（open_file）でタブとして開く。
//   channel が未捕捉のとき（万一のタイミング）は、拡張が自前で開けるリンク（pN 受理）は拡張に委ね、
//   それ以外は最低限「白画面遷移だけ」を止める。
(function () {
  'use strict';

  var VER = '0.1.0';
  var DIAG = false;
  function log(m) { if (DIAG) { try { console.debug('[chat-link-open] ' + m); } catch (_) {} } }

  // 拡張 webview の枠でのみ動く（top フレーム/Monaco/プレビュー枠などには触らない）。
  if (typeof window.acquireVsCodeApi !== 'function') return;

  // ── (1)(2) vscode API 本体と channelId を捕捉 ──────────────────────────
  var vscodeApi = null;
  var channelId = null;
  try {
    if (!window.__ccChatLinkHooked) {
      window.__ccChatLinkHooked = true;
      var realAcquire = window.acquireVsCodeApi;
      window.acquireVsCodeApi = function () {
        var api = realAcquire.apply(this, arguments);
        try {
          vscodeApi = api;
          var origPost = api.postMessage.bind(api);
          api.postMessage = function (msg) {
            // アプリが送る各種 request から channelId（= claudeChannelId）を盗み見る。
            try { if (msg && msg.type === 'request' && msg.channelId) channelId = msg.channelId; } catch (_) {}
            return origPost(msg);
          };
        } catch (_) {}
        return api;
      };
    }
  } catch (_) {}

  // ── 拡張側ヒューリスティック pN の再現（拡張が自前で開けるかの判定） ──────
  // 受理なら {filePath,startLine,endLine}、非受理なら null。
  function extAccepts(href) {
    var m = /^([^:#]+?)(?:[:#]L?(\d+)(?:-L?(\d+))?)?$/.exec(href);
    if (!m) return null;
    var n = m[1];
    var ok =
      n.indexOf('/') === 0 || n.indexOf('./') === 0 || n.indexOf('../') === 0 ||
      n.indexOf('.\\') === 0 || n.indexOf('..\\') === 0 ||
      /\.[a-zA-Z0-9]{1,10}$/.test(n) ||
      n.charAt(n.length - 1) === '/' || n.charAt(n.length - 1) === '\\' ||
      ((n.indexOf('/') >= 0 || n.indexOf('\\') >= 0) &&
        /^(src|lib|test|tests|dist|build|node_modules|components|utils|services|api|assets|public|private|config|scripts|docs)$/i
          .test(n.split(/[/\\]/).pop() || ''));
    if (!ok) return null;
    return { filePath: n, startLine: m[2] ? parseInt(m[2], 10) : undefined, endLine: m[3] ? parseInt(m[3], 10) : undefined };
  }

  // 我々が開くとき用に、より緩く path + 行番号を取り出す。
  function parsePath(href) {
    var m = /^([^#]*?)(?:[:#]L?(\d+)(?:-L?(\d+))?)?$/.exec(href);
    if (!m) return null;
    var n = (m[1] || '').trim();
    if (!n) return null;
    return { filePath: n, startLine: m[2] ? parseInt(m[2], 10) : undefined, endLine: m[3] ? parseInt(m[3], 10) : undefined };
  }

  // http: https: mailto: vscode-webview: command: data: blob: ... どれも scheme 付き＝ファイルではない。
  var SCHEME = /^[a-z][a-z0-9+.-]*:/i;

  function openViaChannel(p) {
    if (!vscodeApi || !channelId) return false;
    try {
      vscodeApi.postMessage({
        type: 'request',
        channelId: channelId,
        requestId: 'cl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
        request: { type: 'open_file', filePath: p.filePath, location: { startLine: p.startLine, endLine: p.endLine } },
      });
      return true;
    } catch (_) { return false; }
  }

  function onClick(ev) {
    try {
      var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return;   // 純フラグメントは触らない
      if (SCHEME.test(href)) return;                 // 外部 URL / command: / blob: 等は既定に委ねる

      if (vscodeApi && channelId) {
        // 確実に開ける状態 → 内部ファイルリンクは一括で横取りし、白画面を根絶。
        var p = parsePath(href);
        if (!p) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (!openViaChannel(p)) log('open failed for ' + href);
        return;
      }

      // channel 未捕捉のフォールバック。
      if (extAccepts(href)) return;                  // 拡張が自前で開けるものは委ねる
      // 拡張が開けない & 自分も開けない → せめて白画面遷移だけ止める。
      ev.preventDefault();
      ev.stopImmediatePropagation();
      log('blank navigation blocked (no channel) for ' + href);
    } catch (_) {}
  }

  document.addEventListener('click', onClick, true);  // capture: React の onClick より先に拾う
  log('v' + VER + ' installed');
})();
