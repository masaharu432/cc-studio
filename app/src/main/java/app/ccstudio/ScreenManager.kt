package app.ccstudio

import android.view.View
import android.widget.FrameLayout

/**
 * スクリーン集合とアクティブを管理し、表示は visibility 切替（A案）。
 * System スクリーン（Plugins）は先頭固定・close 不可。
 */
class ScreenManager(private val container: FrameLayout) {
    private val screens = mutableListOf<Screen>()
    private var activeId: Long = -1
    private var idSeq: Long = 0

    /** アクティブスクリーンが変わるたびに呼ばれる（NotifyState 更新用）。 */
    var onActiveChanged: ((Screen?) -> Unit)? = null

    fun nextId(): Long = ++idSeq

    fun add(screen: Screen) {
        screens.add(screen)
        container.addView(
            screen.webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        screen.webView.visibility = View.GONE
        if (activeId == -1L) select(screen.id)
    }

    fun all(): List<Screen> = screens.toList()
    fun webScreens(): List<Screen> = screens.filter { it.kind == ScreenKind.WEB }
    fun byId(id: Long): Screen? = screens.firstOrNull { it.id == id }
    fun activeOrNull(): Screen? = byId(activeId)
    fun active(): Screen = activeOrNull() ?: screens.first()

    fun select(id: Long) {
        val target = byId(id) ?: return
        activeId = id
        for (s in screens) s.webView.visibility =
            if (s.id == id) View.VISIBLE else View.GONE
        target.webView.requestFocus()
        onActiveChanged?.invoke(target)
    }

    /** Web スクリーンを閉じる。閉じたら隣をアクティブ化。System は閉じない。 */
    fun close(id: Long): Boolean {
        val s = byId(id) ?: return false
        if (!s.closeable) return false
        val wasActive = id == activeId
        val idx = screens.indexOf(s)
        screens.remove(s)
        container.removeView(s.webView)
        s.webView.destroy()
        if (wasActive) {
            val next = screens.getOrNull(idx) ?: screens.lastOrNull()
            if (next != null) select(next.id) else { activeId = -1; onActiveChanged?.invoke(null) }
        }
        return true
    }

    /** switcher 用の行データ。集合順（Plugins 先頭、続いて Web を追加順）。 */
    fun rows(currentGeneration: Int): List<ScreenRow> = screens.map { s ->
        ScreenRow(
            id = s.id,
            title = if (s.kind == ScreenKind.WEB) ScreenUrl.folderName(s.url) else s.title,
            path = if (s.kind == ScreenKind.WEB) ScreenUrl.folderPath(s.url) else null,
            kind = s.kindTag,
            active = s.id == activeId,
            closeable = s.closeable,
            stale = s.kind == ScreenKind.WEB && s.loadedGeneration < currentGeneration,
        )
    }
}
