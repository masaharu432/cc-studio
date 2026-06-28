# CC Studio JS注入プラグイン 実装プラン (v0.2)

> **エージェント作業者へ:** 必須サブスキル: superpowers:subagent-driven-development（推奨）または superpowers:executing-plans を使ってタスク単位で実装すること。各ステップは進捗管理用にチェックボックス（`- [ ]`）記法を使う。

**ゴール:** アプリ同梱の bootstrap.js が左端に `︙` メニューを描き、そこからユーザーが選んだJSを「プラグイン」として WebView に注入できるようにする。

**アーキテクチャ:** WebView の `onPageFinished` で bootstrap.js を必ず注入（︙メニュー描画）。`window.CCStudio` JavaScriptInterface 経由で JS から Android を呼び、SAF でJSを選んで `filesDir/plugins/active.js` にコピー、手動/自動で `evaluateJavascript` 注入する。

**技術スタック:** Kotlin、Android WebView、`@JavascriptInterface`、Storage Access Framework（registerForActivityResult）、SharedPreferences。ビルドは cc-studio リポ内で `./gradlew assembleDebug`（JDK 17 / Android SDK は導入済み）。

## 全体制約（Global Constraints）

- 作業ディレクトリは独立リポ `<repo-root>`。ビルド・コミットはここで行う。
- パッケージは `app.ccstudio`。表示名 CC Studio。
- JavaScriptInterface の注入名は `window.CCStudio`。公開メソッドは `pickPlugin()` / `injectNow()` / `setAuto(enabled)` / `getAuto()`。
- プラグインJSの保存先は `filesDir/plugins/active.js`（取り込みコピー方式。元ファイル参照はしない）。
- 自動注入フラグは SharedPreferences（ファイル名 `ccstudio_prefs`、キー `auto_inject`、既定 false）。
- `︙` ボタンの見た目・位置は cc-web-helper の bridge buttons を踏襲: `position:fixed;z-index:2147483647;left:0;bottom:22%`、ボタン 44×44px、`border-radius:0 10px 10px 0`、`background:#1e88e5`、白文字、`box-shadow:0 2px 6px rgba(0,0,0,.4)`。
- 各ビルド検証コマンドの前提: `export ANDROID_HOME="$HOME/Android/sdk"`、`local.properties` に `sdk.dir=$ANDROID_HOME`（既存）。
- v0.2 スコープのみ: bootstrap注入 / SAFインストール / filesDir永続 / 手動+自動注入 / エラートースト。JSのアプリ内編集・複数プラグイン併用・タブ切替は入れない。

---

### Task 1: PluginStore（取り込み・読み出し・フラグ）

プラグインJSの保存／読み出しと自動注入フラグを一手に持つ小さなクラス。UIにもWebViewにも依存しない。

**ファイル:**
- 作成: `app/src/main/java/net/<tailnet>/ccstudio/PluginStore.kt`

**インターフェース:**
- 提供:
  - `class PluginStore(context: Context)`
  - `fun installFromUri(uri: Uri): Boolean` — uri のJSを `filesDir/plugins/active.js` にコピー。成功で true。
  - `fun activeScript(): String?` — active.js のテキスト。無ければ null。
  - `var autoInject: Boolean` — SharedPreferences `ccstudio_prefs` / キー `auto_inject`。

- [ ] **ステップ1: `PluginStore.kt` を書く**

```kotlin
package app.ccstudio

import android.content.Context
import android.net.Uri
import java.io.File

class PluginStore(private val context: Context) {

    private val prefs = context.getSharedPreferences("ccstudio_prefs", Context.MODE_PRIVATE)

    private fun pluginsDir(): File =
        File(context.filesDir, "plugins").apply { if (!exists()) mkdirs() }

    private fun activeFile(): File = File(pluginsDir(), "active.js")

    /** SAFで選ばれたJSを filesDir/plugins/active.js にコピーする。成功で true。 */
    fun installFromUri(uri: Uri): Boolean = try {
        context.contentResolver.openInputStream(uri)?.use { input ->
            activeFile().outputStream().use { output -> input.copyTo(output) }
        } != null
    } catch (e: Exception) {
        false
    }

    /** インストール済みプラグインのテキスト。無ければ null。 */
    fun activeScript(): String? {
        val f = activeFile()
        return if (f.exists() && f.length() > 0) f.readText() else null
    }

    var autoInject: Boolean
        get() = prefs.getBoolean("auto_inject", false)
        set(value) = prefs.edit().putBoolean("auto_inject", value).apply()
}
```

