package app.ccstudio

import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * 全フレーム×document-start でスクリプトを注入する土台。
 *
 * 通常の `WebView.evaluateJavascript` はメインフレームでしか走らないため、サブフレーム
 * （code-server 内の VS Code webview。claude-code の入力欄はここに居る）へ確実に・先回りで
 * リスナを仕込めない。`WebViewCompat.addDocumentStartJavaScript` はブラウザ拡張の content script
 * (`all_frames:true` + `run_at:document_start`) と等価で、登録すると以後の全ロードの全フレームに
 * ページ自身のスクリプトより先に注入される。これで「自動フォーカスより前にリスナを置く」が成立する。
 */
object ExtensionRuntime {

    /** 全フレーム document-start 注入が使える端末か（古い System WebView は非対応）。 */
    fun isDocumentStartSupported(): Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

    /**
     * 常駐スクリプトを全フレーム（全オリジン）× document-start で登録する。
     * 返り値の [ScriptHandler] を `remove()` すれば登録解除（以後のロードで効かなくなる）。
     * 非対応端末では null を返すので、呼び出し側は evaluateJavascript にフォールバックする。
     *
     * 注意: 登録は「以後のロード」に効く。初回ロードから効かせたい常駐機能は `loadUrl` の前に登録する。
     */
    fun registerDocumentStart(webView: WebView, script: String): ScriptHandler? {
        if (!isDocumentStartSupported()) return null
        // originRules=["*"] で同一・クロス・不透明オリジンを問わず全フレームに注入する。
        return WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("*"))
    }
}
