# cc-studio タスク完了通知（スマホ）設計

- 日付: 2026-06-29
- 対象: cc-studio（Android アプリ + 同梱 code-server）
- 状態: 設計合意済み / 実装計画はこの後に作成

## 背景・課題

cc-studio は code-server を WebView で包んだ Android アプリ。現状:

- 「生存通知」は [KeepAliveService.kt](../../../app/src/main/java/app/ccstudio/KeepAliveService.kt) による **Android フォアグラウンドサービス通知（端末ローカル）** なので確実に出る。
- 一方「AI が応答を終えた」通知はスマホに届かない。[.claude/settings.json](../../../.claude/settings.json) の `Stop` フックが `cc-config notify`（Windows listener 向け）を叩くだけで、**スマホ側に受け取る口が存在しない**。

「AI が終わった」という信号自体は **Claude Code のフックで取れている**。フックは CLI 専用ではなくエンジン（agentic harness）側の機能で、**VS Code 拡張でも同じ `.claude/settings.json` の `Stop` / `Notification` フックが発火する**（IDE 拡張も CLI と同じ settings ツリーを読む）。不足しているのは**スマホへ届ける配管だけ**。

## 要件

1. 信号源は既存の Claude Code `Stop` / `Notification` フックを使う（新規の検出機構は作らない）。`cc-config notify`（ターミナル/Windows listener 向け）は使わない。
2. 配信は **WebSocket**。
3. **アプリが起動中（フォアグラウンドサービス生存中）なら、バックグラウンド／画面オフでも通知が出る**こと。受信は WebView ではなく KeepAliveService（ネイティブ）が担う（WebView の JS は背面で停止/間引かれるため）。
4. 出し分け: **ユーザーが現在見ていないスクリーンの結果のときだけ通知**する。見ているスクリーンそのものの完了は抑制。
5. **通知をタップすると、その結果のスクリーンを開く**（前面化して該当スクリーンへ切替、無ければ新規に開く）。

## 用語

- **スクリーン (Screen)**: `?folder=/path` を読み込んだ WebView。`Long` の `id` を持つ。[Screen.kt](../../../app/src/main/java/app/ccstudio/Screen.kt) / [ScreenManager.kt](../../../app/src/main/java/app/ccstudio/ScreenManager.kt)。

## アーキテクチャ / データフロー

```
[Claude Code 拡張 or CLI]
   │  AI 応答終了 / 許可待ち
   ▼  .claude/settings.json の Stop / Notification フック発火
[フックコマンド (薄いスクリプト)]
   │  hook JSON(stdin) を整形
   ▼  POST http://localhost:<port>/cc-notify   (localhost のみ)
[code-server: /cc-notify (POST)]
   │  接続中の WS クライアントへブロードキャスト
   ▼  wss://agent1…/cc-notify/ws  (code-server 既存 auth 配下)
[Android: KeepAliveService の OkHttp WebSocket クライアント]
   │  受信イベントを cwd でスクリーン突合・前面判定で出し分け
   ▼
[ネイティブ通知 (cc_task チャンネル)] ──タップ──▶ MainActivity 前面化 → ScreenManager.select(該当スクリーン)
```

## コンポーネント

### 1. フックコマンド
- `.claude/settings.json` の `Stop` と `Notification` に登録。
- 役割: stdin の hook JSON から `{kind, project, branch, cwd, session_id, message, last_response, ts}` を組み立て、`http://localhost:<code-server port>/cc-notify` に POST するだけ。
- 失敗してもフックチェーンを壊さない（常に exit 0）。

### 2. `/cc-notify`（POST, localhost バインドのみ）
- code-server の Node ルートに追加。
- 受信イベントを保持中の WS クライアント全員へブロードキャスト。
- localhost のみで外部公開しないため認証不要。

### 3. `/cc-notify/ws`（WebSocket）
- 同じく code-server ルートに追加。**code-server の既存 auth ミドルウェア配下**にマウント。
- 再接続は指数バックオフ。

### 4. KeepAliveService の受信機能
- OkHttp WebSocket で `wss://…/cc-notify/ws` に接続。**起動時に一度 code-server のパスワードでログインして cookie を取得**し、その cookie で WS 接続。
- 受信したら出し分けロジック（下記）を経てネイティブ通知。

## イベントペイロード

```json
{
  "kind": "Stop | Notification",
  "project": "...",
  "branch": "...",
  "cwd": "/path/to/workspace",
  "session_id": "...",
  "message": "...",
  "last_response": "...",
  "ts": 1700000000
}
```

