# セッション状態オブザーバ（処理中 / 接続切れ）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 各 WEB スクリーンの「処理中 / 接続切れ」を DOM から観測し、switcher 行・常駐通知・︙ボタンに可視化しつつ、遷移を `__ccStudioFocusLog` に積んで突発キャンセルの原因切り分けデータを貯める。

**Architecture:** bootstrap.js 内の常時注入 IIFE が `MutationObserver` ＋フォールバックポーリングで `detectBusy()` / `detectDisconnected()` を回し、`window.CCStudio.setSessionState(busy, disconnected)`（screenId 内包）でネイティブへ報告。ネイティブは `Screen` の2フラグを更新し、switcher と常駐通知を貼り直す。︙ボタンの色変えとログ追記は各スクリーンのローカル JS で完結。

**Tech Stack:** Kotlin（Android, JVM 単体テスト= JUnit4 + org.json）、WebView JavaScript（ES5 互換、既存 bootstrap.js / switcher.html 流儀）。

## Global Constraints

- 設計は [docs/specs/2026-06-30-session-state-observer-design.md](2026-06-30-session-state-observer-design.md) に従う。
- `server/code-server` サブモジュールは触らない（外側で実装）。[[dont-edit-code-server-submodule]]
- JS は ES5 互換・冪等（二重注入ガード）。既存 bootstrap.js / switcher.html の書式に合わせる。
- 単体テストコマンド: `./gradlew testDebugUnitTest`（Android JVM 単体テスト）。
- 用語は「スクリーン / プラグイン」。[[cc-studio-terminology]]
- コミットは各タスク末尾。コミットメッセージ末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: 状態モデル（Screen / ScreenRow / ScreensJson / ScreenManager）

**Files:**
- Modify: `app/src/main/java/app/ccstudio/Screen.kt`
- Modify: `app/src/main/java/app/ccstudio/ScreensJson.kt`
- Modify: `app/src/main/java/app/ccstudio/ScreenManager.kt:65-75`
- Test: `app/src/test/java/app/ccstudio/ScreensJsonTest.kt`

**Interfaces:**
- Produces: `Screen.busy: Boolean`（var, default false）, `Screen.disconnected: Boolean`（var, default false）。
- Produces: `ScreenRow(... , busy: Boolean = false, disconnected: Boolean = false)`（末尾2引数, デフォルト付き）。
- Produces: `ScreensJson.build` が各行に `"busy"` / `"disconnected"`（boolean）を出力。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/test/java/app/ccstudio/ScreensJsonTest.kt` を次に置き換える（既存 `buildsArray` の ScreenRow 呼び出しも新シグネチャに合わせる）:

```kotlin
package app.ccstudio

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreensJsonTest {
    @Test fun buildsArray() {
        val json = ScreensJson.build(listOf(
            ScreenRow(1, "Plugins", null, "SYSTEM_PLUGINS", false, false, false),
            ScreenRow(2, "cc-studio", "/mnt/cc-studio", "WEB", true, true, false),
            ScreenRow(3, "old-session", "/mnt/old-session", "WEB", false, true, true),
        ))
        val arr = JSONArray(json)
        assertEquals(3, arr.length())
        val plugins = arr.getJSONObject(0)
        assertEquals("Plugins", plugins.getString("title"))
        assertEquals(false, plugins.getBoolean("closeable"))
        assertEquals("", plugins.getString("path"))
        val web = arr.getJSONObject(2)
        assertEquals("old-session", web.getString("title"))
        assertTrue(web.getBoolean("stale"))
        assertEquals(true, web.getBoolean("closeable"))
    }

    @Test fun serializesBusyAndDisconnected() {
        val json = ScreensJson.build(listOf(
            ScreenRow(2, "a", "/a", "WEB", true, true, false, busy = true, disconnected = false),
            ScreenRow(3, "b", "/b", "WEB", false, true, false, busy = false, disconnected = true),
        ))
        val arr = JSONArray(json)
        assertEquals(true, arr.getJSONObject(0).getBoolean("busy"))
        assertEquals(false, arr.getJSONObject(0).getBoolean("disconnected"))
        assertEquals(false, arr.getJSONObject(1).getBoolean("busy"))
        assertEquals(true, arr.getJSONObject(1).getBoolean("disconnected"))
    }

    @Test fun defaultsAreFalse() {
        val json = ScreensJson.build(listOf(
            ScreenRow(1, "p", null, "SYSTEM_PLUGINS", false, false, false),
        ))
        val o = JSONArray(json).getJSONObject(0)
        assertEquals(false, o.getBoolean("busy"))
        assertEquals(false, o.getBoolean("disconnected"))
    }
}
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `./gradlew testDebugUnitTest --tests app.ccstudio.ScreensJsonTest`
Expected: コンパイルエラー（`ScreenRow` に `busy`/`disconnected` 引数が無い）で FAIL。

