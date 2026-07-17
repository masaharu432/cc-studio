// ==CCStudioPlugin==
// @name        keyboard-suppress
// @version     1.2.21
// @description Stock code-server pops the soft keyboard every time the chat input auto-focuses. This plugin suppresses that and shows the keyboard only when you tap the input yourself.
// @description:ja 素の code-server ではチャット入力欄への自動フォーカスのたびにソフトキーボードが勝手に開く。このプラグインはそれを抑え、枠をタップした時だけキーボードを出す。
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
  var KB_VER = '1.2.21';
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
      // 専用バッファ（focus-hud や他プラグインの共有ログに埋もれないよう分離）。focus-hud が「-- KB --」で表示。
      var a = t.__ccStudioKbOwn || (t.__ccStudioKbOwn = []);
      if (a[a.length - 1] === s) return;
      a.push(s);
      while (a.length > 24) a.shift();
    } catch (_) { /* ignore */ }
  }

  // el が「自動フォーカスでキーボードが出る編集領域」なら、タップ許可判定に使う“枠”要素を返す（else null）。
  // 対象: (1) Claude チャット composer（role=textbox aria-multiline）… 枠は composer 自身
  //       (2) テキストエディタ monaco の入力 … 枠は .monaco-editor 全体（入力は 1px の textarea のため）
  // 単行 <input>（検索/リネーム等）は role=textbox でも aria-multiline でないので対象外。
  function suppressBox(el) {
    try {
      if (!el || !el.closest) return null;
      var mon = el.closest(MONACO_SEL);
      if (mon) return mon;                 // テキストエディタ: 枠はエディタ全体
      var cmp = el.closest(COMPOSER_SEL);
      if (cmp) return cmp;                 // チャット入力: 枠は composer
      return null;
    } catch (_) {
      return null;
    }
  }

  // 直近タップが「その枠内」だったか（時間窓内）。座標で判定する。
  // 「フレーム内のどこかでタップ」では緩すぎる（新セッションの「+」等のタップが同フレームで起き、
  // 直後の自動フォーカスを誤許可してキーボードが出ていた）。
  var TAP_PAD_PX = 40; // 枠の外側この幅まではタップ許可（コンテナ/プレースホルダの余白を吸収）
  var GESTURE_MOVE_PX = 10; // この距離を超えて指が動いたら「スクロール」＝タップ扱いしない
  // イベントから座標を取り出す（pointer / touch 両対応）。
  function pointOf(e) {
    try {
      if (e && e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e && e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
      if (e && typeof e.clientX === 'number') return { x: e.clientX, y: e.clientY };
    } catch (_) { /* ignore */ }
    return null;
  }
  function inPad(r, x, y) {
    return x >= r.left - TAP_PAD_PX && x <= r.right + TAP_PAD_PX &&
      y >= r.top - TAP_PAD_PX && y <= r.bottom + TAP_PAD_PX;
  }
  // タップが「実際に係わった枠」を返す（else null）。座標だけでは AskUserQuestion の回答カード等の
  // オーバーレイが枠に重なって誤許可されるため、当たった要素の関係で判定する:
  //  (1) タップ先が枠の内側 → その枠
  //  (2) タップ先が枠を“内包する”要素（コンテナ余白タップ）で、座標がその枠内 → その枠
  // 別要素（回答カード等）へのタップは (1)(2) どちらにも該当せず null＝許可しない。
  function tapEngagedBox(target, x, y) {
    try {
      var direct = suppressBox(target);
      if (direct) return direct;
      if (target && target.querySelectorAll) {
        var cand = target.querySelectorAll(COMPOSER_SEL + ', ' + MONACO_SEL);
        for (var i = 0; i < cand.length; i++) {
          if (inPad(cand[i].getBoundingClientRect(), x, y)) return cand[i];
        }
      }
    } catch (_) { /* ignore */ }
    return null;
  }
  // 直近タップが「その枠」に係わったか（時間窓内）。枠は要素同一性で判定（座標だけの誤許可を防ぐ）。
  function tapInBox(doc, box) {
    var t = doc.__ccStudioLastTapTime;
    if (typeof t !== 'number' || Date.now() - t >= ACTIVITY_WINDOW_MS) return false;
    return !!box && doc.__ccStudioTapBoxEl === box;
  }

  function isBoxVisible(box) {
    try { var r = box.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    catch (_) { return false; }
  }
  // ---- キーボードを「出させない」制御。blur で殴る争奪を避け、inputmode=none で抑える ----
  // 未許可フォーカス: inputmode="none" を付与（フォーカスされてもキーボードが出ない）＋一度 blur で今出てるのを閉じる。
  function denyKb(el) {
    try {
      if (!el || !el.setAttribute) return;
      if (el.getAttribute('inputmode') !== 'none') {
        if (typeof el.__ccKbPrevIM === 'undefined') el.__ccKbPrevIM = el.getAttribute('inputmode');
        el.setAttribute('inputmode', 'none');
        el.__ccKbNone = true;
      }
      try { el.blur(); } catch (_) { /* ignore */ }
    } catch (_) { /* ignore */ }
  }
  // 許可: 自分が付けた inputmode="none" を外す。外したら true（＝キーボード再トリガが必要）。
  function allowKb(el) {
    try {
      if (el && el.__ccKbNone) {
        if (el.__ccKbPrevIM) el.setAttribute('inputmode', el.__ccKbPrevIM);
        else el.removeAttribute('inputmode');
        el.__ccKbNone = false;
        el.__ccKbPrevIM = undefined;
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }
  // 枠(box)に対応する「実際の編集要素」。composer は box 自身、monaco は中の textarea。
  function editableIn(box) {
    try {
      if (box.matches && box.matches(COMPOSER_SEL)) return box;
      var ta = box.querySelector && box.querySelector('textarea');
      return ta || box;
    } catch (_) { return box; }
  }

  // 今フォーカスされているのが「枠内タップ由来でない」編集領域なら、キーボードを出させない（denyKb）。
  // engaged（タイピング中）／枠内タップ由来／不可視 は触らない。診断ログ付き（kbLog は連続重複を省く）。
  function blurIfUnauthorized(doc) {
    try {
      var a = doc.activeElement;
      var box = suppressBox(a);
      if (!box) return; // 編集領域にフォーカスしていない＝無関係
      if (!isBoxVisible(box)) { kbLog('skip invisible ' + kbFrame()); return; }
      if (doc.__ccStudioEngaged) { kbLog('skip engaged ' + kbFrame()); return; } // タイピング中は触らない
      if (tapInBox(doc, box)) { kbLog('skip tap ' + kbFrame()); return; }
      kbLog('deny-poll ' + kbFrame());
      denyKb(a);
    } catch (_) { /* ignore */ }
  }
  var POLL_MS = 300; // 継続ポーリング間隔。focusin を伴わない自動フォーカスを拾う（engaged 中は触らない）。
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

    // タップの「時刻」と「座標」を記録。ただし指が動いたら（スクロール）タップ扱いを取り消す。
    var markDown = function (e) {
      try {
        var p = pointOf(e);
        doc.__ccStudioLastTapTime = Date.now();
        if (p) {
          doc.__ccStudioLastTapX = p.x; doc.__ccStudioLastTapY = p.y;
          doc.__ccStudioGX = p.x; doc.__ccStudioGY = p.y; doc.__ccStudioGActive = true;
        }
        // タップが実際に係わった枠（オーバーレイ＝回答カード等は除外）。許可判定に使う。
        var boxD = tapEngagedBox(e.target, p ? p.x : -1, p ? p.y : -1);
        doc.__ccStudioTapBoxEl = boxD;
        // 枠タップなら、フォーカスが入る前にキーボード禁止を解除しておく（タップで普通に出す）。
        if (boxD) allowKb(editableIn(boxD));
      } catch (_) { /* ignore */ }
    };
    var markMove = function (e) {
      try {
        if (!doc.__ccStudioGActive) return;
        var p = pointOf(e);
        if (!p) return;
        var dx = p.x - doc.__ccStudioGX, dy = p.y - doc.__ccStudioGY;
        if (dx * dx + dy * dy > GESTURE_MOVE_PX * GESTURE_MOVE_PX) {
          // スクロール等のドラッグ。ただし操作中（engaged）や「フォーカス中の枠の内側で始まった
          // ドラッグ」（自分の下書きをスクロール等）は不変条件どおり絶対に blur しない。
          doc.__ccStudioGActive = false;
          var a = doc.activeElement;
          var box = suppressBox(a);
          if (doc.__ccStudioEngaged || (box && doc.__ccStudioTapBoxEl === box)) return;
          // 枠外で始まったドラッグ → タップ許可を無効化し、フォーカス済みの編集領域はキーボードを閉じる。
          doc.__ccStudioLastTapTime = 0;
          if (box) {
            kbLog('deny-scroll ' + kbFrame());
            denyKb(a);
          }
        }
      } catch (_) { /* ignore */ }
    };
    var markUp = function () { try { doc.__ccStudioGActive = false; } catch (_) { /* ignore */ } };
    doc.addEventListener('pointerdown', markDown, true);
    doc.addEventListener('touchstart', markDown, true);
    doc.addEventListener('pointermove', markMove, true);
    doc.addEventListener('touchmove', markMove, true);
    doc.addEventListener('pointerup', markUp, true);
    doc.addEventListener('touchend', markUp, true);
    doc.addEventListener('touchcancel', markUp, true);

    // 編集領域(composer / テキストエディタ)の focusin。タップが「その枠内」なら通す（ユーザー起点）。
    // 枠外タップ（新セッションの「+」/ファイルを開く等）や、タップ無し（自動フォーカス）→ blur。
    doc.addEventListener(
      'focusin',
      function (e) {
        var t = e.target;
        var box = suppressBox(t);
        if (!box) return; // 対象外は一切触らない
        if (!tapInBox(doc, box)) {
          kbLog('deny1 ' + kbFrame());
          denyKb(t); // inputmode=none＋blur。再フォーカスされてもキーボードは出ない（争奪回避）。
        } else {
          doc.__ccStudioEngaged = true; // 枠内タップで正規フォーカス＝以後 poll では触らない
          var changed = allowKb(t);
          kbLog('allow1 ' + kbFrame());
          // 直前まで inputmode=none だった場合、フォーカス中に外してもキーボードが出ないことがあるので再トリガ。
          if (changed) { try { t.blur(); t.focus(); } catch (_) { /* ignore */ } }
        }
      },
      true
    );

    // フォーカスが編集領域から外れたら engaged 解除（次の自動フォーカスは再び抑制対象になる）。
    doc.addEventListener(
      'focusout',
      function (e) {
        if (suppressBox(e.target)) doc.__ccStudioEngaged = false;
      },
      true
    );

    // 入力(keydown/beforeinput/input)でも engaged を維持 → 継続ポーリングでタイピングを絶対に壊さない。
    var activity = function (e) {
      try { if (suppressBox(e.target)) doc.__ccStudioEngaged = true; } catch (_) { /* ignore */ }
    };
    doc.addEventListener('keydown', activity, true);
    doc.addEventListener('beforeinput', activity, true);
    doc.addEventListener('input', activity, true);

    // 継続ポーリング（フレームに1本だけ）。focusin を伴わない自動フォーカス（AskUserQuestion 回答後・
    // パネル復帰・遅延など）を拾う。blurIfUnauthorized は engaged 中／枠内タップ由来／不可視なら触らない。
    if (!doc.__ccStudioPollTimer) {
      try {
        var win = doc.defaultView || window;
        doc.__ccStudioPollTimer = win.setInterval(function () { blurIfUnauthorized(doc); }, POLL_MS);
      } catch (_) { /* ignore */ }
    }

    // 設置時の一発チェック: 既に編集領域がフォーカス済み（＝リスナ設置“前”に自動フォーカスされた。
    // 新規セッション作成やファイルを開いた直後など。一度フォーカスされると focusin は再発火しないので
    // focusin では拾えない）かつ「枠内タップ」でなければ blur。設置時1回だけ＝連続 poll ではない。
    try {
      var a = doc.activeElement;
      var box0 = suppressBox(a);
      if (box0 && !tapInBox(doc, box0)) {
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
