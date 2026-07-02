# フェーズ1: コード品質リファクタ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MainActivity.kt（1,142 行）を責務ごとの協調クラスへ分割し、抽出した純ロジックにユニットテストを付け、プラグイン JS の規約を文書化する。挙動は一切変えない（純粋なリファクタ）。

**Architecture:** 「純関数として切り出せるもの（URL 判定・JSON 構築・ナビ遷移表・オブザーバ判定・ファイル名処理）」を先に object/クラスへ抽出して TDD で固め、その後に Android 依存の塊（ダウンロード・オーバーレイ・WebView ファクトリ）をクラス移設する。プラグイン JS は端末検証なしに動作コードを触らない — 規約の文書化に留める。

**Tech Stack:** Kotlin (JVM 17) / Android Gradle Plugin 8.5.2 / JUnit 4 + org.json（JVM ユニットテスト）

## Global Constraints

- 挙動変更は禁止。UI 文字列（日本語）もそのまま — i18n はフェーズ 2。
- スペック: `docs/specs/2026-07-02-public-release-refactor-design.md`。
- テスト実行: `./gradlew :app:testDebugUnitTest`。ビルド: `./gradlew :app:assembleDebug`。
- プラグイン `.js` の動作コードは変更しない（実機での検証手段がないため）。
- ブランチ: `refactor/public-release`。タスクごとにコミット。
- コミットメッセージ末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: UrlPolicy — 外部リンク判定と folder URL 構築の抽出

**Files:**
- Create: `app/src/main/java/app/ccstudio/UrlPolicy.kt`
- Test: `app/src/test/java/app/ccstudio/UrlPolicyTest.kt`
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`（`isExternalHttp` 321-327 行 / `openScreenForCwd` の URL 構築 201-205 行を置換）

**Interfaces:**
- Produces: `UrlPolicy.isExternalHttp(scheme: String?, host: String?, workbenchHost: String?): Boolean` / `UrlPolicy.folderUrl(targetUrl: String, cwd: String): String?`

- [ ] **Step 1: 失敗するテストを書く**

```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlPolicyTest {
    @Test fun `workbench と同一ホストは外部ではない`() {
        assertFalse(UrlPolicy.isExternalHttp("https", "h.ts.net", "h.ts.net"))
        assertFalse(UrlPolicy.isExternalHttp("https", "H.TS.NET", "h.ts.net")) // 大文字小文字無視
    }
    @Test fun `別ホストの http(s) は外部`() {
        assertTrue(UrlPolicy.isExternalHttp("https", "example.com", "h.ts.net"))
        assertTrue(UrlPolicy.isExternalHttp("http", "example.com", "h.ts.net"))
    }
    @Test fun `http(s) 以外・情報不足は外部扱いしない`() {
        assertFalse(UrlPolicy.isExternalHttp("file", null, "h.ts.net"))
        assertFalse(UrlPolicy.isExternalHttp(null, "example.com", "h.ts.net"))
        assertFalse(UrlPolicy.isExternalHttp("https", null, "h.ts.net"))
        assertFalse(UrlPolicy.isExternalHttp("https", "example.com", null))
    }
    @Test fun `folderUrl は cwd を URL エンコードして付ける`() {
        assertEquals(
            "https://h.ts.net/?folder=%2Fhome%2Fa%20b",
            UrlPolicy.folderUrl("https://h.ts.net/?folder=/mnt/win", "/home/a b"),
        )
    }
    @Test fun `folderUrl はスキームが無ければ null`() {
        assertEquals(null, UrlPolicy.folderUrl("not-a-url", "/x"))
    }
}
```

- [ ] **Step 2: 失敗を確認** — Run: `./gradlew :app:testDebugUnitTest --tests 'app.ccstudio.UrlPolicyTest'` → Expected: コンパイルエラー（UrlPolicy 未定義）

- [ ] **Step 3: 実装**

```kotlin
package app.ccstudio

/** workbench 内/外の URL 判定と、通知タップ用 folder URL の構築。純関数。 */
object UrlPolicy {
    /** workbench 以外の http(s) ホストへのナビゲーションか（＝外部ブラウザで開くべきか）。 */
    fun isExternalHttp(scheme: String?, host: String?, workbenchHost: String?): Boolean {
        val s = scheme?.lowercase() ?: return false
        if (s != "http" && s != "https") return false
        if (host == null || workbenchHost == null) return false
        return !host.equals(workbenchHost, ignoreCase = true)
    }

