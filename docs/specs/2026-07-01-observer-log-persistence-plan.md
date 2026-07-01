# 観測ログ永続化（フェーズ1）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** state-observer の状態遷移とキープアライブ WS の断/復帰を、アプリ更新で消えないログファイル（JSONL・絶対時刻）へイベント駆動で永続化する。

**Architecture:** プラグインは生の状態遷移で `CCStudio.observerLog(json)` を呼ぶ（OFF もデバウンスせず生時刻）。ネイティブは単一の `ObserverLog`（共有 `ObserverLogStore`）へ、`System.currentTimeMillis()` とスクリーン情報を付けて 1 行 JSONL を append＋即フラッシュし、サイズでローテートする。`KeepAliveService` の WS イベントと Activity ライフサイクルも同じログへ書く。

**Tech Stack:** Kotlin（Android, JVM 単体テスト = JUnit4 + org.json）、WebView JavaScript（ES5・既存 state-observer.js）。

## Global Constraints

- 設計は [docs/specs/2026-07-01-observer-log-persistence-design.md](2026-07-01-observer-log-persistence-design.md) に従う。
- `server/code-server` サブモジュールは触らない。[[dont-edit-code-server-submodule]]
- 単体テストコマンド: `./gradlew testDebugUnitTest`。ビルド: `./gradlew assembleDebug`。
- JS は ES5 互換・冪等。既存 state-observer.js の書式に合わせる。
- ログ I/O 失敗はアプリ動作に影響させない（try/catch で握りつぶす）。
- 絶対時刻は `System.currentTimeMillis()` で一括採番（単一端末クロック）。
- コミットは各タスク末尾。メッセージ末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- スコープはフェーズ1（ローカル永続化）のみ。サーバ送信・突合はフェーズ2（別計画）。

---

### Task 1: ObserverRecord（JSONL 組み立て）と ObserverLogStore（追記・ローテート）

**Files:**
- Create: `app/src/main/java/app/ccstudio/ObserverRecord.kt`
- Create: `app/src/main/java/app/ccstudio/ObserverLogStore.kt`
- Test: `app/src/test/java/app/ccstudio/ObserverRecordTest.kt`
- Test: `app/src/test/java/app/ccstudio/ObserverLogStoreTest.kt`

**Interfaces:**
- Produces: `ObserverRecord.screenState(t: Long, screen: String, cwd: String, busy: Boolean, disconnected: Boolean, matched: String): String`
- Produces: `ObserverRecord.keepalive(t: Long, event: String, detail: String): String`
- Produces: `ObserverRecord.lifecycle(t: Long, event: String): String`
- Produces: `ObserverLogStore(dir: File, maxBytes: Long = 512L*1024).append(line: String)`（同期・即フラッシュ・サイズ超過で `observer.log`→`observer.1.log` ローテート）
- Produces: `ObserverLog`（共有シングルトン。`of/screenState/keepalive/lifecycle`）

- [ ] **Step 1: 失敗するテストを書く（ObserverRecord）**

`app/src/test/java/app/ccstudio/ObserverRecordTest.kt`:

```kotlin
package app.ccstudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ObserverRecordTest {
    @Test fun screenStateHasFields() {
        val o = JSONObject(ObserverRecord.screenState(1_700_000_000_000L, "cc-studio", "/mnt/x", false, true, "overlay:reconnecting"))
        assertEquals(1_700_000_000_000L, o.getLong("t"))
        assertTrue(o.getString("iso").isNotEmpty())
        assertEquals("screen", o.getString("src"))
        assertEquals("state", o.getString("kind"))
        assertEquals("cc-studio", o.getString("screen"))
        assertEquals("/mnt/x", o.getString("cwd"))
        assertEquals(false, o.getBoolean("busy"))
        assertEquals(true, o.getBoolean("disconnected"))
        assertEquals("overlay:reconnecting", o.getString("matched"))
    }

    @Test fun keepaliveHasFields() {
        val o = JSONObject(ObserverRecord.keepalive(1_700_000_000_000L, "failure", "code=1006"))
        assertEquals("keepalive", o.getString("src"))
        assertEquals("ws", o.getString("kind"))
        assertEquals("failure", o.getString("event"))
        assertEquals("code=1006", o.getString("detail"))
    }

    @Test fun lifecycleHasFields() {
        val o = JSONObject(ObserverRecord.lifecycle(1_700_000_000_000L, "foreground"))
        assertEquals("app", o.getString("src"))
        assertEquals("lifecycle", o.getString("kind"))
        assertEquals("foreground", o.getString("event"))
    }

    @Test fun lineIsSingleLine() {
        val s = ObserverRecord.screenState(1L, "a", "/a", true, false, "x")
        assertTrue(!s.contains("\n"))
    }
}
```

