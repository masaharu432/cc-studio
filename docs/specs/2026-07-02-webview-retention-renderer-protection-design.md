# WebView 保持とレンダラ保護 設計・実装記録

- 日付: 2026-07-02
- 種別: 設計（実装済みの記録。APK 260702-1503 / commit d09dd05 で反映）
- 関連: [突発キャンセル解析](../notes/2026-07-02-tool-cancel-analysis.md) /
  [接続改善メモ](../notes/2026-06-30-connection-tool-cancel.md) /
  [観測ログ永続化 設計](2026-07-01-observer-log-persistence-design.md)

## 目的

CC Studio の各スクリーン（WebView 上の code-server + Claude Code）で、**アプリが背面にある間も
実行中のターンを生かし続ける**こと。および、それでも死ぬ場合に**原因が永続ログに残る**こと。

背景: 突発ツールキャンセルの確定機構（解析ノート参照）は
「webview 破棄 → 拡張 comms.shutdown() → CLI 権限ストリーム close → 保留リクエスト一括 reject」。
つまり **WebView を死なせない／作り直させないことがアプリ側でできる最大の防御**。

## プロセスモデル（前提知識）

```
[アプリ本体プロセス]                    [WebView レンダラプロセス]
  MainActivity / 全スクリーンの          ページ描画・JS 実行の実体。
  WebView オブジェクト                   Android 8+ ではサンドボックス化された
  KeepAliveService (FGS, dataSync)       別プロセスで、アプリの全 WebView が共有。
  → FGS が守るのはこちらだけ            → FGS の保護外。既定ポリシーは
                                           「非可視なら優先度放棄」＝背面で kill 候補
```

- 常駐通知（FGS）とオーディオ keepalive は**別機構**。無音オーディオ（cc-web 資産）は
  「ブラウザは FGS を持てない」ための代替であり、自アプリでは FGS＋本設計のレンダラ対策が本筋。
- **Android の仕様**: レンダラが死んだとき `WebViewClient.onRenderProcessGone` を処理しないと、
  **アプリ本体プロセスごと強制終了**される。＝ FGS を素通りする抜け穴。

## スクリーン保持の設計（既存・変更なしで正しいと確認済み）

| 機構 | 実装 | ねらい |
|---|---|---|
| Activity 再生成の回避 | manifest `configChanges` を網羅（orientation/uiMode/density/fontScale 等） | 回転・夜間モード・他アプリから戻る際の onCreate→全 WebView 再構築を防ぐ |
| タスク維持 | `launchMode="singleTask"`、Back は `moveTaskToBack`（finish しない） | Activity と全 WebView をメモリ保持したまま背面へ |
| スクリーン切替 | `ScreenManager` が visibility 切替のみ（非アクティブは GONE、destroy しない） | 裏スクリーンのターン・WS を維持 |
| 背面でも JS 継続 | `webView.onPause()/pauseTimers()` を**呼ばない** | 背面でのターン監視・接続維持を優先（電池より生存性） |
| 破棄と復元 | close 時のみ removeView+destroy。URL/active は `ScreenStore` に永続化 | プロセス死からの復元経路 |

## レンダラ保護の設計（今回追加）

### 1. `onRenderProcessGone` の一元処理（道連れクラッシュ防止＋記録＋復旧）

- 全 WebView（スクリーン・switcher・notify/log/settings オーバーレイ）のクライアントを
  共通基底 `CcWebViewClient` に統一し、`onRenderProcessGone` を必ず処理する。
- 処理内容（`MainActivity.handleRendererGone`）:
  1. `rendererGoneHandled` フラグで**一度だけ**動く（レンダラは全 WebView 共有のため、
     1回の死で全クライアントへコールバックが殺到する）。
  2. `ObserverLog.lifecycle` に **`renderer-crash`（didCrash=true）/ `renderer-killed`（OS による kill）**
     を記録。append は同期 flush なので、後続の再構築より先にディスクに残る。
  3. `recreate()` で Activity を作り直す。onCreate の既存復元経路（ScreenStore）で全スクリーンが
     復旧する。**個別 WebView の差し替えはしない**（共有レンダラ死＝全 WebView 使用不能のため、
     部分復旧は成立しない。recreate が最少コードで既テストの経路）。
  4. `true` を返してアプリ本体の強制終了を防ぐ。
- 効果: 「背面→レンダラ kill→アプリごと死→コールドスタート」だった経路が
  「背面→レンダラ kill→**記録付きで自動復旧**（プロセス・FGS・ネイティブ状態は生存）」になる。
  ターン自体は失われる（ページが死んでいる）が、原因がログで確定できる。

### 2. レンダラ優先度の維持（そもそも殺されにくくする）

- `newConfiguredWebView` で全 WebView に
  `setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, /*waivedWhenNotVisible=*/false)`。
- 既定（非可視で優先度放棄）をやめ、背面・非アクティブスクリーンでもレンダラを
  アプリ本体（FGS で昇格済み）と同格に扱わせる。電池とのトレードオフは許容（アプリの目的が
  「背面でターン維持」のため）。

## 観測との統合

- `renderer-*` はネイティブ記録（背面で JS が凍結していても書ける）→ 60s 定期／復帰時
  アップロードで `server/notify-relay/data/observer.jsonl` へ → Claude が直接解析可能。
- ログビューア（log.html）は `renderer-*` 行を赤表示。
- 読み方の注意: cancel（文字列存在検知）はリロードのたびに過去メッセージを再検知しうる
  （15s デデュープは直後のエコーのみ吸収）。**`start` / `renderer-*` 直後の cancel 行は
  エコーの可能性あり**として読む。

## 制約・既知の残課題

- **minSdk 26** 前提（`onRenderProcessGone` / `setRendererPriorityPolicy` とも API 26）。
- `recreate()` 復旧でも実行中ターンは戻らない（レンダラ死の時点でページは死んでいる）。
  ターンを守る本丸は「殺させない」（優先度維持＋端末のバッテリー最適化除外）。
- Android 15 の `dataSync` FGS には約 6 時間の実行上限がある。長時間常駐で問題になったら
  FGS 種別の見直し（mediaPlayback 等）or `onTimeout` 対応を検討。
- 端末側設定（Samsung「スリープさせないアプリ」への登録）はアプリからは制御できない。
  運用でカバーし、効果はログ（renderer-* / start の頻度）で検証する。

## 検証

- ビルド/テスト: `./gradlew testDebugUnitTest assembleDebug` 通過（APK 260702-1503）。
- 実機での確認観点:
  1. 処理中に背面へ回して放置 → 復帰してもターンが生きているか（優先度維持の効果）。
  2. 「勝手に再起動した」と感じたとき、ログに `renderer-killed`/`renderer-crash` が
     出ているか（＝原因の機械判定）。出ずに `start` だけなら別因（OS のプロセス kill・更新等）。
