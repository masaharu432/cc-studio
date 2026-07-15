package app.ccstudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NavModelTest {
    @Test
    fun `PluginSettings は閉じて下の画面へ`() {
        val m = NavModel()
        m.push(Nav.Switcher("settings")); m.push(Nav.PluginsScreen); m.push(Nav.PluginSettings)
        assertEquals(PopAction.ClosePluginSettings, m.pop())
        assertEquals(PopAction.ShowSettingsSwitcher, m.pop()) // 続けて戻ると PluginsScreen → 設定側
    }

    @Test
    fun `Notify と Log と Server は設定側 switcher へ戻る`() {
        val m = NavModel(); m.push(Nav.Notify)
        assertEquals(PopAction.CloseNotifyToSettings, m.pop())
        val m2 = NavModel(); m2.push(Nav.Log)
        assertEquals(PopAction.CloseLogToSettings, m2.pop())
        val m3 = NavModel(); m3.push(Nav.Server)
        assertEquals(PopAction.CloseServerToSettings, m3.pop())
    }

    @Test
    fun `Switcher 設定側からのバックはスクリーン側へ（スタックに残る）`() {
        val m = NavModel(); m.push(Nav.Switcher("settings"))
        assertEquals(PopAction.SwitchToScreensTab, m.pop())
        assertEquals("screens", m.currentSwitcherTab())
        assertEquals(PopAction.CloseSwitcher, m.pop()) // 次のバックで閉じる
    }

    @Test
    fun `Switcher スクリーン側からのバックは閉じる`() {
        val m = NavModel(); m.push(Nav.Switcher("screens"))
        assertEquals(PopAction.CloseSwitcher, m.pop())
        assertTrue(m.stack.isEmpty())
    }

    @Test
    fun `空スタックは Fallback`() {
        assertEquals(PopAction.Fallback, NavModel().pop())
    }

    @Test
    fun `setSwitcherTab は最後の Switcher を更新し無ければ push`() {
        val m = NavModel()
        m.setSwitcherTab("settings")
        assertEquals("settings", m.currentSwitcherTab())
        m.setSwitcherTab("screens")
        assertEquals("screens", m.currentSwitcherTab())
        assertEquals(1, m.stack.size)
    }

    @Test
    fun `ensureSwitcher は既にあれば何もしない`() {
        val m = NavModel(); m.push(Nav.Switcher("screens")); m.push(Nav.Notify)
        m.ensureSwitcher("settings")
        assertEquals(2, m.stack.size)
    }

    @Test
    fun `ensureSwitcher は無ければ push する`() {
        val m = NavModel()
        m.ensureSwitcher("settings")
        assertEquals("settings", m.currentSwitcherTab())
    }

    @Test
    fun `noteSwitcherTab は Switcher が無ければ何もしない`() {
        val m = NavModel()
        m.noteSwitcherTab("settings")
        assertTrue(m.stack.isEmpty())
        m.push(Nav.Switcher("screens"))
        m.noteSwitcherTab("settings")
        assertEquals("settings", m.currentSwitcherTab())
    }

    @Test
    fun `clear で空になる`() {
        val m = NavModel(); m.push(Nav.Notify); m.clear()
        assertTrue(m.stack.isEmpty())
    }
}
