# cc-studio Android ラッパーアプリ 実装プラン

> 注: 当初 `vc-studio` の名で着手し、実機検証後に `cc-studio` へ改名。本文中の "vc-studio" 表記は旧名。

> **エージェント作業者へ:** 必須サブスキル: superpowers:subagent-driven-development（推奨）または superpowers:executing-plans を使ってタスク単位で実装すること。各ステップは進捗管理用にチェックボックス（`- [ ]`）記法を使う。

**ゴール:** cc-web を全画面 WebView で開き、Foreground Service で裏に回っても接続を維持する薄い Android アプリ。

**アーキテクチャ:** Single-Activity 構成。`MainActivity` が cc-web の URL を指す全画面 `WebView` を1枚持ち、`KeepAliveService`（常駐通知の存在自体が OS への「プロセスを生かせ」シグナルになる Foreground Service）を起動する。アプリ内 Tailscale は持たない — 端末の公式 Tailscale VPN が WebView の通信を自動的に tailnet に乗せる。

**技術スタック:** Kotlin、Android Gradle Plugin (AGP) 8.x、Gradle wrapper、JDK 17、Android SDK (compileSdk 34)。ビルドはすべて WSL 内で `./gradlew` により行う。

## 全体制約（Global Constraints）

- アプリのコードは全て `cc-web/vc-studio/` 配下に自己完結させる — `cc-web-keepalive` / `cc-web-helper` とソースもビルドも共有しない。`git subtree split --prefix=vc-studio` で切り出せること。
- ビルドは WSL 内で `./gradlew` を使う（Android Studio に依存しない）。JDK 17。
- `applicationId` = `net.<tailnet>.vcstudio`、アプリ表示名 = `VC Studio`。
- 接続先 URL（v0.1・ハードコード）: `https://<tailnet-host>/`。
- minSdk 26、compileSdk 34、targetSdk 34。
- v0.1 スコープのみ: WebView 表示、Foreground Service による接続維持、起動時オートオープン、戻るボタンの履歴。プロジェクト選択UI / タスク完了通知 / URL設定画面は**入れない**。

---

### Task 1: ツールチェーンのブートストラップ（WSL に JDK 17 + Android SDK）

ビルド用ツールチェーンを入れる。まだアプリ固有のものは無い。このタスクの成果物は「`sdkmanager` と JDK が存在し PATH に通っている」こと。

**ファイル:**
- 作成: `cc-web/vc-studio/README.md`（ツールチェーン + ビルド手順）

- [ ] **ステップ1: JDK 17 をインストール**

```bash
sudo apt-get update && sudo apt-get install -y openjdk-17-jdk unzip
```

- [ ] **ステップ2: JDK を確認**

実行: `java -version`
期待: 出力に `openjdk version "17` を含む

- [ ] **ステップ3: Android cmdline-tools をインストール**

```bash
export ANDROID_HOME="$HOME/Android/sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
cd /tmp
curl -fsSL -o cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools"
mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
```

- [ ] **ステップ4: SDK パッケージをインストール（ライセンス同意）**

```bash
export ANDROID_HOME="$HOME/Android/sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
yes | sdkmanager --licenses >/dev/null
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

- [ ] **ステップ5: SDK を確認**

実行: `sdkmanager --list_installed`
期待: `platform-tools`、`platforms;android-34`、`build-tools;34.0.0` が並ぶ

- [ ] **ステップ6: `vc-studio/README.md` を書く**

````markdown
# VC Studio

cc-web 用の薄い Android WebView ラッパー。`https://<tailnet-host>/` を
全画面で開き、Foreground Service で裏に回っても接続を維持する。
通信は端末の公式 Tailscale VPN に乗る — アプリ内 Tailscale は無し。

## ビルド（WSL）

前提: JDK 17、Android SDK cmdline-tools。

```bash
sudo apt-get install -y openjdk-17-jdk unzip
export ANDROID_HOME="$HOME/Android/sdk"   # 永続化するなら ~/.bashrc に追記
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

debug APK をビルド:

```bash
cd vc-studio
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

端末へインストール（USB もしくは `adb connect <tailnet-ip>:5555`）:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
````

- [ ] **ステップ7: コミット**

```bash
cd <cc-web-repo>
git add vc-studio/README.md
git commit -m "chore(vc-studio): toolchain bootstrap + build README"
```

---

### Task 2: 空アプリがビルドできる Gradle プロジェクト骨格

**ファイル:**
- 作成: `cc-web/vc-studio/settings.gradle`
- 作成: `cc-web/vc-studio/build.gradle`
- 作成: `cc-web/vc-studio/gradle.properties`
- 作成: `cc-web/vc-studio/app/build.gradle`
- 作成: `cc-web/vc-studio/app/src/main/AndroidManifest.xml`
- 作成: `cc-web/vc-studio/app/src/main/res/values/strings.xml`
- 作成: `cc-web/vc-studio/.gitignore`

