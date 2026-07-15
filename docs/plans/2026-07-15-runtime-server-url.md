# ランタイム接続先設定 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接続先オリジン（HTTPS ドメイン）と初期フォルダをアプリ内 UI からランタイム設定し、ファイルへ永続化する。

**Architecture:** 単一の真実源 `ServerConfig`（`filesDir/server.json` を原子的 read/write）を新設し、既存の `BuildConfig.TARGET_URL` 参照 5 箇所をこれ経由に置換する。`BuildConfig.TARGET_URL` は初回シードに降格。設定 UI は既存 overlay パネル（`server.html`）として実装し、サーバ側（notify-relay）に読み取り専用のディレクトリ一覧 endpoint を足してフォルダ参照を可能にする。

**Tech Stack:** Kotlin（Android app, minSdk 26）, JUnit4 + org.json（JVM unit tests）, OkHttp（HTTP）, WebView + JS bridge, Node.js ESM（notify-relay, `node:test`）。

## Global Constraints

- 接続先は **HTTPS のみ**。`http://` は拒否。（Claude Code 公式拡張の制約）
- ホストは **ドメイン（FQDN）必須。IPv4/IPv6 リテラルは拒否**。
- `server/code-server` は upstream サブモジュール。**触らない**。サーバ改修は `server/notify-relay` のみ。
- 設定ファイルは **原子的書き込み**（tmp→rename）。プロセス kill / アプリ更新後も残ること。
- UI は **ja / en 二言語**（`api().getUiLang()` で切替、既存 `notify.html` に倣う）。
- 公開リポジトリ。コード・テスト・ドキュメントに **実環境データを書かない**（プレースホルダ: ホスト `workbench.tailnet.ts.net`、パス `/home/user/projects`、IP例 `192.0.2.10`）。
- 既存の計器盤デザイントークン（`--chassis` 等, `notify.html`/`switcher.html`）をそのまま使う。新配色を足さない。
- 各 Kotlin テストは `./gradlew :app:testDebugUnitTest` で実行。relay テストは `node --test server/notify-relay/relay.test.mjs`。

---

## File Structure

- Create `app/src/main/java/app/ccstudio/ServerConfig.kt` — `ServerConfigCodec`（純粋: 検証+JSON codec+seed 判定）と `ServerConfig`（File バックの store）。
- Create `app/src/test/java/app/ccstudio/ServerConfigTest.kt` — 上記のユニットテスト。
- Modify `server/notify-relay/relay.mjs` — `listDirs()` 追加＋`createServer` に GET `/ls` 分岐。
- Modify `server/notify-relay/relay.test.mjs` — `listDirs` テスト追加。
- Modify `app/src/main/java/app/ccstudio/PanelJson.kt` — `settingsList` に `server` エントリ。
- Modify `app/src/test/java/app/ccstudio/PanelJsonTest.kt` — server エントリのテスト。
- Modify `app/src/main/java/app/ccstudio/MainActivity.kt` — `TARGET_URL` 参照を `ServerConfig` へ置換、初回シード/誘導、設定導線、ブラウズ/保存ハンドラ。
- Modify `app/src/main/java/app/ccstudio/KeepAliveService.kt` — `wsUrl`/`postUrl` を `ServerConfig` から。
- Modify `app/src/main/java/app/ccstudio/CcBridge.kt` — `serverConfigJson`/`saveServerOrigin`/`saveDefaultFolder`/`browseDir` 追加。
- Create `app/src/main/assets/server.html` — 設定 UI（オリジン検証＋フォルダ参照）。
- Create `app/src/main/res/xml/backup_rules.xml` + Modify `AndroidManifest.xml` — `server.json` をバックアップ対象に明示。

---

## Task 1: オリジン検証 `ServerConfigCodec.normalizeOrigin`

**Files:**
- Create: `app/src/main/java/app/ccstudio/ServerConfig.kt`
- Test: `app/src/test/java/app/ccstudio/ServerConfigTest.kt`

**Interfaces:**
- Produces: `sealed class OriginResult { data class Ok(val origin: String); data class Err(val code: String) }`（code = `empty|not_https|is_ip|no_dot`）。`ServerConfigCodec.normalizeOrigin(input: String): OriginResult`。

- [ ] **Step 1: Write the failing test**

