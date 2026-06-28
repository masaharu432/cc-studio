# cc-studio: cc-web Android ラッパーアプリ 設計 (v0.1)

> 注: 当初 `vc-studio` の名で着手し、実機検証後に `cc-studio`（表示名 CC Studio /
> applicationId app.ccstudio）へ改名した。以下の本文に残る "vc-studio" 表記は旧名。

最終更新: 2026-06-27（改名: 2026-06-27）
関連（cc-web リポジトリ側）: `cc-web/docs/superpowers/specs/2026-06-27-background-keepalive-productionization-design.md`（Web拡張側の延命の苦肉の策。本プロジェクトはこれを根本から不要にすることを狙う。vc-studio を別リポジトリへ分離した後はこのリンクは辿れなくなる）

## 1. 背景と動機
cc-web は code-server（Web版 VS Code）を Tailscale 経由の HTTPS でスマホブラウザから開く構成。
ブラウザのタブで開いているため、**裏に回ると OS が裏タブの通信を止め、WS が切れて実行中ターンが中断**する。
これを Web 側で防ぐため、現状は「`<audio>` で連続ストリームを再生して Android MediaSession を立て、
OS にアプリを生かしてもらう」という苦肉の策（メディア通知ダミー音声）を取っている。副作用として
他アプリのメディア再生と音声フォーカスを奪い合う既知の問題がある（コミット `4ef6a16`）。

**着想**: ブラウザのタブではなく、**専用 Android アプリの WebView** で cc-web を開けば、
アプリは **Foreground Service** を持てる。これは OS への正規の「このプロセスを生かせ」シグナルであり、
ダミー音声・MediaSession ハックが**丸ごと不要**になる。通知・将来のネイティブ機能拡張の余地も得られる。

## 2. 確定した前提
- スマホには**公式 Tailscale Android アプリ**が入っており、OS全体VPNとして tailnet 接続を担っている。
  → WebView は「`https://<tailnet-host>/` を開くだけ」で自動的に tailnet に乗る。
    **アプリ内に Tailscale 実装は不要**（最大の難所を回避）。
- Tailscale の TLS 証明書は OS 信頼ストアに乗る → WebView 側の証明書ハックは不要。
- ビルドは **WSL 上に Android SDK(cmdline-tools)を入れて `gradlew` でビルド**し、リポジトリ内で完結（方式A）。

## 3. ゴール / 非ゴール
**ゴール (v0.1)**:
- WebView で cc-web を全画面表示する専用アプリ。
- Foreground Service（常駐通知）で常駐し、裏/画面オフでも接続を維持する。
- 起動時に自動で WebView を開く。戻るボタンで WebView 履歴を辿る。

**非ゴール（当面・YAGNI）**:
- ネイティブのプロジェクト選択UI（code-server 内の既存拡張に委任、今と同じ）。
- タスク完了のネイティブ通知（まず接続維持が効くか実機で見てから）。
- URL 設定画面（v0.1 はハードコード）。
- iOS 対応。

## 4. アーキテクチャ
```
┌─────────────────────────────────────────┐
│  MainActivity                            │
│  ・全画面 WebView 1枚                     │
│  ・https://<tailnet-host>/ を開く │
│  ・JS / DOMStorage / WebSocket 有効化     │
│  ・onCreate で KeepAliveService を start  │
│  ・戻るボタン → WebView.canGoBack 履歴    │
└─────────────────────────────────────────┘
              │ start
              ▼
┌─────────────────────────────────────────┐
│  KeepAliveService (Foreground Service)   │
│  ・常駐通知1枚("cc-web 接続中")           │
│  ・処理は持たない。存在がOSへの延命シグナル│
└─────────────────────────────────────────┘

  前提: 端末の公式 Tailscale アプリ(OS全体VPN)に
        WebView の通信が自動で乗る。アプリ内にTS実装は不要。
```

### コンポーネント
- **MainActivity**: 全画面 WebView を1枚持つ。`onCreate` で URL をロードし `KeepAliveService` を起動。
  `onBackPressed` で `webView.canGoBack()` なら `goBack()`、なければアプリを閉じる。
  WebViewClient で外部遷移も WebView 内に留める（同一オリジン前提）。
- **KeepAliveService**: `startForeground(id, notification)` で常駐通知を出すだけのサービス。
  内部処理は持たない — 常駐通知の存在自体が OS への「殺すな」シグナル。`START_STICKY` で復帰。
- **WebView 設定**: `javaScriptEnabled=true`, `domStorageEnabled=true`, `databaseEnabled=true`,
  `mediaPlaybackRequiresUserGesture=false`（将来 /voice 等のため）。

### Android 権限・宣言
- `android.permission.INTERNET`
- `android.permission.FOREGROUND_SERVICE`
- `android.permission.POST_NOTIFICATIONS`（Android 13+。常駐通知の表示に必要）
- `<service android:foregroundServiceType="dataSync">`（接続維持の用途として）

## 5. フォルダ構成（将来の分離前提）
Android アプリ一式を **`cc-web/vc-studio/` に自己完結**させる。Web 拡張(cc-web-keepalive /
cc-web-helper)とはソースもビルドも一切共有しない。うまくいったら `git subtree split --prefix=vc-studio`
で履歴ごと別リポジトリに切り出せる。

```
cc-web/vc-studio/
├── settings.gradle
├── build.gradle              # ルート（AGP / Kotlin バージョン）
├── gradle.properties
├── gradlew / gradlew.bat / gradle/wrapper/
├── app/
│   ├── build.gradle          # applicationId, minSdk, targetSdk
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/.../MainActivity.kt
│       ├── java/.../KeepAliveService.kt
│       └── res/               # アイコン, 文字列, 通知チャネル名等
└── README.md                 # ビルド方法（WSL + cmdline-tools + gradlew）
```

## 6. ビルド方法（方式A: WSL 内完結）
- WSL に JDK 17 と Android cmdline-tools を導入、`sdkmanager` で `platform-tools` /
  `platforms;android-34` / `build-tools` を取得。
- `./gradlew assembleDebug` で `app/build/outputs/apk/debug/app-debug.apk` を生成。
- 実機へは `adb install`（USB / tailnet 経由の `adb connect`）または APK をファイル共有して手動インストール。
- 詳細手順は `vc-studio/README.md` に記す（環境変数 `ANDROID_HOME` 等含む）。

## 7. 検証の勘所（go / no-go）
1. **接続維持（本命）**: アプリを裏に回し数分放置 → 戻ったとき WS が生きているか。
   Web側の keepalive 拡張（ダミー音声）を**無効**にした状態で検証する。これが効けば苦肉の策を捨てられる。
2. **Tailscale 同居**: WebView から `<tailnet-host>` に実際に到達するか。
3. **入力系**: ソフトキーボード打鍵 / **ツール許可ダイアログのタッチ承認**（cc-web README の最重要観点）/
   コピー＆ペースト。
4. **画面オフ**: 画面オフ＋裏でも生存するか（Doze 影響の確認）。

## 8. リスクと留意
- **Doze / バッテリー最適化**: Foreground Service でも Doze 下で制限される場合がある。
  効かなければ「バッテリー最適化の除外」をユーザに案内（v0.1 は案内のみ、自動化は非ゴール）。
- **WebView の WS 絞り**: Foreground Service があっても WebView の裏制御が残る可能性 → 実機検証1で判定。
  ダメなら Web 側 keepalive を保険として併用する退路を残す。
- **ビルド環境**: WSL での Android SDK 導入は初回コストあり。`vc-studio/README.md` に再現手順を残す。
