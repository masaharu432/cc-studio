# cc-studio タスク完了通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code の Stop/Notification フックを信号源に、AI 応答完了/許可待ちを cc-studio スマホアプリへ「見ていないスクリーンの結果のときだけ」ネイティブ通知し、タップでそのスクリーンを開く。

**Architecture:** フック → `127.0.0.1` の **notify-relay**（code-server 非依存の単体 Node プロセス）に POST → relay が接続中の WebSocket クライアントへブロードキャスト → Android の `KeepAliveService`（フォアグラウンドサービス＝裏でも生存）が `wss://<host>/cc-notify/ws`（tailscale serve パス割当・tailnet ゲート）を受信 → cwd でスクリーン突合・前面判定で出し分け → `cc_task` チャンネルで通知 → タップで該当スクリーンへ。

**Tech Stack:** notify-relay (Node 標準ライブラリのみ・外部 npm 依存なし, `node:test`), Android (Kotlin, OkHttp WebSocket, JUnit JVM テスト), bash フック + curl, tailscale serve。

設計書: [docs/specs/2026-06-29-cc-studio-task-notification-design.md](../specs/2026-06-29-cc-studio-task-notification-design.md)

## Global Constraints

- **`server/code-server`（upstream サブモジュール）は編集しない**。サーバ機能は `server/notify-relay/` の独立プロセスとして実装する。
- セキュリティは **tailnet 前提**（インターネット非公開）。WS は tailnet ゲートのみ、POST は 127.0.0.1 バインド。トークン等のアプリ層認証は設けない。
- フックはチェーンを壊さない: 失敗しても終了コード 0（`|| true`）。
- relay のポート既定は **8770**（env `CC_NOTIFY_RELAY_PORT` で上書き）。
- relay は **外部 npm 依存を持たない**（`http` + `crypto` のみ、WS は最小自前実装）。
- 通知チャンネルは既存 keepalive(`cc_web_keepalive`, LOW/無音)と分離した新規 `cc_task`（IMPORTANCE_DEFAULT）。
- 出し分け: アプリ前面 かつ アクティブスクリーンの folder が event.cwd と一致するときだけ抑制。背面・未一致・該当なしは通知。
- 個人ホスト名/URL はコミットしない（既存方針: `BuildConfig.TARGET_URL`）。

---

## File Structure

**Server (notify-relay, サブモジュール外)**
- Create: `server/notify-relay/relay.mjs` — 正規化・WS 登録簿・ブロードキャスト・http(POST) + WS(自前ハンドシェイク)。
- Create: `server/notify-relay/relay.test.mjs` — `node:test` による正規化ユニット + 実 WS 往復の統合テスト。
- Modify: `server/provision/start-vsserver.sh`（または新規起動スクリプト）— relay 起動 + `tailscale serve` パス割当。

**Hook 設定**
- Modify: `.claude/settings.json` — Stop/Notification の command を curl POST（127.0.0.1 の relay）に差し替え。

**Android (Kotlin)**
- Create: `app/src/main/java/app/ccstudio/NotifyDecision.kt` — folder 突合と出し分けの純ロジック。
- Create: `app/src/main/java/app/ccstudio/NotifyState.kt` — 前面フラグ/アクティブ folder を保持する singleton。
- Create: `app/src/test/java/app/ccstudio/NotifyDecisionTest.kt` — 純ロジックの JVM テスト。
- Modify: `app/src/main/java/app/ccstudio/ScreenManager.kt` — `onActiveChanged` コールバック追加。
- Modify: `app/src/main/java/app/ccstudio/KeepAliveService.kt` — OkHttp WS クライアント + `cc_task` チャンネル + 通知発火。
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt` — 前面/アクティブ更新の配線、通知タップ Intent 処理（folder 突合 select / 新規作成）。
- Modify: `app/build.gradle` — OkHttp 依存追加。
- Modify: `app/src/main/res/values/strings.xml` — `cc_task` チャンネル名/通知文言。

---

## Task 1: notify-relay 単体サービス（code-server 非依存）

`server/notify-relay/relay.mjs` を新規作成。Node 標準ライブラリのみ（`http` + `crypto`、外部 npm 依存なし）で、hook の POST を受けて接続中の WebSocket クライアントへブロードキャストする。WS はハンドシェイクと送信フレームを最小自前実装（サーバ→クライアント送信のみ）。**`server/code-server` サブモジュールは一切編集しない。**

**Files:**
- Create: `server/notify-relay/relay.mjs`
- Test: `server/notify-relay/relay.test.mjs`

**Interfaces:**
- Produces（テスト用に export）:
  - `normalizeEvent(raw: unknown): object` — `{event:"cc-notify", kind, project, branch:"", cwd, sessionId, message, ts}`。`kind` は `hook_event_name||"Stop"`、`project` は cwd の basename。
  - `encodeTextFrame(text: string): Buffer` — WS テキストフレーム（unmasked）。
  - `broadcast(event: object): number` — 接続中クライアントへ送信、送信数を返す。
  - `createServer(): http.Server` — POST と Upgrade(WS) を扱う http サーバ。
- 動作: 直接実行時のみ `127.0.0.1:${CC_NOTIFY_RELAY_PORT:-8770}` で listen。

- [ ] **Step 1: 失敗するテストを書く**

`server/notify-relay/relay.test.mjs`:

```js
import test from "node:test"
import assert from "node:assert"
import net from "node:net"
import crypto from "node:crypto"
import { normalizeEvent, encodeTextFrame, createServer } from "./relay.mjs"

