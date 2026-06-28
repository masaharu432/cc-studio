package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class ScreenStateTest {
    @Test fun roundTrips() {
        val s = ScreenState(listOf("https://h/?folder=/a", "https://h/?folder=/b"), 1)
        val decoded = ScreenStateCodec.decode(ScreenStateCodec.encode(s))
        assertEquals(s.urls, decoded.urls)
        assertEquals(1, decoded.activeIndex)
    }

    @Test fun decodeNullIsEmpty() {
        val d = ScreenStateCodec.decode(null)
        assertEquals(emptyList<String>(), d.urls)
        assertEquals(0, d.activeIndex)
    }

    @Test fun activeIndexClampedToRange() {
        val d = ScreenStateCodec.decode("9\nhttps://h/?folder=/a")
        assertEquals(0, d.activeIndex)
        assertEquals(1, d.urls.size)
    }
}