```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class ServerConfigTest {
    private fun ok(input: String) = ServerConfigCodec.normalizeOrigin(input) as OriginResult.Ok
    private fun errCode(input: String) = (ServerConfigCodec.normalizeOrigin(input) as OriginResult.Err).code

    @Test fun normalize_bareDomain_addsHttps() {
        assertEquals("https://workbench.tailnet.ts.net", ok("workbench.tailnet.ts.net").origin)
    }
    @Test fun normalize_stripsSchemePathQueryAndLowercasesHost() {
        assertEquals("https://host.example.ts.net", ok("https://Host.Example.TS.net/x?y#z").origin)
    }
    @Test fun normalize_keepsPort() {
        assertEquals("https://host.ts.net:8443", ok("host.ts.net:8443").origin)
    }
    @Test fun normalize_http_rejected() { assertEquals("not_https", errCode("http://host.ts.net")) }
    @Test fun normalize_ipv4_rejected() { assertEquals("is_ip", errCode("192.0.2.10")) }
    @Test fun normalize_ipv6_rejected() {
        assertEquals("is_ip", errCode("2001:db8::1"))
        assertEquals("is_ip", errCode("[2001:db8::1]:8443"))
    }
    @Test fun normalize_noDot_rejected() { assertEquals("no_dot", errCode("localhost")) }
    @Test fun normalize_empty_rejected() {
        assertEquals("empty", errCode(""))
        assertEquals("empty", errCode("   "))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.ServerConfigTest"`
Expected: FAIL — `ServerConfigCodec` / `OriginResult` unresolved.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package app.ccstudio

sealed class OriginResult {
    data class Ok(val origin: String) : OriginResult()
    data class Err(val code: String) : OriginResult()   // empty | not_https | is_ip | no_dot
}

object ServerConfigCodec {
    /** 入力を検証し、合格なら "https://host[:port]"（host 小文字化）を返す。IP・http・ドット無しは拒否。 */
    fun normalizeOrigin(input: String): OriginResult {
        val v = input.trim()
        if (v.isEmpty()) return OriginResult.Err("empty")
        if (v.startsWith("http://", ignoreCase = true)) return OriginResult.Err("not_https")
        var s = v.replaceFirst(Regex("^https://", RegexOption.IGNORE_CASE), "")
        s = s.substringBefore('/').substringBefore('?').substringBefore('#')
        if (s.isEmpty()) return OriginResult.Err("empty")
        // IPv6 リテラル（角括弧 or コロン2つ以上）は IP 扱いで拒否
        if (s.startsWith("[") || s.count { it == ':' } >= 2) return OriginResult.Err("is_ip")
        val host = s.replace(Regex(":\\d+$"), "")
        if (host.isEmpty()) return OriginResult.Err("empty")
        if (Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host)) return OriginResult.Err("is_ip")
        if (!host.contains('.')) return OriginResult.Err("no_dot")
        return OriginResult.Ok("https://" + s.lowercase())
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.ServerConfigTest"`
Expected: PASS（8 tests）。

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/app/ccstudio/ServerConfig.kt app/src/test/java/app/ccstudio/ServerConfigTest.kt
git commit -m "feat: ServerConfigCodec.normalizeOrigin (HTTPS+ドメイン検証, IP拒否)"
```

---

## Task 2: JSON codec・seed 判定・ファイル store（原子的書き込み）

**Files:**
- Modify: `app/src/main/java/app/ccstudio/ServerConfig.kt`
- Test: `app/src/test/java/app/ccstudio/ServerConfigTest.kt`

**Interfaces:**
- Produces:
  - `data class ServerCfg(val origin: String? = null, val defaultFolder: String? = null)`
  - `ServerConfigCodec.encode(cfg: ServerCfg): String` / `decode(json: String?): ServerCfg`
  - `ServerConfigCodec.seedOriginFrom(buildTargetUrl: String): String?`（正規化に通ればその origin、不可なら null）
  - `class ServerConfig(file: File)` with `origin(): String?`, `defaultFolder(): String?`, `setOrigin(origin: String)`, `setDefaultFolder(path: String?)`, `companion object { fun forContext(ctx: Context): ServerConfig }`

- [ ] **Step 1: Write the failing test（ServerConfigTest.kt に追記）**

```kotlin
    // --- codec ---
    @Test fun codec_roundTrip() {
        val json = ServerConfigCodec.encode(ServerCfg("https://host.ts.net", "/home/user/projects"))
        val back = ServerConfigCodec.decode(json)
        assertEquals("https://host.ts.net", back.origin)
        assertEquals("/home/user/projects", back.defaultFolder)
    }
    @Test fun codec_decodesBlankAndBrokenAsEmpty() {
        assertEquals(null, ServerConfigCodec.decode(null).origin)
        assertEquals(null, ServerConfigCodec.decode("").origin)
        assertEquals(null, ServerConfigCodec.decode("{not json").origin)
    }
    @Test fun seed_realDomainSeeds_placeholderDoesNot() {
        assertEquals("https://workbench.tailnet.ts.net",
            ServerConfigCodec.seedOriginFrom("https://workbench.tailnet.ts.net/?folder=/x"))
        assertEquals(null, ServerConfigCodec.seedOriginFrom("https://localhost/"))
        assertEquals(null, ServerConfigCodec.seedOriginFrom(""))
    }

    // --- file store（原子的書き込み） ---
    @org.junit.Rule @JvmField val tmp = org.junit.rules.TemporaryFolder()

