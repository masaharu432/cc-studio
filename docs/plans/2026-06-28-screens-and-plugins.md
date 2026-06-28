# Screens（複数スクリーン切替）+ Plugins システムスクリーン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 別フォルダで開いた複数の VS Code を「スクリーン」として並行保持・切替でき、Plugins を全画面の消せないシステムスクリーンとして管理できるようにする。

**Architecture:** 全スクリーン＝1つの `FrameLayout` 内で visibility 切替する WebView（Web=code-server / System=ローカル HTML）。︙ から全画面 switcher（オーバーレイ WebView）を開く。プラグインは拡張同等の document-start 登録で、反映はスクリーン単位リロード。純ロジックは JVM ユニットテストで TDD、WebView/Activity/HTML 統合はビルド＋手動検証。

**Tech Stack:** Kotlin, Android WebView, androidx.webkit (`addDocumentStartJavaScript`), JUnit4。設計書: [docs/specs/2026-06-28-screens-and-plugins-design.md](../specs/2026-06-28-screens-and-plugins-design.md)。デザインモック: [docs/design/screens-mock.html](../design/screens-mock.html)。

## Global Constraints

- 用語は **Screen / スクリーン** と **Plugin / プラグイン** に統一（"タブ/ウィンドウ/画面(単位)/拡張機能" 禁止。"全画面"=fullscreen は可）。UI 文字列・コメント・コミットメッセージすべてに適用。
- 配色規律: **青=アクティブスクリーン/ナビ**、**エメラルド=有効プラグインのみ**、**琥珀=中断警告のみ**。
- minSdk 26 / targetSdk 34 / compileSdk 34 / JVM 17 / Kotlin。
- 既存パッケージ `app.ccstudio`。
- プラグイン注入土台は既存 `ExtensionRuntime`（document-start×全フレーム）を使う。`evaluateJavascript` 単発注入の常用は新設しない（反映はリロード）。
- 起動 URL は既存定数 `TARGET_URL`（code-server の `?folder=...`）。
- 各タスク末尾でコミット。Android 統合タスクは `./gradlew assembleDebug` がグリーンであることを確認してからコミット。

---

## ファイル構成

新規（純ロジック・JVM テスト可）:
- `app/src/main/java/net/<tailnet>/ccstudio/PluginMeta.kt` — `.js` メタヘッダ解析
- `app/src/main/java/net/<tailnet>/ccstudio/ScreenUrl.kt` — URL→フォルダ名/パス抽出
- `app/src/main/java/net/<tailnet>/ccstudio/ScreenState.kt` — 永続化のエンコード/デコード（純）
- `app/src/main/java/net/<tailnet>/ccstudio/ScreensJson.kt` — listScreens の JSON 構築
- `app/src/test/java/net/<tailnet>/ccstudio/*Test.kt` — 上記のテスト

新規（Android 統合）:
- `app/src/main/java/net/<tailnet>/ccstudio/Screen.kt`
- `app/src/main/java/net/<tailnet>/ccstudio/ScreenManager.kt`
- `app/src/main/java/net/<tailnet>/ccstudio/ScreenStore.kt`（`ScreenState` を SharedPreferences で包む薄い層）
- `app/src/main/assets/switcher.html`
- `app/src/main/assets/plugins.html`

変更:
- `app/build.gradle`（test 依存）
- `app/src/main/java/net/<tailnet>/ccstudio/PluginStore.kt`（メタ・組込み・enriched list）
- `app/src/main/java/net/<tailnet>/ccstudio/CcBridge.kt`（Screens 系メソッド）
- `app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt`（複数スクリーン化）
- `app/src/main/assets/bootstrap.js`（縮小）

---

## Task 1: テスト基盤 + PluginMeta 解析

**Files:**
- Modify: `app/build.gradle`
- Create: `app/src/main/java/net/<tailnet>/ccstudio/PluginMeta.kt`
- Test: `app/src/test/java/net/<tailnet>/ccstudio/PluginMetaTest.kt`

**Interfaces:**
- Produces: `data class PluginMeta(val name: String?, val version: String?, val description: String?, val hasSettings: Boolean)` と `object PluginMetaParser { fun parse(script: String): PluginMeta }`

- [ ] **Step 1: build.gradle に test 依存を追加**

`dependencies { }` 内に追記:
```groovy
    testImplementation 'junit:junit:4.13.2'
    testImplementation 'org.json:json:20240303'
```

- [ ] **Step 2: 失敗するテストを書く**

`app/src/test/java/net/<tailnet>/ccstudio/PluginMetaTest.kt`:
```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PluginMetaTest {
    @Test fun parsesFullHeader() {
        val js = """
            // ==CCStudioPlugin==
            // @name        keyboard-suppress
            // @version     1.2.0
            // @description 物理キーボードの自動表示を抑制する。
            // @settings    true
            // ==/CCStudioPlugin==
            (function(){})();
        """.trimIndent()
        val m = PluginMetaParser.parse(js)
        assertEquals("keyboard-suppress", m.name)
        assertEquals("1.2.0", m.version)
        assertEquals("物理キーボードの自動表示を抑制する。", m.description)
        assertTrue(m.hasSettings)
    }

    @Test fun missingHeaderYieldsEmptyMeta() {
        val m = PluginMetaParser.parse("(function(){})();")
        assertNull(m.name)
        assertNull(m.version)
        assertNull(m.description)
        assertFalse(m.hasSettings)
    }

    @Test fun settingsFalseOrAbsentIsFalse() {
        val js = "// ==CCStudioPlugin==\n// @version 0.1\n// ==/CCStudioPlugin==\n"
        val m = PluginMetaParser.parse(js)
        assertEquals("0.1", m.version)
        assertFalse(m.hasSettings)
    }
}
```

- [ ] **Step 3: 失敗を確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.PluginMetaTest"`
Expected: コンパイル/解決エラー（`PluginMetaParser` 未定義）で FAIL。

- [ ] **Step 4: 最小実装**

`app/src/main/java/net/<tailnet>/ccstudio/PluginMeta.kt`:
```kotlin
package app.ccstudio

/** .js 先頭の userscript 風メタヘッダから取り出すプラグイン情報。 */
data class PluginMeta(
    val name: String?,
    val version: String?,
    val description: String?,
    val hasSettings: Boolean,
)

/** `// ==CCStudioPlugin==` … `// ==/CCStudioPlugin==` ブロックを解析する。純関数。 */
object PluginMetaParser {
    private val FIELD = Regex("""^//\s*@(\w+)\s+(.*\S)\s*$""")

    fun parse(script: String): PluginMeta {
        val lines = script.lineSequence().take(40).toList()
        val start = lines.indexOfFirst { it.contains("==CCStudioPlugin==") }
        if (start < 0) return PluginMeta(null, null, null, false)
        val fields = HashMap<String, String>()
        for (i in (start + 1) until lines.size) {
            val line = lines[i]
            if (line.contains("==/CCStudioPlugin==")) break
            val m = FIELD.find(line.trim()) ?: continue
            fields[m.groupValues[1].lowercase()] = m.groupValues[2]
        }
        return PluginMeta(
            name = fields["name"],
            version = fields["version"],
            description = fields["description"],
            hasSettings = fields["settings"]?.equals("true", ignoreCase = true) == true,
        )
    }
}
```

- [ ] **Step 5: テスト成功を確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.PluginMetaTest"`
Expected: PASS（3 tests）。

