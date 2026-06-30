package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class KeepAliveTextTest {
    @Test fun screensOnly() {
        assertEquals("スクリーン 3 起動中", KeepAliveText.statusLine(3, 0, 0))
    }

    @Test fun withBusy() {
        assertEquals("スクリーン 3 起動中 ・処理中 2", KeepAliveText.statusLine(3, 2, 0))
    }

    @Test fun withDisconnected() {
        assertEquals("スクリーン 3 起動中 ・接続切れ 1", KeepAliveText.statusLine(3, 0, 1))
    }

    @Test fun withBoth() {
        assertEquals("スクリーン 3 起動中 ・処理中 2 ・接続切れ 1", KeepAliveText.statusLine(3, 2, 1))
    }
}
