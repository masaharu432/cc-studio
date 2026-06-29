# プラグイン設定スクリーン（ライブ反映） 設計

- 日付: 2026-06-29
- 対象リポジトリ: cc-studio
- ステータス: Draft（実装前レビュー待ち）

## 背景 / 問題

HUD プラグイン（[plugins/focus-hud.js](../../../plugins/focus-hud.js)）は document-start・all-frames で**常時注入され実行中**。だが「表示するか」を切り替える手段がプラグインの**有効/無効しかなく**、有効/無効の変更は `bumpGenerationAndSync()` → `registerScreenScripts()` を通すものの、document-start 登録は「以後のロード」にしか効かないため、**反映にはスクリーンのリロードが必要**になる。

これが痛点を生む。ソフトキーボード抑制（keyboard-suppress）がうまく動かない状況のログを取りたいとき、HUD を出し入れするためにリロードすると、**再現状態そのものが消えてしまう**。

プラグイン設定（`@settings` ヘッダ、plugins.html の ⚙ ボタン）の枠組みはコメントだけ存在し、実体は未実装（[plugins.html](../../../app/src/main/assets/plugins.html) L114-116）。

## ゴール / 非ゴール

ゴール:
- プラグインに**設定値**を持たせる汎用の第一歩を作る。最初の設定は HUD の `visible`（表示 ON/OFF）。
- 設定変更を**リロード無し**で、既にロード済みのスクリーンへライブ反映する。
- ⚙ ボタンで、通知設定（notify.html）と同型の**専用設定スクリーン（オーバーレイ）**を開く。スキーマ駆動の共通レンダラで、どのプラグインの設定でも同一画面で吸収する。

非ゴール:
- boolean 以外の設定型（enum / number / text）の実装は今回行わない（枠だけ拡張可能にする）。
- プラグインが独自の設定 HTML を同梱する仕組みは作らない（スキーマ駆動に限定）。
- クロスオリジン iframe への設定配信は行わない（HUD は TOP フレームのみ描画するため不要）。
- WebMessagePort 等の双方向チャネルは導入しない（既存の `evaluateJavascript` パターンを踏襲）。

## アプローチ（採用案 A）

HUD は有効のまま据え置き、`visible` 設定で**描画だけ**を生きたまま切り替える。設定変更はネイティブから全 WEB スクリーンへ `evaluateJavascript` で push する。既存の `__ccRenderPlugins()` / `__ccRenderScreens()` / `__ccRenderNotify()` と同じ Kotlin→JS 呼び出しパターンの素直な拡張。

却下案:
- 案B（WebMessagePort 双方向）: フレーム横断に強いがコードベース未使用・実装が重く、今回の要件に過剰。
- 案C（永続化＋doc-start 再登録のみ、push 無し）: 結局リロードが必要で目的を満たさない。

## アーキテクチャ / コンポーネント

データの流れは「宣言（プラグイン）→ 保存（ネイティブ）→ 注入/配信（ネイティブ→Web）→ 反映（プラグイン）」の一方向＋設定 UI からの書き込み。

### 1. 設定スキーマの宣言（プラグイン側ヘッダ）

既存の `@settings true` と同じ行ベースで `@setting` 行を追加宣言する。

```js
// ==CCStudioPlugin==
// @name        focus-hud
// @settings    true
// @setting     visible boolean true HUD を表示
// ==/CCStudioPlugin==
```

- 書式: `@setting <key> <type> <default> <label...>`
  - `key`: 設定キー（英数 / `-` / `_`）
  - `type`: v1 は `boolean` のみ実装（パーサは未知の型を boolean にフォールバックせず、その行を無視）
  - `default`: 既定値（boolean は `true` / `false`）
  - `label`: 行末までを表示ラベルとして使う（日本語可、空白含む）
- 複数 `@setting` 行を許可。出現順を UI の表示順とする。
- `@settings true` が無くても `@setting` 行が1つ以上あれば `hasSettings = true` とみなす（宣言の二重化を避ける）。

