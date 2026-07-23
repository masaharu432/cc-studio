# CC Studio: 設定ランタイム v2（number 型）と ui-zoom v0.5 設計 (v1.0)

最終更新: 2026-07-23
関連: [plugins/README.md](../../plugins/README.md) §1-2（メタヘッダ・設定ランタイム v1）,
[2026-06-29-plugin-settings-screen-design.md](2026-06-29-plugin-settings-screen-design.md)（⚙ 画面）,
[2026-07-22-ui-zoom-plugin-design.md](2026-07-22-ui-zoom-plugin-design.md)（ui-zoom v0.4 系）

## 1. 背景と動機

ui-zoom の倍率チューニング（外枠縮小率・フォント戻し率）は現状ファイル先頭定数で、変更のたびに
「Claude が定数編集 → ユーザーがダウンロード → 再インポート → 手動リロード」の往復が必要だった
（v0.4.x で実際に 5 往復）。設定ランタイム v1 は boolean のみのため数値を UI に出せない。
**number 型を追加し、⚙ 設定スクリーンのステッパーからライブ（リロード無し）で調整可能にする。**

## 2. ゴール / 非ゴール

**ゴール**:
- `@setting` の number 型（default/min/max/step 宣言）と、⚙ 画面の − / + ステッパー UI。
- 値変更のライブ反映（既存の `ccstudio:setting` 経路。リロード不要）。
- ui-zoom v0.5: 4 つの数値設定を公開（§7）。文字系は「**縮小前の見かけ = 1.0**」の意味論。

**非ゴール（YAGNI）**:
- enum / string 型、スライダー UI、プラグイン独自のカスタム設定画面。
- 設定値の import/export。

## 3. メタヘッダ拡張（PluginMeta.kt）

```
@setting     <key> number <default> <min> <max> <step> <label...>
@setting:ja  <key> <日本語ラベル...>            （従来どおりラベルのみ）
```

- boolean は従来形式のまま（`<key> boolean <default> <label...>`）。
- `SettingDef` に `min: Double?` / `max: Double?` / `step: Double?` を追加（boolean は null）。
- パーサ: type=number のときのみ 7 分割（key type default min max step label）。数値でない・
  min>max・step<=0 は**行ごと無効**（v1 の「未知 type は無効」と同じ姿勢）。
- **後方互換**: 旧アプリ（v1 パーサ）は number 行を無効として無視 → ⚙ に出ないだけで、
  プラグインは自前の既定値で動く。旧プラグイン（boolean のみ）は新アプリでそのまま動く。

## 4. 保存と合成（PluginStore / PluginSettings）

- 保存は従来どおり raw 文字列（`setting:<plugin>:<key>`）。
- `PluginSettings.coerce`: number は `toDoubleOrNull() ?: default` の後、**[min,max] へ clamp**。
  JSON には Number として出す → `window.__ccPluginSettings[plugin][key]` が数値になる。

## 5. ブリッジとライブ反映（CcBridge / MainActivity）

- `setSetting(name, key, value)` の value を **raw 文字列**へ一般化（boolean は "true"/"false"）。
  既存 Boolean 版シグネチャは置換（呼び出し元は plugin-settings.html のみ）。
- `pushSettingLive(name, key, raw)`: coerce 済みの値を JSON リテラルで
  `__ccApplyPluginSetting(plugin, key, <json>)` へ渡す（現在の Boolean 直書きを一般化）。
  フレームツリー再伝搬（settings runtime の postMessage）は値が any になるだけで変更なし。

## 6. ⚙ 設定画面（plugin-settings.html）

- type==="number" の行: `ラベル  [−] 0.75 [+]`。step 刻みで増減し min/max で clamp、
  表示は step の桁に合わせる（0.05 → 小数 2 桁）。タップごとに `setSetting` → ライブ反映。
- boolean 行は従来のトグルのまま。フィルタ `type==='boolean'` を `boolean|number` に広げる。

## 7. ui-zoom v0.5 の公開設定

