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
    private val buildLabel: String,
    private val onOpenSwitcher: () -> Unit,
    private val onCloseSwitcher: () -> Unit,
    private val screensJsonFn: () -> String,
    private val onSelectScreen: (id: Long) -> Unit,
    private val onReloadScreen: (id: Long) -> Unit,
    private val onCloseScreen: (id: Long) -> Unit,
    private val onNewScreen: () -> Unit,
) {
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
}
