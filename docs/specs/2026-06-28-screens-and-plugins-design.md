# CC Studio: Screens（複数スクリーン切替）と Plugins システムスクリーン 設計

最終更新: 2026-06-28
関連:
- [WebView 拡張ランタイム 設計](2026-06-28-webview-extension-runtime-design.md)（プラグイン注入の土台。本書はその上に Screens / Plugins UI を載せる）
- [JS注入プラグイン機能 設計](2026-06-28-js-injection-plugin-design.md)（v0.2 の Control Center パネル。本書で全画面スクリーンへ作り替える）
- デザインモック: [docs/design/screens-mock.html](../design/screens-mock.html)（レンダー: `docs/design/previews/screens-mock.png`、git 追跡外）

## 用語（厳守）
CC Studio の UI 語彙は **Screen / スクリーン** と **Plugin / プラグイン** の2語に統一する。
"タブ" "ウィンドウ" "画面（単位の意味で）" "拡張機能" は使わない（web タブ / VS Code タブ / ブラウザ拡張の概念が混在し紛らわしいため）。"全画面"（fullscreen）はレイアウト用語として可。

---

## 1. 背景とゴール

現状の CC Studio は単一 WebView で固定 URL（code-server の `?folder=...`）を1つだけ開く
（[MainActivity.kt](../../app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt)）。
左端 ︙ から開く **Control Center パネル**（[bootstrap.js](../../app/src/main/assets/bootstrap.js)）に
Plugins/Files/Settings/About のタブを詰め込んでいるが、狭いパネルで窮屈。

**ゴール**: ブラウザのタブグリッドのように、**別フォルダで開いた複数の VS Code を「スクリーン」として並行保持・切替**できるようにする。あわせて、窮屈なパネルをやめ、**管理UIを全画面の「システムスクリーン」へ昇格**する。第一弾は **Plugins** システムスクリーン。

### v1 スコープ
- 複数スクリーンの**並行保持**（各スクリーン＝生きた WebView）と全画面 **switcher**（︙ から開く）。
- スクリーンの**新規作成 / 切替 / リロード / 削除（スワイプ2段階）** と **URL 永続化・復元**。
- **Plugins システムスクリーン**（消せない・全画面）: プラグインの ON/OFF・削除・バージョン/説明表示・個別設定の呼び出し口・追加・About。
- プラグイン変更の**反映はスクリーン単位のリロード**（拡張同等＝登録は次ロードから効くため）。リロード時に**実行中の中断を警告**。
- `keyboard-suppress` を「常時登録のハードコード」から**トグル可能な組込みプラグイン**へ。

### 非ゴール（将来章 §9 で扱う）
- **Files システムスクリーン**（スマホ内ファイラー → 関連アプリで開く）。
- プラグインの**設定スキーマ**／設定 UI の実体（v1 は呼び出し口 ⚙ の予約のみ）。
- スクリーンの**ライブサムネイル**（v1 はフォルダ名/パスの帯表示のみ）。

---

## 2. 全体アーキテクチャ

### 2.1 「すべてはスクリーン」モデル
スクリーンは2種類:

| 種別 | 中身 | 閉じる | 例 |
|---|---|---|---|
| **Web スクリーン** | code-server を `?folder=` で開いた WebView | 可（スワイプ削除） | cc-studio, cc-web, … |
| **システムスクリーン** | バンドルされたローカル HTML を読む WebView | 不可（固定） | **Plugins**（将来: Files） |

**設計判断: 全スクリーンを「HTML を読む WebView」に統一する。** Web スクリーンは remote（code-server）を、システムスクリーンは `file:///android_asset/...` のローカル HTML を読むだけの違い。これにより既存のビジュアル言語（HTML/CSS）を一本化でき、システムスクリーンも `CCStudio` ブリッジ経由でネイティブ機能を呼べる。

