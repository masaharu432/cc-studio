// ==CCStudioPlugin==
// @name        view-width
// @version     0.4.0
// @description Reclaim wasted side space in webviews (Markdown preview / Claude Code chat); gutters adjustable live.
// @description:ja webview の無駄な左右余白を詰めて全幅化（Markdown プレビュー / Claude Code 拡張）。⚙で調整。
// @run-at      document-start
// @all-frames  true
// @setting     previewGutter number 12 0 80 4 Markdown preview left/right gutter (px)
// @setting:ja  previewGutter Markdown プレビュー本文の左右ガター(px)
// @setting     chatGutter number 0 0 200 4 Claude chat MESSAGE left/right gutter (px; 0 = full width)
// @setting:ja  chatGutter Claude チャットの「メッセージ」左右ガター(px。0=全幅)
// @setting     inputGutter number 0 0 200 4 Claude chat INPUT box left/right gutter (px; 0 = full width)
// @setting:ja  inputGutter Claude チャットの「入力欄」左右ガター(px。0=全幅)
// ==/CCStudioPlugin==
// view-width.js — CC Studio プラグイン。狭い画面で横幅を食い潰されている webview の無駄な左右余白を
// 詰める汎用プラグイン。ターゲット/部位ごとに ⚙ で独立にガター(px)を調整できる。
//
//   実機 CDP 実測（code-server 4.126.0 / Claude 拡張 2.1.218）で確定したターゲット:
//   ● Markdown プレビュー（判定: `#vscode-markdown-preview-data` の meta を持つ葉フレーム）
//       余白源は html と body の二段の左右 padding。html=0 / body=previewGutter に固定して全幅化。
//   ● Claude Code 拡張チャット（判定: <html> に CSS 変数 --app-claude-orange を持つ葉フレーム）
//       余白は 3 系統あり、**メッセージ**と**入力欄**で独立に調整する:
//         - メッセージ列 `[class*=messagesContainer]` の左右 padding 20px → chatGutter
//         - 入力欄の 680px 中央帯 `[class*=inputWrapper]` の max-width → 解除（全幅の前提）
//         - 入力欄の親 `[class*=inputContainer]`（position:absolute で left/right に ~16px インセット）
//           の left/right → inputGutter（width:auto で left/right に幅を委ねる）
//       ※ クラス名はハッシュ付き（ビルドで変動）のため `[class*=…]` の前方一致で拾う。
//       ※ 狭幅で大きな gutter を入れても潰れないよう、各側は min(px, 12vw) に制限。
//
//   ライブ反映は ui-zoom と同じ postMessage 照会方式（プル型）。真実はトップ一元（ネイティブが main
//   フレームの window.__ccPluginSettings を直接更新し常に最新）。葉は window.top へ MSG_Q を投げ、
//   トップが現在の全ガター値を MSG_V で返信 → 葉が自分の該当ターゲットへ適用する。document.open 対策で
//   毎 tick 再武装。postMessage はクロスオリジン webview 葉でも通る。
//
//   設計: docs/specs/2026-07-23-md-preview-width-design.md（view-width へ発展）
(function () {
  'use strict';
  if (window.__ccViewWidth) return;                   // フレームごとに 1 度だけ武装
  window.__ccViewWidth = true;

  var NS = 'view-width';
  var POLL_MS = 1000;
  var MSG_Q = 'cc-vw-q';                              // 葉 → top: 現在ガター値の照会
  var MSG_V = 'cc-vw-v';                              // top → 葉: 現在ガター値の返信 { g:{...} }

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }

  function clamp(v, dflt, min, max) {
    v = (v == null || isNaN(+v)) ? dflt : +v;
    return Math.max(min, Math.min(max, v));
  }
  // トップ一元の現在ガター値（ローカル __ccPluginSettings はネイティブが main フレーム直接更新で最新）。
  function gutters() {
    var c = (window.__ccPluginSettings || {})[NS] || {};
    return {
      previewGutter: clamp(c.previewGutter, 12, 0, 80),
      chatGutter: clamp(c.chatGutter, 0, 0, 200),
      inputGutter: clamp(c.inputGutter, 0, 0, 200)
    };
  }

  // ---- フレーム判定 ----
  function isPreviewFrame(doc) { try { return !!doc.getElementById('vscode-markdown-preview-data'); } catch (_) { return false; } }
  function isChatFrame(doc) { try { return !!String(getComputedStyle(doc.documentElement).getPropertyValue('--app-claude-orange')).trim(); } catch (_) { return false; } }

  // ---- CSS 生成（部位ごと・独立） ----
  function previewCss(px) {
    return 'html{padding-left:0 !important;padding-right:0 !important;}' +
      'body{padding-left:' + px + 'px !important;padding-right:' + px + 'px !important;}';
  }
  function messagesCss(px) {                           // chatGutter: メッセージ列の左右 padding
    var side = px <= 0 ? '0' : 'min(' + px + 'px, 12vw)';
    return '[class*=messagesContainer]{padding-left:' + side + ' !important;padding-right:' + side + ' !important;}';
  }
  function inputCss(px) {                              // inputGutter: 入力欄（cap 解除＋absolute インセット）
    var side = px <= 0 ? '0' : 'min(' + px + 'px, 12vw)';
    return '[class*=inputWrapper]{max-width:none !important;}' +
      '[class*=inputContainer]{left:' + side + ' !important;right:' + side + ' !important;width:auto !important;max-width:none !important;}';
  }

  // ---- ターゲット（この葉フレームに該当する 1 つに、複数の独立ガターをまとめて適用） ----
  var TARGETS = [
    { styleId: 'cc-vw-preview', match: isPreviewFrame, render: function (g) { return previewCss(g.previewGutter); } },
    { styleId: 'cc-vw-chat', match: isChatFrame, render: function (g) { return messagesCss(g.chatGutter) + inputCss(g.inputGutter); } }
  ];
  function targetFor(doc) { for (var i = 0; i < TARGETS.length; i++) { if (TARGETS[i].match(doc)) return TARGETS[i]; } return null; }

  var lastCss = {};                                   // styleId -> 直近 CSS。変化時のみ書き換える。
  function apply(t, g) {
    try {
      var css = t.render(g);
      var st = document.getElementById(t.styleId);
      if (!st) {
        st = document.createElement('style');
        st.id = t.styleId;
        (document.head || document.documentElement).appendChild(st);
        lastCss[t.styleId] = null;                     // 文書差し替えで消えた → 次で必ず書き直す
      }
      if (css !== lastCss[t.styleId] || !st.textContent) { st.textContent = css; lastCss[t.styleId] = css; }
    } catch (_) {}
  }
  function applyFrom(g) { var t = targetFor(document); if (!t) return; apply(t, g); }

  // ---- トップ: ガター照会に応答する（真実の一元供給元） ----
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (m && m.k === MSG_Q && e.source) { try { e.source.postMessage({ k: MSG_V, g: gutters() }, '*'); } catch (_) {} }
      }, false);
    } catch (_) {}
  }

  // ---- 葉: top へ照会し返信で適用 ----
  var curG = null;                                    // top からの受信値。未受信の間はローカルでフラッシュ防止。
  function onLeafMsg(e) { var m = e && e.data; if (m && m.k === MSG_V && m.g) { curG = m.g; applyFrom(curG); } }
  function onSettingEvt(e) { var d = e && e.detail; if (d && d.plugin === NS && targetFor(document)) query(); }
  function query() { try { window.top.postMessage({ k: MSG_Q }, '*'); } catch (_) {} }
  function arm() {
    if (isTop) return;
    try {
      window.addEventListener('message', onLeafMsg, false);          // 冪等
      window.addEventListener('ccstudio:setting', onSettingEvt, false);
    } catch (_) {}
  }
  function tick() {
    if (isTop) return;                                 // トップは応答役のみ
    arm();                                             // document.open で消えたリスナの再武装（冪等・軽量）
    if (!targetFor(document)) return;                  // 対象 webview 以外の葉では何もしない
    applyFrom(curG || gutters());                      // 初回はローカル（ロード時は正しい）でフラッシュ防止
    query();                                           // 最新値を照会 → 返信で curG 更新・掛け直し
  }

  // ---- 起動 ----
  function start() {
    arm();
    tick();
    [80, 200, 400, 800].forEach(function (ms) { try { setTimeout(tick, ms); } catch (_) {} });  // 初回フラッシュ短縮
    try { setInterval(tick, POLL_MS); } catch (_) {}
  }
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
