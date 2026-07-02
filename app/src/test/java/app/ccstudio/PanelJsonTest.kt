package app.ccstudio

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class PanelJsonTest {
    private fun info(
        name: String = "a.js",
        enabled: Boolean = true,
        settings: List<SettingDef> = emptyList(),
    ) = PluginInfo(
        name = name, size = 10L, enabled = enabled, displayName = name.removeSuffix(".js"),
        version = "1.0", description = "説明", hasSettings = settings.isNotEmpty(),
        bundled = false, runAt = "document-start", allFrames = true, settings = settings,
    )

    @Test
    fun `plugins は全フィールドを持つ配列`() {
        val arr = JSONArray(PanelJson.plugins(listOf(info())))
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
        val o = JSONArray(PanelJson.plugins(listOf(p))).getJSONObject(0)
        assertEquals("", o.getString("version"))
        assertEquals("", o.getString("description"))
    }

    @Test
    fun `settingsList はプラグイン数を sub に埋める`() {
        val arr = JSONArray(PanelJson.settingsList(3, 2))
        assertEquals("plugins", arr.getJSONObject(0).getString("id"))
        assertEquals("3 個インストール · 2 有効", arr.getJSONObject(0).getString("sub"))
        assertEquals("notify", arr.getJSONObject(1).getString("id"))
        assertEquals("log", arr.getJSONObject(2).getString("id"))
    }

    @Test
    fun `settingsView は保存値をスキーマに重ねる`() {
        val def = SettingDef("visible", "boolean", "true", "HUD を表示")
        val o = JSONObject(
            PanelJson.settingsView(info("hud.js", settings = listOf(def))) { ns, key ->
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
    fun `settingsView は保存値が無ければ default を使う`() {
        val def = SettingDef("visible", "boolean", "true", "HUD を表示")
        val o = JSONObject(PanelJson.settingsView(info("hud.js", settings = listOf(def))) { _, _ -> null })
        assertEquals(true, o.getJSONArray("settings").getJSONObject(0).getBoolean("value"))
    }

    @Test
    fun `settingsView は対象なしなら空オブジェクト`() {
        assertEquals("{}", PanelJson.settingsView(null) { _, _ -> null })
    }

    @Test
    fun `effectiveSettings はネストした JSON になる`() {
        val json = JSONObject(PanelJson.effectiveSettings(mapOf("hud" to mapOf("visible" to false))))
        assertEquals(false, json.getJSONObject("hud").getBoolean("visible"))
    }
}
