# プラグイン設定スクリーン（ライブ反映） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HUD などプラグインの表示/挙動を、プラグインの有効/無効ではなく「設定値」でリロード無しにライブ切替できるようにする（最初の設定は HUD の `visible`）。

**Architecture:** プラグインがヘッダ `@setting` で設定スキーマを宣言 → ネイティブが SharedPreferences に保存 → document-start の「設定ランタイム」が `window.__ccPluginSettings` を用意し、変更は `evaluateJavascript` で全 WEB スクリーンへ push（`ccstudio:setting` イベント）。設定 UI は notify.html 同型の専用オーバーレイ（plugin-settings.html）でスキーマ駆動レンダリング。

**Tech Stack:** Kotlin (Android, WebView), JUnit + org.json（JVM ユニットテスト）, バニラ JS/HTML（assets）。

参照 spec: [docs/superpowers/specs/2026-06-29-plugin-settings-screen-design.md](../specs/2026-06-29-plugin-settings-screen-design.md)

## Global Constraints

- v1 の設定型は `boolean` のみ実装。未知 type の `@setting` 行・保存値は無視（前方互換）。
- `setSetting` は generation を上げない（リロードを誘発しない / stale 表示に影響させない）。
- クロスオリジン iframe へは配信しない。設定ランタイムは `window.CCStudio` 不在を try/catch で許容し `{}` フォールバック。
- 既存の冪等ガード（タイマ/リスナ二重設置防止）を壊さない。
- メタヘッダ走査は既存どおり先頭40行のまま（据え置き）。
- UI スタイルは notify.html の CSS 変数・`.bar/.title/.navback/.row/.tgl` を流用する。

---

### Task 1: `@setting` スキーマのパース（SettingDef + PluginMetaParser）

**Files:**
- Modify: `app/src/main/java/app/ccstudio/PluginMeta.kt`
- Test: `app/src/test/java/app/ccstudio/PluginMetaTest.kt`

**Interfaces:**
- Consumes: なし
- Produces:
  - `data class SettingDef(val key: String, val type: String, val default: String, val label: String)`
  - `PluginMeta.settings: List<SettingDef>`
  - `PluginMetaParser.parse(script): PluginMeta`（`@setting` 行を収集。`@settings true` か `@setting` 1行以上で `hasSettings=true`）

- [ ] **Step 1: Write the failing tests**

`app/src/test/java/app/ccstudio/PluginMetaTest.kt` の末尾（最後の `}` の直前）に追記:

```kotlin
    @Test fun parsesSettingLines() {
        val js = """
            // ==CCStudioPlugin==
            // @name        focus-hud
            // @setting     visible boolean true HUD を表示
            // @setting     compact boolean false コンパクト表示
            // ==/CCStudioPlugin==
            (function(){})();
        """.trimIndent()
        val m = PluginMetaParser.parse(js)
        assertTrue(m.hasSettings) // @setting があれば true
        assertEquals(2, m.settings.size)
        val s0 = m.settings[0]
        assertEquals("visible", s0.key)
        assertEquals("boolean", s0.type)
        assertEquals("true", s0.default)
        assertEquals("HUD を表示", s0.label) // ラベルは空白を含み行末まで
        assertEquals("compact", m.settings[1].key)
        assertEquals("false", m.settings[1].default)
    }

    @Test fun ignoresUnknownSettingTypeAndMalformedLines() {
        val js = """
            // ==CCStudioPlugin==
            // @setting     mode enum a foo
            // @setting     broken
            // @setting     ok boolean true ラベル
            // ==/CCStudioPlugin==
        """.trimIndent()
        val m = PluginMetaParser.parse(js)
        assertEquals(1, m.settings.size) // boolean の正常行のみ
        assertEquals("ok", m.settings[0].key)
    }

    @Test fun noSettingsYieldsEmptyList() {
        val m = PluginMetaParser.parse("(function(){})();")
        assertTrue(m.settings.isEmpty())
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.PluginMetaTest"`
Expected: コンパイルエラー（`settings` 未定義 / `SettingDef` 未定義）または FAIL。

- [ ] **Step 3: Implement SettingDef + parser collection**

`app/src/main/java/app/ccstudio/PluginMeta.kt` を次のとおり変更。

`PluginMeta` に `settings` を追加:

```kotlin
data class PluginMeta(
    val name: String?,
    val version: String?,
    val description: String?,
    val hasSettings: Boolean,
    /** 注入タイミング: "document-start"（既定）/ "document-idle"。 */
    val runAt: String,
    /** 全フレームに注入するか（既定 true）。false ならトップフレームのみ。 */
    val allFrames: Boolean,
    /** `@setting <key> <type> <default> <label...>` の宣言（出現順）。 */
    val settings: List<SettingDef>,
)

/** プラグイン1つ分の設定項目スキーマ（v1 は type="boolean" のみ）。 */
data class SettingDef(
    val key: String,
    val type: String,
    val default: String,
    val label: String,
)
```

