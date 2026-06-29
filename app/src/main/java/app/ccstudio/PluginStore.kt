package app.ccstudio

import android.content.Context
import android.net.Uri
import java.io.File

/** インストール済みプラグイン1枚分の情報。name（ファイル名）がそのまま id（plugins/<name>）。 */
data class PluginInfo(
    val name: String,                 // ファイル名＝内部ID（bridge 呼び出しのキー）
    val size: Long,
    val enabled: Boolean,
    val displayName: String,          // 表示名：@name があればそれ、無ければファイル名
    val version: String?,
    val description: String?,
    val hasSettings: Boolean,
    val bundled: Boolean,
    val runAt: String,                // "document-start" | "document-idle"
    val allFrames: Boolean,           // true: 全フレーム / false: トップフレームのみ
    val settings: List<SettingDef>,   // @setting 宣言（無ければ空）
)

/**
 * 複数のプラグインJSを filesDir/plugins 配下の .js ファイルとして管理する。
 * 有効/無効は per-plugin（SharedPreferences の文字列集合 enabled_plugins）。
 * 有効なプラグインだけが onPageFinished で注入される（グローバルな手動注入は廃止）。
 */
class PluginStore(private val context: Context) {

    private val prefs = context.getSharedPreferences("ccstudio_prefs", Context.MODE_PRIVATE)

    private fun pluginsDir(): File =
        File(context.filesDir, "plugins").apply { if (!exists()) mkdirs() }

    init { migrateLegacy() }

    /** 旧 v0.2（active.js 1枚 + autoInject フラグ）を新モデルへ移行。active.js はそのまま1プラグインとして残す。 */
    private fun migrateLegacy() {
        if (prefs.getBoolean("migrated_multi", false)) return
        val legacy = File(pluginsDir(), "active.js")
        if (legacy.exists() && legacy.length() > 0 && prefs.getBoolean("auto_inject", false)) {
            enable("active.js", true)
        }
        prefs.edit().putBoolean("migrated_multi", true).apply()
    }

    /** 単純なファイル名（パス区切りなし）だけを plugins 直下のファイルとして許可する。 */
    private fun fileFor(name: String): File? {
        if (name.isEmpty() || name.contains('/') || name.contains('\\') || name == "." || name == "..") return null
        return File(pluginsDir(), name)
    }