### 2.2 スクリーンの生存方式（A案: visibility 切替）
全 WebView を1つのコンテナ（`FrameLayout`）の子として保持し、**アクティブのみ VISIBLE・他は GONE** で切り替える。detach/attach や saveState は使わない（再描画・状態喪失を避け、確実に「生きたまま並行保持」する）。メモリは食うが、要件に最も忠実。

### 2.3 switcher の位置づけ
switcher は**スクリーンではなく一時的なオーバーレイ**（最前面に出す全画面の選択 UI）。︙ ボタンから開く。実装は**ローカル HTML を読む専用 WebView オーバーレイ**（`switcher.html`）とし、スクリーン一覧（フォルダ名/パス/状態）をブリッジ経由の JSON で受け取って描く。

```
MainActivity
 ├─ rootFrame: FrameLayout
 │   ├─ Screen WebView #plugins (system, GONE/VISIBLE)
 │   ├─ Screen WebView #web-1   (GONE/VISIBLE)
 │   ├─ Screen WebView #web-2   ...
 │   └─ Switcher WebView overlay (前面・表示/非表示)
 ├─ ScreenManager（スクリーン集合・アクティブ・コンテナ操作・サムネ/世代）
 ├─ ScreenStore（URL 群＋アクティブ id の永続化）
 └─ PluginStore（既存：プラグインの保存・有効集合）
```

---

## 3. コンポーネント

### 3.1 `Screen`（新規 data/クラス）
1つのスクリーンを表す。
```
class Screen(
  val id: Long,
  val kind: Kind,            // WEB | SYSTEM_PLUGINS（将来 SYSTEM_FILES）
  val webView: WebView,
)
var url: String              // Web: 現在URL / System: asset URL
var title: String            // Web: フォルダ名（?folder= 由来） / System: 固定名
val closeable: Boolean       // WEB=true, SYSTEM=false
var loadedGeneration: Int    // 最後にロードした時点のプラグイン世代（stale 判定用 §5）
val pluginHandlers: MutableMap<String, ScriptHandler>  // WEB のみ
var kbHandler: ScriptHandler?                          // WEB のみ
```
- **タイトル/フォルダ**は Web スクリーンでは `url` の `?folder=` を decode して basename を `title`、フルパスを副表示に使う（`?folder=` 無しならホスト名）。
- document-start のプラグイン/キーボード抑制登録は **WEB スクリーンのみ**（システムスクリーンの自前 HTML には注入不要）。

### 3.2 `ScreenManager`（新規）
スクリーン集合・アクティブ・コンテナ操作の中心。WebView の組み立ては行わない（`MainActivity` のファクトリに委譲）。
- `screens(): List<Screen>` / `active(): Screen` / `select(id)` / `add(screen)` / `close(id)`（WEB のみ）。
- `select` はアクティブを VISIBLE・他を GONE に。切替**直前にアクティブのサムネ用情報を更新**（v1 はタイトル/URL のみ。ビットマップは将来 §9）。
- システムスクリーン（Plugins）は常に集合の先頭に固定し close 不可。

### 3.3 `ScreenStore`（新規）
`SharedPreferences` に **Web スクリーンの URL 配列＋アクティブ id** を保存/復元。
- 起動時: 復元した URL ごとに WebView を生成（kb＋有効プラグインを登録 → loadUrl）。空なら `TARGET_URL` で1枚。
- 更新: Web スクリーンの `onPageFinished`/`doUpdateVisitedHistory` で `url` を更新 → 保存。
- システムスクリーン（Plugins）は常に存在するので永続化対象外（起動時に必ず生成）。

### 3.4 `MainActivity`（改修）
- ルートを `FrameLayout` に。`createWebScreen(url)` / `createSystemScreen(kind)` ファクトリで WebView を組み立て（既存の WebViewClient / WebChromeClient(file chooser) / DownloadListener / `CCStudio` ブリッジ / document-start 登録を1箇所に集約）、`ScreenManager` に登録。
- 既存の単一 `webView` 直参照を **`screenManager.active().webView` 経由**に置換。
  - `injectPlugin`/`refreshPanel` 等の「現在ページ」操作はアクティブ Web スクリーン対象に。
  - `syncPluginRegistrations()` は**全 Web スクリーンをループ**して同期（§5）。
