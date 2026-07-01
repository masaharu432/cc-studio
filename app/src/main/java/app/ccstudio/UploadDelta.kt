package app.ccstudio

import org.json.JSONObject

/** 永続ログ本文から「lastT より新しい行」を抽出する純関数。バイトオフセット不要でローテートに頑健。 */
object UploadDelta {
    data class Result(val lines: String, val maxT: Long, val count: Int)

    fun select(text: String, lastT: Long): Result {
        val out = ArrayList<String>()
        var maxT = lastT
        for (line in text.split("\n")) {
            val s = line.trim()
            if (s.isEmpty()) continue
            val t = try { JSONObject(s).optLong("t", -1) } catch (_: Exception) { -1 }
            if (t < 0) continue
            if (t > lastT) {
                out.add(s)
                if (t > maxT) maxT = t
            }
        }
        return Result(out.joinToString("\n"), maxT, out.size)
    }
}
