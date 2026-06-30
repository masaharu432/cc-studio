package app.ccstudio

import android.webkit.WebView
import androidx.webkit.ScriptHandler

enum class ScreenKind { WEB, SYSTEM_PLUGINS }

/** 1スクリーン。WEB=code-server / SYSTEM_PLUGINS=ローカル plugins.html。 */
class Screen(
    val id: Long,
    val kind: ScreenKind,
    val webView: WebView,
) {
    var url: String = ""
    var title: String = ""
    var loadedGeneration: Int = 0
    /** Claude Code が処理中（DOM の停止/中断ボタンを検知）。bootstrap.js が報告。 */
    var busy: Boolean = false
    /** code-server セッションが切断/再接続中（DOM の接続喪失オーバーレイを検知）。 */
    var disconnected: Boolean = false
    val closeable: Boolean get() = kind == ScreenKind.WEB
    val pluginHandlers: MutableMap<String, ScriptHandler> = mutableMapOf()
    var kbHandler: ScriptHandler? = null

    val kindTag: String get() = when (kind) {
        ScreenKind.WEB -> "WEB"
        ScreenKind.SYSTEM_PLUGINS -> "SYSTEM_PLUGINS"
    }
}
