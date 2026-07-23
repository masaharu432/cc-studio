// workbench-probe 用テンプレ: Claude 公式拡張のチャット webview（葉フレーム）へ到達する。
// 使い方: 「ここで測定」部分を書き換えて `--eval "$(cat claude-view-template.js)"` で渡す。
// 前提: --url に ?folder=<repo> を付けること（フォルダ無しでは拡張が起動しない）。
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // 1) Workspace Trust を付与（probe は毎回素のプロファイル → Restricted Mode で拡張が無効のため）
  var tr = document.querySelector('.statusbar-item a[aria-label*="Restricted"], .statusbar-item a[aria-label*="restricted"]');
  if (tr) {
    tr.click(); await sleep(2000);
    var b = Array.from(document.querySelectorAll('.monaco-button')).find(function (x) { return /^\s*Trust\b/i.test(x.textContent); });
    if (b) { b.click(); await sleep(10000); }          // 拡張ホスト再起動を待つ
  }

  // 2) アクティビティバーの Claude アイコンを待ってクリック。
  //    狭い画面（--mobile 等）ではバー直置きでなく「Additional Views」オーバーフロー内に入る。
  //    monaco のメニュー項目は素の click() では反応しないため実イベント列で押す。
  var realClick = function (el) {
    ['mouseover', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  };
  var icon = null;
  for (var i = 0; i < 20 && !icon; i++) {
    icon = Array.from(document.querySelectorAll('.activitybar .action-label'))
      .find(function (e) { return /claude/i.test(e.getAttribute('aria-label') || ''); });
    if (!icon) {
      var more = Array.from(document.querySelectorAll('.activitybar .action-label'))
        .find(function (e) { return /Additional Views/i.test(e.getAttribute('aria-label') || ''); });
      if (more) {
        more.click(); await sleep(1500);
        icon = Array.from(document.querySelectorAll('.context-view .action-menu-item, .monaco-menu .action-menu-item'))
          .find(function (e) { return /claude/i.test(e.textContent || ''); });
        if (!icon) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      }
    }
    if (!icon) await sleep(2000);
  }
  if (!icon) return { err: 'Claude icon not found (folder 付き URL か・Trust 済みか)' };
  realClick(icon); await sleep(8000);                  // webview 起動を待つ

  // 3) チャット葉フレームを掴む（code-server の webview は同一オリジン。
  //    構造: top → webview ホスト iframe（内側に iframe を 1 個持つ）→ active-frame = Claude UI 本体）
  var leafWin = null;
  Array.from(document.querySelectorAll('iframe')).forEach(function (f) {
    try {
      var inner = f.contentWindow.document.querySelector('iframe');
      if (inner) leafWin = inner.contentWindow;
    } catch (e) {}                                     // クロスオリジン等はスキップ
  });
  if (!leafWin) return { err: 'chat leaf not found' };

  // （必要なら）セッション一覧から特定セッションを開く例:
  //   var row = Array.from(leafWin.document.querySelectorAll('*'))
  //     .find(function (e) { return e.children.length === 0 && /タイトル断片/.test(e.textContent || ''); });
  //   if (row) { row.click(); await sleep(6000); leafWin = /* 再取得 */ leafWin; }

  // 4) ここで測定（例: チャット文書の状態を返す）
  var d = leafWin.document;
  return {
    url: String(leafWin.location.href).slice(0, 100),
    bodyFont: leafWin.getComputedStyle(d.body).fontSize,
    rootZoom: d.documentElement.style.zoom,
    iw: leafWin.innerWidth
  };
})()
