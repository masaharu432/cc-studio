package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class KeepAliveTextTest {
    @Test fun screensOnlyJa() {
        assertEquals("スクリーン 3 起動中", KeepAliveText.statusLine(3, 0, 0, ja = true))
    }

    @Test fun withBusyJa() {
        assertEquals("スクリーン 3 起動中 ・処理中 2", KeepAliveText.statusLine(3, 2, 0, ja = true))
    }

    @Test fun withDisconnectedJa() {
        assertEquals("スクリーン 3 起動中 ・接続切れ 1", KeepAliveText.statusLine(3, 0, 1, ja = true))
    }

    @Test fun withBothJa() {
        assertEquals("スクリーン 3 起動中 ・処理中 2 ・接続切れ 1", KeepAliveText.statusLine(3, 2, 1, ja = true))
    }

    @Test fun screensOnlyEn() {
        assertEquals("3 screens running", KeepAliveText.statusLine(3, 0, 0, ja = false))
    }

    @Test fun withBothEn() {
        assertEquals("3 screens running · busy 2 · disconnected 1", KeepAliveText.statusLine(3, 2, 1, ja = false))
    }
}
