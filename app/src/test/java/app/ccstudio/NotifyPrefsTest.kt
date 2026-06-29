package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotifyPrefsTest {
    @Test fun mapsKindToKey() {
        assertEquals("stop", NotifyPrefs.keyFor("Stop"))
        assertEquals("permission", NotifyPrefs.keyFor("Notification"))
        assertNull(NotifyPrefs.keyFor("Other"))
    }
}
