# フェーズ2: i18n + プラグイン説明刷新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** アプリ全体（ネイティブ・管理系 HTML・プラグイン説明）を日英対応にし、表示言語を「端末追従 + アプリ内設定で上書き」にする。プラグイン説明は定型フォーマットで短く書き直す。

**Architecture:** ネイティブ文字列は Android リソース（`values/`=英語, `values-ja/`=日本語）+ AppCompatDelegate の per-app language。管理系 HTML と bootstrap.js はブリッジ `CCStudio.getUiLang()` で言語を取得し、ファイル内の小さな辞書で切り替える。プラグインのメタは userscript 慣例のロケール接尾辞（`@description:ja` / `@setting:ja`）で拡張し、ネイティブ側（PanelJson）が言語に応じて解決して HTML へ渡す。

**Tech Stack:** androidx.appcompat 1.7.0（`AppCompatDelegate.setApplicationLocales` / autoStoreLocales）, Android string resources, JUnit 4

## Global Constraints

- スペック: `docs/specs/2026-07-02-public-release-refactor-design.md` フェーズ 2。
- `@description` / `@setting` のラベルは**英語が既定**、`:ja` 接尾辞が日本語。無い言語は英語へフォールバック。
- プラグイン `.js` の**動作コードは変更しない**（メタヘッダのみ変更可）。`@version` は挙動不変のため据え置き。
- 既存挙動の変更は言語表示のみ。レイアウト・遷移・通知チャンネル ID は変えない。
- 通知チャンネル ID は改名不可のため既存 ID を維持し、表示名のみリソース化（済み）を翻訳。
- 突発キャンセル通知の本文はサーバ（relay.mjs）生成のため今回対象外（タイトルのみ翻訳）。既知の制限としてスペックに追記。
- テスト: `./gradlew :app:testDebugUnitTest`。ビルド: `./gradlew :app:assembleDebug`。タスクごとにコミット。
- コミット末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: PluginMetaParser のロケール接尾辞対応

**Files:**
- Modify: `app/src/main/java/app/ccstudio/PluginMeta.kt`
- Modify: `app/src/main/java/app/ccstudio/PluginStore.kt`（PluginInfo に descriptionJa を追加・受け渡し）
- Test: `app/src/test/java/app/ccstudio/PluginMetaTest.kt`（追記）

**Interfaces:**
- Produces: `PluginMeta(name, version, description, descriptionJa, hasSettings, runAt, allFrames, settings)` / `SettingDef(key, type, default, label, labelJa: String? = null)` / `PluginInfo.descriptionJa: String?`
- 既存フィールドの意味は不変。新フィールドはデフォルト値付きで既存テストはそのままコンパイル可。

- [ ] **Step 1: 失敗するテストを追記**（PluginMetaTest に追加）

```kotlin
@Test
fun `description の ja 接尾辞を別フィールドで返す`() {
    val meta = PluginMetaParser.parse(
        """
        // ==CCStudioPlugin==
        // @name        x
        // @description English text.
        // @description:ja 日本語の説明。
        // ==/CCStudioPlugin==
        """.trimIndent()
    )
    assertEquals("English text.", meta.description)
    assertEquals("日本語の説明。", meta.descriptionJa)
}

@Test
fun `setting の ja 接尾辞はラベルだけを上書きする`() {
    val meta = PluginMetaParser.parse(
        """
        // ==CCStudioPlugin==
        // @setting     visible boolean true Show the HUD
        // @setting:ja  visible HUD を表示
        // ==/CCStudioPlugin==
        """.trimIndent()
    )
    val d = meta.settings.single()
    assertEquals("Show the HUD", d.label)
    assertEquals("HUD を表示", d.labelJa)
}

@Test
fun `ja 接尾辞が無ければ labelJa と descriptionJa は null`() {
    val meta = PluginMetaParser.parse(
        """
        // ==CCStudioPlugin==
        // @description Only English.
        // @setting     visible boolean true Show
        // ==/CCStudioPlugin==
        """.trimIndent()
    )
    assertEquals(null, meta.descriptionJa)
    assertEquals(null, meta.settings.single().labelJa)
}
```

