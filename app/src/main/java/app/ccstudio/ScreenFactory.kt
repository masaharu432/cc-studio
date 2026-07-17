package app.ccstudio

import android.annotation.SuppressLint
import android.app.Activity
import android.net.Uri
import android.os.Message
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * WebView の構成・スクリーン生成・プラグインの document-start 登録の一式
 * （MainActivity から移設。ロジック不変）。
 * Activity 側の状態・副作用（ファイル選択・ダウンロード・レンダラ死・永続化）は Deps で注入する。
 */
class ScreenFactory(
    private val activity: Activity,
    private val store: PluginStore,
    private val deps: Deps,
) {
    class Deps(
        val nextId: () -> Long,
        val buildBridge: (screenId: Long) -> CcBridge,
        val onShowFileChooser: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Boolean,
        val onDownload: (url: String, contentDisposition: String?, mimeType: String?) -> Unit,
        val onRendererGone: (RenderProcessGoneDetail?) -> Boolean,
        val isExternalHttp: (Uri) -> Boolean,
        val openExternalUrl: (Uri) -> Unit,
        val injectAsset: (WebView, String) -> Unit,
        val effectiveSettingsJson: () -> String,
        val currentGeneration: () -> Int,
        /** スクリーンの URL 確定・ロード完了時に呼ぶ（persistScreens 相当）。 */
        val onScreenNavigated: (Screen) -> Unit,
    )

    /** 全 WebView 共通のクライアント基底。レンダラ死を必ず処理する（未処理＝アプリごと死）。 */
    open inner class CcWebViewClient : WebViewClient() {
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean =
            deps.onRendererGone(detail)
    }

    /** オーバーレイ等、素の基底クライアントが欲しい呼び出し側向け。 */
    fun baseWebViewClient(): WebViewClient = CcWebViewClient()

    @SuppressLint("SetJavaScriptEnabled")
    fun newConfiguredWebView(screenId: Long = -1L): WebView = WebView(activity).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        // window.open(_blank)（チャット内リンク等）を onCreateWindow で受けるために必須。
        // 無効（既定）だと WebView は _blank をメインフレーム遷移に格下げし、workbench の
        // ページ自体が外部 URL へ遷移し始める。それを shouldOverrideUrlLoading で中断すると
        // ページに unload 系処理（VS Code の終了処理＝接続破棄）が走り、さらに中断された
        // 遷移が renderer に残って以後 ICB がリサイズされなくなる（キーボードで body が
        // 縮まずチャット入力欄が隠れる・送信が死ぬ、の実測原因）。
        settings.setSupportMultipleWindows(true)
        // 非可視でもレンダラ優先度を下げない（既定は非可視で waive＝背面kill の温床）。
        // 背面でターンを維持するというアプリの目的を優先し、電池より生存性を取る。
        setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean = deps.onShowFileChooser(filePathCallback, fileChooserParams)

            // _blank の行き先 URL は onCreateWindow 時点では分からないため、一時 WebView に
            // 受けて最初のナビゲーションで確定させる。外部→ブラウザ / 内部→元スクリーンに
            // 読み込み。メインフレームには一切遷移を試みさせない。
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message,
            ): Boolean {
                val temp = WebView(activity)
                // 破棄は一度だけ（行き先確定・レンダラ死・タイムアウトの3経路から呼ばれるため）。
                var settled = false
                fun settle() {
                    if (settled) return
                    settled = true
                    temp.post { try { temp.destroy() } catch (_: Exception) {} }
                }
                temp.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        if (deps.isExternalHttp(request.url)) {
                            deps.openExternalUrl(request.url)
                        } else {
                            view.loadUrl(request.url.toString())
                        }
                        settle()
                        return true
                    }

                    // 一時 WebView でもレンダラ死を処理しないと Android はアプリごと強制終了する
                    // （CcWebViewClient と同じ穴）。行き先確定前の使い捨てなので、全体復旧は
                    // 走らせず自身を破棄して true を返すだけでよい。
                    override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                        settle()
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = temp
                resultMsg.sendToTarget()
                // window.open('') のように一度もナビゲーションが来ない popup はそのままリークする。
                // 正規の _blank は直後にナビゲーションが来るため、30 秒待って未確定なら破棄する。
                temp.postDelayed({ settle() }, 30_000L)
                return true
            }
        }
        setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            deps.onDownload(url, contentDisposition, mimeType)
        }
        addJavascriptInterface(deps.buildBridge(screenId), "CCStudio")
    }

    fun createWebScreen(url: String, reloadOnFirstLoad: Boolean = false): Screen {
        val id = deps.nextId()
        val wv = newConfiguredWebView(id)
        val screen = Screen(id, ScreenKind.WEB, wv)
        screen.url = url
        var firstReloadDone = false
        wv.webViewClient = object : CcWebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // 外部サイト（調査リンク・ホームページ等）は外部ブラウザで開き、workbench を離れない。
                if (deps.isExternalHttp(request.url)) { deps.openExternalUrl(request.url); return true }
                return false
            }
            override fun doUpdateVisitedHistory(view: WebView, newUrl: String?, isReload: Boolean) {
                if (newUrl != null) { screen.url = newUrl; deps.onScreenNavigated(screen) }
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
                deps.injectAsset(view, "bootstrap.js")
                if (!ExtensionRuntime.isDocumentStartSupported()) {
                    view.evaluateJavascript("window.__ccPluginSettings = ${deps.effectiveSettingsJson()};", null)
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
                screen.loadedGeneration = deps.currentGeneration()
                deps.onScreenNavigated(screen)
            }
        }
        registerScreenScripts(screen)
        wv.loadUrl(url)
        return screen
    }

    fun createSystemPluginsScreen(): Screen {
        val id = deps.nextId()
        val wv = newConfiguredWebView(id)
        val screen = Screen(id, ScreenKind.SYSTEM_PLUGINS, wv)
        screen.title = "Plugins"
        wv.webViewClient = CcWebViewClient()
        wv.loadUrl("file:///android_asset/plugins.html")
        return screen
    }

    fun reloadScreen(s: Screen) {
        registerScreenScripts(s)   // 最新の有効集合で登録し直してから
        s.webView.reload()
    }

    /**
     * 有効プラグインを WEB スクリーンへ document-start 登録/解除する。
     * 対象は **all-frames=true** のプラグインのみ（全フレーム×document-start）。
     * all-frames=false のものはメインフレーム注入なので onPageFinished 側で扱う（ここでは登録しない）。
     */
    fun registerScreenScripts(s: Screen) {
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

    companion object {
        private const val SETTINGS_RUNTIME_KEY = "__ccSettingsRuntime"

        /**
         * document-start で window.__ccPluginSettings を用意し、ライブ更新の受け口を定義する。
         * ライブ反映（pushSettingLive → evaluateJavascript）はメインフレームにしか届かないため、
         * __ccApplyPluginSetting は自フレームへ適用したあと直下の子フレームへ message で再伝搬し、
         * 各フレームの受信側が同関数を呼ぶことでフレームツリー全体へ行き渡らせる
         * （「全 WEB スクリーンへリロード無しでライブ反映」の契約はフレーム単位で成立させる）。
         */
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
    // 直下の子フレームへ再伝搬（受信側が同関数を呼ぶので、ツリー全体へ下方に行き渡る）。
    try {
      for (var i = 0; i < window.frames.length; i++) {
        try {
          window.frames[i].postMessage({ __ccSettingApply: { plugin: plugin, key: key, value: val } }, '*');
        } catch(_){}
      }
    } catch(_){}
  };
  // 親フレームからのライブ設定変更を受けて自フレームへ適用する（直上の親からのみ受ける）。
  window.addEventListener('message', function(ev){
    var d = ev && ev.data && ev.data.__ccSettingApply;
    if (!d || typeof d.plugin !== 'string' || typeof d.key !== 'string') return;
    if (ev.source !== window.parent || ev.source === window) return;
    window.__ccApplyPluginSetting(d.plugin, d.key, d.value);
  });
})();
"""
    }
}