    @Test fun store_unsetWhenNoFile() {
        val c = ServerConfig(java.io.File(tmp.root, "server.json"))
        assertEquals(null, c.origin())
    }
    @Test fun store_setOrigin_persistsAndCleansTmp() {
        val f = java.io.File(tmp.root, "server.json")
        ServerConfig(f).setOrigin("https://host.ts.net")
        assertEquals("https://host.ts.net", ServerConfig(f).origin())
        assertEquals(false, java.io.File(tmp.root, "server.json.tmp").exists())
    }
    @Test fun store_corruptFileReadsAsUnset() {
        val f = java.io.File(tmp.root, "server.json"); f.writeText("{broken")
        assertEquals(null, ServerConfig(f).origin())
    }
    @Test fun store_setDefaultFolderBlankClears() {
        val f = java.io.File(tmp.root, "server.json")
        val c = ServerConfig(f); c.setOrigin("https://host.ts.net"); c.setDefaultFolder("   ")
        assertEquals(null, ServerConfig(f).defaultFolder())
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.ServerConfigTest"`
Expected: FAIL — `ServerCfg` / `encode` / `ServerConfig` unresolved.

- [ ] **Step 3: Write minimal implementation（ServerConfig.kt に追記）**

```kotlin
import android.content.Context
import org.json.JSONObject
import java.io.File

data class ServerCfg(val origin: String? = null, val defaultFolder: String? = null)
```

`ServerConfigCodec` に追記:

```kotlin
    fun encode(cfg: ServerCfg): String =
        JSONObject().put("origin", cfg.origin ?: "").put("defaultFolder", cfg.defaultFolder ?: "").toString()

    fun decode(json: String?): ServerCfg {
        if (json.isNullOrBlank()) return ServerCfg()
        return try {
            val o = JSONObject(json)
            ServerCfg(
                origin = o.optString("origin", "").ifBlank { null },
                defaultFolder = o.optString("defaultFolder", "").ifBlank { null },
            )
        } catch (_: Exception) { ServerCfg() }
    }

    /** BuildConfig.TARGET_URL を初回シードに使えるか。使えるなら正規化 origin、不可なら null。 */
    fun seedOriginFrom(buildTargetUrl: String): String? =
        (normalizeOrigin(buildTargetUrl) as? OriginResult.Ok)?.origin
```

新クラス:

```kotlin
/** filesDir/server.json を原子的に read/write する薄い store。 */
class ServerConfig(private val file: File) {
    private var cache: ServerCfg = ServerConfigCodec.decode(readSafely())

    fun origin(): String? = cache.origin
    fun defaultFolder(): String? = cache.defaultFolder
    fun setOrigin(origin: String) { cache = cache.copy(origin = origin); persist() }
    fun setDefaultFolder(path: String?) { cache = cache.copy(defaultFolder = path?.ifBlank { null }); persist() }

    private fun readSafely(): String? =
        try { if (file.exists()) file.readText() else null } catch (_: Exception) { null }

    private fun persist() {
        val tmp = File(file.parentFile, file.name + ".tmp")
        try {
            file.parentFile?.mkdirs()
            tmp.writeText(ServerConfigCodec.encode(cache))
            if (!tmp.renameTo(file)) { tmp.copyTo(file, overwrite = true); tmp.delete() }
        } catch (_: Exception) { try { tmp.delete() } catch (_: Exception) {} }
    }

    companion object {
        fun forContext(ctx: Context): ServerConfig = ServerConfig(File(ctx.filesDir, "server.json"))
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.ServerConfigTest"`
Expected: PASS（全 15 tests）。

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/app/ccstudio/ServerConfig.kt app/src/test/java/app/ccstudio/ServerConfigTest.kt
git commit -m "feat: ServerConfig ファイル永続化（codec・seed判定・原子的書き込み）"
```

---

## Task 3: relay ディレクトリ一覧 endpoint

**Files:**
- Modify: `server/notify-relay/relay.mjs`
- Test: `server/notify-relay/relay.test.mjs`

**Interfaces:**
- Produces: `export function listDirs(target, opts?): { path, parent, dirs: string[], truncated } | null`。`createServer()` が GET `…/ls?path=<abs>` を処理。

- [ ] **Step 1: Write the failing test（relay.test.mjs に追記）**

```js
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { listDirs } from "./relay.mjs"

test("listDirs lists subdirectories sorted, ignores files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-"))
  fs.mkdirSync(path.join(tmp, "b")); fs.mkdirSync(path.join(tmp, "a"))
  fs.writeFileSync(path.join(tmp, "f.txt"), "x")
  const r = listDirs(tmp)
  assert.deepEqual(r.dirs, ["a", "b"])
  assert.equal(r.truncated, false)
  assert.equal(r.parent, path.dirname(tmp))
})

test("listDirs falls back to home when path is empty", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-home-"))
  fs.mkdirSync(path.join(tmp, "sub"))
  const r = listDirs("", { home: tmp })
  assert.equal(r.path, tmp)
  assert.deepEqual(r.dirs, ["sub"])
})

