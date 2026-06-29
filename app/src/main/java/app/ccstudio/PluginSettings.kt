package app.ccstudio

/** プラグイン設定値の純粋なマージ/型変換。SharedPreferences I/O とは分離してテスト可能にする。 */
object PluginSettings {
    /** スキーマ default を raw（保存値）で上書きし、型に応じて coerce した値マップ（宣言順）。 */
    fun merge(defs: List<SettingDef>, raw: Map<String, String?>): Map<String, Any> {
        val out = LinkedHashMap<String, Any>()
        for (d in defs) {
            val v = raw[d.key] ?: d.default
            out[d.key] = coerce(d.type, v)
        }
        return out
    }

    /** 文字列表現を型に応じた値へ。v1 は boolean のみ（他は文字列のまま）。 */
    fun coerce(type: String, value: String): Any = when (type) {
        "boolean" -> value.equals("true", ignoreCase = true)
        else -> value
    }
}