- switcher オーバーレイの表示/非表示、スクリーン操作のブリッジ受け口を実装。

### 3.5 `CcBridge`（改修・拡張）
既存（pickPlugin/listPlugins/setEnabled/removePlugin/saveBase64/saveFailed/getBuild）に加え:
- `openSwitcher()` / `closeSwitcher()` — switcher オーバーレイ開閉。
- `listScreens(): String` — `[{id,title,path,kind,active,closeable,stale}]` の JSON。
- `selectScreen(id)` — そのスクリーンへ切替（**リロードしない**）。
- `reloadScreen(id)` — そのスクリーンを `reload()`（プラグイン変更を反映）。
- `closeScreen(id)` — Web スクリーンを閉じる（switcher のスワイプ確定から呼ぶ）。
- `newScreen()` — `TARGET_URL` で新規 Web スクリーンを作って選択。
- 「current page」系操作はすべて `ScreenManager.active()` で解決（同一ブリッジを全 WebView に add してよい）。

### 3.6 `bootstrap.js`（縮小）
Control Center パネル（タブ/Plugins UI）を**撤去**し、以下だけ残す:
- 左端 ︙ ボタン → `CCStudio.openSwitcher()`。
- 既存の **createObjectURL フック / ダウンロードフック**（CSP 回避のダウンロード処理）。
Web スクリーンに document-start 注入され、どのスクリーンからでも ︙ で switcher を開ける。

### 3.7 新規 HTML アセット
- `assets/switcher.html` — 全画面 switcher（§4.1）。
- `assets/plugins.html` — Plugins システムスクリーン（§4.2）。
両者ともデザイン言語（[screens-mock.html](../design/screens-mock.html)）の配色・部品を踏襲（青=アクティブ/ナビ、エメラルド=有効プラグイン、琥珀=中断警告のみ）。

---

## 4. UI 仕様

### 4.1 switcher（︙ → 全画面オーバービュー）
- 上部: `CC▍STUDIO` ワードマーク / `SCREENS` / build チップ。サマリ `N screens · 1 active`。サブノート「タップで切替（そのまま）。⟳ でリロードして起動。左スワイプで削除。裏で実行中はそのまま。」
- **スクリーン帯リスト**（サムネ無し・縦スクロール）。各帯:
  - フォルダ色ドット＋**フォルダ名**（太字）＋**パス**（mono・省略可）。
  - 右に **⟳ リロード**ボタン（安全操作なので常時表示）。プラグイン変更後に**古い（stale）**な帯は ⟳ を青塗り（プライマリ）で再読込を示唆（§5）。
  - **アクティブ**帯は青レール＋青ドット。
  - **削除は2段階のスワイプ式**: 帯を**左スワイプ**すると右から赤い「✕ 削除」ボタンが出る → タップで `closeScreen`。常時✕は置かない（誤操作防止）。
- 末尾に破線の **New screen** 帯（`newScreen`）。
- 最下部に固定の **SYSTEM** ドック（スクロールしない）。複数のシステム帯を並べられる:
  - `Plugins`（エメラルドレール・⚓固定・`N installed · M enabled`）。
  - 将来: `Files`（§9）。v1 は表示しても `SOON` 表記（または非表示でも可）。

### 4.2 Plugins システムスクリーン（全画面・消せない）
- 上部: `‹ Screens`（switcher へ戻る = `openSwitcher`）/ `PLUGINS` / build チップ。サマリ `N installed · M enabled`。
- **injection bus**（縦レール＋ノード）に各プラグインを**多段リッチカード**で並べる:
  - **名前 ＋ バージョンチップ**（例 `v1.2.0`）。
  - **説明は全文表示**（省略しない。カードが縦に伸びるのは許容）。
  - メタ: `サイズ · ON/OFF · all frames · document-start`。有効時はノード/レールがエメラルドに灯り、`prefers-reduced-motion` 尊重でパルスが流れる（実機構の可視化）。
  - 操作: **ON/OFF トグル**、**⚙ 個別設定**（プラグインが設定を宣言している時のみ表示・§9）、**✕ 削除**（40px・組込みも削除可）。