test("listDirs returns null for missing path or a file", () => {
  assert.equal(listDirs("/no/such/dir/xyz"), null)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-file-"))
  const file = path.join(tmp, "f"); fs.writeFileSync(file, "x")
  assert.equal(listDirs(file), null)
})

test("listDirs truncates at limit", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-lim-"))
  for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(tmp, "d" + i))
  const r = listDirs(tmp, { limit: 3 })
  assert.equal(r.dirs.length, 3)
  assert.equal(r.truncated, true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/notify-relay/relay.test.mjs`
Expected: FAIL — `listDirs` is not a function / not exported.

- [ ] **Step 3: Write minimal implementation**

`relay.mjs` 冒頭の import 群に追記（既存 import と重複しないもののみ）:

```js
import fs from "node:fs"
import path from "node:path"
```

関数を追加（`createServer` の前あたり）:

```js
const LS_HOME = process.env.HOME || "/root"
const LS_LIMIT = 500

/** target 配下のサブディレクトリ名（昇順）。読めない/存在しない/ファイル → null。 */
export function listDirs(target, { home = LS_HOME, limit = LS_LIMIT } = {}) {
  const p = target && String(target).trim() ? String(target) : home
  let st
  try { st = fs.statSync(p) } catch { return null }
  if (!st.isDirectory()) return null
  let entries
  try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return null }
  const dirs = []
  for (const e of entries) {
    let isDir = false
    try {
      isDir = e.isDirectory() ||
        (e.isSymbolicLink() && fs.statSync(path.join(p, e.name)).isDirectory())
    } catch { isDir = false }
    if (isDir) dirs.push(e.name)
  }
  dirs.sort((a, b) => a.localeCompare(b))
  const truncated = dirs.length > limit
  return {
    path: p,
    parent: p === "/" ? "/" : path.dirname(p),
    dirs: truncated ? dirs.slice(0, limit) : dirs,
    truncated,
  }
}
```

`createServer` の `http.createServer((req, res) => {` 内、`if (req.method === "POST")` ブロックの**前**に GET 分岐を追加:

```js
    if (req.method === "GET") {
      const u = new URL(req.url, "http://x")
      if (u.pathname.endsWith("/ls")) {
        const result = listDirs(u.searchParams.get("path"))
        if (!result) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "not_a_directory" }))
          return
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(result))
        return
      }
      res.writeHead(404); res.end(); return
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/notify-relay/relay.test.mjs`
Expected: PASS（既存 + 追加 4 tests）。

- [ ] **Step 5: Commit**

```bash
git add server/notify-relay/relay.mjs server/notify-relay/relay.test.mjs
git commit -m "feat(relay): 読み取り専用ディレクトリ一覧 GET …/ls"
```

---

## Task 4: 設定リストに接続先エントリ

**Files:**
- Modify: `app/src/main/java/app/ccstudio/PanelJson.kt:38-61`
- Test: `app/src/test/java/app/ccstudio/PanelJsonTest.kt`

**Interfaces:**
- Consumes: なし（純粋関数）。
- Produces: `PanelJson.settingsList(total: Int, enabled: Int, originHost: String?, defaultFolder: String?, ja: Boolean): String`（シグネチャ変更）。JSON 配列に `id="server"` エントリ（System グループ先頭）を含む。

- [ ] **Step 1: Write the failing test（PanelJsonTest.kt に追記）**

```kotlin
    @Test fun settingsList_hasServerEntry_withValueSub() {
        val json = PanelJson.settingsList(0, 0, "workbench.tailnet.ts.net", "/home/user/projects", true)
        val arr = org.json.JSONArray(json)
        var server: org.json.JSONObject? = null
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            if (o.getString("id") == "server") server = o
        }
        assertNotNull(server)
        assertEquals("システム", server!!.getString("group"))
        assertEquals("接続先", server.getString("label"))
        assertEquals("workbench.tailnet.ts.net · /home/user/projects", server.getString("sub"))
    }

    @Test fun settingsList_serverUnset_showsPrompt() {
        val json = PanelJson.settingsList(0, 0, null, null, true)
        val arr = org.json.JSONArray(json)
        var sub = ""
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            if (o.getString("id") == "server") sub = o.getString("sub")
        }
        assertEquals("未設定 — タップして設定", sub)
    }
```

（`import org.junit.Assert.assertNotNull` が無ければ追加。）

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.PanelJsonTest"`
Expected: FAIL — 引数数が合わない（既存 `settingsList` は 3 引数）。

- [ ] **Step 3: Write minimal implementation**

`PanelJson.settingsList` のシグネチャを変更し、`notify` の**前**に server エントリを追加:

