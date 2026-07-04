// ==CCStudioPlugin==
// @name        focus-hud
// @version     1.6.7
// @description Diagnostic tool. Shows which element in which frame received focus or taps, as a timeline overlay at the top of the screen (for sharing screenshots).
// @description:ja 不具合調査用の診断ツール。どの要素・どのフレームにフォーカスやタップが入ったかを画面上部に時系列表示する（スクショで状況共有する用）。
// @run-at      document-start
// @all-frames  true
// @setting     visible boolean true Show the HUD
// @setting:ja  visible HUD を表示
// ==/CCStudioPlugin==
// focus-hud.js — CC Studio 診断プラグイン（keyboard-suppress とは独立）
// 目的: 「エクスプローラー表示でチャット入力にフォーカスが行きキーボードが出る」等の
//       フォーカス挙動を、実機のスクリーンショットで把握できるようにする。
// 仕組み:
//   - 全フレーム（document-start）で pointerdown/touchstart と focusin を capture 監視。
//   - 出来事を window.top の共有リングバッファに集約（クロスオリジンのフレームは top に
//     触れず記録できない＝その行が出ない事自体が「未到達フレーム」の手掛かり）。
//   - TOP フレームだけが画面上部にストリップを描く（タップでログ消去）。
// 抑制は一切しない（観測専用）。多重注入されても冪等。
(function () {
  'use strict';

  var COMPOSER_SEL = '[role="textbox"][aria-multiline="true"]';
  var MONACO_SEL = '.monaco-editor';
  var TAP_WINDOW_MS = 700;
  var MAX_LOG = 16;

  // 表示状態は TOP フレームの共有フラグに持つ。初期値は注入された設定（既定 true）。
  function readVisibleSetting() {
    try {
      var s = window.__ccPluginSettings && window.__ccPluginSettings['focus-hud'];
      return !(s && s.visible === false);
    } catch (_) { return true; }
  }
  function hudVisible() {
    try {
      var t = topWin();
      if (typeof t.__ccStudioHudVisible === 'undefined') t.__ccStudioHudVisible = readVisibleSetting();
      return t.__ccStudioHudVisible !== false;
    } catch (_) { return readVisibleSetting(); }
  }

  function topWin() {
    try { return window.top || window; } catch (_) { return window; }
  }
  function isTop() {
    try { return window === topWin(); } catch (_) { return true; }
  }
  function isComposer(el) {
    try {
      if (!el || !el.closest) return false;
      if (el.closest(MONACO_SEL)) return false;
      return !!el.closest(COMPOSER_SEL);
    } catch (_) { return false; }
  }
  // 自フレームの識別子（自分の location は参照可）。
  function frameTag() {
    try {
      if (isTop()) return 'top';
      var p = (location && location.pathname) || '';
      var last = p.split('/').filter(Boolean).pop() || (location && location.host) || 'sub';
      return decodeURIComponent(last).slice(0, 14);
    } catch (_) { return 'xo'; }
  }
  function elemDesc(el) {
    if (!el) return 'null';
    try {
      var tag = (el.tagName || '?').toLowerCase();
      var role = el.getAttribute && el.getAttribute('role');
      var ml = el.getAttribute && el.getAttribute('aria-multiline');
      var mon = el.closest && el.closest(MONACO_SEL) ? '.monaco' : '';
      var id = el.id ? '#' + String(el.id).slice(0, 10) : '';
      return tag + id + (role ? ('[' + role + (ml ? ' ml=' + ml : '') + ']') : '') + mon;
    } catch (_) { return '?'; }
  }
  // window.top の共有バッファへ追記（クロスオリジンは握りつぶし）。
  function logEvt(s) {
    try {
      var t = topWin();
      var arr = t.__ccStudioFocusLog || (t.__ccStudioFocusLog = []);
      if (arr[arr.length - 1] === s) return; // 連続重複は省く
      arr.push(s);
      while (arr.length > MAX_LOG) arr.shift();
    } catch (_) { /* ignore */ }
  }
  function markFrame() {
    try {
      var t = topWin();
      var set = t.__ccStudioFocusFrames || (t.__ccStudioFocusFrames = {});
      var tag = frameTag();
      if (!set[tag]) { set[tag] = 1; logEvt('frame ' + tag); }
    } catch (_) { /* ignore */ }
  }

  // ---- 監視（各フレームに1回だけ） ----
  // 設置済みフラグは documentElement に付ける（VS Code の document.open()/write() で中身が
  // 作り直されてリスナが消えても、documentElement が新しくなるので張り直せる）。
  function ensureWatch(doc) {
    if (!doc) return;
    var de = doc.documentElement;
    if (!de || de.__ccStudioFocusWatch) return;
    de.__ccStudioFocusWatch = true;
    markFrame();
    var mark = function (e) {
      try {
        doc.__ccStudioFocusTapTime = Date.now();
        doc.__ccStudioFocusTapCmp = isComposer(e.target);
        // タップ(pointerdown)がどのフレームのどの要素に届いたかを記録（抑制の許可判定の生命線）。
        logEvt(frameTag() + ' TAP' + (doc.__ccStudioFocusTapCmp ? '*' : '') + ' ' + elemDesc(e.target));
      } catch (_) { /* ignore */ }
    };
    // 外部リンク→shouldOverrideUrlLoading キャンセルの過程で「ページが遷移しかけた」証拠を
    // 掴む。BEFOREUNLOAD が出れば VS Code の終了処理（接続破棄）が走った疑いが濃くなる。
    try {
      var w2 = doc.defaultView;
      if (w2) {
        w2.addEventListener('beforeunload', function () { logEvt(frameTag() + ' BEFOREUNLOAD'); }, true);
        w2.addEventListener('pagehide', function () { logEvt(frameTag() + ' PAGEHIDE'); }, true);
      }
    } catch (_) { /* ignore */ }
    doc.addEventListener('pointerdown', mark, true);
    doc.addEventListener('touchstart', mark, true);
    doc.addEventListener('focusin', function (e) {
      var t = e.target;
      var cmp = isComposer(t);
      var tappedCmp = !!doc.__ccStudioFocusTapCmp &&
        typeof doc.__ccStudioFocusTapTime === 'number' &&
        (Date.now() - doc.__ccStudioFocusTapTime) < TAP_WINDOW_MS;
      // CMP行は keyboard-suppress の判定（user-tap か否か）と同じ観点で WOULD: 表示。
      var verdict = cmp ? (tappedCmp ? 'CMP user-tap' : 'CMP auto→WOULD-BLUR') : 'fin';
      logEvt(frameTag() + ' ' + verdict + ' ' + elemDesc(t));
    }, true);
    doc.addEventListener('focusout', function (e) {
      if (isComposer(e.target)) logEvt(frameTag() + ' out ' + elemDesc(e.target));
    }, true);
  }

  // 同一オリジンの子フレームにも降りて監視（クロスオリジンは各フレーム自身の document-start に任せる）。
  function watchAll() {
    var seen = [];
    (function walk(doc, depth) {
      ensureWatch(doc);
      if (depth <= 0) return;
      var frames;
      try { frames = doc.querySelectorAll('iframe'); } catch (_) { return; }
      for (var i = 0; i < frames.length; i++) {
        var d = null;
        try { d = frames[i].contentDocument; } catch (_) { d = null; }
        if (d && seen.indexOf(d) < 0) { seen.push(d); walk(d, depth - 1); }
      }
    })(document, 6);
  }

  // 全 iframe をツリー表示。クロスオリジンでも src は親から読めるので、入力欄が在る
  // フレーム/オリジンを特定できる。SO=contentDocument到達可（同一オリジン）, XO=不可（クロス）。
  function frameTree() {
    var lines = [];
    function nameOf(f) {
      try {
        var src = f.getAttribute('src');
        if (!src) return f.hasAttribute('srcdoc') ? '[srcdoc]' : '[no-src]';
        var u = src.split('#')[0].split('?')[0];
        var base = u.split('/').filter(Boolean).pop() || u;
        // オリジンも短く付ける（vscode-webview:// などを見分けるため）
        var orig = '';
        try { orig = new URL(src, location.href).origin; } catch (_) { orig = ''; }
        var ohint = /vscode-webview/.test(orig) ? '·vscode-webview' :
          (orig && orig !== location.origin ? '·' + orig.slice(0, 18) : '');
        return base + ohint;
      } catch (_) { return '?'; }
    }
    (function walk(doc, depth) {
      var ifr;
      try { ifr = doc.querySelectorAll('iframe'); } catch (_) { return; }
      for (var i = 0; i < ifr.length; i++) {
        var f = ifr[i];
        var d = null, ok = false;
        try { d = f.contentDocument; ok = !!d; } catch (_) { ok = false; }
        var act = ok && d.activeElement && isComposer(d.activeElement) ? ' <CMP-active>' : '';
        lines.push(new Array(depth + 1).join('  ') + '· ' + nameOf(f) + ' [' + (ok ? 'SO' : 'XO') + ']' + act);
        if (ok && depth < 6) walk(d, depth + 1);
      }
    })(document, 0);
    return lines.length ? lines.join('\n') : '(no iframes)';
  }

  // ---- 表示（TOP フレームのみ） ----
  // force=true はタップ時の明示更新。展開中は force でない限り更新しない＝凍結（スクショとログ一致）。
  function renderHud(force) {
    try {
      if (!isTop() || !document.body) return;
      if (!hudVisible()) {
        var hiddenEl = document.getElementById('__ccStudioFocusHud');
        if (hiddenEl) hiddenEl.style.display = 'none';
        return; // 非表示中は描画しない（監視・ログ収集は継続）。
      }
      var shownEl = document.getElementById('__ccStudioFocusHud');
      if (shownEl) shownEl.style.display = '';
      var el = document.getElementById('__ccStudioFocusHud');
      if (el && el.__ccExpanded && !force) return; // 展開中は凍結
      if (!el) {
        el = document.createElement('div');
        el.id = '__ccStudioFocusHud';
        el.style.cssText =
          'position:fixed;z-index:2147483647;left:0;right:0;font:10px/1.35 monospace;' +
          'background:rgba(0,0,0,.82);color:#3FD79A;padding:3px 6px;white-space:pre-wrap;' +
          '-webkit-user-select:text;user-select:text;';
        el.__ccExpanded = false; // 既定は畳む（1行）。タップで展開/収納＝左メニューを操作できる
        el.__ccFrozen = false;
        el.addEventListener('click', function () {
          // 収納中タップ→展開（その瞬間のスナップショットで凍結）, 展開中タップ→収納。
          el.__ccExpanded = !el.__ccExpanded;
          renderHud(true);
        });
        document.body.appendChild(el);
      }
      var vv = window.visualViewport;
      el.style.top = Math.round((vv && vv.offsetTop) || 0) + 'px';
      var kbv = '';
      try { kbv = topWin().__ccStudioKbVer || ''; } catch (_) {}
      // vvH=visual viewport（キーボード分縮む側）/ inH=layout viewport（workbench が
      // 再レイアウトの基準にする側）/ wb=.monaco-workbench の実高さ（workbench が resize に
      // 追随したかの直接証拠）。キーボード表示中に inH だけ縮んで wb が縮まないなら
      // 「イベントは届いたが workbench のレイアウトが動いていない」と確定できる。
      // ヘッダは畳んだ1行表示でも 350ms 毎に生更新される＝HUD をタップ（＝チャットの
      // フォーカスが外れてキーボードが閉じる）せずにスクショだけで読み取れる。
      var wbH = '?';
      try {
        var wbEl = document.querySelector('.monaco-workbench');
        if (wbEl) wbH = Math.round(wbEl.getBoundingClientRect().height);
      } catch (_) { /* ignore */ }
      // bd = document.body の実高さ（VS Code がレイアウト計算の基準に測る値）。
      //   in が縮むのに bd が古いままなら Chromium のルートレイアウトが固着＝renderer 側。
      //   bd も縮むのに wb が古いままなら VS Code のレイアウト処理が止まっている＝workbench 側。
      // rsz = resize イベント発火カウンタ（w=window / v=visualViewport）。キーボード開閉で
      //   増えなければ「イベント自体が飛んでいない」と確定できる。
      // raf = 最後に requestAnimationFrame が動いてからの経過ms。正常なら数十ms、
      //   9999 に張り付けば rAF 停止＝rAF 駆動の workbench レイアウトが動かない説の証拠。
      // ※1行（≒55桁）に収めるため KB:/vis: 表示は一時撤去（vis は v+F 固着なしを確認済み）。
      var bdH = '?';
      try { bdH = Math.round(document.body.getBoundingClientRect().height); } catch (_) { /* ignore */ }
      var rsz = window.__ccHudRszCnt || { w: 0, v: 0 };
      var rafAge = '?';
      try {
        if (window.__ccHudRafLast) rafAge = Math.min(9999, Date.now() - window.__ccHudRafLast);
      } catch (_) { /* ignore */ }
      var head = 'HUD1.6.7 vv:' + (vv ? Math.round(vv.height) : '?') +
        ' in:' + Math.round(window.innerHeight) +
        ' bd:' + bdH +
        ' wb:' + wbH +
        ' rsz:w' + rsz.w + '/v' + rsz.v +
        ' raf:' + rafAge;
      if (!el.__ccExpanded) {
        // 畳んだ状態：1行だけ。画面（左メニュー含む）を塞がない。
        el.style.maxHeight = '1.6em';
        el.style.overflow = 'hidden';
        el.textContent = head;
        return;
      }
      // 展開状態：フレーム木＋KB専用ログ＋共有ログを出す。
      el.style.maxHeight = '46vh';
      el.style.overflow = 'auto';
      var frames = '', log = [], kbown = [];
      try {
        frames = Object.keys(topWin().__ccStudioFocusFrames || {}).join(',');
        log = topWin().__ccStudioFocusLog || [];
        kbown = topWin().__ccStudioKbOwn || []; // keyboard-suppress 専用ログ（他プラグインに埋もれない）
      } catch (_) {}
      var active = '';
      try { active = elemDesc(document.activeElement); } catch (_) {}
      el.textContent = head + '  frames[' + frames + ']  active:' + active +
        '\n-- iframe tree (SO=届く/XO=届かない) --\n' + frameTree() +
        '\n-- KB (keyboard-suppress) --\n' + kbown.join('\n') +
        '\n-- log (shared) --\n' + log.join('\n');
    } catch (_) { /* ignore */ }
  }

  watchAll();
  try {
    document.addEventListener('visibilitychange', watchAll, true);
    window.addEventListener('focus', watchAll, true);
    window.addEventListener('pageshow', watchAll, true);
  } catch (_) { /* ignore */ }

  // 監視の取りこぼし防止＋表示更新。表示インターバルは TOP フレームに1本だけ。
  try {
    var w = topWin();
    if (!w.__ccStudioFocusTimer) {
      w.__ccStudioFocusTimer = setInterval(function () { watchAll(); }, 1000);
    }
  } catch (_) { setInterval(watchAll, 1000); }
  if (isTop()) {
    // resize 計測: 「viewport は縮んだのに workbench が再レイアウトしない」を直接観測する。
    // RSZ 行 = window resize 発火時点の innerHeight と .monaco-workbench の実高さ。
    // resize 発火で wb が inH に追随しない＝workbench のレイアウト処理が動いていない証拠になる。
    try {
      if (!window.__ccStudioHudRszHook) {
        window.__ccStudioHudRszHook = true;
        window.__ccHudRszCnt = { w: 0, v: 0 };
        var logRsz = function (src) {
          try {
            var wb = document.querySelector('.monaco-workbench');
            logEvt('top RSZ(' + src + ') in:' + Math.round(window.innerHeight) +
              ' wb:' + (wb ? Math.round(wb.getBoundingClientRect().height) : '?'));
          } catch (_) { /* ignore */ }
        };
        window.addEventListener('resize', function () {
          window.__ccHudRszCnt.w++; logRsz('win');
        }, true);
        if (window.visualViewport) {
          window.visualViewport.addEventListener('resize', function () {
            window.__ccHudRszCnt.v++; logRsz('vv');
          });
        }
        // rAF 生存監視: 常時 rAF ループで最終 tick 時刻を記録し、ヘッダで経過msを出す。
        window.__ccHudRafLast = Date.now();
        var rafTick = function () {
          window.__ccHudRafLast = Date.now();
          try { requestAnimationFrame(rafTick); } catch (_) { /* ignore */ }
        };
        try { requestAnimationFrame(rafTick); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
    try {
      if (!window.__ccStudioHudSettingHook) {
        window.__ccStudioHudSettingHook = true;
        window.addEventListener('ccstudio:setting', function (e) {
          try {
            var d = e && e.detail;
            if (d && d.plugin === 'focus-hud' && d.key === 'visible') {
              topWin().__ccStudioHudVisible = d.value !== false;
              renderHud(true); // 凍結を無視して即反映
            }
          } catch (_) { /* ignore */ }
        }, false);
      }
    } catch (_) { /* ignore */ }
    try {
      if (!window.__ccStudioFocusHudTimer) {
        window.__ccStudioFocusHudTimer = setInterval(function () { renderHud(false); }, 350);
      }
    } catch (_) { setInterval(function () { renderHud(false); }, 350); }
    renderHud(false);
  }
})();
