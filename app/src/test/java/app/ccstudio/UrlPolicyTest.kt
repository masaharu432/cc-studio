package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlPolicyTest {
    @Test
    fun `workbench と同一ホストは外部ではない`() {
        assertFalse(UrlPolicy.isExternalHttp("https", "h.ts.net", "h.ts.net"))
        assertFalse(UrlPolicy.isExternalHttp("https", "H.TS.NET", "h.ts.net"))
    }

    @Test
    fun `別ホストの http(s) は外部`() {
        assertTrue(UrlPolicy.isExternalHttp("https", "example.com", "h.ts.net"))
        assertTrue(UrlPolicy.isExternalHttp("http", "example.com", "h.ts.net"))
    }

    @Test
    fun `http(s) 以外・情報不足は外部扱いしない`() {
        assertFalse(UrlPolicy.isExternalHttp("file", null, "h.ts.net"))
        assertFalse(UrlPolicy.isExternalHttp(null, "example.com", "h.ts.net"))
        assertFalse(UrlPolicy.isExternalHttp("https", null, "h.ts.net"))
        assertFalse(UrlPolicy.isExternalHttp("https", "example.com", null))
    }

    @Test
    fun `folderUrl は cwd を URL エンコードして付ける`() {
        // URLEncoder.encode は既存実装と同じく空白を + にする（挙動維持）。
        assertEquals(
            "https://h.ts.net/?folder=%2Fhome%2Fa+b",
            UrlPolicy.folderUrl("https://h.ts.net/?folder=/mnt/win", "/home/a b"),
        )
    }

    @Test
    fun `folderUrl はパス無しの targetUrl でも組み立てる`() {
        assertEquals(
            "https://h.ts.net/?folder=%2Fx",
            UrlPolicy.folderUrl("https://h.ts.net", "/x"),
        )
    }

    @Test
    fun `folderUrl はスキームが無ければ null`() {
        assertEquals(null, UrlPolicy.folderUrl("not-a-url", "/x"))
    }
}
