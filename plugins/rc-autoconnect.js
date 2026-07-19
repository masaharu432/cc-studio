// ==CCStudioPlugin==
// @name        rc-autoconnect
// @version     0.7.1
// @description Auto-enable Remote Control by sending /remote-control on newly started sessions, and right after a screen reload (a reload drops RC, so it gets re-established).
// @description:ja 新規セッション、およびスクリーンのリロード直後に /remote-control を自動送信して Remote Control を有効化する（リロードは RC を落とすため張り直しになる）。
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
//   「アシスタント応答 0 件」だけで撃つ理由: /remote-control は接続済みで撃つと切断/トグル側になり得るため、
//   会話が動いている既存セッションには触れない。ユーザーが意図的に RC を無効化した状態も尊重できる。
//
//   リロード直後も発火する（実測・許容）: リロード直後は既存セッションでもトランスクリプトが未描画で
//   assistant-message が 0 件のため新規と判定されて撃つ。リロードは RC 接続を落とすので、そこで張り直すのは
//   むしろ意図に沿う（＝この副作用は仕様として受け入れる）。
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
  // 送信ボタン。webview は sendButton_<hash> クラス。state-observer も同セレクタで停止ボタンを見ている。
  var SEND_BTN_SEL = 'button[class*="sendButton"]';
  var HUD_MSG = 'cc-rc-hud';                    // 自前 HUD 中継のメッセージ種別
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

  // ---- 冪等ガード（フレーム内メモリのみ・フレームにつき最大1回） ----
  //   0.5.0 まで sessionStorage を使い、webview オリジンに貼り付いてタブをまたぐため二度と発火しない不具合。
  //   0.6.0 は amsg>0 でリセットしていたが、送信失敗メッセージ等で再発火し RC セッションを乱造する危険が
  //   あった。0.7.0 はリセットを撤去し「1フレーム＝1新規セッション＝最大1回」に固定（新規は新フレームで拾う）。
  var firedThisFrame = false;
  function alreadyFired() { return firedThisFrame; }
  function markFired() { firedThisFrame = true; }

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

  // ---- 診断: composer フレームの状態だけを HUD へ（変化時のみ・非 composer フレームは無視） ----
  var lastDx = '', frameLogged = false;
  function diag() {
    if (!diagOn()) return;
    var c = findComposer();
    if (!c) return;                     // composer 不在フレームは出さない（armed 等のノイズ削減）
    if (!frameLogged) { frameLogged = true; emitLog('cmp-frame ' + TAG + ' via ' + c.sel.slice(0, 14)); }
    var amsg = assistantCount();
    var line = 'dx ' + TAG + ' amsg=' + amsg + ' new=' + (amsg === 0 ? 1 : 0) +
               ' en=' + (enabled() ? 1 : 0) + ' fired=' + (alreadyFired() ? 1 : 0);
    if (line === lastDx) return; lastDx = line;
    emitLog(line);
  }

  // ---- 送信 ----
  function composerText(el) { try { return (el.textContent || el.value || '').trim(); } catch (_) { return ''; } }
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
    emitLog('insert exec=' + (inserted ? 1 : 0) + ' text="' + composerText(composer).slice(0, 20) + '"');
    setTimeout(function () {
      // 送信は「送信ボタンのクリック」のみ。ボタンが在るのに Enter も撃つと二重送信になる（0.6.0 の不具合）。
      // ボタンが見つからない時だけ Enter へフォールバック。
      var btn = null; try { btn = document.querySelector(SEND_BTN_SEL); } catch (_) {}
      var how;
      if (btn) {
        try { btn.click(); } catch (_) {}
        how = 'btn';
      } else {
        var tgt = composer; try { tgt = document.activeElement || composer; } catch (_) {}
        ['keydown', 'keypress', 'keyup'].forEach(function (type) {
          try { tgt.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); } catch (_) {}
        });
        how = 'enter';
      }
      emitLog('submit via ' + how);
      setTimeout(verifyAfterSend, 1500);
    }, SUBMIT_DELAY_MS);
  }
  function verifyAfterSend() {
    var empty = 1, banner = 0;
    try { var c = findComposer(); empty = (c && composerText(c.el)) ? 0 : 1; } catch (_) {}
    // 送信直後は会話が空（新規）なので "Remote Control" 文言＝バナー出現とみなせる（誤ヒット源なし）。
    try { banner = ((document.body && document.body.textContent) || '').indexOf('Remote Control') >= 0 ? 1 : 0; } catch (_) {}
    emitLog('post empty=' + empty + ' banner=' + banner);
  }

  // ---- メインループ ----
  function tick() {
    diag();                                // 毎 tick 状態を診断出力（変化時のみ）
    if (!enabled()) return;
    var c = findComposer();
    if (!c) return;                        // composer 不在フレーム／未ロード → 対象外
    if (assistantCount() !== 0) return;    // アシスタント応答あり＝既存/送信後 → 触らない（リセットしない＝二度撃たない）
    if (alreadyFired()) return;            // このフレームでは送信済み
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
    // armed は出さない（全フレームで出るとノイズ）。composer フレームだけ diag が 'cmp-frame' を1回出す。
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
