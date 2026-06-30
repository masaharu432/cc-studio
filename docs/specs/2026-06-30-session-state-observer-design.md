# CC Studio セッション状態オブザーバ（処理中 / 接続切れ）設計

- 日付: 2026-06-30
- 種別: 設計（feature）
- 関連: [接続改善メモ](../notes/2026-06-30-connection-tool-cancel.md)

## 目的

CC Studio（Android → code-server WebView → Claude Code）越しのセッションで、

1. **そのスクリーンの Claude Code が処理中か**を可視化する。
2. **code-server セッションの接続が切れている／再接続中か**を可視化する。

加えて、両遷移を時刻付きで記録し、接続メモにある「ツールの突発キャンセル」が
**接続瞬断由来か、自前の focus 抑制（keyboard-suppress の `.blur()`）由来か**を後から
切り分けられる診断データを自動で貯める。

「処理中」と「接続切れ」は同じ観測点（WebView DOM）から取れる同一“セッション状態”の
別の面なので、1つのオブザーバで両方を扱う。

## 方式の選択

- **方式A（採用）**: 各 WEB スクリーンの DOM を `MutationObserver` で監視し、状態を
  ネイティブへ報告する。各スクリーン＝1 WebView なので「このタブが回っている」を
  取り違えずに取れる。サーバ／hook 変更が不要。
- **方式B（v1 スコープ外）**: Claude Code hooks → 既存 `wss://host/cc-notify/ws` で
  権威的な busy 開始/終了を流す。DOM 非依存で堅牢だが、cwd↔スクリーンの突き合わせと
  サーバ側 hook 追加が要る。本設計のロガーが将来 B を足すときの布石になる。

背景: 非アクティブスクリーンは `View.GONE` でビュー階層に残る（`ScreenManager` A案）ため、
裏で回っているスクリーンでも MutationObserver は動き続け、状態を報告できる。

## アーキテクチャ

### データフロー

```
[WEB スクリーン DOM]
   │  MutationObserver(body, subtree) + ~1s フォールバックポーリング
   ▼
 detectBusy() / detectDisconnected()   (bootstrap.js・常時注入の IIFE)
   │  状態遷移（デバウンス ~800ms）
   ├─▶ 自分の ︙ ボタンをローカルで色変え（ネイティブ往復なし）
   ├─▶ window.top.__ccStudioFocusLog に {t, busy, disconnected, matched} を追記
   └─▶ window.CCStudio.setSessionState(busy, disconnected)   [ブリッジ／screenId を内包]
          ▼
       MainActivity.onSessionState(screenId, busy, disconnected)
          ├─ Screen.busy / Screen.disconnected を更新
          ├─ refreshSwitcher()        （switcher が開いていれば __ccRenderScreens）
          └─ NotifyState 件数更新 → KeepAliveService ACTION_REFRESH（常駐通知）
```

### コンポーネント

#### 1. 状態モデル（Kotlin）

- `Screen.kt`: `var busy: Boolean = false` / `var disconnected: Boolean = false` を追加。
- `ScreensJson.kt`: `ScreenRow` に `busy` / `disconnected` を追加し、`build()` で直列化。
- `ScreenManager.rows()`: 各 `Screen` の `busy` / `disconnected` を `ScreenRow` に写す。

#### 2. ブリッジのスクリーン識別

現状 `addJavascriptInterface(buildBridge(), "CCStudio")` は WebView ごとに別インスタンスだが、
委譲先ラムダが MainActivity を閉じ込めるだけで**どのスクリーンが呼んだか分からない**。

- スクリーン ID を**先に採番**し、`newConfiguredWebView(screenId)` →
  `buildBridge(screenId)` へ渡す。`createWebScreen` / `createSystemPluginsScreen` は
  `val id = screens.nextId()` を1回だけ呼び、WebView と `Screen` に同じ ID を使う。
- `CcBridge` に `@JavascriptInterface fun setSessionState(busy: Boolean, disconnected: Boolean)`
  を追加し、`onSessionState(screenId, busy, disconnected)` を呼ぶ。
- `MainActivity.onSessionState`（UI スレッド）: ID でスクリーンを引き、値が変わったときだけ
  `Screen` を更新 → `refreshSwitcher()` ＋ 常駐通知件数のリフレッシュ。

SYSTEM_PLUGINS スクリーン（plugins.html）は観測対象外。報告が来ても WEB 以外は無視する。

#### 3. 観測ロジック（state-observer プラグイン・all-frames document-start）

**重要（iframe）**: claude-code の入力欄・停止ボタンは code-server の **webview iframe 内**に居る。
メインフレーム専用の `evaluateJavascript`（= bootstrap.js の注入経路）では届かない。よって観測は
selectable-text と同じ **all-frames × document-start** の作法で全フレームに注入する必要があり、
bootstrap.js ではなく独立プラグイン `plugins/state-observer.js`（トグル可能）として実装する。

