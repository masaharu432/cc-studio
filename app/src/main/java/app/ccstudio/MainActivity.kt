package app.ccstudio

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import okhttp3.Request
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var screens: ScreenManager
    private lateinit var store: PluginStore
    private lateinit var screenStore: ScreenStore
    private val downloader = DownloadController(this) { toast(it) }
    private var settingsTarget: String? = null

    private val serverConfig by lazy { ServerConfig.forContext(this) }

    /** 現在の接続先オリジン（末尾スラッシュ無し）。未設定なら null。 */
    private fun originOrNull(): String? = serverConfig.origin()

    /**
     * 起動時・新規スクリーンで開く URL。初期フォルダ（defaultFolder）が設定されていればそのフォルダ、
     * 無ければオリジンのルート。origin 未設定なら null。
     * ルート（"$origin/"）だと code-server が直近ワークスペースを復元してしまい、
     * 設定した初期フォルダが無視されるため、既定フォルダがあれば必ず folderUrl を使う。
     */
    private fun initialScreenUrl(): String? = originOrNull()?.let { org ->
        serverConfig.defaultFolder()?.let { UrlPolicy.folderUrl(org, it) } ?: "$org/"
    }

    // ── 全画面オーバーレイ（遅延生成・使い回し）。表示順序・再描画 JS は従来と同一。 ──
    private fun overlayWebView(): WebView =
        screenFactory.newConfiguredWebView().also { it.webViewClient = screenFactory.baseWebViewClient() }
    private val switcherPanel by lazy {
        OverlayPanel(root, "switcher.html", "", ::overlayWebView)
    }
    private val notifyPanel by lazy {
        OverlayPanel(root, "notify.html", "window.__ccRenderNotify && window.__ccRenderNotify();", ::overlayWebView)
    }
    private val logPanel by lazy {
        OverlayPanel(root, "log.html", "window.__ccRenderLog && window.__ccRenderLog();", ::overlayWebView)
    }
    private val settingsPanel by lazy {
        OverlayPanel(root, "plugin-settings.html", "window.__ccRenderSettings && window.__ccRenderSettings();", ::overlayWebView)
    }

    // 接続先設定オーバーレイ（server.html）。show() は Task 7 の openServer() から。
    private val serverPanel by lazy {
        OverlayPanel(root, "server.html", "window.__ccRenderServer && window.__ccRenderServer();", ::overlayWebView)
    }

    private val okHttp = okhttp3.OkHttpClient()

    /** OS バック用ナビスタック（純粋モデル）。表示副作用は popBack が PopAction を見て実行する。 */
    private val nav = NavModel()

    /** 最後にアクティブだった WEB スクリーン。plugins スクリーンから switcher を閉じるときの戻り先。 */
    private var lastWebScreenId: Long = -1L

    /** プラグインの有効集合が変わるたびに +1。各 Web スクリーンの loadedGeneration と比べて stale 判定。 */
    private var pluginGeneration: Int = 0

    private val pickJs = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri == null) return@registerForActivityResult
        val saved = store.installFromUri(uri, queryDisplayName(uri))
        Toast.makeText(
            this,
            if (saved != null) getString(R.string.toast_plugin_added, saved)
            else getString(R.string.toast_plugin_load_failed),
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
        // 初回シード: server.json 未設定かつ BuildConfig が実 HTTPS ドメインなら移送。
        if (serverConfig.origin() == null) {
            ServerConfigCodec.seedOriginFrom(SEED_TARGET_URL)?.let { serverConfig.setOrigin(it) }
        }
        screens.onActiveChanged = { s ->
            NotifyState.activeFolder =
                if (s != null && s.kind == ScreenKind.WEB) ScreenUrl.folderPath(s.url) else null
            if (s != null && s.kind == ScreenKind.WEB) lastWebScreenId = s.id
            // 表示スクリーンが変わったら、その ︙ボタンに全体の集約状態を塗り直す。
            pushMenuState()
        }

        // 1) Plugins システムスクリーン（先頭・固定）
        screens.add(screenFactory.createSystemPluginsScreen())

        // 2) 復元 or 既定の Web スクリーン
        // 復元/起動時の WebView も初回ロード後に一度 reload する（reloadOnFirstLoad=true）。
        // これをしないと document-start 登録が「新規 WebView の初回ナビゲーション」に乗らず、
        // アプリ更新後などに既存スクリーンでキーボード抑制が効かないことがある。
        val state = screenStore.load()
        if (state.urls.isEmpty()) {
            initialScreenUrl()?.let { screens.add(createWebScreen(it, reloadOnFirstLoad = true)) }
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

        // 接続先が未設定（シードも不可）なら、localhost へは繋がず設定パネルを促す。
        // Nav.Server も積んでおく（他の設定導線と同様。積まないと戻るボタンがこのパネルを畳めない）。
        if (serverConfig.origin() == null) {
            nav.ensureSwitcher("settings"); nav.push(Nav.Server); openServer("host")
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { popBack() }
        })
    }

    override fun onResume() {
        super.onResume()
        NotifyState.foreground = true
        NotifyState.activeFolder = screens.activeOrNull()
            ?.takeIf { it.kind == ScreenKind.WEB }
            ?.let { ScreenUrl.folderPath(it.url) }
        ObserverLog.lifecycle(this, "foreground")
        ContextCompat.startForegroundService(
            this,
            Intent(this, KeepAliveService::class.java).setAction(KeepAliveService.ACTION_UPLOAD),
        )
    }

    override fun onPause() {
        super.onPause()
        NotifyState.foreground = false
        ObserverLog.lifecycle(this, "background")
    }

    // ── 診断: 「本当の背面化(stop/start)」と「一時的なフォーカス喪失(winblur/winfocus)」を
    //    onPause/onResume(=foreground/background) と区別して記録する。
    //    突発キャンセルは onPause だけで onStop を伴わない“一時フォーカス喪失”に相関する疑いがあるため、
    //    この3系統を分けて突合できるようにする。
    override fun onStart() {
        super.onStart()
        ObserverLog.lifecycle(this, "start-visible")
    }

    override fun onStop() {
        super.onStop()
        ObserverLog.lifecycle(this, "stop-hidden")
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        ObserverLog.lifecycle(this, if (hasFocus) "winfocus" else "winblur")
    }

    /** 破棄処理中フラグ。破棄中に届くナビゲーション等のコールバックが空のリストを永続化しないため。 */
    private var tearingDown = false

    /**
     * recreate()（言語変更・レンダラ死復旧）や実終了時に、全スクリーン WebView と
     * オーバーレイ WebView を確実に破棄する（未処理だと接続を持ったままリークし、
     * 旧 Activity のコールバックが新 Activity の永続状態を壊しうる）。
     * ScreenStore への保存はここではしない: 破棄途中のリストを保存すると復元内容が壊れる。
     * 次回 onCreate が ScreenStore から再構築するので破棄自体は安全。
     */
    override fun onDestroy() {
        tearingDown = true
        if (::screens.isInitialized) screens.destroyAll()
        listOf(switcherPanel, notifyPanel, logPanel, settingsPanel, serverPanel).forEach { it.destroy() }
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(KeepAliveService.EXTRA_OPEN_CWD)?.let { openScreenForCwd(it) }
    }

    /** 通知タップ用: cwd に対応する WEB スクリーンへ。無ければ新規作成して開く。 */
    private fun openScreenForCwd(cwd: String) {
        if (cwd.isEmpty()) return
        // オーバーレイ（switcher 等）を開いたまま背面化していると、select しても
        // その上に被さったままスクリーン一覧が見え続けるため、先に全て畳む。
        nav.clear()
        closeNotify(); closeLog(); closePluginSettings(); closeServer(); closeSwitcher()
        val hit = screens.webScreens().firstOrNull {
            NotifyDecision.matches(ScreenUrl.folderPath(it.url), cwd)
        }
        if (hit != null) {
            screens.select(hit.id)
            return
        }
        val url = originOrNull()?.let { UrlPolicy.folderUrl(it, cwd) } ?: return
        val s = createWebScreen(url, reloadOnFirstLoad = true)
        screens.add(s); screens.select(s.id); persistScreens()
    }

    // ── WebView ファクトリ ──────────────────────────────────────────────

    /**
     * レンダラプロセス死の共通ハンドラ。WebView のレンダラは FGS の保護外の別プロセスで、
     * 背面では優先度が下がり殺されうる。onRenderProcessGone を処理しないと Android は
     * アプリ本体ごと強制終了する（＝通知常駐でも殺される最大の抜け穴）。
     * ここでは (1) 道連れクラッシュを防ぎ (2) 原因を永続ログに記録し (3) Activity を
     * 作り直して全画面を復旧する（レンダラは全 WebView で共有のため個別復旧は意味がない）。
     */
    @Volatile private var rendererGoneHandled = false
    private fun handleRendererGone(detail: RenderProcessGoneDetail?): Boolean {
        if (!rendererGoneHandled) {
            rendererGoneHandled = true
            try {
                ObserverLog.lifecycle(this, if (detail?.didCrash() == true) "renderer-crash" else "renderer-killed")
            } catch (_: Exception) {}
            runOnUiThread { recreate() }
        }
        return true
    }

    /** WebView 構成・スクリーン生成・プラグイン注入の実体。副作用はラムダで Activity に戻す。 */
    private val screenFactory by lazy {
        ScreenFactory(
            this, store,
            ScreenFactory.Deps(
                nextId = { screens.nextId() },
                buildBridge = ::buildBridge,
                onShowFileChooser = ::onShowFileChooser,
                onDownload = { url, cd, mime -> downloader.handleDownload(url, cd, mime) },
                onRendererGone = ::handleRendererGone,
                isExternalHttp = ::isExternalHttp,
                openExternalUrl = ::openExternalUrl,
                injectAsset = ::injectAssetInto,
                effectiveSettingsJson = ::effectiveSettingsJson,
                currentGeneration = { pluginGeneration },
                onScreenNavigated = { persistScreens() },
            ),
        )
    }

    /** <input type="file"> の選択 UI を開く（ScreenFactory の WebChromeClient から呼ばれる）。 */
    private fun onShowFileChooser(
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: WebChromeClient.FileChooserParams,
    ): Boolean {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = filePathCallback
        return try {
            pickFiles.launch(fileChooserParams.createIntent()); true
        } catch (e: Exception) {
            Log.w("CcStudio", "onShowFileChooser failed", e)
            fileChooserCallback = null
            toast(getString(R.string.toast_file_chooser_failed)); false
        }
    }

    private fun createWebScreen(url: String, reloadOnFirstLoad: Boolean = false): Screen =
        screenFactory.createWebScreen(url, reloadOnFirstLoad)

    /** origin のホスト（ポート無し）。null-safe。外部リンク判定など「ホストだけ」比較する用途向け。 */
    private fun originHost(): String? =
        originOrNull()?.let { try { Uri.parse(it).host } catch (_: Exception) { null } }

    /** origin の authority（host:port。ポート省略時は host と同じ）。null-safe。表示/プリフィル用途向け。 */
    private fun originAuthority(): String? =
        originOrNull()?.let { origin ->
            try { Uri.parse(origin).let { it.authority ?: it.host } } catch (_: Exception) { null }
        }

    /** workbench（アプリが開く code-server）のホスト。これ以外の http(s) ホストは「外部」とみなす。 */
    private val workbenchHost: String?
        get() = originHost()

    /** workbench 以外の http(s) ホストへのナビゲーションか（＝外部ブラウザで開くべきか）。 */
    private fun isExternalHttp(uri: Uri): Boolean =
        UrlPolicy.isExternalHttp(uri.scheme, uri.host, workbenchHost)

    /** URL を Android の外部ブラウザ（既定ブラウザ）で開く。 */
    private fun openExternalUrl(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w("CcStudio", "openExternalUrl failed: $uri", e)
            runOnUiThread { toast(getString(R.string.toast_external_link_failed)) }
        }
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
        onSave = { name, mime, b64 -> downloader.saveBase64(name, mime, b64) },
        onSaveFailed = { msg ->
            runOnUiThread { toast(getString(R.string.toast_download_failed)) }
            Log.w("CcStudio", "download failed in JS: $msg")
        },
        onDlBegin = { name, mime -> downloader.begin(name, mime) },
        onDlChunk = { token, b64 -> downloader.chunk(token, b64) },
        onDlEnd = { token -> downloader.end(token) },
        onDlAbort = { token -> downloader.abort(token) },
        iconDataUriFn = { appIconDataUri() },
        buildLabel = BuildConfig.BUILD_LABEL,
        onOpenSwitcher = { runOnUiThread { openSwitcher() } },
        onCloseSwitcher = { runOnUiThread { closeSwitcher() } },
        screensJsonFn = { ScreensJson.build(screens.rows(pluginGeneration)) },
        onSelectScreen = { id -> runOnUiThread { nav.clear(); closeSwitcher(); screens.select(id) } },
        onReloadScreen = { id ->
            runOnUiThread {
                nav.clear(); closeSwitcher()
                screens.byId(id)?.let { reloadScreen(it); screens.select(id) }
            }
        },
        onCloseScreen = { id -> runOnUiThread { screens.close(id); persistScreens(); refreshSwitcher() } },
        onNewScreen = {
            runOnUiThread {
                val s = createWebScreen(initialScreenUrl() ?: return@runOnUiThread, reloadOnFirstLoad = true)
                screens.add(s); screens.select(s.id); persistScreens()
                nav.clear(); closeSwitcher()
            }
        },
        notifyPrefsJsonFn = { NotifyPrefs.toJson(this) },
        onSetNotifyPref = { kind, enabled -> NotifyPrefs.setEnabled(this, kind, enabled) },
        onOpenNotify = { runOnUiThread { openSettingsEntry("notify") } },
        onCloseNotify = { runOnUiThread { popBack() } },
        pluginSettingsJsonFn = { effectiveSettingsJson() },
        onOpenPluginSettings = { name ->
            runOnUiThread {
                settingsTarget = name
                nav.push(Nav.PluginSettings)
                openPluginSettings()
            }
        },
        settingsViewJsonFn = { settingsViewJson() },
        onSetSetting = { name, key, raw ->
            store.setSettingRaw(name, key, raw)
            runOnUiThread { pushSettingLive(name, key, raw) }
        },
        onClosePluginSettings = { runOnUiThread { popBack() } },
        onSessionState = { busy, disconnected -> onSessionState(screenId, busy, disconnected) },
        onMarkdownPreview = { runOnUiThread { dispatchMarkdownPreviewKey() } },
        onObserverLog = { json -> onObserverLog(screenId, json) },
        onOpenLog = { runOnUiThread { openSettingsEntry("log") } },
        onCloseLog = { runOnUiThread { popBack() } },
        observerLogTextFn = { observerLogForDisplay() },
        onDownloadObserverLog = { downloadObserverLog() },
        settingsListJsonFn = { settingsListJson() },
        onOpenSettingsEntry = { id -> runOnUiThread { openSettingsEntry(id) } },
        onSwitcherTabChanged = { tab -> runOnUiThread { onSwitcherTabChanged(tab) } },
        onNavBack = { runOnUiThread { popBack() } },
        uiLangFn = { if (AppLang.isJa(this)) "ja" else "en" },
        serverConfigJsonFn = {
            val o = serverConfig.origin() ?: ""
            org.json.JSONObject().put("origin", o)
                .put("defaultFolder", serverConfig.defaultFolder() ?: "")
                .put("host", originAuthority() ?: "").toString()
        },
        serverModeFn = { serverPanelMode },
        onSaveServerOrigin = { host -> runOnUiThread { applyServerOrigin(host) } },
        onSaveDefaultFolder = { path -> runOnUiThread {
            serverConfig.setDefaultFolder(path); toast(getString(R.string.toast_default_folder_saved))
        } },
        onBrowseDir = { path -> fetchDirs(path) },
    )

    // ── 接続先設定（server.html） ──────────────────────────────────────

    /**
     * ホスト入力を検証・保存し、KeepAlive を新ホストへ再購読する。既定は「保存するだけ」で画面遷移しない。
     * ただしホストが実際に変わった（旧 origin と異なる）ときだけ、既存スクリーンは旧ホストを指して無効に
     * なるため「新ホストで開き直すか」を確認ダイアログで尋ねる（切替はユーザー確認後のみ）。
     */
    private fun applyServerOrigin(host: String) {
        val r = ServerConfigCodec.normalizeOrigin(host)
        if (r !is OriginResult.Ok) { toast(getString(R.string.toast_origin_invalid)); return }
        val old = serverConfig.origin()
        serverConfig.setOrigin(r.origin)
        stopService(Intent(this, KeepAliveService::class.java))
        ContextCompat.startForegroundService(this, Intent(this, KeepAliveService::class.java))
        if (old != null && old != r.origin && screens.webScreens().isNotEmpty()) {
            confirmHostSwitch(r.origin)
        } else {
            toast(getString(R.string.toast_server_updated))
        }
    }

    /** ホストが変わったとき、新ホストでスクリーンを開き直すか確認する。設定自体は既に保存済み。 */
    private fun confirmHostSwitch(newOrigin: String) {
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(getString(R.string.server_switch_title))
            .setMessage(getString(R.string.server_switch_message))
            .setPositiveButton(getString(R.string.server_switch_reopen)) { d, _ ->
                d.dismiss()
                // 旧ホストの Web スクリーンを閉じ、新ホストで初期フォルダのスクリーンを1枚開いて表示する。
                screens.webScreens().forEach { screens.close(it.id) }
                val s = createWebScreen(initialScreenUrl() ?: "$newOrigin/", reloadOnFirstLoad = true)
                screens.add(s); screens.select(s.id); persistScreens()
                nav.clear()
                closeNotify(); closeLog(); closePluginSettings(); closeServer(); closeSwitcher()
            }
            .setNegativeButton(getString(R.string.server_switch_keep)) { d, _ ->
                d.dismiss()
                toast(getString(R.string.toast_server_updated))
            }
            .show()
    }

    /** …/ls を OkHttp で非同期取得し、生 JSON を window.__ccDirResult に渡す。未接続/失敗は {error}。 */
    private fun fetchDirs(path: String) {
        val origin = originOrNull()
        if (origin == null) {
            // このメソッドは JavaBridge スレッドから呼ばれる。WebView 操作は UI スレッドで（他分岐と同様）。
            runOnUiThread { serverPanel.evaluate("window.__ccDirResult({\"error\":\"not_connected\"})") }; return
        }
        val url = "$origin/cc-notify/ls" + if (path.isNotEmpty()) "?path=" + Uri.encode(path) else ""
        okHttp.newCall(Request.Builder().url(url).build()).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                runOnUiThread { serverPanel.evaluate("window.__ccDirResult({\"error\":\"fetch_failed\"})") }
            }
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                val body = response.body?.string()
                val payload = if (response.isSuccessful && body != null) body else "{\"error\":\"not_a_directory\"}"
                runOnUiThread { serverPanel.evaluate("window.__ccDirResult($payload)") }
            }
        })
    }

    /**
     * アクティブな WebView へ Ctrl+Shift+V（markdown.togglePreview）をトラステッドなキーイベントとして
     * 送る。プラグインが .md をテキストで開いた直後に呼ばれ、エディタをプレビュー表示へトグルする。
     * 修飾キーを押下→V→離す、の順で本物のキー入力を再現する（VS Code は isTrusted=false を無視するため）。
     */
    private fun dispatchMarkdownPreviewKey() {
        val wv = screens.activeOrNull()?.webView ?: return
        toast(getString(R.string.toast_mdpv))
        wv.requestFocus()
        // focus が落ち着いてから送る。
        wv.postDelayed({
            // 遅延中にスクリーンが閉じられ WebView が破棄済みなら送らない（destroy 後の操作防止）。
            if (!wv.isAttachedToWindow) return@postDelayed
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

    private fun reloadScreen(s: Screen) = screenFactory.reloadScreen(s)

    private fun bumpGenerationAndSync() {
        pluginGeneration++
        screens.webScreens().forEach { screenFactory.registerScreenScripts(it) }
        refreshSwitcher()
        // 反映は各スクリーンの手動リロードで（他セッションに影響しないよう自動リロードはしない）。
    }

    /** 直近アクティブだった WEB スクリーンの index（保存用）。非 WEB 表示中の保存で 0 に潰さないため。 */
    private var lastActiveWebIndex = 0

    private fun persistScreens() {
        if (tearingDown) return  // 破棄中の onScreenNavigated 等で空になりかけのリストを保存しない
        val web = screens.webScreens()
        val urls = web.map { it.url }
        val activeIdx = web.indexOfFirst { it.id == screens.activeOrNull()?.id }
        // 非 WEB（Plugins 等）がアクティブなときは -1 になる。0 で上書きすると
        // プロセス死をまたいで「最後に居た WEB スクリーン」が失われるため、直近の値を保つ。
        if (activeIdx >= 0) lastActiveWebIndex = activeIdx
        val saveIdx = if (activeIdx >= 0) activeIdx
        else lastActiveWebIndex.coerceIn(0, maxOf(urls.size - 1, 0))
        screenStore.save(urls, saveIdx)
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

    /**
     * cancel の重複除去時刻（screenId → 最終記録時刻）。リロード再検知の吸収が目的なので
     * スクリーン単位で持つ（グローバル1個だと、別スクリーンの正規キャンセルまで 15 秒窓で落ちる）。
     * 各 WebView の JavaBridge スレッドから触るため ConcurrentHashMap。
     */
    private val lastCancelAtByScreen = java.util.concurrent.ConcurrentHashMap<Long, Long>()

    /** プラグインからの生の状態遷移を、スクリーン情報＋端末時刻を付けて永続ログへ書く。 */
    private fun onObserverLog(screenId: Long, json: String) {
        try {
            val s = screens.byId(screenId)
            val screen = if (s?.kind == ScreenKind.WEB) ScreenUrl.folderName(s.url) else (s?.title ?: "")
            val cwd = if (s?.kind == ScreenKind.WEB) (ScreenUrl.folderPath(s.url) ?: "") else ""
            val now = System.currentTimeMillis()
            when (val a = ObserverIngest.decide(json, lastCancelAtByScreen[screenId] ?: 0L, now)) {
                ObserverIngest.Action.RecordCancel -> {
                    lastCancelAtByScreen[screenId] = now
                    ObserverLog.cancel(this, screen, cwd)
                }
                is ObserverIngest.Action.RecordState ->
                    ObserverLog.screenState(this, screen, cwd, a.busy, a.disconnected, a.matched)
                ObserverIngest.Action.DropDuplicateCancel, ObserverIngest.Action.Ignore -> {}
            }
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

    // ── switcher オーバーレイ / ナビスタック ─────────────────────────────

    /** ︙ボタン（WEB スクリーン）から開く入口。設定導線をリセットしてスクリーン側で開く。 */
    private fun openSwitcher() {
        nav.clear()
        nav.push(Nav.Switcher("screens"))
        showSwitcherView("screens")
    }

    /** switcher の WebView を（必要なら作って）表示し、指定タブに合わせる。スタックは触らない。 */
    private fun showSwitcherView(tab: String) {
        // 初回生成時は loadUrl が非同期で evaluate が届かない（ページ既定は screens タブ）ため、
        // 初期タブは URL クエリで渡す。生成済み（ロード済み）のときは従来どおり evaluate で合わせる。
        switcherPanel.show("tab=$tab")
        setSwitcherTabJs(tab)
        refreshSwitcher()
    }

    /** スタック上の Switcher のタブを合わせてから表示する（pop 後の開き直し用）。 */
    private fun showSwitcher(tab: String) {
        nav.setSwitcherTab(tab)
        showSwitcherView(tab)
    }

    private fun closeSwitcher() { switcherPanel.hide() }

    private fun setSwitcherTabJs(tab: String) {
        switcherPanel.evaluate("window.__ccSetTab && window.__ccSetTab('$tab');")
    }

    /** switcher 内のタブ操作の報告（JS 発）。バック時の遷移判断に使う。 */
    private fun onSwitcherTabChanged(tab: String) {
        nav.noteSwitcherTab(tab)
    }

    /** OS バックとアプリ内 ‹ ボタンの共通 pop。遷移の判断は NavModel、表示副作用はここ。 */
    private fun popBack() {
        when (nav.pop()) {
            PopAction.ClosePluginSettings -> closePluginSettings()  // 下の PluginsScreen（表示中）に戻る
            PopAction.CloseNotifyToSettings -> { closeNotify(); showSwitcher("settings") }
            PopAction.CloseLogToSettings -> { closeLog(); showSwitcher("settings") }
            PopAction.CloseServerToSettings -> { closeServer(); showSwitcher("settings") }
            PopAction.ShowSettingsSwitcher -> showSwitcher("settings")
            PopAction.SwitchToScreensTab -> setSwitcherTabJs("screens")
            PopAction.CloseSwitcher -> {
                closeSwitcher()
                // plugins スクリーンが裏に見えている状態で閉じたら、直前の WEB スクリーンへ戻す。
                if (screens.activeOrNull()?.kind != ScreenKind.WEB) {
                    screens.byId(lastWebScreenId)?.let { screens.select(it.id) }
                }
            }
            PopAction.Fallback -> {
                // 防御: スタックと表示がズレていたら、見えているオーバーレイを畳むだけにする。
                val visible = listOf(notifyPanel, logPanel, settingsPanel, serverPanel, switcherPanel)
                    .any { it.isVisible() }
                if (visible) {
                    closeNotify(); closeLog(); closePluginSettings(); closeServer(); closeSwitcher()
                    return
                }
                val a = screens.activeOrNull()
                // WebView に戻る履歴があれば戻る。無い場合は finish() せず
                // ホームボタン同等にバックグラウンドへ送る（moveTaskToBack）。
                // finish() すると Activity/WebView が破棄され、次回起動でリロードが走るため。
                if (a != null && a.webView.canGoBack()) a.webView.goBack() else moveTaskToBack(true)
            }
        }
    }

    /** 設定側の一覧（switcher が描く）。 */
    private fun settingsListJson(): String {
        val plugins = store.list()
        return PanelJson.settingsList(
            plugins.size, plugins.count { it.enabled }, originAuthority(), serverConfig.defaultFolder(), AppLang.isJa(this)
        )
    }

    /** 設定エントリのタップ。遷移の実体はここで解決する（switcher は id を渡すだけ）。 */
    private fun openSettingsEntry(id: String) {
        // 設定導線の起点は switcher（設定側）。スタックに無ければ積んでおく（防御）。
        nav.ensureSwitcher("settings")
        when (id) {
            "plugins" -> {
                closeSwitcher()
                nav.push(Nav.PluginsScreen)
                screens.all().firstOrNull { it.kind == ScreenKind.SYSTEM_PLUGINS }
                    ?.let { screens.select(it.id) }
            }
            "notify" -> { closeSwitcher(); nav.push(Nav.Notify); openNotify() }
            "log" -> { closeSwitcher(); nav.push(Nav.Log); openLog() }
            "server" -> { closeSwitcher(); nav.push(Nav.Server); openServer("host") }
            "defaultfolder" -> { closeSwitcher(); nav.push(Nav.Server); openServer("folder") }
            "lang" -> openLanguageDialog()   // ダイアログ表示のみ。switcher は裏に残す
        }
    }

    /**
     * 表示言語の選択ダイアログ。選択は AppCompatDelegate の per-app language に永続化される。
     * この Activity は configChanges=locale で自動再生成されないため、変更時は明示的に
     * recreate() して新しい言語で作り直す（全スクリーンがリロードされる点は言語変更の明示操作
     * なので許容。実行中ターンがある場合は中断されうる）。
     */
    private fun openLanguageDialog() {
        val current = AppLang.current()
        val choices = arrayOf("system", "ja", "en")
        val labels = arrayOf(getString(R.string.lang_follow_device), "日本語", "English")
        val checked = choices.indexOf(current).let { if (it < 0) 0 else it }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(getString(R.string.lang_dialog_title))
            .setSingleChoiceItems(labels, checked) { dialog, which ->
                dialog.dismiss()
                val choice = choices[which]
                if (choice != current) {
                    AppLang.set(choice)
                    recreate()
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** 通知設定の全画面（notify.html）をオーバーレイ表示する（switcher と同型）。 */
    private fun openNotify() { notifyPanel.show() }

    private fun closeNotify() { notifyPanel.hide() }

    // ── ログビューア（log.html オーバーレイ・notify と同型） ──
    private fun openLog() { logPanel.show() }

    private fun closeLog() { logPanel.hide() }

    // ── 接続先設定（server.html オーバーレイ・notify と同型） ──
    // server.html は host / folder の2モードで開く。設定リストの「接続先」「最初に開くフォルダ」に対応。
    private var serverPanelMode: String = "host"
    private fun openServer(mode: String) { serverPanelMode = mode; serverPanel.show() }

    private fun closeServer() { serverPanel.hide() }

    /** 表示用ログ本文（末尾を上限で切る。ダウンロードは全文）。 */
    private fun observerLogForDisplay(): String {
        val text = ObserverLog.readAll(this)
        val max = 200_000
        return if (text.length > max) text.substring(text.length - max) else text
    }

    /** 永続ログ全文を端末の Downloads へ保存する。 */
    private fun downloadObserverLog() {
        try {
            val text = ObserverLog.readAll(this)
            val b64 = android.util.Base64.encodeToString(text.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
            downloader.saveBase64("cc-studio-observer.log", "application/json", b64)
        } catch (e: Exception) {
            runOnUiThread { toast(getString(R.string.toast_log_save_failed)) }
            Log.w("CcStudio", "downloadObserverLog failed", e)
        }
    }

    private fun refreshSwitcher() {
        switcherPanel.evaluate("window.__ccRenderScreens && window.__ccRenderScreens();")
    }

    /** Plugins システムスクリーンの一覧を再描画させる（開いていれば反映）。 */
    private fun refreshActivePanel() {
        screens.all().firstOrNull { it.kind == ScreenKind.SYSTEM_PLUGINS }
            ?.webView?.evaluateJavascript("window.__ccRenderPlugins && window.__ccRenderPlugins();", null)
    }

    // ── プラグイン設定 ──────────────────────────────────────────────────

    /** 全プラグインの有効設定値を JSON 化（設定ランタイム注入用）。 */
    private fun effectiveSettingsJson(): String =
        PanelJson.effectiveSettings(store.effectiveSettings())

    /** 設定スクリーン描画用 JSON（現在の settingsTarget のスキーマ＋現在値）。 */
    private fun settingsViewJson(): String {
        // settingsTarget はファイル名（bridge ID）。設定 namespace は displayName(@name) で揃える。
        val info = settingsTarget?.let { t -> store.list().firstOrNull { it.name == t } }
        return PanelJson.settingsView(info, AppLang.isJa(this)) { ns, key -> store.settingValue(ns, key) }
    }

    /**
     * 設定変更を全 WEB スクリーンへリロード無しで配信する（generation は上げない）。
     * evaluateJavascript が届くのはメインフレームのみ。サブフレームへは
     * __ccApplyPluginSetting（SETTINGS_RUNTIME_JS）が message で下方に再伝搬する。
     */
    private fun pushSettingLive(name: String, key: String, raw: String) {
        // raw をスキーマの型で coerce してから JS リテラル化（number は clamp 済みの数値になる）。
        val def = store.settingsOf(name).firstOrNull { it.key == key }
        val v: Any = if (def != null) PluginSettings.coerce(def, raw) else raw
        val lit = when (v) {
            is Boolean -> v.toString()
            is Double -> if (v.isFinite()) v.toString() else "0"
            else -> JSONObject.quote(v.toString())
        }
        val js = "window.__ccApplyPluginSetting && window.__ccApplyPluginSetting(" +
            "${JSONObject.quote(name)}, ${JSONObject.quote(key)}, $lit);"
        screens.webScreens().forEach { it.webView.evaluateJavascript(js, null) }
    }

    /** プラグイン設定の全画面（plugin-settings.html）をオーバーレイ表示する（notify と同型）。 */
    private fun openPluginSettings() { settingsPanel.show() }

    private fun closePluginSettings() { settingsPanel.hide() }

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

    /** インストール済みプラグインの一覧 JSON。 */
    private fun pluginsJson(): String = PanelJson.plugins(store.list(), AppLang.isJa(this))

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
        // 既定で開くワークベンチ URL のビルド時シード。実値は local.properties から BuildConfig 経由。
        // ランタイムの真実源は ServerConfig（server.json）。ここは初回シードにのみ使う。
        private val SEED_TARGET_URL = BuildConfig.TARGET_URL
    }
}