    /** targetUrl のスキーム+ホストに ?folder=<cwd> を付けた URL。構築できなければ null。 */
    fun folderUrl(targetUrl: String, cwd: String): String? {
        val schemeEnd = targetUrl.indexOf("://")
        if (schemeEnd < 0) return null
        val host = targetUrl.substring(schemeEnd + 3).substringBefore('/')
        val base = targetUrl.substring(0, schemeEnd) + "://" + host
        return "$base/?folder=" + java.net.URLEncoder.encode(cwd, "UTF-8")
    }
}
```

注意: `URLEncoder.encode` は空白を `+` にする。既存実装（MainActivity 205 行）と同一の関数を使うので挙動は不変だが、テストの期待値は**実際の出力に合わせて確定**する（`%20` でなく `+` ならテストを直す — 挙動維持が正）。

- [ ] **Step 4: パスを確認** — Run: 同上 → Expected: PASS
- [ ] **Step 5: MainActivity を差し替え** — `isExternalHttp(uri)` の本体を `UrlPolicy.isExternalHttp(uri.scheme, uri.host, workbenchHost)` に、`openScreenForCwd` の schemeEnd〜url 構築 5 行を `val url = UrlPolicy.folderUrl(TARGET_URL, cwd) ?: return` に置換。
- [ ] **Step 6: 全テスト実行** — Run: `./gradlew :app:testDebugUnitTest` → Expected: PASS
- [ ] **Step 7: Commit** — `refactor(app): URL 判定と folder URL 構築を UrlPolicy へ抽出`

### Task 2: PanelJson — 画面用 JSON 構築の抽出

**Files:**
- Create: `app/src/main/java/app/ccstudio/PanelJson.kt`
- Test: `app/src/test/java/app/ccstudio/PanelJsonTest.kt`
- Modify: `MainActivity.kt`（`settingsListJson` 654-671 / `pluginsJson` 858-876 / `settingsViewJson` 774-796 / `effectiveSettingsJson` 763-771 を委譲に置換）

**Interfaces:**
- Consumes: `PluginInfo`（PluginStore.kt）, `SettingDef`（PluginMeta.kt）, `PluginSettings.coerce(type, raw)`
- Produces:
  - `PanelJson.plugins(list: List<PluginInfo>): String`
  - `PanelJson.settingsList(total: Int, enabled: Int): String`
  - `PanelJson.settingsView(info: PluginInfo?, valueOf: (ns: String, key: String) -> String?): String`
  - `PanelJson.effectiveSettings(map: Map<String, Map<String, Any>>): String`

- [ ] **Step 1: 失敗するテストを書く**（既存 `ScreensJsonTest.kt` の流儀に合わせる）

```kotlin
package app.ccstudio

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class PanelJsonTest {
    private fun info(
        name: String = "a.js", enabled: Boolean = true,
        settings: List<SettingDef> = emptyList(),
    ) = PluginInfo(
        name = name, size = 10L, enabled = enabled, displayName = name.removeSuffix(".js"),
        version = "1.0", description = "説明", hasSettings = settings.isNotEmpty(),
        bundled = false, runAt = "document-start", allFrames = true, settings = settings,
    )

    @Test fun `plugins は全フィールドを持つ配列`() {
        val arr = JSONArray(PanelJson.plugins(listOf(info())))
        val o = arr.getJSONObject(0)
        assertEquals("a.js", o.getString("name"))
        assertEquals("a", o.getString("displayName"))
        assertEquals(true, o.getBoolean("enabled"))
        assertEquals("説明", o.getString("description"))
        assertEquals("document-start", o.getString("runAt"))
    }

    @Test fun `settingsList はプラグイン数を sub に埋める`() {
        val arr = JSONArray(PanelJson.settingsList(3, 2))
        assertEquals("plugins", arr.getJSONObject(0).getString("id"))
        assertEquals("3 個インストール · 2 有効", arr.getJSONObject(0).getString("sub"))
        assertEquals("notify", arr.getJSONObject(1).getString("id"))
        assertEquals("log", arr.getJSONObject(2).getString("id"))
    }

    @Test fun `settingsView は保存値をスキーマに重ねる`() {
        val def = SettingDef("visible", "boolean", "true", "HUD を表示")
        val o = JSONObject(PanelJson.settingsView(info("hud.js", settings = listOf(def))) { ns, key ->
            if (ns == "hud" && key == "visible") "false" else null
        })
        assertEquals("hud", o.getString("name"))
        val s = o.getJSONArray("settings").getJSONObject(0)
        assertEquals(false, s.getBoolean("value"))
        assertEquals(true, s.getBoolean("default"))
    }

    @Test fun `settingsView は対象なしなら空オブジェクト`() {
        assertEquals("{}", PanelJson.settingsView(null) { _, _ -> null })
    }

    @Test fun `effectiveSettings はネストした JSON になる`() {
        val json = JSONObject(PanelJson.effectiveSettings(mapOf("hud" to mapOf("visible" to false))))
        assertEquals(false, json.getJSONObject("hud").getBoolean("visible"))
    }
}
```

- [ ] **Step 2: 失敗を確認** — Run: `./gradlew :app:testDebugUnitTest --tests 'app.ccstudio.PanelJsonTest'` → Expected: コンパイルエラー
- [ ] **Step 3: 実装** — MainActivity の 4 関数の本体を**そのまま**移す（文字列・キー名は一字も変えない）:

```kotlin
package app.ccstudio