- [ ] **Step 6: コミット**

```bash
git add app/build.gradle app/src/main/java/net/<tailnet>/ccstudio/PluginMeta.kt app/src/test/java/net/<tailnet>/ccstudio/PluginMetaTest.kt
git commit -m "feat(plugins): PluginMeta header parser + JUnit test infra"
```

---

## Task 2: ScreenUrl（URL→フォルダ名/パス）

**Files:**
- Create: `app/src/main/java/net/<tailnet>/ccstudio/ScreenUrl.kt`
- Test: `app/src/test/java/net/<tailnet>/ccstudio/ScreenUrlTest.kt`

**Interfaces:**
- Produces: `object ScreenUrl { fun folderPath(url: String): String?; fun folderName(url: String): String }`
  - `folderPath`: `?folder=` の値を URL デコードして返す。無ければ null。
  - `folderName`: フォルダの basename。`?folder=` 無しならホスト名。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/test/java/net/<tailnet>/ccstudio/ScreenUrlTest.kt`:
```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ScreenUrlTest {
    @Test fun extractsFolderPath() {
        val url = "https://h.ts.net/?folder=/mnt/win/Develop/cc-studio"
        assertEquals("/mnt/win/Develop/cc-studio", ScreenUrl.folderPath(url))
    }

    @Test fun decodesPercentEncoding() {
        val url = "https://h.ts.net/?folder=/home/a%20b/%E6%A0%AA"
        assertEquals("/home/a b/株", ScreenUrl.folderPath(url))
    }

    @Test fun folderNameIsBasename() {
        val url = "https://h.ts.net/?folder=/mnt/win/Develop/cc-studio"
        assertEquals("cc-studio", ScreenUrl.folderName(url))
    }

    @Test fun noFolderFallsBackToHost() {
        val url = "https://<tailnet-host>/"
        assertNull(ScreenUrl.folderPath(url))
        assertEquals("<tailnet-host>", ScreenUrl.folderName(url))
    }
}
```

- [ ] **Step 2: 失敗を確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.ScreenUrlTest"`
Expected: FAIL（`ScreenUrl` 未定義）。

- [ ] **Step 3: 最小実装**

`app/src/main/java/net/<tailnet>/ccstudio/ScreenUrl.kt`:
```kotlin
package app.ccstudio

import java.net.URI
import java.net.URLDecoder

/** code-server の URL から「開いているフォルダ」を読み取る純ヘルパー。 */
object ScreenUrl {
    fun folderPath(url: String): String? {
        val q = url.substringAfter('?', "").ifEmpty { return null }
        for (pair in q.split('&')) {
            val k = pair.substringBefore('=')
            if (k == "folder") {
                val v = pair.substringAfter('=', "")
                return try { URLDecoder.decode(v, "UTF-8") } catch (_: Exception) { v }
            }
        }
        return null
    }

    fun folderName(url: String): String {
        folderPath(url)?.let { p ->
            val trimmed = p.trimEnd('/')
            val base = trimmed.substringAfterLast('/')
            if (base.isNotEmpty()) return base
        }
        return try { URI(url).host ?: url } catch (_: Exception) { url }
    }
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.ScreenUrlTest"`
Expected: PASS（4 tests）。

- [ ] **Step 5: コミット**

```bash
git add app/src/main/java/net/<tailnet>/ccstudio/ScreenUrl.kt app/src/test/java/net/<tailnet>/ccstudio/ScreenUrlTest.kt
git commit -m "feat(screens): ScreenUrl folder name/path extraction"
```

---

## Task 3: ScreenState（永続化のシリアライズ）

**Files:**
- Create: `app/src/main/java/net/<tailnet>/ccstudio/ScreenState.kt`
- Test: `app/src/test/java/net/<tailnet>/ccstudio/ScreenStateTest.kt`

**Interfaces:**
- Produces:
  - `data class ScreenState(val urls: List<String>, val activeIndex: Int)`
  - `object ScreenStateCodec { fun encode(s: ScreenState): String; fun decode(text: String?): ScreenState }`
- 形式: 1行目=activeIndex、2行目以降=URL（1行1件）。URL に改行は無いので安全。空/壊れは `ScreenState(emptyList(), 0)`。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/test/java/net/<tailnet>/ccstudio/ScreenStateTest.kt`:
```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class ScreenStateTest {
    @Test fun roundTrips() {
        val s = ScreenState(listOf("https://h/?folder=/a", "https://h/?folder=/b"), 1)
        val decoded = ScreenStateCodec.decode(ScreenStateCodec.encode(s))
        assertEquals(s.urls, decoded.urls)
        assertEquals(1, decoded.activeIndex)
    }

    @Test fun decodeNullIsEmpty() {
        val d = ScreenStateCodec.decode(null)
        assertEquals(emptyList<String>(), d.urls)
        assertEquals(0, d.activeIndex)
    }

    @Test fun activeIndexClampedToRange() {
        val d = ScreenStateCodec.decode("9\nhttps://h/?folder=/a")
        assertEquals(0, d.activeIndex) // 範囲外は 0 に丸める
        assertEquals(1, d.urls.size)
    }
}
```

- [ ] **Step 2: 失敗を確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.ScreenStateTest"`
Expected: FAIL。

- [ ] **Step 3: 最小実装**

`app/src/main/java/net/<tailnet>/ccstudio/ScreenState.kt`:
```kotlin
package app.ccstudio

/** 復元対象＝Web スクリーンの URL 群＋アクティブ index。System スクリーンは含めない。 */
data class ScreenState(val urls: List<String>, val activeIndex: Int)

object ScreenStateCodec {
    fun encode(s: ScreenState): String =
        (listOf(s.activeIndex.toString()) + s.urls).joinToString("\n")

    fun decode(text: String?): ScreenState {
        if (text.isNullOrBlank()) return ScreenState(emptyList(), 0)
        val lines = text.split("\n")
        val urls = lines.drop(1).filter { it.isNotBlank() }
        val idx = lines.firstOrNull()?.toIntOrNull() ?: 0
        val safeIdx = if (urls.isEmpty() || idx !in urls.indices) 0 else idx
        return ScreenState(urls, safeIdx)
    }
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.ScreenStateTest"`
Expected: PASS（3 tests）。

- [ ] **Step 5: コミット**

```bash
git add app/src/main/java/net/<tailnet>/ccstudio/ScreenState.kt app/src/test/java/net/<tailnet>/ccstudio/ScreenStateTest.kt
git commit -m "feat(screens): ScreenState codec for persistence"
```

---

## Task 4: ScreensJson（listScreens の JSON 構築）

**Files:**
- Create: `app/src/main/java/net/<tailnet>/ccstudio/ScreensJson.kt`
- Test: `app/src/test/java/net/<tailnet>/ccstudio/ScreensJsonTest.kt`

