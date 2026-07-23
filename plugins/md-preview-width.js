// ==CCStudioPlugin==
// @name        md-preview-width
// @version     0.1.0
// @description Markdown プレビュー本文の左右余白を詰めて全幅表示する（余白量は ⚙ で調整）。
// @run-at      document-start
// @all-frames  true
// @setting     gutter number 12 0 80 4 プレビュー本文の左右ガター(px)
// ==/CCStudioPlugin==
// md-preview-width.js — CC Studio プラグイン。
//
//   VS Code の Markdown プレビューは body に `padding:0 26px` と、914px 以上では
//   `@media(min-width:914px){body{padding:0 calc((100%-862px)/2)}}` が乗る（いずれも !important
//   ではない）。スマホ縦画面の実効幅では後者が効き、本文が中央の細い帯に閉じ込められて左右に
//   広い無駄な余白ができる。実機 CDP 実測（code-server 4.126.0）で確定した値をそのまま使う:
//     - プレビュー判定: 葉フレームは `<meta id="vscode-markdown-preview-data" …>` を必ず持つ
//       （エディタ・チャット等の他 webview フレームは持たない）。`body.vscode-body` もこのフレーム
//       にしかないが、meta の方が構造的に一意なのでこちらを判定に採る。
//     - 上書き対象: body（box-sizing: content-box, margin: 0 の素の要素）。子の .markdown-body は
//       padding/margin とも 0 で上書き不要。
//   CSS は最小限（左右 padding のみ !important で上書き）。box-sizing や max-width は実測上すでに
//   問題ないため強制しない（ノイズになるだけで効果がない上書きは書かない）。
(function () {
  'use strict';
  var NS = 'md-preview-width';
  var STYLE_ID = 'md-preview-width';
  var DEFAULT_GUTTER = 12;           // メタの @setting default と一致させる
  var MIN = 0, MAX = 80;             // クランプ用（メタと一致）

  // 注入先ドキュメントが Markdown プレビューか判定する（プレビュー以外では false）。
  // 実測確定: プレビュー葉フレームは常に #vscode-markdown-preview-data の meta を持つ。
  function isPreviewFrame(doc) {
    try { return !!doc.getElementById('vscode-markdown-preview-data'); } catch (_) { return false; }
  }
  // 左右 padding を持つ本文コンテナのセレクタ。実測確定: body（.markdown-body は上書き不要）。
  var BODY_SELECTOR = 'body';

  function readGutter() {
    var conf = (window.__ccPluginSettings || {})[NS] || {};
    var v = conf.gutter;
    v = (v == null || isNaN(+v)) ? DEFAULT_GUTTER : +v;
    return Math.max(MIN, Math.min(MAX, v));
  }

  function css(px) {
    return BODY_SELECTOR + '{' +
      'padding-left:' + px + 'px !important;' +
      'padding-right:' + px + 'px !important;' +
    '}';
  }
  function applyGutter(px) {
    var doc = document;
    if (!isPreviewFrame(doc)) return;               // プレビュー以外では何もしない
    try {
      var st = doc.getElementById(STYLE_ID);
      if (!st) {
        st = doc.createElement('style');
        st.id = STYLE_ID;
        (doc.head || doc.documentElement).appendChild(st);
      }
      st.textContent = css(px);
    } catch (_) {}
  }

  // ⚙ での変更・「デフォルトに戻す」の両方が setSetting 経由で同イベントを発火するので、
  // 名前付きハンドラで購読するだけで両方に追従する。
  function onSetting(e) {
    var d = e && e.detail; if (!d || d.plugin !== NS || d.key !== 'gutter') return;
    var v = (d.value == null || isNaN(+d.value)) ? DEFAULT_GUTTER : +d.value;
    applyGutter(Math.max(MIN, Math.min(MAX, v)));
  }
  function bind() {
    try { window.removeEventListener('ccstudio:setting', onSetting); } catch (_) {}
    try { window.addEventListener('ccstudio:setting', onSetting); } catch (_) {}
  }

  // webview は起動時に document.open()/write() で葉文書を書き換えることがあり、<style> と
  // リスナが消える（ui-zoom v0.5.1 の既知事例）。1本の tick で「<style> 消失の再適用」と
  // 「リスナの再登録」の両方を面倒みる。
  function tick() {
    bind();
    if (!isPreviewFrame(document)) return;
    if (!document.getElementById(STYLE_ID)) applyGutter(readGutter());
  }
  applyGutter(readGutter());                        // 初回
  bind();                                            // 初回
  var iv = setInterval(tick, 1000);                  // 差し替え検知の保険（軽量・存在チェックのみ）
})();