- [ ] **Step 3: `Screen.kt` にフラグを追加**

`app/src/main/java/app/ccstudio/Screen.kt` の `var loadedGeneration: Int = 0` の直後に追加:

```kotlin
    var loadedGeneration: Int = 0
    /** Claude Code が処理中（DOM の停止/中断ボタンを検知）。bootstrap.js が報告。 */
    var busy: Boolean = false
    /** code-server セッションが切断/再接続中（DOM の接続喪失オーバーレイを検知）。 */
    var disconnected: Boolean = false
```

- [ ] **Step 4: `ScreensJson.kt` にフィールドを追加**

`app/src/main/java/app/ccstudio/ScreensJson.kt` の `ScreenRow` を次に置き換える:

```kotlin
data class ScreenRow(
    val id: Long,
    val title: String,
    val path: String?,
    val kind: String,        // "WEB" | "SYSTEM_PLUGINS"
    val active: Boolean,
    val closeable: Boolean,
    val stale: Boolean,
    val busy: Boolean = false,
    val disconnected: Boolean = false,
)
```

`build()` の `JSONObject()...put("stale", r.stale)` の行の直後（`.put` チェーン内）に追加:

```kotlin
                    .put("stale", r.stale)
                    .put("busy", r.busy)
                    .put("disconnected", r.disconnected)
```

- [ ] **Step 5: `ScreenManager.rows()` で2フラグを写す**

`app/src/main/java/app/ccstudio/ScreenManager.kt` の `rows()` 内、`stale = ...` の行の直後に追加:

```kotlin
            stale = s.kind == ScreenKind.WEB && s.loadedGeneration < currentGeneration,
            busy = s.kind == ScreenKind.WEB && s.busy,
            disconnected = s.kind == ScreenKind.WEB && s.disconnected,
```

- [ ] **Step 6: テストが通ることを確認**

Run: `./gradlew testDebugUnitTest --tests app.ccstudio.ScreensJsonTest`
Expected: PASS（3 テスト）。

- [ ] **Step 7: コミット**

```bash
git add app/src/main/java/app/ccstudio/Screen.kt \
        app/src/main/java/app/ccstudio/ScreensJson.kt \
        app/src/main/java/app/ccstudio/ScreenManager.kt \
        app/src/test/java/app/ccstudio/ScreensJsonTest.kt
git commit -m "feat(screen): busy/disconnected フラグを Screen と switcher 行データに追加

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 常駐通知の件数表示（KeepAliveText / NotifyState / KeepAliveService）

**Files:**
- Create: `app/src/main/java/app/ccstudio/KeepAliveText.kt`
- Modify: `app/src/main/java/app/ccstudio/NotifyState.kt`
- Modify: `app/src/main/java/app/ccstudio/KeepAliveService.kt:174`
- Test: `app/src/test/java/app/ccstudio/KeepAliveTextTest.kt`

**Interfaces:**
- Produces: `KeepAliveText.statusLine(screens: Int, busy: Int, disconnected: Int): String`。
- Produces: `NotifyState.busyCount: Int`（@Volatile, default 0）, `NotifyState.disconnectedCount: Int`（@Volatile, default 0）。
- Consumes: なし。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/test/java/app/ccstudio/KeepAliveTextTest.kt`:

