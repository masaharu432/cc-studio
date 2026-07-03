// ==CCStudioPlugin==
// @name        session-list-readable
// @version     1.1.0
// @description Stock code-server truncates session titles on phone-width screens. This plugin shrinks the font and wraps titles to two lines so they stay readable.
// @description:ja 素の code-server ではセッション一覧のタイトルがスマホ幅で途切れて読めない。このプラグインはフォント縮小と最大 2 行の折返しで読めるようにする。
// @run-at      document-start
// @all-frames  true
// ==/CCStudioPlugin==
// session-list-readable.js — CC Studio プラグイン（focus-hud / keyboard-suppress とは独立）
// 目的: スマホ幅でセッションのタイトルが「チャット入…」のように切れる問題を解消する。
// 方式（詳細は docs/specs/2026-06-28-session-list-readable-design.md）:
//   - 公式拡張の DOM クラスは未知/不安定なので使わない。各セッション行に必ず付く
//     相対時刻テキスト（4m,5h,18h,3d…）を TreeWalker で拾い、そこから行とタイトルを推定する。
//   - 検出要素に自前クラスを付け、注入した <style>(!important) で見た目だけ上書きする。
//   - 同一親に時刻付き行が2つ以上ある時だけ対象化（孤立した "4m" の誤爆を防ぐ）。
//   - document.write/再描画で消えても MutationObserver + 周期ポーリングで再注入する。
// 抑制やクリック挙動には一切触れない（見た目のみ）。多重注入されても冪等。
(function () {
  'use strict';

  // ---- 調整パラメータ（好みで変更可）----
  var TITLE_FONT_PX = 11;   // タイトルのフォントサイズ
  var TITLE_LINES = 2;      // タイトルの最大行数（折返し）
  var TIME_FONT_PX = 10;    // 相対時刻のフォントサイズ
  var ROW_GAP_PX = 5;       // 行の上下パディング（隣の行との間隔）
  var SEP_CSS = '1px solid rgba(255,255,255,.08)'; // 行間の区切り線（暗テーマ向けの薄い線）
  var MAX_CLIMB = 5;        // 時刻ノードから行コンテナを探す最大階層
  var DEBOUNCE_MS = 250;    // DOM 変化のデバウンス
  var POLL_MS = 1000;       // 起動直後の周期再走査
  var POLL_FOR_MS = 15000;  // 周期再走査を続ける時間（以後は observer 任せ）
  var DIAG = true;          // focus-hud 共有ログへ診断を出す

  var STYLE_ID = 'cc-studio-session-list-readable';
  var ROW_CLASS = 'ccst-sess-row';
  var TITLE_CLASS = 'ccst-sess-title';
  var TIME_CLASS = 'ccst-sess-time';
  var VER = '1.1.0';

  // 相対時刻: "4m" "5h" "18h" "3d" "2w" "10mo" "1y" / 日本語 "5分" "3時間" "2日" 等。
  var TIME_RE = /^\s*\d+\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|w|wk|wks|mo|mos|y|yr|yrs|秒|分|時間|時|日|週|ヶ月|月|年)\s*$/i;

  // ---- 診断: focus-hud 共有バッファ(window.top.__ccStudioFocusLog)へ「SLR …」を出す ----
  function topWin() { try { return window.top || window; } catch (_) { return window; } }
  function isTop() { try { return window === topWin(); } catch (_) { return true; } }
  function frameTag() {
    try {
      if (isTop()) return 'top';
      var p = (location && location.pathname) || '';
      return (p.split('/').filter(Boolean).pop() || (location && location.host) || 'sub').slice(0, 14);
    } catch (_) { return 'xo'; }
  }
  function slrLog(s) {
    if (!DIAG) return;
    try {
      var t = topWin();
      var a = t.__ccStudioFocusLog || (t.__ccStudioFocusLog = []);
      var line = 'SLR[' + frameTag() + '] ' + s;
      if (a[a.length - 1] === line) return; // 連続重複は抑制
      a.push(line);
      while (a.length > 16) a.shift();
    } catch (_) { /* クロスオリジン等は握りつぶし */ }
  }

  function isTimeText(s) {
    if (!s) return false;
    var t = s.trim();
    if (t.length === 0 || t.length > 8) return false;
    return TIME_RE.test(t);
  }

  // 注入する <style> を（無ければ）入れる。冪等。document.write で消えても復活させる。
  function ensureStyle() {
    try {
      var doc = document;
      if (doc.getElementById(STYLE_ID)) return;
      var head = doc.head || doc.documentElement;
      if (!head) return;
      var css =
        '.' + ROW_CLASS + '{align-items:flex-start!important;height:auto!important;min-height:0!important;' +
          'padding-top:' + ROW_GAP_PX + 'px!important;padding-bottom:' + ROW_GAP_PX + 'px!important;' +
          'border-bottom:' + SEP_CSS + '!important;box-sizing:border-box!important;}' +
        '.' + TITLE_CLASS + '{' +
          'font-size:' + TITLE_FONT_PX + 'px!important;' +
          'line-height:1.25!important;' +
          'white-space:normal!important;' +
          'overflow:hidden!important;' +
          'text-overflow:ellipsis!important;' +
          'display:-webkit-box!important;' +
          '-webkit-line-clamp:' + TITLE_LINES + '!important;' +
          '-webkit-box-orient:vertical!important;' +
          'word-break:break-word!important;' +
          'max-width:none!important;' +
        '}' +
        '.' + TIME_CLASS + '{font-size:' + TIME_FONT_PX + 'px!important;opacity:.7!important;flex:0 0 auto!important;}';
      var el = doc.createElement('style');
      el.id = STYLE_ID;
      el.textContent = css;
      head.appendChild(el);
    } catch (_) { /* ignore */ }
  }

  // テキストノードのうち相対時刻に一致する末端の親要素を集める（軽量: SHOW_TEXT のみ走査）。
  function collectTimeEls() {
    var out = [];
    try {
      var root = document.body || document.documentElement;
      if (!root) return out;
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = w.nextNode())) {
        var v = n.nodeValue;
        if (!v) continue;
        if (!isTimeText(v)) continue;
        var p = n.parentElement;
        if (p && out.indexOf(p) === -1) out.push(p);
      }
    } catch (_) { /* ignore */ }
    return out;
  }

  // 時刻要素から上方向に行コンテナを探す。
  // 行 = 時刻以外の「十分長い」テキストも内包する最初の祖先。
  function findRow(timeEl) {
    var el = timeEl;
    for (var i = 0; i < MAX_CLIMB && el && el.parentElement; i++) {
      el = el.parentElement;
      var full = (el.textContent || '').trim();
      var t = (timeEl.textContent || '').trim();
      var rest = full.replace(t, '').trim();
      if (rest.length >= 2) return el; // タイトルらしき文字が同居 = 行
    }
    return null;
  }

  // 行内で「時刻以外の最長テキスト」を持つ末端要素＝タイトル要素を返す。
  function findTitleEl(row, timeEl) {
    var best = null, bestLen = 0;
    try {
      var w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = w.nextNode())) {
        var v = (n.nodeValue || '').trim();
        if (!v || isTimeText(v)) continue;
        var p = n.parentElement;
        if (!p || p === timeEl || timeEl.contains(p) || (p.contains && p.contains(timeEl))) continue;
        if (v.length > bestLen) { bestLen = v.length; best = p; }
      }
    } catch (_) { /* ignore */ }
    return best;
  }

  // 一回分の走査＋クラス付与。戻り値 = 今回マッチした行数。
  function scanOnce() {
    var timeEls = collectTimeEls();
    if (timeEls.length === 0) return 0;

    // (timeEl, row) を集め、行の親ごとにグルーピングする。
    var pairs = [];
    for (var i = 0; i < timeEls.length; i++) {
      var row = findRow(timeEls[i]);
      if (row) pairs.push({ time: timeEls[i], row: row });
    }
    if (pairs.length === 0) return 0;

    // 誤爆防止: 同じ親の下に2行以上ある行だけを「リスト」として採用する。
    var byParent = new Map();
    for (var j = 0; j < pairs.length; j++) {
      var par = pairs[j].row.parentElement || pairs[j].row;
      var arr = byParent.get(par);
      if (!arr) { arr = []; byParent.set(par, arr); }
      arr.push(pairs[j]);
    }

    var marked = 0;
    byParent.forEach(function (arr) {
      if (arr.length < 2) return; // 孤立行は無視
      for (var k = 0; k < arr.length; k++) {
        var row = arr[k].row, timeEl = arr[k].time;
        if (!row.classList.contains(ROW_CLASS)) { row.classList.add(ROW_CLASS); }
        if (!timeEl.classList.contains(TIME_CLASS)) { timeEl.classList.add(TIME_CLASS); }
        var titleEl = findTitleEl(row, timeEl);
        if (titleEl && !titleEl.classList.contains(TITLE_CLASS)) {
          titleEl.classList.add(TITLE_CLASS);
        }
        marked++;
      }
    });
    return marked;
  }

  var lastReported = -1;
  function apply() {
    ensureStyle();
    var n = scanOnce();
    if (n !== lastReported) { slrLog('matched ' + n + ' rows'); lastReported = n; }
  }

  // ---- スケジューリング: デバウンス走査 + observer + 起動直後ポーリング ----
  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(function () { pending = false; apply(); }, DEBOUNCE_MS);
  }

  function installObserver() {
    try {
      var root = document.documentElement;
      if (!root) return;
      var mo = new MutationObserver(function () { schedule(); });
      mo.observe(root, { childList: true, subtree: true });
    } catch (_) { /* ignore */ }
  }

  function start() {
    apply();
    installObserver();
    // 起動直後は document.write 等で消える/遅れて出る一覧に備え、しばらく周期再注入する。
    var elapsed = 0;
    var id = setInterval(function () {
      elapsed += POLL_MS;
      apply();
      if (elapsed >= POLL_FOR_MS) clearInterval(id);
    }, POLL_MS);
    slrLog('v' + VER + ' started');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    // body 出現前でも observer/poll を早めに張れるよう保険。
    try { if (document.documentElement) installObserver(); } catch (_) {}
  } else {
    start();
  }
})();
