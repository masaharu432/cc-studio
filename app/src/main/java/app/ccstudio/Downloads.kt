package app.ccstudio

import android.app.Activity
import android.app.DownloadManager
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.CookieManager
import android.webkit.URLUtil
import java.io.File
import java.io.FileOutputStream

/** ダウンロードのファイル名処理。純関数（MainActivity から抽出）。 */
object DownloadNames {
    /** パス要素と禁止文字を潰した安全なファイル名。空になったら download_<stamp>。 */
    fun sanitize(name: String, fallbackStamp: () -> String): String {
        val cleaned = name.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1F]"), "_")
            .trim()
        return cleaned.ifEmpty { "download_${fallbackStamp()}" }
    }

    /** 同名ファイルが存在する場合に name(1).ext のような一意名を返す（API<29 用）。 */
    fun unique(dir: File, name: String): File {
        var candidate = File(dir, name)
        if (!candidate.exists()) return candidate
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var i = 1
        while (candidate.exists()) {
            candidate = File(dir, "$base($i)$ext")
            i++
        }
        return candidate
    }
}

/**
 * ダウンロード一式（MainActivity から移設）。
 * - handleDownload: WebView の DownloadListener フォールバック（主に http(s) 直リンク）
 * - saveBase64: JS から base64 一括で受けて Downloads へ保存
 * - begin/chunk/end/abort: 大きいファイル用のチャンク・ストリーミング保存
 */