- [ ] **ステップ2: ビルドでコンパイル確認**

```bash
cd <repo-root>
export ANDROID_HOME="$HOME/Android/sdk"
./gradlew assembleDebug 2>&1 | tail -4
```

期待: `BUILD SUCCESSFUL`。

- [ ] **ステップ3: コミット**

```bash
cd <repo-root>
git add app/src/main/java/net/<tailnet>/ccstudio/PluginStore.kt
git commit -m "feat: PluginStore — install JS to filesDir, read active, auto-inject flag"
```

---

### Task 2: bootstrap.js（︙メニューを描くアプリ同梱JS）

左端に `︙` を描き、タップで簡易メニューを開き、各項目で `window.CCStudio.*` を呼ぶ。冪等（既にあれば作らない）。

**ファイル:**
- 作成: `app/src/main/assets/bootstrap.js`

**インターフェース:**
- 消費（Android側が後で提供）: `window.CCStudio.pickPlugin()` / `injectNow()` / `setAuto(boolean)` / `getAuto()`。
- 提供: グローバルに副作用としてDOMへ `#ccstudio-menu-btn` を1つ追加する。返り値は使わない。

- [ ] **ステップ1: `assets/bootstrap.js` を書く**

```javascript
// CC Studio bootstrap — ︙ フローティングメニューを左端に描く。
// 位置・見た目は cc-web-helper の bridge buttons を踏襲。冪等（多重注入されても1つだけ）。
(function () {
  var BTN_ID = 'ccstudio-menu-btn';
  var PANEL_ID = 'ccstudio-menu-panel';
  if (document.getElementById(BTN_ID)) return;

  function mkBtn(label, bg) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:18px sans-serif;width:44px;height:44px;border:0;border-radius:0 10px 10px 0;' +
      'background:' + (bg || '#1e88e5') + ';color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.4);';
    return b;
  }

  var btn = mkBtn('⋮'); // ︙
  btn.id = BTN_ID;
  btn.style.position = 'fixed';
  btn.style.zIndex = '2147483647';
  btn.style.left = '0';
  btn.style.bottom = '22%';

  var panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.cssText =
    'position:fixed;z-index:2147483647;left:46px;bottom:22%;display:none;' +
    'flex-direction:column;gap:6px;background:#222;padding:8px;border-radius:8px;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.5);font:14px sans-serif;';

  function item(label, handler) {
    var el = document.createElement('div');
    el.textContent = label;
    el.style.cssText = 'color:#fff;padding:8px 12px;white-space:nowrap;';
    el.addEventListener('click', function (e) {
      e.preventDefault();
      panel.style.display = 'none';
      handler();
    });
    return el;
  }

  function autoLabel() {
    var on = false;
    try { on = !!window.CCStudio.getAuto(); } catch (_) {}
    return '自動注入: ' + (on ? 'ON' : 'OFF'); // 自動注入: ON/OFF
  }

  var pick = item('JSプラグインを選ぶ', function () { // JSプラグインを選ぶ
    try { window.CCStudio.pickPlugin(); } catch (_) {}
  });
  var inject = item('今すぐ注入', function () { // 今すぐ注入
    try { window.CCStudio.injectNow(); } catch (_) {}
  });
  var auto = item(autoLabel(), function () {
    var on = false;
    try { on = !!window.CCStudio.getAuto(); window.CCStudio.setAuto(!on); } catch (_) {}
    auto.textContent = autoLabel();
  });

  panel.appendChild(pick);
  panel.appendChild(inject);
  panel.appendChild(auto);

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    auto.textContent = autoLabel();
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });

  document.body.appendChild(btn);
  document.body.appendChild(panel);
})();
```

- [ ] **ステップ2: ビルドで assets が取り込まれるか確認**

```bash
cd <repo-root>
export ANDROID_HOME="$HOME/Android/sdk"
./gradlew assembleDebug 2>&1 | tail -4
# APK内に assets/bootstrap.js が入ったか確認
"$ANDROID_HOME/build-tools/34.0.0/aapt" list app/build/outputs/apk/debug/app-debug.apk | grep bootstrap.js
```