- 下部に **＋ Add plugin**（`pickPlugin`）と **About**（build / ホスト / 注入の説明）。
- **自動注入トグルは廃止**（有効化＝以後の全ロードに常駐が唯一の挙動）。

### 4.3 リロード確認ダイアログ
switcher で stale でない/実行中かもしれないスクリーンの ⟳ を押した時、確認を挟む:
- 「リロードして起動しますか？ / `<folder>` を再読込してプラグインの変更を反映します。**このスクリーンで実行中の処理があれば中断されます。**（琥珀）」
- ボタン: `[そのまま開く]`（= reload せず `selectScreen`）/ `[リロード]`（= `reloadScreen`）。
- 実装メモ: ネイティブの `AlertDialog` か HTML オーバーレイのどちらでも可。switcher が HTML なので **HTML ダイアログ**で統一すると配色も揃う。

---

## 5. プラグイン反映モデル（拡張同等・スクリーン単位リロード）

ブラウザ拡張と同じく `addDocumentStartJavaScript` は**以後のロード**にのみ効く
（[ExtensionRuntime.kt](../../app/src/main/java/net/<tailnet>/ccstudio/ExtensionRuntime.kt)）。
よって ON/OFF の**現在ページへの反映にはリロードが必要**。これを UI で素直に扱う:

1. **プラグイン世代カウンタ** `pluginGeneration: Int` を持つ。`setEnabled`/`removePlugin`/プラグイン追加のたびに +1 し、全 Web スクリーンの document-start 登録を同期（`syncPluginRegistrations` を全スクリーンに対して実行）。
2. 各 Web スクリーンは `loadedGeneration` を保持（ロード完了時に現在の `pluginGeneration` を記録）。
3. switcher の **stale 判定** = `screen.loadedGeneration < pluginGeneration`。stale な帯は ⟳ を青塗りで示唆。
4. ユーザーが ⟳ を押した帯**だけ**を reload（実行中のスクリーンは触らない＝本人が選ぶ）。reload で `loadedGeneration` 更新。
5. `keyboard-suppress` は組込みプラグインとして他と同じ経路に載る（§6）。

> 注: enable した瞬間の「現在のアクティブページへ即 evaluateJavascript」フォールバック（現行 [MainActivity.kt の onSetEnabled](../../app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt)）は、スクリーン単位リロードへ一本化するため**廃止**する（メインフレーム限定で挙動が割れるため）。

---

## 6. `keyboard-suppress` の組込みプラグイン化

現状はアセットを**常時 document-start 登録**（ハードコード・[MainActivity.kt](../../app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt)）。これを **トグル状態を持つ組込みプラグイン**へ:
- `PluginStore` に「組込み（bundled）」プラグインの概念を追加。初回起動時に `assets/keyboard-suppress.js` を取り込み、既定 ON で登録。
- 一覧では `BUNDLED` 由来でも **ON/OFF トグル可・✕ 削除可**（新バージョンに差し替え得るため。fix ではない）。
- 削除後の復活は当面「Add plugin で再投入」とする（バンドル再インストール導線は将来）。
- バージョン/説明は `.js` 先頭の userscript 風メタヘッダから取得（§7）。

---

## 7. プラグインのメタデータ（バージョン/説明/設定の宣言）

`.js` 先頭のコメントヘッダを `PluginStore` が解析する（userscript 慣習に倣う）:
```
// ==CCStudioPlugin==
// @name        keyboard-suppress
// @version     1.2.0
// @description 物理キーボードの自動表示を抑制する。…（全文表示される）
// @settings    true        ← 宣言時のみ ⚙ を表示（実体は §9）
// ==/CCStudioPlugin==
```
- ヘッダが無い場合: name=ファイル名、version=空、description=空、settings=false。
- `listPlugins()` の JSON に `version` / `description` / `hasSettings` を追加し、`plugins.html` が描画。

