// CC Studio bootstrap — 左端の ︙ ボタンだけを描く。タップで全画面 switcher を開く。
// Control Center パネルは廃止し、管理UIは全画面スクリーン(plugins.html)へ移行した。冪等。
(function () {
  var BTN_ID = 'ccstudio-menu-btn';
  if (document.getElementById(BTN_ID)) return;
  var btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.textContent = '⋮';
  btn.style.cssText =
    'position:fixed;z-index:2147483647;left:0;bottom:22%;width:30px;height:84px;border:0;' +
    'border-radius:0 11px 11px 0;background:linear-gradient(180deg,#2E90E8,#1c6fc0);color:#fff;' +
    'font-size:19px;box-shadow:2px 0 10px rgba(0,0,0,.45);cursor:pointer;';
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    try { window.CCStudio.openSwitcher(); } catch (_) {}
  });
  document.body.appendChild(btn);
})();

// ── createObjectURL フック ──────────────────────────────────────────
// VS Code は厳格な CSP(connect-src に blob: 無し)を持つため、blob: URL を
// fetch/XHR で読み直すと失敗する。そこで URL.createObjectURL を差し替え、
// blob URL が作られた瞬間に Blob 本体を保持しておく。保存時はその Blob を
// FileReader で直接読む(= ネットワーク/CSP を通らない)。即 revoke 対策で削除も遅らせる。
(function () {
  if (window.__ccstudioBlobMap) return;
  var map = new Map();
  window.__ccstudioBlobMap = map;
  var origCreate = URL.createObjectURL.bind(URL);
  var origRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var url = origCreate(obj);
    try { if (obj instanceof Blob) map.set(url, obj); } catch (_) {}
    return url;
  };
  URL.revokeObjectURL = function (url) {
    // ダウンロード保存が読み終わるまで map には残す(本物の revoke はそのまま実行)。
    try { setTimeout(function () { map.delete(url); }, 15000); } catch (_) {}
    return origRevoke(url);
  };
})();

