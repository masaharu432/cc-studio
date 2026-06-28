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