---

## 8. データフロー（代表シナリオ）

1. **起動** → `ScreenStore` 復元 → 各 URL で Web スクリーン生成（kb＋有効プラグイン登録 → loadUrl）＋ Plugins システムスクリーン生成 → アクティブのみ VISIBLE。
2. **別フォルダを開く** → VS Code 内でフォルダを開く → URL 変化を捕捉 → `Screen.url/title` 更新 → `ScreenStore` 保存。
3. **新規スクリーン** → ︙ → switcher → New screen → `TARGET_URL` で生成・選択。VS Code 側で目的のフォルダを開く。
4. **プラグイン ON** → Plugins スクリーンでトグル → `pluginGeneration`++、全 Web スクリーン登録同期 → switcher で該当スクリーンが stale 表示 → 反映したいスクリーンの ⟳（実行中なら確認）→ reload。
5. **スクリーン削除** → switcher で帯を左スワイプ → 赤「削除」→ `closeScreen` → WebView 破棄・`ScreenStore` 保存・隣をアクティブ化。

---

## 9. 将来章（v1 非対象）

- **Files システムスクリーン**: スマホ内ファイルをブラウズし、タップで **Android の関連アプリで開く**（`Intent.ACTION_VIEW` ＋ MIME 関連付け、SAF/MediaStore）。SYSTEM ドックに2枚目のシステム帯として載る。SYSTEM エリアは**複数システムスクリーンを並べられる拡張点**として設計済み。
- **プラグイン個別設定**（⚙ の実体）: プラグインが宣言した設定（スキーマ or 実行時 API）を呼び出す UI。Plugins スクリーン内のサブ画面／オーバーレイで開く。
- **ライブサムネイル**: 切替直前にアクティブ WebView を `draw()` でビットマップ化しキャッシュ、switcher の帯にプレビューを添える（GONE 描画問題は cache-on-switch で回避）。
- バンドルプラグインの再インストール導線。

---

## 10. 影響ファイル一覧

新規:
- `app/src/main/java/net/<tailnet>/ccstudio/Screen.kt`
- `app/src/main/java/net/<tailnet>/ccstudio/ScreenManager.kt`
- `app/src/main/java/net/<tailnet>/ccstudio/ScreenStore.kt`
- `app/src/main/assets/switcher.html`
- `app/src/main/assets/plugins.html`

変更:
- `app/src/main/java/net/<tailnet>/ccstudio/MainActivity.kt`（複数スクリーン化・ファクトリ・switcher 開閉・ブリッジ配線・全スクリーン登録同期）
- `app/src/main/java/net/<tailnet>/ccstudio/CcBridge.kt`（Screens 系メソッド追加）
- `app/src/main/java/net/<tailnet>/ccstudio/PluginStore.kt`（メタヘッダ解析・組込みプラグイン・version/description/hasSettings）
- `app/src/main/assets/bootstrap.js`（Control Center 撤去・︙→openSwitcher＋DLフックのみ）

---

## 11. リスク / 留意点

- **メモリ**: Web スクリーンを生かし続けるため枚数に比例して増える。実用上の上限（例: 警告/上限提案）は運用しながら調整（v1 は上限なし、必要なら将来 LRU 休止）。
- **document-start 非対応端末**: `isDocumentStartSupported()==false` の端末では各 Web スクリーンの `onPageFinished` で `evaluateJavascript` フォールバック（現行同様。メインフレーム限定の制約は受容）。
- **switcher オーバーレイ用 WebView の追加コスト**: 軽量 HTML なので許容。表示時のみ前面化。
- **用語の一貫性**: 実装の文字列・コメント・spec すべてで Screen/Plugin を厳守。