```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class KeepAliveTextTest {
    @Test fun screensOnly() {
        assertEquals("スクリーン 3 起動中", KeepAliveText.statusLine(3, 0, 0))
    }

    @Test fun withBusy() {
        assertEquals("スクリーン 3 起動中 ・処理中 2", KeepAliveText.statusLine(3, 2, 0))
    }

    @Test fun withDisconnected() {
        assertEquals("スクリーン 3 起動中 ・接続切れ 1", KeepAliveText.statusLine(3, 0, 1))
    }

    @Test fun withBoth() {
        assertEquals("スクリーン 3 起動中 ・処理中 2 ・接続切れ 1", KeepAliveText.statusLine(3, 2, 1))
    }
}
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `./gradlew testDebugUnitTest --tests app.ccstudio.KeepAliveTextTest`
Expected: コンパイルエラー（`KeepAliveText` 未定義）で FAIL。

- [ ] **Step 3: `KeepAliveText.kt` を作成**

```kotlin
package app.ccstudio

/** 常駐通知の本文を組み立てる純関数。KeepAliveService が使う（JVM 単体テスト可能にするため分離）。 */
object KeepAliveText {
    fun statusLine(screens: Int, busy: Int, disconnected: Int): String {
        val sb = StringBuilder("スクリーン $screens 起動中")
        if (busy > 0) sb.append(" ・処理中 $busy")
        if (disconnected > 0) sb.append(" ・接続切れ $disconnected")
        return sb.toString()
    }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `./gradlew testDebugUnitTest --tests app.ccstudio.KeepAliveTextTest`
Expected: PASS（4 テスト）。

- [ ] **Step 5: `NotifyState.kt` に件数を追加**

`screenCount` の直後に追加:

```kotlin
    @Volatile var screenCount: Int = 0
    /** 処理中の Web スクリーン数。常駐通知に表示。 */
    @Volatile var busyCount: Int = 0
    /** 接続切れ/再接続中の Web スクリーン数。常駐通知に表示。 */
    @Volatile var disconnectedCount: Int = 0
```

- [ ] **Step 6: `KeepAliveService` の本文を差し替える**

`app/src/main/java/app/ccstudio/KeepAliveService.kt` の `buildKeepAliveNotification()` 内、
`.setContentText(getString(R.string.keepalive_screen_count, NotifyState.screenCount))` を次に置き換える:

```kotlin
            .setContentText(
                KeepAliveText.statusLine(
                    NotifyState.screenCount, NotifyState.busyCount, NotifyState.disconnectedCount
                )
            )
```

- [ ] **Step 7: 単体テスト全体が通ることを確認**

Run: `./gradlew testDebugUnitTest`
Expected: PASS（既存含め全テスト）。

- [ ] **Step 8: コミット**

```bash
git add app/src/main/java/app/ccstudio/KeepAliveText.kt \
        app/src/main/java/app/ccstudio/NotifyState.kt \
        app/src/main/java/app/ccstudio/KeepAliveService.kt \
        app/src/test/java/app/ccstudio/KeepAliveTextTest.kt
git commit -m "feat(notify): 常駐通知に処理中/接続切れ件数を併記

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: ブリッジのスクリーン識別と `onSessionState` 配線

**Files:**
- Modify: `app/src/main/java/app/ccstudio/CcBridge.kt`
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`（`newConfiguredWebView`, `buildBridge`, `createWebScreen`, `createSystemPluginsScreen`, `refreshKeepAliveScreenCount`, 新規 `onSessionState`）

**Interfaces:**
- Consumes: `Screen.busy`, `Screen.disconnected`, `NotifyState.busyCount`, `NotifyState.disconnectedCount`（Task 1/2）。
- Produces: JS から呼べる `window.CCStudio.setSessionState(busy: boolean, disconnected: boolean)`（Task 5 が呼ぶ）。

このタスクは Android 実機/ビルド依存のため JVM 単体テストではなくビルド通過で検証する。

- [ ] **Step 1: `CcBridge` にラムダとメソッドを追加**

`app/src/main/java/app/ccstudio/CcBridge.kt` のコンストラクタ末尾（`onClosePluginSettings` の後）に引数を追加:

```kotlin
    private val onClosePluginSettings: () -> Unit,
    private val onSessionState: (busy: Boolean, disconnected: Boolean) -> Unit,
) {
```

クラス本体の末尾（最後の `}` の手前）にメソッドを追加:

```kotlin
    // ── セッション状態（処理中/接続切れ） ──
    /** bootstrap.js のオブザーバが、このスクリーンの処理中/接続切れ状態を報告する。 */
    @JavascriptInterface
    fun setSessionState(busy: Boolean, disconnected: Boolean) = onSessionState(busy, disconnected)
```

- [ ] **Step 2: `buildBridge` を screenId 付きにする**

`MainActivity.kt` の `private fun buildBridge(): CcBridge = CcBridge(` を
`private fun buildBridge(screenId: Long): CcBridge = CcBridge(` に変更し、
コンストラクタ末尾の `onClosePluginSettings = { ... },` の直後に追加:

```kotlin
        onClosePluginSettings = { runOnUiThread { closePluginSettings() } },
        onSessionState = { busy, disconnected -> onSessionState(screenId, busy, disconnected) },
    )
```

- [ ] **Step 3: `newConfiguredWebView` に screenId を通す**

`private fun newConfiguredWebView(): WebView = WebView(this).apply {` を
`private fun newConfiguredWebView(screenId: Long = -1L): WebView = WebView(this).apply {` に変更し、
同関数内の `addJavascriptInterface(buildBridge(), "CCStudio")` を
`addJavascriptInterface(buildBridge(screenId), "CCStudio")` に変更する。

（switcher / notify / plugin-settings オーバーレイは引数なし呼び出しのまま screenId=-1。
これらは bootstrap.js 非注入なので `setSessionState` を呼ばない。）

- [ ] **Step 4: スクリーン ID を先に採番して渡す**

`createWebScreen` の冒頭を次に変更:

```kotlin
    private fun createWebScreen(url: String, reloadOnFirstLoad: Boolean = false): Screen {
        val id = screens.nextId()
        val wv = newConfiguredWebView(id)
        val screen = Screen(id, ScreenKind.WEB, wv)
```

`createSystemPluginsScreen` の冒頭を次に変更:

```kotlin
    private fun createSystemPluginsScreen(): Screen {
        val id = screens.nextId()
        val wv = newConfiguredWebView(id)
        val screen = Screen(id, ScreenKind.SYSTEM_PLUGINS, wv)
```

- [ ] **Step 5: `onSessionState` を追加**

`refreshKeepAliveScreenCount()` の直前（`persistScreens()` の後あたり）に追加:

```kotlin
    /** bootstrap.js のオブザーバからの状態報告。値が変わったときだけ反映して UI を貼り直す。 */
    private fun onSessionState(screenId: Long, busy: Boolean, disconnected: Boolean) {
        runOnUiThread {
            val s = screens.byId(screenId) ?: return@runOnUiThread
            if (s.kind != ScreenKind.WEB) return@runOnUiThread
            if (s.busy == busy && s.disconnected == disconnected) return@runOnUiThread
            s.busy = busy
            s.disconnected = disconnected
            refreshSwitcher()
            refreshKeepAliveScreenCount()
        }
    }
```

- [ ] **Step 6: `refreshKeepAliveScreenCount` で件数を集計**

`refreshKeepAliveScreenCount()` 内の `NotifyState.screenCount = screens.webScreens().size` の直後に追加:

```kotlin
        NotifyState.screenCount = screens.webScreens().size
        NotifyState.busyCount = screens.webScreens().count { it.busy }
        NotifyState.disconnectedCount = screens.webScreens().count { it.disconnected }
```

- [ ] **Step 7: ビルドが通ることを確認**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL（コンパイルエラー無し）。

- [ ] **Step 8: コミット**

```bash
git add app/src/main/java/app/ccstudio/CcBridge.kt \
        app/src/main/java/app/ccstudio/MainActivity.kt
git commit -m "feat(bridge): setSessionState を追加しスクリーン単位で状態を受ける

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: switcher 行に処理中スピナー / 接続切れ赤●

**Files:**
- Modify: `app/src/main/assets/switcher.html`

**Interfaces:**
- Consumes: `listScreens()` JSON の各行 `s.busy` / `s.disconnected`（Task 1）。

ビルド不要・JS のみ。実機目視は Task 6。ここは構文の正しさをコミット前に目視確認する。

- [ ] **Step 1: スタイルを追加**

`switcher.html` の `<style>` 内、`.band.active .fdot{...}` の行の直後に追加:

```css
  .band .fdot.busy{background:var(--brand);animation:ccpulse 1s ease-in-out infinite}
  .band .fdot.disc{background:#e53935;box-shadow:0 0 0 3px rgba(229,57,53,.22);animation:none}
  @keyframes ccpulse{0%,100%{box-shadow:0 0 0 0 rgba(46,144,232,.55)}50%{box-shadow:0 0 0 5px rgba(46,144,232,0)}}
  .band-badge{margin-left:8px;font:600 9px/1 var(--mono);letter-spacing:.08em;padding:4px 7px;border-radius:6px;flex:0 0 auto}
  .band-badge.busy{color:#fff;background:var(--brand)}
  .band-badge.disc{color:#fff;background:#c0392b}
  @media (prefers-reduced-motion:reduce){.band .fdot.busy{animation:none}}
```

- [ ] **Step 2: `makeWebBand` で行にバッジを反映**

`makeWebBand` 内、`var dot=el('span','fdot');` を次に置き換える:

```javascript
    var dot=el('span','fdot');
    if(s.disconnected) dot.classList.add('disc');
    else if(s.busy) dot.classList.add('busy');
```

同関数内、`band.appendChild(dot); band.appendChild(main); band.appendChild(rb);` を次に置き換える
（名前の右側に処理中/接続切れバッジを出す）:

```javascript
    band.appendChild(dot); band.appendChild(main);
    if(s.disconnected){ var bd=el('span','band-badge disc'); bd.textContent='接続切れ'; band.appendChild(bd); }
    else if(s.busy){ var bb=el('span','band-badge busy'); bb.textContent='処理中'; band.appendChild(bb); }
    band.appendChild(rb);
```

- [ ] **Step 3: 構文確認（ローカル node で読み込みチェック）**

Run: `node --check <(sed -n '/<script>/,/<\/script>/p' app/src/main/assets/switcher.html | grep -v '</\?script>')`
Expected: 出力なし（構文 OK）。エラーが出たら該当箇所を修正。

- [ ] **Step 4: コミット**

```bash
git add app/src/main/assets/switcher.html
git commit -m "feat(switcher): 各スクリーン行に処理中スピナー/接続切れバッジを表示

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: bootstrap.js の観測オブザーバ

**Files:**
- Modify: `app/src/main/assets/bootstrap.js`（末尾に新 IIFE を追加）

**Interfaces:**
- Consumes: `window.CCStudio.setSessionState(busy, disconnected)`（Task 3）, 既存 `#ccstudio-menu-btn` ボタン（bootstrap.js 先頭の IIFE が生成）。
- Produces: `window.top.__ccStudioFocusLog` への `{t, tag:'STATE'|'CANCEL', busy, disconnected, matched}` 追記（focus-hud と共有）。

JS のみ。セレクタは実機調整前提のため、判定は小関数に集約し matched をログする。

- [ ] **Step 1: オブザーバ IIFE を bootstrap.js の末尾に追加**

`app/src/main/assets/bootstrap.js` の末尾（最後の `})();` の後）に追加:

```javascript
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
```

- [ ] **Step 2: 構文確認**

Run: `node --check app/src/main/assets/bootstrap.js`
Expected: 出力なし（構文 OK）。

- [ ] **Step 3: コミット**

```bash
git add app/src/main/assets/bootstrap.js
git commit -m "feat(observer): bootstrap.js に処理中/接続切れの DOM オブザーバを追加

MutationObserver+ポーリングで停止ボタン/再接続オーバーレイを検知し、
setSessionState で報告。︙ボタンの色変えと __ccStudioFocusLog への遷移ログ
（CANCEL 相関含む）はローカルで完結。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 実機検証チェックリストとセレクタ調整メモ

**Files:**
- Modify: `docs/notes/2026-06-30-connection-tool-cancel.md`（検証手順と相関ログの見方を追記）

このタスクは実機（CC Studio アプリ）での目視検証。bootstrap.js のセレクタは実機 DOM で
しか確定しないため、ここでマッチ状況を確認して必要なら Task 5 のヒューリスティックを調整する。

- [ ] **Step 1: アプリをビルド/インストールして検証**

`./gradlew installDebug`（または既存の配布手順）で実機へ入れ、以下を確認:
- セッションで処理を開始 → switcher 行に「処理中」スピナー、︙ボタンが青パルス、常駐通知に「・処理中 N」。
- 処理完了 → ~800ms 以内に解除。
- 機内モード等で code-server を切断 → switcher 行に「接続切れ」赤●、︙ボタン赤、通知に「・接続切れ N」。
- focus-hud（[plugins/focus-hud.js](../../plugins/focus-hud.js)）を有効化し、ログに `STATE` / `CANCEL` 行が時刻付きで出ることを確認。

- [ ] **Step 2: セレクタが合わなければ Task 5 を調整**

`detectBusy()` / `detectDisconnected()` が拾えない/誤検知する場合、focus-hud ログの `matched`
を見ながら該当セレクタ・文言を実機 DOM に合わせて修正し、Step 1 を再実行。修正したら
`git commit -m "fix(observer): 実機 DOM に合わせて検知セレクタを調整"` で都度コミット。

- [ ] **Step 3: 接続メモに検証手順と相関の見方を追記**

`docs/notes/2026-06-30-connection-tool-cancel.md` の「## 運用」節の末尾に追記:

```markdown

## 相関ログの見方（セッション状態オブザーバ）

- bootstrap.js のオブザーバが `window.top.__ccStudioFocusLog` に時刻付きで積む:
  - `{tag:'STATE', busy, disconnected, matched}` … 処理中/接続切れの遷移。
  - `{tag:'CANCEL'}` … "doesn't want to take this action" 相当の停止信号を検知。
- 突発キャンセルが出たら、直前の `CANCEL` 行の時刻と、近傍の `STATE`(disconnected:true) や
  keyboard-suppress の `blur` 行を突き合わせる。
  - `CANCEL` 直前に `disconnected:true` があれば **接続瞬断由来**の疑い。
  - `CANCEL` 直前に blur ログ（フォアグラウンド復帰）があれば **focus 抑制由来**の疑い。
- 切り分けが付いたら、設計の方式B（hooks→WS）導入や keyboard-suppress の発火条件見直しへ。
```

- [ ] **Step 4: コミット**

```bash
git add docs/notes/2026-06-30-connection-tool-cancel.md
git commit -m "docs(notes): セッション状態オブザーバの相関ログの見方を追記

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage**: 状態モデル(T1) / 常駐通知(T2) / ブリッジ識別(T3) / switcher 表示(T4) /
  ︙ボタン・観測・診断ログ(T5) / 実機検証・セレクタ調整(T6)。設計の全節を被覆。方式B はスコープ外と明記済み。
- **Placeholder scan**: 各ステップに実コード／実コマンドあり。"TBD"/"適宜" 無し。
- **Type consistency**: `setSessionState(busy, disconnected)` は CcBridge(T3)・bootstrap.js(T5) で一致。
  `ScreenRow(... busy, disconnected)` は ScreensJson(T1)・ScreenManager(T1)・テスト(T1) で一致。
  `KeepAliveText.statusLine(screens, busy, disconnected)` は KeepAliveService(T2)・テスト(T2) で一致。
  `NotifyState.busyCount/disconnectedCount` は NotifyState(T2)・MainActivity(T3)・KeepAliveService(T2) で一致。
```
