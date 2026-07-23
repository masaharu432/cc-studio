// ==CCStudioPlugin==
// @name        ui-zoom
// @version     0.4.0
// @description Shrink the workbench chrome via viewport scale; keep webview content and native UI text at 1x.
// @description:ja workbench の外枠 UI を viewport スケールで縮小し、チャットとネイティブ UI の文字は等倍に保つ。
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
//   code-server Web 版では効かないため、トップフレームの viewport meta を initial-scale=Z に書き換えて
//   全体を縮小する（ピンチズーム相当: レイアウト幅が 1/Z 倍に広がり、workbench は「少し大きい画面」
//   として自然に敷き直す。アプリ側の useWideViewPort=true が前提）。
//
//   CSS zoom を top root に掛ける旧方式（〜v0.2）は不採用: VS Code は getClientArea(body) で
//   window.innerWidth（zoom 非補正）を読むため縮んだ分の L 字空白が残り、さらに標準化 zoom は
//   getBoundingClientRect が視覚座標・style ピクセルがローカル座標と分裂するため、メニュー等の
//   位置決めが 1-Z ぶんズレる。viewport スケールは全 API が一貫するのでどちらも起きない。
//
//   チャット等のコンテンツフレーム（＝自文書に iframe を持たない葉フレーム）は縮小を自分では観測
//   できないため、window.top へ倍率を postMessage で照会し、返信された topZ の逆倍率 1/topZ の
//   CSS zoom を掛けて文字を等倍へ戻す。返信が来ない間は補正しない（誤って拡大しない）。iframe を
//   抱える中間ラッパーフレームは何もしない。ロード途中で iframe が現れたら補正を解除する。
//
//   ネイティブ UI（エクスプローラ等のツリー・タブ・ステータスバー）はフレームでないため逆 zoom で
//   戻すと VS Code の数値ピクセルレイアウトと衝突する（枠だけ縮めれば隙間・中身だけ拡げれば溢れ）。
//   そこでジオメトリは 0.75 のまま、**フォントサイズだけ** 1/Z 倍へ上書きして可読性を保つ
//   （行高は据え置き＝密度が上がる。失敗しても「文字が小さいまま」に倒れる無害な介入）。
//   ここだけ規約の「クラス名非依存」を限定的に外し、VS Code 標準の .monaco-workbench /
//   .part.statusbar のみ参照する（値は実測してから 1/Z 倍するので原値変更にも追従）。
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
  // 有効時の viewport（workbench.html の原文と同形式で scale だけ Z に）。ピンチ無効は維持。
  var VIEWPORT_ON = 'width=device-width, initial-scale=' + Z +
    ', maximum-scale=' + Z + ', minimum-scale=' + Z + ', user-scalable=no';

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

  // viewport スケールが実際に効いたか。効けば innerWidth ≒ screen.width / Z に広がる。
  //   アプリが useWideViewPort 未対応（旧ビルド）だと meta 書き換えは無視され広がらない。
  //   その場合に葉へ Z を配ると「縮小なしでチャットだけ拡大」する事故になるため、返信前に確認する。
  function scaleApplied() {
    try {
      var sw = window.screen && window.screen.width;
      return !!sw && window.innerWidth >= (sw / Z) * 0.9;
    } catch (_) { return false; }
  }

  // トップ: enabled に応じて viewport meta の scale を Z/原文へ切り替え、照会に現在倍率を返信する。
  //   meta は document-start 時点では未パースのことがある → MutationObserver/interval の tick で
  //   出現し次第書き換える（body パース前に書ければフラッシュは目立たない）。
  var origViewport = null;                // 初回書き換え前の原文（OFF で復元する）
  var ineffLogged = false;
  function applyTop() {
    try {
      var m = document.querySelector('meta[name="viewport"]');
      if (!m) return;                     // 未パース: 次 tick で再試行
      if (origViewport === null) origViewport = m.getAttribute('content') || '';
      var want = enabled() ? VIEWPORT_ON : origViewport;
      if (m.getAttribute('content') !== want) {
        m.setAttribute('content', want);
        emitLog('top scale=' + (enabled() ? Z : 1));
        // viewport 変更で innerWidth が変わる。ブラウザ自身の resize も飛ぶが、保険で一発通知。
        try { window.dispatchEvent(new Event('resize')); } catch (_) {}
      } else if (enabled() && !ineffLogged && !scaleApplied()) {
        ineffLogged = true;               // 書き換え済みなのに広がらない＝アプリ側が未対応
        emitLog('top: scale not applied (app useWideViewPort?)');
      }
      applyFonts();
    } catch (_) {}
  }

  // ネイティブ UI のフォント等倍戻し（ヘッダコメント参照）。上書き対象は
  //   .monaco-workbench（既定 13px・タブ等の em 指定はこれに追従）と、明示 px を持つ
  //   .part.statusbar（既定 12px）のみ。原値は上書き前に実測してキャッシュする。
  var FONT_STYLE_ID = 'cc-uz-font';
  var baseRootPx = 0;                     // .monaco-workbench の原フォント px（実測）
  var baseStatusPx = 0;                   // .part.statusbar の原フォント px（実測・後から現れ得る）
  function measurePx(sel) {
    try {
      var el = document.querySelector(sel);
      if (!el) return 0;
      var v = parseFloat(getComputedStyle(el).fontSize);
      return (isFinite(v) && v > 0) ? v : 0;
    } catch (_) { return 0; }
  }
  function applyFonts() {
    try {
      var el = document.getElementById(FONT_STYLE_ID);
      if (!(enabled() && scaleApplied())) { if (el) el.parentNode.removeChild(el); return; }
      if (!baseRootPx) baseRootPx = measurePx('.monaco-workbench');
      if (!baseRootPx) return;            // workbench 未生成（login 等）: 次 tick で
      if (!baseStatusPx && !el) baseStatusPx = measurePx('.part.statusbar');  // 上書き前のみ実測
      var css = '.monaco-workbench{font-size:' + (baseRootPx / Z).toFixed(2) + 'px !important}';
      if (baseStatusPx) css += '\n.monaco-workbench .part.statusbar{font-size:' + (baseStatusPx / Z).toFixed(2) + 'px !important}';
      if (!el) {
        el = document.createElement('style'); el.id = FONT_STYLE_ID;
        (document.head || document.documentElement).appendChild(el);
      }
      if (el.textContent !== css) { el.textContent = css; emitLog('top font x' + (1 / Z).toFixed(3)); }
    } catch (_) {}
  }
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (!m) return;
        if (m.k === HUD_MSG && typeof m.log === 'string') { pushShared(m.log); return; }
        if (m.k === MSG_Q && e.source) {
          // 縮小が実際に効いているときだけ Z を配る（効いていないのに葉が拡大する事故を防ぐ）。
          try { e.source.postMessage({ k: MSG_Z, z: (enabled() && scaleApplied()) ? Z : 1 }, '*'); } catch (_) {}
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
