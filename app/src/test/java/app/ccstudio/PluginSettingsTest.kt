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
        assertEquals(true, PluginSettings.coerce("boolean", "TRUE"))
        assertEquals(false, PluginSettings.coerce("boolean", "nope"))
    }
}
