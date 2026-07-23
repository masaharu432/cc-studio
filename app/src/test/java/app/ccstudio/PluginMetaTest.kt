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

    @Test fun parsesJaDescriptionSuffix() {
        val js = """
            // ==CCStudioPlugin==
            // @name        x
            // @description English text.
            // @description:ja 日本語の説明。
            // ==/CCStudioPlugin==
        """.trimIndent()
        val m = PluginMetaParser.parse(js)
        assertEquals("English text.", m.description)
        assertEquals("日本語の説明。", m.descriptionJa)
    }

    @Test fun settingJaSuffixOverridesLabelOnly() {
        val js = """
            // ==CCStudioPlugin==
            // @setting     visible boolean true Show the HUD
            // @setting:ja  visible HUD を表示
            // ==/CCStudioPlugin==
        """.trimIndent()
        val d = PluginMetaParser.parse(js).settings.single()
        assertEquals("Show the HUD", d.label)
        assertEquals("HUD を表示", d.labelJa)
        assertEquals("boolean", d.type)
        assertEquals("true", d.default)
    }

    @Test fun jaSuffixAbsentYieldsNulls() {
        val js = """
            // ==CCStudioPlugin==
            // @description Only English.
            // @setting     visible boolean true Show
            // ==/CCStudioPlugin==
        """.trimIndent()
        val m = PluginMetaParser.parse(js)
        assertNull(m.descriptionJa)
        assertNull(m.settings.single().labelJa)
    }

    @Test fun settingJaForUnknownKeyIsIgnored() {
        val js = """
            // ==CCStudioPlugin==
            // @setting     visible boolean true Show
            // @setting:ja  nosuch 存在しないキー
            // ==/CCStudioPlugin==
        """.trimIndent()
        val m = PluginMetaParser.parse(js)
        assertNull(m.settings.single().labelJa)
    }

    // ---- v2: number 型 ----

    @Test fun numberSettingParsesWithRange() {
        val js = """
            // ==CCStudioPlugin==
            // @setting     shrink number 0.75 0.5 1.0 0.05 Chrome shrink ratio
            // @setting:ja  shrink 外枠の縮小率
            // ==/CCStudioPlugin==
        """.trimIndent()
        val d = PluginMetaParser.parse(js).settings.single()
        assertEquals("number", d.type)
        assertEquals("0.75", d.default)
        assertEquals(0.5, d.min!!, 0.0)
        assertEquals(1.0, d.max!!, 0.0)
        assertEquals(0.05, d.step!!, 0.0)
        assertEquals("Chrome shrink ratio", d.label)
        assertEquals("外枠の縮小率", d.labelJa)
    }

    @Test fun numberSettingInvalidRowsAreDropped() {
        val js = """
            // ==CCStudioPlugin==
            // @setting     a number 0.75 0.5 1.0 Chrome missing step
            // @setting     b number abc 0.5 1.0 0.05 non-numeric default
            // @setting     c number 0.2 0.5 1.0 0.05 default out of range
            // @setting     d number 0.75 1.0 0.5 0.05 min greater than max
            // @setting     e number 0.75 0.5 1.0 0 zero step
            // @setting     ok boolean true still parsed
            // ==/CCStudioPlugin==
        """.trimIndent()
        val m = PluginMetaParser.parse(js)
        assertEquals(listOf("ok"), m.settings.map { it.key })
    }

    @Test fun booleanSettingHasNoRange() {
        val js = """
            // ==CCStudioPlugin==
            // @setting     visible boolean true Show
            // ==/CCStudioPlugin==
        """.trimIndent()
        val d = PluginMetaParser.parse(js).settings.single()
        assertNull(d.min); assertNull(d.max); assertNull(d.step)
    }
}
