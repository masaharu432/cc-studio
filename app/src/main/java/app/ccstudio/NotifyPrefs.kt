package app.ccstudio

import android.content.Context
import org.json.JSONObject

/** 種類別の通知 ON/OFF を SharedPreferences に保存する。既定は全 ON。 */
object NotifyPrefs {
    private const val PREFS = "cc_notify_prefs"

    /** hook の kind を prefs キーへ。未知の種類は null。 */
    fun keyFor(kind: String): String? = when (kind) {
        "Stop" -> "stop"
        "Notification" -> "permission"
        else -> null
    }

    fun isEnabled(ctx: Context, kind: String): Boolean {
        val key = keyFor(kind) ?: return true
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(key, true)
    }

    fun setEnabled(ctx: Context, kind: String, enabled: Boolean) {
        val key = keyFor(kind) ?: return
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(key, enabled).apply()
    }

    fun toJson(ctx: Context): String {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return JSONObject()
            .put("stop", p.getBoolean("stop", true))
            .put("permission", p.getBoolean("permission", true))
            .toString()
    }
}
