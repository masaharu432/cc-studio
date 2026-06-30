package app.ccstudio

/** KeepAliveService（別プロセス文脈）から参照する軽量な共有状態。MainActivity が更新する。 */
object NotifyState {
    @Volatile var foreground: Boolean = false
    @Volatile var activeFolder: String? = null
    /** 起動中の Web スクリーン数（Plugins システムスクリーンは含めない）。常駐通知に表示。 */
    @Volatile var screenCount: Int = 0
    /** 処理中の Web スクリーン数。常駐通知に表示。 */
    @Volatile var busyCount: Int = 0
    /** 接続切れ/再接続中の Web スクリーン数。常駐通知に表示。 */
    @Volatile var disconnectedCount: Int = 0
}
