package app.ccstudio

import android.content.Context
import org.json.JSONObject
import java.io.File

sealed class OriginResult {
    data class Ok(val origin: String) : OriginResult()
    data class Err(val code: String) : OriginResult()   // empty | not_https | is_ip | no_dot
}

data class ServerCfg(val origin: String? = null, val defaultFolder: String? = null)

object ServerConfigCodec {
    /** 入力を検証し、合格なら "https://host[:port]"（host 小文字化）を返す。IP・http・ドット無しは拒否。 */
    fun normalizeOrigin(input: String): OriginResult {
        val v = input.trim()
        if (v.isEmpty()) return OriginResult.Err("empty")
        if (v.startsWith("http://", ignoreCase = true)) return OriginResult.Err("not_https")
        var s = v.replaceFirst(Regex("^https://", RegexOption.IGNORE_CASE), "")
        s = s.substringBefore('/').substringBefore('?').substringBefore('#')
        if (s.isEmpty()) return OriginResult.Err("empty")
        // IPv6 リテラル（角括弧 or コロン2つ以上）は IP 扱いで拒否
        if (s.startsWith("[") || s.count { it == ':' } >= 2) return OriginResult.Err("is_ip")
        val host = s.replace(Regex(":\\d+$"), "")
        if (host.isEmpty()) return OriginResult.Err("empty")
        if (Regex("^\\d{1,3}(\\.\\d{1,3}){3}$").matches(host)) return OriginResult.Err("is_ip")
        if (!host.contains('.')) return OriginResult.Err("no_dot")
        return OriginResult.Ok("https://" + s.lowercase())
    }

    fun encode(cfg: ServerCfg): String =
        JSONObject().put("origin", cfg.origin ?: "").put("defaultFolder", cfg.defaultFolder ?: "").toString()

    fun decode(json: String?): ServerCfg {
        if (json.isNullOrBlank()) return ServerCfg()
        return try {
            val o = JSONObject(json)
            ServerCfg(
                origin = o.optString("origin", "").ifBlank { null },
                defaultFolder = o.optString("defaultFolder", "").ifBlank { null },
            )
        } catch (_: Exception) { ServerCfg() }
    }

    /** BuildConfig.TARGET_URL を初回シードに使えるか。使えるなら正規化 origin、不可なら null。 */
    fun seedOriginFrom(buildTargetUrl: String): String? =
        (normalizeOrigin(buildTargetUrl) as? OriginResult.Ok)?.origin
}

/** filesDir/server.json を原子的に read/write する薄い store。 */
class ServerConfig(private val file: File) {
    private var cache: ServerCfg = ServerConfigCodec.decode(readSafely())

    fun origin(): String? = cache.origin
    fun defaultFolder(): String? = cache.defaultFolder
    fun setOrigin(origin: String) { cache = cache.copy(origin = origin); persist() }
    fun setDefaultFolder(path: String?) { cache = cache.copy(defaultFolder = path?.ifBlank { null }); persist() }

    private fun readSafely(): String? =
        try { if (file.exists()) file.readText() else null } catch (_: Exception) { null }

    private fun persist() {
        val tmp = File(file.parentFile, file.name + ".tmp")
        try {
            file.parentFile?.mkdirs()
            tmp.writeText(ServerConfigCodec.encode(cache))
            if (!tmp.renameTo(file)) { tmp.copyTo(file, overwrite = true); tmp.delete() }
        } catch (_: Exception) { try { tmp.delete() } catch (_: Exception) {} }
    }

    companion object {
        fun forContext(ctx: Context): ServerConfig = ServerConfig(File(ctx.filesDir, "server.json"))
    }
}
