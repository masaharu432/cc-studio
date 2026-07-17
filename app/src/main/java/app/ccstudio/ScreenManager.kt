package app.ccstudio

import android.view.View
import android.widget.FrameLayout

/**
 * スクリーン集合とアクティブを管理し、表示は visibility 切替（A案）。
 * System スクリーン（Plugins）は先頭固定・close 不可。
 */
class ScreenManager(private val container: FrameLayout) {
    // screens は UI スレッドが変更（add/close/select）し、JavaBridge スレッドが読む
    // （listScreens → rows / onObserverLog → byId）。素の MutableList のままでは
    // ConcurrentModificationException や途中状態の読み出しが起きるため、リスト操作は
    // lock で守り、読み出しはスナップショットを返す。WebView のライフサイクル操作
    // （addView/destroy 等）は従来どおり呼び出し元（UI）スレッドで lock の外。
    private val lock = Any()
    private val screens = mutableListOf<Screen>()
    @Volatile private var activeId: Long = -1
    private var idSeq: Long = 0

    /** アクティブスクリーンが変わるたびに呼ばれる（NotifyState 更新用）。 */
    var onActiveChanged: ((Screen?) -> Unit)? = null

    fun nextId(): Long = synchronized(lock) { ++idSeq }

    fun add(screen: Screen) {
        synchronized(lock) { screens.add(screen) }
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

    fun all(): List<Screen> = synchronized(lock) { screens.toList() }
    fun webScreens(): List<Screen> = synchronized(lock) { screens.filter { it.kind == ScreenKind.WEB } }
    fun byId(id: Long): Screen? = synchronized(lock) { screens.firstOrNull { it.id == id } }
    fun activeOrNull(): Screen? = byId(activeId)
    fun active(): Screen = activeOrNull() ?: all().first()

    fun select(id: Long) {
        val target = byId(id) ?: return
        activeId = id
        for (s in all()) s.webView.visibility =
            if (s.id == id) View.VISIBLE else View.GONE
        target.webView.requestFocus()
        onActiveChanged?.invoke(target)
    }

    /** Web スクリーンを閉じる。閉じたら隣をアクティブ化。System は閉じない。 */
    fun close(id: Long): Boolean {
        val s: Screen
        val wasActive: Boolean
        var next: Screen? = null
        synchronized(lock) {
            s = screens.firstOrNull { it.id == id } ?: return false
            if (!s.closeable) return false
            wasActive = id == activeId
            val idx = screens.indexOf(s)
            screens.remove(s)
            if (wasActive) next = screens.getOrNull(idx) ?: screens.lastOrNull()
        }
        container.removeView(s.webView)
        s.webView.destroy()
        if (wasActive) {
            val n = next
            if (n != null) select(n.id) else { activeId = -1; onActiveChanged?.invoke(null) }
        }
        return true
    }

    /** switcher 用の行データ。集合順（Plugins 先頭、続いて Web を追加順）。 */
    fun rows(currentGeneration: Int): List<ScreenRow> = synchronized(lock) {
        screens.map { s ->
            ScreenRow(
                id = s.id,
                title = if (s.kind == ScreenKind.WEB) ScreenUrl.folderName(s.url) else s.title,
                path = if (s.kind == ScreenKind.WEB) ScreenUrl.folderPath(s.url) else null,
                kind = s.kindTag,
                active = s.id == activeId,
                closeable = s.closeable,
                stale = s.kind == ScreenKind.WEB && s.loadedGeneration < currentGeneration,
                busy = s.kind == ScreenKind.WEB && s.busy,
                disconnected = s.kind == ScreenKind.WEB && s.disconnected,
            )
        }
    }
}
