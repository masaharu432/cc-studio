# CC Studio: プラグイン・マニフェスト（埋め込みメタヘッダ）設計

最終更新: 2026-06-28
関連: [WebView 拡張ランタイム 設計](2026-06-28-webview-extension-runtime-design.md)（注入土台）/
[キーボード抑制プラグイン 設計](2026-06-28-keyboard-suppress-plugin-design.md)。

## 1. 方針：マニフェストは「別ファイル」ではなく「JS 埋め込みヘッダ」
プラグインは単一 `.js`。説明・バージョン等のメタ情報と注入挙動の宣言は、ファイル先頭の
**userscript 風メタヘッダ**で持つ（manifest.json + zip の同梱パッケージにはしない）。

理由:
- **単一ファイルのまま**＝SAF で .js を1枚選ぶ現行フローと完全一致（解凍・パス管理・改ざん面を増やさない）。
- **自己記述で同期ズレが起きない**（説明とコードが同じファイル）。
- **確立した慣習**（Tampermonkey / Greasemonkey のメタブロック、ブラウザ拡張の `content_scripts` 宣言）に倣う
  ＝再発明しない。

## 2. 形式
```js
// ==CCStudioPlugin==
// @name        keyboard-suppress
// @version     1.0.0
// @description 物理キーボードの自動表示を抑制する。…
// @settings    true            (任意。設定UIを持つか。既定 false)
// @run-at      document-start   (任意。document-start | document-idle。既定 document-start)
// @all-frames  true             (任意。true | false。既定 true)
// ==/CCStudioPlugin==
(function(){ /* 本体 */ })();
```
- ブロックは**ファイル先頭40行以内**を走査（[PluginMetaParser](../../app/src/main/java/net/<tailnet>/ccstudio/PluginMeta.kt)、純関数＋単体テスト）。
- フィールド名はハイフン可（`@run-at` / `@all-frames`）。値は `// @key value` 形式。

### フィールド
| フィールド | 既定 | 用途 |
| --- | --- | --- |
| `@name` | ファイル名 | **表示名**。一覧のタイトル。内部ID（操作キー）は引き続き**ファイル名**。 |
| `@version` | （空） | バージョンバッジ表示。 |
| `@description` | （空） | 説明文表示。 |
| `@settings` | false | 設定UI（⚙）を出すか。設定実体は将来フェーズ。 |
| `@run-at` | document-start | 注入タイミング。 |
| `@all-frames` | true | 全フレーム注入か（false でトップフレームのみ）。 |

## 3. ID と表示名
- **ID = ファイル名**（`plugins/<name>.js` の `<name>.js`）。`setEnabled/removePlugin` 等の bridge 呼び出しキー。
  安定IDとして使う（`@name` を変えても参照が壊れない）。
- **表示名 = `@name`**（無ければファイル名）。`pluginsJson` の `displayName` として UI へ渡す。
  UI はタイトルに `displayName`、操作に `name`(ID) を使う。

## 4. 注入挙動のマッピング（プラットフォーム制約込み）
WebView で素直に使える注入機構は2つ:
- **(a) `addDocumentStartJavaScript(["*"])`** … 全フレーム × document-start（[ExtensionRuntime](../../app/src/main/java/net/<tailnet>/ccstudio/ExtensionRuntime.kt)）。
- **(b) `evaluateJavascript`@`onPageFinished`** … メインフレーム × document-idle 相当。

ヘッダの宣言は次のように土台が出し分ける（[MainActivity] `registerScreenScripts` / `onPageFinished`）:

| `@all-frames` | 採用機構 | 備考 |
| --- | --- | --- |
| `true`（既定） | (a) 全フレーム×document-start | 各フレームがページのJSより先にリスナを張れる（例: keyboard-suppress）。 |
| `false` | (b) メインフレーム×document-idle | トップフレームだけで動くUI系プラグイン向け。 |

- **制約**: WebView には「全フレーム × document-idle」「メインフレームのみ × document-start」を厳密に行う API が
  無い。そのため実効モードは `@all-frames` で2択に収束し、`@run-at` は次のように扱う:
  - `@all-frames true` のとき：機構(a)の都合上つねに document-start（`@run-at document-idle` 指定でも start に倒す）。
  - `@all-frames false` のとき：機構(b)＝document-idle（onPageFinished）。
  - → `@run-at` は主に表示・将来用のメタ。実挙動の主スイッチは `@all-frames`。設計上は両方を解析・公開する。
- document-start 非対応端末では全有効プラグインを (b) でメインフレーム注入（フォールバック）。

## 5. 反映タイミング（ブラウザ拡張と同じ思想）
- 登録/解除は「以後のロード」に効く。新規スクリーンは初回ロード後に一度 reload して確実に反映
  （[MainActivity] `reloadOnFirstLoad`）。ON/OFF 変更は `bumpGenerationAndSync` で各スクリーンに再登録。

## 6. 非ゴール（当面）
- `@match`（URL/スクリーン別の注入対象指定）: 必要になったら追加（現状は全 WEB スクリーン対象）。
- `@author` / `@homepage` / `@icon` 等: UI が出すときに追加。
- 設定（`@settings true`）の実体UI・永続化: 将来フェーズ（⚙ ボタンは表示のみ）。