// ── ダウンロードフック ───────────────────────────────────────────────
// VS Code Web(code-server) の「Download」は URL.createObjectURL(blob) の blob: URL を
// <a download> のクリックで落とすが、WebView は blob: を保存できない。
// ここで blob:/data: のダウンロードクリックを横取りし、base64 化してネイティブへ渡す。
(function () {
  if (window.__ccstudioDownloadHook) return;
  window.__ccstudioDownloadHook = true;

  var CHUNK = 512 * 1024; // 生バイトのチャンク幅（base64 で約1.33倍になる）

  // ── 進捗オーバーレイ ──
  function el(id) { return document.getElementById(id); }
  function ensureOverlay() {
    var o = el('ccstudio-dl');
    if (o) return o;
    o = document.createElement('div');
    o.id = 'ccstudio-dl';
    o.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
      'min-width:240px;max-width:90vw;background:#222;color:#fff;padding:10px 14px;' +
      'border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.5);font:13px sans-serif;display:none;';
    // 上段: アプリアイコン + ラベル
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
    var icon = document.createElement('img');
    icon.id = 'ccstudio-dl-icon';
    icon.style.cssText = 'width:22px;height:22px;border-radius:5px;flex:0 0 auto;display:none;';
    try {
      var d = window.CCStudio && window.CCStudio.appIcon && window.CCStudio.appIcon();
      if (d) { icon.src = d; icon.style.display = 'block'; }
    } catch (_) {}
    var label = document.createElement('div');
    label.id = 'ccstudio-dl-label';
    label.style.cssText = 'flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    row.appendChild(icon);
    row.appendChild(label);
    var track = document.createElement('div');
    track.style.cssText = 'height:6px;background:#444;border-radius:3px;overflow:hidden;';
    var bar = document.createElement('div');
    bar.id = 'ccstudio-dl-bar';
    bar.style.cssText = 'height:100%;width:0%;background:#1e88e5;transition:width .12s linear;';
    track.appendChild(bar);
    o.appendChild(row);
    o.appendChild(track);
    document.body.appendChild(o);
    return o;
  }
  function fmt(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function ovShow(name) {
    ensureOverlay().style.display = 'block';
    el('ccstudio-dl-bar').style.background = '#1e88e5';
    el('ccstudio-dl-bar').style.width = '0%';
    el('ccstudio-dl-label').textContent = 'ダウンロード開始: ' + name;
  }
  function ovProgress(done, total) {
    var p = total ? Math.round(done / total * 100) : 0;
    el('ccstudio-dl-bar').style.width = p + '%';
    el('ccstudio-dl-label').textContent =
      'ダウンロード中 ' + p + '%  (' + fmt(done) + ' / ' + fmt(total) + ')';
  }
  function ovDone(name) {
    el('ccstudio-dl-bar').style.width = '100%';
    el('ccstudio-dl-label').textContent = '保存しました: ' + name;
    setTimeout(function () { var o = el('ccstudio-dl'); if (o) o.style.display = 'none'; }, 2500);
  }
  function ovFail() {
    var o = ensureOverlay();
    el('ccstudio-dl-bar').style.background = '#e53935';
    el('ccstudio-dl-label').textContent = 'ダウンロードに失敗しました';
    setTimeout(function () { o.style.display = 'none'; }, 3000);
  }

  // ── Blob をチャンクで読み、ネイティブへストリーム送信 ──
  function streamBlob(blob, name) {
    var size = blob.size || 0;
    var mime = blob.type || 'application/octet-stream';
    var token = '';
    try { token = window.CCStudio.downloadBegin(name, mime); } catch (_) {}
    if (!token) { ovFail(); return; }
    var offset = 0;
    function next() {
      if (offset >= size) {
        try { window.CCStudio.downloadEnd(token); } catch (_) {}
        ovDone(name);
        return;
      }
      var end = Math.min(offset + CHUNK, size);
      var fr = new FileReader();
      fr.onload = function () {
        var res = fr.result;
        var b64 = res.substring(res.indexOf(',') + 1); // チャンク毎に独立した base64
        var ok = false;
        try { ok = window.CCStudio.downloadChunk(token, b64); } catch (_) {}
        if (!ok) { try { window.CCStudio.downloadAbort(token); } catch (_) {} ovFail(); return; }
        offset = end;
        ovProgress(offset, size);
        setTimeout(next, 0); // UI 描画の隙を与える
      };
      fr.onerror = function () { try { window.CCStudio.downloadAbort(token); } catch (_) {} ovFail(); };
      fr.readAsDataURL(blob.slice(offset, end));
    }
    next();
  }

  function deliver(href, name) {
    ovShow(name);
    // まず createObjectURL フックが保持した Blob 本体を使う(CSP を回避)。
    var cached = null;
    try { cached = window.__ccstudioBlobMap && window.__ccstudioBlobMap.get(href); } catch (_) {}
    if (cached) { streamBlob(cached, name); return; }

    // 保持が無い場合のみ XHR で Blob を取り直す(data: や非フック生成の blob: 用)。
    var xhr = new XMLHttpRequest();
    xhr.open('GET', href, true);
    xhr.responseType = 'blob';
    xhr.onerror = function () { ovFail(); try { window.CCStudio.saveFailed('hook:xhr-error'); } catch (_) {} };
    xhr.onload = function () {
      if (xhr.status && xhr.status !== 200) { ovFail(); return; }
      streamBlob(xhr.response, name);
    };
    try { xhr.send(); } catch (e) { ovFail(); try { window.CCStudio.saveFailed('hook:send:' + e); } catch (_) {} }
  }

  // キャプチャ段階で拾う（VS Code は anchor を生成→click→即 remove するため）。
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var isBlob = href.indexOf('blob:') === 0;
    var isData = href.indexOf('data:') === 0;
    if (!isBlob && !isData) return;
    // data: は download 属性つきのみ横取り（画像等の通常クリックを壊さない）。
    if (isData && !a.hasAttribute('download')) return;
    if (typeof window.CCStudio === 'undefined' || !window.CCStudio.downloadBegin) return;
    ev.preventDefault();
    ev.stopPropagation();
    deliver(href, a.getAttribute('download') || 'download');
  }, true);
})();

