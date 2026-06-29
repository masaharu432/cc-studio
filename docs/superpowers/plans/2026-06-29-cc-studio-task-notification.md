# cc-studio タスク完了通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code の Stop/Notification フックを信号源に、AI 応答完了/許可待ちを cc-studio スマホアプリへ「見ていないスクリーンの結果のときだけ」ネイティブ通知し、タップでそのスクリーンを開く。

**Architecture:** フック → `localhost` の code-server に POST → code-server の `/cc-notify` が接続中の WebSocket クライアントへブロードキャスト → Android の `KeepAliveService`（フォアグラウンドサービス＝裏でも生存）が `wss://…/cc-notify/ws` を受信 → cwd でスクリーン突合・前面判定で出し分け → `cc_task` チャンネルで通知 → タップで該当スクリーンへ。

**Tech Stack:** code-server (TypeScript / Express / `ws`, Jest 統合テスト), Android (Kotlin, OkHttp WebSocket, JUnit JVM テスト), bash フック + curl。

設計書: [docs/superpowers/specs/2026-06-29-cc-studio-task-notification-design.md](../specs/2026-06-29-cc-studio-task-notification-design.md)

## Global Constraints

- フックはチェーンを壊さない: 失敗しても終了コード 0（`|| true`）。
- POST `/cc-notify` の認可: **トークン一致 または code-server 認証(cookie) のどちらか**。loopback 判定には依存しない（tailscale serve が localhost 終端するため loopback だけでは外部を弾けない）。
- WS `/cc-notify/ws` は code-server 既存認証(cookie)配下。アプリは保存済み cookie（`CookieManager`）を流用し、追加パスワード入力なし。
- code-server の bind ポート既定は **8088**（`server/provision/start-vsserver.sh`: `CC_PORT:-8088`）。エンドポイント実値は起動時にファイルへ書き出してフックが読む。
- 通知チャンネルは既存 keepalive(`cc_web_keepalive`, LOW/無音)と分離した新規 `cc_task`（IMPORTANCE_DEFAULT）。
- 出し分け: アプリ前面 かつ アクティブスクリーンの folder が event.cwd と一致するときだけ抑制。背面・未一致・該当なしは通知。
- 個人ホスト名/URL はコミットしない（既存方針: `BuildConfig.TARGET_URL`）。

---

## File Structure

**Server (code-server, TypeScript)**
- Create: `server/code-server/src/node/routes/ccNotify.ts` — イベント正規化・クライアント登録簿・ブロードキャスト・トークン・エンドポイントファイル書き出し・Express ルート。
- Modify: `server/code-server/src/node/routes/index.ts` — `/cc-notify`(POST) と `/cc-notify/ws`(WS) の登録、起動時 `init(args)` 呼び出し。
- Create: `server/code-server/test/unit/node/routes/ccNotify.test.ts` — 正規化のユニット + POST→WS の統合テスト。

**Hook 設定**
- Modify: `.claude/settings.json` — Stop/Notification の command を `cc-config notify` から curl POST に差し替え。

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

## Task 1: cc-notify サーバコア（正規化・登録簿・トークン）

純粋に近いロジック（イベント正規化、WS クライアント登録簿とブロードキャスト、トークン）を Express から切り離して実装し、サーバを立てずにテストする。

**Files:**
- Create: `server/code-server/src/node/routes/ccNotify.ts`
- Test: `server/code-server/test/unit/node/routes/ccNotify.test.ts`

**Interfaces:**
- Produces:
  - `interface NotifyEvent { kind: string; project: string; branch: string; cwd: string; sessionId: string; message: string; ts: number }`
  - `normalizeEvent(raw: unknown): NotifyEvent`
  - `addClient(ws: WebSocket): void` / `removeClient(ws: WebSocket): void` / `clientCount(): number`
  - `broadcast(event: NotifyEvent): number`（送信できたクライアント数を返す）
  - `setToken(t: string | undefined): void` / `tokenMatches(headerValue: unknown): boolean`

- [ ] **Step 1: 失敗するテストを書く（正規化）**

`server/code-server/test/unit/node/routes/ccNotify.test.ts`:

