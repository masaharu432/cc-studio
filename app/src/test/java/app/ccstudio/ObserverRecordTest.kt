package app.ccstudio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ObserverRecordTest {
    @Test fun screenStateHasFields() {
        val o = JSONObject(ObserverRecord.screenState(1_700_000_000_000L, "cc-studio", "/mnt/x", false, true, "overlay:reconnecting"))
        assertEquals(1_700_000_000_000L, o.getLong("t"))
        assertTrue(o.getString("iso").isNotEmpty())
        assertEquals("screen", o.getString("src"))
        assertEquals("state", o.getString("kind"))
        assertEquals("cc-studio", o.getString("screen"))
        assertEquals("/mnt/x", o.getString("cwd"))
        assertEquals(false, o.getBoolean("busy"))
        assertEquals(true, o.getBoolean("disconnected"))
        assertEquals("overlay:reconnecting", o.getString("matched"))
    }

    @Test fun keepaliveHasFields() {
        val o = JSONObject(ObserverRecord.keepalive(1_700_000_000_000L, "failure", "code=1006", "/mnt/proj"))
        assertEquals("keepalive", o.getString("src"))
        assertEquals("ws", o.getString("kind"))
        assertEquals("failure", o.getString("event"))
        assertEquals("code=1006", o.getString("detail"))
        assertEquals("/mnt/proj", o.getString("active"))
    }

    @Test fun lifecycleHasFields() {
        val o = JSONObject(ObserverRecord.lifecycle(1_700_000_000_000L, "foreground", "/mnt/proj"))
        assertEquals("app", o.getString("src"))
        assertEquals("lifecycle", o.getString("kind"))
        assertEquals("foreground", o.getString("event"))
        assertEquals("/mnt/proj", o.getString("active"))
    }

    @Test fun cancelHasFields() {
        val o = JSONObject(ObserverRecord.cancel(1_700_000_000_000L, "cc-studio", "/mnt/x"))
        assertEquals("cancel", o.getString("src"))
        assertEquals("cancel", o.getString("kind"))
        assertEquals("cc-studio", o.getString("screen"))
        assertEquals("/mnt/x", o.getString("cwd"))
    }

    @Test fun lineIsSingleLine() {
        val s = ObserverRecord.screenState(1L, "a", "/a", true, false, "x")
        assertTrue(!s.contains("\n"))
    }
}
