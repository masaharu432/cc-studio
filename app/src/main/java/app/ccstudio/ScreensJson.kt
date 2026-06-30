package app.ccstudio

import org.json.JSONArray
import org.json.JSONObject

data class ScreenRow(
    val id: Long,
    val title: String,
    val path: String?,
    val kind: String,        // "WEB" | "SYSTEM_PLUGINS"
    val active: Boolean,
    val closeable: Boolean,
    val stale: Boolean,
    val busy: Boolean = false,
    val disconnected: Boolean = false,
)

object ScreensJson {
    fun build(rows: List<ScreenRow>): String {
        val arr = JSONArray()
        for (r in rows) {
            arr.put(
                JSONObject()
                    .put("id", r.id)
                    .put("title", r.title)
                    .put("path", r.path ?: "")
                    .put("kind", r.kind)
                    .put("active", r.active)
                    .put("closeable", r.closeable)
                    .put("stale", r.stale)
                    .put("busy", r.busy)
                    .put("disconnected", r.disconnected)
            )
        }
        return arr.toString()
    }
}