test("normalizeEvent maps fields and derives project", () => {
  const ev = normalizeEvent({ hook_event_name: "Stop", cwd: "/a/proj", session_id: "s1" })
  assert.equal(ev.event, "cc-notify")
  assert.equal(ev.kind, "Stop")
  assert.equal(ev.project, "proj")
  assert.equal(ev.cwd, "/a/proj")
  assert.equal(ev.sessionId, "s1")
})

test("normalizeEvent tolerates junk", () => {
  assert.equal(normalizeEvent(null).kind, "Stop")
  assert.equal(normalizeEvent("x").cwd, "")
  assert.equal(normalizeEvent({}).project, "")
})

test("encodeTextFrame short payload", () => {
  const f = encodeTextFrame("hi")
  assert.equal(f[0], 0x81)
  assert.equal(f[1], 2)
  assert.equal(f.subarray(2).toString(), "hi")
})

test("POST broadcasts to a connected ws client", async () => {
  const server = createServer()
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  const key = crypto.randomBytes(16).toString("base64")
  const sock = net.connect(port, "127.0.0.1")
  const msg = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    let upgraded = false
    sock.on("error", reject)
    sock.on("connect", () => {
      sock.write(
        `GET /cc-notify/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    })
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d])
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n")
        if (idx === -1) return
        upgraded = true
        buf = buf.subarray(idx + 4)
        // client is registered now (server added it before sending 101) -> fire the POST
        fetch(`http://127.0.0.1:${port}/cc-notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hook_event_name: "Stop", cwd: "/a/proj", session_id: "s1" }),
        }).then((res) => res.json()).then((j) => assert.equal(j.delivered, 1)).catch(reject)
      }
      if (upgraded && buf.length >= 2) {
        const len = buf[1] & 0x7f
        if (buf.length >= 2 + len) {
          resolve(JSON.parse(buf.subarray(2, 2 + len).toString("utf8")))
        }
      }
    })
  })
  sock.destroy()
  await new Promise((r) => server.close(r))
  assert.equal(msg.event, "cc-notify")
  assert.equal(msg.project, "proj")
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server/notify-relay && node --test relay.test.mjs`
Expected: FAIL（`Cannot find module ./relay.mjs`）

- [ ] **Step 3: relay.mjs を実装**

`server/notify-relay/relay.mjs`:

```js
import http from "node:http"
import crypto from "node:crypto"

const PORT = parseInt(process.env.CC_NOTIFY_RELAY_PORT || "8770", 10)
const HOST = "127.0.0.1"
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const asString = (v) => (typeof v === "string" ? v : "")

export function normalizeEvent(raw) {
  const o = raw && typeof raw === "object" ? raw : {}
  const cwd = asString(o.cwd)
  return {
    event: "cc-notify",
    kind: asString(o.hook_event_name) || "Stop",
    project: cwd ? cwd.replace(/\/+$/, "").split("/").pop() || "" : "",
    branch: "",
    cwd,
    sessionId: asString(o.session_id),
    message: asString(o.message),
    ts: Math.floor(Date.now() / 1000),
  }
}

/** WS テキストフレーム（unmasked, FIN+text）。 */
export function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8")
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

const clients = new Set()

export function broadcast(event) {
  const frame = encodeTextFrame(JSON.stringify(event))
  let sent = 0
  for (const sock of clients) {
    try {
      sock.write(frame)
      sent++
    } catch {
      clients.delete(sock)
      try { sock.destroy() } catch {}
    }
  }
  return sent
}

function handleUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"]
  if (!key) { socket.destroy(); return }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64")
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  clients.add(socket)
  const drop = () => clients.delete(socket)
  socket.on("close", drop)
  socket.on("error", drop)
  socket.on("end", drop)
  socket.on("data", (buf) => {
    // クライアントからの close フレーム（opcode 0x8）だけ処理。他の受信は無視。
    if (buf.length >= 1 && (buf[0] & 0x0f) === 0x8) { drop(); try { socket.end() } catch {} }
  })
}