**Interfaces:**
- Produces: `object ScreensJson { fun build(rows: List<ScreenRow>): String }`
  - `data class ScreenRow(val id: Long, val title: String, val path: String?, val kind: String, val active: Boolean, val closeable: Boolean, val stale: Boolean)`
  - JSON 配列 `[{id,title,path,kind,active,closeable,stale}]`（path が null なら空文字）。
- Consumes: なし（`ScreenManager` が `ScreenRow` を組んで渡す）。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/test/java/net/<tailnet>/ccstudio/ScreensJsonTest.kt`:
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
            ScreenRow(3, "cc-web", "/mnt/cc-web", "WEB", false, true, true),
        ))
        val arr = JSONArray(json)
        assertEquals(3, arr.length())
        val plugins = arr.getJSONObject(0)
        assertEquals("Plugins", plugins.getString("title"))
        assertEquals(false, plugins.getBoolean("closeable"))
        assertEquals("", plugins.getString("path"))
        val web = arr.getJSONObject(2)
        assertEquals("cc-web", web.getString("title"))
        assertTrue(web.getBoolean("stale"))
        assertEquals(true, web.getBoolean("closeable"))
    }
}
```

- [ ] **Step 2: 失敗を確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.ScreensJsonTest"`
Expected: FAIL。

- [ ] **Step 3: 最小実装**

`app/src/main/java/net/<tailnet>/ccstudio/ScreensJson.kt`:
```kotlin
package app.ccstudio

import org.json.JSONArray
import org.json.JSONObject

data class ScreenRow(
    val id: Long,
    val title: String,
    val path: String?,
    val kind: String,        // "WEB" | "SYSTEM_PLUGINS"
    val active: Boolean,
    val closeable: Boolean,
    val stale: Boolean,
)

object ScreensJson {
    fun build(rows: List<ScreenRow>): String {
        val arr = JSONArray()
        for (r in rows) {
            arr.put(
                JSONObject()
                    .put("id", r.id)
                    .put("title", r.title)
                    .put("path", r.path ?: "")
                    .put("kind", r.kind)
                    .put("active", r.active)
                    .put("closeable", r.closeable)
                    .put("stale", r.stale)
            )
        }
        return arr.toString()
    }
}
```

- [ ] **Step 4: テスト成功を確認**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.ScreensJsonTest"`
Expected: PASS。

- [ ] **Step 5: 全ユニットテストを通す**

Run: `./gradlew :app:testDebugUnitTest`
Expected: 全 PASS（Task1-4）。

- [ ] **Step 6: コミット**

```bash
git add app/src/main/java/net/<tailnet>/ccstudio/ScreensJson.kt app/src/test/java/net/<tailnet>/ccstudio/ScreensJsonTest.kt
git commit -m "feat(screens): ScreensJson builder for listScreens bridge"
```

---

## Task 5: PluginStore に メタ・組込み・enriched list を追加

**Files:**
- Modify: `app/src/main/java/net/<tailnet>/ccstudio/PluginStore.kt`

**Interfaces:**
- Produces:
  - `PluginInfo` を拡張: `data class PluginInfo(val name, val size, val enabled, val version: String?, val description: String?, val hasSettings: Boolean, val bundled: Boolean)`
  - `fun ensureBundledInstalled()` — 初回起動時に `assets/keyboard-suppress.js` を `plugins/` に取り込み既定 ON。
  - 既存 `list()` を enriched（`PluginMetaParser` 利用、bundled 判定）に。
- Consumes: `PluginMetaParser.parse`（Task 1）。

> 注: これらは Android `Context`/ファイルに触れるため JVM 単体テストはせず、コンパイル＋後続の手動検証で担保する（解析ロジック自体は Task 1 でテスト済み）。

- [ ] **Step 1: PluginInfo を拡張し list() を enriched に**

`PluginInfo` 定義を置換:
```kotlin
data class PluginInfo(
    val name: String,
    val size: Long,
    val enabled: Boolean,
    val version: String?,
    val description: String?,
    val hasSettings: Boolean,
    val bundled: Boolean,
)
```
`list()` を置換:
```kotlin
    fun list(): List<PluginInfo> {
        val enabled = enabledSet()
        val bundledNames = BUNDLED.keys
        return pluginsDir()
            .listFiles { f -> f.isFile && f.name.endsWith(".js", ignoreCase = true) }
            ?.sortedBy { it.name.lowercase() }
            ?.map { f ->
                val meta = PluginMetaParser.parse(f.readText())
                PluginInfo(
                    name = f.name,
                    size = f.length(),
                    enabled = enabled.contains(f.name),
                    version = meta.version,
                    description = meta.description,
                    hasSettings = meta.hasSettings,
                    bundled = bundledNames.contains(f.name),
                )
            }
            ?: emptyList()
    }
```

- [ ] **Step 2: 組込みプラグインの取り込みを追加**

クラス内に追記:
```kotlin
    companion object {
        /** 組込み（バンドル）プラグイン: ファイル名 → assets パス。既定 ON で初回投入。 */
        val BUNDLED = mapOf("keyboard-suppress.js" to "keyboard-suppress.js")
    }

    /** 初回のみ、組込みプラグインを plugins/ に取り込み既定 ON にする。削除済みなら再投入しない。 */
    fun ensureBundledInstalled() {
        if (prefs.getBoolean("bundled_installed", false)) {
            return
        }
        for ((name, asset) in BUNDLED) {
            val out = fileFor(name) ?: continue
            if (!out.exists()) {
                try {
                    context.assets.open(asset).use { input ->
                        out.outputStream().use { input.copyTo(it) }
                    }
                    enable(name, true)
                } catch (_: Exception) { /* 取り込み失敗は無視（次回再試行しない） */ }
            }
        }
        prefs.edit().putBoolean("bundled_installed", true).apply()
    }
```

- [ ] **Step 3: コンパイル確認**

Run: `./gradlew :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL（`pluginsJson()` 等の呼び出し側は Task 7 で更新するため、まだ参照ズレが出る場合は本タスクの変更範囲のみ確認。エラーが出る場合は次タスクで解消する旨を確認）。

> 補足: 既存 `MainActivity.pluginsJson()` は `PluginInfo` の新フィールドを使わなくてもコンパイルは通る（put し忘れても型は合う）。通らない場合は Task 7 まで一時的に最小修正で通す。

- [ ] **Step 4: コミット**

```bash
git add app/src/main/java/net/<tailnet>/ccstudio/PluginStore.kt
git commit -m "feat(plugins): enriched PluginInfo (version/desc/settings/bundled) + bundled install"
```

---

## Task 6: Screen + ScreenManager

**Files:**
- Create: `app/src/main/java/net/<tailnet>/ccstudio/Screen.kt`
- Create: `app/src/main/java/net/<tailnet>/ccstudio/ScreenManager.kt`

**Interfaces:**
- Produces:
  - `enum class ScreenKind { WEB, SYSTEM_PLUGINS }`
  - `class Screen(id, kind, webView)` with `var url, var title, var loadedGeneration, val closeable, pluginHandlers, kbHandler`
  - `class ScreenManager(container: FrameLayout)`:
    - `fun add(screen: Screen)` / `fun activeOrNull(): Screen?` / `fun active(): Screen`
    - `fun byId(id: Long): Screen?` / `fun select(id: Long)` / `fun close(id: Long): Boolean`
    - `fun webScreens(): List<Screen>` / `fun all(): List<Screen>`
    - `fun rows(currentGeneration: Int): List<ScreenRow>`（ScreensJson 用）
    - `fun nextId(): Long`
- Consumes: `ScreenRow`（Task 4）、`ScreenUrl`（Task 2）、androidx.webkit `ScriptHandler`。

> 検証: Android View に触れるためコンパイル＋手動。

- [ ] **Step 1: Screen.kt を作成**

```kotlin
package app.ccstudio