`PluginMetaParser.parse` を `@setting` 収集に対応させる（`==/CCStudioPlugin==` 未検出時の early return も `settings` 引数を追加）:

```kotlin
    fun parse(script: String): PluginMeta {
        val lines = script.lineSequence().take(40).toList()
        val start = lines.indexOfFirst { it.contains("==CCStudioPlugin==") }
        if (start < 0)
            return PluginMeta(null, null, null, false, "document-start", true, emptyList())
        val fields = HashMap<String, String>()
        val settings = ArrayList<SettingDef>()
        for (i in (start + 1) until lines.size) {
            val line = lines[i]
            if (line.contains("==/CCStudioPlugin==")) break
            val m = FIELD.find(line.trim()) ?: continue
            val key = m.groupValues[1].lowercase()
            val value = m.groupValues[2]
            if (key == "setting") {
                parseSettingDef(value)?.let { settings.add(it) }
            } else {
                fields[key] = value
            }
        }
        val runAt = if (fields["run-at"]?.equals("document-idle", ignoreCase = true) == true)
            "document-idle" else "document-start"
        val allFrames = fields["all-frames"]?.equals("false", ignoreCase = true) != true
        val hasSettings =
            fields["settings"]?.equals("true", ignoreCase = true) == true || settings.isNotEmpty()
        return PluginMeta(
            name = fields["name"],
            version = fields["version"],
            description = fields["description"],
            hasSettings = hasSettings,
            runAt = runAt,
            allFrames = allFrames,
            settings = settings,
        )
    }

    /** "<key> <type> <default> <label...>" を解析。v1 は boolean のみ採用。不正/未知 type は null。 */
    private fun parseSettingDef(spec: String): SettingDef? {
        val parts = spec.trim().split(Regex("\\s+"), limit = 4)
        if (parts.size < 4) return null
        val key = parts[0]
        val type = parts[1].lowercase()
        val default = parts[2]
        val label = parts[3]
        if (type != "boolean") return null
        if (!key.matches(Regex("[\\w-]+"))) return null
        return SettingDef(key, type, default, label)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.PluginMetaTest"`
Expected: PASS（既存テストも含め全て緑）。

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/app/ccstudio/PluginMeta.kt app/src/test/java/app/ccstudio/PluginMetaTest.kt
git commit -m "feat(app): parse @setting schema lines into PluginMeta.settings"
```

---

### Task 2: 設定値のマージ/coerce（PluginSettings 純関数）

**Files:**
- Create: `app/src/main/java/app/ccstudio/PluginSettings.kt`
- Test: `app/src/test/java/app/ccstudio/PluginSettingsTest.kt`

**Interfaces:**
- Consumes: `SettingDef`（Task 1）
- Produces:
  - `PluginSettings.merge(defs: List<SettingDef>, raw: Map<String, String?>): Map<String, Any>`
  - `PluginSettings.coerce(type: String, value: String): Any`

- [ ] **Step 1: Write the failing tests**

`app/src/test/java/app/ccstudio/PluginSettingsTest.kt`:

```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class PluginSettingsTest {
    private val defs = listOf(
        SettingDef("visible", "boolean", "true", "表示"),
        SettingDef("compact", "boolean", "false", "コンパクト"),
    )

    @Test fun usesDefaultWhenRawMissing() {
        val out = PluginSettings.merge(defs, emptyMap())
        assertEquals(true, out["visible"])
        assertEquals(false, out["compact"])
    }

    @Test fun rawOverridesDefaultAndCoercesBoolean() {
        val out = PluginSettings.merge(defs, mapOf("visible" to "false", "compact" to "true"))
        assertEquals(false, out["visible"])
        assertEquals(true, out["compact"])
    }

    @Test fun nullRawFallsBackToDefault() {
        val out = PluginSettings.merge(defs, mapOf("visible" to null))
        assertEquals(true, out["visible"])
    }

    @Test fun ignoresRawKeysNotInSchema() {
        val out = PluginSettings.merge(defs, mapOf("ghost" to "true"))
        assertEquals(setOf("visible", "compact"), out.keys)
    }

    @Test fun coerceBooleanIsCaseInsensitive() {
        assertEquals(true, PluginSettings.coerce("boolean", "TRUE"))
        assertEquals(false, PluginSettings.coerce("boolean", "nope"))
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.PluginSettingsTest"`
Expected: コンパイルエラー（`PluginSettings` 未定義）。

- [ ] **Step 3: Implement PluginSettings**

`app/src/main/java/app/ccstudio/PluginSettings.kt`:

```kotlin
package app.ccstudio

/** プラグイン設定値の純粋なマージ/型変換。SharedPreferences I/O とは分離してテスト可能にする。 */
object PluginSettings {
    /** スキーマ default を raw（保存値）で上書きし、型に応じて coerce した値マップ（宣言順）。 */
    fun merge(defs: List<SettingDef>, raw: Map<String, String?>): Map<String, Any> {
        val out = LinkedHashMap<String, Any>()
        for (d in defs) {
            val v = raw[d.key] ?: d.default
            out[d.key] = coerce(d.type, v)
        }
        return out
    }

    /** 文字列表現を型に応じた値へ。v1 は boolean のみ（他は文字列のまま）。 */
    fun coerce(type: String, value: String): Any = when (type) {
        "boolean" -> value.equals("true", ignoreCase = true)
        else -> value
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :app:testDebugUnitTest --tests "app.ccstudio.PluginSettingsTest"`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/app/ccstudio/PluginSettings.kt app/src/test/java/app/ccstudio/PluginSettingsTest.kt
git commit -m "feat(app): PluginSettings.merge/coerce pure settings resolver"
```

---

### Task 3: PluginStore の設定保存 API

**Files:**
- Modify: `app/src/main/java/app/ccstudio/PluginStore.kt`

**Interfaces:**
- Consumes: `SettingDef`（Task 1）, `PluginSettings.merge`（Task 2）
- Produces:
  - `PluginInfo.settings: List<SettingDef>`
  - `PluginStore.settingValue(name, key): String?`
  - `PluginStore.setSettingRaw(name, key, value)`
  - `PluginStore.settingsOf(name): List<SettingDef>`
  - `PluginStore.effectiveSettings(): Map<String, Map<String, Any>>`

- [ ] **Step 1: Add `settings` to PluginInfo**

`PluginStore.kt` の `data class PluginInfo(...)` に末尾フィールドを追加:

```kotlin
    val runAt: String,                // "document-start" | "document-idle"
    val allFrames: Boolean,           // true: 全フレーム / false: トップフレームのみ
    val settings: List<SettingDef>,   // @setting 宣言（無ければ空）
)
```

- [ ] **Step 2: Populate `settings` in list()**

`list()` 内の `PluginInfo(...)` 生成に追加（`allFrames = meta.allFrames,` の次行）:

```kotlin
                    allFrames = meta.allFrames,
                    settings = meta.settings,
                )