- [ ] **Step 2: 失敗するテストを書く（ObserverLogStore）**

`app/src/test/java/app/ccstudio/ObserverLogStoreTest.kt`:

```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ObserverLogStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun appendsOneLinePerRecord() {
        val store = ObserverLogStore(tmp.root)
        store.append("""{"a":1}""")
        store.append("""{"a":2}""")
        val lines = java.io.File(tmp.root, "observer.log").readLines()
        assertEquals(2, lines.size)
        assertEquals("""{"a":1}""", lines[0])
        assertEquals("""{"a":2}""", lines[1])
    }

    @Test fun rotatesWhenOverSize() {
        val store = ObserverLogStore(tmp.root, maxBytes = 64)
        repeat(20) { store.append("""{"i":$it,"pad":"xxxxxxxxxx"}""") }
        val cur = java.io.File(tmp.root, "observer.log")
        val old = java.io.File(tmp.root, "observer.1.log")
        assertTrue(old.exists())
        assertTrue(cur.exists())
        assertTrue(cur.readText().contains("\"i\":19"))
    }
}
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `./gradlew testDebugUnitTest --tests 'app.ccstudio.ObserverRecordTest' --tests 'app.ccstudio.ObserverLogStoreTest'`
Expected: コンパイルエラー（`ObserverRecord`/`ObserverLogStore` 未定義）で FAIL。

- [ ] **Step 4: `ObserverRecord.kt` を実装**

```kotlin
package app.ccstudio

import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 観測ログの1行 JSONL を組み立てる純関数群。時刻(t=epoch ms)から ISO8601(TZ付) を作る。 */
object ObserverRecord {
    private fun iso(t: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date(t))

    fun screenState(t: Long, screen: String, cwd: String, busy: Boolean, disconnected: Boolean, matched: String): String =
        JSONObject()
            .put("t", t).put("iso", iso(t)).put("src", "screen").put("kind", "state")
            .put("screen", screen).put("cwd", cwd)
            .put("busy", busy).put("disconnected", disconnected).put("matched", matched)
            .toString()

    fun keepalive(t: Long, event: String, detail: String): String =
        JSONObject()
            .put("t", t).put("iso", iso(t)).put("src", "keepalive").put("kind", "ws")
            .put("event", event).put("detail", detail)
            .toString()

    fun lifecycle(t: Long, event: String): String =
        JSONObject()
            .put("t", t).put("iso", iso(t)).put("src", "app").put("kind", "lifecycle")
            .put("event", event)
            .toString()
}
```

- [ ] **Step 5: `ObserverLogStore.kt` を実装**

```kotlin
package app.ccstudio

import android.content.Context
import java.io.File

/**
 * 観測ログを1行 JSONL で追記＋即フラッシュし、サイズ超過で1世代ローテートするストア。
 * dir を注入するので JVM 単体テスト可能。append は同期（複数コンポーネントから呼ばれる）。
 */
class ObserverLogStore(private val dir: File, private val maxBytes: Long = 512L * 1024) {
    private val lock = Any()

