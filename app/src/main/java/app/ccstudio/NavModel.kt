package app.ccstudio

/**
 * OS バック用の明示的ナビスタックの純粋モデル。オーバーレイ/設定導線を開くたびに push し、
 * バック（および各画面の ‹ ボタン＝ navBack）で pop する。表示の single source of truth は
 * このスタックで、open/close は必ずスタック操作経由にする。
 * 表示副作用は持たない — pop() が返す PopAction を呼び出し側（MainActivity）が実行する。
 */
sealed class Nav {
    data class Switcher(var tab: String) : Nav()   // tab: "screens" | "settings"
    object PluginsScreen : Nav()                   // 設定から開いた Plugins システムスクリーン
    object Notify : Nav()
    object Log : Nav()
    object PluginSettings : Nav()
}

/**
 * pop の結果として呼び出し側が実行すべき表示副作用。spec の遷移表:
 * PluginSettings → plugins / Notify・Log → switcher(設定側) / PluginsScreen → switcher(設定側)
 * / Switcher(設定側) → スクリーン側 / Switcher(スクリーン側) → 閉じる
 * / 空 → WebView 履歴 → moveTaskToBack。
 */
sealed class PopAction {
    object ClosePluginSettings : PopAction()   // 下の PluginsScreen（表示中）に戻る
    object CloseNotifyToSettings : PopAction()
    object CloseLogToSettings : PopAction()
    object ShowSettingsSwitcher : PopAction()
    object SwitchToScreensTab : PopAction()    // 設定側→スクリーン側（Switcher はスタックに残る）
    object CloseSwitcher : PopAction()
    object Fallback : PopAction()              // 空スタック（WebView 履歴 or 背面へは呼び出し側）
}

class NavModel {
    val stack = mutableListOf<Nav>()

    fun clear() = stack.clear()

    fun push(nav: Nav) { stack.add(nav) }

    /** 最後の Switcher の tab（無ければ null）。 */
    fun currentSwitcherTab(): String? = stack.filterIsInstance<Nav.Switcher>().lastOrNull()?.tab

    /** 最後の Switcher の tab を更新（無ければ push）。 */
    fun setSwitcherTab(tab: String) {
        val entry = stack.filterIsInstance<Nav.Switcher>().lastOrNull()
        if (entry != null) entry.tab = tab else stack.add(Nav.Switcher(tab))
    }

    /** 最後の Switcher の tab を更新（無ければ何もしない — JS からのタブ報告用）。 */
    fun noteSwitcherTab(tab: String) {
        stack.filterIsInstance<Nav.Switcher>().lastOrNull()?.tab = tab
    }

    /** Switcher が無ければ push（設定導線の起点の防御）。 */
    fun ensureSwitcher(tab: String) {
        if (stack.none { it is Nav.Switcher }) stack.add(Nav.Switcher(tab))
    }

    fun pop(): PopAction = when (val top = stack.removeLastOrNull()) {
        is Nav.PluginSettings -> PopAction.ClosePluginSettings
        is Nav.Notify -> PopAction.CloseNotifyToSettings
        is Nav.Log -> PopAction.CloseLogToSettings
        is Nav.PluginsScreen -> PopAction.ShowSettingsSwitcher
        is Nav.Switcher ->
            if (top.tab == "settings") {
                // タブの「ホーム」はスクリーン側。設定側からのバックはまずスクリーン側へ。
                top.tab = "screens"
                stack.add(top)
                PopAction.SwitchToScreensTab
            } else {
                PopAction.CloseSwitcher
            }
        null -> PopAction.Fallback
    }
}