`PluginMetaParser`（[PluginMeta.kt](../../../app/src/main/java/app/ccstudio/PluginMeta.kt)）は現在 `HashMap<String,String>` に1キー1値で畳んでいるため、複数行 `@setting` を集約できるよう**専用に収集**する。`PluginMeta` / `PluginInfo` に `settings: List<SettingDef>` を追加する。

```kotlin
data class SettingDef(
    val key: String,
    val type: String,        // "boolean"（v1）
    val default: String,     // 文字列表現で保持（"true"/"false"）
    val label: String,
)
```

メタヘッダの走査範囲は現在「先頭40行」。`@setting` を多数持つプラグインを想定し、この上限は**据え置き**（HUD は1行）。将来必要になれば別途拡張する。

### 2. 保存先（PluginStore）

[PluginStore.kt](../../../app/src/main/java/app/ccstudio/PluginStore.kt) の既存 `ccstudio_prefs`（SharedPreferences）に格納する。

- 保存キー: `setting:<pluginName>:<settingKey>` → 値の文字列表現（boolean は `"true"` / `"false"`）。
- 公開 API:
  - `fun settingValue(name: String, key: String): String?` — 生の保存値（未保存は null）。
  - `fun setSettingRaw(name: String, key: String, value: String)` — 永続化のみ（`apply()`）。
  - `fun effectiveSettings(): Map<String, Map<String, Any>>` — 全プラグインについて、スキーマ default を保存値で上書きし、**型に応じて coerce**（boolean は実 Boolean）したマージ結果。設定ランタイム注入と Bridge `getPluginSettings()` の素にする。
  - `fun settingsOf(name: String): List<SettingDef>` — UI レンダラ用に、対象プラグインのスキーマ＋現在値を取り出す素。
- 削除済みプラグインの掃除は今回は行わない（残存キーは無害。`effectiveSettings()` はスキーマに無いキーを出さない）。

### 3. ブリッジ（CcBridge）追加メソッド

[CcBridge.kt](../../../app/src/main/java/app/ccstudio/CcBridge.kt) にラムダ委譲で4つ追加（既存 notify 系と同じ構造）。

| メソッド | 役割 |
|---|---|
| `getPluginSettings(): String` | `effectiveSettings()` の JSON（`{"focus-hud":{"visible":true}, ...}`）。設定ランタイムが document-start で読む。 |
| `openPluginSettings(name: String)` | 対象プラグイン名を保持し、設定オーバーレイ（plugin-settings.html）を表示。 |
| `getSettingsView(): String` | 現在の対象プラグインの `{name, displayName, settings:[{key,type,default,label,value}]}` を JSON で返す。設定スクリーンが描画に使う。 |
| `setSetting(name, key, value: Boolean)` | 永続化（`setSettingRaw`）＋全 WEB スクリーンへライブ push。v1 は boolean のみ。 |
| `closePluginSettings()` | 設定オーバーレイを隠して Plugins 画面に戻す。 |

`setSetting` の値型は v1 では `Boolean`。将来 enum/number を入れる際に `value: String` + type 解釈へ拡張する（その時点で署名変更）。

### 4. 設定ランタイムの注入（MainActivity / ExtensionRuntime）

`registerScreenScripts()`（[MainActivity.kt](../../../app/src/main/java/app/ccstudio/MainActivity.kt) L300-317）で、**有効プラグイン群より前に**、静的な「設定ランタイム」を document-start 登録する。`pluginHandlers` に予約キー `__ccSettingsRuntime` で1本だけ持たせ、登録順を最初にする（`addDocumentStartJavaScript` は登録順に実行されるため、プラグインが読む前に `window.__ccPluginSettings` が用意される）。

設定ランタイム本体（静的文字列）:

```js
(function(){
  try { window.__ccPluginSettings = JSON.parse(window.CCStudio.getPluginSettings() || '{}'); }
  catch(e){ window.__ccPluginSettings = {}; }
  window.__ccApplyPluginSetting = function(plugin, key, val){
    var p = window.__ccPluginSettings[plugin] || (window.__ccPluginSettings[plugin] = {});
    p[key] = val;
    try {
      window.dispatchEvent(new CustomEvent('ccstudio:setting',
        { detail: { plugin: plugin, key: key, value: val } }));
    } catch(_){}
  };
})();
```

