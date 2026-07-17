package app.ccstudio

import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout

/**
 * file:///android_asset/<asset> を表示する遅延生成の全画面オーバーレイ
 * （switcher / notify / log / plugin-settings の共通形。MainActivity から抽出）。
 * show() のたびに renderJs を評価して最新状態で再描画させる。
 */
class OverlayPanel(
    private val root: FrameLayout,
    private val asset: String,
    private val renderJs: String,
    private val newWebView: () -> WebView,
) {
    var viewOrNull: WebView? = null
        private set

    private fun ensure(initialQuery: String?): WebView = viewOrNull ?: newWebView().also {
        val q = if (initialQuery.isNullOrEmpty()) "" else "?$initialQuery"
        it.loadUrl("file:///android_asset/$asset$q")
        root.addView(
            it,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        viewOrNull = it
    }

    /**
     * 表示する。initialQuery は初回生成時のみページ URL のクエリとして渡る（生成済みなら無視）。
     * loadUrl は非同期でロード完了前の evaluate は届かないため、初期状態はクエリで渡す用途。
     */
    fun show(initialQuery: String? = null) {
        val v = ensure(initialQuery)
        v.visibility = View.VISIBLE
        v.bringToFront()
        v.evaluateJavascript(renderJs, null)
    }

    fun hide() { viewOrNull?.visibility = View.GONE }

    fun isVisible(): Boolean = viewOrNull?.visibility == View.VISIBLE

    /** 生成済みのときだけ JS を評価する（未生成なら何もしない）。 */
    fun evaluate(js: String) { viewOrNull?.evaluateJavascript(js, null) }

    /** Activity 破棄時に WebView を外して destroy する（未生成なら何もしない）。 */
    fun destroy() {
        val v = viewOrNull ?: return
        viewOrNull = null
        root.removeView(v)
        try { v.destroy() } catch (_: Exception) {}
    }
}