    fun append(line: String) = synchronized(lock) {
        try {
            if (!dir.exists()) dir.mkdirs()
            val cur = File(dir, "observer.log")
            if (cur.exists() && cur.length() >= maxBytes) {
                val old = File(dir, "observer.1.log")
                old.delete()
                cur.renameTo(old)
            }
            cur.appendText(line + "\n", Charsets.UTF_8)
        } catch (_: Exception) { /* ログ機能はアプリを落とさない */ }
    }
}

/** アプリ全体で共有する単一ストア。MainActivity と KeepAliveService の両方から使う。 */
object ObserverLog {
    @Volatile private var store: ObserverLogStore? = null
    fun of(context: Context): ObserverLogStore =
        store ?: synchronized(this) {
            store ?: ObserverLogStore(
                context.getExternalFilesDir("observer") ?: File(context.filesDir, "observer")
            ).also { store = it }
        }
    fun screenState(context: Context, screen: String, cwd: String, busy: Boolean, disc: Boolean, matched: String) =
        of(context).append(ObserverRecord.screenState(System.currentTimeMillis(), screen, cwd, busy, disc, matched))
    fun keepalive(context: Context, event: String, detail: String) =
        of(context).append(ObserverRecord.keepalive(System.currentTimeMillis(), event, detail))
    fun lifecycle(context: Context, event: String) =
        of(context).append(ObserverRecord.lifecycle(System.currentTimeMillis(), event))
}
```

- [ ] **Step 6: テストが通ることを確認**

Run: `./gradlew testDebugUnitTest --tests 'app.ccstudio.ObserverRecordTest' --tests 'app.ccstudio.ObserverLogStoreTest'`
Expected: PASS（Record 4 件・Store 2 件）。

- [ ] **Step 7: コミット**

```bash
git add app/src/main/java/app/ccstudio/ObserverRecord.kt \
        app/src/main/java/app/ccstudio/ObserverLogStore.kt \
        app/src/test/java/app/ccstudio/ObserverRecordTest.kt \
        app/src/test/java/app/ccstudio/ObserverLogStoreTest.kt
git commit -m "feat(observerlog): JSONL レコード組み立てと追記/ローテートのストアを追加

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: ブリッジ observerLog とスクリーン状態・ライフサイクルの記録（MainActivity）

**Files:**
- Modify: `app/src/main/java/app/ccstudio/CcBridge.kt`
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`（`buildBridge`, 新規 `onObserverLog`, ライフサイクル）

**Interfaces:**
- Consumes: `ObserverLog.screenState(...)`, `ObserverLog.lifecycle(...)`（Task 1）。
- Produces: JS から呼べる `window.CCStudio.observerLog(json: string)`（Task 4 が呼ぶ）。
  json は `{"busy":bool,"disconnected":bool,"matched":str}`（kind は native 側で state 固定）。

Android 依存のためビルド通過で検証する。

- [ ] **Step 1: `CcBridge` にメソッドを追加**

`CcBridge.kt` のコンストラクタ末尾（`onSessionState` の後）に引数追加:

```kotlin
    private val onSessionState: (busy: Boolean, disconnected: Boolean) -> Unit,
    private val onObserverLog: (json: String) -> Unit,
) {
```

クラス本体末尾（最後の `}` の手前）にメソッド追加:

```kotlin
    /** 観測ログ（生の状態遷移）をネイティブへ。JSON: {"busy":bool,"disconnected":bool,"matched":str}。 */
    @JavascriptInterface
    fun observerLog(json: String) = onObserverLog(json)
```

- [ ] **Step 2: `buildBridge` で配線**

`MainActivity.kt` の `buildBridge(screenId)` 内、`onSessionState = { ... },` の行を次の2行に置き換える:

```kotlin
        onSessionState = { busy, disconnected -> onSessionState(screenId, busy, disconnected) },
        onObserverLog = { json -> onObserverLog(screenId, json) },
