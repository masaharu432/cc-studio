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

## 相関ログの見方（セッション状態オブザーバ）

- bootstrap.js のオブザーバが `window.top.__ccStudioFocusLog` に時刻付きで積む:
  - `{tag:'STATE', busy, disconnected, matched}` … 処理中/接続切れの遷移。
  - `{tag:'CANCEL'}` … "doesn't want to take this action" 相当の停止信号を検知。
- 突発キャンセルが出たら、直前の `CANCEL` 行の時刻と、近傍の `STATE`(disconnected:true) や
  keyboard-suppress の `blur` 行を突き合わせる。
  - `CANCEL` 直前に `disconnected:true` があれば **接続瞬断由来**の疑い。
  - `CANCEL` 直前に blur ログ（フォアグラウンド復帰）があれば **focus 抑制由来**の疑い。
- 切り分けが付いたら、設計の方式B（hooks→WS）導入や keyboard-suppress の発火条件見直しへ。
