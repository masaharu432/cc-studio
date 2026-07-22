// ==CCStudioPlugin==
// @name        ui-zoom
// @version     0.1.0
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
//   CSS zoom は iframe 内へ継承される（css-viewport 標準, Chromium 128+）。チャット等のコンテンツ
//   フレーム（＝自文書に iframe を持たない葉フレーム）は currentCSSZoom で継承倍率を実測し、逆倍率を
//   掛けて等倍へ戻す。実測ベースなので、継承されない環境では補正ゼロ（誤って拡大しない）に倒れる。
//   iframe を抱える中間ラッパーフレームは何もしない。ロード途中で iframe が現れたら（＝実は中間
//   フレームだった）補正を解除する。
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
  var POLL_MS = 1000;                     // 低頻度の自己校正（トップのトグル追従・iframe 出現検知の保険）
  var EPS = 0.001;
  var HUD_MSG = 'cc-uz-hud';              // クロスオリジンフレーム → top へのログ中継種別

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
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (m && m.k === HUD_MSG && typeof m.log === 'string') pushShared(m.log);
      }, false);
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

  // ---- 役割判定・倍率適用 ----
  function hasIframe() {
    try { return !!document.querySelector('iframe,frame'); } catch (_) { return true; }
  }
  // documentElement の実効 zoom（自分に掛けた分も含む積）。API 未実装なら null。
  function effZoom() {
    try {
      var de = document.documentElement;
      if (de && typeof de.currentCSSZoom === 'number') return de.currentCSSZoom;
    } catch (_) {}
    return null;
  }

  // トップ: enabled に応じて Z を適用/除去するだけ。
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

  // 非トップ: 葉フレームなら継承倍率を実測して逆倍率で等倍へ。中間フレームなら補正解除。
  //   own = 自分が掛けている zoom（初期 1）。継承分 = currentCSSZoom / own。
  //   enabled は読まない: OFF でトップが zoom を外せば継承が 1 に戻り、次の校正で補正も自然に消える。
  var own = 1;
  var apiLogged = false;
  function applyFrame() {
    try {
      var de = document.documentElement; if (!de) return;
      if (hasIframe()) {                  // 実は中間ラッパーフレームだった → 補正解除して以後何もしない
        if (own !== 1) { de.style.zoom = ''; own = 1; emitLog('wrapper: comp removed'); }
        return;
      }
      var cz = effZoom();
      if (cz === null) {
        if (!apiLogged) { apiLogged = true; emitLog('leaf: no currentCSSZoom API (no comp)'); }
        return;                           // 補正しない＝全体縮小のまま（拡大方向には倒れない）
      }
      var inherited = cz / own;
      if (!isFinite(inherited) || inherited <= 0) return;
      var k = 1 / inherited;
      if (Math.abs(k - own) <= EPS) return;
      if (Math.abs(k - 1) <= EPS) { de.style.zoom = ''; own = 1; }
      else { de.style.zoom = String(k); own = k; }
      emitLog('leaf inh=' + inherited.toFixed(3) + ' comp=' + own.toFixed(3));
    } catch (_) {}
  }

  function tick() { if (isTop) applyTop(); else applyFrame(); }

  // ---- 起動 ----
  function start() {
    tick();                               // document-start で即適用（フラッシュ防止）
    try { window.addEventListener('ccstudio:setting', function (e) {
      var d = e && e.detail;
      if (d && d.plugin === NAME) tick(); // enabled/diag のライブ反映
    }, false); } catch (_) {}
    try { new MutationObserver(tick).observe(document.documentElement, { subtree: true, childList: true }); } catch (_) {}
    try { setInterval(tick, POLL_MS); } catch (_) {}
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