import org.json.JSONArray
import org.json.JSONObject

/** ネイティブ→WebView パネルへ渡す JSON の純粋ビルダー群（MainActivity から抽出）。 */
object PanelJson {
    fun plugins(list: List<PluginInfo>): String {
        val arr = JSONArray()
        list.forEach {
            arr.put(
                JSONObject()
                    .put("name", it.name)
                    .put("displayName", it.displayName)
                    .put("size", it.size)
                    .put("enabled", it.enabled)
                    .put("version", it.version ?: "")
                    .put("description", it.description ?: "")
                    .put("hasSettings", it.hasSettings)
                    .put("bundled", it.bundled)
                    .put("runAt", it.runAt)
                    .put("allFrames", it.allFrames)
            )
        }
        return arr.toString()
    }

    fun settingsList(total: Int, enabled: Int): String {
        val arr = JSONArray()
        arr.put(
            JSONObject().put("id", "plugins").put("group", "プラグイン").put("icon", "🧩")
                .put("label", "プラグイン管理")
                .put("sub", "$total 個インストール · $enabled 有効")
        )
        arr.put(
            JSONObject().put("id", "notify").put("group", "システム").put("icon", "🔔")
                .put("label", "通知").put("sub", "Stop / Notification フック")
        )
        arr.put(
            JSONObject().put("id", "log").put("group", "システム").put("icon", "📋")
                .put("label", "ログ").put("sub", "オブザーバーログを表示")
        )
        return arr.toString()
    }