import android.webkit.WebView
import androidx.webkit.ScriptHandler

enum class ScreenKind { WEB, SYSTEM_PLUGINS }

/** 1スクリーン。WEB=code-server / SYSTEM_PLUGINS=ローカル plugins.html。 */
class Screen(
    val id: Long,
    val kind: ScreenKind,
    val webView: WebView,
) {
    var url: String = ""
    var title: String = ""
    var loadedGeneration: Int = 0
    val closeable: Boolean get() = kind == ScreenKind.WEB
    val pluginHandlers: MutableMap<String, ScriptHandler> = mutableMapOf()
    var kbHandler: ScriptHandler? = null

    val kindTag: String get() = when (kind) {
        ScreenKind.WEB -> "WEB"
        ScreenKind.SYSTEM_PLUGINS -> "SYSTEM_PLUGINS"
    }
}
```

- [ ] **Step 2: ScreenManager.kt を作成**

```kotlin
package app.ccstudio

import android.view.View
import android.widget.FrameLayout

/**
 * スクリーン集合とアクティブを管理し、表示は visibility 切替（A案）。
 * System スクリーン（Plugins）は先頭固定・close 不可。
 */
class ScreenManager(private val container: FrameLayout) {
    private val screens = mutableListOf<Screen>()
    private var activeId: Long = -1
    private var idSeq: Long = 0

    fun nextId(): Long = ++idSeq

    fun add(screen: Screen) {
        screens.add(screen)
        container.addView(
            screen.webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        screen.webView.visibility = View.GONE
        if (activeId == -1L) select(screen.id)
    }

    fun all(): List<Screen> = screens.toList()
    fun webScreens(): List<Screen> = screens.filter { it.kind == ScreenKind.WEB }
    fun byId(id: Long): Screen? = screens.firstOrNull { it.id == id }
    fun activeOrNull(): Screen? = byId(activeId)
    fun active(): Screen = activeOrNull() ?: screens.first()

    fun select(id: Long) {
        val target = byId(id) ?: return
        activeId = id
        for (s in screens) s.webView.visibility =
            if (s.id == id) View.VISIBLE else View.GONE
        target.webView.requestFocus()
    }

    /** Web スクリーンを閉じる。閉じたら隣をアクティブ化。System は閉じない。 */
    fun close(id: Long): Boolean {
        val s = byId(id) ?: return false
        if (!s.closeable) return false
        val wasActive = id == activeId
        val idx = screens.indexOf(s)
        screens.remove(s)
        container.removeView(s.webView)
        s.webView.destroy()
        if (wasActive) {
            val next = screens.getOrNull(idx) ?: screens.lastOrNull()
            if (next != null) select(next.id) else activeId = -1
        }
        return true
    }

    /** switcher 用の行データ。Plugins を先頭に、続いて Web を追加順で。 */
    fun rows(currentGeneration: Int): List<ScreenRow> = screens.map { s ->
        ScreenRow(
            id = s.id,
            title = if (s.kind == ScreenKind.WEB) ScreenUrl.folderName(s.url) else s.title,
            path = if (s.kind == ScreenKind.WEB) ScreenUrl.folderPath(s.url) else null,
            kind = s.kindTag,
            active = s.id == activeId,
            closeable = s.closeable,
            stale = s.kind == ScreenKind.WEB && s.loadedGeneration < currentGeneration,
        )
    }
}
```

- [ ] **Step 3: コンパイル確認**

Run: `./gradlew :app:compileDebugKotlin`
Expected: 本ファイル群はエラー無し（MainActivity 側の旧コードは Task 7 で更新）。

- [ ] **Step 4: コミット**

```bash
git add app/src/main/java/net/<tailnet>/ccstudio/Screen.kt app/src/main/java/net/<tailnet>/ccstudio/ScreenManager.kt
git commit -m "feat(screens): Screen + ScreenManager (visibility switching, rows, close)"
```

---

## Task 7: ScreenStore + CcBridge 拡張

**Files:**
- Create: `app/src/main/java/net/<tailnet>/ccstudio/ScreenStore.kt`
- Modify: `app/src/main/java/net/<tailnet>/ccstudio/CcBridge.kt`

**Interfaces:**
- Produces:
  - `class ScreenStore(context)`: `fun load(): ScreenState` / `fun save(urls: List<String>, activeIndex: Int)`
  - `CcBridge` に追加コールバック＆ @JavascriptInterface:
    - `openSwitcher()` / `closeSwitcher()` / `listScreens(): String` / `selectScreen(id: String)` / `reloadScreen(id: String)` / `closeScreen(id: String)` / `newScreen()`
- Consumes: `ScreenStateCodec`（Task 3）。

- [ ] **Step 1: ScreenStore.kt を作成**

```kotlin
package app.ccstudio

import android.content.Context

/** Web スクリーンの URL 群＋アクティブ index を SharedPreferences に保存/復元する薄い層。 */
class ScreenStore(context: Context) {
    private val prefs = context.getSharedPreferences("ccstudio_prefs", Context.MODE_PRIVATE)

    fun load(): ScreenState = ScreenStateCodec.decode(prefs.getString("screens_state", null))

