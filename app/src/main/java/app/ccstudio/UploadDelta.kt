package app.ccstudio

import org.json.JSONObject

/** 永続ログ本文から「未送信の行」を抽出する純関数。バイトオフセット不要でローテートに頑健。 */
object UploadDelta {
    /** countAtMaxT: maxT と同じ t を持つ行のファイル内累計。次回カーソルの countAtLastT に渡す。 */
    data class Result(val lines: String, val maxT: Long, val count: Int, val countAtMaxT: Int = 0)

    /**
     * カーソルは (lastT, countAtLastT)。t > lastT の行に加え、t == lastT の行のうち
     * 先頭 countAtLastT 件を飛ばした残り（スナップショット後に同ミリ秒で追記された行）も拾う。
     * ファイルは追記専用なのでファイル内の行順は安定。既定の countAtLastT = Int.MAX_VALUE は
     * 旧来の「t > lastT のみ」挙動。残る制約: 時計が巻き戻ると t < lastT の新規行は拾えない。
     */
    fun select(text: String, lastT: Long, countAtLastT: Int = Int.MAX_VALUE): Result {
        val out = ArrayList<String>()
        var maxT = lastT
        var seenAtLast = 0   // t == lastT の行のファイル内累計
        var countAtMax = 0   // t == maxT (> lastT) の行数
        for (line in text.split("\n")) {
            val s = line.trim()
            if (s.isEmpty()) continue
            val t = try { JSONObject(s).optLong("t", -1) } catch (_: Exception) { -1 }
            if (t < 0) continue
            if (t < lastT) continue
            if (t == lastT) {
                seenAtLast++
                if (seenAtLast > countAtLastT) out.add(s)  // 先頭 countAtLastT 件は前回送信済み
            } else {
                out.add(s)
                if (t > maxT) { maxT = t; countAtMax = 1 } else if (t == maxT) countAtMax++
            }
        }
        return Result(out.joinToString("\n"), maxT, out.size, if (maxT == lastT) seenAtLast else countAtMax)
    }
}