- [ ] **Step 2: 失敗を確認** — `./gradlew :app:testDebugUnitTest --tests 'app.ccstudio.PluginMetaTest'` → コンパイルエラー
- [ ] **Step 3: 実装** — 変更点:
  - `FIELD` 正規表現を `^//\s*@([\w:-]+)\s+(.*\S)\s*$` に（`:` を許す）。
  - `@setting:ja <key> <label...>` を `jaLabels: MutableMap<String,String>` に貯め、ループ後に `settings` へ `labelJa` としてマージ。
  - `description:ja` は fields に入るので `descriptionJa = fields["description:ja"]`。
  - `SettingDef` に `val labelJa: String? = null`、`PluginMeta` に `val descriptionJa: String?` を追加。
  - `PluginStore.list()` の `PluginInfo` 構築に `descriptionJa = meta.descriptionJa` を追加（`PluginInfo` にフィールド追加、`description` の直後に）。
- [ ] **Step 4: パス確認 → 全テスト → Commit** — `feat(plugin): メタヘッダの @description:ja / @setting:ja に対応`

### Task 2: PanelJson の言語対応

**Files:**
- Modify: `app/src/main/java/app/ccstudio/PanelJson.kt`
- Test: `app/src/test/java/app/ccstudio/PanelJsonTest.kt`（追記・既定文言の英語化に伴う期待値変更）

**Interfaces:**
- Produces: `PanelJson.plugins(list, ja: Boolean)` / `settingsList(total, enabled, ja: Boolean)` / `settingsView(info, ja: Boolean, valueOf)`。`effectiveSettings` は言語非依存で不変。
- 解決規則: `ja=true` なら `descriptionJa ?: description ?: ""`・`labelJa ?: label`。`ja=false` なら英語側。

- [ ] **Step 1: テスト追記**（plugins/settingsView の ja/en、settingsList の英語文言）

```kotlin
@Test
fun `plugins は ja=true で日本語説明を優先しフォールバックする`() {
    val p = info().copy(description = "EN", descriptionJa = "JA")
    val arr = JSONArray(PanelJson.plugins(listOf(p), ja = true))
    assertEquals("JA", arr.getJSONObject(0).getString("description"))
    val p2 = info().copy(description = "EN", descriptionJa = null)
    assertEquals("EN", JSONArray(PanelJson.plugins(listOf(p2), ja = true)).getJSONObject(0).getString("description"))
}

@Test
fun `settingsList は言語で文言が切り替わる`() {
    val en = JSONArray(PanelJson.settingsList(3, 2, ja = false)).getJSONObject(0)
    assertEquals("Plugin manager", en.getString("label"))
    assertEquals("3 installed · 2 enabled", en.getString("sub"))
    val jp = JSONArray(PanelJson.settingsList(3, 2, ja = true)).getJSONObject(0)
    assertEquals("プラグイン管理", jp.getString("label"))
}

@Test
fun `settingsView は ja=true で labelJa を使う`() {
    val def = SettingDef("visible", "boolean", "true", "Show the HUD", "HUD を表示")
    val o = JSONObject(PanelJson.settingsView(info("hud.js", settings = listOf(def)), ja = true) { _, _ -> null })
    assertEquals("HUD を表示", o.getJSONArray("settings").getJSONObject(0).getString("label"))
}
```

- [ ] **Step 2: 失敗確認 → 実装** — settingsList の文言表:

| id | 項目 | 英語 (`ja=false`) | 日本語 (`ja=true`) |
|---|---|---|---|
| plugins | group | Plugins | プラグイン |
| plugins | label | Plugin manager | プラグイン管理 |
| plugins | sub | `$total installed · $enabled enabled` | `$total 個インストール · $enabled 有効` |
| notify | group | System | システム |
| notify | label | Notifications | 通知 |
| notify | sub | Stop / Notification hooks | Stop / Notification フック |
| log | group | System | システム |
| log | label | Log | ログ |
| log | sub | Show observer log | オブザーバーログを表示 |
| lang | group | System | システム |
| lang | label | Language | 言語 |
| lang | sub | Follow device / 日本語 / English | 端末に合わせる / 日本語 / English |

（`lang` エントリは Task 3 で使う設定導線。ここで一緒に追加する。icon は "🌐"。）

- [ ] **Step 3: 全テスト → Commit** — `feat(app): PanelJson を言語対応（説明・ラベル・設定一覧の日英切替）`

### Task 3: 表示言語の基盤と言語設定 UI

