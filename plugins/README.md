# CC Studio プラグイン規約

CC Studio のプラグインは、アプリが各スクリーンの WebView（code-server の workbench）へ注入する
単体の `.js` ファイル。このディレクトリの 8 本が同梱プラグインで、アプリの管理スクリーンから
ON/OFF・追加・削除できる。ここでは 8 本から抽出した共通規約をまとめる（実装の典拠は各ソースと
`app/src/main/java/app/ccstudio/PluginMeta.kt` / `ScreenFactory.kt`）。

## 1. メタヘッダ

ファイル先頭 40 行以内に userscript 風のメタブロックを書く。`PluginMetaParser` が解析する。

```js
// ==CCStudioPlugin==
// @name        my-plugin
// @version     1.0.0
// @description 何をするプラグインかの短い説明（管理スクリーンのカードに表示）。
// @run-at      document-start
// @all-frames  true
// @setting     visible boolean true HUD を表示
// ==/CCStudioPlugin==
```

| フィールド | 意味 | 既定値 |
|---|---|---|
| `@name` | 表示名。**設定の namespace にもなる**（下記）。無ければファイル名 | — |
| `@version` | 表示用の版数。挙動には影響しない | — |
| `@description` | 管理スクリーンのカードに出す説明 | — |
| `@run-at` | `document-start` / `document-idle`。それ以外の値は document-start に正規化 | `document-start` |
| `@all-frames` | `true`: 全フレーム × document-start 登録。`false`: メインフレームのみ・ロード完了後に注入 | `true` |
| `@setting` | `<key> <type> <default> <label...>` の設定宣言（複数可）。v1 は `boolean` のみ | — |

補足:
- ファイル名がプラグインの内部 ID（ブリッジ操作のキー）。`@name` は表示と設定 namespace。
- `@settings true` でも「設定あり」と見なされる（`@setting` 行があれば不要）。

## 2. 設定ランタイム

アプリは各 WEB スクリーンに、プラグインより先に設定ランタイムを 1 本注入する（`ScreenFactory` の
`SETTINGS_RUNTIME_JS`）。プラグインからは次の 2 つで読む・追従する:

```js
// 現在値を読む（namespace は @name）
var conf = (window.__ccPluginSettings || {})['my-plugin'] || {};
if (conf.visible !== false) { /* ... */ }

// リロード無しのライブ反映（⚙ 設定画面で変更されたとき飛んでくる）
window.addEventListener('ccstudio:setting', function (e) {
  var d = e.detail; // { plugin, key, value }
  if (d.plugin !== 'my-plugin') return;
  // 値を反映する
});
```

設定値の永続化・配信はネイティブ側が持つ。プラグイン側で保存処理は書かない。

## 3. フレーム構成の作法

workbench は多層 iframe（メインフレーム / webview 本体フレーム / チャット・プレビューのコンテンツ
フレーム）で構成される。狙う DOM がどのフレームに居るかで方式を選ぶ:

- **全フレーム常駐（既定）** — `@all-frames true` × document-start で全フレームに同じスクリプトが
  入る。各インスタンスは自分のフレームだけを見る（例: keyboard-suppress）。
- **非トップ → トップへ集約** — 検知は各フレーム、表示・報告はトップだけで行う場合、非トップは
  `postMessage` でトップへ送る。トップのインスタンスが集約してネイティブへ報告する
  （例: state-observer, focus-hud, selectable-text）。
- **BroadcastChannel 橋渡し** — VS Code API を持つフレーム（`__vscode_post_message__` 保持）へ
  依頼を送る必要がある場合に使う（例: chat-link-open がチャットフレームからタップを横取りして
  webview 本体フレームへ open_file を依頼）。
- **メインフレームのみ** — `@all-frames false`。document-start 登録はされず、ページのロード完了後に
  メインフレームへ注入される（document-idle 相当）。

DOM の特定は code-server / 公式拡張のクラス名に依存しない（更新で壊れるため）。テキストや相対時刻
のような「必ず出る手掛かり」を TreeWalker 等で探す（例: session-list-readable）。

## 4. ネイティブ連携（window.CCStudio ブリッジ）

プラグインが直接使ってよいブリッジの口は最小限にする。現状の利用実績:

| メソッド | 用途 | 使用プラグイン |
|---|---|---|
| `CCStudio.setSessionState(busy, disconnected)` | 処理中/切断の状態報告（スクリーン一覧・通知に反映） | state-observer |
| `CCStudio.observerLog(json)` | 状態遷移・突発キャンセルの永続ログ報告 | state-observer |

これ以外の口（ダウンロード・スクリーン操作・設定など）はアプリ同梱の `bootstrap.js` と管理系
HTML（switcher / plugins / notify / log）が使う。プラグインから安易に呼ばない。
ブリッジの全メソッドは `app/src/main/java/app/ccstudio/CcBridge.kt` 参照。

## 5. 診断の作法

- 共有ログバッファ: `window.top.__ccStudioFocusLog` に行を積むと **focus-hud** が画面上に時系列
  表示する（focus-hud が無効でも配列に積むだけで無害）。プレフィックスで発信元を示す
  （例: keyboard-suppress は「KB」、session-list-readable は「SLR」）。
- ログが多いプラグインは専用バッファに分離し、focus-hud 側でセクション表示する
  （例: keyboard-suppress の「-- KB --」）。
- 一時的な調査専用プラグイン（例: select-diag）は `@description` に「調査が終わったら削除」と
  明記し、常用しない。

## 6. 命名・バージョニング

- ファイル名 = 内部 ID。kebab-case（例: `chat-link-open.js`）。
- `@name` はファイル名から拡張子を除いたものに揃える（表示と設定 namespace のブレを防ぐ）。
- 挙動が変わる修正では `@version` を上げる（パッチ運用。例: keyboard-suppress は不具合切り分けの
  たびに 1.2.x を bump）。
- ヘッダ直後に「何を・どの機構で・なぜこの方式か」を数行のコメントで書く。設計文書がある場合は
  `docs/specs/...` へのパスを添える。