| key | 型 | 既定 | 範囲/刻み | 意味 |
|---|---|---|---|---|
| `enabled` | boolean | true | — | 全体の ON/OFF（従来） |
| `shrink` | number | 0.75 | 0.50〜1.00 / 0.05 | 外枠縮小率 Z（本来の目的: バー・外枠の幅） |
| `sidebarFont` | number | 0.90 | 0.70〜1.30 / 0.05 | サイドバー文字。**1.0 = 縮小前の見かけ** |
| `uiFont` | number | 0.90 | 0.70〜1.30 / 0.05 | その他 UI 文字（タブ・パネル・ステータスバー・メニュー等） |
| `claudeFont` | number | 1.00 | 0.70〜1.30 / 0.05 | webview（チャット/セッション一覧）丸ごと倍率 |
| `diag` | boolean | true | — | HUD 診断（従来） |

実装対応（v0.4.5 からの差分）:
- 定数 Z / FONT_TRIM を廃し、tick ごとに設定を読む（既に毎 tick 読む構造なので自然に追従）。
- viewport content は shrink から動的生成。shrink 変更時は meta 書き換え＋resize（既存 applyTop が
  値比較で検知）。**連打対策に 300ms デバウンス**（フォント/zoom はデバウンス不要・軽量）。
- フォント上書き: sidebarFont → `.part.sidebar > .content`、uiFont → ルート・
  `.part.editor > .content`・`.part.panel > .content`・`.part.auxiliarybar > .content`・
  `.part.statusbar`。書き込み値 = 素の実測値 × (係数 / shrink)（textZoom 除去は v0.4.3 どおり）。
- 葉 webview: top の返信を `z = shrink / claudeFont` に一般化（葉は 1/z を掛ける → 正味 claudeFont。
  claudeFont=1 で従来の等倍戻しと同値）。旧アプリでは設定が出ないため全て既定値で動作。
- プラグイン側でも値を [min,max] へ clamp（壊れた保存値への防御）。

## 8. リスクと留意

- **ステッパー連打**: viewport 再書き換えの度に workbench が再レイアウトする。300ms デバウンス
  で 1 回に纏める。フォント・zoom は軽いので即時。
- **設定名の意味論**: 文字系 1.0 = 「縮小前の見かけ」。shrink を変えても文字の見かけが不変に
  なるよう、内部係数は常に `係数 / shrink` で再計算する。
- **旧アプリ × 新プラグイン**: number 設定が UI に出ない＋`__ccPluginSettings` に number が
  入らない → プラグイン内既定値で動く（v0.4.5 相当の挙動）。scaleApplied ガードも従来どおり。

## 9. テスト

- **PluginMetaTest**（JVM 単体）: number 解析・min/max/step・不正行無効・boolean 後方互換。
- **PluginSettingsTest**: coerce の clamp・default フォールバック・JSON 数値化。
- **ハーネス（headless）**: `__ccPluginSettings` に number を与え、shrink/フォント係数/claudeFont の
  ライブ変更（`ccstudio:setting` 発火）で meta・#cc-uz-font・葉 zoom が追従することを検証。
- **workbench-probe（実 code-server）**: v0.5 を注入し係数変更で computed 値が式どおり変わること。
- **実機**: ⚙ ステッパー操作 → リロード無しで見た目が変わる・値がリロード後も保持される。

## 10. ファイル構成

```
app/src/main/java/app/ccstudio/PluginMeta.kt        # SettingDef 拡張・number 解析
app/src/main/java/app/ccstudio/PluginSettings.kt    # coerce: number + clamp
app/src/main/java/app/ccstudio/CcBridge.kt          # setSetting raw 文字列化
app/src/main/java/app/ccstudio/MainActivity.kt      # pushSettingLive 一般化
app/src/main/assets/plugin-settings.html            # number ステッパー UI
plugins/ui-zoom.js                                  # v0.5.0（4 数値設定・動的 Z）
plugins/README.md                                   # §1 表の @setting 形式を v2 に更新
app/src/test/java/app/ccstudio/PluginMetaTest.kt    # テスト追加
```
