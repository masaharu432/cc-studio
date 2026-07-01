package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class UploadDeltaTest {
    private val sample = listOf(
        """{"t":100,"a":1}""",
        """{"t":200,"a":2}""",
        """{"t":300,"a":3}""",
    ).joinToString("\n") + "\n"

    @Test fun selectsOnlyNewerThanLastT() {
        val r = UploadDelta.select(sample, 150)
        assertEquals(2, r.count)
        assertEquals(300, r.maxT)
        assertEquals("""{"t":200,"a":2}""" + "\n" + """{"t":300,"a":3}""", r.lines)
    }

    @Test fun emptyWhenNothingNewer() {
        val r = UploadDelta.select(sample, 300)
        assertEquals(0, r.count)
        assertEquals(300, r.maxT)
        assertEquals("", r.lines)
    }

    @Test fun skipsUnparseableLines() {
        val r = UploadDelta.select("not-json\n" + """{"t":10}""" + "\n", 0)
        assertEquals(1, r.count)
        assertEquals(10, r.maxT)
    }
}
