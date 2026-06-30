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
            ScreenRow(3, "old-session", "/mnt/old-session", "WEB", false, true, true),
        ))
        val arr = JSONArray(json)
        assertEquals(3, arr.length())
        val plugins = arr.getJSONObject(0)
        assertEquals("Plugins", plugins.getString("title"))
        assertEquals(false, plugins.getBoolean("closeable"))
        assertEquals("", plugins.getString("path"))
        val web = arr.getJSONObject(2)
        assertEquals("old-session", web.getString("title"))
        assertTrue(web.getBoolean("stale"))
        assertEquals(true, web.getBoolean("closeable"))
    }

    @Test fun serializesBusyAndDisconnected() {
        val json = ScreensJson.build(listOf(
            ScreenRow(2, "a", "/a", "WEB", true, true, false, busy = true, disconnected = false),
            ScreenRow(3, "b", "/b", "WEB", false, true, false, busy = false, disconnected = true),
        ))
        val arr = JSONArray(json)
        assertEquals(true, arr.getJSONObject(0).getBoolean("busy"))
        assertEquals(false, arr.getJSONObject(0).getBoolean("disconnected"))
        assertEquals(false, arr.getJSONObject(1).getBoolean("busy"))
        assertEquals(true, arr.getJSONObject(1).getBoolean("disconnected"))
    }

    @Test fun defaultsAreFalse() {
        val json = ScreensJson.build(listOf(
            ScreenRow(1, "p", null, "SYSTEM_PLUGINS", false, false, false),
        ))
        val o = JSONArray(json).getJSONObject(0)
        assertEquals(false, o.getBoolean("busy"))
        assertEquals(false, o.getBoolean("disconnected"))
    }
}
