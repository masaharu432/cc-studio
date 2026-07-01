# CC Studio 経由セッションで稀に出るツール突発キャンセル（接続改善メモ）

- 日付: 2026-06-30
- 種別: 調査メモ（接続堅牢性の改善ポイントを貯めるための記録）
- きっかけ: CC Studio（Android アプリ → code-server WebView → Claude Code）越しのセッション中、
  ツール呼び出しが本人操作と無関係に中断される事象が出たこと。

## 事象

- セッション中、ツール呼び出しが「The user doesn't want to take this action right now. STOP ...」という
  キャンセル信号で中断されることが稀にある。
- 2026-06-30 のセッションで、`strings.xml` を読む Read 呼び出しが一度この信号で弾かれた。
  **直後にそのまま再実行したら正常通過**した（恒常的な不可ではなく、単発の取りこぼし）。
- 中身のある指示テキストは伴わず、停止ボタン相当のシグナルだけが届く。

## 見立て

- ユーザ操作ではなく、**アプリ／WebView の通信瞬断が誤って「中断」として伝わっている**可能性が高い。
  - 想定される断点: キープアライブ WS（`wss://host/cc-notify/ws`）の切断・再接続、
    フォアグラウンド復帰時の取りこぼし、code-server セッションの一時切断。
- Claude 側の判断ミスではなく、**CC Studio の接続堅牢性の問題**として扱う。

## 接続改善の着手ポイント

1. `KeepAliveService` の WS 再接続バックオフ／フォアグラウンド復帰時の再同期。
2. WebView 側（code-server セッション）の通信切断ハンドリング。
3. 突発キャンセルが UI 操作の取りこぼしに化けていないかの確認。

## 運用

- 同種の突発キャンセルが再発したら、ユーザ操作と断定せず、本ノートに事象
  （日時・直前の操作・直後の再試行が通ったか）を追記して**再現条件を貯める**。

## 記録した事象

- **2026-07-02 ~02:06** — cc-studio 開発セッション中、`MainActivity.kt` の Edit が
  `The user doesn't want to take this action right now. STOP ...` で中断。ユーザは直後に「すすめて」＝
  **意図的な拒否ではない**。同一 Edit を再適用したら**正常通過**（APK 260702-0206 ビルド、02:06:58 コミット）。
  → 永続ログの収集開始（02:16）より前なので突合データ無し。
- **2026-07-02 ~00:33** — 同セッション、フェーズ2 計画ドキュメントの Write が同種シグナルで中断。
  ユーザ「続けて」で再実行し正常通過。これも収集開始前。
- **2026-07-02 02:19:01–02:20:03**（参考・自己誘発）— relay 再起動の空白で端末側 `keepalive failure`＋
  `502 Bad Gateway` が連続 → 復帰で `open`。**ログが本物の断を時刻付きで捕捉できることの実証**
  （このときツール中断は無し）。502 は私の relay 停止中が原因で実障害ではない。

## 相関ログの見方（セッション状態オブザーバ）

- bootstrap.js のオブザーバが `window.top.__ccStudioFocusLog` に時刻付きで積む:
  - `{tag:'STATE', busy, disconnected, matched}` … 処理中/接続切れの遷移。
  - `{tag:'CANCEL'}` … "doesn't want to take this action" 相当の停止信号を検知。
- 突発キャンセルが出たら、直前の `CANCEL` 行の時刻と、近傍の `STATE`(disconnected:true) や
  keyboard-suppress の `blur` 行を突き合わせる。
  - `CANCEL` 直前に `disconnected:true` があれば **接続瞬断由来**の疑い。
  - `CANCEL` 直前に blur ログ（フォアグラウンド復帰）があれば **focus 抑制由来**の疑い。
- 切り分けが付いたら、設計の方式B（hooks→WS）導入や keyboard-suppress の発火条件見直しへ。

## 永続ログ（フェーズ1）

- 保存先: `/sdcard/Android/data/app.ccstudio/files/observer/observer.log`（JSONL, アプリ更新で消えない）。
  回収例: `adb exec-out cat /sdcard/Android/data/app.ccstudio/files/observer/observer.log | tail -40`
- `src:"screen"`（処理中/接続切れ遷移, matched 付き）と `src:"keepalive"`（WS open/closed/failure）、
  `src:"app"`（lifecycle）を**同一端末クロック(t=epoch ms, iso)**で記録。突発キャンセル発生時は、近傍の
  `keepalive failure` と `screen disconnected` の t を突き合わせる。
- 接続断は cc-web `reconnectguard.js` 準拠で `"attempting to reconnect"`/`"cannot reconnect"` を検知。
- 真因候補（cc-web reconnectguard の知見）: 再接続トーストの **Reload Window を押す（誤タップ含む）と
  実行中の Claude ターンが破棄される**。VS Code は最大3時間 自動再接続でゼロロス復帰するのでリロードしないのが安全。
  → cc-studio に reconnectguard 相当（Reload を隠す/リロードさせない）の移植を別途検討。
- フェーズ2 でこの永続ログを本 repo の cc-notify サーバ `server/notify-relay/relay.mjs` へ送り、サーバ側 WS 断と時刻突合する。

## サーバ取得（フェーズ2）

- アプリが未送信分(t>lastUploadedT)を `POST https://host/cc-notify`（body type=cc-observer）で自動送信
  （keepalive 復帰・60s定期・前面復帰）。relay が `server/notify-relay/data/observer.jsonl` へ追記（gitignore）。
- サーバ視点の keepalive（`src:"server" kind:"keepalive" connect/disconnect`）とバッチ受信時刻
  （`kind:"batch" t_server/sentAt`）も残るので、端末側の断と**サーバ側の断**を時刻突合できる。
- Claude 解析: `server/notify-relay/data/observer.jsonl` を直接 grep/cat。突発キャンセル時刻の近傍で
  端末 `keepalive failure` / サーバ `keepalive disconnect` / `screen disconnected @<folder>` を並べる。
  例: `grep -nE '"disconnected":true|keepalive.*failure|"src":"server"' server/notify-relay/data/observer.jsonl | tail -30`
