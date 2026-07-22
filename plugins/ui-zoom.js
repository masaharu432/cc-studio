// ==CCStudioPlugin==
// @name        ui-zoom
// @version     0.2.0
// @description Shrink the workbench chrome via CSS zoom while keeping webview content (chat etc.) at 1x.
// @description:ja workbench の外枠 UI を CSS zoom で縮小し、チャット等の文字サイズは等倍に保つ。
// @run-at      document-start
// @all-frames  true
// @setting     enabled boolean true 外枠 UI（アクティビティバー等）を縮小表示する
// @setting:ja  enabled 外枠 UI（アクティビティバー等）を縮小表示する
// @setting     diag boolean true 診断ログを focus-hud に出す
// @setting:ja  diag 診断ログを focus-hud に出す
// ==/CCStudioPlugin==
// ui-zoom.js — CC Studio プラグイン。
//
//   スマホ縦画面ではアクティビティバー等の外枠 UI が横幅を食う。window.zoomLevel は Electron 専用で
//   code-server Web 版では効かないため、トップフレームへ CSS zoom を注入して外枠ごと縮小する
//   （transform と違いレイアウトごと縮むので、空いた幅にサイドバー/エディタが詰まる）。
//
//   CSS zoom は iframe 内へ視覚的に継承される（css-viewport 標準, Chromium 128+）が、子フレームの
//   currentCSSZoom は親ドキュメント由来の zoom を含まず、継承は子から観測できない（v0.1 の敗因）。
//   そこでチャット等のコンテンツフレーム（＝自文書に iframe を持たない葉フレーム）は window.top へ
//   倍率を postMessage で照会し、返信された topZ の逆倍率 1/topZ を掛けて等倍へ戻す。返信が来ない間は
//   補正しない（誤って拡大しない）。iframe を抱える中間ラッパーフレームは何もしない。ロード途中で
//   iframe が現れたら（＝実は中間フレームだった）補正を解除する。
//
//   フレーム判定は構造ルールのみ（クラス名非依存）。倍率 Z はファイル先頭定数、変更は版数 bump。
//
//   設計: docs/specs/2026-07-22-ui-zoom-plugin-design.md
(function () {
  'use strict';
  if (window.__ccUiZoom) return;          // フレームごとに 1 度だけ武装
  window.__ccUiZoom = true;

  var NAME = 'ui-zoom';
  var Z = 0.75;                           // 外枠縮小倍率（チューニングは @version bump とセットで変更）
  var POLL_MS = 1000;                     // 倍率照会＋自己校正（トップのトグル追従・iframe 出現検知）
  var EPS = 0.001;
  var HUD_MSG = 'cc-uz-hud';              // クロスオリジンフレーム → top へのログ中継種別
  var MSG_Q = 'cc-uz-q';                  // 葉 → top: 現在倍率の照会
  var MSG_Z = 'cc-uz-z';                  // top → 葉: 現在倍率の返信 { z: Z | 1 }

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }

  // ---- 設定 ----
  function setting(key, dflt) {
    try { var s = window.__ccPluginSettings && window.__ccPluginSettings[NAME]; if (s && typeof s[key] === 'boolean') return s[key]; }
    catch (_) {}
    return dflt;
  }
  function enabled() { return setting('enabled', true); }
  function diagOn() { return setting('diag', true); }

  // ---- HUD ログ: focus-hud 共有バッファへ 'UZ ' プレフィックスで（変化時のみ・低量）。
  //   クロスオリジン(webview)フレームは window.top へ直書きできないので postMessage で top へ中継する。
  function pushShared(line) {
    try {
      var t = window.top;
      var a = t.__ccStudioFocusLog || (t.__ccStudioFocusLog = []);
      if (a[a.length - 1] === line) return;
      a.push(line); while (a.length > 200) a.shift();
    } catch (_) {}
  }
  var lastLog = '';
  function emitLog(s) {
    if (!diagOn()) return;
    var line = 'UZ ' + s;
    if (line === lastLog) return; lastLog = line;
    if (isTop) { pushShared(line); return; }
    try { window.top.__ccStudioFocusLog.length; pushShared(line); }   // 同一オリジンなら直書き
    catch (_) {
      try { window.top.postMessage({ k: HUD_MSG, log: line }, '*'); }
      catch (__) { try { console.debug('[cc-' + NAME + ']', s); } catch (___) {} }
    }
  }

  // ---- 役割判定 ----
  function hasIframe() {
    try { return !!document.querySelector('iframe,frame'); } catch (_) { return true; }
  }

  // トップ: enabled に応じて Z を適用/除去し、葉からの照会に現在倍率を返信する。
  function applyTop() {
    try {
      var de = document.documentElement; if (!de) return;
      var want = enabled() ? String(Z) : '';
      if (de.style.zoom !== want) {
        de.style.zoom = want;
        emitLog('top zoom=' + (want || '1'));
      }
    } catch (_) {}
  }
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (!m) return;
        if (m.k === HUD_MSG && typeof m.log === 'string') { pushShared(m.log); return; }
        if (m.k === MSG_Q && e.source) {
          try { e.source.postMessage({ k: MSG_Z, z: enabled() ? Z : 1 }, '*'); } catch (_) {}
        }
      }, false);
    } catch (_) {}
  }

  // 非トップ: 葉フレームなら top から配布された topZ の逆倍率で等倍へ。中間フレームなら補正解除。
  //   topZ 未受信の間は補正しない（誤って拡大しない）。enabled は読まない: 真実はトップ一元で、
  //   OFF ならば返信が z=1 になり補正も自然に消える。
  var own = 1;
  var topZ = null;
  function applyFrame() {
    try {
      var de = document.documentElement; if (!de) return;
      if (hasIframe()) {                  // 実は中間ラッパーフレームだった → 補正解除して以後何もしない
        if (own !== 1) { de.style.zoom = ''; own = 1; emitLog('wrapper: comp removed'); }
        return;
      }
      if (topZ === null) return;          // 返信待ち（未注入環境でもここで止まり、拡大方向には倒れない）
      var k = 1 / topZ;
      if (Math.abs(k - own) <= EPS) return;
      if (Math.abs(k - 1) <= EPS) { de.style.zoom = ''; own = 1; }
      else { de.style.zoom = String(k); own = k; }
      emitLog('leaf topZ=' + topZ.toFixed(3) + ' comp=' + own.toFixed(3));
    } catch (_) {}
  }
  if (!isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (m && m.k === MSG_Z && typeof m.z === 'number' && isFinite(m.z) && m.z > 0) {
          topZ = m.z; applyFrame();
        }
      }, false);
    } catch (_) {}
  }
  function query() {
    try { window.top.postMessage({ k: MSG_Q }, '*'); } catch (_) {}
  }

  //   照会は force（1s インターバル・設定イベント）と未受信時のみ。DOM 変異のたびに送ると
  //   チャットのストリーミング中に postMessage が乱発するため、変異では送らない。
  function tick(force) {
    if (isTop) { applyTop(); return; }
    applyFrame();
    if ((force || topZ === null) && !hasIframe()) query();  // 返信ハンドラが topZ を更新して掛け直す
  }

  // ---- 起動 ----
  function start() {
    tick(true);                           // document-start で即適用（フラッシュ防止）
    try { window.addEventListener('ccstudio:setting', function (e) {
      var d = e && e.detail;
      if (d && d.plugin === NAME) tick(true); // enabled/diag のライブ反映（葉は再照会で追従）
    }, false); } catch (_) {}
    try { new MutationObserver(function () { tick(false); }).observe(document.documentElement, { subtree: true, childList: true }); } catch (_) {}
    try { setInterval(function () { tick(true); }, POLL_MS); } catch (_) {}
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
