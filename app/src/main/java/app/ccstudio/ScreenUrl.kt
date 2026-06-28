package app.ccstudio

import java.net.URI
import java.net.URLDecoder

/** code-server の URL から「開いているフォルダ」を読み取る純ヘルパー。 */
object ScreenUrl {
    fun folderPath(url: String): String? {
        val q = url.substringAfter('?', "").ifEmpty { return null }
        for (pair in q.split('&')) {
            val k = pair.substringBefore('=')
            if (k == "folder") {
                val v = pair.substringAfter('=', "")
                return try { URLDecoder.decode(v, "UTF-8") } catch (_: Exception) { v }
            }
        }
        return null
    }

    fun folderName(url: String): String {
        folderPath(url)?.let { p ->
            val trimmed = p.trimEnd('/')
            val base = trimmed.substringAfterLast('/')
            if (base.isNotEmpty()) return base
        }
        return try { URI(url).host ?: url } catch (_: Exception) { url }
    }
}
