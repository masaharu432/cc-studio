package app.ccstudio

/** .js 先頭の userscript 風メタヘッダから取り出すプラグイン情報。 */
data class PluginMeta(
    val name: String?,
    val version: String?,
    /** 説明（英語・既定）。日本語は @description:ja → descriptionJa。 */
    val description: String?,
    val descriptionJa: String?,
    val hasSettings: Boolean,
    /** 注入タイミング: "document-start"（既定）/ "document-idle"。 */
    val runAt: String,
    /** 全フレームに注入するか（既定 true）。false ならトップフレームのみ。 */
    val allFrames: Boolean,
    /** `@setting <key> <type> <default> <label...>` の宣言（出現順）。 */
    val settings: List<SettingDef>,
)

/** プラグイン1つ分の設定項目スキーマ（v1 は type="boolean" のみ）。 */
data class SettingDef(
    val key: String,
    val type: String,
    val default: String,
    /** ラベル（英語・既定）。日本語は `@setting:ja <key> <label...>` → labelJa。 */
    val label: String,
    val labelJa: String? = null,
)

/**
 * `// ==CCStudioPlugin==` … `// ==/CCStudioPlugin==` ブロックを解析する。純関数。
 *
 * 対応フィールド（userscript / ブラウザ拡張の content_scripts に倣う）:
 *   @name @version @description @settings
 *   @run-at      document-start | document-idle   （既定 document-start）
 *   @all-frames  true | false                      （既定 true）
 * ロケール接尾辞（userscript の @description:ja に倣う。英語が既定・無い言語は英語へフォールバック）:
 *   @description:ja <日本語説明>
 *   @setting:ja     <key> <日本語ラベル...>   （ラベルのみ上書き。型・既定値は @setting 側）
 */
object PluginMetaParser {
    // フィールド名にハイフン（@run-at / @all-frames）とロケール接尾辞のコロン（@description:ja）を許す。
    private val FIELD = Regex("""^//\s*@([\w:-]+)\s+(.*\S)\s*$""")

    fun parse(script: String): PluginMeta {
        val lines = script.lineSequence().take(40).toList()
        val start = lines.indexOfFirst { it.contains("==CCStudioPlugin==") }
        if (start < 0)
            return PluginMeta(null, null, null, null, false, "document-start", true, emptyList())
        val fields = HashMap<String, String>()
        val settings = ArrayList<SettingDef>()
        val jaLabels = HashMap<String, String>()
        for (i in (start + 1) until lines.size) {
            val line = lines[i]
            if (line.contains("==/CCStudioPlugin==")) break
            val m = FIELD.find(line.trim()) ?: continue
            val key = m.groupValues[1].lowercase()
            val value = m.groupValues[2]
            when (key) {
                "setting" -> parseSettingDef(value)?.let { settings.add(it) }
                "setting:ja" -> parseSettingJa(value)?.let { (k, label) -> jaLabels[k] = label }
                else -> fields[key] = value
            }
        }
        // run-at は document-idle のみ idle 扱い、それ以外は document-start に正規化。
        val runAt = if (fields["run-at"]?.equals("document-idle", ignoreCase = true) == true)
            "document-idle" else "document-start"
        // all-frames は明示的に false のときだけ false。
        val allFrames = fields["all-frames"]?.equals("false", ignoreCase = true) != true
        // @settings true、または @setting 行が1つ以上あれば設定ありとみなす。
        val hasSettings =
            fields["settings"]?.equals("true", ignoreCase = true) == true || settings.isNotEmpty()
        return PluginMeta(
            name = fields["name"],
            version = fields["version"],
            description = fields["description"],
            descriptionJa = fields["description:ja"],
            hasSettings = hasSettings,
            runAt = runAt,
            allFrames = allFrames,
            settings = settings.map { d -> jaLabels[d.key]?.let { d.copy(labelJa = it) } ?: d },
        )
    }

    /** "<key> <label...>" を解析（@setting:ja 用）。不正なら null。 */
    private fun parseSettingJa(spec: String): Pair<String, String>? {
        val parts = spec.trim().split(Regex("\\s+"), limit = 2)
        if (parts.size < 2) return null
        if (!parts[0].matches(Regex("[\\w-]+"))) return null
        return parts[0] to parts[1]
    }

    /** "<key> <type> <default> <label...>" を解析。v1 は boolean のみ採用。不正/未知 type は null。 */
    private fun parseSettingDef(spec: String): SettingDef? {
        val parts = spec.trim().split(Regex("\\s+"), limit = 4)
        if (parts.size < 4) return null
        val key = parts[0]
        val type = parts[1].lowercase()
        val default = parts[2]
        val label = parts[3]
        if (type != "boolean") return null
        if (!key.matches(Regex("[\\w-]+"))) return null
        return SettingDef(key, type, default, label)
    }
}