    fun settingsView(info: PluginInfo?, valueOf: (ns: String, key: String) -> String?): String {
        if (info == null) return "{}"
        val ns = info.displayName
        val arr = JSONArray()
        info.settings.forEach { d ->
            val value = PluginSettings.coerce(d.type, valueOf(ns, d.key) ?: d.default)
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
            .put("name", ns)
            .put("displayName", info.displayName)
            .put("settings", arr)
            .toString()
    }

    fun effectiveSettings(map: Map<String, Map<String, Any>>): String {
        val root = JSONObject()
        map.forEach { (plugin, kv) ->
            val o = JSONObject()
            kv.forEach { (k, v) -> o.put(k, v) }
            root.put(plugin, o)
        }
        return root.toString()
    }
}
```

MainActivity 側は委譲に置換: `pluginsJson()` → `PanelJson.plugins(store.list())`、`settingsListJson()` → `store.list().let { PanelJson.settingsList(it.size, it.count { p -> p.enabled }) }`、`settingsViewJson()` → `PanelJson.settingsView(settingsTarget?.let { t -> store.list().firstOrNull { it.name == t } }) { ns, key -> store.settingValue(ns, key) }`、`effectiveSettingsJson()` → `PanelJson.effectiveSettings(store.effectiveSettings())`（`effectiveSettings()` の実際の戻り型に合わせて map 型を確定する）。

- [ ] **Step 4: パスを確認** — Run: 同上 → PASS
- [ ] **Step 5: 全テスト実行** — `./gradlew :app:testDebugUnitTest` → PASS
- [ ] **Step 6: Commit** — `refactor(app): パネル用 JSON 構築を PanelJson へ抽出`

### Task 3: NavModel — OS バック遷移表の抽出

**Files:**
- Create: `app/src/main/java/app/ccstudio/NavModel.kt`
- Test: `app/src/test/java/app/ccstudio/NavModelTest.kt`
- Modify: `MainActivity.kt`（sealed class Nav 57-64 / navStack 64 / popBack 616-651 / openSwitcher・showSwitcher・openSettingsEntry・onSwitcherTabChanged のスタック操作を NavModel 経由に）

**Interfaces:**
- Produces:

```kotlin
sealed class Nav {
    data class Switcher(var tab: String) : Nav()
    object PluginsScreen : Nav()
    object Notify : Nav()
    object Log : Nav()
    object PluginSettings : Nav()
}

sealed class PopAction {
    object ClosePluginSettings : PopAction()          // 下の PluginsScreen に戻る
    object CloseNotifyToSettings : PopAction()        // closeNotify + switcher(設定側)
    object CloseLogToSettings : PopAction()           // closeLog + switcher(設定側)
    object ShowSettingsSwitcher : PopAction()         // PluginsScreen から設定側へ
    object SwitchToScreensTab : PopAction()           // 設定側→スクリーン側（スタックに残す）
    object CloseSwitcher : PopAction()                // スクリーン側→閉じる
    object Fallback : PopAction()                     // 空スタック（WebView 履歴 or 背面へ）
}

class NavModel {
    val stack: MutableList<Nav>
    fun clear()
    fun push(nav: Nav)
    fun currentSwitcherTab(): String?                 // 最後の Switcher の tab（無ければ null）
    fun setSwitcherTab(tab: String)                   // 最後の Switcher の tab を更新（無ければ push）
    fun ensureSwitcher(tab: String)                   // Switcher が無ければ push（防御）
    fun pop(): PopAction
}
```

- [ ] **Step 1: 失敗するテストを書く** — popBack の docコメント（MainActivity 610-615 行）の遷移表を全行テスト化:

```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NavModelTest {
    @Test fun `PluginSettings は閉じて下の画面へ`() {
        val m = NavModel()
        m.push(Nav.Switcher("settings")); m.push(Nav.PluginsScreen); m.push(Nav.PluginSettings)
        assertEquals(PopAction.ClosePluginSettings, m.pop())
        assertEquals(PopAction.ShowSettingsSwitcher, m.pop()) // 続けて戻ると PluginsScreen → 設定側
    }
    @Test fun `Notify と Log は設定側 switcher へ戻る`() {
        val m = NavModel(); m.push(Nav.Notify)
        assertEquals(PopAction.CloseNotifyToSettings, m.pop())
        val m2 = NavModel(); m2.push(Nav.Log)
        assertEquals(PopAction.CloseLogToSettings, m2.pop())
    }
    @Test fun `Switcher 設定側からのバックはスクリーン側へ（スタックに残る）`() {
        val m = NavModel(); m.push(Nav.Switcher("settings"))
        assertEquals(PopAction.SwitchToScreensTab, m.pop())
        assertEquals("screens", m.currentSwitcherTab())
        assertEquals(PopAction.CloseSwitcher, m.pop()) // 次のバックで閉じる
    }
    @Test fun `Switcher スクリーン側からのバックは閉じる`() {
        val m = NavModel(); m.push(Nav.Switcher("screens"))
        assertEquals(PopAction.CloseSwitcher, m.pop())
        assertTrue(m.stack.isEmpty())
    }
    @Test fun `空スタックは Fallback`() {
        assertEquals(PopAction.Fallback, NavModel().pop())
    }
    @Test fun `setSwitcherTab は最後の Switcher を更新し無ければ push`() {
        val m = NavModel()
        m.setSwitcherTab("settings")
        assertEquals("settings", m.currentSwitcherTab())
        m.setSwitcherTab("screens")
        assertEquals(1, m.stack.size)
    }
    @Test fun `ensureSwitcher は既にあれば何もしない`() {
        val m = NavModel(); m.push(Nav.Switcher("screens")); m.push(Nav.Notify)
        m.ensureSwitcher("settings")
        assertEquals(2, m.stack.size)
    }
}
```

注意: `Nav.Switcher` は data class になるので、equals はタブ値込み。PopAction の同一性は object 比較で OK。

- [ ] **Step 2: 失敗を確認** → コンパイルエラー
- [ ] **Step 3: 実装** — popBack の when 分岐から「View を触る部分」を除いた判断だけを移す:

```kotlin
package app.ccstudio

/** OS バック用ナビスタックの純粋モデル。表示副作用は PopAction として呼び出し側が実行する。 */
sealed class Nav {
    data class Switcher(var tab: String) : Nav()
    object PluginsScreen : Nav()
    object Notify : Nav()
    object Log : Nav()
    object PluginSettings : Nav()
}

sealed class PopAction {
    object ClosePluginSettings : PopAction()
    object CloseNotifyToSettings : PopAction()
    object CloseLogToSettings : PopAction()
    object ShowSettingsSwitcher : PopAction()
    object SwitchToScreensTab : PopAction()
    object CloseSwitcher : PopAction()
    object Fallback : PopAction()
}

class NavModel {
    val stack = mutableListOf<Nav>()

    fun clear() = stack.clear()
    fun push(nav: Nav) { stack.add(nav) }
    fun currentSwitcherTab(): String? = stack.filterIsInstance<Nav.Switcher>().lastOrNull()?.tab

    fun setSwitcherTab(tab: String) {
        val entry = stack.filterIsInstance<Nav.Switcher>().lastOrNull()
        if (entry != null) entry.tab = tab else stack.add(Nav.Switcher(tab))
    }

    fun ensureSwitcher(tab: String) {
        if (stack.none { it is Nav.Switcher }) stack.add(Nav.Switcher(tab))
    }

