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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
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

    @Volatile private var uploading = false
    private val uploadRunnable = object : Runnable {
        override fun run() {
            triggerUpload()
            if (!stopped) handler.postDelayed(this, 60_000L)
        }
    }
    private val prefs by lazy { getSharedPreferences("cc_observer", MODE_PRIVATE) }
    private fun deviceId(): String {
        var id = prefs.getString("device_id", null)
        if (id == null) {
            id = java.util.UUID.randomUUID().toString().take(12)
            prefs.edit().putString("device_id", id).apply()
        }
        return id
    }

    override fun onCreate() {
        super.onCreate()
        createChannels()
        startForeground(NOTIFICATION_ID, buildKeepAliveNotification())
        connect()
        handler.postDelayed(uploadRunnable, 15_000L)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // MainActivity からスクリーン数が変わったときに送られてくる。常駐通知を貼り直して更新。
        // startForegroundService 契約（要 startForeground）を満たすため notify ではなく startForeground。
        if (intent?.action == ACTION_REFRESH) {
            startForeground(NOTIFICATION_ID, buildKeepAliveNotification())
        }
        if (intent?.action == ACTION_UPLOAD) triggerUpload()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopped = true
        handler.removeCallbacks(uploadRunnable)
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

    /** TARGET_URL から https://host/cc-notify を作る（ログアップロード先）。 */
    private fun postUrl(): String? {
        val base = BuildConfig.TARGET_URL.ifEmpty { return null }
        val schemeEnd = base.indexOf("://")
        if (schemeEnd < 0) return null
        val host = base.substring(schemeEnd + 3).substringBefore('/')
        return "https://$host/cc-notify"
    }

    /** 未送信分(t>lastUploadedT)を relay へ POST。成功で lastUploadedT を更新。失敗は次回再試行。 */
    private fun triggerUpload() {
        if (uploading || stopped) return
        val url = postUrl() ?: return
        uploading = true
        try {
            val lastT = prefs.getLong("last_uploaded_t", 0L)
            val delta = UploadDelta.select(ObserverLog.readAll(this), lastT)
            if (delta.count == 0) { uploading = false; return }
            val payload = JSONObject()
                .put("type", "cc-observer").put("device", deviceId())
                .put("sentAt", System.currentTimeMillis()).put("lines", delta.lines).toString()
            val req = Request.Builder().url(url)
                .post(payload.toRequestBody("application/json".toMediaType())).build()
            client.newCall(req).enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) { uploading = false }
                override fun onResponse(call: okhttp3.Call, response: Response) {
                    try { if (response.isSuccessful) prefs.edit().putLong("last_uploaded_t", delta.maxT).apply() }
                    finally { response.close(); uploading = false }
                }
            })
        } catch (e: Exception) { uploading = false }
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
                ObserverLog.keepalive(this@KeepAliveService, "open", "")
                triggerUpload()
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                handleEvent(text)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                ObserverLog.keepalive(this@KeepAliveService, "failure", (t.message ?: "").take(80))
                scheduleReconnect()
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                ObserverLog.keepalive(this@KeepAliveService, "closed", "code=$code $reason".take(80))
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
        val title = when (kind) {
            "Notification" -> "${getString(R.string.task_permission_title)} — $project"
            "Cancel" -> "${getString(R.string.task_cancel_title)} — $project"
            else -> "${getString(R.string.task_done_title)} — $project"
        }
        // フォルダ（cwd フルパス）を必ず表示。message があれば上に添える。
        val folder = cwd.ifEmpty { project }
        val body = if (message.isNotEmpty()) "$message\n$folder" else folder

        notifyTask(title, body, cwd, kind)
    }

    private fun notifyTask(title: String, body: String, cwd: String, kind: String) {
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
            .setPriority(NotificationCompat.PRIORITY_HIGH)      // Android 7 以下でのヘッドアップ用
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build()
        // セッション単位で更新（積み上げない）: tag+id namespace で foreground id=1 と衝突しない。
        // ただし Cancel は専用 tag に分離する。同じ cwd の直後の Stop（応答完了）が同一枠を
        // 上書きして「⚠️中断」が「✅完了」に化けるのを防ぐ（実測で発生）。
        val mgr = ContextCompat.getSystemService(this, NotificationManager::class.java)
        mgr?.notify(if (kind == "Cancel") CANCEL_TAG else TASK_TAG, cwd.hashCode(), n)
        Log.d("CcStudio", "cc_task notified: $title")
    }

    // ── 常駐通知 / チャンネル ────────────────────────────────────────────

    private fun createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            // 旧チャンネル（showBadge=true で作られていた）を削除して作り直す。
            // チャンネル設定はアプリから後変更できないため、ID を変えるしかない。
            mgr.deleteNotificationChannel(CHANNEL_ID_LEGACY)
            mgr.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID, getString(R.string.keepalive_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    // 常駐 foreground 通知はアイコンに赤バッジ（ドット）を出さない。
                    setShowBadge(false)
                }
            )
            // 旧 cc_task は IMPORTANCE_DEFAULT で作成済み（フロート表示されない）。
            // チャンネル設定は後変更できないため ID を変えて HIGH で作り直す。
            mgr.deleteNotificationChannel(TASK_CHANNEL_ID_LEGACY)
            mgr.createNotificationChannel(
                NotificationChannel(
                    TASK_CHANNEL_ID, getString(R.string.task_channel_name),
                    NotificationManager.IMPORTANCE_HIGH  // 他アプリ表示中でもヘッドアップ（フロート）表示
                ).apply {
                    enableVibration(true)
                    enableLights(true)
                }
            )
        }
    }

    private fun buildKeepAliveNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.keepalive_notification_title))
            .setContentText(
                KeepAliveText.statusLine(
                    NotifyState.screenCount, NotifyState.busyCount, NotifyState.disconnectedCount,
                    AppLang.isJa(this)
                )
            )
            .setSmallIcon(R.drawable.ic_keepalive)
            .setOngoing(true)
            // 起動中スクリーン数と更新時刻を表示する（[[cc-studio-terminology]] スクリーン）。
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setBadgeIconType(NotificationCompat.BADGE_ICON_NONE)
            .build()

    companion object {
        const val CHANNEL_ID = "cc_studio_keepalive"
        // 旧ブランド名（CC Web）時代に出荷したチャンネル。削除専用に値を保持する。
        const val CHANNEL_ID_LEGACY = "cc_web_keepalive"
        // 旧タスクチャンネル（IMPORTANCE_DEFAULT）。削除専用に値を保持。
        const val TASK_CHANNEL_ID_LEGACY = "cc_task"
        const val TASK_CHANNEL_ID = "cc_task_alerts"
        const val TASK_TAG = "cc_task"
        // Cancel 通知の専用 tag（同 cwd の Stop 通知に上書きされない別枠）
        const val CANCEL_TAG = "cc_cancel"
        const val NOTIFICATION_ID = 1
        const val EXTRA_OPEN_CWD = "app.ccstudio.OPEN_CWD"
        const val ACTION_REFRESH = "app.ccstudio.REFRESH_KEEPALIVE"
        const val ACTION_UPLOAD = "app.ccstudio.UPLOAD_OBSERVER_LOG"
    }
}
