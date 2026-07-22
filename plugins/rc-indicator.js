// ==CCStudioPlugin==
// @name        rc-indicator
// @version     0.11.0
// @description Hide the persistent "Remote Control is active" banner (RC stays on), and show a compact "R" pill above the ⋮ button instead; long-press the pill (fill gauge completes) to toggle RC manually.
// @description:ja 常時表示の「Remote Control is active」バナーを非表示にし（RC は維持）、代わりに ⋮ ボタン直上の「R」ピルで状態表示。ピルの長押し（ゲージが満ちたら発火）で手動オン/オフ。
// @run-at      document-start
// @all-frames  true
// @setting     hideBanner boolean true RCバナーを隠す
// @setting:ja  hideBanner RCバナーを隠す（RC接続は維持）
// @setting     indicator boolean true 「R」ピルでRC状態を表示
// @setting:ja  indicator 「R」ピルでRC状態を表示
// @setting     holdToggle boolean true ピルの長押しでRCを手動オン/オフ
// @setting:ja  holdToggle ピルの長押しでRCを手動オン/オフ
// @setting     diag boolean false 診断ログを focus-hud に出す
// @setting:ja  diag 診断ログを focus-hud に出す
// ==/CCStudioPlugin==
// rc-indicator.js — RC バナーを CSS で非表示（DOM は残る＝RC 接続に無影響）にし、
// 「バナーが DOM に存在するか」を RC 状態の検知器として流用して ⋮ ボタン直上の「R」ピルに表示する。
// ピルの長押し（600ms・フィルが満ちたら発火、途中で離すとキャンセル）で /remote-control を送信し
// 手動トグル。× ボタンには一切触れない（クリック＝RC 切断）。
//
// v0.10 通信構成: フレーム間のやり取りは上下とも **汎用プラグイン・メッセージバス**
// （CCStudio.pluginPublish / pluginSubscribe）に統一。
//   上り: chat フレームが topic "rc-indicator/state"（状態）/"rc-indicator/deny"（拒否）へ発行、
//         top が 700ms ポーリングで購読（バス不在環境のみ postMessage フォールバック）。
//   下り: top のピル操作を topic "rc-indicator/toggle" へ発行、可視 chat フレームが購読して
//         フレーム内完結の実証済みコードで /remote-control を送信。
// 下りに postMessage を使わない理由: この WebView 構成では top→iframe 方向が e.source 直送・
// 深掘り列挙・ホップ中継のいずれでも届かない実測（v0.3〜0.7.2）。全フレームに注入される
// ブリッジ経由の Pull が唯一の確実な経路。旧ホップ中継も無害なので併走させている。
// 設計: docs/specs/2026-07-21-rc-indicator-plugin-design.md
(function () {
  'use strict';
  if (window.__ccRcIndicator) return;   // フレームごとに 1 度だけ武装
  window.__ccRcIndicator = true;

  var NAME = 'rc-indicator';
  var BANNER_TEXT = 'Remote Control is active';
  var CMD = '/remote-control';
  var COMPOSER_SELS = ['[aria-label="Message input"]', '[role="textbox"][aria-multiline="true"]'];
  var SEND_BTN_SEL = 'button[class*="sendButton"]';
  var STOP_ICON_SEL = 'button[class*="sendButton"] [class*="stopIcon"]';   // 在=生成中（state-observer と同一判定）
  var TRANSCRIPT_SEL = '[data-testid*="message"]';   // 会話本文（誤ヒット除外の第一段）
  var MARK = 'data-cc-ri-banner';
  var MSG_STATE = 'cc-ri-state';
  var MSG_TOGGLE = 'cc-ri-toggle';
  var MSG_DENY = 'cc-ri-deny';
  var MSG_HUD = 'cc-ri-hud';
  // 汎用バス（CCStudio.pluginPublish/pluginSubscribe）のトピック。上り（状態・拒否）も下り（トグル）も
  // 同じバスに統一し、フレーム間のプラグイン通信の標準機構とする（postMessage は上りフォールバックのみ）。
  var TOPIC_TOGGLE = 'rc-indicator/toggle';
  var TOPIC_STATE = 'rc-indicator/state';
  var TOPIC_DENY = 'rc-indicator/deny';
  function busPublish(topic, payload) {
    try {
      if (window.CCStudio && window.CCStudio.pluginPublish) { window.CCStudio.pluginPublish(topic, payload); return true; }
    } catch (_) {}
    return false;
  }
  function busSubscribe(topic) {
    try {
      if (window.CCStudio && window.CCStudio.pluginSubscribe) return window.CCStudio.pluginSubscribe(topic) || '';
    } catch (_) {}
    return '';
  }
  var POLL_MS = 400;           // フレーム側 tick（検知・報告・トグル購読）。反映のチラつき抑制で短め
  var TOP_POLL_MS = 250;       // top 側: バス購読＋ピル描画の周期
  var HB_TICKS = 3;            // 状態ハートビートの送信間隔（tick 数 ≒ 1.2s）
  var STALE_MS = 4000;         // top 側: 報告途絶でピルを隠すまで
  var HOLD_MS = 600;           // 長押し発火時間（フィルが満ちるまで）
  var DEBOUNCE_MS = 3000;      // トグル連続送信の抑止
  var SUBMIT_DELAY_MS = 300;   // 文字挿入〜送信までの待ち

  var isTop; try { isTop = (window === window.top); } catch (_) { isTop = false; }

  // ---- 設定 ----
  function setting(key, dflt) {
    try { var s = window.__ccPluginSettings && window.__ccPluginSettings[NAME]; if (s && typeof s[key] === 'boolean') return s[key]; }
    catch (_) {}
    return dflt;
  }
  function hideOn() { return setting('hideBanner', true); }
  function indOn() { return setting('indicator', true); }
  function holdOn() { return setting('holdToggle', true); }
  function diagOn() { return setting('diag', false); }

  // ---- 診断: focus-hud 共有バッファへ 'RI ' プレフィックスで。クロスオリジンは top 中継 ----
  function pushShared(line) {
    try {
      var a = window.__ccStudioFocusLog || (window.__ccStudioFocusLog = []);
      if (a[a.length - 1] === line) return;
      a.push(line); while (a.length > 200) a.shift();
    } catch (_) {}
  }
  var lastLog = '';
  function emitLog(s) {
    if (!diagOn()) return;
    var line = 'RI ' + s;
    if (line === lastLog) return; lastLog = line;
    if (isTop) { pushShared(line); return; }
    try { window.top.postMessage({ k: MSG_HUD, log: line }, '*'); } catch (_) {}
  }

  // ---- chat フレーム判定 ----
  function findComposer() {
    for (var i = 0; i < COMPOSER_SELS.length; i++) {
      try { var el = document.querySelector(COMPOSER_SELS[i]); if (el) return el; } catch (_) {}
    }
    return null;
  }
  function composerText(el) { try { return (el.textContent || el.value || '').trim(); } catch (_) { return ''; } }
  // composer だけでは足りない。フォールバックセレクタ [role="textbox"][aria-multiline="true"] は
  // VS Code エディタ(Monaco)にもマッチするため、webview 固有の送信ボタンの存在も要求する。
  function chatFrame() {
    try { return !!document.querySelector(SEND_BTN_SEL); } catch (_) { return false; }
  }
  // このフレームが画面に見えているか（裏タブ/退避 webview は getClientRects が空になる）
  function frameVisible(composer) {
    try { return composer.getClientRects().length > 0; } catch (_) { return true; }
  }
  function frameTag() {
    try {
      if (isTop) return 'top';
      var p = (location && location.pathname) || '';
      return (decodeURIComponent(p.split('/').filter(Boolean).pop() || (location && location.host) || 'sub')).slice(0, 12);
    } catch (_) { return 'xo'; }
  }
  var TAG = frameTag() + '~' + Math.random().toString(36).slice(2, 6);   // 同一パスのフレーム衝突も避ける

  // ---- バナー検知＝RC 状態検知 ----
  // バナー容器の認定条件（設計 §5）:
  //   - composer を巻き込まない / BANNER_TEXT を含む
  //   - テキスト長 ≤300: 実バナーは 1 行(~80字)。会話履歴に残る RC システム転記（data-testid を
  //     持たず transcript 除外をすり抜ける）を巻き込んだ巨大容器は数千字になるので排除。
  //   - button 内包必須: 実バナーは × ボタンを持つ。転記はリンクだけでボタンが無い。
  function validBanner(cont, composer) {
    try {
      if (!cont || cont.contains(composer)) return false;
      var txt = cont.textContent || '';
      if (txt.indexOf(BANNER_TEXT) < 0) return false;
      if (txt.length > 300) return false;
      if (!cont.querySelector('button')) return false;
      return true;
    } catch (_) { return false; }
  }
  // 認定済み要素は毎回再検証し、外れていたら隠しを解除して認定を剥がす（誤認定の固着防止）。
  function findBanner(composer) {
    var marked = null;
    try { marked = document.querySelector('[' + MARK + ']'); } catch (_) {}
    if (marked && document.contains(marked)) {
      if (validBanner(marked, composer)) return marked;
      try { marked.style.removeProperty('display'); marked.removeAttribute(MARK); emitLog('banner unmark'); } catch (_) {}
    }
    if (!document.body) return null;
    var walker;
    try {
      walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (n.nodeType === 1) {
            try { if (n.matches && n.matches(TRANSCRIPT_SEL)) return NodeFilter.FILTER_REJECT; } catch (_) {}
            return NodeFilter.FILTER_SKIP;
          }
          return (n.nodeValue && n.nodeValue.indexOf(BANNER_TEXT) >= 0) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      });
    } catch (_) { return null; }
    var node;
    while ((node = walker.nextNode())) {
      var el = node.parentElement;
      if (!el) continue;
      var cont = el;
      while (cont.parentElement && cont.parentElement !== document.body && !cont.parentElement.contains(composer)) cont = cont.parentElement;
      if (!validBanner(cont, composer)) continue;
      try { cont.setAttribute(MARK, '1'); } catch (_) {}
      emitLog('banner found');
      return cont;
    }
    return null;
  }

  function applyHide(banner) {
    if (!banner) return;
    try {
      if (hideOn()) {
        if (banner.style.display !== 'none') { banner.style.display = 'none'; emitLog('banner hidden'); }
      } else if (banner.style.display === 'none') {
        banner.style.removeProperty('display'); emitLog('banner restored');
      }
    } catch (_) {}
  }

  // ---- chat フレーム側: RC 状態を top へ報告（変化時 + ハートビート・フレーム ID / 可視フラグつき） ----
  var tickCount = 0, lastActive = null, lastVis = null, frameLogged = false;
  function report(active, vis) {
    // 主経路: 汎用バス（top が 700ms でポーリング購読）。バス不在時のみ postMessage へフォールバック
    var sent = busPublish(TOPIC_STATE, JSON.stringify({ tag: TAG, active: !!active, vis: !!vis }));
    if (!sent) { try { window.top.postMessage({ k: MSG_STATE, tag: TAG, active: !!active, vis: !!vis }, '*'); } catch (_) {} }
  }
  function tick() {
    var composer = findComposer();
    if (!composer || !chatFrame()) return;   // chat 本体フレーム以外は対象外
    var banner = findBanner(composer);
    applyHide(banner);
    var active = !!banner;
    var vis = frameVisible(composer);
    if (!frameLogged) { frameLogged = true; emitLog('frame ' + TAG + ' vis=' + (vis ? 1 : 0)); }
    tickCount++;
    if (active !== lastActive || vis !== lastVis || tickCount % HB_TICKS === 0) {
      lastActive = active; lastVis = vis; report(active, vis);
    }
    // トグル依頼の購読（ポーリング型。可視 chat フレームだけが消費する）
    if (vis && holdOn()) {
      var m = busSubscribe(TOPIC_TOGGLE);
      if (m) { emitLog('toggle sub (bus)'); handleToggle(); }
    }
  }

  // ---- chat フレーム側: トグル実行（フレーム内完結・v0.5 実証済み） ----
  var lastSendAt = 0;
  function deny(reason) {
    emitLog('toggle deny: ' + reason);
    if (!busPublish(TOPIC_DENY, reason)) {
      try { window.top.postMessage({ k: MSG_DENY, reason: reason }, '*'); } catch (_) {}
    }
  }
  function handleToggle() {
    var composer = findComposer();
    if (!composer || !chatFrame()) return;                   // chat 本体フレーム以外は黙って無視
    var vis = frameVisible(composer);
    emitLog('toggle recv ' + TAG + ' vis=' + (vis ? 1 : 0));
    if (!vis) return;                                        // 裏タブのセッションを誤トグルしない
    if (composerText(composer)) { deny('draft'); return; }   // 下書きを壊さない
    var busy = false;
    try { busy = !!document.querySelector(STOP_ICON_SEL); } catch (_) {}
    if (busy) { deny('busy'); return; }                      // 生成中は送信ボタン＝停止ボタン。触らない
    var now = Date.now();
    if (now - lastSendAt < DEBOUNCE_MS) { deny('debounce'); return; }
    lastSendAt = now;
    sendCommand(composer);
  }
  // 送信手順は rc-autoconnect の実測確定手順を踏襲（insertText → 送信ボタンのクリックのみ。
  // ボタンが在るのに Enter も撃つと二重送信になる。未検出時のみ Enter フォールバック）。
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
    emitLog('toggle insert exec=' + (inserted ? 1 : 0));
    setTimeout(function () {
      var btn = null; try { btn = document.querySelector(SEND_BTN_SEL); } catch (_) {}
      if (btn) {
        try { btn.click(); } catch (_) {}
        emitLog('toggle submit btn');
      } else {
        var tgt = composer; try { tgt = document.activeElement || composer; } catch (_) {}
        ['keydown', 'keypress', 'keyup'].forEach(function (type) {
          try { tgt.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); } catch (_) {}
        });
        emitLog('toggle submit enter');
      }
    }, SUBMIT_DELAY_MS);
  }

  // ---- 全フレーム: トグル依頼のホップ・バイ・ホップ中継（設定ランタイムと同方式・実機実績あり）。
  //   直上の親からの依頼だけを受け、直下の子 window.frames[i]（同一コンテキスト参照）へ再伝搬する。
  //   クロスオリジン WindowProxy の深掘り列挙（v0.2〜0.4）は実機で届かなかったため使わない。 ----
  function relayToChildren(msg) {
    try {
      for (var i = 0; i < window.frames.length; i++) {
        try { window.frames[i].postMessage(msg, '*'); } catch (_) {}
      }
    } catch (_) {}
  }
  try {
    window.addEventListener('message', function (ev) {
      var m = ev && ev.data;
      if (!m || m.k !== MSG_TOGGLE) return;
      var fromParent = false;
      try { fromParent = (ev.source === window.parent && ev.source !== window); } catch (_) {}
      if (!fromParent) return;
      relayToChildren(m);
      handleToggle();
    }, false);
  } catch (_) {}

  // ---- top フレーム側: 「R」ピル（⋮ ボタン #ccstudio-menu-btn の直上・同じ列） ----
  var pill = null, fill = null;
  var reg = {};   // フレーム別の状態レジストリ: tag → { active, vis, t }
  var reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) {}

  function ensureStyles() {
    if (document.getElementById('cc-ri-style')) return;
    var st = document.createElement('style'); st.id = 'cc-ri-style';
    st.textContent =
      '@keyframes ccRiDeny{0%,100%{opacity:1}50%{opacity:.25}}' +
      '#cc-ri-pill{position:fixed;left:0;bottom:calc(22% + 92px);width:30px;height:68px;border:0;padding:0;' +
      'border-radius:0 10px 10px 0;z-index:2147483647;color:#9aa3b2;background:#3a4150;' +
      'display:none;align-items:center;justify-content:center;overflow:hidden;' +
      'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;cursor:pointer;}' +
      '#cc-ri-pill *{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;}' +
      '#cc-ri-pill.cc-ri-on{color:#fff;background:linear-gradient(180deg,#34C77B,#1e9a58);box-shadow:2px 0 10px rgba(52,199,123,.45);}' +
      '#cc-ri-pill.cc-ri-deny{animation:ccRiDeny .18s 3;}' +
      '#cc-ri-fill{position:absolute;left:0;bottom:0;width:100%;height:0;background:rgba(255,255,255,.28);pointer-events:none;}' +
      '#cc-ri-glyph{position:relative;width:15px;height:22px;pointer-events:none;}';
    try { (document.head || document.documentElement).appendChild(st); } catch (_) {}
  }
  function ensurePill() {
    if (pill && document.contains(pill)) return pill;
    if (!document.body) return null;
    ensureStyles();
    pill = document.createElement('button');
    pill.id = 'cc-ri-pill';
    pill.type = 'button';
    fill = document.createElement('div'); fill.id = 'cc-ri-fill';
    // 「R」はテキストノードにすると Android の長押しで文字選択が発動するため SVG ストロークで描く
    var SVGNS = 'http://www.w3.org/2000/svg';
    var glyph = document.createElementNS(SVGNS, 'svg');
    glyph.setAttribute('id', 'cc-ri-glyph');
    glyph.setAttribute('viewBox', '5 4 14 20');
    glyph.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', 'M8 22 V6 H13 a4 4 0 0 1 0 8 H8 M13 14 L17 22');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    glyph.appendChild(path);
    pill.appendChild(fill); pill.appendChild(glyph);
    pill.addEventListener('pointerdown', pressStart);
    pill.addEventListener('pointerup', pressEnd);
    pill.addEventListener('pointercancel', pressCancel);
    // pointerleave でのキャンセルはしない: 幅 30px のピルでは長押し中の指の揺れで接触点が
    // 外に出て leave が発火し、600ms 完走できず hold fire に到達しない（0.7.0 の実害）。
    // pressStart の setPointerCapture で指がずれてもイベントをピルに束縛する。
    // ネイティブの長押しジェスチャ（選択・コンテキストメニュー・スクロール）を根元から抑止
    pill.addEventListener('touchstart', function (ev) { try { ev.preventDefault(); } catch (_) {} }, { passive: false });
    pill.addEventListener('selectstart', function (ev) { try { ev.preventDefault(); } catch (_) {} });
    pill.addEventListener('contextmenu', function (ev) { try { ev.preventDefault(); } catch (_) {} });
    pill.addEventListener('click', function (ev) { try { ev.preventDefault(); } catch (_) {} });   // 単タップは無反応
    try { document.body.appendChild(pill); } catch (_) { pill = null; }
    return pill;
  }
  function renderPill() {
    if (!isTop) return;
    var p = ensurePill();
    if (!p) return;
    // フレーム別レジストリを集約。可視フレームの報告を優先し、いま画面に出ているセッションの
    // RC 状態を表示する（可視の報告が無いときだけ全報告にフォールバック）。
    var now = Date.now(), any = false, active = false, anyVis = false, visActive = false;
    for (var k in reg) {
      var r = reg[k];
      if (now - r.t >= STALE_MS) { delete reg[k]; continue; }
      any = true; if (r.active) active = true;
      if (r.vis) { anyVis = true; if (r.active) visActive = true; }
    }
    if (!indOn() || !any) { p.style.display = 'none'; return; }   // 非チャット画面・報告途絶は非表示
    p.style.display = 'flex';
    var on = anyVis ? visActive : active;
    if (on) p.classList.add('cc-ri-on'); else p.classList.remove('cc-ri-on');
  }
  function denyBlink() {
    if (!pill) return;
    try { pill.classList.remove('cc-ri-deny'); void pill.offsetWidth; pill.classList.add('cc-ri-deny'); } catch (_) {}
  }

  // ---- top: 長押し判定（押下中フィルが HOLD_MS かけて満ちる＝離せばキャンセル/満ちれば発火）。
  //   タップ配達は v0.10 で実証済み。誤爆防止のポインターキャプチャは維持し、
  //   pointerleave ではキャンセルしない（幅 30px では指の揺れで leave が出る＝0.7.0 の実害）。 ----
  var holdTimer = null, pressAt = 0;
  function resetFill() { if (fill) { try { fill.style.transition = 'none'; fill.style.height = '0'; } catch (_) {} } }
  function pressStart(e) {
    try { e.preventDefault(); } catch (_) {}
    if (!holdOn() || holdTimer) return;
    // 指の揺れで接触点がピル外へ出ても pointerup までイベントをピルに束縛する（誤キャンセル防止）
    try { if (pill && e.pointerId !== undefined) pill.setPointerCapture(e.pointerId); } catch (_) {}
    pressAt = Date.now();
    emitLog('press down');
    if (!reduced && fill) { try { fill.style.transition = 'height ' + HOLD_MS + 'ms linear'; fill.style.height = '100%'; } catch (_) {} }
    holdTimer = setTimeout(function () {
      holdTimer = null; resetFill();
      emitLog('hold fire');
      // 主経路: 汎用バスへ発行（可視 chat フレームがポーリング購読で ≤400ms 以内に受け取る）
      var bridged = busPublish(TOPIC_TOGGLE, '1');
      emitLog('fire bus=' + (bridged ? 1 : 0));
      relayToChildren({ k: MSG_TOGGLE });   // 旧ホップ中継も併走（届く環境ではデバウンスが二重実行を潰す）
    }, HOLD_MS);
  }
  function pressEnd(e) {
    try { e.preventDefault(); } catch (_) {}
    pressCancel('up');
  }
  function pressCancel(why) {
    var w = (why && why.type) ? why.type : (typeof why === 'string' ? why : 'cancel');
    if (holdTimer) {
      clearTimeout(holdTimer); holdTimer = null;
      emitLog('press cancel ' + w + ' dt=' + (Date.now() - pressAt));
    }
    resetFill();
  }

  // ---- top: 状態・拒否のバス購読（700ms ポーリングで空になるまでドレイン） ----
  function pollBus() {
    var i, m;
    for (i = 0; i < 16; i++) {   // 1 回のポーリングで最大 16 件（暴走時の保険）
      m = busSubscribe(TOPIC_STATE);
      if (!m) break;
      try {
        var s = JSON.parse(m);
        reg[typeof s.tag === 'string' ? s.tag : 'f'] = { active: !!s.active, vis: !!s.vis, t: Date.now() };
      } catch (_) {}
    }
    for (i = 0; i < 16; i++) {
      m = busSubscribe(TOPIC_DENY);
      if (!m) break;
      denyBlink(); emitLog('deny ' + m);
    }
    renderPill();
  }

  // ---- top: postMessage フォールバックの受信（バス不在環境用）と HUD ログ中継 ----
  if (isTop) {
    try {
      window.addEventListener('message', function (e) {
        var m = e && e.data;
        if (!m) return;
        if (m.k === MSG_STATE) { reg[typeof m.tag === 'string' ? m.tag : 'f'] = { active: !!m.active, vis: !!m.vis, t: Date.now() }; renderPill(); }
        else if (m.k === MSG_DENY) { denyBlink(); emitLog('deny ' + (m.reason || '')); }
        else if (m.k === MSG_HUD && typeof m.log === 'string') pushShared(m.log);
      }, false);
    } catch (_) {}
  }

  // ---- 設定のライブ反映 ----
  try {
    window.addEventListener('ccstudio:setting', function (e) {
      var d = e && e.detail;
      if (!d || d.plugin !== NAME) return;
      if (d.key === 'hideBanner') { var c = findComposer(); if (c && chatFrame()) applyHide(findBanner(c)); }
      if (isTop && d.key === 'indicator') renderPill();
    });
  } catch (_) {}

  // ---- 起動 ----
  var pending = false;
  function scheduleTick() {
    if (pending) return; pending = true;
    setTimeout(function () { pending = false; tick(); }, 150);   // 変異の嵐を 150ms に集約
  }
  var started = false;
  function start() {
    if (started) return; started = true;
    try { new MutationObserver(scheduleTick).observe(document.documentElement || document.body, { subtree: true, childList: true }); } catch (_) {}
    setInterval(tick, POLL_MS);
    if (isTop) setInterval(pollBus, TOP_POLL_MS);   // 状態/拒否の購読＋報告途絶→非表示の劣化を同じ周期で
    tick();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    try { if (document.documentElement) start(); } catch (_) {}
  } else {
    start();
  }
})();
