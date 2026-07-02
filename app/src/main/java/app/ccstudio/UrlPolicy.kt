package app.ccstudio

/** workbench 内/外の URL 判定と、通知タップ用 folder URL の構築。純関数。 */
object UrlPolicy {
    /** workbench 以外の http(s) ホストへのナビゲーションか（＝外部ブラウザで開くべきか）。 */
    fun isExternalHttp(scheme: String?, host: String?, workbenchHost: String?): Boolean {
        val s = scheme?.lowercase() ?: return false
        if (s != "http" && s != "https") return false
        if (host == null || workbenchHost == null) return false
        return !host.equals(workbenchHost, ignoreCase = true)
    }

    /** targetUrl のスキーム+ホストに ?folder=<cwd> を付けた URL。構築できなければ null。 */
    fun folderUrl(targetUrl: String, cwd: String): String? {
        val schemeEnd = targetUrl.indexOf("://")
        if (schemeEnd < 0) return null
        val host = targetUrl.substring(schemeEnd + 3).substringBefore('/')
        val base = targetUrl.substring(0, schemeEnd) + "://" + host
        return "$base/?folder=" + java.net.URLEncoder.encode(cwd, "UTF-8")
    }
}
