# CC Studio 観測ログ永続化・サーバ取得 設計

- 日付: 2026-07-01
- 種別: 設計（feature）
- 関連: [session-state-observer 設計](2026-06-30-session-state-observer-design.md) / [接続改善メモ](../notes/2026-06-30-connection-tool-cancel.md)
- 参考（keepalive 解析の既存資産・cc-web）:
  - `cc-web/cc-web-keepalive/src/reconnectguard.js` … code-server 再接続トーストの DOM 事実
    （`.notification-toast/.notification-list-item` の `"attempting to reconnect"`/`"cannot reconnect"`）。
    **突発キャンセルの真因＝再接続トーストの Reload Window でターン破棄**、VS Code は最大3時間 自動再接続。
  - cc-notify WS サーバ本体は **本 repo 独自の `server/notify-relay/relay.mjs`**（素の Node http+WS、
    POST `/cc-notify`・WS `/cc-notify/ws`、既定ポート 8770。`server/provision/install-notify.sh` で常駐化。
    code-server サブモジュールの外）。フェーズ2 のサーバ側キープアライブ記録・突合はここに足す。

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
5. **絶対時刻で記録**し、サーバ側の「キープアライブ WS が切れた」等のイベントと
   **時刻で突合**できること。相対時間ではなく epoch ms ＋ タイムゾーン付き ISO を残す。
6. `code-server WebView の切断`（プラグイン検知）と `キープアライブ WS の断/復帰`
   （`KeepAliveService`）を突合できるよう、**両方を同じログに同一端末クロックで**記録する。

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
   │  window.CCStudio.observerLog(json)         [ブリッジ／screenId 内包]
   ▼
 CcBridge.observerLog(json)  → onObserverLog(screenId, json)
   │
[KeepAliveService の WS onOpen/onClosed/onFailure]
   │  keepalive の断/復帰イベント（src=keepalive）
   ▼
 ObserverLogStore.append(record)   ← 両経路ともここへ集約
   │  time = System.currentTimeMillis()（単一クロック）＋ screen 情報を付与
   │  getExternalFilesDir("observer")/observer.log に1行 JSONL 追記
   └  サイズ上限でローテート（observer.log → observer.1.log）