**Files:**
- Create: `app/src/main/java/app/ccstudio/AppLang.kt`
- Modify: `app/src/main/java/app/ccstudio/CcBridge.kt`（`getUiLang` 追加）
- Modify: `app/src/main/java/app/ccstudio/MainActivity.kt`（ja フラグの配線・言語ダイアログ・openSettingsEntry に "lang"）
- Modify: `app/src/main/AndroidManifest.xml`（autoStoreLocales サービス + localeConfig）
- Create: `app/src/main/res/xml/locales_config.xml`

**Interfaces:**
- Produces: `AppLang.isJa(context: Context): Boolean`（`context.resources.configuration.locales[0].language == "ja"`）/ `AppLang.set(choice: String)`（"system"|"ja"|"en" → `AppCompatDelegate.setApplicationLocales`）/ `AppLang.current(): String`（現在の選択）
- Bridge: `@JavascriptInterface fun getUiLang(): String`（"ja" / "en"。uiLangFn ラムダで注入）

- [ ] **Step 1: AppLang 実装**

```kotlin
package app.ccstudio

import android.content.Context
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat

/** 表示言語。既定は端末追従、アプリ内設定で ja/en に固定できる（appcompat が永続化）。 */
object AppLang {
    fun isJa(context: Context): Boolean =
        context.resources.configuration.locales[0].language == "ja"

    /** "system" | "ja" | "en" */
    fun set(choice: String) {
        AppCompatDelegate.setApplicationLocales(
            if (choice == "system") LocaleListCompat.getEmptyLocaleList()
            else LocaleListCompat.forLanguageTags(choice)
        )
    }

    fun current(): String =
        AppCompatDelegate.getApplicationLocales().toLanguageTags().ifEmpty { "system" }
}
```

- [ ] **Step 2: Manifest** — `<application>` 内に追加（appcompat の自動永続化）と `android:localeConfig="@xml/locales_config"`:

```xml
<service
    android:name="androidx.appcompat.app.AppLocalesMetadataHolderService"
    android:enabled="false"
    android:exported="false">
    <meta-data android:name="autoStoreLocales" android:value="true" />
</service>
```

`res/xml/locales_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<locale-config xmlns:android="http://schemas.android.com/apk/res/android">
    <locale android:name="en" />
    <locale android:name="ja" />
</locale-config>
```

- [ ] **Step 3: ブリッジと配線** — CcBridge に `uiLangFn: () -> String` コンストラクタ引数 + `@JavascriptInterface fun getUiLang(): String = uiLangFn()`。MainActivity の buildBridge に `uiLangFn = { if (AppLang.isJa(this)) "ja" else "en" }`。PanelJson 呼び出し 3 箇所に `ja = AppLang.isJa(this)` を渡す。
- [ ] **Step 4: 言語設定 UI** — `openSettingsEntry` に `"lang"` 分岐を追加し、ネイティブ AlertDialog（singleChoiceItems: 端末に合わせる / 日本語 / English、現在値 `AppLang.current()` を選択状態に）。選択で `AppLang.set(...)` → appcompat が Activity を再生成し、以後の描画が新言語になる。ダイアログ文言もリソース化（Task 4 の strings に含める）。
- [ ] **Step 5: ビルド確認 → Commit** — `feat(app): 表示言語の端末追従 + アプリ内設定（日本語/English）を追加`

### Task 4: ネイティブ文字列のリソース化（英語既定 + values-ja）

**Files:**
- Modify: `app/src/main/res/values/strings.xml`（**英語化** + 新規キー）
- Create: `app/src/main/res/values-ja/strings.xml`（日本語）
- Modify: `MainActivity.kt` / `Downloads.kt`（toast を getString に）/ `KeepAliveText.kt`（ja 引数）/ `KeepAliveService.kt`（statusLine 呼び出しに isJa）
- Test: `app/src/test/java/app/ccstudio/KeepAliveTextTest.kt`（ja/en 両方に更新）

**Interfaces:**
- `KeepAliveText.statusLine(screens, busy, disconnected, ja: Boolean)` — 純関数のまま（リソース非依存で JVM テスト可能に保つ）。EN: `"$screens screens running" + " · busy $busy" + " · disconnected $disconnected"` / JA: 従来文言。
- `DownloadController` は `activity.getString(...)` を使う（コンストラクタ変更なし）。

- [ ] **Step 1: 文字列表** — values/strings.xml（英語・既定）と values-ja/strings.xml（日本語）:

| key | en | ja |
|---|---|---|
| app_name | CC Studio | （en と同じ・ja 側は省略） |
| keepalive_channel_name | CC Studio connection | CC Studio 接続維持 |
| keepalive_notification_title | CC Studio | （省略） |
| task_channel_name | Task alerts | タスク通知 |
| task_done_title | ✅ Response finished | ✅ 応答が完了しました |
| task_permission_title | 🔔 Waiting for permission | 🔔 許可待ち |
| task_cancel_title | ⚠️ Tool interrupted | ⚠️ ツールが中断されました |
| toast_plugin_added | Plugin added: %1$s | プラグインを追加しました: %1$s |
| toast_plugin_load_failed | Failed to load the JS file | JSの読み込みに失敗しました |
| toast_file_chooser_failed | Could not open the file picker | ファイル選択を開けませんでした |
| toast_external_link_failed | Could not open the external link | 外部リンクを開けませんでした |
| toast_download_started | Download started | ダウンロードを開始しました |
| toast_download_failed | Download failed | ダウンロードに失敗しました |
| toast_saved | Saved: %1$s | 保存しました: %1$s |
| toast_save_failed | Failed to save | 保存に失敗しました |
| toast_log_save_failed | Failed to save the log | ログの保存に失敗しました |
| toast_mdpv | MDPV: sending preview toggle key | MDPV: プレビュー化キー送出 |
| lang_dialog_title | Display language | 表示言語 |
| lang_follow_device | Follow device | 端末に合わせる |

（`keepalive_screen_count` は未使用と判明したら削除。使用箇所を `git grep keepalive_screen_count` で確認してから。）

- [ ] **Step 2: KeepAliveTextTest を ja/en 両対応に更新 → 失敗確認 → 実装 → パス**
- [ ] **Step 3: 各 toast 呼び出しを getString に置換。ビルド + 全テスト → Commit** — `feat(app): ネイティブ文字列をリソース化し英語既定 + 日本語リソースに分離`

### Task 5: 管理系 HTML / bootstrap.js の日英対応

**Files:**
- Modify: `app/src/main/assets/switcher.html` / `plugins.html` / `notify.html` / `log.html` / `plugin-settings.html` / `bootstrap.js`

**Interfaces:**
- 各ファイル冒頭のスクリプトで `var JA = (function(){ try { return (window.CCStudio && CCStudio.getUiLang && CCStudio.getUiLang()) === 'ja'; } catch(_) { return true; } })();` を定義し、`var T = JA ? {日本語辞書} : {英語辞書};` で全文言を引く。
- 静的 HTML 内のテキスト（タブ名・見出し・ボタン）は DOMContentLoaded で `T` から流し込む（既存の描画関数がある画面はその中で）。
- 対象文言（抜粋・全対訳はソース内辞書が正）: スクリーン/Screens, 設定/Settings, 削除/Delete, 接続切れ/disconnected, リロードして起動しますか？/Reload and open?, そのまま開く/Open as is, リロード/Reload, ↻ 更新/↻ Refresh, ⬇ ダウンロード/⬇ Download, まだログがありません…/No log entries yet…, 通知設定/Notifications, 応答完了 (Stop)/Response finished (Stop), 許可待ち (Notification)/Waiting for permission (Notification), 種類別/By type, 注意書き 2 種, プラグイン設定 note, このプラグインに設定項目はありません。/This plugin has no settings., 削除確認 confirm 文, ⚙/✕ の title, bootstrap.js の進捗ラベル（ダウンロード開始/中/保存しました/失敗）。
- `plugins.html` のカード説明はネイティブ（PanelJson）が言語解決済みの `description` を返すので変更不要。

- [ ] **Step 1: 5 HTML + bootstrap.js に辞書を実装**（1 ファイルずつ。文言の取りこぼしは `grep -n '[ぁ-ん]'` で確認）
- [ ] **Step 2: ビルド + 全テスト → Commit** — `feat(app): 管理系 HTML と bootstrap.js のラベルを日英対応`

### Task 6: プラグイン説明の全面書き直し（8 本・定型・日英）

**Files:**
- Modify: `plugins/*.js` 8 本のメタヘッダのみ（`@description` 英語 + `@description:ja` 日本語 + 必要な `@setting:ja`）

**書式:** 不具合解消型「素の code-server では〜。このプラグインは〜で解消する。」/ 機能追加型「元々〜する手段がない。このプラグインが〜を実現する。」1〜2 文・カードで 3 行以内目安。

