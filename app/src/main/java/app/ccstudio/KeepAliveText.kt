package app.ccstudio

/**
 * 常駐通知の本文を組み立てる純関数。KeepAliveService が使う（JVM 単体テスト可能にするため分離）。
 * Android リソースに依存させず、言語は ja フラグで受ける。
 */
object KeepAliveText {
    fun statusLine(screens: Int, busy: Int, disconnected: Int, ja: Boolean): String {
        val sb = StringBuilder(if (ja) "スクリーン $screens 起動中" else "$screens screens running")
        if (busy > 0) sb.append(if (ja) " ・処理中 $busy" else " · busy $busy")
        if (disconnected > 0) sb.append(if (ja) " ・接続切れ $disconnected" else " · disconnected $disconnected")
        return sb.toString()
    }
}