```

### コンポーネント

#### 1. 保存先とローテート（`ObserverLogStore`）

- ファイル: `getExternalFilesDir("observer")/observer.log`
  - アプリ**更新では消えない**（アンインストール時のみ削除）。
  - `/Android/data/app.ccstudio/files/observer/` として端末のファイラ／MTP／adb で取り出せる
    （フェーズ2 が入るまでの手動回収経路にもなる）。
- 1 行 = 1 レコード。**JSON Lines**（1行1 JSON）で機械解析しやすくする。共通フィールドに
  **絶対時刻**（`t`=epoch ms, `iso`=タイムゾーン付き ISO8601）を必ず入れ、`src`/`kind` で種別を分ける:
  - スクリーン状態: `{"t":<ms>,"iso":"...","src":"screen","kind":"state","screen":"<title>","cwd":"<path>","busy":<bool>,"disconnected":<bool>,"matched":"<str>"}`
  - キープアライブ WS: `{"t":<ms>,"iso":"...","src":"keepalive","kind":"ws","event":"open|closed|failure","detail":"<code/reason>"}`
- **時刻はネイティブの `System.currentTimeMillis()` で一括採番**（プラグイン由来イベントも
  ネイティブ到達時に打つ）。これで全レコードが**単一の端末クロック**に載り、`screen` と `keepalive` を
  ズレなく突合できる。サーバ側との突合は端末⇔サーバの時計ズレを別途考慮（フェーズ2）。
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

- `src:"screen"` レコード: 処理中/接続切れの **on/off 遷移**。特に `disconnected:true→false` の
  時刻対が接続断の解析データになる（いつ切れ、いつ戻ったか、どのスクリーンか）。
- `src:"keepalive"` レコード: `KeepAliveService` の WS が **onOpen/onClosed/onFailure** した時刻。
  これで「code-server WebView の切断」と「キープアライブ WS の切断」を**同一端末クロックで突合**でき、
  接続断がネットワーク全体の瞬断か個別かを切り分けられる（[接続改善メモ](../notes/2026-06-30-connection-tool-cancel.md) の狙い）。

#### 4. キープアライブ WS の記録（`KeepAliveService`）

- 既存の `WebSocketListener`（`onOpen`/`onClosed`/`onFailure`）に、`ObserverLogStore.append` で
  `src:"keepalive"` レコードを追記するフックを足す。バックオフ再接続の各試行も残すと解析しやすい。
- これは接続断そのものの一次証拠（サーバに届かなくても端末に残る）。

### 保存タイミング（イベント駆動）

- **時間間隔での定期保存はしない。イベント（状態遷移）ごとに1行 append＋即フラッシュ**。
  遷移は低頻度で、突合には正確な遷移時刻が要るため、定期サンプリングより優れる。
- **OFF は生（デバウンス前）タイミングで記録する**。プラグインの集約は off を約800ms デバウンスして
  UI 表示を安定させるが、**ログには onset（検知した生の時刻）を使う**。接続断の終了/開始時刻を
  正確に突合できるようにするため。実装: プラグインは「生の遷移」を検知した時点で `observerLog` を送り、
  UI 用の setSessionState 側だけデバウンスする（ログと表示でタイミング源を分ける）。
- **ライフサイクルもイベントとして記録**（アプリ start/foreground/background/stop）。観測が
  有効だった区間の境界になり、突合の解釈に効く。
- **専用ハートビートは新設しない**。「一定間隔の生存記録」は**既存のキープアライブ機構**（`KeepAliveService`
  の WS ＝ ベースコードに既にある機能）で足りる。アプリ側はその WS 断/復帰を `src:"keepalive"` で記録し、
  サーバ側は同 WS の接続/切断を記録する（フェーズ2）。二重に作らない。

## エラー処理・制約

- ログ I/O 失敗はアプリ動作に影響させない（try/catch で握りつぶし）。
- 外部ストレージが使えない端末では `filesDir/observer` にフォールバック（更新では消えないが取り出しにくい）。
- 低頻度イベントのみ記録＋サイズローテートで、容量は実質 ~1MB に収まる。

## テスト

- **Kotlin 単体**（`ObserverLogStoreTest`, 一時ディレクトリ使用）:
  - `append` が1行 JSON を追記する。
  - サイズ上限超過で `observer.log` → `observer.1.log` にローテートし、新ファイルに追記が続く。
  - `src:"screen"` レコードに t/iso/screen/cwd/busy/disconnected が、`src:"keepalive"` レコードに
    t/iso/event が含まれる。`t` は絶対時刻（epoch ms）で単調に増える。
- **ブリッジ/プラグイン**: STATE 遷移で1行増えることを実機で確認（ファイルを取り出して JSONL を目視）。

## フェーズ2（方向性・別設計）

- 復帰検知: `KeepAliveService` は既に `wss://host/cc-notify/ws` に接続している。再接続時に
  未送信ログ（オフセット管理）を **agent1 の cc-notify サイドカー**（code-server サブモジュール外）へ
  HTTP/WS で送る。サーバ側で保存・解析。
- サイドカーの所在特定と API 設計はフェーズ1完了後に行う（[[dont-edit-code-server-submodule]] を厳守）。
- 接続断中はローカルに貯まり続け、復帰後にまとめて送る（要件4を満たす）。
- **サーバ側キープアライブ記録と突合**: サーバは自分視点で WS の接続/切断を**サーバ絶対時刻**で
  記録する。アプリ側ログ（端末時刻）とサーバ側ログ（サーバ時刻）を突き合わせるため、
  **端末⇔サーバの時計ズレ**を扱う。案: アップロード時にアプリの `t` とサーバ受信時刻を突き合わせて
  **オフセットを推定・記録**する（NTP 同期済みならズレは小さいが、明示的に残して解析時に補正可能にする）。
- アプリ側は `src:"keepalive"` レコードで端末視点の断も持つため、**サーバ不達でも端末内で一次突合が可能**。

## スコープ外（フェーズ1）

- サーバ送信・解析（フェーズ2）。
- CANCEL（突発キャンセル）の精度ある記録。
- ログ閲覧 UI（当面はファイル回収 or HUD）。