    fun pop(): PopAction = when (val top = stack.removeLastOrNull()) {
        is Nav.PluginSettings -> PopAction.ClosePluginSettings
        is Nav.Notify -> PopAction.CloseNotifyToSettings
        is Nav.Log -> PopAction.CloseLogToSettings
        is Nav.PluginsScreen -> PopAction.ShowSettingsSwitcher
        is Nav.Switcher ->
            if (top.tab == "settings") {
                top.tab = "screens"
                stack.add(top)
                PopAction.SwitchToScreensTab
            } else PopAction.CloseSwitcher
        null -> PopAction.Fallback
    }
}
```

- [ ] **Step 4: パスを確認** → PASS
- [ ] **Step 5: MainActivity を NavModel へ差し替え** — `navStack` を `private val nav = NavModel()` に。`popBack()` は `when (nav.pop())` で従来と同じ副作用を実行（`Fallback` 分岐に既存の「可視オーバーレイを畳む／WebView 履歴／moveTaskToBack」防御をそのまま残す）。`showSwitcher(tab)` → `nav.setSwitcherTab(tab); showSwitcherView(tab)`。`openSettingsEntry` 冒頭の防御 → `nav.ensureSwitcher("settings")`。インナー sealed class Nav は削除。
- [ ] **Step 6: 全テスト実行** → PASS
- [ ] **Step 7: Commit** — `refactor(app): OS バック遷移表を NavModel へ抽出しテスト化`

### Task 4: ObserverIngest — オブザーバ報告の解釈と cancel 重複除去の抽出

**Files:**
- Create: `app/src/main/java/app/ccstudio/ObserverIngest.kt`
- Test: `app/src/test/java/app/ccstudio/ObserverIngestTest.kt`
- Modify: `MainActivity.kt`（`onObserverLog` 517-541 を委譲に。SharedPreferences の読み書きは Activity に残す）

**Interfaces:**
- Produces:

```kotlin
object ObserverIngest {
    const val CANCEL_DEDUP_MS = 15_000L
    sealed class Action {
        object RecordCancel : Action()
        object DropDuplicateCancel : Action()
        data class RecordState(val busy: Boolean, val disconnected: Boolean, val matched: String) : Action()
        object Ignore : Action()   // JSON 不正など
    }
    fun decide(json: String, lastCancelAtMs: Long, nowMs: Long): Action
}
```

- [ ] **Step 1: 失敗するテストを書く**

```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class ObserverIngestTest {
    @Test fun `cancel は窓の外なら記録`() {
        assertEquals(
            ObserverIngest.Action.RecordCancel,
            ObserverIngest.decide("""{"event":"cancel"}""", 0L, 100_000L),
        )
    }
    @Test fun `cancel は窓の内なら重複として捨てる`() {
        assertEquals(
            ObserverIngest.Action.DropDuplicateCancel,
            ObserverIngest.decide("""{"event":"cancel"}""", 100_000L, 100_000L + 14_999L),
        )
    }
    @Test fun `cancel 以外は状態記録`() {
        assertEquals(
            ObserverIngest.Action.RecordState(busy = true, disconnected = false, matched = "stop-btn"),
            ObserverIngest.decide("""{"busy":true,"disconnected":false,"matched":"stop-btn"}""", 0L, 1L),
        )
    }
    @Test fun `壊れた JSON は無視`() {
        assertEquals(ObserverIngest.Action.Ignore, ObserverIngest.decide("not-json", 0L, 1L))
    }
}
```

- [ ] **Step 2: 失敗を確認** → コンパイルエラー
- [ ] **Step 3: 実装**

```kotlin
package app.ccstudio

import org.json.JSONObject

/** state-observer プラグイン報告の解釈。cancel の重複除去判定を含む。純関数。 */
object ObserverIngest {
    /** 突発キャンセルの重複除去窓（ms）。この時間内の再報告はリロード再検知として捨てる。 */
    const val CANCEL_DEDUP_MS = 15_000L

    sealed class Action {
        object RecordCancel : Action()
        object DropDuplicateCancel : Action()
        data class RecordState(val busy: Boolean, val disconnected: Boolean, val matched: String) : Action()
        object Ignore : Action()
    }

