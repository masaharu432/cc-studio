// ==CCStudioPlugin==
// @name        rc-autoconnect
// @version     0.4.0
// @description Auto-enable Remote Control on newly started sessions by sending /remote-control (workbench only).
// @description:ja 新規に起動したセッションで /remote-control を自動送信し、リモートコントロールを有効化する（workbench 用）。
// @run-at      document-start
// @all-frames  true
// @setting     enabled boolean true 新規セッションで自動的にリモートコントロールに接続する
// @setting:ja  enabled 新規セッションで自動的にリモートコントロールに接続する
// @setting     diag boolean true 診断ログを focus-hud に出す
// @setting:ja  diag 診断ログを focus-hud に出す
// ==/CCStudioPlugin==
// rc-autoconnect.js — CC Studio プラグイン。
//
//   VS Code / code-server 拡張のセッションは remoteControlAtStartup:true を読むが、起動時オート接続が
//   サーバ実験ゲート ide_rc_auto_enable_gate (statsig tengu_ide_rc_auto_enable, 既定 false) で抑止される。
//   公式のゲート開放を待たず、workbench 経由の「新規セッション」だけで /remote-control を 1 回自動送信して
//   RC を有効化する。extension.js は改変せず、claude-code の webview UI（composer）を操作するだけ。
//
//   新規セッション限定の理由: /remote-control は接続済みで撃つと切断/トグル側になり得る。ユーザーの意図的
//   無効化も尊重したい。よって「アシスタント応答 0 件＝新規」だけで撃つ（リロード後の張り直しはしない）。
//
//   診断(diag): 私（サーバ側）からはブラウザの生 DOM を読めないため、プラグイン自身が「このフレームで何が
//   見えているか」を focus-hud の共有バッファへ出す。クロスオリジン(webview)フレームは window.top へ直接
//   書けないので、自前の top 中継（HUD_MSG）で送る（state-observer 等に依存しない）。'RC ' プレフィックス。
//
//   設計: docs/specs/2026-07-20-rc-autoconnect-plugin-design.md
(function () {
  'use strict';
  if (window.__ccRcAutoconnect) return;   // フレームごとに 1 度だけ武装
  window.__ccRcAutoconnect = true;

  var NAME = 'rc-autoconnect';
  var CMD = '/remote-control';
  // composer セレクタ。webview の安定ラベル aria-label="Message input" を第一候補、role をフォールバック。
  var COMPOSER_SELS = ['[aria-label="Message input"]', '[role="textbox"][aria-multiline="true"]'];
  // 新規判定＝アシスタント応答 0 件。assistant-message は webview の安定 data-testid。
  var ASSISTANT_MSG_SEL = '[data-testid="assistant-message"]';
  var HUD_MSG = 'cc-rc-hud';                    // 自前 HUD 中継のメッセージ種別
  var FIRED_KEY = 'cc-rc-autoconnect-fired';    // 1 セッション 1 回の冪等キー
  var POLL_MS = 700;
  var SETTLE_MS = 700;                          // 新規確定〜送信までの待ち
  var SUBMIT_DELAY_MS = 300;                    // 文字挿入〜Enter までの待ち

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }

  // ---- 設定 ----
  function setting(key, dflt) {
    try { var s = window.__ccPluginSettings && window.__ccPluginSettings[NAME]; if (s && typeof s[key] === 'boolean') return s[key]; }
    catch (_) {}
    return dflt;
  }
  function enabled() { return setting('enabled', true); }
  function diagOn() { return setting('diag', true); }

  // ---- HUD ログ: rc-autoconnect 専用バッファ __ccStudioRcOwn へ（focus-hud が "-- RC --" 区画で表示）。
  //   共有バッファ(__ccStudioFocusLog)は focus/セッション系ログで溢れるため、KB と同様に専用バッファへ分離。
  //   クロスオリジン(webview)フレームは window.top へ直書きできないので、自前 top 中継(HUD_MSG)で送る。
  function pushOwn(line) {
    try {
      var a = window.__ccStudioRcOwn || (window.__ccStudioRcOwn = []);
      if (a[a.length - 1] === line) return;
      a.push(line); while (a.length > 20) a.shift();
    } catch (_) {}
  }
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (m && m.k === HUD_MSG && typeof m.log === 'string') pushOwn(m.log);
      }, false);
    } catch (_) {}
  }
  var lastLog = '';
  function emitLog(s) {
    var line = 'RC ' + s;
    if (line === lastLog) return; lastLog = line;
    if (isTop) { pushOwn(line); return; }
    try { window.top.postMessage({ k: HUD_MSG, log: line }, '*'); }
    catch (_) { try { console.debug('[cc-' + NAME + ']', s); } catch (__) {} }
  }

  function frameTag() {
    try {
      if (isTop) return 'top';
      var p = (location && location.pathname) || '';
      return (decodeURIComponent(p.split('/').filter(Boolean).pop() || (location && location.host) || 'sub')).slice(0, 12);
    } catch (_) { return 'xo'; }
  }
  var TAG = frameTag();

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

  // ---- composer / 新規判定 ----
  function findComposer() {
    for (var i = 0; i < COMPOSER_SELS.length; i++) {
      try { var el = document.querySelector(COMPOSER_SELS[i]); if (el) return { el: el, sel: COMPOSER_SELS[i] }; }
      catch (_) {}
    }
    return null;
  }
  function assistantCount() {
    try { return document.querySelectorAll(ASSISTANT_MSG_SEL).length; }
    catch (_) { return -1; }
  }

  // ---- 診断: このフレームで見えている手掛かりを HUD へ（変化時のみ） ----
  var lastDx = '';
  function elemDesc(el) {
    try {
      var tag = (el.tagName || '?').toLowerCase();
      var role = el.getAttribute('role'); var al = el.getAttribute('aria-label'); var ml = el.getAttribute('aria-multiline');
      return tag + (role ? '[role=' + role + ']' : '') + (al ? '[al=' + al.slice(0, 18) + ']' : '') + (ml ? '[ml=' + ml + ']' : '');
    } catch (_) { return '?'; }
  }
  function diag() {
    if (!diagOn()) return;
    var c = findComposer();
    var line;
    if (c) {
      line = 'dx ' + TAG + ' cmp=1(' + c.sel.slice(0, 14) + ') amsg=' + assistantCount() +
             ' new=' + (assistantCount() === 0 ? 1 : 0) + ' en=' + (enabled() ? 1 : 0) + ' fired=' + (alreadyFired() ? 1 : 0);
    } else {
      // composer 未一致フレーム: input 候補があればセレクタ確定用にダンプ（無ければ何も出さない＝ノイズ抑制）
      var cand = null;
      try { cand = document.querySelector('[role="textbox"],textarea,[contenteditable="true"]'); } catch (_) {}
      if (!cand) return;
      line = 'dx ' + TAG + ' cmp=0 cand=' + elemDesc(cand);
    }
    if (line === lastDx) return; lastDx = line;
    emitLog(line);
  }

  // ---- 送信 ----
  function sendCommand(composer) {
    try { composer.focus(); } catch (_) {}
    var inserted = false;
    try { inserted = document.execCommand('insertText', false, CMD); } catch (_) {}
    if (!inserted) {
      try {
        composer.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: CMD, bubbles: true, cancelable: true }));
        composer.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: CMD, bubbles: true }));
      } catch (_) {}
    }
    emitLog('insert exec=' + (inserted ? 1 : 0) + ' text="' + ((composer.textContent || composer.value || '').slice(0, 20)) + '"');
    setTimeout(function () {
      ['keydown', 'keypress', 'keyup'].forEach(function (type) {
        try {
          composer.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        } catch (_) {}
      });
      emitLog('enter dispatched (verify RC banner)');
    }, SUBMIT_DELAY_MS);
  }

  // ---- メインループ ----
  function tick() {
    diag();                                // 毎 tick 状態を診断出力（変化時のみ）
    if (!enabled()) return;
    if (alreadyFired()) return;
    var c = findComposer();
    if (!c) return;                        // composer 不在フレーム／未ロード → 対象外
    if (assistantCount() !== 0) return;    // アシスタント応答が既にある＝既存/接続済み → 触らない
    markFired();
    emitLog('FIRE new session (0 msgs) via ' + c.sel.slice(0, 14) + ' in ' + SETTLE_MS + 'ms');
    setTimeout(function () {
      try {
        if (!enabled()) { emitLog('aborted: disabled'); return; }
        var c2 = findComposer();
        if (c2) sendCommand(c2.el); else emitLog('aborted: composer gone');
      } catch (e) { emitLog('send error'); }
    }, SETTLE_MS);
  }

  var pollTimer = null;
  function start() {
    emitLog('armed ' + TAG);               // フレーム到達確認（HUD に出れば注入できている）
    try { new MutationObserver(tick).observe(document.documentElement || document.body, { subtree: true, childList: true }); } catch (_) {}
    pollTimer = setInterval(tick, POLL_MS);
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    try { if (document.documentElement) start(); } catch (_) {}
  } else {
    start();
  }
})();