```

- [ ] **Step 3: Add settings storage/read API**

`enable(...)` 関数の直後（`fun enable` の閉じ `}` の後）に追記:

```kotlin
    /** 設定値の生文字列（未保存は null）。キーは setting:<plugin>:<key>。 */
    fun settingValue(name: String, key: String): String? =
        prefs.getString("setting:$name:$key", null)

    /** 設定値を文字列で永続化（型解釈は呼び出し側 / PluginSettings に委ねる）。 */
    fun setSettingRaw(name: String, key: String, value: String) {
        prefs.edit().putString("setting:$name:$key", value).apply()
    }

    /** 対象プラグインの設定スキーマ（無ければ空）。 */
    fun settingsOf(name: String): List<SettingDef> =
        list().firstOrNull { it.name == name }?.settings ?: emptyList()

    /** 設定を持つ全プラグインの「default を保存値で上書き＋型変換した」有効値マップ。 */
    fun effectiveSettings(): Map<String, Map<String, Any>> {
        val out = LinkedHashMap<String, Map<String, Any>>()
        for (p in list()) {
            if (p.settings.isEmpty()) continue
            val raw = p.settings.associate { it.key to settingValue(p.name, it.key) }
            out[p.name] = PluginSettings.merge(p.settings, raw)
        }
        return out
    }
