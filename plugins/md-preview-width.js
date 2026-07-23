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
//   VS Code の Markdown プレビューは html と body の両方に `padding:0 26px` を持ち、914px 以上では
//   `@media(min-width:914px){body{padding:0 calc((100%-862px)/2)}}` も乗る（いずれも !important
//   ではない）。本文が左右の余白で細い帯に閉じ込められる。実機 CDP 実測（code-server 4.126.0）:
//     - プレビュー判定: 葉フレームは `<meta id="vscode-markdown-preview-data" …>` を必ず持つ
//       （エディタ・チャット等の他 webview フレームは持たない）。`body.vscode-body` もこのフレーム
//       にしかないが、meta の方が構造的に一意なのでこちらを判定に採る。
//     - 余白源は html と body の左右 padding の二段。body だけ 0 にしても html の 26px が残る
//       （gutter=0 実測: html padL/R=26px → body.left=26px）。両方を制御する。
//     - 総インセットを gutter に一致させるため html=0 / body=gutter に固定（子の .markdown-body は
//       padding/margin とも 0 で寄与しないため触らない）。
//   CSS は最小限（html と body の左右 padding のみ !important）。box-sizing/max-width は実測上すでに
//   問題ないため強制しない（効果のない上書きは書かない）。
(function () {
  'use strict';
  // フレームごとに 1 度だけ武装（二重注入で setInterval/リスナが二重化するのを防ぐ。ui-zoom と同じ作法）。
  if (window.__ccMdPreviewWidth) return;
  window.__ccMdPreviewWidth = true;
  var NS = 'md-preview-width';
  var STYLE_ID = 'md-preview-width';
  var DEFAULT_GUTTER = 12;           // メタの @setting default と一致させる
  var MIN = 0, MAX = 80;             // クランプ用（メタと一致）

  // 注入先ドキュメントが Markdown プレビューか判定する（プレビュー以外では false）。
  // 実測確定: プレビュー葉フレームは常に #vscode-markdown-preview-data の meta を持つ。
  function isPreviewFrame(doc) {
    try { return !!doc.getElementById('vscode-markdown-preview-data'); } catch (_) { return false; }
  }
  // ライブ反映の要。設定ランタイムの ccstudio:setting は postMessage 連鎖で下方伝搬されるが、
  // 深くネストした Markdown プレビュー葉フレームまでは届かないことが実機で判明（連鎖が途中で切れる）。
  // 一方トップフレームの window.__ccPluginSettings はネイティブが main フレーム直接更新で常に最新。
  // プレビューは code-server と同一オリジンなので window.top を読める。トップ優先で読み、失敗時は自フレーム。
  function settingsSource() {
    try { if (window.top && window.top.__ccPluginSettings) return window.top.__ccPluginSettings; } catch (_) {}
    return window.__ccPluginSettings || {};
  }
  function clampGutter(v) {
    v = (v == null || isNaN(+v)) ? DEFAULT_GUTTER : +v;
    return Math.max(MIN, Math.min(MAX, v));
  }
  function readGutter() {
    return clampGutter((settingsSource()[NS] || {}).gutter);
  }

  // 余白は html と body の二段の左右 padding。html を 0 に固定し gutter を body に載せる
  // ことで、総インセット = gutter px にそろえる（実測: body だけでは html の 26px が残る）。
  function css(px) {
    return 'html{padding-left:0 !important;padding-right:0 !important;}' +
      'body{' +
        'padding-left:' + px + 'px !important;' +
        'padding-right:' + px + 'px !important;' +
      '}';
  }
  var lastPx = null;                                  // 直近適用値。変化時のみ書き換えて無駄な再計算を避ける。
  function applyGutter(px) {
    var doc = document;
    if (!isPreviewFrame(doc)) return;               // プレビュー以外では何もしない
    try {
      var st = doc.getElementById(STYLE_ID);
      if (!st) {
        st = doc.createElement('style');
        st.id = STYLE_ID;
        (doc.head || doc.documentElement).appendChild(st);
        lastPx = null;                              // 文書差し替えで消えた → 次で必ず書き直す
      }
      if (px !== lastPx || !st.textContent) { st.textContent = css(px); lastPx = px; }
    } catch (_) {}
  }

  // ⚙ での変更・「デフォルトに戻す」の両方が setSetting 経由で同イベントを発火する。連鎖が届く
  // フレームでは即時反映、届かないプレビューフレームでは下の tick ポーリングが拾う（二重の保険）。
  function onSetting(e) {
    var d = e && e.detail; if (!d || d.plugin !== NS || d.key !== 'gutter') return;
    applyGutter(clampGutter(d.value));
  }
  function bind() {
    try { window.removeEventListener('ccstudio:setting', onSetting); } catch (_) {}
    try { window.addEventListener('ccstudio:setting', onSetting); } catch (_) {}
  }

  // webview は起動時に document.open()/write() で葉文書を書き換えることがあり、<style> と
  // リスナが消える（ui-zoom v0.5.1 の既知事例）。1本の tick で「リスナ再登録」「<style> 再適用」に
  // 加え、毎回 readGutter() で最新値を適用する（イベントが届かないプレビューフレームのライブ反映経路。
  // lastPx ガードで値が変わらない限り DOM は書き換えない）。
  function tick() {
    bind();
    if (!isPreviewFrame(document)) return;
    applyGutter(readGutter());
  }
  applyGutter(readGutter());                        // 初回
  bind();                                            // 初回
  try { setInterval(tick, 1000); } catch (_) {}      // 差し替え検知の保険（軽量・存在チェックのみ）
})();
