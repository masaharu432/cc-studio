package app.ccstudio

import org.json.JSONObject

/** state-observer プラグイン報告の解釈。cancel の重複除去判定を含む。純関数。 */
object ObserverIngest {
    /** 突発キャンセルの重複除去窓（ms）。この時間内の再報告はリロード再検知として捨てる。 */
    const val CANCEL_DEDUP_MS = 15_000L

    sealed class Action {
        object RecordCancel : Action()
        object DropDuplicateCancel : Action()
        data class RecordState(val busy: Boolean, val disconnected: Boolean, val matched: String) : Action()
        object Ignore : Action()

        // object 同士の equals は同一性で足りる。RecordState は data class で値比較。
    }

    /**
     * プラグインからの生 JSON を解釈する。
     * event=cancel は「中断メッセージが履歴に残るため、リロード（背面 kill→復帰の再作成含む）ごとに
     * 同じ中断が再検知される」問題があるので、直近 cancel から CANCEL_DEDUP_MS 未満の再報告は捨てる。
     */
    fun decide(json: String, lastCancelAtMs: Long, nowMs: Long): Action = try {
        val o = JSONObject(json)
        if (o.optString("event") == "cancel") {
            if (nowMs - lastCancelAtMs >= CANCEL_DEDUP_MS) Action.RecordCancel
            else Action.DropDuplicateCancel
        } else {
            Action.RecordState(
                o.optBoolean("busy", false),
                o.optBoolean("disconnected", false),
                o.optString("matched", ""),
            )
        }
    } catch (_: Exception) {
        Action.Ignore
    }
}
