package app.ccstudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class KeepAliveService : Service() {

    private val client = OkHttpClient()
    private var ws: WebSocket? = null
    @Volatile private var stopped = false
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    @Volatile private var backoffMs = 2000L
    private val reconnectRunnable = Runnable { connect() }

    override fun onCreate() {
        super.onCreate()
        createChannels()
        startForeground(NOTIFICATION_ID, buildKeepAliveNotification())
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopped = true
        try { ws?.close(1000, null) } catch (_: Exception) {}
        super.onDestroy()
    }

    // ── WebSocket ───────────────────────────────────────────────────────

    /** TARGET_URL（https://host[:port]/…）から wss://host[:port]/cc-notify/ws を作る。 */
    private fun wsUrl(): String? {
        val base = BuildConfig.TARGET_URL.ifEmpty { return null }
        val schemeEnd = base.indexOf("://")
        if (schemeEnd < 0) return null
        val scheme = base.substring(0, schemeEnd)
        val host = base.substring(schemeEnd + 3).substringBefore('/')
        val wsScheme = if (scheme == "https") "wss" else "ws"
        return "$wsScheme://$host/cc-notify/ws"
    }

    private fun connect() {
        if (stopped) return
        val url = wsUrl() ?: return
        // tailnet ゲートのみ（[[cc-studio-tailnet-only]]）。cookie/トークン不要。
        val request = Request.Builder().url(url).build()
        ws?.cancel()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                backoffMs = 2000L
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                handleEvent(text)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scheduleReconnect()
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (stopped) return
        handler.removeCallbacks(reconnectRunnable)
        handler.postDelayed(reconnectRunnable, backoffMs)
        backoffMs = (backoffMs * 2).coerceAtMost(60000L)
    }

    // ── イベント処理 ─────────────────────────────────────────────────────

    private fun handleEvent(text: String) {
        val json = try { JSONObject(text) } catch (e: Exception) {
            Log.w("CcStudio", "bad cc-notify payload", e); return
        }
        if (json.optString("event") != "cc-notify") return
        val cwd = json.optString("cwd")
        if (!NotifyDecision.shouldNotify(NotifyState.foreground, NotifyState.activeFolder, cwd)) return

        val kind = json.optString("kind", "Stop")
        if (!NotifyPrefs.isEnabled(this, kind)) return
        val project = json.optString("project")
        val message = json.optString("message")
        val title = if (kind == "Notification")
            "${getString(R.string.task_permission_title)} — $project"
        else
            "${getString(R.string.task_done_title)} — $project"
        val body = if (message.isNotEmpty()) message else project

        notifyTask(title, body, cwd)
    }

    private fun notifyTask(title: String, body: String, cwd: String) {
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(EXTRA_OPEN_CWD, cwd)
        }
        val pi = PendingIntent.getActivity(
            this, cwd.hashCode(), tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(this, TASK_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(R.drawable.ic_keepalive)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        // セッション単位で更新（積み上げない）: tag+id namespace で foreground id=1 と衝突しない
        val mgr = ContextCompat.getSystemService(this, NotificationManager::class.java)
        mgr?.notify(TASK_TAG, cwd.hashCode(), n)
        Log.d("CcStudio", "cc_task notified: $title")
    }

    // ── 常駐通知 / チャンネル ────────────────────────────────────────────

    private fun createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID, getString(R.string.keepalive_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                )
            )
            mgr.createNotificationChannel(
                NotificationChannel(
                    TASK_CHANNEL_ID, getString(R.string.task_channel_name),
                    NotificationManager.IMPORTANCE_DEFAULT
                )
            )
        }
    }

    private fun buildKeepAliveNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.keepalive_notification_title))
            .setContentText(getString(R.string.keepalive_notification_text))
            .setSmallIcon(R.drawable.ic_keepalive)
            .setColor(ContextCompat.getColor(this, R.color.keepalive_accent))
            .setColorized(true)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    companion object {
        const val CHANNEL_ID = "cc_web_keepalive"
        const val TASK_CHANNEL_ID = "cc_task"
        const val TASK_TAG = "cc_task"
        const val NOTIFICATION_ID = 1
        const val EXTRA_OPEN_CWD = "app.ccstudio.OPEN_CWD"
    }
}
