package app.ccstudio

/** 通知の出し分け（副作用なし・JVM テスト可能）。 */
object NotifyDecision {
    /** cwd が folder と一致、または folder 配下なら true。 */
    fun matches(folder: String?, cwd: String?): Boolean {
        if (folder.isNullOrEmpty() || cwd.isNullOrEmpty()) return false
        val f = folder.trimEnd('/')
        val c = cwd.trimEnd('/')
        return c == f || c.startsWith("$f/")
    }

    /** 前面で見ているスクリーンそのものの結果だけ抑制。それ以外は通知する。 */
    fun shouldNotify(foreground: Boolean, activeFolder: String?, eventCwd: String?): Boolean {
        if (foreground && matches(activeFolder, eventCwd)) return false
        return true
    }
}