- ロード時に Bridge から**最新値を読む**ので、リロードしても設定が効く（doc-start 再登録は不要、generation も上げない）。
- クロスオリジン iframe では `window.CCStudio` が無い前提で try/catch し `{}` にフォールバック（HUD は TOP フレームのみ参照するので影響なし）。

ライブ push（`setSetting` の中）:

```kotlin
screens.webScreens().forEach {
    it.webView.evaluateJavascript(
        "window.__ccApplyPluginSetting && window.__ccApplyPluginSetting(" +
        "${JSONObject.quote(name)}, ${JSONObject.quote(key)}, $value);", null)
}
```

`$value` は boolean リテラル（`true`/`false`）。`evaluateJavascript` はメインフレームで実行され、ランタイムが定義した `__ccApplyPluginSetting` を呼ぶ。Plugins 画面自身の一覧は対象でないため触らない（設定スクリーン側で自分の状態を持つ）。

document-start 非対応端末では設定ランタイムも登録されない。この場合 `onPageFinished` フォールバック注入の直前に、`window.__ccPluginSettings = <effectiveSettings JSON>` を一度 `evaluateJavascript` する（ライブ push は不可。設定変更は次ロードで反映）。これは劣化動作として許容する。

### 5. 設定スクリーン（plugin-settings.html、オーバーレイ）

notify.html / switcher.html と**同型のオーバーレイ WebView**（`settingsView` フィールドを MainActivity に追加）。`openPluginSettings(name)` で表示、`closePluginSettings()` で `View.GONE`。表示直後に `evaluateJavascript("window.__ccRenderSettings && window.__ccRenderSettings();")` を撃つ（notify と同じ）。

plugin-settings.html はスキーマ駆動の共通レンダラ:
- `CCStudio.getSettingsView()` から `{name, displayName, settings:[...]}` を取得。
- ヘッダにプラグイン表示名、「‹ Plugins」戻るボタン（`closePluginSettings()`）。
- `settings[]` を走査してコントロール生成:
  - `type === 'boolean'` → notify.html と同じ `.tgl` トグル。`value` を初期 `aria-pressed` に反映。変更時 `CCStudio.setSetting(name, key, next)`。
  - 未知の type → そのキーは描画スキップ（前方互換）。
- スタイル/トグルは notify.html のものを流用（`--chassis` 等の CSS 変数、`.row` / `.tgl`）。

### 6. focus-hud.js の改修

- 起動時に表示状態を読む: `var visible = (window.__ccPluginSettings && window.__ccPluginSettings['focus-hud'] && window.__ccPluginSettings['focus-hud'].visible) !== false;`（既定 true、未定義でも true）。TOP フレームの共有 `topWin().__ccStudioHudVisible` に持たせ、フレーム間で一貫させる。
- `renderHud()` を `visible` でゲート: false のとき、既存の HUD 要素があれば `display:none`、無ければ生成しない。**監視（watchAll）とログ収集は継続**（コスト極小、再表示時に履歴が残る）。
- ライブ反映: TOP フレームで `window.addEventListener('ccstudio:setting', fn, false)` を1回だけ張り、`detail.plugin === 'focus-hud' && detail.key === 'visible'` のとき `__ccStudioHudVisible` を更新して `renderHud(true)` を即実行。
- 冪等性は既存方針を踏襲（タイマ/リスナの二重設置ガード）。

## データフロー

設定スクリーンを開く:
1. Plugins 画面で ⚙ タップ → `CCStudio.openPluginSettings('focus-hud')`
2. ネイティブ: 対象名保持 → `settingsView` を VISIBLE → `__ccRenderSettings()`
3. plugin-settings.html: `getSettingsView()` → トグル描画（`visible` の現在値で初期化）