```

- [ ] **Step 4: Compile check**

Run: `./gradlew :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL（`PluginInfo` の全生成箇所が `settings` を含む。生成は `list()` の1箇所のみ）。

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/app/ccstudio/PluginStore.kt
git commit -m "feat(app): PluginStore settings storage + effectiveSettings"
```

---

### Task 4: CcBridge に設定メソッドを追加

**Files:**
- Modify: `app/src/main/java/app/ccstudio/CcBridge.kt`

**Interfaces:**
- Consumes: なし（ラムダは MainActivity が Task 5 で供給）
- Produces（`window.CCStudio.*` から呼べる JS API）:
  - `getPluginSettings(): String`
  - `openPluginSettings(name: String)`
  - `getSettingsView(): String`
  - `setSetting(name: String, key: String, value: Boolean)`
  - `closePluginSettings()`

- [ ] **Step 1: Add constructor lambdas**

`CcBridge` のコンストラクタ引数の末尾（`onCloseNotify: () -> Unit,` の次）に追加:

```kotlin
    private val onCloseNotify: () -> Unit,
    private val pluginSettingsJsonFn: () -> String,
    private val onOpenPluginSettings: (name: String) -> Unit,
    private val settingsViewJsonFn: () -> String,
    private val onSetSetting: (name: String, key: String, value: Boolean) -> Unit,
    private val onClosePluginSettings: () -> Unit,
) {
```

（元の `) {` を上記で置き換える。）

- [ ] **Step 2: Add @JavascriptInterface methods**

最後のメソッド `closeNotifySettings()` の直後（クラス閉じ `}` の前）に追加:

```kotlin
    // ── プラグイン設定 ──
    /** 設定ランタイム注入用。全プラグインの有効設定値（{"focus-hud":{"visible":true}, ...}）。 */
    @JavascriptInterface fun getPluginSettings(): String = pluginSettingsJsonFn()
    /** そのプラグインの専用設定スクリーン（plugin-settings.html オーバーレイ）を開く。 */
    @JavascriptInterface fun openPluginSettings(name: String) = onOpenPluginSettings(name)
    /** 設定スクリーンの描画素材（{name, displayName, settings:[{key,type,default,label,value}]}）。 */
    @JavascriptInterface fun getSettingsView(): String = settingsViewJsonFn()
    /** 設定値を保存し、全 WEB スクリーンへリロード無しでライブ反映する（v1: boolean）。 */
    @JavascriptInterface fun setSetting(name: String, key: String, value: Boolean) =
        onSetSetting(name, key, value)
    /** 設定スクリーンを閉じて Plugins 画面へ戻す。 */
    @JavascriptInterface fun closePluginSettings() = onClosePluginSettings()
```

- [ ] **Step 3: Compile check (expected to fail at call site)**

Run: `./gradlew :app:compileDebugKotlin`
Expected: FAIL — `buildBridge()`（MainActivity）の `CcBridge(...)` 呼び出しが新引数を渡していないためのエラー。Task 5 で解消する。

- [ ] **Step 4: Commit**

```bash
git add app/src/main/java/app/ccstudio/CcBridge.kt
git commit -m "feat(app): CcBridge plugin-settings JS API surface"
```

---

### Task 5: MainActivity 配線（ランタイム注入・ライブ push・設定オーバーレイ）

**Files:**
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`

**Interfaces:**
- Consumes: `store.effectiveSettings()` / `store.settingValue` / `store.setSettingRaw`（Task 3）, `PluginSettings.coerce`（Task 2）, CcBridge 新ラムダ（Task 4）
- Produces: `window.__ccPluginSettings` / `window.__ccApplyPluginSetting`（設定ランタイム）, `plugin-settings.html` オーバーレイの open/close, `getSettingsView()` JSON

- [ ] **Step 1: Add fields for the settings overlay + target**

`notifyView` フィールドの近く（クラスのフィールド宣言領域。`private var notifyView: WebView? = null` がある箇所の直後）に追加。`notifyView` の宣言行を grep で特定して隣に置く:

```kotlin
    private var settingsView: WebView? = null
    private var settingsTarget: String? = null
```

> 注: 既存の `notifyView` 宣言が見つからない場合は、`switcher` フィールド宣言の隣に同様に追加する。フィールドはクラス直下に置くこと。

- [ ] **Step 2: Add the settings-runtime constant**

`MainActivity` クラスの末尾付近、`companion object` があればその中、無ければクラス直下にトップレベル定数として追加（同ファイル内 `private const val`）:

```kotlin
private const val SETTINGS_RUNTIME_KEY = "__ccSettingsRuntime"

/** document-start で window.__ccPluginSettings を用意し、ライブ更新の受け口を定義する。 */
private const val SETTINGS_RUNTIME_JS = """
(function(){
  try { window.__ccPluginSettings = JSON.parse(window.CCStudio.getPluginSettings() || '{}'); }
  catch(e){ window.__ccPluginSettings = {}; }
  window.__ccApplyPluginSetting = function(plugin, key, val){
    var p = window.__ccPluginSettings[plugin] || (window.__ccPluginSettings[plugin] = {});
    p[key] = val;
    try {
      window.dispatchEvent(new CustomEvent('ccstudio:setting',
        { detail: { plugin: plugin, key: key, value: val } }));
    } catch(_){}
  };
})();
"""
```

- [ ] **Step 3: Register the settings runtime first in registerScreenScripts**

`registerScreenScripts(s: Screen)` の本体を次に置き換える（設定ランタイムを最初に1本だけ登録し、解除対象から除外する）:

```kotlin
    private fun registerScreenScripts(s: Screen) {
        if (s.kind != ScreenKind.WEB) return
        if (!ExtensionRuntime.isDocumentStartSupported()) return
        // 設定ランタイムを最初に1本だけ登録（プラグインが読む前に __ccPluginSettings を用意）。
        if (!s.pluginHandlers.containsKey(SETTINGS_RUNTIME_KEY)) {
            ExtensionRuntime.registerDocumentStart(s.webView, SETTINGS_RUNTIME_JS)
                ?.let { s.pluginHandlers[SETTINGS_RUNTIME_KEY] = it }
        }
        val enabled = store.enabled().filter { it.allFrames }.map { it.name }.toSet()
        val iter = s.pluginHandlers.iterator()
        while (iter.hasNext()) {
            val e = iter.next()
            if (e.key == SETTINGS_RUNTIME_KEY) continue
            if (e.key !in enabled) {
                try { e.value.remove() } catch (_: Exception) {}
                iter.remove()
            }
        }
        for (name in enabled) {
            if (s.pluginHandlers.containsKey(name)) continue
            val js = store.script(name) ?: continue
            ExtensionRuntime.registerDocumentStart(s.webView, js)?.let { h -> s.pluginHandlers[name] = h }
        }
    }
```

- [ ] **Step 4: Inject settings snapshot on the no-document-start fallback path**

`createWebScreen` の `onPageFinished` 内、`if (!ExtensionRuntime.isDocumentStartSupported()) {` ブロックの**先頭**に1行追加（フォールバック端末でも `__ccPluginSettings` を用意）:

```kotlin
                if (!ExtensionRuntime.isDocumentStartSupported()) {
                    view.evaluateJavascript("window.__ccPluginSettings = ${effectiveSettingsJson()};", null)
                    // document-start 非対応端末: 有効プラグインを全部メインフレームに注入（フォールバック）。
                    store.enabledScripts().forEach { view.evaluateJavascript(it, null) }
                } else {
```

- [ ] **Step 5: Add JSON builders + live push + overlay open/close**

`refreshActivePanel()`（Plugins 再描画）の直後に、関連メソッドをまとめて追加:

```kotlin
    /** 全プラグインの有効設定値を JSON 化（設定ランタイム注入用）。 */
    private fun effectiveSettingsJson(): String {
        val root = JSONObject()
        store.effectiveSettings().forEach { (plugin, kv) ->
            val o = JSONObject()
            kv.forEach { (k, v) -> o.put(k, v) }
            root.put(plugin, o)
        }
        return root.toString()
    }

    /** 設定スクリーン描画用 JSON（現在の settingsTarget のスキーマ＋現在値）。 */
    private fun settingsViewJson(): String {
        val name = settingsTarget ?: return "{}"
        val info = store.list().firstOrNull { it.name == name } ?: return "{}"
        val arr = JSONArray()
        info.settings.forEach { d ->
            val value = PluginSettings.coerce(d.type, store.settingValue(name, d.key) ?: d.default)
            arr.put(
                JSONObject()
                    .put("key", d.key)
                    .put("type", d.type)
                    .put("default", PluginSettings.coerce(d.type, d.default))
                    .put("label", d.label)
                    .put("value", value)
            )
        }
        return JSONObject()
            .put("name", info.name)
            .put("displayName", info.displayName)
            .put("settings", arr)
            .toString()
    }

    /** 設定変更を全 WEB スクリーンへリロード無しで配信する（generation は上げない）。 */
    private fun pushSettingLive(name: String, key: String, value: Boolean) {
        val js = "window.__ccApplyPluginSetting && window.__ccApplyPluginSetting(" +
            "${JSONObject.quote(name)}, ${JSONObject.quote(key)}, $value);"
        screens.webScreens().forEach { it.webView.evaluateJavascript(js, null) }
    }

    /** プラグイン設定の全画面（plugin-settings.html）をオーバーレイ表示する（notify と同型）。 */
    private fun openPluginSettings() {
        val sv = settingsView ?: newConfiguredWebView().also {
            it.webViewClient = WebViewClient()
            it.loadUrl("file:///android_asset/plugin-settings.html")
            root.addView(
                it,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
            settingsView = it
        }
        sv.visibility = View.VISIBLE
        sv.bringToFront()
        sv.evaluateJavascript("window.__ccRenderSettings && window.__ccRenderSettings();", null)
    }

    private fun closePluginSettings() { settingsView?.visibility = View.GONE }
```

> 注: `JSONArray` / `JSONObject` は既存 import 済み（`pluginsJson()` で使用）。`FrameLayout` / `View` / `WebViewClient` も既存 import 済み（`openNotify()` で使用）。

- [ ] **Step 6: Wire the new bridge lambdas in buildBridge()**

`buildBridge()` の `CcBridge(` 引数の末尾、`onCloseNotify = { ... },` の次に追加:

```kotlin
        onCloseNotify = { runOnUiThread { closeNotify(); openSwitcher() } },
        pluginSettingsJsonFn = { effectiveSettingsJson() },
        onOpenPluginSettings = { name -> runOnUiThread { settingsTarget = name; openPluginSettings() } },
        settingsViewJsonFn = { settingsViewJson() },
        onSetSetting = { name, key, value ->
            store.setSettingRaw(name, key, value.toString())
            runOnUiThread { pushSettingLive(name, key, value) }
        },
        onClosePluginSettings = { runOnUiThread { closePluginSettings() } },
    )
```

