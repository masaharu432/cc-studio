// ==CCStudioPlugin==
// @name        ui-zoom
// @version     0.5.0
// @description Shrink the workbench chrome via viewport scale; fonts and webview scale are adjustable live from settings.
// @description:ja workbench の外枠 UI を viewport スケールで縮小。倍率・文字サイズは⚙設定からライブ調整できる。
// @run-at      document-start
// @all-frames  true
// @setting     enabled boolean true Shrink the outer UI (activity bar etc.)
// @setting:ja  enabled 外枠 UI（アクティビティバー等）を縮小表示する
// @setting     shrink number 0.75 0.5 1.0 0.05 Chrome shrink ratio (smaller = narrower bars)
// @setting:ja  shrink 外枠の縮小率（小さいほどバーが細い）
// @setting     sidebarFont number 0.9 0.7 1.3 0.05 Sidebar text size (1.0 = original)
// @setting:ja  sidebarFont サイドバー文字（1.0 = 縮小前と同じ）
// @setting     uiFont number 0.9 0.7 1.3 0.05 Other UI text size (tabs/status bar etc.)
// @setting:ja  uiFont その他 UI 文字（タブ・ステータスバー等）
// @setting     claudeFont number 1.0 0.7 1.3 0.05 Claude webview scale (1.0 = original)
// @setting:ja  claudeFont Claude 表示倍率（1.0 = 縮小前と同じ）
// @setting     diag boolean true Emit diagnostics to focus-hud
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
//   そこでジオメトリは縮小のまま、**フォントサイズだけ**上書きして可読性を保つ（行高は据え置き＝
//   密度が上がる。失敗しても「文字が小さいまま」に倒れる無害な介入）。ここだけ規約の
//   「クラス名非依存」を限定的に外し、VS Code 標準の .monaco-workbench / .part 系のみ参照する
//   （値は実測してから係数を掛けるので原値変更にも追従。textZoom は実測して除去）。
//
//   フレーム判定は構造ルールのみ（クラス名非依存）。v0.5: 縮小率 shrink・サイドバー文字
//   sidebarFont・その他 UI 文字 uiFont・webview 倍率 claudeFont は ⚙ 設定からライブ変更できる
//   （文字系は 1.0 = 縮小前の見かけ。旧アプリでは設定が出ず内蔵既定値で動く）。
//
//   設計: docs/specs/2026-07-22-ui-zoom-plugin-design.md,
//         docs/specs/2026-07-23-plugin-settings-number-design.md
(function () {
  'use strict';
  if (window.__ccUiZoom) return;          // フレームごとに 1 度だけ武装
  window.__ccUiZoom = true;

  var NAME = 'ui-zoom';
  var POLL_MS = 1000;                     // 倍率照会＋自己校正（トップのトグル追従・iframe 出現検知）
  var VP_DEBOUNCE_MS = 300;               // viewport 再書き換えのデバウンス（ステッパー連打対策）
  var EPS = 0.001;
  var HUD_MSG = 'cc-uz-hud';              // クロスオリジンフレーム → top へのログ中継種別
  var MSG_Q = 'cc-uz-q';                  // 葉 → top: 現在倍率の照会
  var MSG_Z = 'cc-uz-z';                  // top → 葉: 現在倍率の返信 { z }（葉は 1/z を掛ける）

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }

  // ---- 設定（⚙ からライブ変更される。既定値は旧アプリ＝設定未注入でも成立する内蔵値） ----
  function boolSetting(key, dflt) {
    try { var s = window.__ccPluginSettings && window.__ccPluginSettings[NAME]; if (s && typeof s[key] === 'boolean') return s[key]; }
    catch (_) {}
    return dflt;
  }
  function numSetting(key, dflt, min, max) {
    try {
      var s = window.__ccPluginSettings && window.__ccPluginSettings[NAME];
      var v = s && s[key];
      if (typeof v === 'number' && isFinite(v)) return Math.min(max, Math.max(min, v));
    } catch (_) {}
    return dflt;
  }
  function enabled() { return boolSetting('enabled', true); }
  function diagOn() { return boolSetting('diag', true); }
  function shrink() { return numSetting('shrink', 0.75, 0.5, 1.0); }         // 外枠縮小率 Z
  function sidebarFont() { return numSetting('sidebarFont', 0.9, 0.7, 1.3); } // 1.0 = 縮小前の見かけ
  function uiFont() { return numSetting('uiFont', 0.9, 0.7, 1.3); }
  function claudeFont() { return numSetting('claudeFont', 1.0, 0.7, 1.3); }
  // 有効時の viewport 文字列（workbench.html の原文と同形式で scale だけ z に）。ピンチ無効は維持。
  function viewportContent(z) {
    return 'width=device-width, initial-scale=' + z +
      ', maximum-scale=' + z + ', minimum-scale=' + z + ', user-scalable=no';
  }

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

  // viewport スケールが実際に効いたか。効けば innerWidth ≒ screen.width / z に広がる。
  //   アプリが useWideViewPort 未対応（旧ビルド）だと meta 書き換えは無視され広がらない。
  //   その場合に葉へ z を配ると「縮小なしでチャットだけ拡大」する事故になるため、返信前に確認する。
  function scaleApplied() {
    try {
      var sw = window.screen && window.screen.width;
      return !!sw && window.innerWidth >= (sw / shrink()) * 0.9;
    } catch (_) { return false; }
  }

  // トップ: enabled/shrink に応じて viewport meta を切り替え、照会に現在倍率を返信する。
  //   meta は document-start 時点では未パースのことがある → MutationObserver/interval の tick で
  //   出現し次第書き換える（body パース前に書ければフラッシュは目立たない）。
  //   2 回目以降の書き換え（⚙ ステッパー連打）は VP_DEBOUNCE_MS でデバウンスし、発火時に最新値で書く。
  var origViewport = null;                // 初回書き換え前の原文（OFF で復元する）
  var ineffLogged = false;
  var vpAppliedOnce = false;
  var vpTimer = null;
  function writeViewport() {
    try {
      var m = document.querySelector('meta[name="viewport"]');
      if (!m) return;
      var want = enabled() ? viewportContent(shrink()) : origViewport;
      if (want !== null && m.getAttribute('content') !== want) {
        m.setAttribute('content', want);
        vpAppliedOnce = true;
        emitLog('top scale=' + (enabled() ? shrink() : 1));
        // viewport 変更で innerWidth が変わる。ブラウザ自身の resize も飛ぶが、保険で一発通知。
        try { window.dispatchEvent(new Event('resize')); } catch (_) {}
      }
    } catch (_) {}
  }
  function applyTop() {
    try {
      var m = document.querySelector('meta[name="viewport"]');
      if (!m) return;                     // 未パース: 次 tick で再試行
      if (origViewport === null) origViewport = m.getAttribute('content') || '';
      var want = enabled() ? viewportContent(shrink()) : origViewport;
      if (m.getAttribute('content') !== want) {
        if (!vpAppliedOnce) writeViewport();          // 初回は即時（フラッシュ防止）
        else if (!vpTimer) vpTimer = setTimeout(function () { vpTimer = null; writeViewport(); applyFonts(); }, VP_DEBOUNCE_MS);
      } else if (enabled() && !ineffLogged && !scaleApplied()) {
        ineffLogged = true;               // 書き換え済みなのに広がらない＝アプリ側が未対応
        emitLog('top: scale not applied (app useWideViewPort?)');
      }
      applyFonts();
    } catch (_) {}
  }

  // ネイティブ UI のフォント等倍戻し（ヘッダコメント参照）。上書き対象は 3 つ:
  //   .monaco-workbench（既定 13px）/ .part > .content（既定 13px の明示再指定。ツリー・タブは
  //   ここから継承しており、root だけ上書きしても届かない — 実 workbench の CDP 実測で確認）/
  //   .part.statusbar（明示 12px）。原値は上書き前に実測してキャッシュする。
  var FONT_STYLE_ID = 'cc-uz-font';
  var baseRootPx = 0;                     // .monaco-workbench の原フォント px（実測・textZoom 除去済み）
  var baseContentPx = 0;                  // .part > .content の原フォント px（同上）
  var baseStatusPx = 0;                   // .part.statusbar の原フォント px（同上・後から現れ得る）
  // Android WebView の textZoom（システムフォントスケール）は computed font-size に乗って見える。
  // 実測値をそのまま CSS に書き戻すと textZoom が二重適用され 1.15 倍等に膨らむ（実機 uz-diag で
  // 実測特定: 上書き 19.93px → computed 22.92px = ×1.15）。font-size:100px のプローブ要素で
  // 倍率を実測し、測定値から除いてから書く。デスクトップ Chrome では 1 になり無害。
  var tzoom = 0;                          // 0=未測定
  function textZoomFactor() {
    try {
      var s = document.createElement('span');
      s.style.cssText = 'position:absolute;visibility:hidden;font-size:100px';
      (document.body || document.documentElement).appendChild(s);
      var t = parseFloat(getComputedStyle(s).fontSize) / 100;
      s.parentNode.removeChild(s);
      return (isFinite(t) && t > 0.3 && t < 4) ? t : 1;
    } catch (_) { return 1; }
  }
  function measurePx(sel) {
    try {
      var el = document.querySelector(sel);
      if (!el) return 0;
      var v = parseFloat(getComputedStyle(el).fontSize);
      if (!(isFinite(v) && v > 0)) return 0;
      if (!tzoom) tzoom = textZoomFactor();
      return v / tzoom;                   // textZoom を除いた素の CSS 値へ正規化
    } catch (_) { return 0; }
  }
  function applyFonts() {
    try {
      var el = document.getElementById(FONT_STYLE_ID);
      if (!(enabled() && scaleApplied())) { if (el) el.parentNode.removeChild(el); return; }
      if (!baseRootPx) baseRootPx = measurePx('.monaco-workbench');
      if (!baseRootPx) return;            // workbench 未生成（login 等）: 次 tick で
      if (!baseContentPx && !el) baseContentPx = measurePx('.monaco-workbench .part > .content');  // 上書き前のみ実測
      if (!baseStatusPx && !el) baseStatusPx = measurePx('.part.statusbar');  // 上書き前のみ実測
      // 戻し倍率 = 係数 / shrink（係数 1.0 = 縮小前の見かけ。shrink を変えても見かけが不変になる）。
      var z = shrink();
      var fkUi = uiFont() / z;
      var fkSide = sidebarFont() / z;
      var contentPx = baseContentPx || baseRootPx;
      var css = '.monaco-workbench{font-size:' + (baseRootPx * fkUi).toFixed(2) + 'px !important}';
      css += '\n.monaco-workbench .part > .content{font-size:' + (contentPx * fkUi).toFixed(2) + 'px !important}';
      // サイドバーは個別係数（.part > .content より特異度が高いのでこちらが勝つ）。
      css += '\n.monaco-workbench .part.sidebar > .content{font-size:' + (contentPx * fkSide).toFixed(2) + 'px !important}';
      if (baseStatusPx) css += '\n.monaco-workbench .part.statusbar{font-size:' + (baseStatusPx * fkUi).toFixed(2) + 'px !important}';
      // アプリ自前のオーバーレイ（⋮ スクリーン切替ボタン）は縮小せず元の見かけサイズに戻す。
      // fixed 配置の独立要素への zoom は VS Code のレイアウトと衝突しない。第一者 UI なので id 参照可。
      css += '\n#ccstudio-menu-btn{zoom:' + (1 / z).toFixed(4) + '}';
      if (!el) {
        el = document.createElement('style'); el.id = FONT_STYLE_ID;
        (document.head || document.documentElement).appendChild(el);
      }
      if (el.textContent !== css) { el.textContent = css; emitLog('top font ui=' + uiFont() + ' side=' + sidebarFont()); }
    } catch (_) {}
  }
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (!m) return;
        if (m.k === HUD_MSG && typeof m.log === 'string') { pushShared(m.log); return; }
        if (m.k === MSG_Q && e.source) {
          // 縮小が実際に効いているときだけ配る（効いていないのに葉が拡大する事故を防ぐ）。
          // z = shrink/claudeFont: 葉は 1/z を掛けるので正味 claudeFont 倍（1.0 で縮小前と同じ）。
          try {
            var z = (enabled() && scaleApplied()) ? (shrink() / claudeFont()) : 1;
            e.source.postMessage({ k: MSG_Z, z: z }, '*');
          } catch (_) {}
        }
      }, false);
    } catch (_) {}
  }

  // 非トップ: 葉フレームなら top から配布された topZ の逆倍率で等倍へ。中間フレームなら補正解除。
  //   topZ 未受信の間は補正しない（誤って拡大しない）。enabled は読まない: 真実はトップ一元で、
  //   OFF ならば返信が z=1 になり補正も自然に消える。
  //   判定は「自分が掛けた記憶」ではなく **現在の style.zoom の実測** と比較する: webview の
  //   アプリ（Claude 拡張等）が起動時に html の style を上書きして補正を消すことがあり、
  //   記憶比較だと“適用済み”と誤認して二度と直らない（v0.4.1 までの実機バグ）。
  var topZ = null;
  function applyFrame() {
    try {
      var de = document.documentElement; if (!de) return;
      var cur = parseFloat(de.style.zoom); if (!isFinite(cur) || cur <= 0) cur = 1;
      if (hasIframe()) {                  // 実は中間ラッパーフレームだった → 補正解除して以後何もしない
        if (cur !== 1) { de.style.zoom = ''; emitLog('wrapper: comp removed'); }
        return;
      }
      if (topZ === null) return;          // 返信待ち（未注入環境でもここで止まり、拡大方向には倒れない）
      var k = 1 / topZ;
      if (Math.abs(k - cur) <= EPS) return;
      if (Math.abs(k - 1) <= EPS) de.style.zoom = '';
      else de.style.zoom = String(k);
      emitLog('leaf topZ=' + topZ.toFixed(3) + ' comp=' + k.toFixed(3));
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
    // 非トップのみ: html 要素の style 上書き（webview アプリが起動時に補正を消す）を即検知して掛け直す。
    //   監視は documentElement 単体（subtree だと描画のたびに発火して無駄）。自分の再適用で 1 回
    //   発火するが、次の applyFrame は EPS 一致で何もしないためループしない。
    if (!isTop) {
      try { new MutationObserver(function () { tick(false); }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] }); } catch (_) {}
    }
    try { setInterval(function () { tick(true); }, POLL_MS); } catch (_) {}
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