- 各フレームが自分の DOM を `MutationObserver`（throttle）＋約1秒ポーリングで検知。
- 非トップフレームは結果を `window.top.postMessage({k,id,busy,disc,matched}, '*')` でトップへ送る
  （直接 `window.top` プロパティ参照はクロスオリジンで失敗しうるため postMessage を使う）。
- **トップフレームだけ**が `message` を受けてフレーム別レジストリに集約（staleness で除去）、
  OR を取り、デバウンスして `CCStudio.setSessionState` を呼び ︙ボタンを塗りログを積む。
- `detectBusy()`: **on-device で調整しやすいよう小関数に集約**。複数ヒューリスティックの OR:
  - 停止/中断ボタン: `aria-label` / `title` が `stop|interrupt|cancel|中断|停止` に一致する可視ボタン。
  - 処理中ステータス文言（"Honking…" 等の動的ステータス行）。
  - いずれか1つでも真なら busy。
- `detectDisconnected()`: code-server が出す接続喪失 UI（"Disconnected" / "Reconnecting…"
  オーバーレイ／ダイアログ）の存在。
- 状態遷移時（**off 方向は ~800ms デバウンス**、on 方向は即時）:
  1. 自分の ︙ ボタンをローカルで色変え（処理中＝青パルス、接続切れ＝赤）。
  2. `window.top.__ccStudioFocusLog`（無ければ生成）に
     `{t: Date.now(), tag:'STATE', busy, disconnected, matched:<該当セレクタ名>}` を push。
  3. `window.CCStudio.setSessionState(busy, disconnected)` を呼ぶ（メソッド存在チェック付き）。
- 可能なら "STOP"/「don't want to take this action」相当のキャンセル文言出現も
  `{tag:'CANCEL'}` としてログに積む（接続メモの相関用。表示はしない）。

セレクタは実機でしか確定しないため、ヒューリスティックは1箇所に集約し、**マッチした
セレクタ名をログに残す**ことで実機で詰められるようにする。

#### 4. 表示3面

- **switcher 各行**（`switcher.html`）: `__ccRenderScreens` の行描画で、`busy` ならスピナー、
  `disconnected` なら赤●を出す。`stale` バッジと同じ位置・流儀。
- **常駐通知**（`KeepAliveService.buildKeepAliveNotification`）: `NotifyState` に
  `busyCount` / `disconnectedCount` を足し、本文に「起動中 N / 処理中 M / 接続切れ K」を併記。
  件数が変わったら既存 `ACTION_REFRESH` で貼り直す（`refreshKeepAliveScreenCount` と同経路）。
- **︙ ボタン**: 各スクリーンの JS が自分の状態で塗る（ネイティブ往復なし）。
  処理中＝青パルス、接続切れ＝赤、通常＝既存グラデーション。

#### 5. 診断ログ

`window.top.__ccStudioFocusLog` を keyboard-suppress / focus-hud と共有して相乗りする。
focus-hud が表示するので、別 UI は追加しない。これにより接続メモの「日時・直前操作・
再試行可否を貯める」が自動化され、突発キャンセルの真因（接続 or blur）を切り分けられる。

## エラー処理・制約

- **セレクタ未確定**: ヒューリスティック集約＋マッチ内容ログで、出荷後に実機で詰める前提。
  誤検知時も ︙ 色とバッジが出るだけで機能破壊はしない。
- **デバウンス**: off 方向 ~800ms。連続ツール呼び出し間の瞬きと通知ばたつきを抑える。
- **背景スクリーン**: `View.GONE` で階層に残るので検知は継続。ただし全アプリ背景化時は
  全 WebView が pause（想定内）。復帰時、次の Observer 発火か次回ポーリングで再同期する。
- **冪等性**: IIFE は二重注入ガード。`setSessionState` は値が変わったときだけネイティブ側を更新。

## テスト

- **Kotlin 単体**:
  - `ScreensJson` が `busy` / `disconnected` を直列化する。
  - `ScreenManager.rows()` が `Screen` の2フラグを `ScreenRow` に写す。
  - `NotifyState` の `busyCount` / `disconnectedCount` 集計。
- **JS（v1 は実機目視）**: focus-hud ログで busy/disconnected/CANCEL 遷移を確認する手順を
  チェックリスト化（処理開始→処理中表示、停止→解除、機内モード等で接続切れ表示）。

## スコープ外（v1）

- 方式B（hooks → cc-notify WS の権威的 busy 信号）。本ロガーが布石。
- 突発キャンセルの自動リカバリ（再試行）。今回は可視化と原因切り分けデータの収集まで。