（元の `onCloseNotify = ...,` 行に続けて挿入し、閉じ `)` を維持する。）

- [ ] **Step 7: Compile check**

Run: `./gradlew :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL（Task 4 の呼び出し側エラーが解消）。

- [ ] **Step 8: Commit**

```bash
git add app/src/main/java/app/ccstudio/MainActivity.kt
git commit -m "feat(app): settings runtime injection, live push, plugin-settings overlay"
```

---

### Task 6: 設定スクリーン plugin-settings.html（スキーマ駆動レンダラ）

**Files:**
- Create: `app/src/main/assets/plugin-settings.html`

**Interfaces:**
- Consumes: `CCStudio.getSettingsView()` / `CCStudio.setSetting(name,key,bool)` / `CCStudio.closePluginSettings()`（Task 4/5）
- Produces: `window.__ccRenderSettings()`（MainActivity が open 時に呼ぶ）

- [ ] **Step 1: Create the asset**

`app/src/main/assets/plugin-settings.html`:

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>プラグイン設定</title>
<style>
  :root{
    --chassis:#11151C; --module:#1B222E; --line:#2A3342; --ink:#E8EDF4; --dim:#7C8694;
    --brand:#2E90E8; --brand-soft:#8FC2F2; --live:#3FD79A; --live-dim:#1f6d52;
    --sans:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    --mono:ui-monospace,"Roboto Mono","JetBrains Mono",Menlo,monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:var(--chassis);color:var(--ink);font-family:var(--sans)}
  .screen{height:100%;display:flex;flex-direction:column}
  .bar{display:flex;align-items:center;gap:10px;padding:16px 16px 12px;border-bottom:1px solid var(--line);flex:0 0 auto;
    padding-top:calc(16px + env(safe-area-inset-top))}
  .title{font:600 13px/1 var(--mono);letter-spacing:.18em;color:var(--dim);text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .navback{border:1px solid var(--line);background:transparent;color:var(--dim);border-radius:8px;
    font:600 12px/1 var(--sans);padding:7px 10px 7px 8px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;flex:0 0 auto}
  .navback .chev{font-size:14px;color:var(--brand-soft)}
  .body{flex:1;overflow:auto;padding:6px 16px calc(20px + env(safe-area-inset-bottom))}
  .sect{margin-top:14px;padding-top:6px}
  .row{display:flex;align-items:center;gap:12px;padding:8px 0}
  .row .ic{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;background:#0e1620;border:1px solid var(--line);color:var(--brand-soft);flex:0 0 auto;font-size:15px}
  .row-main{flex:1;min-width:0}
  .row-t{font:600 13px/1.2 var(--sans);color:var(--ink)}
  .tgl{appearance:none;border:0;cursor:pointer;flex:0 0 auto;width:46px;height:26px;border-radius:99px;background:#2b3342;position:relative;transition:background .18s}
  .tgl .knob{position:absolute;top:2.5px;left:2.5px;width:21px;height:21px;border-radius:50%;background:#aeb7c4;transition:transform .18s,background .18s}
  .tgl[aria-pressed="true"]{background:var(--live-dim)}
  .tgl[aria-pressed="true"] .knob{transform:translateX(20px);background:var(--live)}
  .note{margin-top:18px;font:500 11px/1.6 var(--sans);color:#5d6675}
  .empty{padding:24px 8px;text-align:center;color:var(--dim);font:500 12px/1.5 var(--sans)}
  @media (prefers-reduced-motion:reduce){.tgl,.tgl .knob{transition:none}}
</style>
</head>
<body>
  <div class="screen">
    <div class="bar">
      <button class="navback" id="back"><span class="chev">‹</span>Plugins</button>
      <span class="title" id="title">設定</span>
    </div>
    <div class="body">
      <div class="sect" id="list"></div>
      <p class="note">設定はリロード無しで、開いている全スクリーンに即反映されます。</p>
    </div>
  </div>
<script>
  function api(){ return window.CCStudio || {}; }
  function el(t,c){ var e=document.createElement(t); if(c) e.className=c; return e; }
  function view(){ try{ return JSON.parse(api().getSettingsView()||'{}'); }catch(_){ return {}; } }

  function boolRow(name,s){
    var row=el('div','row');
    var ic=el('div','ic'); ic.textContent='⚙'; row.appendChild(ic);
    var main=el('div','row-main');
    var t=el('div','row-t'); t.textContent=s.label||s.key; main.appendChild(t);
    row.appendChild(main);
    var tgl=el('button','tgl'); tgl.setAttribute('aria-pressed', String(!!s.value));
    tgl.appendChild(el('span','knob'));
    tgl.addEventListener('click',function(){
      var next = tgl.getAttribute('aria-pressed')!=='true';
      try{ api().setSetting(name, s.key, next); }catch(_){ }
      tgl.setAttribute('aria-pressed', String(next));
    });
    row.appendChild(tgl);
    return row;
  }

  window.__ccRenderSettings=function(){
    var v=view();
    document.getElementById('title').textContent = v.displayName || v.name || '設定';
    var list=document.getElementById('list'); list.innerHTML='';
    var defs=(v.settings||[]).filter(function(s){ return s.type==='boolean'; });
    if(!defs.length){
      var e=el('div','empty'); e.textContent='このプラグインに設定項目はありません。';
      list.appendChild(e); return;
    }
    defs.forEach(function(s){ list.appendChild(boolRow(v.name, s)); });
  };
  document.getElementById('back').addEventListener('click',function(){ try{ api().closePluginSettings(); }catch(_){ } });
  document.addEventListener('DOMContentLoaded', window.__ccRenderSettings);
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/assets/plugin-settings.html
git commit -m "feat(app): plugin-settings.html schema-driven settings screen"
```