```

- [ ] **Step 3: `onObserverLog` を実装**

`onSessionState(...)` メソッドの直後に追加:

```kotlin
    /** プラグインからの生の状態遷移を、スクリーン情報＋端末時刻を付けて永続ログへ書く。 */
    private fun onObserverLog(screenId: Long, json: String) {
        try {
            val o = org.json.JSONObject(json)
            val s = screens.byId(screenId)
            val screen = if (s?.kind == ScreenKind.WEB) ScreenUrl.folderName(s.url) else (s?.title ?: "")
            val cwd = if (s?.kind == ScreenKind.WEB) (ScreenUrl.folderPath(s.url) ?: "") else ""
            ObserverLog.screenState(
                this, screen, cwd,
                o.optBoolean("busy", false), o.optBoolean("disconnected", false), o.optString("matched", ""),
            )
        } catch (_: Exception) { /* ログはアプリを落とさない */ }
    }
```

- [ ] **Step 4: ライフサイクルマーカーを記録**

`MainActivity` に onResume/onPause を追加（既存にあれば中へ1行足す）:

```kotlin
    override fun onResume() {
        super.onResume()
        ObserverLog.lifecycle(this, "foreground")
    }

    override fun onPause() {
        super.onPause()
        ObserverLog.lifecycle(this, "background")
    }
```

`onCreate` の末尾（`root` 構築後、一度）に起動マーカー:

```kotlin
        ObserverLog.lifecycle(this, "start")
```

- [ ] **Step 5: ビルド確認**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL。

- [ ] **Step 6: コミット**

```bash
git add app/src/main/java/app/ccstudio/CcBridge.kt app/src/main/java/app/ccstudio/MainActivity.kt
git commit -m "feat(observerlog): observerLog ブリッジとスクリーン状態/ライフサイクルの記録

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: キープアライブ WS の記録（KeepAliveService）

**Files:**
- Modify: `app/src/main/java/app/ccstudio/KeepAliveService.kt`

**Interfaces:**
- Consumes: `ObserverLog.keepalive(context, event, detail)`（Task 1）。

- [ ] **Step 1: WS リスナに記録を足す**

`KeepAliveService.kt` の `connect()` 内 `WebSocketListener` の各コールバックに追記:

```kotlin
            override fun onOpen(webSocket: WebSocket, response: Response) {
                backoffMs = 2000L
                ObserverLog.keepalive(this@KeepAliveService, "open", "")
            }
```

```kotlin
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                ObserverLog.keepalive(this@KeepAliveService, "failure", (t.message ?: "").take(80))
                scheduleReconnect()
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                ObserverLog.keepalive(this@KeepAliveService, "closed", "code=$code $reason".take(80))
                scheduleReconnect()
            }
```

- [ ] **Step 2: ビルド確認**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL。

- [ ] **Step 3: コミット**

```bash
git add app/src/main/java/app/ccstudio/KeepAliveService.kt
git commit -m "feat(observerlog): キープアライブ WS の open/closed/failure を記録

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: プラグインから生の状態遷移を送る（state-observer.js）

**Files:**
- Modify: `plugins/state-observer.js`

**Interfaces:**
- Consumes: `window.CCStudio.observerLog(json)`（Task 2）。
- 既存の `computeState()` / `aggregate()`（トップフレーム集約）を利用。

**要点:** UI 用の `setSessionState` はデバウンス済み `doCommit` のまま。ログは **生の遷移**（OFF もデバウンスせず）で送る。両者のタイミング源を分ける。

- [ ] **Step 1: 生遷移ロガーを追加し aggregate に差し込む**

`state-observer.js` の `@version` を `1.3.0` に更新。`var lastB = null, lastD = null, offTimer = null;` の行の直後に生ログ用の状態を追加:

```javascript
  var loggedB = null, loggedD = null;
  function observerLog(busy, disc, matched) {
    try {
      if (window.CCStudio && window.CCStudio.observerLog)
        window.CCStudio.observerLog(JSON.stringify({ busy: !!busy, disconnected: !!disc, matched: matched || '' }));
    } catch (_) {}
  }