    fun save(urls: List<String>, activeIndex: Int) {
        prefs.edit()
            .putString("screens_state", ScreenStateCodec.encode(ScreenState(urls, activeIndex)))
            .apply()
    }
}
```

- [ ] **Step 2: CcBridge に Screens 系を追加**

`CcBridge` のコンストラクタ引数末尾に追加（既存引数は維持）:
```kotlin
    private val onOpenSwitcher: () -> Unit,
    private val onCloseSwitcher: () -> Unit,
    private val screensJsonFn: () -> String,
    private val onSelectScreen: (id: Long) -> Unit,
    private val onReloadScreen: (id: Long) -> Unit,
    private val onCloseScreen: (id: Long) -> Unit,
    private val onNewScreen: () -> Unit,
```
クラス本体に追加:
```kotlin
    @JavascriptInterface fun openSwitcher() = onOpenSwitcher()
    @JavascriptInterface fun closeSwitcher() = onCloseSwitcher()
    @JavascriptInterface fun listScreens(): String = screensJsonFn()
    @JavascriptInterface fun selectScreen(id: String) { id.toLongOrNull()?.let(onSelectScreen) }
    @JavascriptInterface fun reloadScreen(id: String) { id.toLongOrNull()?.let(onReloadScreen) }
    @JavascriptInterface fun closeScreen(id: String) { id.toLongOrNull()?.let(onCloseScreen) }
    @JavascriptInterface fun newScreen() = onNewScreen()
```

- [ ] **Step 3: コンパイル確認（MainActivity 未更新なので失敗想定）**

Run: `./gradlew :app:compileDebugKotlin`
Expected: `MainActivity` の `CcBridge(...)` 生成箇所で引数不足エラー。Task 8 で解消する。ここでは ScreenStore/CcBridge 自体に文法エラーが無いことを確認。

- [ ] **Step 4: コミット**

```bash
git add app/src/main/java/net/<tailnet>/ccstudio/ScreenStore.kt app/src/main/java/net/<tailnet>/ccstudio/CcBridge.kt
git commit -m "feat(screens): ScreenStore persistence + CcBridge screen methods"
```

---

## Task 8: MainActivity を複数スクリーン化

**Files:**
- Modify: `app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt`

**Interfaces:**
- Consumes: `ScreenManager`, `Screen(Kind)`, `ScreenStore`, `ScreensJson`(via ScreenManager.rows), `CcBridge` 新シグネチャ, `PluginStore.ensureBundledInstalled/list`。
- Produces: 実行可能な複数スクリーンアプリ（switcher オーバーレイ含む）。

> 検証: ビルド＋手動（実機/エミュ）。本タスクは大きいので段階的に。

- [ ] **Step 1: フィールドと onCreate を複数スクリーン構成に置換**

`MainActivity` 先頭フィールドを変更:
```kotlin
    private lateinit var root: android.widget.FrameLayout
    private lateinit var screens: ScreenManager
    private lateinit var store: PluginStore
    private lateinit var screenStore: ScreenStore
    private var switcher: WebView? = null
    private var pluginGeneration: Int = 0
    private var keyboardSuppressJs: String? = null  // 互換: 旧フォールバック用（§5）
```
`onCreate` の本体（既存 webView 構築〜loadUrl〜back）を次の構成に置換:
```kotlin
        requestNotificationPermissionIfNeeded()
        ContextCompat.startForegroundService(this, Intent(this, KeepAliveService::class.java))

        store = PluginStore(this)
        store.ensureBundledInstalled()
        screenStore = ScreenStore(this)
        keyboardSuppressJs = assetText("keyboard-suppress.js")

        root = android.widget.FrameLayout(this)
        setContentView(root)
        screens = ScreenManager(root)

        // 1) Plugins システムスクリーン（先頭・固定）
        screens.add(createSystemPluginsScreen())

        // 2) 復元 or 既定の Web スクリーン
        val state = screenStore.load()
        if (state.urls.isEmpty()) {
            screens.add(createWebScreen(TARGET_URL))
        } else {
            state.urls.forEach { screens.add(createWebScreen(it)) }
        }
        // アクティブ Web スクリーンを選択（System は先頭だが、起動時は Web を見せる）
        val webList = screens.webScreens()
        val activeWeb = webList.getOrNull(state.activeIndex) ?: webList.firstOrNull()
        activeWeb?.let { screens.select(it.id) }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val sw = switcher
                if (sw != null && sw.visibility == android.view.View.VISIBLE) { closeSwitcher(); return }
                val a = screens.activeOrNull()
                if (a != null && a.webView.canGoBack()) a.webView.goBack() else finish()
            }
        })
```

- [ ] **Step 2: WebView ファクトリと共通設定を追加**

`MainActivity` にメソッド追加:
```kotlin
    @SuppressLint("SetJavaScriptEnabled")
    private fun newConfiguredWebView(): WebView = WebView(this).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                return try { pickFiles.launch(fileChooserParams.createIntent()); true }
                catch (e: Exception) { fileChooserCallback = null; toast("ファイル選択を開けませんでした"); false }
            }
        }
        setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            handleDownload(url, contentDisposition, mimeType)
        }
        addJavascriptInterface(buildBridge(), "CCStudio")
    }

    private fun createWebScreen(url: String): Screen {
        val wv = newConfiguredWebView()
        val screen = Screen(screens.nextId(), ScreenKind.WEB, wv)
        screen.url = url
        wv.webViewClient = object : WebViewClient() {
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                if (url != null) { screen.url = url; persistScreens() }
            }
            override fun onPageFinished(view: WebView, url: String?) {
                injectAssetInto(view, "bootstrap.js")
                if (!ExtensionRuntime.isDocumentStartSupported()) {
                    store.enabledScripts().forEach { view.evaluateJavascript(it, null) }
                }
                if (url != null) screen.url = url
                screen.loadedGeneration = pluginGeneration
                persistScreens()
            }
        }
        registerScreenScripts(screen)   // kb + 有効プラグインを document-start 登録
        wv.loadUrl(url)
        return screen
    }

    private fun createSystemPluginsScreen(): Screen {
        val wv = newConfiguredWebView()
        val screen = Screen(screens.nextId(), ScreenKind.SYSTEM_PLUGINS, wv)
        screen.title = "Plugins"
        wv.webViewClient = WebViewClient()
        wv.loadUrl("file:///android_asset/plugins.html")
        return screen
    }
```

- [ ] **Step 3: ブリッジ生成・switcher・プラグイン同期・永続化を追加**

```kotlin
    private fun buildBridge(): CcBridge = CcBridge(
        onPick = { runOnUiThread { pickJs.launch("*/*") } },
        listJsonFn = { pluginsJson() },
        onSetEnabled = { name, enabled ->
            store.enable(name, enabled)
            runOnUiThread { bumpGenerationAndSync() }
        },
        onRemove = { name -> store.remove(name); runOnUiThread { bumpGenerationAndSync(); refreshActivePanel() } },
        onSave = { name, mime, b64 -> saveBase64Download(name, mime, b64) },
        onSaveFailed = { msg -> runOnUiThread { toast("ダウンロードに失敗しました") }; Log.w("CcStudio", "dl: $msg") },
        buildLabel = BuildConfig.BUILD_LABEL,
        onOpenSwitcher = { runOnUiThread { openSwitcher() } },
        onCloseSwitcher = { runOnUiThread { closeSwitcher() } },
        screensJsonFn = { ScreensJson.build(screens.rows(pluginGeneration)) },
        onSelectScreen = { id -> runOnUiThread { closeSwitcher(); screens.select(id) } },
        onReloadScreen = { id -> runOnUiThread { closeSwitcher(); screens.byId(id)?.let { reloadScreen(it) } } },
        onCloseScreen = { id -> runOnUiThread { screens.close(id); persistScreens(); refreshSwitcher() } },
        onNewScreen = { runOnUiThread { val s = createWebScreen(TARGET_URL); screens.add(s); screens.select(s.id); closeSwitcher() } },
    )

    private fun reloadScreen(s: Screen) {
        registerScreenScripts(s)   // 最新の有効集合で登録し直してから
        s.webView.reload()
    }

    /** kb（組込みは PluginStore 管理だが互換のため）＋有効プラグインを WEB スクリーンへ document-start 登録。 */
    private fun registerScreenScripts(s: Screen) {
        if (s.kind != ScreenKind.WEB) return
        if (!ExtensionRuntime.isDocumentStartSupported()) return
        val enabled = store.list().filter { it.enabled }.map { it.name }.toSet()
        val it = s.pluginHandlers.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (e.key !in enabled) { try { e.value.remove() } catch (_: Exception) {}; it.remove() }
        }
        for (name in enabled) {
            if (s.pluginHandlers.containsKey(name)) continue
            val js = store.script(name) ?: continue
            ExtensionRuntime.registerDocumentStart(s.webView, js)?.let { h -> s.pluginHandlers[name] = h }
        }
    }

    private fun bumpGenerationAndSync() {
        pluginGeneration++
        screens.webScreens().forEach { registerScreenScripts(it) }
        refreshSwitcher()
    }

    private fun persistScreens() {
        val urls = screens.webScreens().map { it.url }
        val activeIdx = screens.webScreens().indexOfFirst { it.id == screens.activeOrNull()?.id }
        screenStore.save(urls, if (activeIdx < 0) 0 else activeIdx)
    }

    private fun openSwitcher() {
        val sw = switcher ?: newConfiguredWebView().also {
            it.webViewClient = WebViewClient()
            it.loadUrl("file:///android_asset/switcher.html")
            root.addView(it, android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT))
            switcher = it
        }
        sw.visibility = android.view.View.VISIBLE
        sw.bringToFront()
        refreshSwitcher()
    }

    private fun closeSwitcher() { switcher?.visibility = android.view.View.GONE }
    private fun refreshSwitcher() {
        switcher?.evaluateJavascript("window.__ccRenderScreens && window.__ccRenderScreens();", null)
    }
    private fun refreshActivePanel() {
        screens.all().firstOrNull { it.kind == ScreenKind.SYSTEM_PLUGINS }
            ?.webView?.evaluateJavascript("window.__ccRenderPlugins && window.__ccRenderPlugins();", null)
    }