**インターフェース:**
- 提供: `applicationId net.<tailnet>.vcstudio` でビルド可能な Gradle プロジェクト、パッケージ `net.<tailnet>.vcstudio`。後続タスクで `MainActivity.kt` と `KeepAliveService.kt` を `app/src/main/java/net/<tailnet>/vcstudio/` に追加する。

- [ ] **ステップ1: Gradle wrapper を生成**

注意: `gradle wrapper` はカレントに `settings.gradle` が無いと「does not contain a Gradle build」で失敗する。
先にステップ2〜8のファイル（少なくとも `settings.gradle`）を作ってから、このステップを実行すること。

```bash
cd <cc-web-repo>/vc-studio
gradle wrapper --gradle-version 8.7 2>/dev/null || \
  (cd /tmp && curl -fsSL -o gradle.zip https://services.gradle.org/distributions/gradle-8.7-bin.zip && unzip -q gradle.zip && \
   /tmp/gradle-8.7/bin/gradle -p <cc-web-repo>/vc-studio wrapper --gradle-version 8.7)
```

期待: `gradlew`、`gradlew.bat`、`gradle/wrapper/` が生成される。

- [ ] **ステップ2: `settings.gradle` を書く**

```groovy
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "vc-studio"
include ':app'
```

- [ ] **ステップ3: ルートの `build.gradle` を書く**

```groovy
plugins {
    id 'com.android.application' version '8.5.2' apply false
    id 'org.jetbrains.kotlin.android' version '1.9.24' apply false
}
```

- [ ] **ステップ4: `gradle.properties` を書く**

```properties
org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
kotlin.code.style=official
```

- [ ] **ステップ5: `app/build.gradle` を書く**

```groovy
plugins {
    id 'com.android.application'
    id 'org.jetbrains.kotlin.android'
}

android {
    namespace 'net.<tailnet>.vcstudio'
    compileSdk 34

    defaultConfig {
        applicationId "net.<tailnet>.vcstudio"
        minSdk 26
        targetSdk 34
        versionCode 1
        versionName "0.1.0"
    }

    buildTypes {
        release {
            minifyEnabled false
        }
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = '17'
    }
}

dependencies {
    implementation 'androidx.core:core-ktx:1.13.1'
    implementation 'androidx.appcompat:appcompat:1.7.0'
}
```

- [ ] **ステップ6: `app/src/main/res/values/strings.xml` を書く**

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">VC Studio</string>
    <string name="keepalive_channel_name">cc-web connection</string>
    <string name="keepalive_notification_title">cc-web connected</string>
    <string name="keepalive_notification_text">Keeping the session alive in the background</string>
</resources>
```

- [ ] **ステップ7: 最小の `app/src/main/AndroidManifest.xml` を書く（まだ Activity 無し — プレースホルダ）**

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:allowBackup="true"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:usesCleartextTraffic="false" />
</manifest>
```

- [ ] **ステップ8: `vc-studio/.gitignore` を書く**

```gitignore
.gradle/
build/
app/build/
local.properties
*.apk
.idea/
```

- [ ] **ステップ9: スケルトンがコンパイルできるかビルドで確認**

```bash
cd <cc-web-repo>/vc-studio
export ANDROID_HOME="$HOME/Android/sdk"
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleDebug
```

期待: `BUILD SUCCESSFUL`。（Activity が無いアプリでも有効な APK は生成される。）

- [ ] **ステップ10: コミット**

```bash
cd <cc-web-repo>
git add vc-studio/settings.gradle vc-studio/build.gradle vc-studio/gradle.properties \
  vc-studio/app/build.gradle vc-studio/app/src/main/AndroidManifest.xml \
  vc-studio/app/src/main/res/values/strings.xml vc-studio/.gitignore \
  vc-studio/gradlew vc-studio/gradlew.bat vc-studio/gradle/
git commit -m "feat(vc-studio): Gradle skeleton that builds an empty debug APK"
```

---

### Task 3: KeepAliveService (Foreground Service)

**ファイル:**
- 作成: `cc-web/vc-studio/app/src/main/java/net/<tailnet>/vcstudio/KeepAliveService.kt`
- 変更: `cc-web/vc-studio/app/src/main/AndroidManifest.xml`

**インターフェース:**
- 提供: `KeepAliveService` — `MainActivity`（Task 4）が
  `ContextCompat.startForegroundService(context, Intent(context, KeepAliveService::class.java))` で起動する。
  companion に `const val CHANNEL_ID = "cc_web_keepalive"` と `const val NOTIFICATION_ID = 1`。

- [ ] **ステップ1: `KeepAliveService.kt` を書く**

```kotlin
package net.<tailnet>.vcstudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class KeepAliveService : Service() {

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 常駐通知が存在すること自体が OS への keep-alive シグナル。
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.keepalive_channel_name),
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.keepalive_notification_title))
            .setContentText(getString(R.string.keepalive_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    companion object {
        const val CHANNEL_ID = "cc_web_keepalive"
        const val NOTIFICATION_ID = 1
    }
}
```

- [ ] **ステップ2: `AndroidManifest.xml` に権限 + `<service>` を追加**

