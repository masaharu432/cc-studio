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

    @Test fun readAllConcatsRotatedThenCurrentOldestFirst() {
        val store = ObserverLogStore(tmp.root, maxBytes = 40)
        store.append("""{"i":0}""")            // これで observer.log
        repeat(5) { store.append("""{"i":${it + 1}}""") } // 途中でローテート発生
        val all = store.readAll()
        // 最初の行(古い=1.log 側)が、最後の行(新しい=log 側)より前に出る
        assertTrue(all.indexOf("\"i\":0") < all.indexOf("\"i\":5"))
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