---

### Task 7: plugins.html の ⚙ ボタンを配線

**Files:**
- Modify: `app/src/main/assets/plugins.html:114-117`

**Interfaces:**
- Consumes: `CCStudio.openPluginSettings(name)`（Task 4/5）

- [ ] **Step 1: Wire the gear button**

`plugins.html` の以下のブロック（placeholder）:

```javascript
    if(p.hasSettings){
      var g=el('button','iconbtn gear'); g.textContent='⚙'; g.title='このプラグインの設定';
      acts.appendChild(g); // 設定の実体は将来フェーズ
    }
```

を次に置き換える:

```javascript
    if(p.hasSettings){
      var g=el('button','iconbtn gear'); g.textContent='⚙'; g.title='このプラグインの設定';
      g.addEventListener('click',function(){ try{ api().openPluginSettings(p.name); }catch(_){ } });
      acts.appendChild(g);
    }
```

- [ ] **Step 2: Commit**

```bash
git add app/src/main/assets/plugins.html
git commit -m "feat(app): wire ⚙ to open the plugin settings screen"
```

---

### Task 8: focus-hud.js に visible 設定を導入

**Files:**
- Modify: `plugins/focus-hud.js`

**Interfaces:**
- Consumes: `window.__ccPluginSettings['focus-hud'].visible`, `ccstudio:setting` イベント（Task 5）
- Produces: `@setting visible boolean true HUD を表示`（Plugins 画面の ⚙ が活性化）

- [ ] **Step 1: Declare the setting in the header and bump version**

ヘッダ（先頭ブロック）を次のように変更。`@all-frames true` の次に `@setting` を追加し、version を上げる:

```js
// ==CCStudioPlugin==
// @name        focus-hud
// @version     1.5.0
// @description フォーカス診断オーバーレイ。どの要素・どのフレームにフォーカス/タップが入ったかを画面上部に時系列表示する（スクショで状況共有する用）。全フレームに document-start で常駐し、表示は最前面フレームのみ。
// @run-at      document-start
// @all-frames  true
// @setting     visible boolean true HUD を表示
// ==/CCStudioPlugin==
```

- [ ] **Step 2: Add visibility helpers**

`var MAX_LOG = 16;` の直後に追加:

```js
  // 表示状態は TOP フレームの共有フラグに持つ。初期値は注入された設定（既定 true）。
  function readVisibleSetting() {
    try {
      var s = window.__ccPluginSettings && window.__ccPluginSettings['focus-hud'];
      return !(s && s.visible === false);
    } catch (_) { return true; }
  }
  function hudVisible() {
    try {
      var t = topWin();
      if (typeof t.__ccStudioHudVisible === 'undefined') t.__ccStudioHudVisible = readVisibleSetting();
      return t.__ccStudioHudVisible !== false;
    } catch (_) { return readVisibleSetting(); }
  }
```

> 注: `topWin()` はこの位置より下で定義されているが、関数宣言の巻き上げ（hoisting）で参照可能。

- [ ] **Step 3: Gate renderHud on visibility**

`renderHud(force)` の冒頭、`if (!isTop() || !document.body) return;` の**直後**に挿入:

```js
      if (!isTop() || !document.body) return;
      if (!hudVisible()) {
        var hiddenEl = document.getElementById('__ccStudioFocusHud');
        if (hiddenEl) hiddenEl.style.display = 'none';
        return; // 非表示中は描画しない（監視・ログ収集は継続）。
      }
      var shownEl = document.getElementById('__ccStudioFocusHud');
      if (shownEl) shownEl.style.display = '';
```

