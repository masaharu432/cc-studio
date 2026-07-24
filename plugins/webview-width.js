// ==CCStudioPlugin==
// @name        webview-width
// @version     0.3.0
// @description Reclaim wasted side space in webviews (Markdown preview / Claude Code chat); gutters adjustable live.
// @description:ja webview の無駄な左右余白を詰めて全幅化（Markdown プレビュー / Claude Code 拡張）。⚙で調整。
// @run-at      document-start
// @all-frames  true
// @setting     previewGutter number 12 0 80 4 Markdown preview left/right gutter (px)
// @setting:ja  previewGutter Markdown プレビュー本文の左右ガター(px)
// @setting     chatGutter number 0 0 200 8 Claude chat left/right gutter (px; 0 = full width)
// @setting:ja  chatGutter Claude 拡張チャットの左右ガター(px。0=全幅)
// ==/CCStudioPlugin==
// webview-width.js — CC Studio プラグイン。狭い画面で横幅を食い潰されている webview の
// 無駄な左右余白を詰める汎用プラグイン。ターゲットごとに ⚙ で独立にガター(px)を調整できる。
//
//   実機 CDP 実測（code-server 4.126.0 / Claude 拡張 2.1.218）で確定したターゲット:
//   ● Markdown プレビュー（判定: `#vscode-markdown-preview-data` の meta を持つ葉フレーム）
//       余白源は html と body の二段の左右 padding（各 0 26px。914px 以上では body に更に大余白の
//       media query）。html=0 / body=previewGutter に固定し総インセット = previewGutter に揃える。
//   ● Claude Code 拡張チャット（判定: <html> に CSS 変数 --app-claude-orange を持つ葉フレーム）
//       会話コンテンツ列 `[class*=inputWrapper]` が max-width:680px＋auto マージンで中央寄せされ、
//       広い幅で左右が大きく余る（実測: 1052px 幅で列 680px・両側 169px）。max-width を緩めて
//       全幅化する。chatGutter=0 で max-width:none（全幅）、>0 なら calc(100% - 2*gutter)。
//       ※ クラス名はハッシュ付き（ビルドで変動）のため `[class*=inputWrapper]` の前方一致で拾う。
//
//   ライブ反映は ui-zoom と同じ postMessage 照会方式（プル型）。設定ランタイムの ccstudio:setting は
//   深くネストした webview 葉フレームまで届かないため、真実はトップ一元（ネイティブが main フレームの
//   window.__ccPluginSettings を直接更新し常に最新）。葉は window.top へ MSG_Q を投げ、トップが現在の
//   全ガター値を MSG_V で返信 → 葉が自分の該当ターゲットへ適用する。document.open 対策で毎 tick 再武装。
//
//   設計: docs/specs/2026-07-23-md-preview-width-design.md（webview-width へ発展）
(function () {
  'use strict';
  if (window.__ccWebviewWidth) return;                // フレームごとに 1 度だけ武装
  window.__ccWebviewWidth = true;

  var NS = 'webview-width';
  var POLL_MS = 1000;
  var MSG_Q = 'cc-ww-q';                              // 葉 → top: 現在ガター値の照会
  var MSG_V = 'cc-ww-v';                              // top → 葉: 現在ガター値の返信 { g:{previewGutter,chatGutter} }

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }

  function clamp(v, dflt, min, max) {
    v = (v == null || isNaN(+v)) ? dflt : +v;
    return Math.max(min, Math.min(max, v));
  }

  // ---- ターゲット定義（判定・スタイル生成・設定キー・既定/範囲・style 要素 id）----
  var TARGETS = [
    {
      key: 'previewGutter', def: 12, min: 0, max: 80, styleId: 'cc-ww-preview',
      match: function (doc) { try { return !!doc.getElementById('vscode-markdown-preview-data'); } catch (_) { return false; } },
      css: function (px) {
        return 'html{padding-left:0 !important;padding-right:0 !important;}' +
          'body{padding-left:' + px + 'px !important;padding-right:' + px + 'px !important;}';
      }
    },
    {
      key: 'chatGutter', def: 0, min: 0, max: 200, styleId: 'cc-ww-chat',
      match: function (doc) { try { return !!String(getComputedStyle(doc.documentElement).getPropertyValue('--app-claude-orange')).trim(); } catch (_) { return false; } },
      css: function (px) {
        // px=0 → 全幅(none)。>0 → 左右 px の中央寄せだが、狭い幅で gutter を大きくしても
        // 入力欄が潰れないよう max() で下限 280px を確保する（calc 単独だと極小化して壊れる）。
        var mw = px <= 0 ? 'none' : 'max(280px, calc(100% - ' + (2 * px) + 'px))';
        return '[class*=inputWrapper]{max-width:' + mw + ' !important;}';
      }
    }
  ];
  // この document に該当するターゲット（webview 葉フレームは高々1つに一致）。
  function targetFor(doc) {
    for (var i = 0; i < TARGETS.length; i++) { if (TARGETS[i].match(doc)) return TARGETS[i]; }
    return null;
  }

  // トップ一元の現在値（ローカル __ccPluginSettings はネイティブが main フレーム直接更新で最新）。
  function gutters() {
    var conf = (window.__ccPluginSettings || {})[NS] || {};
    var out = {};
    for (var i = 0; i < TARGETS.length; i++) { var t = TARGETS[i]; out[t.key] = clamp(conf[t.key], t.def, t.min, t.max); }
    return out;
  }

  var lastPx = {};                                    // styleId -> 直近適用値。変化時のみ書き換える。
  function apply(t, px) {
    try {
      var st = document.getElementById(t.styleId);
      if (!st) {
        st = document.createElement('style');
        st.id = t.styleId;
        (document.head || document.documentElement).appendChild(st);
        lastPx[t.styleId] = null;                     // 文書差し替えで消えた → 次で必ず書き直す
      }
      if (px !== lastPx[t.styleId] || !st.textContent) { st.textContent = t.css(px); lastPx[t.styleId] = px; }
    } catch (_) {}
  }
  // この葉フレームの該当ターゲットへ、与えられたガター集合から適用する。
  function applyFrom(g) {
    var t = targetFor(document); if (!t) return;
    apply(t, clamp(g[t.key], t.def, t.min, t.max));
  }

  // ---- トップ: ガター照会に応答する（真実の一元供給元）----
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
  function onLeafMsg(e) {
    var m = e && e.data;
    if (m && m.k === MSG_V && m.g) { curG = m.g; applyFrom(curG); }
  }
  function onSettingEvt(e) {
    var d = e && e.detail;
    if (d && d.plugin === NS && targetFor(document)) query();
  }
  function query() { try { window.top.postMessage({ k: MSG_Q }, '*'); } catch (_) {} }
  function arm() {
    if (isTop) return;
    try {
      window.addEventListener('message', onLeafMsg, false);          // 冪等
      window.addEventListener('ccstudio:setting', onSettingEvt, false);
    } catch (_) {}
  }

  // 1本の tick でリスナ再武装＋該当ターゲットへの適用＋最新値の照会をまとめて面倒みる。
  function tick() {
    if (isTop) return;                                 // トップは応答役のみ
    arm();                                             // document.open で消えたリスナの再武装（冪等・軽量）
    if (!targetFor(document)) return;                  // 対象 webview 以外の葉では何もしない
    applyFrom(curG || gutters());                      // 初回はローカル（ロード時は正しい）でフラッシュ防止
    query();                                           // 最新値を照会 → 返信で curG 更新・掛け直し
  }

  // ---- 起動 ----
  //   document-start 時点では判定マーカー（preview の meta / chat の CSS 変数）が未生成のことがある。
  //   ui-zoom に倣い documentElement 準備を待って開始し、さらに初回だけ速い tick を数発撃って
  //   マーカー出現直後に掛ける（フラッシュ短縮）。以後は 1s ポーリング。subtree observer は chat の
  //   ストリーミングで多発コストがあるため採らず、短いバースト＋ポーリングで代替する。
  function start() {
    arm();
    tick();                                            // 即適用（マーカーが既にあれば）
    [80, 200, 400, 800].forEach(function (ms) { try { setTimeout(tick, ms); } catch (_) {} });
    try { setInterval(tick, POLL_MS); } catch (_) {}
  }
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
