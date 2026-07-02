package app.ccstudio

import android.content.Context
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat

/**
 * 表示言語。既定は端末追従で、アプリ内設定（switcher → 設定 → 言語）から ja/en に固定できる。
 * 固定は AppCompatDelegate の per-app language に乗せる（Manifest の autoStoreLocales で永続化、
 * Android 13+ は OS のアプリ別言語設定にも露出する）。
 */
object AppLang {
    /** 現在の解決済みロケールが日本語か。Activity 再生成後の resources に反映されている値を見る。 */
    fun isJa(context: Context): Boolean =
        context.resources.configuration.locales[0].language == "ja"

    /** choice: "system" | "ja" | "en" */
    fun set(choice: String) {
        AppCompatDelegate.setApplicationLocales(
            if (choice == "system") LocaleListCompat.getEmptyLocaleList()
            else LocaleListCompat.forLanguageTags(choice)
        )
    }

    /** 現在の選択（"system" | "ja" | "en" 等の language tag）。 */
    fun current(): String =
        AppCompatDelegate.getApplicationLocales().toLanguageTags().ifEmpty { "system" }
}