- [ ] **Step 4: Subscribe to live setting changes (TOP only)**

末尾の `if (isTop()) {` ブロック内、`try {` で始まるタイマ設置の**前**に挿入:

```js
  if (isTop()) {
    try {
      if (!window.__ccStudioHudSettingHook) {
        window.__ccStudioHudSettingHook = true;
        window.addEventListener('ccstudio:setting', function (e) {
          try {
            var d = e && e.detail;
            if (d && d.plugin === 'focus-hud' && d.key === 'visible') {
              topWin().__ccStudioHudVisible = d.value !== false;
              renderHud(true); // 凍結を無視して即反映
            }
          } catch (_) { /* ignore */ }
        }, false);
      }
    } catch (_) { /* ignore */ }
    try {
```

> 注: 既存の `try {` 〜 タイマ設置 〜 `renderHud(false);` の構造はそのまま残す。上記は新しい `try{...}catch{}` を1つ足して既存 `try {` の直前に置くだけ。

- [ ] **Step 5: Update the HUD header version label**

`renderHud` 内の表示文字列を 1.5.0 に合わせる:

```js
      var head = 'FOCUS-HUD v1.5.0  KB:' + (kbv ? 'v' + kbv : 'none') +
```

- [ ] **Step 6: Commit**

```bash
git add plugins/focus-hud.js
git commit -m "feat(focus-hud): live show/hide via 'visible' plugin setting"
```

---

### Task 9: 全体ビルド＋ユニットテスト＋手動検証

**Files:** なし（検証のみ）

- [ ] **Step 1: Run all unit tests**

Run: `./gradlew :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL（PluginMetaTest / PluginSettingsTest 含め全緑）。

- [ ] **Step 2: Build the debug APK**

Run: `./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL。

- [ ] **Step 3: 手動検証（実機 / エミュレータ）**

次を確認（spec のテスト方針）:
1. focus-hud を有効化（初回のみリロードで HUD 出現）。
2. Plugins 画面の focus-hud に ⚙ が出る → タップで設定スクリーンが開き「HUD を表示」トグルが ON。
3. トグル OFF → **リロード無し**で HUD が即消える。ON → 即再表示。
4. keyboard-suppress を動かしている状態で HUD をトグルしても、フォーカス/キーボードの再現状態が維持される。
5. 設定 OFF のままスクリーンをリロード → HUD は非表示のまま（設定が永続）。
6. WEB スクリーンを2枚開いて片方でトグル → 両方に反映される。
7. 「‹ Plugins」で設定スクリーンが閉じ、Plugins 画面に戻る。

- [ ] **Step 4: Commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "fix(app): plugin settings verification fixups"
```

（修正不要なら本ステップはスキップ。）

---

## Self-Review

**Spec coverage:**
- 設定スキーマ宣言（@setting）→ Task 1 ✓
- 保存先（SharedPreferences）→ Task 3 ✓
- effectiveSettings マージ/coerce → Task 2（純関数）+ Task 3（I/O）✓
- ブリッジ 5 メソッド → Task 4 ✓
- 設定ランタイム注入（document-start 先頭）→ Task 5 Step 2-3 ✓
- ライブ push（evaluateJavascript）→ Task 5 Step 5 ✓
- 非対応端末フォールバック → Task 5 Step 4 ✓
- 専用設定オーバーレイ（plugin-settings.html）→ Task 5 Step 5 + Task 6 ✓
- plugins.html ⚙ 配線 → Task 7 ✓
- focus-hud visible 宣言/ゲート/購読 → Task 8 ✓
- テスト方針（ユニット＋手動）→ Task 1/2 + Task 9 ✓

**Placeholder scan:** 全ステップに実コード/実コマンドあり。"TBD"/"後で"/抽象指示なし。✓

**Type consistency:**
- `SettingDef(key,type,default,label)` を Task 1 で定義 → Task 2/3/5 で同一フィールド名使用 ✓
- `effectiveSettings(): Map<String, Map<String, Any>>` Task 3 → Task 5 `effectiveSettingsJson` で `.forEach { (plugin, kv) -> ... kv.forEach { (k,v) -> } }` 整合 ✓
- `setSetting(name,key,value:Boolean)` Task 4 ↔ `onSetSetting`(name,key,value) Task 5 整合 ✓
- JS: `window.__ccApplyPluginSetting(plugin,key,val)` 定義（Task 5）↔ 呼び出し（Task 5 pushSettingLive）↔ 購読 `ccstudio:setting`（Task 8）整合 ✓
- `window.__ccRenderSettings`（Task 6 定義）↔ open 時呼び出し（Task 5）整合 ✓
- `getSettingsView` の戻り `{name,displayName,settings:[{key,type,default,label,value}]}`（Task 5）↔ レンダラ参照（Task 6）整合 ✓