```kotlin
    fun settingsList(total: Int, enabled: Int, originHost: String?, defaultFolder: String?, ja: Boolean): String {
        fun t(en: String, jp: String) = if (ja) jp else en
        val arr = JSONArray()
        arr.put(
            JSONObject().put("id", "plugins").put("group", t("Plugins", "プラグイン")).put("icon", "🧩")
                .put("label", t("Plugin manager", "プラグイン管理"))
                .put("sub", t("$total installed · $enabled enabled", "$total 個インストール · $enabled 有効"))
        )
        val serverSub = if (originHost != null)
            originHost + (defaultFolder?.let { " · $it" } ?: "")
        else t("Not set — tap to configure", "未設定 — タップして設定")
        arr.put(
            JSONObject().put("id", "server").put("group", t("System", "システム")).put("icon", "🖥️")
                .put("label", t("Server", "接続先")).put("sub", serverSub)
        )
        arr.put(
            JSONObject().put("id", "notify").put("group", t("System", "システム")).put("icon", "🔔")
                .put("label", t("Notifications", "通知"))
                .put("sub", t("Stop / Notification hooks", "Stop / Notification フック"))
        )
        arr.put(
            JSONObject().put("id", "log").put("group", t("System", "システム")).put("icon", "📋")
                .put("label", t("Log", "ログ")).put("sub", t("Show observer log", "オブザーバーログを表示"))
        )
        arr.put(
            JSONObject().put("id", "lang").put("group", t("System", "システム")).put("icon", "🌐")
                .put("label", t("Language", "言語"))
                .put("sub", t("Follow device / 日本語 / English", "端末に合わせる / 日本語 / English"))
        )
        return arr.toString()
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.PanelJsonTest"`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/app/ccstudio/PanelJson.kt app/src/test/java/app/ccstudio/PanelJsonTest.kt
git commit -m "feat: 設定リストに接続先エントリを追加"
```

---

## Task 5: TARGET_URL 参照を ServerConfig へ置換＋初回シード

**Files:**
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`（`697`, `118`, `194`, `261`, `315`, `settingsListJson` `519-522`）
- Modify: `app/src/main/java/app/ccstudio/KeepAliveService.kt:78-96`

**Interfaces:**
- Consumes: `ServerConfig.forContext(ctx)`, `ServerConfigCodec.seedOriginFrom`, `PanelJson.settingsList(...)`（5 引数）。
- Produces: `MainActivity` に `private val serverConfig by lazy { ServerConfig.forContext(this) }`。以降のタスクが参照。

このタスクはコンパイル＋ビルドで検証する（Android ランタイム依存のため単体テスト無し）。

- [ ] **Step 1: MainActivity の companion を差し替え、seed とヘルパを追加**

`MainActivity.kt:694-698` の companion を変更:

```kotlin
    companion object {
        // 既定で開くワークベンチ URL のビルド時シード。実値は local.properties から BuildConfig 経由。
        // ランタイムの真実源は ServerConfig（server.json）。ここは初回シードにのみ使う。
        private val SEED_TARGET_URL = BuildConfig.TARGET_URL
    }
```

クラス本体（フィールド宣言域、例: `screens` 付近）に追加:

```kotlin
    private val serverConfig by lazy { ServerConfig.forContext(this) }

    /** 現在の接続先オリジン（末尾スラッシュ無し）。未設定なら null。 */
    private fun originOrNull(): String? = serverConfig.origin()

    /** origin + "/" を返す。未設定なら null。 */
    private fun originRootUrl(): String? = originOrNull()?.let { "$it/" }
```

- [ ] **Step 2: onCreate の初期化直後に初回シードを追加**

`onCreate` 内、`serverConfig` を最初に使う前（`screens = ScreenManager(root)` の直後あたり）に:

```kotlin
        // 初回シード: server.json 未設定かつ BuildConfig が実 HTTPS ドメインなら移送。
        if (serverConfig.origin() == null) {
            ServerConfigCodec.seedOriginFrom(SEED_TARGET_URL)?.let { serverConfig.setOrigin(it) }
        }
```

- [ ] **Step 3: TARGET_URL 参照 4 箇所を置換**

`118`（初期スクリーン。復元状態が無いとき）:

```kotlin
        if (state.urls.isEmpty()) {
            val initial = originOrNull()?.let { org ->
                serverConfig.defaultFolder()?.let { UrlPolicy.folderUrl(org, it) } ?: "$org/"
            }
            if (initial != null) screens.add(createWebScreen(initial, reloadOnFirstLoad = true))
        } else {
            state.urls.forEach { screens.add(createWebScreen(it, reloadOnFirstLoad = true)) }
        }
```

`194`（通知タップ cwd→URL）: `UrlPolicy.folderUrl(TARGET_URL, cwd)` → 

```kotlin
        val url = originOrNull()?.let { UrlPolicy.folderUrl(it, cwd) } ?: return
```

`261`（workbenchHost）:

```kotlin
    private val workbenchHost: String?
        get() = originOrNull()?.let { try { Uri.parse(it).host } catch (_: Exception) { null } }
```

（`by lazy` から `get()` へ変更。オリジン変更後に追従させるため。）

`315`（新規スクリーン）: `createWebScreen(TARGET_URL, …)` →

```kotlin
                val s = createWebScreen(originRootUrl() ?: return, reloadOnFirstLoad = true)
```