```ts
import { normalizeEvent } from "../../../../src/node/routes/ccNotify"

describe("ccNotify.normalizeEvent", () => {
  it("maps hook fields and derives project from cwd", () => {
    const ev = normalizeEvent({
      hook_event_name: "Stop",
      cwd: "/mnt/win/Develop/cc-studio",
      session_id: "abc",
      message: "",
    })
    expect(ev.kind).toBe("Stop")
    expect(ev.cwd).toBe("/mnt/win/Develop/cc-studio")
    expect(ev.project).toBe("cc-studio")
    expect(ev.sessionId).toBe("abc")
    expect(typeof ev.ts).toBe("number")
  })

  it("defaults kind to Stop and tolerates junk input", () => {
    expect(normalizeEvent(null).kind).toBe("Stop")
    expect(normalizeEvent({}).project).toBe("")
    expect(normalizeEvent("nope").cwd).toBe("")
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server/code-server && npm run test:unit -- ccNotify`
Expected: FAIL（`Cannot find module .../ccNotify`）

- [ ] **Step 3: 最小実装を書く**

`server/code-server/src/node/routes/ccNotify.ts`:

```ts
import * as path from "path"
import type WebSocket from "ws"

export interface NotifyEvent {
  kind: string
  project: string
  branch: string
  cwd: string
  sessionId: string
  message: string
  ts: number
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "")

export const normalizeEvent = (raw: unknown): NotifyEvent => {
  const o: Record<string, unknown> = raw && typeof raw === "object" ? (raw as any) : {}
  const cwd = asString(o.cwd)
  return {
    kind: asString(o.hook_event_name) || "Stop",
    project: cwd ? path.basename(cwd) : "",
    branch: "", // v1 では未取得（spec の将来拡張）
    cwd,
    sessionId: asString(o.session_id),
    message: asString(o.message),
    ts: Math.floor(Date.now() / 1000),
  }
}

const clients = new Set<WebSocket>()
export const addClient = (ws: WebSocket): void => {
  clients.add(ws)
}
export const removeClient = (ws: WebSocket): void => {
  clients.delete(ws)
}
export const clientCount = (): number => clients.size

export const broadcast = (event: NotifyEvent): number => {
  const data = JSON.stringify({ event: "cc-notify", ...event })
  let sent = 0
  for (const ws of clients) {
    try {
      ws.send(data)
      sent++
    } catch {
      // 切断済みは登録簿から外す
      clients.delete(ws)
    }
  }
  return sent
}

let endpointToken: string | undefined
export const setToken = (t: string | undefined): void => {
  endpointToken = t
}
export const tokenMatches = (headerValue: unknown): boolean =>
  !!endpointToken && typeof headerValue === "string" && headerValue === endpointToken
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server/code-server && npm run test:unit -- ccNotify`
Expected: PASS（2 tests）

- [ ] **Step 5: コミット**

```bash
git add server/code-server/src/node/routes/ccNotify.ts server/code-server/test/unit/node/routes/ccNotify.test.ts
git commit -m "feat(server): cc-notify core (normalize/registry/broadcast/token)"
```

---

## Task 2: cc-notify Express ルート + 登録 + 起動時初期化

POST と WS のルートを実装し `index.ts` に配線。統合テストハーネス（`test/utils/integration`）で「POST した内容が接続中 WS に届く」「未認証 POST は 403」を検証する。

**Files:**
- Modify: `server/code-server/src/node/routes/ccNotify.ts`（ルート/`init` 追加）
- Modify: `server/code-server/src/node/routes/index.ts:135-136`（json ミドルウェア直後に POST 登録）, `:155`（health ws 直後に WS 登録）, `:31-53`（`init(args)` 呼び出し）
- Test: `server/code-server/test/unit/node/routes/ccNotify.test.ts`（統合テスト追記）

**Interfaces:**
- Consumes: Task 1 の `normalizeEvent` / `addClient` / `removeClient` / `broadcast` / `tokenMatches` / `setToken`、`../http` の `authenticated`、`../wsRouter` の `wss` と `Router as WsRouter`、`../util` の `paths`。
- Produces:
  - `router: express.Router`（`POST /` → 認可後にブロードキャスト、`{ delivered: number }` を返す）
  - `wsRouter: WebsocketRouter`（`GET /` → 認証後に WS 登録）
  - `init(args: DefaultedArgs): Promise<void>`（トークン生成 + `~/.cc-studio/notify-endpoint` 2行ファイル書き出し）

- [ ] **Step 1: 失敗するテストを書く（統合）**

`ccNotify.test.ts` に追記（ファイル先頭の import に `httpserver`/`integration` を追加）:

```ts
import * as httpserver from "../../../utils/httpserver"
import * as integration from "../../../utils/integration"

describe("ccNotify routes", () => {
  let codeServer: httpserver.HttpServer | undefined
  afterEach(async () => {
    if (codeServer) {
      await codeServer.dispose()
      codeServer = undefined
    }
  })

  it("POST broadcasts to a connected websocket client", async () => {
    codeServer = await integration.setup(["--auth=none"], "")
    const ws = codeServer.ws("/cc-notify")
    const got = new Promise((resolve, reject) => {
      ws.on("error", reject)
      ws.on("message", (m) => resolve(JSON.parse(m.toString())))
    })
    await new Promise((r) => ws.on("open", r))
    const resp = await codeServer.fetch("/cc-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop", cwd: "/x/proj", session_id: "s1" }),
    })
    expect(resp.status).toBe(200)
    expect(await resp.json()).toStrictEqual({ delivered: 1 })
    const msg: any = await got
    ws.terminate()
    expect(msg.event).toBe("cc-notify")
    expect(msg.project).toBe("proj")
    expect(msg.sessionId).toBe("s1")
  })

  it("POST is rejected without auth or token", async () => {
    codeServer = await integration.setup(["--auth=password"], "")
    const resp = await codeServer.fetch("/cc-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop", cwd: "/x/proj" }),
    })
    expect(resp.status).toBe(403)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server/code-server && npm run test:unit -- ccNotify`
Expected: FAIL（`/cc-notify` ルート未登録のため 404 / 接続不可）

- [ ] **Step 3: ルートと init を実装**

`ccNotify.ts` 末尾に追記:

```ts
import { promises as fsp } from "fs"
import * as os from "os"
import * as crypto from "crypto"
import { Router } from "express"
import { HttpCode, HttpError } from "../../common/http"
import { authenticated } from "../http"
import { paths } from "../util"
import { wss, Router as WsRouter } from "../wsRouter"
import type { WebsocketRequest } from "../wsRouter"
import type { DefaultedArgs } from "../cli"

export const router = Router()

router.post("/", async (req, res) => {
  const ok = tokenMatches(req.headers["x-cc-notify-token"]) || (await authenticated(req))
  if (!ok) {
    throw new HttpError("Unauthorized", HttpCode.Unauthorized)
  }
  const event = normalizeEvent(req.body)
  const delivered = broadcast(event)
  res.json({ delivered })
})

export const wsRouter = WsRouter()

wsRouter.ws("/", async (req: WebsocketRequest) => {
  if (!(await authenticated(req))) {
    req.ws.destroy()
    return
  }
  wss.handleUpgrade(req, req.ws, req.head, (ws) => {
    addClient(ws)
    ws.on("close", () => removeClient(ws))
    ws.on("error", () => removeClient(ws))
    req.ws.resume()
  })
})

const parsePort = (bindAddr: string | undefined): number => {
  const m = (bindAddr || "").match(/:(\d+)\s*$/)
  return m ? parseInt(m[1], 10) : 8088
}

export const init = async (args: DefaultedArgs): Promise<void> => {
  const token = crypto.randomBytes(24).toString("hex")
  setToken(token)
  const port = parsePort(args["bind-addr"])
  const url = `http://localhost:${port}/cc-notify`
  const dir = path.join(os.homedir(), ".cc-studio")
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, "notify-endpoint"), `${url}\n${token}\n`, { mode: 0o600 })
}
```

注: `HttpCode`/`HttpError` は `../../common/http`、`paths` は今回未使用なら import から外してよい（lint が未使用を弾くため、使わない import は削除すること）。

- [ ] **Step 4: index.ts に配線**

`server/code-server/src/node/routes/index.ts` の import 群に追加（`import * as health` の近く）:

```ts
import * as ccNotify from "./ccNotify"
```

`app.router.use(express.json())`（135 行目付近）と `app.router.use(express.urlencoded(...))` の直後に追加:

```ts
  app.router.use("/cc-notify", ccNotify.router)
```

`app.wsRouter.use("/healthz", health.wsRouter.router)`（155 行目付近）の直後に追加:

```ts
  app.wsRouter.use("/cc-notify", ccNotify.wsRouter.router)
