package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DownloadNamesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `パス区切りは最後の要素だけ残し禁止文字を潰す`() {
        assertEquals("c.txt", DownloadNames.sanitize("dir/a\\b/c.txt") { "S" })
        assertEquals("a_b_c.txt", DownloadNames.sanitize("a:b*c.txt") { "S" })
        assertEquals("x.txt", DownloadNames.sanitize("/deep/path/x.txt") { "S" })
    }

    @Test
    fun `空になったらフォールバック名`() {
        assertEquals("download_S", DownloadNames.sanitize("///") { "S" })
        assertEquals("download_S", DownloadNames.sanitize("  ") { "S" })
    }

    @Test
    fun `unique は重複時に連番を振る`() {
        val dir = tmp.root
        assertEquals("a.txt", DownloadNames.unique(dir, "a.txt").name)
        dir.resolve("a.txt").writeText("x")
        assertEquals("a(1).txt", DownloadNames.unique(dir, "a.txt").name)
        dir.resolve("a(1).txt").writeText("x")
        assertEquals("a(2).txt", DownloadNames.unique(dir, "a.txt").name)
    }

    @Test
    fun `拡張子なしでも連番が付く`() {
        tmp.root.resolve("name").writeText("x")
        assertEquals("name(1)", DownloadNames.unique(tmp.root, "name").name)
    }

    @Test
    fun `fetchBlobJs はクォートをエスケープする`() {
        val js = DownloadController.fetchBlobJs("blob:x'y", "a'b.txt")
        assertTrue(js.contains("blob:x\\'y"))
        assertTrue(js.contains("a\\'b.txt"))
    }
}