- [ ] **Step 4: settingsListJson を 5 引数化**

`MainActivity.kt:519-522`:

```kotlin
    private fun settingsListJson(): String {
        val plugins = pluginStore.list()
        val host = originOrNull()?.let { try { Uri.parse(it).host } catch (_: Exception) { null } }
        return PanelJson.settingsList(
            plugins.size, plugins.count { it.enabled }, host, serverConfig.defaultFolder(), AppLang.isJa(this)
        )
    }
```

- [ ] **Step 5: KeepAliveService の wsUrl/postUrl を ServerConfig から**

`KeepAliveService.kt:78-96` を置換:

```kotlin
    /** ServerConfig の origin から wss://host[:port]/cc-notify/ws を作る。 */
    private fun wsUrl(): String? {
        val base = ServerConfig.forContext(this).origin() ?: return null
        val schemeEnd = base.indexOf("://"); if (schemeEnd < 0) return null
        val scheme = base.substring(0, schemeEnd)
        val host = base.substring(schemeEnd + 3).substringBefore('/')
        val wsScheme = if (scheme == "https") "wss" else "ws"
        return "$wsScheme://$host/cc-notify/ws"
    }

    /** ServerConfig の origin から https://host/cc-notify を作る（ログアップロード先）。 */
    private fun postUrl(): String? {
        val base = ServerConfig.forContext(this).origin() ?: return null
        val schemeEnd = base.indexOf("://"); if (schemeEnd < 0) return null
        val host = base.substring(schemeEnd + 3).substringBefore('/')
        return "https://$host/cc-notify"
    }
```

- [ ] **Step 6: Build to verify it compiles**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL（`TARGET_URL` 未解決参照が残っていないこと）。

- [ ] **Step 7: Commit**

```bash
git add app/src/main/java/app/ccstudio/MainActivity.kt app/src/main/java/app/ccstudio/KeepAliveService.kt
git commit -m "feat: 接続先を ServerConfig 経由に統一し BuildConfig を初回シードに降格"
```

---

## Task 6: JS 橋（設定値取得・保存・ディレクトリ参照）

**Files:**
- Modify: `app/src/main/java/app/ccstudio/CcBridge.kt`
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`（CcBridge 生成箇所、`openSettingsEntry`）

**Interfaces:**
- Produces（JS からは `window.CCStudio.*`）:
  - `getServerConfig(): String` — `{"origin":"…","defaultFolder":"…","host":"…"}`（未設定は空文字）
  - `saveServerOrigin(host: String)` — 検証・保存・スクリーン再構築・KeepAlive 再起動
  - `saveDefaultFolder(path: String)` — 保存のみ
  - `browseDir(path: String)` — 非同期に `…/ls` を取得し `window.__ccDirResult(json)` を呼ぶ

このタスクはビルド＋実機で検証する。

- [ ] **Step 1: CcBridge にラムダと @JavascriptInterface を追加**

`CcBridge` のコンストラクタ引数に追加:

```kotlin
    private val serverConfigJsonFn: () -> String,
    private val onSaveServerOrigin: (host: String) -> Unit,
    private val onSaveDefaultFolder: (path: String) -> Unit,
    private val onBrowseDir: (path: String) -> Unit,
```

メソッド追加（他の `@JavascriptInterface` 群の末尾）:

```kotlin
    /** 接続先設定の現在値 JSON（origin/defaultFolder/host）。 */
    @JavascriptInterface fun getServerConfig(): String = serverConfigJsonFn()
    /** ホスト文字列を検証・保存し、スクリーンを新オリジンで再構築する。 */
    @JavascriptInterface fun saveServerOrigin(host: String) = onSaveServerOrigin(host)
    /** 初期フォルダを保存する。 */
    @JavascriptInterface fun saveDefaultFolder(path: String) = onSaveDefaultFolder(path)
    /** ディレクトリ一覧を非同期取得し window.__ccDirResult(json) を呼ぶ。 */
    @JavascriptInterface fun browseDir(path: String) = onBrowseDir(path)
```

- [ ] **Step 2: MainActivity の CcBridge 生成にハンドラを渡す**

`CcBridge(...)` 生成箇所（`MainActivity.kt:320` 付近）に引数追加:

```kotlin
        serverConfigJsonFn = {
            val o = serverConfig.origin() ?: ""
            val h = if (o.isNotEmpty()) (try { Uri.parse(o).host } catch (_: Exception) { null }) ?: "" else ""
            org.json.JSONObject().put("origin", o)
                .put("defaultFolder", serverConfig.defaultFolder() ?: "")
                .put("host", h).toString()
        },
        onSaveServerOrigin = { host -> runOnUiThread { applyServerOrigin(host) } },
        onSaveDefaultFolder = { path -> runOnUiThread {
            serverConfig.setDefaultFolder(path); toast(getString(R.string.toast_saved))
        } },
        onBrowseDir = { path -> fetchDirs(path) },