    fun decide(json: String, lastCancelAtMs: Long, nowMs: Long): Action = try {
        val o = JSONObject(json)
        if (o.optString("event") == "cancel") {
            if (nowMs - lastCancelAtMs >= CANCEL_DEDUP_MS) Action.RecordCancel
            else Action.DropDuplicateCancel
        } else {
            Action.RecordState(
                o.optBoolean("busy", false),
                o.optBoolean("disconnected", false),
                o.optString("matched", ""),
            )
        }
    } catch (_: Exception) {
        Action.Ignore
    }
}
```

MainActivity 側の `onObserverLog` は screen/cwd の解決と SharedPreferences・ObserverLog 呼び出しだけを残し、判断を `ObserverIngest.decide(json, prefs.getLong("last_cancel_t", 0L), System.currentTimeMillis())` の when に置換。`CANCEL_DEDUP_MS` の companion 定数（1102 行）は削除して `ObserverIngest.CANCEL_DEDUP_MS` を参照。

- [ ] **Step 4: パスを確認** → PASS。全テスト実行 → PASS
- [ ] **Step 5: Commit** — `refactor(app): オブザーバ報告の解釈を ObserverIngest へ抽出`

### Task 5: DownloadController — ダウンロード一式の移設

**Files:**
- Create: `app/src/main/java/app/ccstudio/Downloads.kt`
- Test: `app/src/test/java/app/ccstudio/DownloadNamesTest.kt`
- Modify: `MainActivity.kt`（`handleDownload` 894-926 / `saveBase64Download` 929-964 / DownloadSink・downloads・downloadSeq・downloadBegin/Chunk/End/Abort 970-1050 / `sanitizeFilename` 1052-1057 / `uniqueFile` 1060-1072 / companion の `fetchBlobJs` 1123-1140 を移設）

**Interfaces:**
- Produces:
  - `object DownloadNames { fun sanitize(name: String, fallbackStamp: () -> String): String; fun unique(dir: File, name: String): File }`
  - `class DownloadController(private val activity: android.app.Activity, private val onToast: (String) -> Unit)` — メソッド: `handleDownload(url, contentDisposition, mimeType)` / `saveBase64(name, mime, base64)` / `begin(name, mime): String` / `chunk(token, base64): Boolean` / `end(token): Boolean` / `abort(token)` / companion `fun fetchBlobJs(url: String, name: String): String`
- 事前確認: `git grep -n 'fetchBlobJs'` で呼び出し元を特定し、参照を `DownloadController.fetchBlobJs` に更新（呼び出し元が無ければ bootstrap.js との関係をコメントで確認の上、そのまま移設して参照だけ残す）。

- [ ] **Step 1: 失敗するテストを書く**（純関数部分のみ。ストリーミング保存は Android API のため対象外）

```kotlin
package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DownloadNamesTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun `パス区切りと禁止文字を潰す`() {
        assertEquals("a_b_c.txt", DownloadNames.sanitize("dir/a\\b:c.txt") { "S" })
        assertEquals("x.txt", DownloadNames.sanitize("/deep/path/x.txt") { "S" })
    }
    @Test fun `空になったらフォールバック名`() {
        assertEquals("download_S", DownloadNames.sanitize("///") { "S" })
    }
    @Test fun `unique は重複時に連番を振る`() {
        val dir = tmp.root
        assertEquals("a.txt", DownloadNames.unique(dir, "a.txt").name)
        dir.resolve("a.txt").writeText("x")
        assertEquals("a(1).txt", DownloadNames.unique(dir, "a.txt").name)
        dir.resolve("a(1).txt").writeText("x")
        assertEquals("a(2).txt", DownloadNames.unique(dir, "a.txt").name)
    }
    @Test fun `拡張子なしでも連番が付く`() {
        tmp.root.resolve("name").writeText("x")
        assertEquals("name(1)", DownloadNames.unique(tmp.root, "name").name)
    }
    @Test fun `fetchBlobJs はクォートをエスケープする`() {
        val js = DownloadController.fetchBlobJs("blob:x'y", "a'b.txt")
        assertTrue(js.contains("blob:x\\'y"))
        assertTrue(js.contains("a\\'b.txt"))
    }
}
```

`sanitize` の `fallbackStamp` は既存の `SystemClock.elapsedRealtime()`（Android API）を注入可能にするための引数。既存呼び出しはラムダで包む。

- [ ] **Step 2: 失敗を確認** → コンパイルエラー
- [ ] **Step 3: 実装** — MainActivity から該当ブロックを**そのまま** `Downloads.kt` へ移す。`DownloadController` は `activity.contentResolver` / `activity.getSystemService` / `activity.runOnUiThread` を使い、トーストは `onToast` コールバック経由。`sanitizeFilename` は `DownloadNames.sanitize(name) { SystemClock.elapsedRealtime().toString() }` に、`uniqueFile` は `DownloadNames.unique(dir, name)` に置換。MainActivity には `private val downloader = DownloadController(this) { toast(it) }` を置き、`buildBridge` の onSave/onDlBegin/onDlChunk/onDlEnd/onDlAbort と `setDownloadListener`・`downloadObserverLog` を委譲に置換。
- [ ] **Step 4: パスを確認 + 全テスト** → PASS
- [ ] **Step 5: ビルド確認** — Run: `./gradlew :app:assembleDebug` → Expected: BUILD SUCCESSFUL
- [ ] **Step 6: Commit** — `refactor(app): ダウンロード一式を DownloadController へ移設`

### Task 6: OverlayPanel — オーバーレイ WebView 4 枚の共通化

**Files:**
- Create: `app/src/main/java/app/ccstudio/OverlayPanel.kt`
- Modify: `MainActivity.kt`（switcher 573-599 / notifyView 690-708 / logView 711-729 / settingsView 806-824 の遅延生成＋表示切替を OverlayPanel に）

**Interfaces:**
- Produces:

```kotlin
/** file:///android_asset/<asset> を表示する遅延生成の全画面オーバーレイ。 */
class OverlayPanel(
    private val root: FrameLayout,
    private val asset: String,
    private val renderJs: String,                 // show のたびに評価する再描画フック
    private val newWebView: () -> WebView,        // MainActivity.newConfiguredWebView を注入
) {
    val viewOrNull: WebView?
    fun show()                                    // 生成→VISIBLE→bringToFront→renderJs
    fun hide()
    fun isVisible(): Boolean
    fun evaluate(js: String)                      // 生成済みのときだけ評価
}
```

- [ ] **Step 1: 実装**（Android View 依存のためユニットテストなし。ビルド＋既存テストで担保）

```kotlin
package app.ccstudio

