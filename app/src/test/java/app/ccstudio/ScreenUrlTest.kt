package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ScreenUrlTest {
    @Test fun extractsFolderPath() {
        val url = "https://h.ts.net/?folder=/mnt/win/Develop/cc-studio"
        assertEquals("/mnt/win/Develop/cc-studio", ScreenUrl.folderPath(url))
    }

    @Test fun decodesPercentEncoding() {
        val url = "https://h.ts.net/?folder=/home/a%20b/%E6%A0%AA"
        assertEquals("/home/a b/株", ScreenUrl.folderPath(url))
    }

    @Test fun folderNameIsBasename() {
        val url = "https://h.ts.net/?folder=/mnt/win/Develop/cc-studio"
        assertEquals("cc-studio", ScreenUrl.folderName(url))
    }

    @Test fun noFolderFallsBackToHost() {
        val url = "https://h.ts.net/"
        assertNull(ScreenUrl.folderPath(url))
        assertEquals("h.ts.net", ScreenUrl.folderName(url))
    }
}
