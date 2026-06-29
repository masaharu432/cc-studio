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

    @Test fun parsesSettingLines() {
        val js = """
            // ==CCStudioPlugin==
            // @name        focus-hud
            // @setting     visible boolean true HUD を表示
            // @setting     compact boolean false コンパクト表示
            // ==/CCStudioPlugin==
            (function(){})();
        """.trimIndent()
        val m = PluginMetaParser.parse(js)
        assertTrue(m.hasSettings) // @setting があれば true
        assertEquals(2, m.settings.size)
        val s0 = m.settings[0]
        assertEquals("visible", s0.key)
        assertEquals("boolean", s0.type)
        assertEquals("true", s0.default)
        assertEquals("HUD を表示", s0.label) // ラベルは空白を含み行末まで
        assertEquals("compact", m.settings[1].key)
        assertEquals("false", m.settings[1].default)
    }

    @Test fun ignoresUnknownSettingTypeAndMalformedLines() {
        val js = """
            // ==CCStudioPlugin==
            // @setting     mode enum a foo
            // @setting     broken
            // @setting     ok boolean true ラベル
            // ==/CCStudioPlugin==
        """.trimIndent()
        val m = PluginMetaParser.parse(js)
        assertEquals(1, m.settings.size) // boolean の正常行のみ
        assertEquals("ok", m.settings[0].key)
    }

    @Test fun noSettingsYieldsEmptyList() {
        val m = PluginMetaParser.parse("(function(){})();")
        assertTrue(m.settings.isEmpty())
    }
}