## 認証

- `/cc-notify`(POST): localhost バインドのみ → 認証不要。
- `/cc-notify/ws`(WS): code-server 既存 auth 配下。KeepAliveService が code-server パスワードでログイン→cookie 取得→その cookie で接続。新しい秘密鍵は増やさない。

## 通知の中身と出し分け

| フック | タイトル例 | 本文 | チャンネル |
|---|---|---|---|
| `Stop` | ✅ AI 応答完了 — `project/branch` | `last_response` 冒頭抜粋 | `cc_task` |
| `Notification` | 🔔 許可待ち — `project` | hook の `message` | `cc_task` |

- 既存 keepalive チャンネル（`cc_web_keepalive`, LOW/無音）とは**別の新チャンネル `cc_task`**（IMPORTANCE_DEFAULT〜HIGH, 音/バナーあり）。
- 同一 `session_id` の通知は ID を固定して**更新（積み上げない）**。

### 出し分けロジック（スクリーン単位）

```
eventScreenId  = findScreenByFolderPath(event.cwd)   // ScreenUrl.folderPath() で各スクリーンと突合
activeScreenId = screens.activeOrNull()?.id

show = true
if (appInForeground && eventScreenId != null && eventScreenId == activeScreenId) {
    show = false   // 見ているスクリーンそのものの完了 → 抑制
}
```

- アプリが背面（どのスクリーンも見ていない）→ 常に通知。
- 該当スクリーンが見つからない（開いていない workspace）→ 通知。
- `appInForeground` は Activity の onResume/onPause でフラグ管理。
- `findScreenByFolderPath` は `ScreenManager` の各スクリーンの `url` を [ScreenUrl.kt](../../../app/src/main/java/app/ccstudio/ScreenUrl.kt) の `folderPath()` で取り出し `event.cwd` と突合（厳密一致 → 無ければプレフィックス一致）。

## 通知タップの挙動

- 通知に `screenId`（cwd から解決）と `cwd` を載せる。
- タップ → `PendingIntent` で `MainActivity` を前面化、extra で対象を渡す。
- 該当スクリーンが開いていれば `ScreenManager.select(screenId)` で切替。
- 開いていない workspace なら ベースURL + `?folder=<cwd>` で**新規 WEB スクリーンを開く**。

## 影響ファイル（見込み）

- 追加/編集: code-server ルート（`/cc-notify`, `/cc-notify/ws`）— `server/code-server/src/node/routes/` 配下。
- 追加: フックコマンド（薄いスクリプト）＋ `.claude/settings.json` の hook 差し替え。
- 編集: [KeepAliveService.kt](../../../app/src/main/java/app/ccstudio/KeepAliveService.kt)（WS クライアント＋`cc_task` チャンネル＋通知発火）。
- 編集: [ScreenManager.kt](../../../app/src/main/java/app/ccstudio/ScreenManager.kt) / [MainActivity.kt](../../../app/src/main/java/app/ccstudio/MainActivity.kt)（`findScreenByFolderPath`、前面フラグ、タップ Intent 処理、必要なら新規スクリーン生成）。
- 追加: `strings.xml` の `cc_task` チャンネル名/通知文言。

## エラーハンドリング

- フック→localhost POST 失敗: 無視（exit 0）。フックがブロックしない。
- WS 切断: KeepAliveService が指数バックオフで自動再接続。
- code-server ログイン失敗: リトライ。資格情報が無ければ通知機能は無効（生存通知やアプリ本体には影響させない）。
- 突合不能な cwd: 抑制せず通知（取りこぼしより誤抑制を避ける）。

## テスト方針

- フックコマンド単体: stdin JSON → 期待ペイロードを localhost に POST すること。
- `/cc-notify` → WS ブロードキャスト: POST した内容が接続クライアントに届くこと。
- 出し分けロジック: 前面×該当スクリーン=抑制 / 背面=通知 / 別スクリーン=通知 / 未一致=通知 の 4 ケース。
- タップ Intent: 既存スクリーン select / 未オープン時の新規作成。

## スコープ外（YAGNI）

- アプリ完全終了中でも届くプッシュ（FCM/Firebase）。将来 `/cc-notify` の先に FCM を足せば拡張可能、という余地だけ残す。
- WebView 内 Web 通知 / DOM 監視。
- transcript ファイル監視による検出。
