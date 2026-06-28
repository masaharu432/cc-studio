package app.ccstudio

/** 復元対象＝Web スクリーンの URL 群＋アクティブ index。System スクリーンは含めない。 */
data class ScreenState(val urls: List<String>, val activeIndex: Int)

object ScreenStateCodec {
    fun encode(s: ScreenState): String =
        (listOf(s.activeIndex.toString()) + s.urls).joinToString("\n")

    fun decode(text: String?): ScreenState {
        if (text.isNullOrBlank()) return ScreenState(emptyList(), 0)
        val lines = text.split("\n")
        val urls = lines.drop(1).filter { it.isNotBlank() }
        val idx = lines.firstOrNull()?.toIntOrNull() ?: 0
        val safeIdx = if (urls.isEmpty() || idx !in urls.indices) 0 else idx
        return ScreenState(urls, safeIdx)
    }
}