```

- [ ] **Step 4: 旧メソッドの整理**

- 旧 `injectAsset(name)`（単一 webView 依存）を `injectAssetInto(view: WebView, name: String)` に置換:
```kotlin
    private fun injectAssetInto(view: WebView, name: String) {
        val js = assetText(name) ?: return
        view.evaluateJavascript(js, null)
    }
```
- 旧 `injectActive`/`injectPlugin`/`syncPluginRegistrations`/`refreshPanel`/単一 `webView` フィールド参照を削除（上記新メソッドで置換済み）。
- `handleDownload` 内の `webView.evaluateJavascript(...)` は `screens.active().webView.evaluateJavascript(...)` に変更。
- `pluginsJson()` は `PluginInfo` の新フィールドを含めて返すよう更新（Task 9 の plugins.html が使う）:
```kotlin
    private fun pluginsJson(): String {
        val arr = JSONArray()
        store.list().forEach {
            arr.put(JSONObject()
                .put("name", it.name).put("size", it.size).put("enabled", it.enabled)
                .put("version", it.version ?: "").put("description", it.description ?: "")
                .put("hasSettings", it.hasSettings).put("bundled", it.bundled))
        }
        return arr.toString()
    }
```

- [ ] **Step 5: ビルド確認**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL（switcher.html/plugins.html がまだ無くても Kotlin はコンパイルされる。実行時に 404 になるだけ）。エラーがあれば未削除の旧 `webView` 参照を解消。

- [ ] **Step 6: コミット**

```bash
git add app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt
git commit -m "feat(screens): MainActivity multi-screen container, switcher overlay, per-screen plugin sync"
```

---

## Task 9: bootstrap.js 縮小（︙→openSwitcher ＋ DL フック）

**Files:**
- Modify: `app/src/main/assets/bootstrap.js`

> 検証: ビルド＋手動。Control Center パネル（タブ/Plugins UI）を撤去し、左端 ︙ ボタンと既存の createObjectURL/ダウンロードフックだけ残す。

- [ ] **Step 1: パネル描画ブロックを ︙→openSwitcher に置換**

`bootstrap.js` の先頭 IIFE（`BTN_ID`/`PANEL_ID` のパネル一式：おおよそ 1〜219 行）を次に置換。**ダウンロード関連の後半2つの IIFE（createObjectURL フック / ダウンロードフック、221 行目以降）はそのまま残す**:
```javascript
// CC Studio bootstrap — 左端の ︙ ボタンだけを描く。タップで全画面 switcher を開く。
// Control Center パネルは廃止し、管理UIは全画面スクリーン(plugins.html)へ移行した。冪等。
(function () {
  var BTN_ID = 'ccstudio-menu-btn';
  if (document.getElementById(BTN_ID)) return;
  var btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.textContent = '⋮';
  btn.style.cssText =
    'position:fixed;z-index:2147483647;left:0;bottom:22%;width:30px;height:84px;border:0;' +
    'border-radius:0 11px 11px 0;background:linear-gradient(180deg,#2E90E8,#1c6fc0);color:#fff;' +
    'font-size:19px;box-shadow:2px 0 10px rgba(0,0,0,.45);cursor:pointer;';
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    try { window.CCStudio.openSwitcher(); } catch (_) {}
  });
  document.body.appendChild(btn);
})();
```

- [ ] **Step 2: ビルド確認**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL。

- [ ] **Step 3: コミット**

```bash
git add app/src/main/assets/bootstrap.js
git commit -m "refactor(ui): shrink bootstrap.js to ︙→openSwitcher + keep download hooks"
```

---

## Task 10: switcher.html（全画面スクリーン切替）

**Files:**
- Create: `app/src/main/assets/switcher.html`

**Interfaces:**
- Consumes（ブリッジ）: `CCStudio.listScreens()`, `selectScreen(id)`, `reloadScreen(id)`, `closeScreen(id)`, `newScreen()`, `closeSwitcher()`。
- Produces: `window.__ccRenderScreens()`（ネイティブが再描画に呼ぶ）。

> 検証: ビルド＋手動。スタイルは [docs/design/screens-mock.html](../design/screens-mock.html) の switcher 部分（`:root` 変数・`.band`/`.band-row`/`.swipe-del`/`.dock`/`.bicon` 等）を移植する。本ファイルは**データ駆動**で描く。

- [ ] **Step 1: switcher.html を作成**

`<head>` の `<style>` には screens-mock.html の `:root` 変数群と switcher 関連クラス（`.bar .wordmark .title .build .summary .subnote .sw-body .band .band-row .band-main .band-name .band-path .bicon .swipe-del .dock .dock-h .band.sys .anchor .band.new` と reduced-motion）をコピーする。`<body>` と script は以下:
```html
<body>
  <div class="screen">
    <div class="bar">
      <span class="wordmark">CC<i>▍</i>STUDIO</span><span class="title">Screens</span>
      <span class="build" id="build"></span>
    </div>
    <div class="summary" id="summary"></div>
    <div class="subnote">タップで切替（そのまま）。⟳ でリロードして起動。左スワイプで削除。裏で実行中はそのまま。</div>
    <div class="sw-body" id="webList"></div>
    <div class="dock"><div class="dock-h">System</div><div id="sysList"></div></div>
  </div>