```

`aggregate()` の先頭（`var s = computeState();` の直後）に、生遷移の即時ログを差し込む:

```javascript
  function aggregate() {
    var s = computeState();
    // ログ: 生の遷移で即記録（OFF もデバウンスしない。UI は下の doCommit 側でデバウンス）。
    if (s.busy !== loggedB || s.disc !== loggedD) {
      loggedB = s.busy; loggedD = s.disc;
      observerLog(s.busy, s.disc, s.matched);
    }
```

（既存の「変化なし return / goingOn 即時 / off デバウンス」ロジックはそのまま後続に残す。）

- [ ] **Step 2: 構文確認**

Run: `node --check plugins/state-observer.js`
Expected: 出力なし（OK）。

- [ ] **Step 3: コミット**

```bash
git add plugins/state-observer.js
git commit -m "feat(observer): 生の状態遷移を observerLog で永続ログへ送る(v1.3.0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 実機検証（ログファイルの回収と JSONL 確認）

**Files:**
- Modify: `docs/notes/2026-06-30-connection-tool-cancel.md`（ログの所在と確認手順を追記）

実機での目視検証。プラグイン(v1.3.0 再取り込み)＋新 APK をインストールして行う。

- [ ] **Step 1: イベントを発生させて記録を確認**

`./gradlew installDebug`（or 配布手順）後:
- あるスクリーンで処理を走らせる → 終える。別スクリーンでも。
- 機内モード等でキープアライブ/接続を切って戻す。
- アプリを背面→前面へ。

- [ ] **Step 2: ログファイルを回収して JSONL を確認**

Run: `adb exec-out cat /sdcard/Android/data/app.ccstudio/files/observer/observer.log | tail -40`
Expected: 1 行 1 JSON。`src:"screen"`（busy/disconnected 遷移, matched 付き）、`src:"keepalive"`（open/closed/failure）、`src:"app"`（lifecycle）が**絶対時刻 t/iso 付き**で並ぶ。処理の OFF が生タイミング（デバウンス遅延なし）で記録されている。

- [ ] **Step 3: 接続メモに所在と手順を追記**

`docs/notes/2026-06-30-connection-tool-cancel.md` の「## 相関ログの見方」節の末尾に追記:

```markdown

## 永続ログ（フェーズ1）

- 保存先: `/sdcard/Android/data/app.ccstudio/files/observer/observer.log`（JSONL, アプリ更新で消えない）。
- `src:"screen"`（処理中/接続切れ遷移）と `src:"keepalive"`（WS open/closed/failure）を**同一端末クロック**で
  記録。突発キャンセル発生時は、近傍の `keepalive failure` と `screen disconnected` の t を突き合わせる。
- 接続断は cc-web reconnectguard 準拠で `"attempting to reconnect"`/`"cannot reconnect"` を検知。
- フェーズ2 でこれを agent1 の cc-notify サーバ(claude-code-config)へ送り、サーバ側 WS 断と時刻突合する。
```

- [ ] **Step 4: コミット**

```bash
git add docs/notes/2026-06-30-connection-tool-cancel.md
git commit -m "docs(notes): 永続観測ログの所在と確認手順を追記

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage**: 保存先/ローテート(T1) / ブリッジ・スクリーン状態・ライフサイクル(T2) /
  キープアライブ記録(T3) / 生遷移送信・OFF生時刻(T4) / 実機検証・所在追記(T5)。設計の各節を被覆。
  絶対時刻・単一クロック・イベント駆動・OFF生時刻・keepalive 流用を反映。フェーズ2 はスコープ外と明記。
- **Placeholder scan**: 各ステップに実コード/実コマンドあり。TBD 無し。
- **Type consistency**: `ObserverLog.screenState/keepalive/lifecycle` は T1 定義と T2/T3 使用で一致。
  `observerLog(json)` は CcBridge(T2)・plugin(T4) で一致（json は {busy,disconnected,matched}）。
  `ObserverLogStore(dir, maxBytes)` は T1 定義とテストで一致。
