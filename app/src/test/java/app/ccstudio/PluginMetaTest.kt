package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PluginMetaTest {
    @Test fun parsesFullHeader() {
        val js = """
            // ==CCStudioPlugin==
            // @name        keyboard-suppress
            // @version     1.2.0
            // @description 物理キーボードの自動表示を抑制する。
            // @settings    true
            // @run-at      document-idle
            // @all-frames  false
            // ==/CCStudioPlugin==
            (function(){})();
        """.trimIndent()
        val m = PluginMetaParser.parse(js)
        assertEquals("keyboard-suppress", m.name)
        assertEquals("1.2.0", m.version)
        assertEquals("物理キーボードの自動表示を抑制する。", m.description)
        assertTrue(m.hasSettings)
        assertEquals("document-idle", m.runAt)
        assertFalse(m.allFrames)
    }

    @Test fun missingHeaderYieldsEmptyMeta() {
        val m = PluginMetaParser.parse("(function(){})();")
        assertNull(m.name)
        assertNull(m.version)
        assertNull(m.description)
        assertFalse(m.hasSettings)
        // 既定値: 全フレーム × document-start。
        assertEquals("document-start", m.runAt)
        assertTrue(m.allFrames)
    }

    @Test fun settingsFalseOrAbsentIsFalse() {
        val js = "// ==CCStudioPlugin==\n// @version 0.1\n// ==/CCStudioPlugin==\n"
        val m = PluginMetaParser.parse(js)
        assertEquals("0.1", m.version)
        assertFalse(m.hasSettings)
    }

    @Test fun injectionFieldsDefaultWhenAbsent() {
        val js = "// ==CCStudioPlugin==\n// @name x\n// ==/CCStudioPlugin==\n"
        val m = PluginMetaParser.parse(js)
        assertEquals("document-start", m.runAt)
        assertTrue(m.allFrames)
    }

    @Test fun unknownRunAtFallsBackToDocumentStart() {
        val js = "// ==CCStudioPlugin==\n// @run-at whenever\n// ==/CCStudioPlugin==\n"
        assertEquals("document-start", PluginMetaParser.parse(js).runAt)
    }

    @Test fun allFramesTrueIsDefaultAndExplicitFalseHonored() {
        val on = "// ==CCStudioPlugin==\n// @all-frames true\n// ==/CCStudioPlugin==\n"
        val off = "// ==CCStudioPlugin==\n// @all-frames false\n// ==/CCStudioPlugin==\n"
        assertTrue(PluginMetaParser.parse(on).allFrames)
        assertFalse(PluginMetaParser.parse(off).allFrames)
    }
}