export function createServer() {
  const server = http.createServer((req, res) => {
    // tailscale serve のパス挙動に依存しないよう POST は method だけで判定（tailnet 前提）。
    if (req.method === "POST") {
      let body = ""
      req.on("data", (c) => {
        body += c
        if (body.length > 1_000_000) req.destroy()
      })
      req.on("end", () => {
        let parsed
        try { parsed = body ? JSON.parse(body) : {} } catch { parsed = {} }
        const delivered = broadcast(normalizeEvent(parsed))
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ delivered }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  // 全 Upgrade を WS 購読として受ける（パスのプレフィックス有無に依存しない）。
  server.on("upgrade", (req, socket) => handleUpgrade(req, socket))
  return server
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  createServer().listen(PORT, HOST, () => {
    console.log(`notify-relay on ${HOST}:${PORT}`)
  })
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server/notify-relay && node --test relay.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 5: コミット**

```bash
git add server/notify-relay/relay.mjs server/notify-relay/relay.test.mjs
git commit -m "feat(relay): standalone notify-relay (POST -> websocket broadcast, no deps)"
```

---

## Task 2: provision — relay 起動 + tailscale serve 公開

`start-vsserver.sh` に relay の起動を追加し、`tailscale serve` で `/cc-notify` を relay へ割り当てる。検証はホスト上の手動確認。

**Files:**
- Modify: `server/provision/start-vsserver.sh`

**Interfaces:**
- Consumes: Task 1 の `server/notify-relay/relay.mjs`。
- Produces: code-server 起動時に relay も 127.0.0.1:8770 で常駐し、`wss://<host>/cc-notify/ws` が tailnet から届く。

- [ ] **Step 1: relay 起動ブロックを追加**

`start-vsserver.sh` の変数定義（`LOG=...` の後）に追加:

```bash
RELAY_PORT="${CC_NOTIFY_RELAY_PORT:-8770}"
RELAY_JS="$HERE/../notify-relay/relay.mjs"
RELAY_LOG="$HOME/.local/share/code-server/notify-relay.log"
```

code-server 起動成功を表示する箇所（末尾の `echo "code-server UP ..."` 付近の後）に追加:

```bash
# notify-relay（未起動なら起動）
if ! ss -tln 2>/dev/null | grep -q "127.0.0.1:${RELAY_PORT} "; then
  if command -v node >/dev/null 2>&1 && [[ -f "$RELAY_JS" ]]; then
    setsid env -i HOME="$HOME" PATH="$PREFIX/bin:/usr/local/bin:/usr/bin:/bin" \
      CC_NOTIFY_RELAY_PORT="$RELAY_PORT" node "$RELAY_JS" >"$RELAY_LOG" 2>&1 &
    echo "notify-relay starting on 127.0.0.1:${RELAY_PORT}  (log: ${RELAY_LOG})"
  else
    echo "notify-relay skipped (node not found or relay.mjs missing)" >&2
  fi
else
  echo "notify-relay already on 127.0.0.1:${RELAY_PORT}"
fi
```

- [ ] **Step 2: 構文チェック**

Run: `bash -n server/provision/start-vsserver.sh`
Expected: エラーなし（終了コード 0）

- [ ] **Step 3: tailscale serve のパス割当（手動・ドキュメント）**

ホストで次を実行して relay を tailnet に公開する（一度設定すれば永続）:

```bash
tailscale serve --bg --set-path /cc-notify "http://127.0.0.1:${CC_NOTIFY_RELAY_PORT:-8770}"
tailscale serve status
```

注: relay は POST を method だけで判定し Upgrade を全パスで受けるため、tailscale serve がプレフィックスを剥がしても剥がさなくても動く。

- [ ] **Step 4: 起動の手動確認**

Run（ホスト）:
```bash
bash server/provision/start-vsserver.sh
ss -tln | grep 8770
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"hook_event_name":"Stop","cwd":"/x/proj"}' http://127.0.0.1:8770/cc-notify
```
Expected: `{"delivered":0}`（WS 未接続時）。relay 配管 OK。

- [ ] **Step 5: コミット**

```bash
git add server/provision/start-vsserver.sh
git commit -m "feat(provision): start notify-relay alongside code-server"
```

---

## Task 3: フック設定の差し替え（curl POST）

Stop/Notification フックを `cc-config notify` から、127.0.0.1 の relay に hook JSON を POST する curl ワンライナーへ差し替える（トークン/エンドポイントファイル不要）。

**Files:**
- Modify: `.claude/settings.json`

**Interfaces:**
- Consumes: Task 1/2 の relay（`http://127.0.0.1:${CC_NOTIFY_RELAY_PORT:-8770}/cc-notify`）。
- Produces: Stop/Notification 時に hook JSON(stdin) を relay へ POST。

- [ ] **Step 1: settings.json を書き換える**

`.claude/settings.json` を以下に置換:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 3 -X POST -H 'Content-Type: application/json' --data-binary @- \"http://127.0.0.1:${CC_NOTIFY_RELAY_PORT:-8770}/cc-notify\" >/dev/null 2>&1 || true",
            "timeout": 5
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 3 -X POST -H 'Content-Type: application/json' --data-binary @- \"http://127.0.0.1:${CC_NOTIFY_RELAY_PORT:-8770}/cc-notify\" >/dev/null 2>&1 || true",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: JSON 妥当性を確認**

Run: `python3 -c "import json; json.load(open('.claude/settings.json')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: エンドツーエンドで手動確認**

前提: relay 起動済み（Task 2）。

Run:
```bash
echo '{"hook_event_name":"Stop","cwd":"/x/proj","session_id":"manual"}' \
  | curl -s -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:8770/cc-notify"
```
Expected: `{"delivered":N}`（接続中 WS が無ければ N=0）。

- [ ] **Step 4: コミット**

```bash
git add .claude/settings.json
git commit -m "feat(hook): post Stop/Notification to local notify-relay"
```

---

## Task 4: 出し分けの純ロジック（NotifyDecision）

folder 突合と「通知すべきか」を副作用なしの関数にして JVM テストする。

**Files:**
- Create: `app/src/main/java/app/ccstudio/NotifyDecision.kt`
- Test: `app/src/test/java/app/ccstudio/NotifyDecisionTest.kt`

**Interfaces:**
- Produces:
  - `NotifyDecision.matches(folder: String?, cwd: String?): Boolean` — folder==cwd もしくは cwd が folder 配下なら true。
  - `NotifyDecision.shouldNotify(foreground: Boolean, activeFolder: String?, eventCwd: String?): Boolean` — 前面かつ matches のときだけ false、それ以外 true。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/test/java/app/ccstudio/NotifyDecisionTest.kt`:

```kotlin
package app.ccstudio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotifyDecisionTest {
    @Test fun matchesExactAndSubdir() {
        assertTrue(NotifyDecision.matches("/a/proj", "/a/proj"))
        assertTrue(NotifyDecision.matches("/a/proj", "/a/proj/sub/dir"))
        assertFalse(NotifyDecision.matches("/a/proj", "/a/project")) // prefix だが境界違い
        assertFalse(NotifyDecision.matches(null, "/a/proj"))
        assertFalse(NotifyDecision.matches("/a/proj", null))
    }

    @Test fun suppressOnlyWhenForegroundAndActiveMatches() {
        assertFalse(NotifyDecision.shouldNotify(true, "/a/proj", "/a/proj"))      // 見てる画面 → 抑制
        assertTrue(NotifyDecision.shouldNotify(false, "/a/proj", "/a/proj"))      // 背面 → 通知
        assertTrue(NotifyDecision.shouldNotify(true, "/a/other", "/a/proj"))      // 別画面 → 通知
        assertTrue(NotifyDecision.shouldNotify(true, null, "/a/proj"))            // 該当なし → 通知
    }
}
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.NotifyDecisionTest"`
Expected: FAIL（`NotifyDecision` 未定義でコンパイルエラー）

- [ ] **Step 3: 最小実装を書く**

`app/src/main/java/app/ccstudio/NotifyDecision.kt`:

```kotlin
package app.ccstudio

/** 通知の出し分け（副作用なし・JVM テスト可能）。 */
object NotifyDecision {
    /** cwd が folder と一致、または folder 配下なら true。 */
    fun matches(folder: String?, cwd: String?): Boolean {
        if (folder.isNullOrEmpty() || cwd.isNullOrEmpty()) return false
        val f = folder.trimEnd('/')
        val c = cwd.trimEnd('/')
        return c == f || c.startsWith("$f/")
    }

    /** 前面で見ているスクリーンそのものの結果だけ抑制。それ以外は通知する。 */
    fun shouldNotify(foreground: Boolean, activeFolder: String?, eventCwd: String?): Boolean {
        if (foreground && matches(activeFolder, eventCwd)) return false
        return true
    }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.NotifyDecisionTest"`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/src/main/java/app/ccstudio/NotifyDecision.kt app/src/test/java/app/ccstudio/NotifyDecisionTest.kt
git commit -m "feat(app): NotifyDecision pure logic for per-screen notification gating"
```

---

## Task 5: 共有状態（NotifyState）＋ アクティブ/前面の配線

サービスが参照する「前面か」「アクティブスクリーンの folder」を保持する singleton を作り、`MainActivity` と `ScreenManager` から更新する。

**Files:**
- Create: `app/src/main/java/app/ccstudio/NotifyState.kt`
- Modify: `app/src/main/java/app/ccstudio/ScreenManager.kt:10-12, 36-42, 44-58`
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt:73-113`（onCreate）, 新規 onResume/onPause

**Interfaces:**
- Produces:
  - `object NotifyState { @Volatile var foreground: Boolean; @Volatile var activeFolder: String? }`
  - `ScreenManager.onActiveChanged: ((Screen?) -> Unit)?`（select/close でアクティブが変わるたび呼ばれる）
- Consumes: `ScreenUrl.folderPath`（アクティブ folder 算出）。

- [ ] **Step 1: NotifyState を作成**

`app/src/main/java/app/ccstudio/NotifyState.kt`:

```kotlin
package app.ccstudio

/** KeepAliveService（別プロセス文脈）から参照する軽量な共有状態。MainActivity が更新する。 */
object NotifyState {
    @Volatile var foreground: Boolean = false
    @Volatile var activeFolder: String? = null
}
```

- [ ] **Step 2: ScreenManager に onActiveChanged を追加**

`ScreenManager.kt` のフィールド宣言（`private var idSeq` 付近）に追加:

```kotlin
    /** アクティブスクリーンが変わるたびに呼ばれる（NotifyState 更新用）。 */
    var onActiveChanged: ((Screen?) -> Unit)? = null
```

`select(id)` の末尾（`target.webView.requestFocus()` の後）に追加:

```kotlin
        onActiveChanged?.invoke(target)
```

`close(id)` 内、アクティブを切り替える分岐を更新（`if (wasActive) { ... }` ブロック）:

```kotlin
        if (wasActive) {
            val next = screens.getOrNull(idx) ?: screens.lastOrNull()
            if (next != null) select(next.id) else { activeId = -1; onActiveChanged?.invoke(null) }
        }
```

- [ ] **Step 3: MainActivity で配線**

`MainActivity.onCreate` の `screens = ScreenManager(root)`（85 行目付近）の直後に追加:

```kotlin
        screens.onActiveChanged = { s ->
            NotifyState.activeFolder =
                if (s != null && s.kind == ScreenKind.WEB) ScreenUrl.folderPath(s.url) else null
        }
```

`MainActivity` に前面状態のライフサイクルを追加（クラス内の任意の場所、例: onCreate の後）:

```kotlin
    override fun onResume() {
        super.onResume()
        NotifyState.foreground = true
        NotifyState.activeFolder = screens.activeOrNull()
            ?.takeIf { it.kind == ScreenKind.WEB }
            ?.let { ScreenUrl.folderPath(it.url) }
    }

    override fun onPause() {
        super.onPause()
        NotifyState.foreground = false
    }
```

- [ ] **Step 4: ビルドが通ることを確認**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL（コンパイルエラー無し）

- [ ] **Step 5: コミット**

```bash
git add app/src/main/java/app/ccstudio/NotifyState.kt app/src/main/java/app/ccstudio/ScreenManager.kt app/src/main/java/app/ccstudio/MainActivity.kt
git commit -m "feat(app): track foreground + active screen folder in NotifyState"
```

---

## Task 6: KeepAliveService に WS 受信 + cc_task 通知

OkHttp WebSocket で `/cc-notify/ws` に接続（保存済み cookie 流用）、受信イベントを `NotifyDecision` で判定し `cc_task` チャンネルに通知する。

**Files:**
- Modify: `app/build.gradle`（OkHttp 追加）
- Modify: `app/src/main/res/values/strings.xml`（文言追加）
- Modify: `app/src/main/java/app/ccstudio/KeepAliveService.kt`

**Interfaces:**
- Consumes: `NotifyDecision.shouldNotify`、`NotifyState.foreground`/`activeFolder`、`BuildConfig.TARGET_URL`。
- Produces: 受信時に `cc_task` チャンネルで通知（タップ Intent は Task 7 で詳細化、本タスクでは本文表示まで）。

- [ ] **Step 1: OkHttp 依存を追加**

`app/build.gradle` の `dependencies { ... }` に追加:

```gradle
    implementation 'com.squareup.okhttp3:okhttp:4.12.0'
```

- [ ] **Step 2: 文言を追加**

`app/src/main/res/values/strings.xml` の `<resources>` 内に追加:

```xml
    <string name="task_channel_name">タスク通知</string>
    <string name="task_done_title">✅ 応答が完了しました</string>
    <string name="task_permission_title">🔔 許可待ち</string>
```

- [ ] **Step 3: KeepAliveService に WS クライアントと通知を実装**

`KeepAliveService.kt` を以下に置換:

```kotlin
package app.ccstudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class KeepAliveService : Service() {

    private val client = OkHttpClient()
    private var ws: WebSocket? = null
    @Volatile private var stopped = false
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var backoffMs = 2000L

    override fun onCreate() {
        super.onCreate()
        createChannels()
        startForeground(NOTIFICATION_ID, buildKeepAliveNotification())
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopped = true
        try { ws?.close(1000, null) } catch (_: Exception) {}
        super.onDestroy()
    }

    // ── WebSocket ───────────────────────────────────────────────────────

    /** TARGET_URL（https://host[:port]/…）から wss://host[:port]/cc-notify/ws を作る。 */
    private fun wsUrl(): String? {
        val base = BuildConfig.TARGET_URL.ifEmpty { return null }
        val schemeEnd = base.indexOf("://")
        if (schemeEnd < 0) return null
        val scheme = base.substring(0, schemeEnd)
        val host = base.substring(schemeEnd + 3).substringBefore('/')
        val wsScheme = if (scheme == "https") "wss" else "ws"
        return "$wsScheme://$host/cc-notify/ws"
    }

    private fun connect() {
        if (stopped) return
        val url = wsUrl() ?: return
        // tailnet ゲートのみ（[[cc-studio-tailnet-only]]）。cookie/トークン不要。
        val request = Request.Builder().url(url).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                backoffMs = 2000L
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                handleEvent(text)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scheduleReconnect()
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (stopped) return
        handler.postDelayed({ connect() }, backoffMs)
        backoffMs = (backoffMs * 2).coerceAtMost(60000L)
    }

    // ── イベント処理 ─────────────────────────────────────────────────────

    private fun handleEvent(text: String) {
        val json = try { JSONObject(text) } catch (e: Exception) {
            Log.w("CcStudio", "bad cc-notify payload", e); return
        }
        if (json.optString("event") != "cc-notify") return
        val cwd = json.optString("cwd")
        if (!NotifyDecision.shouldNotify(NotifyState.foreground, NotifyState.activeFolder, cwd)) return

        val kind = json.optString("kind", "Stop")
        val project = json.optString("project")
        val message = json.optString("message")
        val title = if (kind == "Notification")
            "${getString(R.string.task_permission_title)} — $project"
        else
            "${getString(R.string.task_done_title)} — $project"
        val body = if (message.isNotEmpty()) message else project

        notifyTask(title, body, cwd)
    }

    private fun notifyTask(title: String, body: String, cwd: String) {
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(EXTRA_OPEN_CWD, cwd)
        }
        val pi = PendingIntent.getActivity(
            this, cwd.hashCode(), tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(this, TASK_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(R.drawable.ic_keepalive)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        // セッション単位で更新（積み上げない）: cwd で通知 ID を固定
        ContextCompat.getSystemService(this, NotificationManager::class.java)
            ?.notify(cwd.hashCode(), n)
    }

    // ── 常駐通知 / チャンネル ────────────────────────────────────────────

    private fun createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID, getString(R.string.keepalive_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                )
            )
            mgr.createNotificationChannel(
                NotificationChannel(
                    TASK_CHANNEL_ID, getString(R.string.task_channel_name),
                    NotificationManager.IMPORTANCE_DEFAULT
                )
            )
        }
    }

    private fun buildKeepAliveNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.keepalive_notification_title))
            .setContentText(getString(R.string.keepalive_notification_text))
            .setSmallIcon(R.drawable.ic_keepalive)
            .setColor(ContextCompat.getColor(this, R.color.keepalive_accent))
            .setColorized(true)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    companion object {
        const val CHANNEL_ID = "cc_web_keepalive"
        const val TASK_CHANNEL_ID = "cc_task"
        const val NOTIFICATION_ID = 1
        const val EXTRA_OPEN_CWD = "app.ccstudio.OPEN_CWD"
    }
}
```

- [ ] **Step 4: ビルドが通ることを確認**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 5: 実機/エミュレータで疎通確認（手動）**

1. アプリを起動して一度 WebView でログイン（cookie 取得）。
2. サーバ側で Task 3 Step 2 の curl を実行（`session_id`/`cwd` は今開いていない workspace を指定）。
3. Expected: `cc_task` チャンネルでバナー通知が出る。アプリを前面にして今見ているスクリーンと同じ cwd で再度 curl → 通知が出ないこと（抑制）。

- [ ] **Step 6: コミット**

```bash
git add app/build.gradle app/src/main/res/values/strings.xml app/src/main/java/app/ccstudio/KeepAliveService.kt
git commit -m "feat(app): receive cc-notify over websocket and post cc_task notifications"
```

---

## Task 7: 通知タップで該当スクリーンを開く

通知タップ → `MainActivity.onNewIntent` で extra の cwd を受け、folder 突合で既存スクリーンを `select`、無ければ `?folder=cwd` で新規 WEB スクリーンを作成して開く。

**Files:**
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`（onNewIntent 追加、folder 突合ヘルパー、新規作成）
- Test: `app/src/test/java/app/ccstudio/NotifyDecisionTest.kt`（突合は `NotifyDecision.matches` を再利用するため追加テストのみ）

**Interfaces:**
- Consumes: `KeepAliveService.EXTRA_OPEN_CWD`、`NotifyDecision.matches`、`ScreenUrl.folderPath`、`ScreenManager.{webScreens,select,add}`、`createWebScreen`。
- Produces: cwd → スクリーンを開く副作用（戻り値なし）。

- [ ] **Step 1: 突合の追加テストを書く（既存テストに 1 ケース追記）**

`NotifyDecisionTest.kt` に追記:

```kotlin
    @Test fun matchesPicksScreenByFolder() {
        // 「該当スクリーン選択」は matches を folder 一覧に適用する想定。
        val folders = listOf("/a/one", "/a/two")
        val hit = folders.firstOrNull { NotifyDecision.matches(it, "/a/two/src") }
        assertTrue(hit == "/a/two")
    }
```

- [ ] **Step 2: テストが失敗しないこと（matches は既存）を確認 → 仕様の固定**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.NotifyDecisionTest"`
Expected: PASS（突合仕様が固定される）

- [ ] **Step 3: MainActivity に onNewIntent と open ロジックを実装**

`MainActivity` に追加（`createWebScreen` が見える同クラス内）:

```kotlin
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(KeepAliveService.EXTRA_OPEN_CWD)?.let { openScreenForCwd(it) }
    }

    /** 通知タップ用: cwd に対応する WEB スクリーンへ。無ければ新規作成して開く。 */
    private fun openScreenForCwd(cwd: String) {
        if (cwd.isEmpty()) return
        val hit = screens.webScreens().firstOrNull {
            NotifyDecision.matches(ScreenUrl.folderPath(it.url), cwd)
        }
        if (hit != null) {
            screens.select(hit.id)
            return
        }
        // ベース origin + ?folder=cwd で新規スクリーン
        val origin = TARGET_URL.substringBefore("/?").substringBefore("/", )
        val schemeEnd = TARGET_URL.indexOf("://")
        if (schemeEnd < 0) return
        val host = TARGET_URL.substring(schemeEnd + 3).substringBefore('/')
        val base = TARGET_URL.substring(0, schemeEnd) + "://" + host
        val url = "$base/?folder=" + java.net.URLEncoder.encode(cwd, "UTF-8")
        val s = createWebScreen(url, reloadOnFirstLoad = true)
        screens.add(s); screens.select(s.id)
    }
```

注: 上記 `origin`/`schemeEnd`/`host`/`base` のうち実際に使うのは `base` のみ。未使用変数（`origin`）が lint/コンパイルで弾かれるため削除し、`base` 算出だけ残すこと:

```kotlin
        val schemeEnd = TARGET_URL.indexOf("://")
        if (schemeEnd < 0) return
        val host = TARGET_URL.substring(schemeEnd + 3).substringBefore('/')
        val base = TARGET_URL.substring(0, schemeEnd) + "://" + host
        val url = "$base/?folder=" + java.net.URLEncoder.encode(cwd, "UTF-8")
```

`onCreate` 末尾に、起動時 Intent（アプリが落ちていた状態でタップ）にも対応する 1 行を追加:

```kotlin
        intent.getStringExtra(KeepAliveService.EXTRA_OPEN_CWD)?.let { openScreenForCwd(it) }
```

- [ ] **Step 4: ビルドが通ることを確認**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 5: 実機で手動確認**

1. 今開いていない workspace の cwd で curl（Task 3 Step 2）→ 通知が出る。
2. 通知タップ → アプリ前面化し、その folder のスクリーンが選択される（無ければ新規に開く）。
3. 既に開いている folder の通知タップ → そのスクリーンへ切替（新規を作らない）。

- [ ] **Step 6: コミット**

```bash
git add app/src/main/java/app/ccstudio/MainActivity.kt app/src/test/java/app/ccstudio/NotifyDecisionTest.kt
git commit -m "feat(app): open the screen for a tapped task notification (select or create)"
```

---

## Task 8: 通知設定の保存 + ブリッジ + KeepAliveService 反映

種類別（Stop / Notification）の ON/OFF を `SharedPreferences` に保存し、ブリッジ経由で JS から読み書きできるようにし、KeepAliveService が無効な種類の通知を出さないようにする。

**Files:**
- Create: `app/src/main/java/app/ccstudio/NotifyPrefs.kt`
- Test: `app/src/test/java/app/ccstudio/NotifyPrefsTest.kt`
- Modify: `app/src/main/java/app/ccstudio/CcBridge.kt`（ブリッジ 2 メソッド + コンストラクタ引数）
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`（buildBridge の配線）
- Modify: `app/src/main/java/app/ccstudio/KeepAliveService.kt`（handleEvent で種類チェック）

**Interfaces:**
- Consumes: Task 6 の `KeepAliveService.handleEvent`、`CcBridge` コンストラクタ。
- Produces:
  - `NotifyPrefs.keyFor(kind: String): String?` — `"Stop"`→`"stop"`, `"Notification"`→`"permission"`, それ以外 null（純・テスト可）。
  - `NotifyPrefs.isEnabled(ctx: android.content.Context, kind: String): Boolean`（既定 true）。
  - `NotifyPrefs.setEnabled(ctx: android.content.Context, kind: String, enabled: Boolean)`。
  - `NotifyPrefs.toJson(ctx: android.content.Context): String` — `{"stop":true,"permission":true}`。
  - `CcBridge.getNotifyPrefs(): String` / `CcBridge.setNotifyPref(kind: String, enabled: Boolean)`。

- [ ] **Step 1: 失敗するテストを書く（純ロジック keyFor）**

`app/src/test/java/app/ccstudio/NotifyPrefsTest.kt`:

```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotifyPrefsTest {
    @Test fun mapsKindToKey() {
        assertEquals("stop", NotifyPrefs.keyFor("Stop"))
        assertEquals("permission", NotifyPrefs.keyFor("Notification"))
        assertNull(NotifyPrefs.keyFor("Other"))
    }
}
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.NotifyPrefsTest"`
Expected: FAIL（`NotifyPrefs` 未定義でコンパイルエラー）

- [ ] **Step 3: NotifyPrefs を実装**

`app/src/main/java/app/ccstudio/NotifyPrefs.kt`:

```kotlin
package app.ccstudio

import android.content.Context
import org.json.JSONObject

/** 種類別の通知 ON/OFF を SharedPreferences に保存する。既定は全 ON。 */
object NotifyPrefs {
    private const val PREFS = "cc_notify_prefs"

    /** hook の kind を prefs キーへ。未知の種類は null。 */
    fun keyFor(kind: String): String? = when (kind) {
        "Stop" -> "stop"
        "Notification" -> "permission"
        else -> null
    }

    fun isEnabled(ctx: Context, kind: String): Boolean {
        val key = keyFor(kind) ?: return true
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(key, true)
    }

    fun setEnabled(ctx: Context, kind: String, enabled: Boolean) {
        val key = keyFor(kind) ?: return
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(key, enabled).apply()
    }

    fun toJson(ctx: Context): String {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return JSONObject()
            .put("stop", p.getBoolean("stop", true))
            .put("permission", p.getBoolean("permission", true))
            .toString()
    }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.NotifyPrefsTest"`
Expected: PASS

- [ ] **Step 5: KeepAliveService.handleEvent で種類チェック**

`KeepAliveService.handleEvent` 内、`val kind = json.optString("kind", "Stop")` の直後に追加:

```kotlin
        if (!NotifyPrefs.isEnabled(this, kind)) return
```

（`shouldNotify` のスクリーン判定より前でも後でもよいが、種類チェックを先に置く。）

- [ ] **Step 6: CcBridge にメソッド追加**

`CcBridge` のコンストラクタ引数末尾に追加:

```kotlin
    private val notifyPrefsJsonFn: () -> String,
    private val onSetNotifyPref: (kind: String, enabled: Boolean) -> Unit,
```

クラス本体（Screens セクションの後）に追加:

```kotlin
    // ── 通知設定 ──
    /** 種類別 ON/OFF の現在値（{"stop":bool,"permission":bool}）。 */
    @JavascriptInterface fun getNotifyPrefs(): String = notifyPrefsJsonFn()
    /** 種類別 ON/OFF を保存する。kind は "Stop" | "Notification"。 */
    @JavascriptInterface fun setNotifyPref(kind: String, enabled: Boolean) = onSetNotifyPref(kind, enabled)
```

- [ ] **Step 7: MainActivity.buildBridge で配線**

`buildBridge()` の `CcBridge(...)` 呼び出しの末尾引数に追加:

```kotlin
        notifyPrefsJsonFn = { NotifyPrefs.toJson(this) },
        onSetNotifyPref = { kind, enabled -> NotifyPrefs.setEnabled(this, kind, enabled) },
```

- [ ] **Step 8: ビルドが通ることを確認**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 9: コミット**

```bash
git add app/src/main/java/app/ccstudio/NotifyPrefs.kt app/src/test/java/app/ccstudio/NotifyPrefsTest.kt app/src/main/java/app/ccstudio/CcBridge.kt app/src/main/java/app/ccstudio/MainActivity.kt app/src/main/java/app/ccstudio/KeepAliveService.kt
git commit -m "feat(app): per-kind notification prefs (store + bridge + honor in service)"
```

---

## Task 9: plugins.html に通知設定セクション

Plugins システムスクリーンのプラグイン一覧の下に「通知設定」セクションを追加し、種類別トグルをブリッジに接続する。

**Files:**
- Modify: `app/src/main/assets/plugins.html`

**Interfaces:**
- Consumes: Task 8 の `window.CCStudio.getNotifyPrefs()` / `window.CCStudio.setNotifyPref(kind, enabled)`、既存 `.tgl` トグルスタイル。
- Produces: UI のみ（自動テストなし、手動確認）。

- [ ] **Step 1: 通知設定セクションのマークアップを追加**

`plugins.html` のプラグイン一覧コンテナ（`.pl-body` 内）の末尾に追加:

```html
    <section class="notify-settings">
      <div class="title" style="padding:14px 2px 8px">通知設定</div>
      <div class="mod">
        <div class="mod-top">
          <div class="mod-id"><span class="mod-name">✅ 応答完了 (Stop)</span></div>
          <button class="tgl" id="tgl-stop" aria-pressed="true" onclick="window.__ccToggleNotify('Stop')"><span class="knob"></span></button>
        </div>
      </div>
      <div class="mod" style="margin-top:11px">
        <div class="mod-top">
          <div class="mod-id"><span class="mod-name">🔔 許可待ち (Notification)</span></div>
          <button class="tgl" id="tgl-permission" aria-pressed="true" onclick="window.__ccToggleNotify('Notification')"><span class="knob"></span></button>
        </div>
      </div>
    </section>
```

- [ ] **Step 2: 初期化とトグル処理の JS を追加**

`plugins.html` の `<script>` 内（プラグイン描画ロジックの近く）に追加し、初期描画時にも `window.__ccRenderNotify()` を呼ぶ:

```javascript
    function __ccReadNotifyPrefs(){
      try { return JSON.parse(window.CCStudio.getNotifyPrefs()); }
      catch(e){ return {stop:true, permission:true}; }
    }
    window.__ccRenderNotify = function(){
      var p = __ccReadNotifyPrefs();
      var s = document.getElementById('tgl-stop');
      var n = document.getElementById('tgl-permission');
      if (s) s.setAttribute('aria-pressed', String(!!p.stop));
      if (n) n.setAttribute('aria-pressed', String(!!p.permission));
    };
    window.__ccToggleNotify = function(kind){
      var id = kind === 'Stop' ? 'tgl-stop' : 'tgl-permission';
      var el = document.getElementById(id);
      var next = el.getAttribute('aria-pressed') !== 'true';
      window.CCStudio.setNotifyPref(kind, next);
      el.setAttribute('aria-pressed', String(next));
    };
```

既存の初期化（プラグイン一覧を描く箇所、例 `window.__ccRenderPlugins()` 呼び出しの近く）に `window.__ccRenderNotify();` を追加。

- [ ] **Step 3: 実機/エミュレータで手動確認**

1. 天井の三角（switcher）→ Plugins スクリーンを開く。
2. プラグイン一覧の下に「通知設定」が出て、2 トグルが現在値で表示される。
3. 「応答完了」を OFF → Stop 通知が出ないこと、「許可待ち」は出ることを curl（Task 3 Step 2 で `hook_event_name` を切替）で確認。
4. アプリ再起動後も設定が保持される（SharedPreferences）。

- [ ] **Step 4: コミット**

```bash
git add app/src/main/assets/plugins.html
git commit -m "feat(app): notification settings section (per-kind toggles) in plugins screen"
```

---

## Self-Review メモ

- **Spec coverage:** 信号=Stop/Notification フック(Task 3) / localhost POST + WS(Task 1,2) / 既存 auth + token(Task 2) / KeepAliveService 受信(Task 6) / スクリーン突合・前面抑制(Task 4,5,6) / タップで開く(Task 7) / cc_task 別チャンネル(Task 6) / セッション単位更新(Task 6, cwd ハッシュ ID)。`branch` は v1 未実装（"" 固定）として明示——spec の「将来 FCM」と同様、必要になったら拡張。
- **配信先=ネイティブ通知**: WebView ではなく KeepAliveService が受けるため背面でも動く（要件 3 充足）。
- **セキュリティ:** loopback に依存せず token もしくは cookie 認証で POST を保護（tailscale serve の localhost 終端対策）。
- **既知の前提:** WS の cookie は WebView で一度ログイン後に有効。未ログイン時は再接続ループで待機（通知機能のみ無効、本体・生存通知に影響なし）。
- **ポート:** 既定 8088。`init` が bind-addr から解決してファイルに書くため、ポート変更にも追従。
