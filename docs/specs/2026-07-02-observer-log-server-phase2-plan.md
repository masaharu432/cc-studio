# 観測ログ サーバ取得・突合（フェーズ2）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 端末の観測ログを agent1 の relay.mjs へ自動アップロードし、repo 内 `server/notify-relay/data/observer.jsonl`（gitignore）へ端末行＋サーバ視点 keepalive＋受信時刻を追記して、Claude が直接解析できる状態を作る。

**Architecture:** アプリ `KeepAliveService` が `readAll()` から `t>lastUploadedT` の行を抽出し `POST /cc-observer`（復帰/60s定期/前面）。relay は本文 `type==="cc-observer"` を判定して data/observer.jsonl へ追記（＋バッチ受信マーカー）、それ以外は従来 broadcast。WS 接続/切断もサーバ時刻で追記。

**Tech Stack:** Node（relay, `node:test`）、Kotlin（Android, JUnit4）、OkHttp（既存）。

## Global Constraints

- 設計は [docs/specs/2026-07-02-observer-log-server-phase2-design.md](2026-07-02-observer-log-server-phase2-design.md) に従う。
- `server/code-server` サブモジュールは触らない。[[dont-edit-code-server-submodule]]
- tailnet 前提・アプリ層認証なし。[[cc-studio-tailnet-only]]
- relay テスト: `node --test server/notify-relay/relay.test.mjs`。アプリ: `./gradlew testDebugUnitTest` / `assembleDebug`。
- 保存/送信の失敗は握りつぶし、relay・アプリを落とさない。時刻は絶対時刻(epoch ms)。
- コミットは各タスク末尾。メッセージ末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: relay.mjs にログ保存・サーバ keepalive を追加

**Files:**
- Modify: `server/notify-relay/relay.mjs`
- Modify: `server/notify-relay/relay.test.mjs`
- Create: `server/notify-relay/.gitignore`

**Interfaces:**
- Produces（純関数・export）: `isObserverBatch(o): boolean`、`formatBatchRecords(o, tServer): string`、`serverKeepaliveLine(event, tServer): string`
- 副作用ラッパ: `appendObserver(text)`（data/observer.jsonl へ append）

- [ ] **Step 1: 失敗するテストを書く**

`server/notify-relay/relay.test.mjs` の末尾に追記:

```javascript
import { isObserverBatch, formatBatchRecords, serverKeepaliveLine } from "./relay.mjs"

test("isObserverBatch detects observer batch bodies", () => {
  assert.equal(isObserverBatch({ type: "cc-observer", lines: "{}\n" }), true)
  assert.equal(isObserverBatch({ hook_event_name: "Stop" }), false)
  assert.equal(isObserverBatch(null), false)
  assert.equal(isObserverBatch({ type: "cc-observer" }), false)
})

test("formatBatchRecords appends lines then a server batch marker", () => {
  const out = formatBatchRecords({ type: "cc-observer", device: "d1", sentAt: 111, lines: '{"t":1}\n{"t":2}' }, 999)
  const lines = out.trim().split("\n")
  assert.equal(lines[0], '{"t":1}')
  assert.equal(lines[1], '{"t":2}')
  const marker = JSON.parse(lines[2])
  assert.equal(marker.src, "server")
  assert.equal(marker.kind, "batch")
  assert.equal(marker.t_server, 999)
  assert.equal(marker.device, "d1")
  assert.equal(marker.count, 2)
  assert.equal(marker.sentAt, 111)
})

test("serverKeepaliveLine builds connect/disconnect line", () => {
  const o = JSON.parse(serverKeepaliveLine("disconnect", 555).trim())
  assert.equal(o.src, "server")
  assert.equal(o.kind, "keepalive")
  assert.equal(o.event, "disconnect")
  assert.equal(o.t_server, 555)
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test server/notify-relay/relay.test.mjs`
Expected: `isObserverBatch` 等が未定義で FAIL。

- [ ] **Step 3: relay.mjs に純関数と保存を実装**

`relay.mjs` の import 群の直後（`const asString = ...` の前後）に追加:

```javascript
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data")
const DATA_FILE = path.join(DATA_DIR, "observer.jsonl")

export function isObserverBatch(o) {
  return !!(o && typeof o === "object" && o.type === "cc-observer" && typeof o.lines === "string")
}

export function formatBatchRecords(o, tServer) {
  const raw = String(o.lines || "")
  const lines = raw.split("\n").filter((s) => s.trim())
  const marker = JSON.stringify({
    src: "server", kind: "batch", t_server: tServer,
    device: asString(o.device), count: lines.length, sentAt: Number(o.sentAt) || 0,
  })
  return lines.concat(marker).join("\n") + "\n"
}

export function serverKeepaliveLine(event, tServer) {
  return JSON.stringify({ src: "server", kind: "keepalive", event, t_server: tServer }) + "\n"
}

function appendObserver(text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(DATA_FILE, text)
  } catch (e) {
    console.error("observer append failed:", e.message)
  }
}
```

（注: `asString` は既存。`isObserverBatch` より後で使うが hoist される関数宣言なので順序問題なし。もし
参照エラーになる配置なら `asString` 定義をこのブロックより前へ移す。）

- [ ] **Step 4: POST 判定と WS keepalive 記録を差し込む**

`createServer()` 内、`req.on("end", () => {` の中身を次に置き換える:

```javascript
      req.on("end", () => {
        let parsed
        try { parsed = body ? JSON.parse(body) : {} } catch { parsed = {} }
        if (isObserverBatch(parsed)) {
          appendObserver(formatBatchRecords(parsed, Date.now()))
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ saved: true }))
          return
        }
        const delivered = broadcast(normalizeEvent(parsed))
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ delivered }))
      })
```

`handleUpgrade` 内、`clients.add(socket)` の直後に接続記録、`drop` に切断記録を足す:

```javascript
  clients.add(socket)
  appendObserver(serverKeepaliveLine("connect", Date.now()))
```

```javascript
  const drop = () => { clients.delete(socket); appendObserver(serverKeepaliveLine("disconnect", Date.now())); try { socket.destroy() } catch {} }
  socket.on("close", () => { clients.delete(socket); appendObserver(serverKeepaliveLine("disconnect", Date.now())) })
```

- [ ] **Step 5: .gitignore を作成**

`server/notify-relay/.gitignore`:

```
data/
```

- [ ] **Step 6: テストが通ることを確認**

Run: `node --test server/notify-relay/relay.test.mjs`
Expected: 追加3件＋既存すべて PASS。

- [ ] **Step 7: コミット**

```bash
git add server/notify-relay/relay.mjs server/notify-relay/relay.test.mjs server/notify-relay/.gitignore
git commit -m "feat(relay): 観測ログ受信保存とサーバ視点 keepalive 記録を追加

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: アップロード差分抽出（Kotlin 純関数）

**Files:**
- Create: `app/src/main/java/app/ccstudio/UploadDelta.kt`
- Test: `app/src/test/java/app/ccstudio/UploadDeltaTest.kt`

**Interfaces:**
- Produces: `UploadDelta.select(text: String, lastT: Long): UploadDelta.Result`（`Result(lines: String, maxT: Long, count: Int)`）
  - `text` の各行を JSON パースし `t > lastT` の行だけ連結。`maxT` は送った最大 t（無ければ lastT）。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/test/java/app/ccstudio/UploadDeltaTest.kt`:

```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class UploadDeltaTest {
    private val sample = listOf(
        """{"t":100,"a":1}""",
        """{"t":200,"a":2}""",
        """{"t":300,"a":3}""",
    ).joinToString("\n") + "\n"

    @Test fun selectsOnlyNewerThanLastT() {
        val r = UploadDelta.select(sample, 150)
        assertEquals(2, r.count)
        assertEquals(300, r.maxT)
        assertEquals("""{"t":200,"a":2}""" + "\n" + """{"t":300,"a":3}""", r.lines)
    }

    @Test fun emptyWhenNothingNewer() {
        val r = UploadDelta.select(sample, 300)
        assertEquals(0, r.count)
        assertEquals(300, r.maxT)
        assertEquals("", r.lines)
    }

    @Test fun skipsUnparseableLines() {
        val r = UploadDelta.select("not-json\n" + """{"t":10}""" + "\n", 0)
        assertEquals(1, r.count)
        assertEquals(10, r.maxT)
    }
}
```

- [ ] **Step 2: 失敗を確認**

Run: `./gradlew testDebugUnitTest --tests 'app.ccstudio.UploadDeltaTest'`
Expected: `UploadDelta` 未定義で FAIL。

- [ ] **Step 3: `UploadDelta.kt` を実装**