| プラグイン | @description (en) | @description:ja |
|---|---|---|
| keyboard-suppress | Stock code-server pops the soft keyboard every time the chat input auto-focuses. This plugin suppresses that and shows the keyboard only when you tap the input yourself. | 素の code-server ではチャット入力欄への自動フォーカスのたびにソフトキーボードが勝手に開く。このプラグインはそれを抑え、枠をタップした時だけキーボードを出す。 |
| selectable-text | Stock code-server won't let you select or copy chat replies or preview text on mobile. This plugin adds long-press selection with a copy button and adjustable handles. | 素の code-server ではチャットの返信やプレビューの文字をモバイルで選択・コピーできない。このプラグインは長押しでコピーボタンを出し、範囲を調整してコピーできるようにする。 |
| region-grab | Stock code-server has no way to bulk-copy text from read-only areas on mobile. This plugin adds a □ button: trace a rectangle with your finger and everything inside is copied at once. | 素の code-server では編集できない画面の文字をまとめてコピーする手段がない。このプラグインは左端の □ ボタンから指で範囲を囲うと、中の文字を一括コピーできるようにする。 |
| session-list-readable | Stock code-server truncates session titles on phone-width screens. This plugin shrinks the font and wraps titles to two lines so they stay readable. | 素の code-server ではセッション一覧のタイトルがスマホ幅で途切れて読めない。このプラグインはフォント縮小と最大 2 行の折返しで読めるようにする。 |
| chat-link-open | Stock code-server opens file links in chat replies to a blank page or "Not found". This plugin intercepts the tap and opens the file in an editor tab (.md opens as preview). | 素の code-server ではチャット内のファイルリンクを開くと真っ白/Not found になる。このプラグインはタップを横取りしてエディタのタブで開く（.md はプレビュー表示）。 |
| state-observer | There is no built-in way to see whether each screen is busy or disconnected. This plugin detects both and shows them in the screen list, the persistent notification, and the ︙ button. It only observes and never acts. | 元々は各スクリーンが処理中か・接続切れかを知る手段がない。このプラグインが検知してスクリーン一覧・常駐通知・︙ ボタンに表示する。監視のみで操作はしない。 |
| focus-hud | Diagnostic tool. Shows which element in which frame received focus or taps, as a timeline overlay at the top of the screen (for sharing screenshots). | 不具合調査用の診断ツール。どの要素・どのフレームにフォーカスやタップが入ったかを画面上部に時系列表示する（スクショで状況共有する用）。 |
| select-diag | Diagnostic tool. On long-press it shows a red test button and markers and records what fired; copy the log with the DIAG button. Delete it when the investigation is done. | 不具合調査用の診断ツール。長押しで赤いテストボタンとマーカーを出して記録し、DIAG ボタンで内容をコピーできる。調査が終わったら削除してよい。 |

`@setting` ラベル: focus-hud → `@setting visible boolean true Show the HUD` + `@setting:ja visible HUD を表示`。state-observer → `@setting diag boolean true Send diagnostics to focus-hud` + `@setting:ja diag 診断ログを focus-hud に出す`。

- [ ] **Step 1: 8 ファイルのヘッダを書き換え**（動作コードは触らない。`@name/@version/@run-at/@all-frames` は不変）
- [ ] **Step 2: ビルド + 全テスト → Commit** — `feat(plugins): 説明を定型フォーマットで日英化し簡潔に書き直し`

### Task 7: 最終検証

- [ ] **Step 1:** `./gradlew :app:testDebugUnitTest :app:assembleDebug` → 全 PASS / BUILD SUCCESSFUL
- [ ] **Step 2:** 文言の取りこぼしスキャン — `grep -rn '[ぁ-んァ-ヶ]' app/src/main/java/ | grep '"'` が toast/ラベルを含まないこと（コメントは可）。assets 側も同様に「辞書外の生文言」が無いこと。
- [ ] **Step 3:** スペックに既知の制限（cancel 通知本文はサーバ生成で日本語のまま）と「最終スキャンは追跡ファイルのみ対象（`git grep`）。実行時データ `server/notify-relay/data/` は gitignore 済み」を追記してコミット。
- [ ] **Step 4:** 差分通読（`git diff <phase1末> -- app plugins`）→ 完了報告
