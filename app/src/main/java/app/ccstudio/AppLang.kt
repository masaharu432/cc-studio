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
    /**
     * 現在の表示言語が日本語か。
     * アプリ内で明示選択があればそれを優先する（Service など AppCompat が resources を
     * 上書きしないコンテキスト（API<33）でも正しく判定できるように）。未選択なら
     * コンテキストの解決済みロケール（=端末追従）を見る。
     */
    fun isJa(context: Context): Boolean {
        val app = AppCompatDelegate.getApplicationLocales()
        if (!app.isEmpty) return app[0]?.language == "ja"
        return context.resources.configuration.locales[0].language == "ja"
    }

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
