package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ObserverLogStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun appendsOneLinePerRecord() {
        val store = ObserverLogStore(tmp.root)
        store.append("""{"a":1}""")
        store.append("""{"a":2}""")
        val lines = java.io.File(tmp.root, "observer.log").readLines()
        assertEquals(2, lines.size)
        assertEquals("""{"a":1}""", lines[0])
        assertEquals("""{"a":2}""", lines[1])
    }

    @Test fun rotatesWhenOverSize() {
        val store = ObserverLogStore(tmp.root, maxBytes = 64)
        repeat(20) { store.append("""{"i":$it,"pad":"xxxxxxxxxx"}""") }
        val cur = java.io.File(tmp.root, "observer.log")
        val old = java.io.File(tmp.root, "observer.1.log")
        assertTrue(old.exists())
        assertTrue(cur.exists())
        assertTrue(cur.readText().contains("\"i\":19"))
    }
}