```

`register` 関数内、`heart` 生成後〜`return` 前のどこか（例: `app.router.use(common)` の後）に起動時初期化を追加:

```ts
  await ccNotify.init(args)
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd server/code-server && npm run test:unit -- ccNotify`
Expected: PASS（4 tests）

- [ ] **Step 6: ビルド健全性を確認**

Run: `cd server/code-server && npm run lint || true` および `npx tsc --noEmit -p . 2>&1 | head`
Expected: cc-notify 関連の型エラーが無いこと（既存の無関係警告は許容）

- [ ] **Step 7: コミット**

```bash
git add server/code-server/src/node/routes/ccNotify.ts server/code-server/src/node/routes/index.ts server/code-server/test/unit/node/routes/ccNotify.test.ts
git commit -m "feat(server): /cc-notify POST + /cc-notify/ws WS routes with auth/token"
```

---

## Task 3: フック設定の差し替え（curl POST）

Stop/Notification フックを `cc-config notify` から、エンドポイントファイルを読んで `localhost` に POST する curl ワンライナーへ差し替える。

**Files:**
- Modify: `.claude/settings.json`

**Interfaces:**
- Consumes: Task 2 が書き出す `~/.cc-studio/notify-endpoint`（1行目=URL, 2行目=token）。
- Produces: Stop/Notification 時に hook JSON(stdin) をそのまま `/cc-notify` へ POST。

- [ ] **Step 1: settings.json を書き換える**

`.claude/settings.json` を以下に置換（command は単一文字列）:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "f=\"$HOME/.cc-studio/notify-endpoint\"; [ -f \"$f\" ] || exit 0; url=$(sed -n 1p \"$f\"); tok=$(sed -n 2p \"$f\"); curl -s -m 3 -X POST -H 'Content-Type: application/json' -H \"x-cc-notify-token: $tok\" --data-binary @- \"$url\" >/dev/null 2>&1 || true",
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
            "command": "f=\"$HOME/.cc-studio/notify-endpoint\"; [ -f \"$f\" ] || exit 0; url=$(sed -n 1p \"$f\"); tok=$(sed -n 2p \"$f\"); curl -s -m 3 -X POST -H 'Content-Type: application/json' -H \"x-cc-notify-token: $tok\" --data-binary @- \"$url\" >/dev/null 2>&1 || true",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: エンドツーエンドで手動確認**

前提: Task 2 を含む code-server を起動（`server/provision/start-vsserver.sh` 等）し `~/.cc-studio/notify-endpoint` が生成されていること。

Run:
```bash
URL=$(sed -n 1p "$HOME/.cc-studio/notify-endpoint"); TOK=$(sed -n 2p "$HOME/.cc-studio/notify-endpoint")
echo '{"hook_event_name":"Stop","cwd":"/x/proj","session_id":"manual"}' \
  | curl -s -X POST -H 'Content-Type: application/json' -H "x-cc-notify-token: $TOK" --data-binary @- "$URL"
```
Expected: `{"delivered":N}`（接続中 WS が無ければ N=0、あれば配信される）。`{"delivered"` が返れば配管は OK。

- [ ] **Step 3: コミット**

```bash
git add .claude/settings.json
git commit -m "feat(hook): post Stop/Notification to local /cc-notify instead of cc-config notify"
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
- Consumes: `NotifyDecision.shouldNotify`、`NotifyState.foreground`/`activeFolder`、`BuildConfig.TARGET_URL`、`CookieManager`。
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
import android.webkit.CookieManager
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
        val builder = Request.Builder().url(url)
        CookieManager.getInstance().getCookie(BuildConfig.TARGET_URL)?.let {
            builder.addHeader("Cookie", it)
        }
        ws = client.newWebSocket(builder.build(), object : WebSocketListener() {
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

## Self-Review メモ

- **Spec coverage:** 信号=Stop/Notification フック(Task 3) / localhost POST + WS(Task 1,2) / 既存 auth + token(Task 2) / KeepAliveService 受信(Task 6) / スクリーン突合・前面抑制(Task 4,5,6) / タップで開く(Task 7) / cc_task 別チャンネル(Task 6) / セッション単位更新(Task 6, cwd ハッシュ ID)。`branch` は v1 未実装（"" 固定）として明示——spec の「将来 FCM」と同様、必要になったら拡張。
- **配信先=ネイティブ通知**: WebView ではなく KeepAliveService が受けるため背面でも動く（要件 3 充足）。
- **セキュリティ:** loopback に依存せず token もしくは cookie 認証で POST を保護（tailscale serve の localhost 終端対策）。
- **既知の前提:** WS の cookie は WebView で一度ログイン後に有効。未ログイン時は再接続ループで待機（通知機能のみ無効、本体・生存通知に影響なし）。
- **ポート:** 既定 8088。`init` が bind-addr から解決してファイルに書くため、ポート変更にも追従。