期待: `BUILD SUCCESSFUL` と、`assets/bootstrap.js` の行が表示される。

- [ ] **ステップ3: コミット**

```bash
cd <repo-root>
git add app/src/main/assets/bootstrap.js
git commit -m "feat: bootstrap.js — floating ︙ menu mirroring cc-web-helper bridge"
```

---

### Task 3: CcBridge（@JavascriptInterface）

JSから呼ばれるブリッジ。WebView/Toast/SAFは MainActivity が持つので、コールバックのラムダで委譲する。

**ファイル:**
- 作成: `app/src/main/java/net/<tailnet>/ccstudio/CcBridge.kt`

**インターフェース:**
- 消費: なし（コンストラクタで委譲ラムダを受ける）。
- 提供:
  - `class CcBridge(onPick: () -> Unit, onInject: () -> Unit, getAuto: () -> Boolean, setAuto: (Boolean) -> Unit)`
  - `@JavascriptInterface fun pickPlugin()` → onPick
  - `@JavascriptInterface fun injectNow()` → onInject
  - `@JavascriptInterface fun getAuto(): Boolean` → getAuto
  - `@JavascriptInterface fun setAuto(enabled: Boolean)` → setAuto

- [ ] **ステップ1: `CcBridge.kt` を書く**

```kotlin
package app.ccstudio

import android.webkit.JavascriptInterface

/**
 * WebView の JS から window.CCStudio.* として呼ばれる橋。
 * 実体（WebView操作・Toast・SAF起動）は MainActivity が持つのでラムダで委譲する。
 * これらは JS スレッドから呼ばれるため、委譲先で runOnUiThread すること。
 */
class CcBridge(
    private val onPick: () -> Unit,
    private val onInject: () -> Unit,
    private val getAutoFn: () -> Boolean,
    private val setAutoFn: (Boolean) -> Unit
) {
    @JavascriptInterface
    fun pickPlugin() = onPick()

    @JavascriptInterface
    fun injectNow() = onInject()

    @JavascriptInterface
    fun getAuto(): Boolean = getAutoFn()

    @JavascriptInterface
    fun setAuto(enabled: Boolean) = setAutoFn(enabled)
}
```

- [ ] **ステップ2: ビルドでコンパイル確認**

```bash
cd <repo-root>
export ANDROID_HOME="$HOME/Android/sdk"
./gradlew assembleDebug 2>&1 | tail -4
```

期待: `BUILD SUCCESSFUL`。

- [ ] **ステップ3: コミット**

```bash
cd <repo-root>
git add app/src/main/java/net/<tailnet>/ccstudio/CcBridge.kt
git commit -m "feat: CcBridge — @JavascriptInterface delegating to MainActivity"
```

---

### Task 4: MainActivity 配線（bridge登録・SAF・注入）

PluginStore・CcBridge・bootstrap.js を WebView に繋ぐ。SAFランチャー、assets読み出し、注入ヘルパを足す。

**ファイル:**
- 変更: `app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt`

**インターフェース:**
- 消費: `PluginStore`（Task 1）、`CcBridge`（Task 3）、`assets/bootstrap.js`（Task 2）。

- [ ] **ステップ1: import とフィールドを追加**

`MainActivity.kt` の import 群（13行目 `import androidx.core.content.ContextCompat` の下）に追記:

```kotlin
import android.net.Uri
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
```

`private lateinit var webView: WebView` の下にフィールド追加:

```kotlin
    private lateinit var store: PluginStore

    private val pickJs = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri == null) return@registerForActivityResult
        val ok = store.installFromUri(uri)
        Toast.makeText(
            this,
            if (ok) "プラグインをインストールしました" else "JSの読み込みに失敗しました",
            Toast.LENGTH_SHORT
        ).show()
    }
```

- [ ] **ステップ2: onCreate に store 初期化・bridge登録・WebViewClient差し替えを行う**

`onCreate` 内、`webView = WebView(this).apply { ... }` ブロックを次の形に置き換える（`store` 初期化を前に、`webViewClient` を匿名クラスに、bridge登録を後に）:

