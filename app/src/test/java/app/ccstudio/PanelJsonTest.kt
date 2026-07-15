package app.ccstudio

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class PanelJsonTest {
    private fun info(
        name: String = "a.js",
        enabled: Boolean = true,
        settings: List<SettingDef> = emptyList(),
    ) = PluginInfo(
        name = name, size = 10L, enabled = enabled, displayName = name.removeSuffix(".js"),
        version = "1.0", description = "説明", descriptionJa = null,
        hasSettings = settings.isNotEmpty(),
        bundled = false, runAt = "document-start", allFrames = true, settings = settings,
    )

    @Test
    fun `plugins は全フィールドを持つ配列`() {
        val arr = JSONArray(PanelJson.plugins(listOf(info()), ja = false))
        val o = arr.getJSONObject(0)
        assertEquals("a.js", o.getString("name"))
        assertEquals("a", o.getString("displayName"))
        assertEquals(true, o.getBoolean("enabled"))
        assertEquals("説明", o.getString("description"))
        assertEquals("document-start", o.getString("runAt"))
        assertEquals(true, o.getBoolean("allFrames"))
        assertEquals(false, o.getBoolean("bundled"))
    }

    @Test
    fun `plugins は null の version と description を空文字にする`() {
        val p = info().copy(version = null, description = null)
        val o = JSONArray(PanelJson.plugins(listOf(p), ja = false)).getJSONObject(0)
        assertEquals("", o.getString("version"))
        assertEquals("", o.getString("description"))
    }

    @Test
    fun `plugins は ja=true で日本語説明を優先しフォールバックする`() {
        val p = info().copy(description = "EN", descriptionJa = "JA")
        assertEquals("JA", JSONArray(PanelJson.plugins(listOf(p), ja = true)).getJSONObject(0).getString("description"))
        assertEquals("EN", JSONArray(PanelJson.plugins(listOf(p), ja = false)).getJSONObject(0).getString("description"))
        val p2 = info().copy(description = "EN", descriptionJa = null)
        assertEquals("EN", JSONArray(PanelJson.plugins(listOf(p2), ja = true)).getJSONObject(0).getString("description"))
    }

    @Test
    fun `settingsList はプラグイン数を sub に埋める`() {
        val arr = JSONArray(PanelJson.settingsList(3, 2, null, null, ja = true))
        assertEquals("plugins", arr.getJSONObject(0).getString("id"))
        assertEquals("3 個インストール · 2 有効", arr.getJSONObject(0).getString("sub"))
        assertEquals("server", arr.getJSONObject(1).getString("id"))
        assertEquals("notify", arr.getJSONObject(2).getString("id"))
        assertEquals("log", arr.getJSONObject(3).getString("id"))
        assertEquals("lang", arr.getJSONObject(4).getString("id"))
    }

    @Test
    fun `settingsList は言語で文言が切り替わる`() {
        val en = JSONArray(PanelJson.settingsList(3, 2, null, null, ja = false)).getJSONObject(0)
        assertEquals("Plugin manager", en.getString("label"))
        assertEquals("3 installed · 2 enabled", en.getString("sub"))
        val jp = JSONArray(PanelJson.settingsList(3, 2, null, null, ja = true)).getJSONObject(0)
        assertEquals("プラグイン管理", jp.getString("label"))
    }

    @Test
    fun `settingsView は保存値をスキーマに重ねる`() {
        val def = SettingDef("visible", "boolean", "true", "HUD を表示")
        val o = JSONObject(
            PanelJson.settingsView(info("hud.js", settings = listOf(def)), ja = false) { ns, key ->
                if (ns == "hud" && key == "visible") "false" else null
            },
        )
        assertEquals("hud", o.getString("name"))
        val s = o.getJSONArray("settings").getJSONObject(0)
        assertEquals(false, s.getBoolean("value"))
        assertEquals(true, s.getBoolean("default"))
        assertEquals("HUD を表示", s.getString("label"))
    }

    @Test
    fun `settingsView は ja=true で labelJa を優先しフォールバックする`() {
        val def = SettingDef("visible", "boolean", "true", "Show the HUD", "HUD を表示")
        val ja = JSONObject(PanelJson.settingsView(info("hud.js", settings = listOf(def)), ja = true) { _, _ -> null })
        assertEquals("HUD を表示", ja.getJSONArray("settings").getJSONObject(0).getString("label"))
        val en = JSONObject(PanelJson.settingsView(info("hud.js", settings = listOf(def)), ja = false) { _, _ -> null })
        assertEquals("Show the HUD", en.getJSONArray("settings").getJSONObject(0).getString("label"))
        val noJa = SettingDef("visible", "boolean", "true", "Show the HUD")
        val fb = JSONObject(PanelJson.settingsView(info("hud.js", settings = listOf(noJa)), ja = true) { _, _ -> null })
        assertEquals("Show the HUD", fb.getJSONArray("settings").getJSONObject(0).getString("label"))
    }

    @Test
    fun `settingsView は保存値が無ければ default を使う`() {
        val def = SettingDef("visible", "boolean", "true", "HUD を表示")
        val o = JSONObject(PanelJson.settingsView(info("hud.js", settings = listOf(def)), ja = false) { _, _ -> null })
        assertEquals(true, o.getJSONArray("settings").getJSONObject(0).getBoolean("value"))
    }

    @Test
    fun `settingsView は対象なしなら空オブジェクト`() {
        assertEquals("{}", PanelJson.settingsView(null, ja = false) { _, _ -> null })
    }

    @Test
    fun `effectiveSettings はネストした JSON になる`() {
        val json = JSONObject(PanelJson.effectiveSettings(mapOf("hud" to mapOf("visible" to false))))
        assertEquals(false, json.getJSONObject("hud").getBoolean("visible"))
    }

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
}