```kotlin
package app.ccstudio

import org.json.JSONObject

/** 永続ログ本文から「lastT より新しい行」を抽出する純関数。バイトオフセット不要でローテートに頑健。 */
object UploadDelta {
    data class Result(val lines: String, val maxT: Long, val count: Int)

    fun select(text: String, lastT: Long): Result {
        val out = ArrayList<String>()
        var maxT = lastT
        for (line in text.split("\n")) {
            val s = line.trim()
            if (s.isEmpty()) continue
            val t = try { JSONObject(s).optLong("t", -1) } catch (_: Exception) { -1 }
            if (t < 0) continue
            if (t > lastT) {
                out.add(s)
                if (t > maxT) maxT = t
            }
        }
        return Result(out.joinToString("\n"), maxT, out.size)
    }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `./gradlew testDebugUnitTest --tests 'app.ccstudio.UploadDeltaTest'`
Expected: PASS（3件）。

- [ ] **Step 5: コミット**

```bash
git add app/src/main/java/app/ccstudio/UploadDelta.kt app/src/test/java/app/ccstudio/UploadDeltaTest.kt
git commit -m "feat(observerlog): アップロード差分抽出 UploadDelta を追加

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: KeepAliveService からの自動アップロード配線

**Files:**
- Modify: `app/src/main/java/app/ccstudio/KeepAliveService.kt`
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`（onResume で ACTION_UPLOAD）

**Interfaces:**
- Consumes: `ObserverLog.readAll(this)`（フェーズ1）、`UploadDelta.select`（Task 2）。
- 送信先: `BuildConfig.TARGET_URL` の host から `https://host/cc-notify`。

Android 依存のためビルド通過で検証する。

- [ ] **Step 1: 送信 URL とアップロード実装を追加**

`KeepAliveService.kt` のフィールド群（`@Volatile private var backoffMs` 付近）に追加:

```kotlin
    @Volatile private var uploading = false
    private val uploadRunnable = object : Runnable {
        override fun run() {
            triggerUpload()
            if (!stopped) handler.postDelayed(this, 60_000L)
        }
    }
    private val prefs by lazy { getSharedPreferences("cc_observer", MODE_PRIVATE) }
    private fun deviceId(): String {
        var id = prefs.getString("device_id", null)
        if (id == null) { id = java.util.UUID.randomUUID().toString().take(12); prefs.edit().putString("device_id", id).apply() }
        return id
    }
```

`wsUrl()` の直後に POST 先を作る関数を追加:

```kotlin
    /** TARGET_URL から https://host/cc-notify を作る（ログアップロード先）。 */
    private fun postUrl(): String? {
        val base = BuildConfig.TARGET_URL.ifEmpty { return null }
        val schemeEnd = base.indexOf("://")
        if (schemeEnd < 0) return null
        val host = base.substring(schemeEnd + 3).substringBefore('/')
        return "https://$host/cc-notify"
    }
```

アップロード本体（クラス内に追加）:

```kotlin
    /** 未送信分(t>lastUploadedT)を relay へ POST。成功で lastUploadedT を更新。失敗は次回再試行。 */
    private fun triggerUpload() {
        if (uploading || stopped) return
        val url = postUrl() ?: return
        uploading = true
        try {
            val lastT = prefs.getLong("last_uploaded_t", 0L)
            val delta = UploadDelta.select(ObserverLog.readAll(this), lastT)
            if (delta.count == 0) { uploading = false; return }
            val payload = org.json.JSONObject()
                .put("type", "cc-observer").put("device", deviceId())
                .put("sentAt", System.currentTimeMillis()).put("lines", delta.lines).toString()
            val req = Request.Builder().url(url)
                .post(payload.toRequestBody("application/json".toMediaType())).build()
            client.newCall(req).enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) { uploading = false }
                override fun onResponse(call: okhttp3.Call, response: Response) {
                    try { if (response.isSuccessful) prefs.edit().putLong("last_uploaded_t", delta.maxT).apply() }
                    finally { response.close(); uploading = false }
                }
            })
        } catch (e: Exception) { uploading = false }
    }
```

必要 import（ファイル先頭に追加、未追加のもののみ）:

```kotlin
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
```

- [ ] **Step 2: トリガーを配線**

`onCreate()` の `connect()` の直後に定期アップロード開始:

```kotlin
        handler.postDelayed(uploadRunnable, 15_000L)
```

`onOpen()`（既に ObserverLog.keepalive を書いている箇所）の末尾に復帰時アップロード:

```kotlin
                ObserverLog.keepalive(this@KeepAliveService, "open", "")
                triggerUpload()
```

