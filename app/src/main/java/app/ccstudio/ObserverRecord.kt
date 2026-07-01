package app.ccstudio

import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 観測ログの1行 JSONL を組み立てる純関数群。時刻(t=epoch ms)から ISO8601(TZ付) を作る。 */
object ObserverRecord {
    private fun iso(t: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date(t))

    fun screenState(t: Long, screen: String, cwd: String, busy: Boolean, disconnected: Boolean, matched: String): String =
        JSONObject()
            .put("t", t).put("iso", iso(t)).put("src", "screen").put("kind", "state")
            .put("screen", screen).put("cwd", cwd)
            .put("busy", busy).put("disconnected", disconnected).put("matched", matched)
            .toString()

    fun keepalive(t: Long, event: String, detail: String, active: String): String =
        JSONObject()
            .put("t", t).put("iso", iso(t)).put("src", "keepalive").put("kind", "ws")
            .put("event", event).put("detail", detail).put("active", active)
            .toString()

    fun lifecycle(t: Long, event: String, active: String): String =
        JSONObject()
            .put("t", t).put("iso", iso(t)).put("src", "app").put("kind", "lifecycle")
            .put("event", event).put("active", active)
            .toString()
}
