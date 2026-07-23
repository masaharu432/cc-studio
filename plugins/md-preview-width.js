// ==CCStudioPlugin==
// @name        md-preview-width
// @version     0.2.0
// @description Markdown プレビュー本文の左右余白を詰めて全幅表示する（余白量は ⚙ で調整）。
// @run-at      document-start
// @all-frames  true
// @setting     gutter number 12 0 80 4 プレビュー本文の左右ガター(px)
// ==/CCStudioPlugin==
// md-preview-width.js — CC Studio プラグイン。
//
//   VS Code の Markdown プレビューは html と body の両方に `padding:0 26px` を持ち、914px 以上では
//   `@media(min-width:914px){body{padding:0 calc((100%-862px)/2)}}` も乗る（いずれも !important
//   ではない）。本文が左右の余白で細い帯に閉じ込められる。実機 CDP 実測（code-server 4.126.0）:
//     - プレビュー判定: 葉フレームは `<meta id="vscode-markdown-preview-data" …>` を必ず持つ
//       （エディタ・チャット等の他 webview フレームは持たない）。meta が構造的に一意なので判定に採る。
//     - 余白源は html と body の二段の左右 padding。body だけ 0 にしても html の 26px が残る
//       （gutter=0 実測: html padL/R=26px）。html=0 / body=gutter に固定して総インセット=gutter に揃える
//       （子の .markdown-body は padding/margin 0 で寄与しない）。
//
//   ライブ反映は ui-zoom と同じ **postMessage 照会方式**（プル型）。設定ランタイムの ccstudio:setting は
//   postMessage 連鎖で下方伝搬されるが、深くネストしたプレビュー葉フレームまで届かない（実機で確認）。
//   真実はトップ一元（ネイティブが main フレームの window.__ccPluginSettings を直接更新し常に最新）。
//   葉は window.top へ MSG_Q を投げ、トップが現在 gutter を MSG_V で返信 → 葉が適用する。postMessage は
//   クロスオリジン webview 葉でも通る（window.top 直読みは同一オリジン限定なので採らない）。
//   webview は起動時に document.open()/write() で葉文書を書き換えリスナが消えるため、毎 tick で再武装する。
//
//   設計: docs/specs/2026-07-23-md-preview-width-design.md
(function () {
  'use strict';
  if (window.__ccMdPreviewWidth) return;              // フレームごとに 1 度だけ武装
  window.__ccMdPreviewWidth = true;

  var NS = 'md-preview-width';
  var STYLE_ID = 'md-preview-width';
  var DEFAULT_GUTTER = 12;                             // メタの @setting default と一致
  var MIN = 0, MAX = 80;                               // クランプ（メタと一致）
  var POLL_MS = 1000;                                  // 照会＋自己校正（トップのライブ変更追従）
  var MSG_Q = 'cc-mpw-q';                              // 葉 → top: 現在 gutter の照会
  var MSG_V = 'cc-mpw-v';                              // top → 葉: 現在 gutter の返信 { g }

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }

  function clampGutter(v) {
    v = (v == null || isNaN(+v)) ? DEFAULT_GUTTER : +v;
    return Math.max(MIN, Math.min(MAX, v));
  }
  // トップ一元の現在値。ローカル __ccPluginSettings はネイティブが main フレーム直接更新で最新に保つ。
  function topGutter() {
    return clampGutter(((window.__ccPluginSettings || {})[NS] || {}).gutter);
  }

  // 注入先が Markdown プレビューか（プレビュー以外では false）。実測: #vscode-markdown-preview-data を持つ。
  function isPreviewFrame(doc) {
    try { return !!doc.getElementById('vscode-markdown-preview-data'); } catch (_) { return false; }
  }
  // html を 0 に固定し gutter を body に載せる（総インセット = gutter px）。
  function css(px) {
    return 'html{padding-left:0 !important;padding-right:0 !important;}' +
      'body{padding-left:' + px + 'px !important;padding-right:' + px + 'px !important;}';
  }
  var lastPx = null;                                   // 直近適用値。変化時のみ書き換えて無駄な再計算を避ける。
  function applyGutter(px) {
    if (!isPreviewFrame(document)) return;             // プレビュー以外では何もしない
    try {
      var st = document.getElementById(STYLE_ID);
      if (!st) {
        st = document.createElement('style');
        st.id = STYLE_ID;
        (document.head || document.documentElement).appendChild(st);
        lastPx = null;                                 // 文書差し替えで消えた → 次で必ず書き直す
      }
      if (px !== lastPx || !st.textContent) { st.textContent = css(px); lastPx = px; }
    } catch (_) {}
  }

  // ---- トップ: gutter 照会に応答する（真実の一元供給元）----
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (m && m.k === MSG_Q && e.source) {
          try { e.source.postMessage({ k: MSG_V, g: topGutter() }, '*'); } catch (_) {}
        }
      }, false);
    } catch (_) {}
  }

  // ---- 葉（プレビュー）: top へ照会し返信で適用 ----
  var curGutter = null;                                // top からの受信値。未受信の間はローカルでフラッシュ防止。
  function onLeafMsg(e) {
    var m = e && e.data;
    if (m && m.k === MSG_V && typeof m.g === 'number') { curGutter = clampGutter(m.g); applyGutter(curGutter); }
  }
  // 連鎖が届くフレームでは ccstudio:setting を受けて即再照会（届かないプレビューは下の tick ポーリングが拾う）。
  function onSettingEvt(e) {
    var d = e && e.detail;
    if (d && d.plugin === NS && isPreviewFrame(document)) query();
  }
  function query() { try { window.top.postMessage({ k: MSG_Q }, '*'); } catch (_) {} }
  function arm() {
    if (isTop) return;
    try {
      window.addEventListener('message', onLeafMsg, false);          // 冪等
      window.addEventListener('ccstudio:setting', onSettingEvt, false);
    } catch (_) {}
  }

  // 1本の tick でリスナ再武装＋プレビューへの適用＋最新値の照会をまとめて面倒みる。
  function tick() {
    if (isTop) return;                                 // トップは応答役のみ
    arm();                                             // document.open で消えたリスナの再武装（冪等・軽量）
    if (!isPreviewFrame(document)) return;             // プレビュー以外の葉では何もしない
    applyGutter(curGutter === null ? topGutter() : curGutter);   // 初回はローカル（ロード時は正しい）でフラッシュ防止
    query();                                           // 最新値を照会 → 返信で curGutter 更新・掛け直し
  }

  // ---- 起動 ----
  arm();
  tick();                                              // document-start で即適用
  try { setInterval(tick, POLL_MS); } catch (_) {}
})();