// ── セッション状態オブザーバ（処理中 / 接続切れ） ───────────────────────
// 各 WEB スクリーンの DOM を監視し、処理中(停止ボタン)と接続切れ(再接続オーバーレイ)を
// 検知して window.CCStudio.setSessionState で報告する。︙ボタンの色変えとログ追記は
// ローカルで完結。セレクタは実機調整前提なので detectBusy/detectDisconnected に集約し、
// 何にマッチしたか(matched)をログへ残す。冪等。
(function () {
  if (window.__ccstudioStateObserver) return;
  window.__ccstudioStateObserver = true;

  var OFF_DEBOUNCE_MS = 800;   // off 方向の遷移はばたつき防止に遅延確定
  var POLL_MS = 1000;          // MutationObserver の取りこぼし対策フォールバック

  function focusLog(entry) {
    try {
      var t = window.top || window;
      var a = t.__ccStudioFocusLog || (t.__ccStudioFocusLog = []);
      a.push(entry);
      if (a.length > 500) a.splice(0, a.length - 500);
    } catch (_) {}
  }

  // ---- 処理中判定: 停止/中断ボタン or 動的ステータス文言 ----
  function detectBusy() {
    // 1) aria-label / title が停止系の可視ボタン
    var sel = 'button[aria-label],button[title],[role="button"][aria-label]';
    var nodes = document.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var lbl = (n.getAttribute('aria-label') || n.getAttribute('title') || '').toLowerCase();
      if (!lbl) continue;
      if (/\b(stop|interrupt|cancel)\b/.test(lbl) || lbl.indexOf('中断') >= 0 || lbl.indexOf('停止') >= 0) {
        if (n.offsetParent !== null) return 'btn:' + lbl.slice(0, 24);
      }
    }
    return null;
  }

  // ---- 接続切れ判定: code-server の接続喪失オーバーレイ ----
  function detectDisconnected() {
    // VS Code/code-server は切断時に文言を含むダイアログ/バナーを出す。
    var texts = ['Disconnected', 'Reconnecting', 'Connection', '接続が切断', '再接続'];
    // 限定領域: ダイアログ/通知系のみ走査して誤検知を抑える
    var scopes = document.querySelectorAll(
      '.monaco-dialog-box, .notifications-toasts, .monaco-workbench .dialog-message, [role="dialog"]'
    );
    for (var i = 0; i < scopes.length; i++) {
      var el = scopes[i];
      if (el.offsetParent === null) continue;
      var tx = (el.textContent || '');
      for (var j = 0; j < texts.length; j++) {
        if (tx.indexOf(texts[j]) >= 0) return 'overlay:' + texts[j];
      }
    }
    return null;
  }

  // ---- ︙ボタンのローカル色変え ----
  function paintButton(busy, disconnected) {
    var btn = document.getElementById('ccstudio-menu-btn');
    if (!btn) return;
    if (disconnected) {
      btn.style.background = 'linear-gradient(180deg,#e53935,#b21f1a)';
      btn.style.animation = 'none';
    } else if (busy) {
      btn.style.background = 'linear-gradient(180deg,#2E90E8,#1c6fc0)';
      btn.style.animation = 'ccstudioBusyPulse 1s ease-in-out infinite';
    } else {
      btn.style.background = 'linear-gradient(180deg,#2E90E8,#1c6fc0)';
      btn.style.animation = 'none';
    }
  }

  // パルス用 keyframes を一度だけ注入
  (function () {
    if (document.getElementById('ccstudio-state-kf')) return;
    var st = document.createElement('style');
    st.id = 'ccstudio-state-kf';
    st.textContent =
      '@keyframes ccstudioBusyPulse{0%,100%{box-shadow:2px 0 10px rgba(46,144,232,.45)}' +
      '50%{box-shadow:2px 0 18px rgba(46,144,232,.95)}}';
    (document.head || document.documentElement).appendChild(st);
  })();

  var lastBusy = false, lastDisc = false;
  var offTimer = null;

  function apply(busy, disconnected, matched) {
    // off 方向（true→false）のみデバウンス。on 方向は即時。
    var goingOff = (lastBusy && !busy) || (lastDisc && !disconnected);
    function commit() {
      if (busy === lastBusy && disconnected === lastDisc) return;
      lastBusy = busy; lastDisc = disconnected;
      paintButton(busy, disconnected);
      focusLog({ t: Date.now(), tag: 'STATE', busy: busy, disconnected: disconnected, matched: matched });
      try { if (window.CCStudio && window.CCStudio.setSessionState) window.CCStudio.setSessionState(busy, disconnected); } catch (_) {}
    }
    if (offTimer) { clearTimeout(offTimer); offTimer = null; }
    if (goingOff) { offTimer = setTimeout(commit, OFF_DEBOUNCE_MS); }
    else { commit(); }
  }

  function scan() {
    var bm = detectBusy();
    var dm = detectDisconnected();
    apply(!!bm, !!dm, bm || dm || '');
  }

  // ---- キャンセル文言の相関ログ（表示はしない） ----
  function watchCancel() {
    try {
      var body = document.body ? (document.body.textContent || '') : '';
      if (body.indexOf("doesn't want to take this action") >= 0) {
        focusLog({ t: Date.now(), tag: 'CANCEL', busy: lastBusy, disconnected: lastDisc, matched: 'stop-signal' });
      }
    } catch (_) {}
  }

  var mo = new MutationObserver(function () { scan(); });
  function start() {
    try { mo.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['aria-label', 'title', 'class', 'style'] }); } catch (_) {}
    setInterval(function () { scan(); watchCancel(); }, POLL_MS);
    scan();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
