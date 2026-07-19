// ==CCStudioPlugin==
// @name        rc-autoconnect
// @version     0.2.0
// @description Auto-enable Remote Control on newly started sessions by sending /remote-control (workbench only).
// @description:ja 新規に起動したセッションで /remote-control を自動送信し、リモートコントロールを有効化する（workbench 用）。
// @run-at      document-start
// @all-frames  true
// @setting     enabled boolean true 新規セッションで自動的にリモートコントロールに接続する
// @setting:ja  enabled 新規セッションで自動的にリモートコントロールに接続する
// ==/CCStudioPlugin==
// rc-autoconnect.js — CC Studio プラグイン。
//
//   VS Code / code-server 拡張のセッションは remoteControlAtStartup:true を読むが、起動時オート接続が
//   サーバ実験ゲート ide_rc_auto_enable_gate (statsig tengu_ide_rc_auto_enable, 既定 false) で抑止される。
//   公式のゲート開放を待たず、workbench 経由の「新規セッション」だけで /remote-control を 1 回自動送信して
//   RC を有効化する。extension.js は改変せず、claude-code の webview UI（composer）を操作するだけ。
//
//   トリガーを新規セッション限定にする理由:
//     - webview の /remote-control は未接続時に確認なしで即有効になるが、接続済みで撃つと切断/トグル側に
//       なり得るため、無検知連打の事故を避ける。
//     - ユーザーが意図的に RC を無効化する運用があるので「RC 表示が無い=張り直す」方式は採らない。新規限定なら
//       既存セッションで無効化した状態を尊重できる（既存=会話が空でない=非該当）。
//     - リロード（実質プラグイン/拡張更新時のみで稀）後の張り直しはしない（非ゴール）。
//
//   設計: docs/specs/2026-07-20-rc-autoconnect-plugin-design.md
//   フレーム作法・DIAG は state-observer.js / chat-link-open.js を踏襲。
//   ★印は実機 DOM で確定する spike ポイント（セレクタ・新規判定・送信手段）。壊れたら DIAG を見て詰める。
(function () {
  'use strict';
  if (window.__ccRcAutoconnect) return;   // フレームごとに 1 度だけ武装
  window.__ccRcAutoconnect = true;

  var NAME = 'rc-autoconnect';
  var CMD = '/remote-control';
  // composer セレクタ。webview の安定ラベル aria-label="Message input" を第一候補、role をフォールバック。
  // これが在るフレーム＝チャット本体フレームだけで作動。
  var COMPOSER_SEL = '[aria-label="Message input"], [role="textbox"][aria-multiline="true"]';
  // 新規セッション判定＝アシスタント応答 0 件。assistant-message は webview の安定 data-testid。
  // ウェルカム文言はランダム（webview は候補配列から毎回抽選）なので使わない。会話本文テキストにも依存しない。
  var ASSISTANT_MSG_SEL = '[data-testid="assistant-message"]';
  var FIRED_KEY = 'cc-rc-autoconnect-fired';   // 1 セッション 1 回の冪等キー（sessionStorage）
  var POLL_MS = 700;                            // composer/新規判定の監視間隔
  var SETTLE_MS = 700;                          // 新規確定〜送信までの待ち（UI 安定待ち）
  var SUBMIT_DELAY_MS = 300;                    // 文字挿入〜Enter までの待ち（補完ポップアップ対策）

  // ---- 設定（enabled=false で無効。⚙ からのライブ変更にも追従） ----
  function enabled() {
    try { var s = window.__ccPluginSettings && window.__ccPluginSettings[NAME]; return !(s && s.enabled === false); }
    catch (_) { return true; }
  }

  // ---- 診断ログ: focus-hud 共有バッファへ 'RC ' プレフィックスで積む（state-observer と同じ配管） ----
  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }
  var lastLog = '';
  function emitLog(s) {
    var line = 'RC ' + s;
    if (line === lastLog) return; lastLog = line;
    try {
      if (isTop) {
        var a = window.__ccStudioFocusLog || (window.__ccStudioFocusLog = []);
        a.push(line); while (a.length > 24) a.shift();
      } else {
        // 非トップ（webview 本体フレーム）は cross-origin で window.top へ直接触れないため postMessage で送る。
        // state-observer のトップ集約が {k:'__cc_session', log} を hud に積む。未導入でも無害。
        window.top.postMessage({ k: '__cc_session', log: line }, '*');
      }
    } catch (_) { try { console.debug('[cc-' + NAME + ']', s); } catch (__) {} }
  }

  // ---- 冪等ガード ----
  var firedThisFrame = false;
  function alreadyFired() {
    if (firedThisFrame) return true;
    try { if (sessionStorage.getItem(FIRED_KEY)) return true; } catch (_) {}
    return false;
  }
  function markFired() {
    firedThisFrame = true;
    try { sessionStorage.setItem(FIRED_KEY, String(Date.now())); } catch (_) {}
  }

  // ---- 新規セッション判定 ----
  //   会話が空（アシスタント応答 0 件）＝新規。assistant-message は webview の安定 data-testid。
  //   既存/再開/接続済みセッションは応答が 1 件以上あるので発火しない（＝接続済みへ撃つトグル誤爆を回避）。
  //   会話本文テキストには一切依存しない（旧 0.1.0 の body 全文スキャン誤ヒットを廃止）。
  function isNewSession() {
    try { return document.querySelectorAll(ASSISTANT_MSG_SEL).length === 0; }
    catch (_) { return false; }
  }

  // ---- 送信（★ spike: React/Lexical composer への挿入＋送信手段を実機で確定） ----
  function sendCommand(composer) {
    try { composer.focus(); } catch (_) {}
    var inserted = false;
    // 1) 標準の insertText（contenteditable で最も素直）
    try { inserted = document.execCommand('insertText', false, CMD); } catch (_) {}
    // 2) フォールバック: beforeinput/InputEvent
    if (!inserted) {
      try {
        composer.dispatchEvent(new InputEvent('beforeinput',
          { inputType: 'insertText', data: CMD, bubbles: true, cancelable: true }));
        composer.dispatchEvent(new InputEvent('input',
          { inputType: 'insertText', data: CMD, bubbles: true }));
      } catch (_) {}
    }
    // 3) Enter で送信。'/' 補完ポップアップが Enter を横取りしても、通常は選択中コマンドを確定＝実行になる。
    //    横取り挙動が違えば DIAG を見て手順を差し替える。
    setTimeout(function () {
      ['keydown', 'keypress', 'keyup'].forEach(function (type) {
        try {
          composer.dispatchEvent(new KeyboardEvent(type,
            { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        } catch (_) {}
      });
      emitLog('sent ' + CMD + ' (verify RC banner)');
    }, SUBMIT_DELAY_MS);
  }

  // ---- メインループ ----
  function tick() {
    if (!enabled()) return;
    if (alreadyFired()) return;
    var composer;
    try { composer = document.querySelector(COMPOSER_SEL); } catch (_) { composer = null; }
    if (!composer) return;                 // composer 不在フレーム／未ロード → 対象外
    if (!isNewSession()) return;           // アシスタント応答が既にある＝既存/接続済み → 触らない
    markFired();
    emitLog('new session (0 msgs) -> ' + CMD + ' in ' + SETTLE_MS + 'ms');
    setTimeout(function () {
      try {
        // 送信直前に enabled を再確認（この間に OFF されたら撃たない）
        if (!enabled()) { emitLog('aborted: disabled'); return; }
        var c = document.querySelector(COMPOSER_SEL);
        if (c) sendCommand(c); else emitLog('aborted: composer gone');
      } catch (e) { emitLog('send error'); }
    }, SETTLE_MS);
  }

  var pollTimer = null;
  function start() {
    emitLog('armed ' + (isTop ? 'top' : 'frame'));   // フレーム到達確認（HUD に出れば注入できている）
    try {
      new MutationObserver(tick).observe(document.documentElement || document.body,
        { subtree: true, childList: true });
    } catch (_) {}
    pollTimer = setInterval(function () {
      if (alreadyFired() && pollTimer) { clearInterval(pollTimer); pollTimer = null; return; }
      tick();
    }, POLL_MS);
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    try { if (document.documentElement) start(); } catch (_) {}
  } else {
    start();
  }
})();