ファイルを以下で置き換える:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

    <application
        android:allowBackup="true"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:usesCleartextTraffic="false">

        <service
            android:name=".KeepAliveService"
            android:exported="false"
            android:foregroundServiceType="dataSync" />
    </application>
</manifest>
```

- [ ] **ステップ3: コンパイルできるかビルドで確認**

```bash
cd <cc-web-repo>/vc-studio
export ANDROID_HOME="$HOME/Android/sdk"
./gradlew assembleDebug
```

期待: `BUILD SUCCESSFUL`。

- [ ] **ステップ4: コミット**

```bash
cd <cc-web-repo>
git add vc-studio/app/src/main/java/net/<tailnet>/vcstudio/KeepAliveService.kt \
  vc-studio/app/src/main/AndroidManifest.xml
git commit -m "feat(vc-studio): KeepAliveService foreground service with persistent notification"
```

---

### Task 4: MainActivity（全画面 WebView + サービス起動 + 戻る履歴）

**ファイル:**
- 作成: `cc-web/vc-studio/app/src/main/java/net/<tailnet>/vcstudio/MainActivity.kt`
- 変更: `cc-web/vc-studio/app/src/main/AndroidManifest.xml`（Activity を launcher として登録）

**インターフェース:**
- 利用: `KeepAliveService`（Task 3）を `ContextCompat.startForegroundService` 経由で起動。

- [ ] **ステップ1: `MainActivity.kt` を書く**

```kotlin
package net.<tailnet>.vcstudio

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        requestNotificationPermissionIfNeeded()
        ContextCompat.startForegroundService(
            this, Intent(this, KeepAliveService::class.java)
        )

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = WebViewClient()  // 遷移を WebView 内に留める
        }
        setContentView(webView)
        webView.loadUrl(TARGET_URL)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

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

    companion object {
        private const val TARGET_URL = "https://<tailnet-host>/"
    }
}
```

- [ ] **ステップ2: `AndroidManifest.xml` に `MainActivity` を launcher として登録**

`<application>` の中（`</application>` の前）に追加:

```xml
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
```

さらに AppCompat が動くよう `<application>` にテーマを追加: `android:theme="@style/Theme.AppCompat.DayNight.NoActionBar"` を設定する。

- [ ] **ステップ3: コンパイルできるかビルドで確認**

```bash
cd <cc-web-repo>/vc-studio
export ANDROID_HOME="$HOME/Android/sdk"
./gradlew assembleDebug
```

期待: `BUILD SUCCESSFUL`。APK は `app/build/outputs/apk/debug/app-debug.apk`。

- [ ] **ステップ4: コミット**

```bash
cd <cc-web-repo>
git add vc-studio/app/src/main/java/net/<tailnet>/vcstudio/MainActivity.kt \
  vc-studio/app/src/main/AndroidManifest.xml
git commit -m "feat(vc-studio): MainActivity full-screen WebView, auto-start service, back history"
```

---

### Task 5: 実機検証（go / no-go）

実機での手動検証。コードは無し。成果物は、スペックの go/no-go 観点に対する合否の記録。

**ファイル:**
- 変更: `cc-web/vc-studio/README.md`（「検証結果」セクションを追記）

- [ ] **ステップ1: APK を実機にインストール**

```bash
export ANDROID_HOME="$HOME/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
adb connect <phone-tailnet-ip>:5555   # もしくは USB
adb install -r vc-studio/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **ステップ2: 各 go/no-go 観点を検証して結果を記録**

順に確認:
1. **Tailscale 到達性** — アプリが開き cc-web が実際にロードされる（TLS/タイムアウトエラーでない）。
2. **入力系** — ソフトキーボードでチャットに打鍵できる / **ツール許可ダイアログのタッチ承認が効く** / コピー＆ペーストが効く。
3. **バックグラウンド接続維持（本プロジェクトの本命）** — Web 側 keepalive 拡張（ダミー音声）を**無効**にした状態で、Claude のターンを開始 → 数分アプリを裏に回す（画面オフ）→ 戻ったとき、ターンがまだ走っている / WS が生存している。
4. **Doze** — 3 と同じだが、画面オフでより長く放置する。

- [ ] **ステップ3: 結果を README に記録してコミット**

`vc-studio/README.md` に `## 検証結果（YYYY-MM-DD）` セクションを追記し、4観点それぞれの合否と、フォローアップ（例: 「バッテリー最適化の除外が必要」）を記す。

```bash
cd <cc-web-repo>
git add vc-studio/README.md
git commit -m "docs(vc-studio): record on-device go/no-go verification results"
```

---

## 実装者向けメモ

- 初回に `./gradlew assembleDebug` が `local.properties` 無しで失敗したら、`echo "sdk.dir=$HOME/Android/sdk" > vc-studio/local.properties` で作る（gitignore 済み）。
- Gradle が AGP をダウンロードできない場合、端末/WSL に普通のインターネットがあるか確認する（Tailscale VPN はこれをブロックしない）。
- 通知の小アイコンは v0.1 では画像アセットを同梱しないよう Android 組み込みの drawable を使っている。`vc-studio/` から独立する際に本物のアイコンに差し替える。
