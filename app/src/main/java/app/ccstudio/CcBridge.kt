package app.ccstudio

import android.webkit.JavascriptInterface

/**
 * WebView の JS から window.CCStudio.* として呼ばれる橋。
 * 実体（WebView操作・Toast・SAF起動・保存）は MainActivity が持つのでラムダで委譲する。
 * これらは JS スレッドから呼ばれるため、WebView を触る委譲先では runOnUiThread すること。
 */
class CcBridge(
    private val onPick: () -> Unit,
    private val listJsonFn: () -> String,
    private val onSetEnabled: (name: String, enabled: Boolean) -> Unit,
    private val onRemove: (name: String) -> Unit,
    private val onSave: (name: String, mime: String, base64: String) -> Unit,
    private val onSaveFailed: (msg: String) -> Unit,
    private val onDlBegin: (name: String, mime: String) -> String,
    private val onDlChunk: (token: String, base64: String) -> Boolean,
    private val onDlEnd: (token: String) -> Boolean,
    private val onDlAbort: (token: String) -> Unit,
    private val iconDataUriFn: () -> String,
    private val buildLabel: String,
    private val onOpenSwitcher: () -> Unit,
    private val onCloseSwitcher: () -> Unit,
    private val screensJsonFn: () -> String,
    private val onSelectScreen: (id: Long) -> Unit,
    private val onReloadScreen: (id: Long) -> Unit,
    private val onCloseScreen: (id: Long) -> Unit,
    private val onNewScreen: () -> Unit,
    private val notifyPrefsJsonFn: () -> String,
    private val onSetNotifyPref: (kind: String, enabled: Boolean) -> Unit,
    private val onOpenNotify: () -> Unit,
    private val onCloseNotify: () -> Unit,
    private val pluginSettingsJsonFn: () -> String,
    private val onOpenPluginSettings: (name: String) -> Unit,
    private val settingsViewJsonFn: () -> String,
    private val onSetSetting: (name: String, key: String, value: Boolean) -> Unit,
    private val onClosePluginSettings: () -> Unit,
    private val onSessionState: (busy: Boolean, disconnected: Boolean) -> Unit,
    private val onMarkdownPreview: () -> Unit,
    private val onObserverLog: (json: String) -> Unit,
    private val onOpenLog: () -> Unit,
    private val onCloseLog: () -> Unit,
    private val observerLogTextFn: () -> String,
    private val onDownloadObserverLog: () -> Unit,
    private val settingsListJsonFn: () -> String,
    private val onOpenSettingsEntry: (id: String) -> Unit,
    private val onSwitcherTabChanged: (tab: String) -> Unit,
    private val onNavBack: () -> Unit,
    private val uiLangFn: () -> String,
) {
    /** 表示言語（"ja" / "en"）。管理系 HTML と bootstrap.js が文言辞書の切替に使う。 */
    @JavascriptInterface
    fun getUiLang(): String = uiLangFn()

    /** ︙メニューに出すビルド番号（ビルド時刻）。 */
    @JavascriptInterface
    fun getBuild(): String = buildLabel

    /** [JSプラグインを追加] → SAF を起動して新しいプラグインを取り込む。 */
    @JavascriptInterface
    fun pickPlugin() = onPick()

    /** インストール済みプラグインの一覧（JSON 配列文字列 [{name,size,enabled}, ...]）。 */
    @JavascriptInterface
    fun listPlugins(): String = listJsonFn()

    /** プラグインの有効/無効を切り替える。有効化した瞬間は現在のページにも即注入される。 */
    @JavascriptInterface
    fun setEnabled(name: String, enabled: Boolean) = onSetEnabled(name, enabled)

    /** プラグインを削除する。 */
    @JavascriptInterface
    fun removePlugin(name: String) = onRemove(name)

    /** blob:/data: のダウンロードを JS で base64 化して受け取り、端末の Downloads へ保存する。 */
    @JavascriptInterface
    fun saveBase64(name: String, mime: String, base64: String) = onSave(name, mime, base64)

    /** JS 側のダウンロード処理が失敗したときの通知。 */
    @JavascriptInterface
    fun saveFailed(msg: String) = onSaveFailed(msg)

    // ── ダウンロード（チャンク・ストリーミング） ──
    /** 保存先を開いて token を返す（失敗時は空文字）。以後 downloadChunk を順に呼ぶ。 */
    @JavascriptInterface
    fun downloadBegin(name: String, mime: String): String = onDlBegin(name, mime)

    /** base64 のチャンクを追記する。成功で true。 */
    @JavascriptInterface
    fun downloadChunk(token: String, base64: String): Boolean = onDlChunk(token, base64)

    /** 書き込みを完了し保存を確定する。 */
    @JavascriptInterface
    fun downloadEnd(token: String): Boolean = onDlEnd(token)

    /** 途中失敗時に書きかけを破棄する。 */
    @JavascriptInterface
    fun downloadAbort(token: String) = onDlAbort(token)

    /** アプリのランチャーアイコンを data:image/png;base64,... で返す（進捗バー表示用）。 */
    @JavascriptInterface
    fun appIcon(): String = iconDataUriFn()

    // ── Screens（スクリーン切替） ──
    /** 左端 ︙ から全画面 switcher を開く。 */
    @JavascriptInterface fun openSwitcher() = onOpenSwitcher()
    /** switcher を閉じる。 */
    @JavascriptInterface fun closeSwitcher() = onCloseSwitcher()
    /** スクリーン一覧 JSON（[{id,title,path,kind,active,closeable,stale}]）。 */
    @JavascriptInterface fun listScreens(): String = screensJsonFn()
    /** そのスクリーンへ切替（リロードしない）。 */
    @JavascriptInterface fun selectScreen(id: String) { id.toLongOrNull()?.let(onSelectScreen) }
    /** そのスクリーンをリロードして反映。 */
    @JavascriptInterface fun reloadScreen(id: String) { id.toLongOrNull()?.let(onReloadScreen) }
    /** そのスクリーンを閉じる（Web のみ）。 */
    @JavascriptInterface fun closeScreen(id: String) { id.toLongOrNull()?.let(onCloseScreen) }
    /** 新規 Web スクリーンを作って選択。 */
    @JavascriptInterface fun newScreen() = onNewScreen()

    // ── 通知設定 ──
    /** 種類別 ON/OFF の現在値（{"stop":bool,"permission":bool}）。 */
    @JavascriptInterface fun getNotifyPrefs(): String = notifyPrefsJsonFn()
    /** 種類別 ON/OFF を保存する。kind は "Stop" | "Notification"。 */
    @JavascriptInterface fun setNotifyPref(kind: String, enabled: Boolean) = onSetNotifyPref(kind, enabled)
    /** 通知設定の全画面（notify.html オーバーレイ）を開く。 */
    @JavascriptInterface fun openNotifySettings() = onOpenNotify()
    /** 通知設定の全画面を閉じて switcher に戻る。 */
    @JavascriptInterface fun closeNotifySettings() = onCloseNotify()

    // ── プラグイン設定 ──
    /** 設定ランタイム注入用。全プラグインの有効設定値（{"focus-hud":{"visible":true}, ...}）。 */
    @JavascriptInterface fun getPluginSettings(): String = pluginSettingsJsonFn()
    /** そのプラグインの専用設定スクリーン（plugin-settings.html オーバーレイ）を開く。 */
    @JavascriptInterface fun openPluginSettings(name: String) = onOpenPluginSettings(name)
    /** 設定スクリーンの描画素材（{name, displayName, settings:[{key,type,default,label,value}]}）。 */
    @JavascriptInterface fun getSettingsView(): String = settingsViewJsonFn()
    /** 設定値を保存し、全 WEB スクリーンへリロード無しでライブ反映する（v1: boolean）。 */
    @JavascriptInterface fun setSetting(name: String, key: String, value: Boolean) =
        onSetSetting(name, key, value)
    /** 設定スクリーンを閉じて Plugins 画面へ戻す。 */
    @JavascriptInterface fun closePluginSettings() = onClosePluginSettings()

    // ── セッション状態（処理中/接続切れ） ──
    /** bootstrap.js のオブザーバが、このスクリーンの処理中/接続切れ状態を報告する。 */
    @JavascriptInterface
    fun setSessionState(busy: Boolean, disconnected: Boolean) = onSessionState(busy, disconnected)

    /**
     * .md をテキストで開いた直後に呼ばれ、アクティブな WebView へ Ctrl+Shift+V
     * (markdown.togglePreview) をトラステッドなキーイベントとして送ってプレビュー化する。
     * 合成 JS イベントは VS Code のキーバインドサービスが無視するため、ネイティブ送出が必須。
     */
    @JavascriptInterface
    fun markdownPreview() = onMarkdownPreview()

    /** 観測ログ（生の状態遷移）をネイティブへ。JSON: {"busy":bool,"disconnected":bool,"matched":str}。 */
    @JavascriptInterface
    fun observerLog(json: String) = onObserverLog(json)

    // ── ログビューア ──
    /** 永続ログの全画面ビューア（log.html オーバーレイ）を開く。 */
    @JavascriptInterface fun openLogViewer() = onOpenLog()
    /** ログビューアを閉じて switcher に戻る。 */
    @JavascriptInterface fun closeLogViewer() = onCloseLog()
    /** ログ本文（JSONL, 古い順連結）を返す。表示用に末尾を上限で切る。 */
    @JavascriptInterface fun getObserverLog(): String = observerLogTextFn()
    /** ログを端末の Downloads へ保存する。 */
    @JavascriptInterface fun downloadObserverLog() = onDownloadObserverLog()

    // ── 設定（switcher 設定側） ──
    /** 設定エントリ一覧 JSON（[{id,group,icon,label,sub}]、group 順）。 */
    @JavascriptInterface fun listSettings(): String = settingsListJsonFn()
    /** 設定エントリを開く。遷移の実体（スクリーン切替 / オーバーレイ表示）はネイティブが解決する。 */
    @JavascriptInterface fun openSettingsEntry(id: String) = onOpenSettingsEntry(id)
    /** switcher のタブ現在値の報告（"screens" | "settings"）。OS バックの遷移判断に使う。 */
    @JavascriptInterface fun switcherTabChanged(tab: String) = onSwitcherTabChanged(tab)
    /** アプリ内 ‹ ボタン用。OS バックと同じ pop 処理を呼ぶ（遷移ロジックを二重に持たない）。 */
    @JavascriptInterface fun navBack() = onNavBack()
}
