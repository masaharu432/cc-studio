package app.ccstudio

/** 常駐通知の本文を組み立てる純関数。KeepAliveService が使う（JVM 単体テスト可能にするため分離）。 */
object KeepAliveText {
    fun statusLine(screens: Int, busy: Int, disconnected: Int): String {
        val sb = StringBuilder("スクリーン $screens 起動中")
        if (busy > 0) sb.append(" ・処理中 $busy")
        if (disconnected > 0) sb.append(" ・接続切れ $disconnected")
        return sb.toString()
    }
}
