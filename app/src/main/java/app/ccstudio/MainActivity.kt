package app.ccstudio

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var screens: ScreenManager
    private lateinit var store: PluginStore
    private lateinit var screenStore: ScreenStore
    private var switcher: WebView? = null
    private var notifyView: WebView? = null
    private var settingsView: WebView? = null
    private var settingsTarget: String? = null

    /** プラグインの有効集合が変わるたびに +1。各 Web スクリーンの loadedGeneration と比べて stale 判定。 */
    private var pluginGeneration: Int = 0

    private val pickJs = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri == null) return@registerForActivityResult
        val saved = store.installFromUri(uri, queryDisplayName(uri))
        Toast.makeText(
            this,
            if (saved != null) "プラグインを追加しました: $saved" else "JSの読み込みに失敗しました",
            Toast.LENGTH_SHORT
        ).show()
        if (saved != null) { bumpGenerationAndSync(); refreshActivePanel() }
    }

    /** <input type="file"> の onShowFileChooser から渡されるコールバック。選択結果を返す先。 */
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val pickFiles = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = fileChooserCallback
        fileChooserCallback = null
        cb?.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        requestNotificationPermissionIfNeeded()
        ContextCompat.startForegroundService(this, Intent(this, KeepAliveService::class.java))
        ObserverLog.lifecycle(this, "start")

        store = PluginStore(this)
        store.ensureBundledInstalled()
        screenStore = ScreenStore(this)

        root = FrameLayout(this)
        setContentView(root)
        screens = ScreenManager(root)
        screens.onActiveChanged = { s ->
            NotifyState.activeFolder =
                if (s != null && s.kind == ScreenKind.WEB) ScreenUrl.folderPath(s.url) else null
            // 表示スクリーンが変わったら、その ︙ボタンに全体の集約状態を塗り直す。
            pushMenuState()
        }

        // 1) Plugins システムスクリーン（先頭・固定）
        screens.add(createSystemPluginsScreen())

        // 2) 復元 or 既定の Web スクリーン
        // 復元/起動時の WebView も初回ロード後に一度 reload する（reloadOnFirstLoad=true）。
        // これをしないと document-start 登録が「新規 WebView の初回ナビゲーション」に乗らず、
        // アプリ更新後などに既存スクリーンでキーボード抑制が効かないことがある。
        val state = screenStore.load()
        if (state.urls.isEmpty()) {
            screens.add(createWebScreen(TARGET_URL, reloadOnFirstLoad = true))
        } else {
            state.urls.forEach { screens.add(createWebScreen(it, reloadOnFirstLoad = true)) }
        }
        // 起動時は Web スクリーンを見せる（System は先頭だが裏に置く）
        val webList = screens.webScreens()
        val activeWeb = webList.getOrNull(state.activeIndex) ?: webList.firstOrNull()
        activeWeb?.let { screens.select(it.id) }
        refreshKeepAliveScreenCount()

        // 通知タップでアプリが起動した場合（アプリが落ちていた状態でタップ）の処理
        intent.getStringExtra(KeepAliveService.EXTRA_OPEN_CWD)?.let { openScreenForCwd(it) }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val nv = notifyView
                if (nv != null && nv.visibility == View.VISIBLE) { closeNotify(); openSwitcher(); return }
                val sw = switcher
                if (sw != null && sw.visibility == View.VISIBLE) { closeSwitcher(); return }
                val a = screens.activeOrNull()
                // WebView に戻る履歴があれば戻る。無い場合は finish() せず
                // ホームボタン同等にバックグラウンドへ送る（moveTaskToBack）。
                // finish() すると Activity/WebView が破棄され、次回起動でリロードが走るため。
                if (a != null && a.webView.canGoBack()) a.webView.goBack() else moveTaskToBack(true)
            }
        })
    }

    override fun onResume() {
        super.onResume()
        NotifyState.foreground = true
        NotifyState.activeFolder = screens.activeOrNull()
            ?.takeIf { it.kind == ScreenKind.WEB }
            ?.let { ScreenUrl.folderPath(it.url) }
        ObserverLog.lifecycle(this, "foreground")
    }

    override fun onPause() {
        super.onPause()
        NotifyState.foreground = false
        ObserverLog.lifecycle(this, "background")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(KeepAliveService.EXTRA_OPEN_CWD)?.let { openScreenForCwd(it) }
    }

    /** 通知タップ用: cwd に対応する WEB スクリーンへ。無ければ新規作成して開く。 */
    private fun openScreenForCwd(cwd: String) {
        if (cwd.isEmpty()) return
        val hit = screens.webScreens().firstOrNull {
            NotifyDecision.matches(ScreenUrl.folderPath(it.url), cwd)
        }
        if (hit != null) {
            screens.select(hit.id)
            return
        }
        val schemeEnd = TARGET_URL.indexOf("://")
        if (schemeEnd < 0) return
        val host = TARGET_URL.substring(schemeEnd + 3).substringBefore('/')
        val base = TARGET_URL.substring(0, schemeEnd) + "://" + host
        val url = "$base/?folder=" + java.net.URLEncoder.encode(cwd, "UTF-8")
        val s = createWebScreen(url, reloadOnFirstLoad = true)
        screens.add(s); screens.select(s.id); persistScreens()
    }

    // ── WebView ファクトリ ──────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun newConfiguredWebView(screenId: Long = -1L): WebView = WebView(this).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                return try {
                    pickFiles.launch(fileChooserParams.createIntent()); true
                } catch (e: Exception) {
                    Log.w("CcStudio", "onShowFileChooser failed", e)
                    fileChooserCallback = null
                    toast("ファイル選択を開けませんでした"); false
                }
            }
        }
        setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            handleDownload(url, contentDisposition, mimeType)
        }
        addJavascriptInterface(buildBridge(screenId), "CCStudio")
    }

    private fun createWebScreen(url: String, reloadOnFirstLoad: Boolean = false): Screen {
        val id = screens.nextId()
        val wv = newConfiguredWebView(id)
        val screen = Screen(id, ScreenKind.WEB, wv)
        screen.url = url
        var firstReloadDone = false
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // 外部サイト（調査リンク・ホームページ等）は外部ブラウザで開き、workbench を離れない。
                if (isExternalHttp(request.url)) { openExternalUrl(request.url); return true }
                return false
            }
            override fun doUpdateVisitedHistory(view: WebView, newUrl: String?, isReload: Boolean) {
                if (newUrl != null) { screen.url = newUrl; persistScreens() }
            }
            override fun onPageFinished(view: WebView, finishedUrl: String?) {
                // 新規スクリーンは初回ロード後に一度だけリロードして、有効プラグインを確実に反映する
                // （document-start 登録は新規 WebView の初回ナビゲーションに乗り切らないことがあるため）。
                if (reloadOnFirstLoad && !firstReloadDone) {
                    firstReloadDone = true
                    registerScreenScripts(screen)
                    view.reload()
                    return
                }
                injectAssetInto(view, "bootstrap.js")
                if (!ExtensionRuntime.isDocumentStartSupported()) {
                    view.evaluateJavascript("window.__ccPluginSettings = ${effectiveSettingsJson()};", null)
                    // document-start 非対応端末: 有効プラグインを全部メインフレームに注入（フォールバック）。
                    store.enabledScripts().forEach { view.evaluateJavascript(it, null) }
                } else {
                    // all-frames=false のプラグインは document-start 登録していない（registerScreenScripts 参照）。
                    // メインフレームのみ・document-idle 相当として、ここで注入する。
                    store.enabled().filter { !it.allFrames }.forEach { p ->
                        store.script(p.name)?.let { view.evaluateJavascript(it, null) }
                    }
                }
                if (finishedUrl != null) screen.url = finishedUrl
                screen.loadedGeneration = pluginGeneration
                persistScreens()
            }
        }
        registerScreenScripts(screen)
        wv.loadUrl(url)
        return screen
    }

    /** workbench（アプリが開く code-server）のホスト。これ以外の http(s) ホストは「外部」とみなす。 */
    private val workbenchHost: String? by lazy {
        try { Uri.parse(TARGET_URL).host } catch (_: Exception) { null }
    }

    /** workbench 以外の http(s) ホストへのナビゲーションか（＝外部ブラウザで開くべきか）。 */
    private fun isExternalHttp(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https") return false
        val host = uri.host ?: return false
        val wh = workbenchHost ?: return false
        return !host.equals(wh, ignoreCase = true)
    }

    /** URL を Android の外部ブラウザ（既定ブラウザ）で開く。 */
    private fun openExternalUrl(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w("CcStudio", "openExternalUrl failed: $uri", e)
            runOnUiThread { toast("外部リンクを開けませんでした") }
        }
    }

    private fun createSystemPluginsScreen(): Screen {
        val id = screens.nextId()
        val wv = newConfiguredWebView(id)
        val screen = Screen(id, ScreenKind.SYSTEM_PLUGINS, wv)
        screen.title = "Plugins"
        wv.webViewClient = WebViewClient()
        wv.loadUrl("file:///android_asset/plugins.html")
        return screen
    }

    // ── ブリッジ ────────────────────────────────────────────────────────

    private fun buildBridge(screenId: Long): CcBridge = CcBridge(
        onPick = { runOnUiThread { pickJs.launch("*/*") } },
        listJsonFn = { pluginsJson() },
        onSetEnabled = { name, enabled ->
            store.enable(name, enabled)
            runOnUiThread { bumpGenerationAndSync() }
        },
        onRemove = { name ->
            store.remove(name)
            runOnUiThread { bumpGenerationAndSync(); refreshActivePanel() }
        },
        onSave = { name, mime, b64 -> saveBase64Download(name, mime, b64) },
        onSaveFailed = { msg ->
            runOnUiThread { toast("ダウンロードに失敗しました") }
            Log.w("CcStudio", "download failed in JS: $msg")
        },
        onDlBegin = { name, mime -> downloadBegin(name, mime) },
        onDlChunk = { token, b64 -> downloadChunk(token, b64) },
        onDlEnd = { token -> downloadEnd(token) },
        onDlAbort = { token -> downloadAbort(token) },
        iconDataUriFn = { appIconDataUri() },
        buildLabel = BuildConfig.BUILD_LABEL,
        onOpenSwitcher = { runOnUiThread { openSwitcher() } },
        onCloseSwitcher = { runOnUiThread { closeSwitcher() } },
        screensJsonFn = { ScreensJson.build(screens.rows(pluginGeneration)) },
        onSelectScreen = { id -> runOnUiThread { closeSwitcher(); screens.select(id) } },
        onReloadScreen = { id ->
            runOnUiThread {
                closeSwitcher()
                screens.byId(id)?.let { reloadScreen(it); screens.select(id) }
            }
        },
        onCloseScreen = { id -> runOnUiThread { screens.close(id); persistScreens(); refreshSwitcher() } },
        onNewScreen = {
            runOnUiThread {
                val s = createWebScreen(TARGET_URL, reloadOnFirstLoad = true)
                screens.add(s); screens.select(s.id); persistScreens(); closeSwitcher()
            }
        },
        notifyPrefsJsonFn = { NotifyPrefs.toJson(this) },
        onSetNotifyPref = { kind, enabled -> NotifyPrefs.setEnabled(this, kind, enabled) },
        onOpenNotify = { runOnUiThread { closeSwitcher(); openNotify() } },
        onCloseNotify = { runOnUiThread { closeNotify(); openSwitcher() } },
        pluginSettingsJsonFn = { effectiveSettingsJson() },
        onOpenPluginSettings = { name -> runOnUiThread { settingsTarget = name; openPluginSettings() } },
        settingsViewJsonFn = { settingsViewJson() },
        onSetSetting = { name, key, value ->
            store.setSettingRaw(name, key, value.toString())
            runOnUiThread { pushSettingLive(name, key, value) }
        },
        onClosePluginSettings = { runOnUiThread { closePluginSettings() } },
        onSessionState = { busy, disconnected -> onSessionState(screenId, busy, disconnected) },
        onMarkdownPreview = { runOnUiThread { dispatchMarkdownPreviewKey() } },
        onObserverLog = { json -> onObserverLog(screenId, json) },
    )

    /**
     * アクティブな WebView へ Ctrl+Shift+V（markdown.togglePreview）をトラステッドなキーイベントとして
     * 送る。プラグインが .md をテキストで開いた直後に呼ばれ、エディタをプレビュー表示へトグルする。
     * 修飾キーを押下→V→離す、の順で本物のキー入力を再現する（VS Code は isTrusted=false を無視するため）。
     */
    private fun dispatchMarkdownPreviewKey() {
        val wv = screens.activeOrNull()?.webView ?: return
        toast("MDPV: プレビュー化キー送出")
        wv.requestFocus()
        // focus が落ち着いてから送る。
        wv.postDelayed({
            val ctrl = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
            val ctrlShift = ctrl or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
            fun ev(action: Int, code: Int, meta: Int) =
                KeyEvent(SystemClock.uptimeMillis(), SystemClock.uptimeMillis(), action, code, 0, meta)
            // 押下: Ctrl, Shift, V → 離す: V, Shift, Ctrl
            wv.dispatchKeyEvent(ev(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_CTRL_LEFT, ctrl))
            wv.dispatchKeyEvent(ev(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_SHIFT_LEFT, ctrlShift))
            wv.dispatchKeyEvent(ev(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_V, ctrlShift))
            wv.dispatchKeyEvent(ev(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_V, ctrlShift))
            wv.dispatchKeyEvent(ev(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_SHIFT_LEFT, ctrl))
            wv.dispatchKeyEvent(ev(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_CTRL_LEFT, 0))
        }, 120)
    }

    // ── スクリーン操作・プラグイン反映 ──────────────────────────────────

    private fun reloadScreen(s: Screen) {
        registerScreenScripts(s)   // 最新の有効集合で登録し直してから
        s.webView.reload()
    }

    /**
     * 有効プラグインを WEB スクリーンへ document-start 登録/解除する。
     * 対象は **all-frames=true** のプラグインのみ（全フレーム×document-start）。
     * all-frames=false のものはメインフレーム注入なので onPageFinished 側で扱う（ここでは登録しない）。
     */
    private fun registerScreenScripts(s: Screen) {
        if (s.kind != ScreenKind.WEB) return
        if (!ExtensionRuntime.isDocumentStartSupported()) return
        // 設定ランタイムを最初に1本だけ登録（プラグインが読む前に __ccPluginSettings を用意）。
        if (!s.pluginHandlers.containsKey(SETTINGS_RUNTIME_KEY)) {
            ExtensionRuntime.registerDocumentStart(s.webView, SETTINGS_RUNTIME_JS)
                ?.let { s.pluginHandlers[SETTINGS_RUNTIME_KEY] = it }
        }
        val enabled = store.enabled().filter { it.allFrames }.map { it.name }.toSet()
        val iter = s.pluginHandlers.iterator()
        while (iter.hasNext()) {
            val e = iter.next()
            if (e.key == SETTINGS_RUNTIME_KEY) continue
            if (e.key !in enabled) {
                try { e.value.remove() } catch (_: Exception) {}
                iter.remove()
            }
        }
        for (name in enabled) {
            val js = store.script(name) ?: continue
            // 同名でも毎回、古いハンドラを外して現在の内容で登録し直す（再取り込みを確実に反映）。
            s.pluginHandlers.remove(name)?.let { try { it.remove() } catch (_: Exception) {} }
            ExtensionRuntime.registerDocumentStart(s.webView, js)?.let { h -> s.pluginHandlers[name] = h }
        }
    }

    private fun bumpGenerationAndSync() {
        pluginGeneration++
        screens.webScreens().forEach { registerScreenScripts(it) }
        refreshSwitcher()
        // 反映は各スクリーンの手動リロードで（他セッションに影響しないよう自動リロードはしない）。
    }

    private fun persistScreens() {
        val web = screens.webScreens()
        val urls = web.map { it.url }
        val activeIdx = web.indexOfFirst { it.id == screens.activeOrNull()?.id }
        screenStore.save(urls, if (activeIdx < 0) 0 else activeIdx)
        refreshKeepAliveScreenCount()
    }

    /** bootstrap.js のオブザーバからの状態報告。値が変わったときだけ反映して UI を貼り直す。 */
    private fun onSessionState(screenId: Long, busy: Boolean, disconnected: Boolean) {
        runOnUiThread {
            val s = screens.byId(screenId) ?: return@runOnUiThread
            if (s.kind != ScreenKind.WEB) return@runOnUiThread
            if (s.busy != busy || s.disconnected != disconnected) {
                s.busy = busy
                s.disconnected = disconnected
                refreshSwitcher()
                refreshKeepAliveScreenCount()
            }
            // 変化が無くても押す: 起動直後の表示中スクリーンの ︙ボタンにも集約状態を反映するため。
            pushMenuState()
        }
    }

    /** プラグインからの生の状態遷移を、スクリーン情報＋端末時刻を付けて永続ログへ書く。 */
    private fun onObserverLog(screenId: Long, json: String) {
        try {
            val o = org.json.JSONObject(json)
            val s = screens.byId(screenId)
            val screen = if (s?.kind == ScreenKind.WEB) ScreenUrl.folderName(s.url) else (s?.title ?: "")
            val cwd = if (s?.kind == ScreenKind.WEB) (ScreenUrl.folderPath(s.url) ?: "") else ""
            ObserverLog.screenState(
                this, screen, cwd,
                o.optBoolean("busy", false), o.optBoolean("disconnected", false), o.optString("matched", ""),
            )
        } catch (_: Exception) { /* ログはアプリを落とさない */ }
    }

    /** 全 Web スクリーンの集約状態（どれか処理中/接続切れ）を、表示中スクリーンの ︙ボタンへ反映する。 */
    private fun pushMenuState() {
        val anyBusy = screens.webScreens().any { it.busy }
        val anyDisc = screens.webScreens().any { it.disconnected }
        screens.activeOrNull()?.webView?.evaluateJavascript(
            "window.__ccPaintMenu && window.__ccPaintMenu($anyBusy, $anyDisc);", null,
        )
    }

    /** 起動中 Web スクリーン数を共有状態に反映し、常駐通知を貼り直させる。 */
    private fun refreshKeepAliveScreenCount() {
        NotifyState.screenCount = screens.webScreens().size
        NotifyState.busyCount = screens.webScreens().count { it.busy }
        NotifyState.disconnectedCount = screens.webScreens().count { it.disconnected }
        ContextCompat.startForegroundService(
            this,
            Intent(this, KeepAliveService::class.java).setAction(KeepAliveService.ACTION_REFRESH),
        )
    }

    // ── switcher オーバーレイ ───────────────────────────────────────────

    private fun openSwitcher() {
        val sw = switcher ?: newConfiguredWebView().also {
            it.webViewClient = WebViewClient()
            it.loadUrl("file:///android_asset/switcher.html")
            root.addView(
                it,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
            switcher = it
        }
        sw.visibility = View.VISIBLE
        sw.bringToFront()
        refreshSwitcher()
    }

    private fun closeSwitcher() { switcher?.visibility = View.GONE }

    /** 通知設定の全画面（notify.html）をオーバーレイ表示する（switcher と同型）。 */
    private fun openNotify() {
        val nv = notifyView ?: newConfiguredWebView().also {
            it.webViewClient = WebViewClient()
            it.loadUrl("file:///android_asset/notify.html")
            root.addView(
                it,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
            notifyView = it
        }
        nv.visibility = View.VISIBLE
        nv.bringToFront()
        nv.evaluateJavascript("window.__ccRenderNotify && window.__ccRenderNotify();", null)
    }

    private fun closeNotify() { notifyView?.visibility = View.GONE }

    private fun refreshSwitcher() {
        switcher?.evaluateJavascript("window.__ccRenderScreens && window.__ccRenderScreens();", null)
    }

    /** Plugins システムスクリーンの一覧を再描画させる（開いていれば反映）。 */
    private fun refreshActivePanel() {
        screens.all().firstOrNull { it.kind == ScreenKind.SYSTEM_PLUGINS }
            ?.webView?.evaluateJavascript("window.__ccRenderPlugins && window.__ccRenderPlugins();", null)
    }

    // ── プラグイン設定 ──────────────────────────────────────────────────

    /** 全プラグインの有効設定値を JSON 化（設定ランタイム注入用）。 */
    private fun effectiveSettingsJson(): String {
        val root = JSONObject()
        store.effectiveSettings().forEach { (plugin, kv) ->
            val o = JSONObject()
            kv.forEach { (k, v) -> o.put(k, v) }
            root.put(plugin, o)
        }
        return root.toString()
    }

    /** 設定スクリーン描画用 JSON（現在の settingsTarget のスキーマ＋現在値）。 */
    private fun settingsViewJson(): String {
        val target = settingsTarget ?: return "{}"
        // settingsTarget はファイル名（bridge ID）。設定 namespace は displayName(@name) で揃える。
        val info = store.list().firstOrNull { it.name == target } ?: return "{}"
        val ns = info.displayName
        val arr = JSONArray()
        info.settings.forEach { d ->
            val value = PluginSettings.coerce(d.type, store.settingValue(ns, d.key) ?: d.default)
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

    /** 設定変更を全 WEB スクリーンへリロード無しで配信する（generation は上げない）。 */
    private fun pushSettingLive(name: String, key: String, value: Boolean) {
        val js = "window.__ccApplyPluginSetting && window.__ccApplyPluginSetting(" +
            "${JSONObject.quote(name)}, ${JSONObject.quote(key)}, $value);"
        screens.webScreens().forEach { it.webView.evaluateJavascript(js, null) }
    }

    /** プラグイン設定の全画面（plugin-settings.html）をオーバーレイ表示する（notify と同型）。 */
    private fun openPluginSettings() {
        val sv = settingsView ?: newConfiguredWebView().also {
            it.webViewClient = WebViewClient()
            it.loadUrl("file:///android_asset/plugin-settings.html")
            root.addView(
                it,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
            settingsView = it
        }
        sv.visibility = View.VISIBLE
        sv.bringToFront()
        sv.evaluateJavascript("window.__ccRenderSettings && window.__ccRenderSettings();", null)
    }

    private fun closePluginSettings() { settingsView?.visibility = View.GONE }

    // ── 補助 ────────────────────────────────────────────────────────────

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 0
            )
        }
    }

    /** assets/<name> をテキストで読む。読めなければ null。 */
    private fun assetText(name: String): String? = try {
        assets.open(name).bufferedReader().use { it.readText() }
    } catch (e: Exception) {
        Log.w("CcStudio", "asset read failed: $name", e)
        null
    }

    /** assets/<name> を指定 WebView に注入する。 */
    private fun injectAssetInto(view: WebView, name: String) {
        val js = assetText(name) ?: return
        view.evaluateJavascript(js, null)
    }

    /**
     * インストール済みプラグインを JSON 化する。
     * name=ファイル名(=bridge のID), displayName=@name(表示用), 他に version/description/
     * hasSettings/bundled/runAt/allFrames。UI はタイトルに displayName、操作キーに name を使う。
     */
    private fun pluginsJson(): String {
        val arr = JSONArray()
        store.list().forEach {
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

    /** content:// の表示名（ファイル名）を取得する。取れなければ null。 */
    private fun queryDisplayName(uri: Uri): String? = try {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (e: Exception) {
        null
    }

    private fun toast(msg: String) =
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    /**
     * WebView の DownloadListener フォールバック。blob:/data: は bootstrap.js のフックが横取りするので
     * ここに来るのは主に http(s) の直リンク。
     */
    private fun handleDownload(url: String, contentDisposition: String?, mimeType: String?) {
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
                    saveBase64Download("download", mime, data)
                }
                else -> {
                    val request = DownloadManager.Request(Uri.parse(url)).apply {
                        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
                        setMimeType(mimeType)
                        CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                    }
                    (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                    runOnUiThread { toast("ダウンロードを開始しました") }
                }
            }
        } catch (e: Exception) {
            Log.w("CcStudio", "handleDownload failed: $url", e)
            runOnUiThread { toast("ダウンロードに失敗しました") }
        }
    }

    /** base64 のダウンロードデータを端末の Downloads フォルダへ保存する。JS スレッドから呼ばれる。 */
    private fun saveBase64Download(name: String, mime: String, base64: String) {
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
                val resolver = contentResolver
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
                FileOutputStream(uniqueFile(dir, filename)).use { it.write(bytes) }
            }
            true
        } catch (e: Exception) {
            Log.w("CcStudio", "saveBase64Download failed: $name", e)
            err = e.message
            false
        }
        runOnUiThread {
            if (ok) toast("保存しました: $name") else toast("保存に失敗しました")
        }
        if (!ok) Log.w("CcStudio", "save failed reason: $err")
    }

    // ── ダウンロード（チャンク・ストリーミング） ──────────────────────────
    // 大きいファイルでも巨大 base64 を一括で持たず、JS から少しずつ受けて追記する。
    // 進捗バーは JS 側（blob.size 基準）で描く。ここは保存先の生成・追記・確定のみ。

    private class DownloadSink(
        val uri: Uri?,            // MediaStore（API29+）
        val file: File?,          // legacy（API<29）
        val out: java.io.OutputStream,
        val name: String
    )

    private val downloads = java.util.concurrent.ConcurrentHashMap<String, DownloadSink>()
    private val downloadSeq = java.util.concurrent.atomic.AtomicInteger(0)

    /** 保存先を開いて token を返す。失敗時は空文字。JS スレッドから呼ばれる。 */
    private fun downloadBegin(name: String, mime: String): String {
        return try {
            val filename = sanitizeFilename(name)
            val token = "dl${downloadSeq.incrementAndGet()}"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    if (mime.isNotEmpty()) put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return ""
                val out = contentResolver.openOutputStream(uri) ?: run {
                    contentResolver.delete(uri, null, null); return ""
                }
                downloads[token] = DownloadSink(uri, null, out, filename)
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                if (!dir.exists()) dir.mkdirs()
                val file = uniqueFile(dir, filename)
                downloads[token] = DownloadSink(null, file, FileOutputStream(file), filename)
            }
            token
        } catch (e: Exception) {
            Log.w("CcStudio", "downloadBegin failed: $name", e)
            ""
        }
    }

    /** base64 のチャンクを追記。JS スレッドから順に呼ばれる。 */
    private fun downloadChunk(token: String, base64: String): Boolean {
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
    private fun downloadEnd(token: String): Boolean {
        val sink = downloads.remove(token) ?: return false
        return try {
            sink.out.flush(); sink.out.close()
            if (sink.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                contentResolver.update(
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
    private fun downloadAbort(token: String) {
        val sink = downloads.remove(token) ?: return
        try { sink.out.close() } catch (_: Exception) {}
        try {
            if (sink.uri != null) contentResolver.delete(sink.uri, null, null)
            else sink.file?.delete()
        } catch (_: Exception) {}
    }

    private fun sanitizeFilename(name: String): String {
        val cleaned = name.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1F]"), "_")
            .trim()
        return cleaned.ifEmpty { "download_${SystemClock.elapsedRealtime()}" }
    }

    /** 同名ファイルが存在する場合に name(1).ext のような一意名を返す（API<29 用）。 */
    private fun uniqueFile(dir: File, name: String): File {
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

    private var cachedIconDataUri: String? = null

    /** アプリのランチャーアイコンを data:image/png;base64,... に変換して返す（進捗バー用、結果はキャッシュ）。 */
    private fun appIconDataUri(): String {
        cachedIconDataUri?.let { return it }
        return try {
            val d = packageManager.getApplicationIcon(packageName)
            val size = 96
            val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bmp)
            d.setBounds(0, 0, size, size)
            d.draw(canvas)
            val bos = java.io.ByteArrayOutputStream()
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, bos)
            ("data:image/png;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP))
                .also { cachedIconDataUri = it }
        } catch (e: Exception) {
            Log.w("CcStudio", "appIconDataUri failed", e)
            ""
        }
    }

    companion object {
        // 既定で開くワークベンチ URL。実値は local.properties の ccstudio.targetUrl から
        // BuildConfig 経由で注入する（build.gradle 参照）。個人ホストはコミットしない。
        private val TARGET_URL = BuildConfig.TARGET_URL

        private const val SETTINGS_RUNTIME_KEY = "__ccSettingsRuntime"

        /** document-start で window.__ccPluginSettings を用意し、ライブ更新の受け口を定義する。 */
        private const val SETTINGS_RUNTIME_JS = """
(function(){
  try { window.__ccPluginSettings = JSON.parse(window.CCStudio.getPluginSettings() || '{}'); }
  catch(e){ window.__ccPluginSettings = {}; }
  window.__ccApplyPluginSetting = function(plugin, key, val){
    var p = window.__ccPluginSettings[plugin] || (window.__ccPluginSettings[plugin] = {});
    p[key] = val;
    try {
      window.dispatchEvent(new CustomEvent('ccstudio:setting',
        { detail: { plugin: plugin, key: key, value: val } }));
    } catch(_){}
  };
})();
"""

        /** blob: URL を fetch して base64 化し、CCStudio.saveBase64 に渡す JS。 */
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
