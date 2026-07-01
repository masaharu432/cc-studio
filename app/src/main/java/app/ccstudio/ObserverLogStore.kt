package app.ccstudio

import android.content.Context
import java.io.File

/**
 * 観測ログを1行 JSONL で追記＋即フラッシュし、サイズ超過で1世代ローテートするストア。
 * dir を注入するので JVM 単体テスト可能。append は同期（複数コンポーネントから呼ばれる）。
 */
class ObserverLogStore(private val dir: File, private val maxBytes: Long = 512L * 1024) {
    private val lock = Any()

    fun append(line: String) = synchronized(lock) {
        try {
            if (!dir.exists()) dir.mkdirs()
            val cur = File(dir, "observer.log")
            if (cur.exists() && cur.length() >= maxBytes) {
                val old = File(dir, "observer.1.log")
                old.delete()
                cur.renameTo(old)
            }
            cur.appendText(line + "\n", Charsets.UTF_8)
        } catch (_: Exception) { /* ログ機能はアプリを落とさない */ }
    }

    /** ローテート分（observer.1.log）＋現行（observer.log）を古い順に連結して返す。 */
    fun readAll(): String = synchronized(lock) {
        val sb = StringBuilder()
        try { File(dir, "observer.1.log").takeIf { it.exists() }?.let { sb.append(it.readText(Charsets.UTF_8)) } } catch (_: Exception) {}
        try { File(dir, "observer.log").takeIf { it.exists() }?.let { sb.append(it.readText(Charsets.UTF_8)) } } catch (_: Exception) {}
        sb.toString()
    }
}

/** アプリ全体で共有する単一ストア。MainActivity と KeepAliveService の両方から使う。 */
object ObserverLog {
    @Volatile private var store: ObserverLogStore? = null
    fun of(context: Context): ObserverLogStore =
        store ?: synchronized(this) {
            store ?: ObserverLogStore(
                context.getExternalFilesDir("observer") ?: File(context.filesDir, "observer")
            ).also { store = it }
        }

    fun screenState(context: Context, screen: String, cwd: String, busy: Boolean, disc: Boolean, matched: String) =
        of(context).append(ObserverRecord.screenState(System.currentTimeMillis(), screen, cwd, busy, disc, matched))

    fun keepalive(context: Context, event: String, detail: String) =
        of(context).append(ObserverRecord.keepalive(System.currentTimeMillis(), event, detail, NotifyState.activeFolder ?: ""))

    fun lifecycle(context: Context, event: String) =
        of(context).append(ObserverRecord.lifecycle(System.currentTimeMillis(), event, NotifyState.activeFolder ?: ""))

    fun readAll(context: Context): String = of(context).readAll()
}