<script>
  function api(){ return window.CCStudio || {}; }
  function el(t,s){ var e=document.createElement(t); if(s) e.style.cssText=s; return e; }
  function screensData(){ try { return JSON.parse(api().listScreens()||'[]'); } catch(_){ return []; } }

  function makeWebBand(s){
    var row=document.createElement('div'); row.className='band-row';
    var del=document.createElement('button'); del.className='swipe-del';
    del.innerHTML='<span class="x">✕</span>削除';
    del.addEventListener('click',function(e){ e.stopPropagation(); try{ api().closeScreen(String(s.id)); }catch(_){ } });
    var band=document.createElement('div'); band.className='band'+(s.active?' active':'');
    var dot=el('span'); dot.className='fdot';
    var main=el('div'); main.className='band-main';
    var nm=el('div'); nm.className='band-name'; nm.textContent=s.title;
    var pa=el('div'); pa.className='band-path'; pa.textContent=s.path||'';
    main.appendChild(nm); main.appendChild(pa);
    var rb=document.createElement('button'); rb.className='bicon reload'+(s.stale?' stale':''); rb.textContent='⟳';
    rb.addEventListener('click',function(e){ e.stopPropagation(); onReload(s); });
    band.appendChild(dot); band.appendChild(main); band.appendChild(rb);
    // 左スワイプで削除を出す（簡易: タッチ移動量で .swiped 切替）
    var x0=null;
    band.addEventListener('touchstart',function(e){ x0=e.touches[0].clientX; });
    band.addEventListener('touchend',function(e){
      if(x0==null) return; var dx=e.changedTouches[0].clientX-x0;
      if(dx<-40){ row.classList.add('swiped'); }
      else if(dx>40){ row.classList.remove('swiped'); }
      else if(!row.classList.contains('swiped')){ try{ api().selectScreen(String(s.id)); }catch(_){ } }
      x0=null;
    });
    band.addEventListener('click',function(){ if(!row.classList.contains('swiped')){ try{ api().selectScreen(String(s.id)); }catch(_){ } } });
    row.appendChild(del); row.appendChild(band);
    return row;
  }

  function onReload(s){
    // 実行中の中断を警告（HTML ダイアログ）
    showConfirm(s.title, function(){ try{ api().reloadScreen(String(s.id)); }catch(_){ } },
                          function(){ try{ api().selectScreen(String(s.id)); }catch(_){ } });
  }

  function showConfirm(folder, onReload, onOpen){
    var bd=el('div'); bd.style.cssText='position:fixed;inset:0;background:rgba(6,9,13,.66);display:flex;align-items:center;justify-content:center;padding:22px;z-index:50;';
    var dg=el('div'); dg.style.cssText='width:100%;max-width:320px;background:linear-gradient(180deg,#161d27,#11151c);border:1px solid #2A3342;border-radius:16px;padding:18px 16px 16px;';
    dg.innerHTML='<div style="font:600 16px/1.3 sans-serif;color:#E8EDF4;margin-bottom:8px;">リロードして起動しますか？</div>'+
      '<div style="font:500 12.5px/1.65 sans-serif;color:#7C8694;margin-bottom:16px;"><b style="color:#E8EDF4;">'+folder+'</b> を再読込してプラグインの変更を反映します。<span style="color:#e8b07e;">このスクリーンで実行中の処理があれば中断されます。</span></div>';
    var row=el('div'); row.style.cssText='display:flex;gap:9px;';
    var b1=el('button'); b1.textContent='そのまま開く'; b1.style.cssText='flex:1;border-radius:10px;padding:13px;border:1px solid #2A3342;background:transparent;color:#7C8694;font:600 13px sans-serif;';
    var b2=el('button'); b2.textContent='リロード'; b2.style.cssText='flex:1;border-radius:10px;padding:13px;border:1px solid #1c6fc0;background:#2E90E8;color:#fff;font:600 13px sans-serif;';
    b1.onclick=function(){ document.body.removeChild(bd); onOpen(); };
    b2.onclick=function(){ document.body.removeChild(bd); onReload(); };
    row.appendChild(b1); row.appendChild(b2); dg.appendChild(row); bd.appendChild(dg); document.body.appendChild(bd);
  }

  function makeSysBand(s){
    var band=el('div'); band.className='band sys';
    band.innerHTML='<div class="sic">⌁</div><div class="band-main"><div class="band-name">'+s.title+'</div></div><div class="anchor">⚓</div>';
    band.addEventListener('click',function(){ try{ api().selectScreen(String(s.id)); }catch(_){ } });
    return band;
  }

  window.__ccRenderScreens=function(){
    var data=screensData();
    var web=data.filter(function(s){return s.kind==='WEB';});
    var sys=data.filter(function(s){return s.kind!=='WEB';});
    var list=document.getElementById('webList'); list.innerHTML='';
    web.forEach(function(s){ list.appendChild(makeWebBand(s)); });
    var nw=el('div'); nw.className='band new'; nw.innerHTML='<span class="plus">＋</span><span>New screen</span>';
    nw.addEventListener('click',function(){ try{ api().newScreen(); }catch(_){ } });
    list.appendChild(nw);
    var sysEl=document.getElementById('sysList'); sysEl.innerHTML='';
    sys.forEach(function(s){ sysEl.appendChild(makeSysBand(s)); });
    var active=data.filter(function(s){return s.active;}).length;
    document.getElementById('summary').innerHTML='<b>'+web.length+'</b> screens · <span style="color:#8FC2F2;font-weight:700;">'+active+' active</span>';
    try{ document.getElementById('build').textContent='build '+(api().getBuild&&api().getBuild()||''); }catch(_){ }
  };
  document.addEventListener('DOMContentLoaded', window.__ccRenderScreens);
</script>
</body>
```

- [ ] **Step 2: ビルド確認**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL（HTML はアセットに含まれる）。

- [ ] **Step 3: コミット**

```bash
git add app/src/main/assets/switcher.html
git commit -m "feat(screens): switcher.html — full-screen overview (bands, swipe-delete, reload confirm)"
```

---

## Task 11: plugins.html（Plugins システムスクリーン）

**Files:**
- Create: `app/src/main/assets/plugins.html`

**Interfaces:**
- Consumes（ブリッジ）: `CCStudio.listPlugins()`, `setEnabled(name,bool)`, `removePlugin(name)`, `pickPlugin()`, `getBuild()`, `openSwitcher()`。
- Produces: `window.__ccRenderPlugins()`。

> 検証: ビルド＋手動。スタイルは screens-mock.html の Plugins 部分（`.bus .mod .mod-top .mod-id .mod-name .ver .mod-desc .mod-foot .mod-meta .mod-actions .iconbtn .tgl .add .sect .row` 等）を移植。⚙ は `hasSettings` の時のみ。説明は全文表示（line-clamp 無し）。

- [ ] **Step 1: plugins.html を作成**

`<style>` に screens-mock.html の Plugins 関連クラスと `:root` 変数をコピー（`.spark`/アニメは任意）。`<body>`/script:
```html
<body>
  <div class="screen">
    <div class="bar">
      <button class="navback" id="back"><span class="chev">‹</span>Screens</button>
      <span class="title">Plugins</span><span class="build" id="build"></span>
    </div>
    <div class="summary" id="summary"></div>
    <div class="pl-body"><div class="bus" id="bus"></div>
      <button class="add" id="add">＋ Add plugin</button>
      <div class="sect"><p class="sect-h">About</p>
        <div class="row"><div class="ic">▍</div><div class="row-main">
          <div class="row-t">CC Studio</div><div class="row-d" id="about"></div></div></div>
      </div>
    </div>
  </div>