```

- [ ] **Step 3: MainActivity に okHttp・serverPanel・applyServerOrigin・fetchDirs を実装**

まずフィールドを追加（`import okhttp3.Request` も追加）:

```kotlin
    private val okHttp = okhttp3.OkHttpClient()

    // 設定オーバーレイ（server.html）。show() は Task 7 の openServer() から。
    private val serverPanel by lazy {
        OverlayPanel(root, "server.html", "window.__ccRenderServer && window.__ccRenderServer()") { newManagementWebView() }
    }
```

（`newManagementWebView()` は既存 overlay パネル（notify/log）が使う WebView 生成ヘルパに名前を合わせること。notify パネル定義を参照。）

```kotlin
    /** ホスト入力を検証・保存し、旧スクリーンを捨てて新オリジンで作り直す。KeepAlive も再起動。 */
    private fun applyServerOrigin(host: String) {
        val r = ServerConfigCodec.normalizeOrigin(host)
        if (r !is OriginResult.Ok) { toast(getString(R.string.toast_origin_invalid)); return }
        serverConfig.setOrigin(r.origin)
        screenStore.save(emptyList(), 0)
        screens.webScreens().forEach { screens.close(it.id) }
        val folder = serverConfig.defaultFolder()
        val url = folder?.let { UrlPolicy.folderUrl(r.origin, it) } ?: "${r.origin}/"
        val s = createWebScreen(url, reloadOnFirstLoad = true)
        screens.add(s); screens.select(s.id)
        stopService(Intent(this, KeepAliveService::class.java))
        ContextCompat.startForegroundService(this, Intent(this, KeepAliveService::class.java))
        toast(getString(R.string.toast_server_updated))
    }

    /** …/ls を OkHttp で非同期取得し、生 JSON を window.__ccDirResult に渡す。未接続/失敗は {error}。 */
    private fun fetchDirs(path: String) {
        val origin = originOrNull()
        if (origin == null) {
            serverPanel.evaluate("window.__ccDirResult({\"error\":\"not_connected\"})"); return
        }
        val url = "$origin/cc-notify/ls" + if (path.isNotEmpty()) "?path=" + Uri.encode(path) else ""
        okHttp.newCall(Request.Builder().url(url).build()).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                runOnUiThread { serverPanel.evaluate("window.__ccDirResult({\"error\":\"fetch_failed\"})") }
            }
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                val body = response.body?.string()
                val payload = if (response.isSuccessful && body != null) body else "{\"error\":\"not_a_directory\"}"
                runOnUiThread { serverPanel.evaluate("window.__ccDirResult($payload)") }
            }
        })
    }
```

補足: `relay` が返す JSON をそのまま `window.__ccDirResult(<json>)` へ渡す（`OverlayPanel.evaluate` は生成済みのときだけ評価する既存挙動）。

- [ ] **Step 4: 文言リソースを追加**

`res/values/strings.xml`（en）と `res/values-ja/strings.xml`（ja）に:

```xml
<!-- en -->
<string name="toast_saved">Saved</string>
<string name="toast_server_updated">Server updated</string>
<string name="toast_origin_invalid">Enter a valid HTTPS domain (no IP)</string>
```
```xml
<!-- ja -->
<string name="toast_saved">保存しました</string>
<string name="toast_server_updated">接続先を更新しました</string>
<string name="toast_origin_invalid">HTTPS のドメインを入力してください（IP 不可）</string>
```

- [ ] **Step 5: Build to verify it compiles**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL。

- [ ] **Step 6: Commit**

```bash
git add app/src/main/java/app/ccstudio/CcBridge.kt app/src/main/java/app/ccstudio/MainActivity.kt app/src/main/res/values/strings.xml app/src/main/res/values-ja/strings.xml
git commit -m "feat: 接続先の取得・保存・ディレクトリ参照の JS 橋を追加"
```

---

## Task 7: 設定 UI `server.html` ＋ パネル結線

**Files:**
- Create: `app/src/main/assets/server.html`
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`（`serverPanel` 定義、`openSettingsEntry`、`fetchDirs` 結線）

**Interfaces:**
- Consumes: `window.CCStudio.getServerConfig/saveServerOrigin/saveDefaultFolder/browseDir`, `getUiLang`, `navBack`。
- Produces: `openSettingsEntry("server")` で `serverPanel.show()`。

デザインは確定モック `docs/specs/mockups/2026-07-15-server-settings.html` の**詳細ページ部分**（`.bar`/`.body`/scheme-lab/hostbox/tele/folder/browser/foot）を `server.html` に移植する。トークン・レイアウト・検証 JS はモックのものを流用（`classify`/`ERR`/テレメトリ更新/ディレクトリブラウザ）。相違点のみ以下。

- [ ] **Step 1: server.html を作成**

モック詳細ページの `<style>` と詳細 `.view` 相当のマークアップを、`notify.html` 同様の単一ページ構成（`.screen>.bar+.body+.foot`）で `app/src/main/assets/server.html` に作る。JS は次を実データに差し替える:

- 初期値取得: `var cfg = JSON.parse(api().getServerConfig()||"{}")` → `#host` に `cfg.host`、`#folder` に `cfg.defaultFolder` を反映。
- 保存: `#save` クリックで `api().saveServerOrigin(document.getElementById('host').value)`。フォルダ確定（`#pick` / フォルダ入力 blur）で `api().saveDefaultFolder(...)`。
- ブラウズ: `#browseBtn` で `api().browseDir(currentPath)`、`window.__ccDirResult = function(res){ … }` で描画（`res.error` があれば「サーバに接続すると参照できます」）。
- 戻る: `#back` で `api().navBack()`。
- ja/en: `notify.html` と同じ `getUiLang()` パターンで文言辞書を切替。
- 検証文言はモックの `ERR` を流用（IP/HTTPS/ドット無し）。

（完全なファイルはモックからの機械的移植のため、モックを直接ベースにコピーし上記フックを差し替えること。新規デザインは起こさない。）

- [ ] **Step 2: openSettingsEntry に server 分岐と openServer を追加**

（`serverPanel` は Task 6 Step 3 で定義済み。）`openSettingsEntry` の `when (id)` に追加:

```kotlin
            "server" -> { closeSwitcher(); nav.push(Nav.Server); openServer() }
```

`Nav` に `Server` が無ければ `NavModel.kt` に追加（既存 `Notify`/`Log` に倣う。`NavModelTest` があるので同パターンで足す）。`openServer()`:

```kotlin
    private fun openServer() { serverPanel.show() }
```

- [ ] **Step 3: 初回誘導 — 未設定なら起動時に設定パネルを自動表示**

`onCreate` の末尾（スクリーン初期化後）に追加:

```kotlin
        // 接続先が未設定（シードも不可）なら、localhost へは繋がず設定パネルを促す。
        if (serverConfig.origin() == null) { nav.ensureSwitcher("settings"); openServer() }
```

- [ ] **Step 4: Build**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL。

- [ ] **Step 5: 実機/エミュレータで手動検証（verify スキル推奨）**

1. 設定タブに「接続先」カードが出る。タップで `server.html` が開く。
2. ホストに `192.0.2.10` → IP 拒否文言、保存ボタン不活性。正しい FQDN → 活性。
3. 保存 → トースト「接続先を更新しました」、新オリジンでスクリーンが開き直る。
4. 「参照」→ ディレクトリ一覧が出て降下・「ここを選択」でフォルダ確定。未接続時は「サーバに接続すると参照できます」。
5. アプリを強制終了 → 再起動で接続先が保持されている。
6. 未設定状態（`server.json` 削除）で起動 → 設定パネルが自動表示され、localhost に繋ぎに行かない。

- [ ] **Step 6: Commit**

```bash
git add app/src/main/assets/server.html app/src/main/java/app/ccstudio/MainActivity.kt app/src/main/java/app/ccstudio/NavModel.kt
git commit -m "feat: 接続先設定 UI（server.html）とパネル結線・初回誘導"
```

---

## Task 8: バックアップ対象に server.json を明示

**Files:**
- Create: `app/src/main/res/xml/backup_rules.xml`
- Create: `app/src/main/res/xml/data_extraction_rules.xml`
- Modify: `app/src/main/AndroidManifest.xml:13-14`

**Interfaces:** なし（構成のみ）。ビルドで検証。

- [ ] **Step 1: backup ルールを作成**

`res/xml/backup_rules.xml`（Android 11 以前, `fullBackupContent`）:

```xml
<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <include domain="file" path="server.json"/>
</full-backup-content>
```

`res/xml/data_extraction_rules.xml`（Android 12+, `dataExtractionRules`）:

```xml
<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <include domain="file" path="server.json"/>
    </cloud-backup>
    <device-transfer>
        <include domain="file" path="server.json"/>
    </device-transfer>
</data-extraction-rules>
```

- [ ] **Step 2: Manifest の `<application>` に属性を追加**

`AndroidManifest.xml` の `<application ... android:allowBackup="true"` に隣接して:

```xml
        android:fullBackupContent="@xml/backup_rules"
        android:dataExtractionRules="@xml/data_extraction_rules"
```

- [ ] **Step 3: Build**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL。

- [ ] **Step 4: Commit**

```bash
git add app/src/main/res/xml/backup_rules.xml app/src/main/res/xml/data_extraction_rules.xml app/src/main/AndroidManifest.xml
git commit -m "feat: server.json をバックアップ対象に明示（再インストール/機種変で復元）"
```

---

## 完了条件

- `./gradlew :app:testDebugUnitTest` と `node --test server/notify-relay/relay.test.mjs` が全 PASS。
- `./gradlew :app:assembleDebug` が成功。
- 実機で Task 7 Step 4 の手動検証項目がすべて通る。
- コミット・テスト・ドキュメントに実環境データが無い（`git grep -IiE 'taildf47|/home/[^ ]*shimi|100\.64'` が空）。
