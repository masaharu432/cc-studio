package app.ccstudio

/** プラグイン設定値の純粋なマージ/型変換。SharedPreferences I/O とは分離してテスト可能にする。 */
object PluginSettings {
    /** スキーマ default を raw（保存値）で上書きし、型に応じて coerce した値マップ（宣言順）。 */
    fun merge(defs: List<SettingDef>, raw: Map<String, String?>): Map<String, Any> {
        val out = LinkedHashMap<String, Any>()
        for (d in defs) {
            val v = raw[d.key] ?: d.default
            out[d.key] = coerce(d, v)
        }
        return out
    }

    /**
     * 文字列表現を型に応じた値へ。number は [min,max] へ clamp（壊れた保存値への防御）。
     * 数値でない raw は default へフォールバック。
     */
    fun coerce(def: SettingDef, value: String): Any = when (def.type) {
        "boolean" -> value.equals("true", ignoreCase = true)
        "number" -> {
            var v = value.toDoubleOrNull() ?: def.default.toDoubleOrNull() ?: 0.0
            def.min?.let { if (v < it) v = it }
            def.max?.let { if (v > it) v = it }
            v
        }
        else -> value
    }
}
