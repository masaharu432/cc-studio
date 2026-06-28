package app.ccstudio

import android.content.Context

/** Web スクリーンの URL 群＋アクティブ index を SharedPreferences に保存/復元する薄い層。 */
class ScreenStore(context: Context) {
    private val prefs = context.getSharedPreferences("ccstudio_prefs", Context.MODE_PRIVATE)

    fun load(): ScreenState = ScreenStateCodec.decode(prefs.getString("screens_state", null))

    fun save(urls: List<String>, activeIndex: Int) {
        prefs.edit()
            .putString("screens_state", ScreenStateCodec.encode(ScreenState(urls, activeIndex)))
            .apply()
    }
}
