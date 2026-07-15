package app.ccstudio

sealed class OriginResult {
    data class Ok(val origin: String) : OriginResult()
    data class Err(val code: String) : OriginResult()   // empty | not_https | is_ip | no_dot
}

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
}
