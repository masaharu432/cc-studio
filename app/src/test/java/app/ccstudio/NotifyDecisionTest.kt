package app.ccstudio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotifyDecisionTest {
    @Test fun matchesExactAndSubdir() {
        assertTrue(NotifyDecision.matches("/a/proj", "/a/proj"))
        assertTrue(NotifyDecision.matches("/a/proj", "/a/proj/sub/dir"))
        assertFalse(NotifyDecision.matches("/a/proj", "/a/project")) // prefix だが境界違い
        assertFalse(NotifyDecision.matches(null, "/a/proj"))
        assertFalse(NotifyDecision.matches("/a/proj", null))
    }

    @Test fun suppressOnlyWhenForegroundAndActiveMatches() {
        assertFalse(NotifyDecision.shouldNotify(true, "/a/proj", "/a/proj"))      // 見てる画面 → 抑制
        assertTrue(NotifyDecision.shouldNotify(false, "/a/proj", "/a/proj"))      // 背面 → 通知
        assertTrue(NotifyDecision.shouldNotify(true, "/a/other", "/a/proj"))      // 別画面 → 通知
        assertTrue(NotifyDecision.shouldNotify(true, null, "/a/proj"))            // 該当なし → 通知
    }

    @Test fun matchesPicksScreenByFolder() {
        // 「該当スクリーン選択」は matches を folder 一覧に適用する想定。
        val folders = listOf("/a/one", "/a/two")
        val hit = folders.firstOrNull { NotifyDecision.matches(it, "/a/two/src") }
        assertTrue(hit == "/a/two")
    }
}