import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout

class OverlayPanel(
    private val root: FrameLayout,
    private val asset: String,
    private val renderJs: String,
    private val newWebView: () -> WebView,
) {
    var viewOrNull: WebView? = null
        private set

    private fun ensure(): WebView = viewOrNull ?: newWebView().also {
        it.loadUrl("file:///android_asset/$asset")
        root.addView(
            it,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        viewOrNull = it
    }

    fun show() {
        val v = ensure()
        v.visibility = View.VISIBLE
        v.bringToFront()
        v.evaluateJavascript(renderJs, null)
    }

    fun hide() { viewOrNull?.visibility = View.GONE }
    fun isVisible(): Boolean = viewOrNull?.visibility == View.VISIBLE
    fun evaluate(js: String) { viewOrNull?.evaluateJavascript(js, null) }
}
```

- [ ] **Step 2: MainActivity を置換** — `switcher`/`notifyView`/`logView`/`settingsView` の 4 フィールドを `OverlayPanel` に。webViewClient は `newConfiguredWebView()` に `CcWebViewClient` を付けるラムダで注入（4 枚とも同じ）。switcher の `setSwitcherTabJs`/`refreshSwitcher` は `panel.evaluate(...)` に。popBack の防御分岐（638-642 行）は `listOf(notifyPanel, logPanel, settingsPanel, switcherPanel).any { it.isVisible() }` に。renderJs: switcher=`"window.__ccRenderScreens && window.__ccRenderScreens();"`、notify=`"window.__ccRenderNotify && window.__ccRenderNotify();"`、log=`"window.__ccRenderLog && window.__ccRenderLog();"`、settings=`"window.__ccRenderSettings && window.__ccRenderSettings();"`。
  - 注意: 既存 `showSwitcherView` は表示後に `setSwitcherTabJs(tab)` → `refreshSwitcher()` の順。OverlayPanel.show() が renderJs を評価するので、順序が変わらないよう switcher だけ `show()` 後に `evaluate(tabJs)` を呼ぶ形にする（renderJs と tab 設定はどちらも冪等な JS フックなので順序影響なし — 変更前後で呼ぶ JS の集合は同一）。
- [ ] **Step 3: 全テスト + ビルド** — `./gradlew :app:testDebugUnitTest :app:assembleDebug` → PASS / BUILD SUCCESSFUL
- [ ] **Step 4: Commit** — `refactor(app): オーバーレイ 4 枚の遅延生成・表示切替を OverlayPanel へ共通化`

### Task 7: ScreenFactory — WebView 生成とプラグイン注入の移設

**Files:**
- Create: `app/src/main/java/app/ccstudio/ScreenFactory.kt`
- Modify: `MainActivity.kt`（`newConfiguredWebView` 238-267 / `createWebScreen` 269-313 / `createSystemPluginsScreen` 339-347 / `registerScreenScripts` 459-483 / `reloadScreen` 449-452 / SETTINGS_RUNTIME_KEY・SETTINGS_RUNTIME_JS 1104-1120 を移設）

**Interfaces:**
- Consumes: `ExtensionRuntime.registerDocumentStart` / `PluginStore`（enabled/script/enabledScripts）/ `Screen`・`ScreenKind`
- Produces:

```kotlin
/** WebView 構成・スクリーン生成・プラグイン document-start 登録の一式。 */
class ScreenFactory(
    private val activity: android.app.Activity,
    private val store: PluginStore,
    private val deps: Deps,
) {
    class Deps(
        val nextId: () -> Long,
        val buildBridge: (screenId: Long) -> CcBridge,
        val onFileChooser: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Boolean,
        val onDownload: (url: String, contentDisposition: String?, mimeType: String?) -> Unit,
        val onRendererGone: (RenderProcessGoneDetail?) -> Boolean,
        val isExternalHttp: (Uri) -> Boolean,
        val openExternalUrl: (Uri) -> Unit,
        val injectAsset: (WebView, String) -> Unit,
        val effectiveSettingsJson: () -> String,
        val currentGeneration: () -> Int,
        val onScreenNavigated: (Screen) -> Unit,   // persistScreens 相当（URL 更新時）
    )
    fun newConfiguredWebView(screenId: Long = -1L): WebView
    fun createWebScreen(url: String, reloadOnFirstLoad: Boolean = false): Screen
    fun createSystemPluginsScreen(): Screen
    fun registerScreenScripts(s: Screen)
    fun reloadScreen(s: Screen)
}
```

- [ ] **Step 1: 実装** — 該当メソッド群を**ロジック不変で**移設。`CcWebViewClient`（基底）も ScreenFactory 内へ移し、MainActivity 側は `screenFactory.newConfiguredWebView()` を OverlayPanel の `newWebView` にも使う。`handleRendererGone`・`rendererGoneHandled` は Activity 再作成（`recreate()`）を伴うため MainActivity に残し、`Deps.onRendererGone` で渡す。`Screen.loadedGeneration = pluginGeneration` の更新は `currentGeneration()` 経由。`onPageFinished` 内の `persistScreens()`・`screen.url` 更新は `onScreenNavigated(screen)` に集約。
- [ ] **Step 2: MainActivity 側の残置確認** — 残るのは: ライフサイクル・intent・権限、フィールド（screens/store/nav/panels/downloader/factory）、buildBridge、スクリーン操作（openScreenForCwd/persistScreens/bumpGenerationAndSync/onSessionState/onObserverLog/pushMenuState/refreshKeepAliveScreenCount）、popBack の副作用、settingsEntry 遷移、dispatchMarkdownPreviewKey、appIconDataUri、小物ヘルパ。
- [ ] **Step 3: 全テスト + ビルド** → PASS / BUILD SUCCESSFUL。`wc -l MainActivity.kt` で 650 行以下を確認（目安）。
- [ ] **Step 4: Commit** — `refactor(app): WebView 生成とプラグイン注入を ScreenFactory へ移設`

### Task 8: プラグイン規約の文書化

**Files:**
- Create: `plugins/README.md`

**Interfaces:** なし（文書のみ。プラグイン `.js` の動作コードは触らない — Global Constraints 参照）

- [ ] **Step 1: plugins/README.md を書く** — 8 本の現物から抽出した共通規約を記述する。章立て:
  1. メタヘッダ（`==CCStudioPlugin==` ブロック、`@name/@version/@description/@run-at/@all-frames/@setting` の意味と既定値 — PluginMetaParser の実装に一致させる）
  2. 設定ランタイム（`window.__ccPluginSettings` の読み方、`ccstudio:setting` イベントでのライブ反映、`@setting` 宣言と namespace=@name の関係）
  3. フレーム構成の作法（all-frames×document-start 常駐、非トップフレーム→トップへの postMessage 集約、webview iframe 内での動作、BroadcastChannel 橋渡し — chat-link-open / state-observer / selectable-text の実例を参照として挙げる）
  4. ネイティブ連携（`window.CCStudio` ブリッジの主な口と、どのプラグインが何を呼ぶか）
  5. 診断の作法（focus-hud のログバッファへの出力、select-diag のような一時診断プラグインの位置づけ）
  6. 命名・バージョニング（ファイル名=ID、displayName=@name、version bump の慣行）
- [ ] **Step 2: 記述の正確性確認** — 各記述を現物ソース（plugins/*.js、PluginMeta.kt、bootstrap.js、MainActivity の SETTINGS_RUNTIME_JS）と突き合わせ、ソースに無い仕様を書いていないことを確認。
- [ ] **Step 3: Commit** — `docs(plugins): プラグイン規約（メタヘッダ・設定・フレーム構成・ブリッジ）を文書化`

### Task 9: 最終検証

- [ ] **Step 1: 全テスト** — `./gradlew :app:testDebugUnitTest` → 全 PASS（既存 11 + 新規 5 テストクラス）
- [ ] **Step 2: ビルド** — `./gradlew :app:assembleDebug` → BUILD SUCCESSFUL、`app/build/outputs/apk/debug/cc-studio-*.apk` 生成を確認
- [ ] **Step 3: 行数確認** — `wc -l app/src/main/java/app/ccstudio/*.kt | sort -rn | head` で MainActivity の縮小を記録
- [ ] **Step 4: 差分レビュー** — `git diff main --stat` を確認し、意図しない挙動変更（文字列変更・条件反転）が無いことを `git diff main -- app/src/main` の通読で確認
- [ ] **Step 5: Commit（残があれば）+ 完了報告**