```kotlin
        store = PluginStore(this)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String?) {
                    injectAsset("bootstrap.js")              // ︙メニューを必ず描く
                    if (store.autoInject) injectActive()      // 自動注入ONなら active も
                }
            }
        }
        webView.addJavascriptInterface(
            CcBridge(
                onPick = { runOnUiThread { pickJs.launch(arrayOf("application/javascript", "text/*", "*/*")) } },
                onInject = { runOnUiThread { injectActive() } },
                getAutoFn = { store.autoInject },
                setAutoFn = { store.autoInject = it }
            ),
            "CCStudio"
        )
        setContentView(webView)
        webView.loadUrl(TARGET_URL)
```

- [ ] **ステップ3: 注入ヘルパ2つを追加**

`requestNotificationPermissionIfNeeded()` の下に追加:

```kotlin
    /** assets/<name> を読んで WebView に注入する。 */
    private fun injectAsset(name: String) {
        val js = try {
            assets.open(name).bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            null
        } ?: return
        webView.evaluateJavascript(js, null)
    }

    /** インストール済みプラグインを注入する。未インストールはトースト。 */
    private fun injectActive() {
        val js = store.activeScript()
        if (js == null) {
            Toast.makeText(this, "先にJSプラグインを選んでください", Toast.LENGTH_SHORT).show()
            return
        }
        webView.evaluateJavascript(js, null)
    }
```

- [ ] **ステップ4: ビルドでコンパイル確認**

```bash
cd <repo-root>
export ANDROID_HOME="$HOME/Android/sdk"
./gradlew assembleDebug 2>&1 | tail -6
ls -la app/build/outputs/apk/debug/app-debug.apk
```

期待: `BUILD SUCCESSFUL`。APK が生成される。

- [ ] **ステップ5: コミット**

```bash
cd <repo-root>
git add app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt
git commit -m "feat: wire bootstrap/CcBridge/PluginStore into WebView (SAF + inject)"
```

---

### Task 5: 実機検証（go / no-go）

実機での手動検証。コードは無し。成果物は合否の記録。

**ファイル:**
- 変更: `README.md`（「検証結果」セクションを追記）

- [ ] **ステップ1: APK を実機にインストール**

スマホから共有フォルダの `cc-studio/app/build/outputs/apk/debug/app-debug.apk` をダウンロード→OS自動インストール。または:

```bash
export ANDROID_HOME="$HOME/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
adb install -r <repo-root>/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **ステップ2: 各観点を検証**

順に確認:
1. **︙ 出現** — cc-web ロード後、左端・下から22%に青い `︙` が出る。
2. **メニュー** — `︙`タップで [JSプラグインを選ぶ / 今すぐ注入 / 自動注入: OFF] が出る。
3. **インストール** — [JSプラグインを選ぶ]→SAFでDownload内のJSを選ぶ→「インストールしました」トースト。
4. **手動注入** — [今すぐ注入]で、そのJSの効果が出る（例: 簡単な `document.title = 'INJECTED'` や `alert` で確認）。
5. **自動注入** — [自動注入: OFF]をタップしてON→リロード/プロジェクト切替→選んだJSが自動で効く。
6. **永続** — アプリを完全終了→再起動→[今すぐ注入]で前回のJSが残っている。

- [ ] **ステップ3: 結果を README に記録してコミット**

`README.md` に `## v0.2 検証結果（YYYY-MM-DD）` を追記し、6観点の合否とフォロー（メニュー位置の微調整要否など）を記す。

```bash
cd <repo-root>
git add README.md
git commit -m "docs: record v0.2 on-device verification results"
```

---

## 実装者向けメモ

- `local.properties`（`sdk.dir=$HOME/Android/sdk`）は gitignore 済み。無ければ `echo "sdk.dir=$HOME/Android/sdk" > local.properties`。
- 検証用の最小プラグインJS例（Downloadに置いて選ぶ用）: `document.title = 'INJECTED ' + Date.now();` — タイトル変化で注入成功が分かる。
- JavaScriptInterface のメソッドは JS スレッドで呼ばれる。WebView 操作・Toast・SAF起動は必ず `runOnUiThread` 経由（本プランの配線はそうなっている）。
- bootstrap.js は onPageFinished で毎回注入されるが、冒頭の `if (document.getElementById(BTN_ID)) return;` で二重描画を防ぐ。
