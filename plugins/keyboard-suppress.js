// ==CCStudioPlugin==
// @name        keyboard-suppress
// @version     1.2.12
// @description ソフトキーボードの自動表示を抑制する。入力欄やターミナルへ自動フォーカスが移っても、ソフトキーボードを勝手に開かせない。全フレームに document-start で常駐する。
// ==/CCStudioPlugin==
// keyboard-suppress.js — CC Studio 組込み機能（assets同梱）
// claude-code チャットの入力欄が「自動フォーカス（ページ読込/送信後/遷移/タブ切替）」された
// ときに毎回せり上がるソフトキーボードを抑制する。ユーザーが入力欄を直接タップしたフォーカスは通す。
// （入力欄のせり上がり=lift は WebView 側で解決済みのため、本スクリプトは抑制のみを担当する。）
//
// 注入経路は2系統（MainActivity / ExtensionRuntime 参照）:
//   (A) addDocumentStartJavaScript で全フレーム×document-start に登録 … 主経路。
//       各フレームが自分の document に対して即リスナを張る（installAll の最初の一手）。
//       ページ自身のスクリプトより先に走るので、自動フォーカスより確実に前にリスナが入る。
//   (B) 非対応端末では onPageFinished で evaluateJavascript（メインフレームのみ）… フォールバック。
//       この場合だけ iframe 降下 / MutationObserver / ポーリングが効いて子フレームを拾う。
// (A) では降下/observer/poll は冪等な保険として残るだけ（無害）。多重注入されても冪等。
(function () {
  'use strict';

  var TAP_WINDOW_MS = 700; // タップ→自動フォーカスとみなす猶予（移植元 cc-web-helper と同値）
  var MAX_DEPTH = 6; // iframe 降下の最大深さ（フォールバック経路用）
  var RESCAN_MS = 250; // 再設置の定期スキャン間隔。短いほど document.write 後の「リスナ空白」が縮む
                       // ＝自動フォーカスの取りこぼし(たまにキーボードが出る)が減る。installAll は冪等で軽量。
  // VS Code の webview ホストはパネル復帰時に contentWindow.focus() で composer フォーカスを
  // 復元するが、これは composer 要素の focusin を発火させない（要素指定でなく window フォーカス）。
  // よって focusin 依存では取りこぼす。window focus イベント＋遷移ポーリングで拾う。
  // 誤爆防止: 「直近のユーザー操作（composer へのタップ／入力）」があれば絶対に blur しない。
  var ACTIVITY_WINDOW_MS = 1500; // この時間内に composer 操作があれば「操作中」とみなし blur しない
  var FOCUS_POLL_MS = 250; // composer が active になった“遷移”を拾う間隔（VS Code 自身も 250ms ポーリング）

  // 入力欄(composer): claude-code の prompt box は role=textbox / aria-multiline=true。
  // VS Code(monaco) のエディタ/検索も同じ role を持つため .monaco-editor 配下は除外する。
  var COMPOSER_SEL = '[role="textbox"][aria-multiline="true"]';
  var MONACO_SEL = '.monaco-editor';

  // 純粋述語: 直近タップが composer 上で、かつ窓内なら true（＝ユーザー操作由来）。
  function tapAllows(tapTime, tapWasComposer, now, windowMs) {
    if (!tapWasComposer) return false;
    if (typeof tapTime !== 'number') return false;
    return now - tapTime < (windowMs || TAP_WINDOW_MS);
  }

  // ---- 診断: focus-hud 共有ログ(window.top.__ccStudioFocusLog)へ「KB …」行を出す ----
  // focus-hud が無くても害は無い（配列に積むだけ）。原因切り分けが済んだら DIAG=false に。
  var KB_VER = '1.2.12';
  var DIAG = true;
  function kbTopWin() { try { return window.top || window; } catch (_) { return window; } }
  function kbFrame() {
    try {
      if (window === kbTopWin()) return 'top';
      var p = (location && location.pathname) || '';
      return (p.split('/').filter(Boolean).pop() || (location && location.host) || 'sub').slice(0, 14);
    } catch (_) { return 'xo'; }
  }
  function kbLog(s) {
    if (!DIAG) return;
    try {
      var t = kbTopWin();
      var a = t.__ccStudioFocusLog || (t.__ccStudioFocusLog = []);
      var line = 'KB ' + s;
      if (a[a.length - 1] === line) return;
      a.push(line);
      while (a.length > 16) a.shift();
    } catch (_) { /* ignore */ }
  }

  // el が composer か（monaco 配下は composer 扱いしない）。
  function isComposer(el) {
    try {
      if (!el || !el.closest) return false;
      if (el.closest(MONACO_SEL)) return false;
      return !!el.closest(COMPOSER_SEL);
    } catch (_) {
      return false;
    }
  }

  // 直近タップが「その composer の枠内」だったか（時間窓内）。
  // 「フレーム内のどこかでタップ」では緩すぎる（新セッションの「+」ボタンのタップが composer と
  // 同フレームで起き、直後の自動フォーカスを誤許可してキーボードが出ていた）。座標で枠内判定する。
  var TAP_PAD_PX = 40; // 枠の外側この幅まではタップ許可（コンテナ/プレースホルダの余白を吸収）
  function tapOnComposer(doc, el) {
    var t = doc.__ccStudioLastTapTime;
    if (typeof t !== 'number' || Date.now() - t >= ACTIVITY_WINDOW_MS) return false;
    var x = doc.__ccStudioLastTapX, y = doc.__ccStudioLastTapY;
    if (typeof x !== 'number' || !el) return false;
    try {
      var r = el.getBoundingClientRect();
      return x >= r.left - TAP_PAD_PX && x <= r.right + TAP_PAD_PX &&
        y >= r.top - TAP_PAD_PX && y <= r.bottom + TAP_PAD_PX;
    } catch (_) {
      return false;
    }
  }
  // 1つの document に capture リスナを設置（設置済みなら何もしない＝冪等）。
  // 方式は focusin のみ（#1 タップ入力＋#2 自動フォーカス抑制を両立する想定）。
  // 【重要】VS Code webview は fake.html を作った後 document.open()/write() で中身を流し込み、
  //   その際 document-start で張ったリスナを全消去する。設置済みフラグを「document」でなく
  //   **documentElement** に付けることで、write で作り直されたら再スキャンが張り直す。
  function ensureSuppressor(doc) {
    if (!doc) return;
    var root = doc.documentElement;
    if (!root || root.__ccStudioKbSup) return;
    root.__ccStudioKbSup = true;
    kbLog('install ' + kbFrame()); // 設置/再設置を可視化（write 後に再設置されれば再度出る）

    // タップの「時刻」と「座標」を記録（pointerdown/touchstart 両対応）。座標で composer 枠内判定する。
    var mark = function (e) {
      try {
        var x, y;
        if (e && e.touches && e.touches[0]) { x = e.touches[0].clientX; y = e.touches[0].clientY; }
        else if (e && e.changedTouches && e.changedTouches[0]) { x = e.changedTouches[0].clientX; y = e.changedTouches[0].clientY; }
        else if (e) { x = e.clientX; y = e.clientY; }
        doc.__ccStudioLastTapTime = Date.now();
        if (typeof x === 'number') { doc.__ccStudioLastTapX = x; doc.__ccStudioLastTapY = y; }
      } catch (_) { /* ignore */ }
    };
    doc.addEventListener('pointerdown', mark, true);
    doc.addEventListener('touchstart', mark, true);

    // composer の focusin。タップが「その composer の枠内」だったら通す（ユーザー起点）。
    // 枠外タップ（新セッションの「+」等）や、タップ無し（自動フォーカス）→ blur。
    doc.addEventListener(
      'focusin',
      function (e) {
        var t = e.target;
        if (!isComposer(t)) return; // composer 以外は一切触らない
        if (!tapOnComposer(doc, t)) {
          kbLog('blur1 ' + kbFrame());
          try { t.blur(); } catch (_) { /* ignore */ }
        } else {
          kbLog('allow1 ' + kbFrame());
        }
      },
      true
    );

    // 設置時の一発チェック: 既に composer がフォーカス済み（＝リスナ設置“前”に自動フォーカスされた。
    // 新規セッション作成時など。一度フォーカスされると focusin は再発火しないので focusin では拾えない）
    // かつ「枠内タップ」でなければ blur。設置時の1回だけ＝連続 poll ではないので誤爆/争奪は起こさない。
    try {
      var a = doc.activeElement;
      if (a && isComposer(a) && !tapOnComposer(doc, a)) {
        kbLog('blur0 install-active ' + kbFrame());
        a.blur();
      }
    } catch (_) { /* ignore */ }
  }

  // ---- 以下はフォールバック経路(B)用。document-start 全フレーム注入(A)では各フレームが
  //      自分で ensureSuppressor(document) するため、これらは冪等な保険として働くだけ。 ----

  // document に MutationObserver を設置（冪等）。サブツリーに iframe 等が追加されたら即再設置。
  function ensureObserver(doc) {
    if (!doc || doc.__ccStudioKbObs) return;
    var root = doc.documentElement || doc.body;
    if (!root || typeof MutationObserver === 'undefined') return;
    doc.__ccStudioKbObs = true;
    try {
      var obs = new MutationObserver(scheduleInstall);
      obs.observe(root, { childList: true, subtree: true });
    } catch (_) {
      doc.__ccStudioKbObs = false;
    }
  }

  // iframe 要素に load リスナを1回だけ付与（contentDocument 差し替え時に再設置）。
  function ensureIframeLoad(frame) {
    if (!frame || frame.__ccStudioKbLoad) return;
    frame.__ccStudioKbLoad = true;
    try {
      frame.addEventListener('load', scheduleInstall, true);
    } catch (_) {
      frame.__ccStudioKbLoad = false;
    }
  }

  // document から到達できる同一オリジン document を再帰処理し、各所に設置する。
  function instrument(doc, depth) {
    ensureSuppressor(doc);
    ensureObserver(doc);
    if (depth <= 0) return;
    var frames;
    try {
      frames = doc.querySelectorAll('iframe');
    } catch (_) {
      return;
    }
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      ensureIframeLoad(f);
      var d = null;
      try {
        d = f.contentDocument;
      } catch (_) {
        d = null; // クロスオリジン等はスキップ（経路Aではそのフレーム自身が自前で設置済み）
      }
      if (d) instrument(d, depth - 1);
    }
  }

  function installAll() {
    instrument(document, MAX_DEPTH);
  }

  // 呼び出しをデバウンスしつつ、document 準備遅れに備えて数回ずらして再実行する。
  var pending = false;
  function scheduleInstall() {
    if (pending) return;
    pending = true;
    var run = function () {
      pending = false;
      installAll();
    };
    try {
      setTimeout(run, 0);
      setTimeout(installAll, 60);
      setTimeout(installAll, 250);
    } catch (_) {
      installAll();
    }
  }

  // 版数を共有グローバルに公開（focus-hud がヘッダに常時表示する。ログと違いクリアで消えない）。
  try { kbTopWin().__ccStudioKbVer = KB_VER; } catch (_) { /* ignore */ }

  // 初回設置（経路Aでは「自分のフレーム」に即設置されるのが要点）。
  installAll();
  kbLog('v' + KB_VER + ' loaded ' + kbFrame()); // 版数確認用（HUD に出る）

  // タブ切替・復帰シグナルでの再設置（フォールバック経路の保険）。
  try {
    document.addEventListener('visibilitychange', scheduleInstall, true);
    window.addEventListener('focus', scheduleInstall, true);
    window.addEventListener('pageshow', scheduleInstall, true);
  } catch (_) {
    /* ignore */
  }

  // フォールバック経路の定期再スキャン。多重注入時に増殖しないようトップ window に1本だけ。
  try {
    var w = window.top || window;
    if (!w.__ccStudioKbSupTimer) {
      w.__ccStudioKbSupTimer = setInterval(installAll, RESCAN_MS);
    }
  } catch (_) {
    setInterval(installAll, RESCAN_MS);
  }
})();