    private fun sanitize(name: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1F]"), "_").trim()
        val safe = base.ifEmpty { "plugin.js" }
        return if (safe.endsWith(".js", ignoreCase = true)) safe else "$safe.js"
    }

    private fun enabledSet(): MutableSet<String> =
        prefs.getStringSet("enabled_plugins", emptySet())!!.toMutableSet()

    /**
     * SAFで選ばれたJSを plugins/<name>.js にコピー。成功で保存名、失敗で null。
     * 「同じプラグイン」（@name 一致、無ければファイル名一致）が既にあれば、そのファイルへ上書き更新し
     * 重複インストールを作らない。上書き時は ON/OFF 状態（ファイル名キー）もそのまま保たれる。
     */
    fun installFromUri(uri: Uri, displayName: String?): String? {
        val bytes = try {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (e: Exception) { null } ?: return null

        val sanitized = sanitize(displayName ?: "plugin.js")
        val incomingName = try {
            PluginMetaParser.parse(String(bytes, Charsets.UTF_8)).name?.takeIf { it.isNotBlank() }
        } catch (_: Exception) { null }

        val targetName = findExisting(incomingName, sanitized) ?: sanitized
        val out = fileFor(targetName) ?: return null
        return try {
            out.outputStream().use { it.write(bytes) }
            targetName
        } catch (e: Exception) {
            null
        }
    }

    /**
     * 取り込むプラグインと「同じ」既存ファイル名を返す（無ければ null）。
     * ファイル名の完全一致を優先し、無ければ @name の一致（大小無視）で判定する。
     */
    private fun findExisting(incomingMetaName: String?, sanitizedFileName: String): String? {
        val files = pluginsDir()
            .listFiles { f -> f.isFile && f.name.endsWith(".js", ignoreCase = true) }
            ?: return null
        files.firstOrNull { it.name == sanitizedFileName }?.let { return it.name }
        if (incomingMetaName != null) {
            files.firstOrNull { f ->
                val m = try { PluginMetaParser.parse(f.readText()).name } catch (_: Exception) { null }
                m != null && m.equals(incomingMetaName, ignoreCase = true)
            }?.let { return it.name }
        }
        return null
    }

    /** インストール済みプラグイン一覧（名前順）。メタヘッダから version/description/settings を解析。 */
    fun list(): List<PluginInfo> {
        val enabled = enabledSet()
        val bundledNames = BUNDLED.keys
        return pluginsDir()
            .listFiles { f -> f.isFile && f.name.endsWith(".js", ignoreCase = true) }
            ?.sortedBy { it.name.lowercase() }
            ?.map { f ->
                val meta = PluginMetaParser.parse(f.readText())
                PluginInfo(
                    name = f.name,
                    size = f.length(),
                    enabled = enabled.contains(f.name),
                    displayName = meta.name?.takeIf { it.isNotBlank() } ?: f.name,
                    version = meta.version,
                    description = meta.description,
                    hasSettings = meta.hasSettings,
                    bundled = bundledNames.contains(f.name),
                    runAt = meta.runAt,
                    allFrames = meta.allFrames,
                    settings = meta.settings,
                )
            }
            ?: emptyList()
    }

    /** 有効なプラグインの情報（注入順＝名前順）。注入方式の出し分けに使う。 */
    fun enabled(): List<PluginInfo> = list().filter { it.enabled }

    /** プラグイン1枚のスクリプト本文。無ければ null。 */
    fun script(name: String): String? {
        val f = fileFor(name) ?: return null
        return if (f.exists() && f.length() > 0) f.readText() else null
    }

    /** 有効なプラグインのスクリプト（注入順＝名前順）。 */
    fun enabledScripts(): List<String> =
        list().filter { it.enabled }.mapNotNull { script(it.name) }

    /** 有効/無効を切り替える。 */
    fun enable(name: String, enabled: Boolean) {
        val set = enabledSet()
        if (enabled) set.add(name) else set.remove(name)
        prefs.edit().putStringSet("enabled_plugins", set).apply()
    }

    /** 設定値の生文字列（未保存は null）。キーは setting:<plugin>:<key>。 */
    fun settingValue(name: String, key: String): String? =
        prefs.getString("setting:$name:$key", null)

    /** 設定値を文字列で永続化（型解釈は呼び出し側 / PluginSettings に委ねる）。 */
    fun setSettingRaw(name: String, key: String, value: String) {
        prefs.edit().putString("setting:$name:$key", value).apply()
    }

    /** 対象プラグインの設定スキーマ（無ければ空）。 */
    fun settingsOf(name: String): List<SettingDef> =
        list().firstOrNull { it.name == name }?.settings ?: emptyList()

    /**
     * 設定を持つ全プラグインの「default を保存値で上書き＋型変換した」有効値マップ。
     * namespace は displayName(@name) を使う。プラグイン本体は自分の @name で設定を参照するため、
     * 内部IDのファイル名（focus-hud.js）ではなく @name（focus-hud）で揃える。
     */
    fun effectiveSettings(): Map<String, Map<String, Any>> {
        val out = LinkedHashMap<String, Map<String, Any>>()
        for (p in list()) {
            if (p.settings.isEmpty()) continue
            val raw = p.settings.associate { it.key to settingValue(p.displayName, it.key) }
            out[p.displayName] = PluginSettings.merge(p.settings, raw)
        }
        return out
    }

    /** プラグインを削除（ファイル削除 + 有効集合から除外）。組込みは「削除済み」として記録し再投入を抑止。 */
    fun remove(name: String): Boolean {
        enable(name, false)
        if (BUNDLED.containsKey(name)) {
            val removed = removedBundledSet().apply { add(name) }
            prefs.edit().putStringSet("removed_bundled", removed).apply()
        }
        val f = fileFor(name) ?: return false
        return if (f.exists()) f.delete() else false
    }

    private fun removedBundledSet(): MutableSet<String> =
        prefs.getStringSet("removed_bundled", emptySet())!!.toMutableSet()

    /**
     * 組込みプラグインを assets から filesDir へ**同期**する（毎起動）。
     * - ユーザーが削除した組込みは再投入しない（removed_bundled で記録）。
     * - それ以外は assets の最新内容で**上書き**する → アプリ更新で説明・バージョン・本体が追従する。
     * - 初回出現時（ファイルが無かった）のみ既定 ON。以後はユーザーの ON/OFF を尊重。
     */
    fun ensureBundledInstalled() {
        // 旧ロジック（初回1回きり）の削除済み状態を引き継ぐ: bundled_installed 済みでファイルが無い＝削除されていた。
        if (prefs.getBoolean("bundled_installed", false)) {
            val removed = removedBundledSet()
            for ((name, _) in BUNDLED) {
                val out = fileFor(name) ?: continue
                if (!out.exists() && name !in removed) removed.add(name)
            }
            prefs.edit().putStringSet("removed_bundled", removed).remove("bundled_installed").apply()
        }
        val removed = removedBundledSet()
        for ((name, asset) in BUNDLED) {
            if (name in removed) continue
            val out = fileFor(name) ?: continue
            val firstTime = !out.exists()
            try {
                context.assets.open(asset).use { input ->
                    out.outputStream().use { input.copyTo(it) }
                }
                if (firstTime) enable(name, true)
            } catch (_: Exception) { /* 取り込み失敗は無視 */ }
        }
    }

    companion object {
        /**
         * 組込み（バンドル）プラグイン: ファイル名 → assets パス。既定 ON で初回投入。
         * 開発中は空。プラグイン本体は repo の plugins/ に外部ファイルとして置き、
         * Plugins 画面の「＋ Add plugin」で取り込んで反復する（APK 再ビルド不要）。
         * 機能が固まったら、ここに登録してアプリ同梱（自動 ON）に切り替える。
         */
        val BUNDLED = emptyMap<String, String>()
    }
}
