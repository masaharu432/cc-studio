# CC Studio 観測ログ永続化・サーバ取得 設計

- 日付: 2026-07-01
- 種別: 設計（feature）
- 関連: [session-state-observer 設計](2026-06-30-session-state-observer-design.md) / [接続改善メモ](../notes/2026-06-30-connection-tool-cancel.md)

## 目的

state-observer プラグインが検知する状態遷移（処理中 / 接続切れ、将来は突発キャンセル）を、
**その場の HUD 表示だけでなく永続的に記録**し、後から接続断の解析に使えるようにする。

現状の課題（[session-state-observer 設計](2026-06-30-session-state-observer-design.md) の実装で判明）:
- ログは `window.top.__ccStudioFocusLog` の **16 件リングバッファ**にしか無い。
- **focus-hud の HUD にその場で出るだけ**。リロードで消え、どこにも保存されない。
- よって接続メモが狙う「突発キャンセル／接続断の再現条件を**貯める**」が成立していない。

## 要件（ユーザ確定事項）

1. **第一前提: アプリ領域にログをファイルとして保存**する（HUD の一時表示ではない）。
2. **アプリ更新で消えない**こと。
3. **接続が切れている間でも記録が残る**こと（＝ローカル保存が先、通信は後）。
4. 後で**サーバ側（agent1）へ持って来て解析**できる経路があること。

## 方式・スコープ

2 フェーズに分割する。本ドキュメントは**フェーズ1（ローカル永続化）を確定仕様**とし、
フェーズ2（サーバ取得）は方向性のみ記す（実装前に別途詳細設計する）。

- **フェーズ1（本実装対象）**: プラグイン → ブリッジ → ネイティブがアプリ領域のログファイルへ追記。
- **フェーズ2（別設計）**: 復帰時に貯めたログを agent1 の cc-notify サイドカーへ送り解析。

## フェーズ1 アーキテクチャ

### データフロー

```
[state-observer プラグイン / 各 WEB スクリーンの top フレーム]
   │  STATE 遷移が確定した時だけ（BUSY?/DIAG のポーリングは送らない）
   │  window.CCStudio.observerLog(line)         [ブリッジ／screenId 内包]
   ▼
 CcBridge.observerLog(line)  → onObserverLog(screenId, line)
   ▼
 MainActivity.onObserverLog
   │  スクリーンの cwd/タイトルと端末時刻を付与
   ▼
 ObserverLogStore.append(record)
   │  getExternalFilesDir("observer")/observer.log に1行追記
   └  サイズ上限でローテート（observer.log → observer.1.log）
```

### コンポーネント

#### 1. 保存先とローテート（`ObserverLogStore`）

- ファイル: `getExternalFilesDir("observer")/observer.log`
  - アプリ**更新では消えない**（アンインストール時のみ削除）。
  - `/Android/data/app.ccstudio/files/observer/` として端末のファイラ／MTP／adb で取り出せる
    （フェーズ2 が入るまでの手動回収経路にもなる）。
- 1 行 = 1 レコード。**JSON Lines**（1行1 JSON）で機械解析しやすくする:
  `{"t":<epoch_ms>,"iso":"<ISO8601>","screen":"<title>","cwd":"<path>","kind":"state","busy":<bool>,"disconnected":<bool>,"matched":"<str>"}`
- ローテート: `observer.log` が上限（既定 512KB）を超えたら `observer.1.log` へ退避（1 世代保持）。
  実質 ~1MB 上限。追記は同期（イベント頻度は低いので性能問題なし）。
- スレッド: ブリッジは JS スレッドから呼ばれるため、ファイル I/O はバックグラウンド or
  単純同期でも可（低頻度）。MainActivity 側で軽量に処理する。

#### 2. ブリッジ（`CcBridge` / `MainActivity`）

- `CcBridge` に `@JavascriptInterface fun observerLog(line: String)` を追加 → `onObserverLog(line)`。
  screenId は既存の `setSessionState` と同じく `buildBridge(screenId)` のクロージャで内包し、
  `onObserverLog(screenId, line)` としてスクリーンを特定する。
- `MainActivity.onObserverLog(screenId, line)`:
  - `screens.byId(screenId)` から cwd/title を引く（無ければ空）。
  - 端末時刻・screen 情報を付けて `ObserverLogStore.append(...)` に渡す。
  - 失敗は握りつぶす（ログ機能自体がアプリを落とさない）。

#### 3. プラグイン（`state-observer.js`）

- **STATE が確定した瞬間だけ**（`doCommit` 内）に `window.CCStudio.observerLog(...)` を呼ぶ。
  送る内容は `{kind:'state', busy, disconnected, matched}` の JSON 文字列。
  ネイティブ側で time/screen を足すので、プラグインは状態のみ送る。
- `BUSY?` / `DIAG` / ポーリングは**送らない**（ノイズ・容量対策）。HUD 用の `hudLog` は従来どおり。
- **CANCEL は当面送らない**: 現状の detectCancel は会話文字列 `"doesn't want to take this action"`
  を拾うため誤検知が多い。信頼できる接続断（disconnected の on/off）を主データとする。
  CANCEL の精度改善は接続メモ側の課題として保留。

### 記録する事象（フェーズ1）

- `state` レコード: 処理中/接続切れの **on/off 遷移**。特に `disconnected:true→false` の時刻対が
  接続断の解析データになる（いつ切れ、いつ戻ったか、どのスクリーンか）。

## エラー処理・制約

- ログ I/O 失敗はアプリ動作に影響させない（try/catch で握りつぶし）。
- 外部ストレージが使えない端末では `filesDir/observer` にフォールバック（更新では消えないが取り出しにくい）。
- 低頻度イベントのみ記録＋サイズローテートで、容量は実質 ~1MB に収まる。

## テスト

- **Kotlin 単体**（`ObserverLogStoreTest`, 一時ディレクトリ使用）:
  - `append` が1行 JSON を追記する。
  - サイズ上限超過で `observer.log` → `observer.1.log` にローテートし、新ファイルに追記が続く。
  - レコードに t/iso/screen/cwd/busy/disconnected が含まれる。
- **ブリッジ/プラグイン**: STATE 遷移で1行増えることを実機で確認（ファイルを取り出して JSONL を目視）。

## フェーズ2（方向性・別設計）

- 復帰検知: `KeepAliveService` は既に `wss://host/cc-notify/ws` に接続している。再接続時に
  未送信ログ（オフセット管理）を **agent1 の cc-notify サイドカー**（code-server サブモジュール外）へ
  HTTP/WS で送る。サーバ側で保存・解析。
- サイドカーの所在特定と API 設計はフェーズ1完了後に行う（[[dont-edit-code-server-submodule]] を厳守）。
- 接続断中はローカルに貯まり続け、復帰後にまとめて送る（要件4を満たす）。

## スコープ外（フェーズ1）

- サーバ送信・解析（フェーズ2）。
- CANCEL（突発キャンセル）の精度ある記録。
- ログ閲覧 UI（当面はファイル回収 or HUD）。
