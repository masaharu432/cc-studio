package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Test

class PluginSettingsTest {
    private val defs = listOf(
        SettingDef("visible", "boolean", "true", "表示"),
        SettingDef("compact", "boolean", "false", "コンパクト"),
    )

    @Test fun usesDefaultWhenRawMissing() {
        val out = PluginSettings.merge(defs, emptyMap())
        assertEquals(true, out["visible"])
        assertEquals(false, out["compact"])
    }

    @Test fun rawOverridesDefaultAndCoercesBoolean() {
        val out = PluginSettings.merge(defs, mapOf("visible" to "false", "compact" to "true"))
        assertEquals(false, out["visible"])
        assertEquals(true, out["compact"])
    }

    @Test fun nullRawFallsBackToDefault() {
        val out = PluginSettings.merge(defs, mapOf("visible" to null))
        assertEquals(true, out["visible"])
    }

    @Test fun ignoresRawKeysNotInSchema() {
        val out = PluginSettings.merge(defs, mapOf("ghost" to "true"))
        assertEquals(setOf("visible", "compact"), out.keys)
    }

    @Test fun coerceBooleanIsCaseInsensitive() {
        val d = SettingDef("visible", "boolean", "true", "表示")
        assertEquals(true, PluginSettings.coerce(d, "TRUE"))
        assertEquals(false, PluginSettings.coerce(d, "nope"))
    }

    // ---- v2: number ----

    private val numDef = SettingDef("shrink", "number", "0.75", "縮小率", min = 0.5, max = 1.0, step = 0.05)

    @Test fun numberCoercesToDouble() {
        assertEquals(0.8, PluginSettings.coerce(numDef, "0.8"))
    }

    @Test fun numberClampsToRange() {
        assertEquals(0.5, PluginSettings.coerce(numDef, "0.2"))
        assertEquals(1.0, PluginSettings.coerce(numDef, "9"))
    }

    @Test fun numberFallsBackToDefaultOnGarbage() {
        assertEquals(0.75, PluginSettings.coerce(numDef, "abc"))
    }

    @Test fun mergeEmitsNumberValues() {
        val out = PluginSettings.merge(listOf(numDef), mapOf("shrink" to "0.65"))
        assertEquals(0.65, out["shrink"])
    }
}
