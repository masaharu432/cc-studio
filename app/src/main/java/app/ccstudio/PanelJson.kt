package app.ccstudio

import org.json.JSONArray
import org.json.JSONObject

/** ネイティブ→WebView パネルへ渡す JSON の純粋ビルダー群（MainActivity から抽出）。 */
object PanelJson {
    /**
     * インストール済みプラグイン一覧の JSON。
     * name=ファイル名(=bridge のID), displayName=@name(表示用)。UI はタイトルに displayName、
     * 操作キーに name を使う。
     */
    fun plugins(list: List<PluginInfo>): String {
        val arr = JSONArray()
        list.forEach {
            arr.put(
                JSONObject()
                    .put("name", it.name)
                    .put("displayName", it.displayName)
                    .put("size", it.size)
                    .put("enabled", it.enabled)
                    .put("version", it.version ?: "")
                    .put("description", it.description ?: "")
                    .put("hasSettings", it.hasSettings)
                    .put("bundled", it.bundled)
                    .put("runAt", it.runAt)
                    .put("allFrames", it.allFrames)
            )
        }
        return arr.toString()
    }

    /** 設定側の一覧（switcher が描く）。項目追加はここに1エントリ足すだけで済ませる。 */
    fun settingsList(total: Int, enabled: Int): String {
        val arr = JSONArray()
        arr.put(
            JSONObject().put("id", "plugins").put("group", "プラグイン").put("icon", "🧩")
                .put("label", "プラグイン管理")
                .put("sub", "$total 個インストール · $enabled 有効")
        )
        arr.put(
            JSONObject().put("id", "notify").put("group", "システム").put("icon", "🔔")
                .put("label", "通知").put("sub", "Stop / Notification フック")
        )
        arr.put(
            JSONObject().put("id", "log").put("group", "システム").put("icon", "📋")
                .put("label", "ログ").put("sub", "オブザーバーログを表示")
        )
        return arr.toString()
    }

    /**
     * 設定スクリーン描画用 JSON（対象プラグインのスキーマ＋現在値）。
     * 設定 namespace は displayName(@name) で揃える。valueOf は保存値（無ければ null）を返す。
     */
    fun settingsView(info: PluginInfo?, valueOf: (ns: String, key: String) -> String?): String {
        if (info == null) return "{}"
        val ns = info.displayName
        val arr = JSONArray()
        info.settings.forEach { d ->
            val value = PluginSettings.coerce(d.type, valueOf(ns, d.key) ?: d.default)
            arr.put(
                JSONObject()
                    .put("key", d.key)
                    .put("type", d.type)
                    .put("default", PluginSettings.coerce(d.type, d.default))
                    .put("label", d.label)
                    .put("value", value)
            )
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