設定をライブ変更:
1. 設定スクリーンでトグル → `CCStudio.setSetting('focus-hud','visible',false)`
2. ネイティブ: `setSettingRaw` で永続化 → 全 WEB スクリーンへ `__ccApplyPluginSetting('focus-hud','visible',false)`
3. 各スクリーンのランタイム: `__ccPluginSettings` 更新 + `ccstudio:setting` 発火
4. focus-hud（TOP）: イベント受信 → HUD を即 `display:none`（リロード無し）

リロード後:
1. ランタイムが document-start で `getPluginSettings()` を読む → `visible:false` が反映済み
2. focus-hud 起動時に false を読んで非表示で開始

## 運用フロー（解決する体験）

HUD を一度有効化（このときだけ要リロード）→ 以降のデバッグ中は ⚙ の「HUD を表示」トグルで**ライブに出し入れ**。keyboard-suppress は触らないので再現状態は維持される。

## エッジケース

- document-start 非対応端末: 設定ランタイム未登録。`onPageFinished` で `__ccPluginSettings` を一度注入。ライブ push 不可（次ロードで反映）＝劣化動作として許容。
- クロスオリジン iframe: `window.CCStudio` 不在で try/catch → `{}`。HUD は TOP のみ参照なので無影響。
- 設定スクリーンを開かず削除されたプラグイン: 残存 prefs キーは無害。`effectiveSettings()` がスキーマ外キーを出さない。
- スキーマに無い保存値 / 未知 type: レンダラ・effectiveSettings の双方でスキップ。
- 多重注入・再注入（VS Code の document.open 等）: 既存の冪等ガードを維持。
- `setSetting` は generation を上げない（リロードを誘発しない）。stale 表示にも影響させない。

## テスト方針

ユニット（純関数）:
- `PluginMetaParser`: 複数 `@setting` 行の収集、`@setting` のみで `hasSettings=true`、不正行/未知 type の無視。
- `PluginStore.effectiveSettings()`: default と保存値のマージ、boolean coerce、スキーマ外キー除外。

手動（実機 / 既存スクリーンで再現性確認）:
- HUD 有効化 → ⚙ で設定スクリーン表示 → トグル OFF で**リロード無し**に HUD が消える / ON で再表示。
- keyboard-suppress を動作させた状態で HUD をトグルしても、再現状態（フォーカス/キーボード挙動）が維持される。
- 設定変更後にスクリーンをリロード → 設定が保持される。
- 複数 WEB スクリーンを開いた状態で、全スクリーンに反映される。

## 変更ファイル一覧

ネイティブ（Kotlin）:
- [PluginMeta.kt](../../../app/src/main/java/app/ccstudio/PluginMeta.kt): `SettingDef` 追加、`@setting` 収集、`PluginMeta.settings`。
- [PluginStore.kt](../../../app/src/main/java/app/ccstudio/PluginStore.kt): `PluginInfo.settings`、`settingValue` / `setSettingRaw` / `effectiveSettings` / `settingsOf`。
- [CcBridge.kt](../../../app/src/main/java/app/ccstudio/CcBridge.kt): `getPluginSettings` / `openPluginSettings` / `getSettingsView` / `setSetting` / `closePluginSettings` とラムダ。
- [MainActivity.kt](../../../app/src/main/java/app/ccstudio/MainActivity.kt): 設定ランタイムの document-start 登録（`registerScreenScripts`）、ライブ push、`settingsView` オーバーレイの open/close、Bridge 配線、`getSettingsView` JSON 生成、非対応端末フォールバック。

アセット / プラグイン:
- 新規 `app/src/main/assets/plugin-settings.html`: スキーマ駆動の共通設定レンダラ。
- [plugins.html](../../../app/src/main/assets/plugins.html): ⚙ ボタンに `openPluginSettings(p.name)` を配線（placeholder を実装に）。
- [focus-hud.js](../../../plugins/focus-hud.js): `@setting visible` 宣言、`visible` ゲート、`ccstudio:setting` 購読。

## オープン事項

- 設定スクリーンの「戻る」先は Plugins 画面（`closePluginSettings`）で固定。switcher へ直接戻す導線は今回入れない。
- boolean 以外の型は本設計の枠（SettingDef.type / レンダラの type 分岐 / setSetting の値型）を拡張して別途対応。
