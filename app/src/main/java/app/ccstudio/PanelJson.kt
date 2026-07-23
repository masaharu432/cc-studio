package app.ccstudio

import org.json.JSONArray
import org.json.JSONObject

/**
 * ネイティブ→WebView パネルへ渡す JSON の純粋ビルダー群（MainActivity から抽出）。
 * ja=true なら日本語（無ければ英語へフォールバック）、false なら英語で文言を解決する。
 */
object PanelJson {
    /**
     * インストール済みプラグイン一覧の JSON。
     * name=ファイル名(=bridge のID), displayName=@name(表示用)。UI はタイトルに displayName、
     * 操作キーに name を使う。description は言語解決済みの 1 本を渡す（HTML 側は選ばない）。
     */
    fun plugins(list: List<PluginInfo>, ja: Boolean): String {
        val arr = JSONArray()
        list.forEach {
            val desc = if (ja) it.descriptionJa ?: it.description else it.description
            arr.put(
                JSONObject()
                    .put("name", it.name)
                    .put("displayName", it.displayName)
                    .put("size", it.size)
                    .put("enabled", it.enabled)
                    .put("version", it.version ?: "")
                    .put("description", desc ?: "")
                    .put("hasSettings", it.hasSettings)
                    .put("bundled", it.bundled)
                    .put("runAt", it.runAt)
                    .put("allFrames", it.allFrames)
            )
        }
        return arr.toString()
    }

    /** 設定側の一覧（switcher が描く）。項目追加はここに1エントリ足すだけで済ませる。 */
    fun settingsList(total: Int, enabled: Int, originHost: String?, defaultFolder: String?, ja: Boolean): String {
        fun t(en: String, jp: String) = if (ja) jp else en
        val arr = JSONArray()
        arr.put(
            JSONObject().put("id", "plugins").put("group", t("Plugins", "プラグイン")).put("icon", "🧩")
                .put("label", t("Plugin manager", "プラグイン管理"))
                .put("sub", t("$total installed · $enabled enabled", "$total 個インストール · $enabled 有効"))
        )
        // 接続先（ホストのみ）と初期フォルダは別エントリに分ける（保存の意味・影響範囲が違うため）。
        val serverSub = originHost ?: t("Not set — tap to configure", "未設定 — タップして設定")
        arr.put(
            JSONObject().put("id", "server").put("group", t("System", "システム")).put("icon", "🖥️")
                .put("label", t("Server", "接続先")).put("sub", serverSub)
        )
        val folderSub = defaultFolder ?: t("Server default (home)", "サーバの既定（ホーム）")
        arr.put(
            JSONObject().put("id", "defaultfolder").put("group", t("System", "システム")).put("icon", "📁")
                .put("label", t("Folder to open first", "最初に開くフォルダ")).put("sub", folderSub)
        )
        arr.put(
            JSONObject().put("id", "notify").put("group", t("System", "システム")).put("icon", "🔔")
                .put("label", t("Notifications", "通知"))
                .put("sub", t("Stop / Notification hooks", "Stop / Notification フック"))
        )
        arr.put(
            JSONObject().put("id", "log").put("group", t("System", "システム")).put("icon", "📋")
                .put("label", t("Log", "ログ")).put("sub", t("Show observer log", "オブザーバーログを表示"))
        )
        arr.put(
            JSONObject().put("id", "lang").put("group", t("System", "システム")).put("icon", "🌐")
                .put("label", t("Language", "言語"))
                .put("sub", t("Follow device / 日本語 / English", "端末に合わせる / 日本語 / English"))
        )
        return arr.toString()
    }

    /**
     * 設定スクリーン描画用 JSON（対象プラグインのスキーマ＋現在値）。
     * 設定 namespace は displayName(@name) で揃える。valueOf は保存値（無ければ null）を返す。
     */
    fun settingsView(info: PluginInfo?, ja: Boolean, valueOf: (ns: String, key: String) -> String?): String {
        if (info == null) return "{}"
        val ns = info.displayName
        val arr = JSONArray()
        info.settings.forEach { d ->
            val value = PluginSettings.coerce(d, valueOf(ns, d.key) ?: d.default)
            val o = JSONObject()
                .put("key", d.key)
                .put("type", d.type)
                .put("default", PluginSettings.coerce(d, d.default))
                .put("label", if (ja) d.labelJa ?: d.label else d.label)
                .put("value", value)
            // number のみ範囲・刻みを渡す（ステッパー UI 用）。
            d.min?.let { o.put("min", it) }
            d.max?.let { o.put("max", it) }
            d.step?.let { o.put("step", it) }
            arr.put(o)
        }
        return JSONObject()
            .put("name", ns) // setSetting / ライブ push の namespace に使う（=@name）
            .put("displayName", info.displayName)
            .put("settings", arr)
            .toString()
    }

    /** 全プラグインの有効設定値を JSON 化（設定ランタイム注入用）。 */
    fun effectiveSettings(map: Map<String, Map<String, Any>>): String {
        val root = JSONObject()
        map.forEach { (plugin, kv) ->
            val o = JSONObject()
            kv.forEach { (k, v) -> o.put(k, v) }
            root.put(plugin, o)
        }
        return root.toString()
    }
}