<script>
  function api(){ return window.CCStudio || {}; }
  function el(t,c){ var e=document.createElement(t); if(c) e.className=c; return e; }
  function fmtSize(b){ b=+b||0; return b<1024? b+' B':(b/1024).toFixed(1)+' KB'; }
  function plugins(){ try{ return JSON.parse(api().listPlugins()||'[]'); }catch(_){ return []; } }

  function makeMod(p){
    var on=!!p.enabled;
    var mod=el('div','mod'+(on?' on':''));
    var top=el('div','mod-top');
    var idw=el('div','mod-id');
    var nm=el('span','mod-name'); nm.textContent=p.name; idw.appendChild(nm);
    if(p.version){ var v=el('span','ver'); v.textContent='v'+p.version; idw.appendChild(v); }
    var tgl=el('button','tgl'); tgl.setAttribute('aria-pressed', on?'true':'false');
    tgl.appendChild(el('span','knob'));
    tgl.addEventListener('click',function(){ try{ api().setEnabled(p.name,!on); }catch(_){ } render(); });
    top.appendChild(idw); top.appendChild(tgl);
    var desc=el('div','mod-desc'); desc.textContent=p.description||''; // 全文表示
    var foot=el('div','mod-foot');
    var meta=el('div','mod-meta'); meta.innerHTML=fmtSize(p.size)+' · <span class="st">'+(on?'ON':'OFF')+'</span> · all frames';
    var acts=el('div','mod-actions');
    if(p.hasSettings){ var g=el('button','iconbtn gear'); g.textContent='⚙';
      g.title='このプラグインの設定'; acts.appendChild(g); } // 設定の実体は将来
    var del=el('button','iconbtn del'); del.textContent='✕';
    del.addEventListener('click',function(){ if(confirm('「'+p.name+'」を削除しますか？')){ try{ api().removePlugin(p.name); }catch(_){ } render(); } });
    acts.appendChild(del);
    foot.appendChild(meta); foot.appendChild(acts);
    mod.appendChild(top);
    if(p.description) mod.appendChild(desc);
    mod.appendChild(foot);
    return mod;
  }

  window.__ccRenderPlugins=function(){
    var list=plugins(); var bus=document.getElementById('bus'); bus.innerHTML='';
    list.forEach(function(p){ bus.appendChild(makeMod(p)); });
    var en=list.filter(function(p){return p.enabled;}).length;
    document.getElementById('summary').innerHTML='<b>'+list.length+'</b> installed · <span style="color:#3FD79A;font-weight:700;">'+en+' enabled</span>';
    var b=''; try{ b=api().getBuild&&api().getBuild()||''; }catch(_){ }
    document.getElementById('build').textContent='build '+b;
    document.getElementById('about').textContent='build '+b+' · <tailnet-host>';
  };
  document.getElementById('add').addEventListener('click',function(){ try{ api().pickPlugin(); }catch(_){ } });
  document.getElementById('back').addEventListener('click',function(){ try{ api().openSwitcher(); }catch(_){ } });
  document.addEventListener('DOMContentLoaded', window.__ccRenderPlugins);
</script>
</body>
```

- [ ] **Step 2: ビルド確認**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL。

- [ ] **Step 3: コミット**

```bash
git add app/src/main/assets/plugins.html
git commit -m "feat(plugins): plugins.html — full-screen system screen (rich cards, version, settings hook)"
```

---

## Task 12: 統合検証（ビルド＋手動）

**Files:** なし（検証のみ）。

- [ ] **Step 1: 全ユニットテスト**

Run: `./gradlew :app:testDebugUnitTest`
Expected: 全 PASS。

- [ ] **Step 2: リリース可能なデバッグ APK をビルド**

Run: `./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL。`app/build/outputs/apk/debug/cc-studio-debug-*.apk` 生成。

- [ ] **Step 3: 実機/エミュで手動チェックリスト**

端末にインストールして確認（各項目 PASS を確認）:
- 起動: 既定 Web スクリーン（cc-studio フォルダ）が全画面表示。左端に ︙。
- ︙ → 全画面 switcher が開く。Web スクリーンが帯（フォルダ名＋パス）で並ぶ。最下部 SYSTEM ドックに Plugins。
- New screen → 新しい Web スクリーンが増え選択される。
- 帯タップ → そのスクリーンへ（リロードされない）。
- 帯を左スワイプ → 赤「削除」→ タップで閉じる。隣がアクティブに。
- SYSTEM の Plugins タップ → 全画面 Plugins スクリーン。keyboard-suppress が ON・version 表示・説明全文。
- プラグイン追加（＋ Add plugin）→ 一覧に出る。トグル ON → switcher で該当 Web スクリーンが stale（青⟳）。
- stale の ⟳ → 確認ダイアログ「…実行中の処理があれば中断されます」→ リロードで反映。
- keyboard-suppress を ✕ 削除できる。
- アプリ再起動 → 開いていた Web スクリーン群と URL が復元。

- [ ] **Step 4: 最終コミット（必要なら微修正後）**

```bash
git add -A
git commit -m "test: verify Screens + Plugins end-to-end (build + manual checklist)"
```

---

## Self-Review（計画の自己点検）

- **Spec カバレッジ**: §2 統一モデル→T6/T8、§2.2 visibility→T6、§2.3 switcher→T8/T10、§3 各コンポーネント→T5-T8、§4.1 switcher UI→T10、§4.2 Plugins UI→T11、§4.3 確認ダイアログ→T10、§5 反映/世代/stale→T6(rows)/T8(bump/register)、§6 keyboard-suppress 組込み→T5、§7 メタ→T1/T5/T8(pluginsJson)、§8 フロー→T8/T10/T11、§9 将来→対象外（⚙ 口のみ T11）、§10 影響ファイル→全タスク網羅。
- **プレースホルダ**: 純ロジックは完全コード。Android/HTML 統合はスタイル移植元を明示（screens-mock.html）し、データ駆動の完全な script を記載。"TODO" 無し。⚙ の設定実体は spec の将来章であり、UI 口のみ実装＝設計通り。
- **型整合**: `PluginInfo`(T5) のフィールドを `pluginsJson`(T8) と plugins.html(T11) が一致使用。`ScreenRow`(T4) を `ScreenManager.rows`(T6)→`ScreensJson.build`(T4)→switcher.html(T10) が一致使用。`CcBridge` 新シグネチャ(T7) を `buildBridge`(T8) が一致供給。`ScreenStateCodec`(T3) を `ScreenStore`(T7) が使用。