class DownloadController(
    private val activity: Activity,
    private val onToast: (String) -> Unit,
) {

    /**
     * WebView の DownloadListener フォールバック。blob:/data: は bootstrap.js のフックが横取りするので
     * ここに来るのは主に http(s) の直リンク。
     */
    fun handleDownload(url: String, contentDisposition: String?, mimeType: String?) {
        try {
            when {
                url.startsWith("blob:") -> {
                    // blob: は bootstrap.js の JS フックが横取りして進捗バー付きで保存する。
                    // WebView は preventDefault と無関係に DownloadListener にも blob を通すため、
                    // ここで処理すると二重保存・二重通知になる。JS フックに一任して何もしない。
                    Log.d("CcStudio", "blob download owned by JS hook; skip native: $url")
                }
                url.startsWith("data:") -> {
                    val comma = url.indexOf(',')
                    val meta = url.substring(5, if (comma >= 0) comma else 5)
                    val mime = meta.substringBefore(';').ifEmpty { mimeType ?: "application/octet-stream" }
                    val data = if (comma >= 0) url.substring(comma + 1) else ""
                    saveBase64("download", mime, data)
                }
                else -> {
                    val request = DownloadManager.Request(Uri.parse(url)).apply {
                        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
                        setMimeType(mimeType)
                        CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                    }
                    (activity.getSystemService(Activity.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                    activity.runOnUiThread { onToast("ダウンロードを開始しました") }
                }
            }
        } catch (e: Exception) {
            Log.w("CcStudio", "handleDownload failed: $url", e)
            activity.runOnUiThread { onToast("ダウンロードに失敗しました") }
        }
    }

    /** base64 のダウンロードデータを端末の Downloads フォルダへ保存する。JS スレッドから呼ばれる。 */
    fun saveBase64(name: String, mime: String, base64: String) {
        var err: String? = null
        val ok = try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val filename = sanitizeFilename(name)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    if (mime.isNotEmpty()) put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = activity.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: error("MediaStore insert failed")
                resolver.openOutputStream(uri).use { out ->
                    (out ?: error("openOutputStream null")).write(bytes)
                }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                if (!dir.exists()) dir.mkdirs()
                FileOutputStream(DownloadNames.unique(dir, filename)).use { it.write(bytes) }
            }
            true
        } catch (e: Exception) {
            Log.w("CcStudio", "saveBase64Download failed: $name", e)
            err = e.message
            false
        }
        activity.runOnUiThread {
            if (ok) onToast("保存しました: $name") else onToast("保存に失敗しました")
        }
        if (!ok) Log.w("CcStudio", "save failed reason: $err")
    }

    // ── チャンク・ストリーミング ──────────────────────────────────────────
    // 大きいファイルでも巨大 base64 を一括で持たず、JS から少しずつ受けて追記する。
    // 進捗バーは JS 側（blob.size 基準）で描く。ここは保存先の生成・追記・確定のみ。

    private class DownloadSink(
        val uri: Uri?,            // MediaStore（API29+）
        val file: File?,          // legacy（API<29）
        val out: java.io.OutputStream,
        val name: String,
    )

    private val downloads = java.util.concurrent.ConcurrentHashMap<String, DownloadSink>()
    private val downloadSeq = java.util.concurrent.atomic.AtomicInteger(0)

    /** 保存先を開いて token を返す。失敗時は空文字。JS スレッドから呼ばれる。 */
    fun begin(name: String, mime: String): String {
        return try {
            val filename = sanitizeFilename(name)
            val token = "dl${downloadSeq.incrementAndGet()}"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    if (mime.isNotEmpty()) put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return ""
                val out = activity.contentResolver.openOutputStream(uri) ?: run {
                    activity.contentResolver.delete(uri, null, null); return ""
                }
                downloads[token] = DownloadSink(uri, null, out, filename)
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                if (!dir.exists()) dir.mkdirs()
                val file = DownloadNames.unique(dir, filename)
                downloads[token] = DownloadSink(null, file, FileOutputStream(file), filename)
            }
            token
        } catch (e: Exception) {
            Log.w("CcStudio", "downloadBegin failed: $name", e)
            ""
        }
    }

    /** base64 のチャンクを追記。JS スレッドから順に呼ばれる。 */
    fun chunk(token: String, base64: String): Boolean {
        val sink = downloads[token] ?: return false
        return try {
            sink.out.write(Base64.decode(base64, Base64.DEFAULT))
            true
        } catch (e: Exception) {
            Log.w("CcStudio", "downloadChunk failed", e)
            false
        }
    }

    /** 書き込み完了 → 保存確定。 */
    fun end(token: String): Boolean {
        val sink = downloads.remove(token) ?: return false
        return try {
            sink.out.flush(); sink.out.close()
            if (sink.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                activity.contentResolver.update(
                    sink.uri,
                    ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
                    null, null
                )
            }
            // 完了表示は JS 側の進捗バー（オーバーレイ）に一本化。ここではトーストを出さない。
            true
        } catch (e: Exception) {
            Log.w("CcStudio", "downloadEnd failed", e)
            false
        }
    }

    /** 途中失敗 → 書きかけを破棄。失敗表示も進捗バー側に任せる。 */
    fun abort(token: String) {
        val sink = downloads.remove(token) ?: return
        try { sink.out.close() } catch (_: Exception) {}
        try {
            if (sink.uri != null) activity.contentResolver.delete(sink.uri, null, null)
            else sink.file?.delete()
        } catch (_: Exception) {}
    }

    private fun sanitizeFilename(name: String): String =
        DownloadNames.sanitize(name) { SystemClock.elapsedRealtime().toString() }

    companion object {
        /**
         * blob: URL を fetch して base64 化し、CCStudio.saveBase64 に渡す JS。
         * 現在は未使用（bootstrap.js のフックが downloadBegin/Chunk/End を直接使う）。
         * チャンク経路が使えない場面の一括保存フォールバックとして保持。
         */
        fun fetchBlobJs(url: String, name: String): String {
            val u = url.replace("\\", "\\\\").replace("'", "\\'")
            val n = name.replace("\\", "\\\\").replace("'", "\\'")
            return """
                (function(){
                  fetch('$u').then(function(r){return r.blob();}).then(function(b){
                    var fr=new FileReader();
                    fr.onload=function(){
                      var res=fr.result; var c=res.indexOf(',');
                      var mime=(res.substring(5,c).split(';')[0])||b.type||'application/octet-stream';
                      window.CCStudio.saveBase64('$n', mime, res.substring(c+1));
                    };
                    fr.onerror=function(){ window.CCStudio.saveFailed('read error'); };
                    fr.readAsDataURL(b);
                  }).catch(function(e){ window.CCStudio.saveFailed(String(e)); });
                })();
            """.trimIndent()
        }
    }
}