`onStartCommand` に ACTION_UPLOAD 分岐を追加（既存 ACTION_REFRESH の分岐の隣）:

```kotlin
        if (intent?.action == ACTION_UPLOAD) triggerUpload()
```

`companion object` に定数追加:

```kotlin
        const val ACTION_UPLOAD = "app.ccstudio.UPLOAD_OBSERVER_LOG"
```

`onDestroy()` の先頭で定期停止:

```kotlin
        handler.removeCallbacks(uploadRunnable)
```

- [ ] **Step 3: 前面復帰でアップロード（MainActivity）**

`MainActivity.onResume()` の末尾（`ObserverLog.lifecycle(this, "foreground")` の後）に追加:

```kotlin
        ContextCompat.startForegroundService(
            this,
            Intent(this, KeepAliveService::class.java).setAction(KeepAliveService.ACTION_UPLOAD),
        )
```

- [ ] **Step 4: ビルド確認**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL。

- [ ] **Step 5: コミット**

```bash
git add app/src/main/java/app/ccstudio/KeepAliveService.kt app/src/main/java/app/ccstudio/MainActivity.kt
git commit -m "feat(observerlog): 未送信分を relay へ自動アップロード(復帰/定期/前面)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 実機検証（サーバ保存の確認と Claude 解析）

**Files:**
- Modify: `docs/notes/2026-06-30-connection-tool-cancel.md`（サーバ保存先と解析手順を追記）

- [ ] **Step 1: relay を再起動して受信を確認**

- 新 APK をインストール。relay を再起動（`systemctl --user restart notify-relay` 等、`install-notify.sh` の常駐名に従う）。
- アプリで処理を走らせる／接続を切って戻す／前面復帰。
- Run: `tail -f server/notify-relay/data/observer.jsonl`
  Expected: 端末行（screen/keepalive/app）＋サーバ行（`src:"server" kind:"keepalive"` connect/disconnect、`kind:"batch"`）が増える。

- [ ] **Step 2: Claude が直接解析できることを確認**

- Run: `grep -nE '"disconnected":true|keepalive.*failure|"src":"server"' server/notify-relay/data/observer.jsonl | tail -30`
  Expected: 端末側の断とサーバ側の断が時刻付きで並び、突合できる。

- [ ] **Step 3: 接続メモに追記**

`docs/notes/2026-06-30-connection-tool-cancel.md` の「## 永続ログ（フェーズ1）」の後に追記:

```markdown

## サーバ取得（フェーズ2）

- アプリが未送信分(t>lastUploadedT)を `POST https://host/cc-notify`（body type=cc-observer）で自動送信
  （keepalive 復帰・60s定期・前面復帰）。relay が `server/notify-relay/data/observer.jsonl` へ追記。
- サーバ視点の keepalive（`src:"server" kind:"keepalive" connect/disconnect`）とバッチ受信時刻
  （`kind:"batch" t_server/sentAt`）も残るので、端末側の断と**サーバ側の断**を時刻突合できる。
- Claude 解析: `server/notify-relay/data/observer.jsonl` を直接 grep/cat。突発キャンセル時刻の近傍で
  端末 `keepalive failure` / サーバ `keepalive disconnect` / `screen disconnected @<folder>` を並べる。
```

- [ ] **Step 4: コミット**

```bash
git add docs/notes/2026-06-30-connection-tool-cancel.md
git commit -m "docs(notes): サーバ取得(フェーズ2)の保存先と解析手順を追記

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage**: relay 保存・振り分け・サーバ keepalive(T1) / 差分抽出(T2) / 自動アップロード配線(T3) /
  実機検証・解析手順(T4)。設計の各節を被覆。自動トリガー(復帰/定期/前面)・repo 内 gitignore 保存・
  サーバ視点 keepalive・時計ズレ(t_server/sentAt) を反映。解析自動化・reconnectguard はスコープ外と明記。
- **Placeholder scan**: 各ステップに実コード/実コマンドあり。TBD 無し。
- **Type consistency**: `isObserverBatch/formatBatchRecords/serverKeepaliveLine` は relay.mjs 定義と
  relay.test.mjs 使用で一致。`UploadDelta.select→Result(lines,maxT,count)` は定義・テスト・KeepAliveService 使用で一致。
  本文 `{type:"cc-observer",device,sentAt,lines}` は アプリ送信(T3)・relay 判定(T1) で一致。
```
