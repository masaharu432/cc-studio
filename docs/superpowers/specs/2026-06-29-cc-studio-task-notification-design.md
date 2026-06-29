# cc-studio タスク完了通知（スマホ）設計

- 日付: 2026-06-29
- 対象: cc-studio（Android アプリ + 同梱 code-server）
- 状態: 設計合意済み / 実装中（リレー方式に改訂）

## セキュリティ前提

cc-studio は **tailscale の tailnet 前提**で、インターネットには公開されない。配信経路はすべて tailnet ゲート内に閉じるため、トークン等のアプリ層認証は設けない（tailnet 到達性そのものが認証境界）。POST 受け口は 127.0.0.1 バインドでローカル限定。

## 重要な制約: code-server（サブモジュール）は編集しない

`server/code-server` は upstream `github.com/coder/code-server.git` を指す **git サブモジュール**で、実行時は `~/.local/bin/code-server`（公式 standalone インストール版）が動く。**サブモジュールのソースを編集しても実行時に反映されず、フォーク維持の負担にもなる**ため、サーバ機能は code-server に相乗りせず **サブモジュール外の独立リレープロセス**として実装する。

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
[フックコマンド (curl)]
   │  hook JSON(stdin) をそのまま
   ▼  POST http://127.0.0.1:<relay port>/cc-notify   (localhost のみ)
[notify-relay  (server/notify-relay, code-server 非依存の単体 Node プロセス)]
   │  受信を正規化し、接続中の WS クライアントへブロードキャスト
   ▼  wss://agent1…/cc-notify/ws   (tailscale serve パス割当, tailnet ゲート)
[Android: KeepAliveService の OkHttp WebSocket クライアント]
   │  受信イベントを cwd でスクリーン突合・前面判定で出し分け
   ▼
[ネイティブ通知 (cc_task チャンネル)] ──タップ──▶ MainActivity 前面化 → ScreenManager.select(該当スクリーン)
```

## コンポーネント

### 1. フックコマンド
- `.claude/settings.json` の `Stop` と `Notification` に登録。
- 役割: stdin の hook JSON を `http://127.0.0.1:${CC_NOTIFY_RELAY_PORT:-8770}/cc-notify` に curl で POST するだけ（整形はリレー側）。
- 失敗してもフックチェーンを壊さない（常に exit 0）。

### 2. notify-relay（`server/notify-relay/relay.mjs`, code-server 非依存）
- Node 標準ライブラリのみ（`http` + `crypto`）の単体プロセス。**外部 npm 依存なし**（`ws` も使わず WS ハンドシェイク/送信フレームを最小実装）。
- `127.0.0.1:<port>`（既定 8770, env `CC_NOTIFY_RELAY_PORT`）で待受。
- `POST /cc-notify`: hook JSON を `normalizeEvent` で `{kind, project, branch, cwd, session_id, message, ts}` に正規化し、接続中 WS クライアントへブロードキャスト。`{delivered:n}` を返す。
- `GET /cc-notify/ws`（Upgrade）: WS クライアントを登録（サーバ→クライアント送信のみ。受信は不要）。close/error で登録解除。
- provision が code-server と並べて起動し、`tailscale serve` で `/cc-notify` パスをこのポートへ割り当てる。

### 3. tailscale serve パス割当（exposure）
- `wss://<host>/cc-notify/ws` がリレーへ届くよう tailscale serve のパスマッピングを追加。
- tailnet 内からのみ到達可能（=認証境界）。アプリ側に秘密は持たせない。

### 4. KeepAliveService の受信機能
- OkHttp WebSocket で `wss://<host>/cc-notify/ws` に接続（tailnet ゲートのみ、cookie/トークン不要）。
- 接続先 host は `BuildConfig.TARGET_URL` から導出。再接続は指数バックオフ。
- 受信したら出し分けロジック（下記）を経てネイティブ通知。

## イベントペイロード

リレーが正規化して送る（`last_response`/`branch` は v1 では持たない）:

```json
{
  "event": "cc-notify",
  "kind": "Stop | Notification",
  "project": "...",
  "branch": "",
  "cwd": "/path/to/workspace",
  "sessionId": "...",
  "message": "...",
  "ts": 1700000000
}
```

## 認証

- `/cc-notify`(POST): リレーが 127.0.0.1 バインド → ローカル限定で認証不要。
- `/cc-notify/ws`(WS): tailscale serve で公開し tailnet ゲートのみ。アプリ側に秘密は持たせない（[[cc-studio-tailnet-only]] の前提）。

## 通知の中身と出し分け

| フック | タイトル例 | 本文 | チャンネル |
|---|---|---|---|
| `Stop` | ✅ 応答が完了しました — `project` | hook の `message`（無ければ project） | `cc_task` |
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

- 追加: `server/notify-relay/relay.mjs`（code-server 非依存のリレー）＋ テスト。**サブモジュール `server/code-server` は編集しない**（[[dont-edit-code-server-submodule]]）。
- 編集: `server/provision/`（リレー起動 + `tailscale serve` パス割当）。
- 編集: `.claude/settings.json`（hook を curl POST に差し替え）。
- 編集: [KeepAliveService.kt](../../../app/src/main/java/app/ccstudio/KeepAliveService.kt)（WS クライアント＋`cc_task` チャンネル＋通知発火）。
- 編集: [ScreenManager.kt](../../../app/src/main/java/app/ccstudio/ScreenManager.kt) / [MainActivity.kt](../../../app/src/main/java/app/ccstudio/MainActivity.kt)（`findScreenByFolderPath`、前面フラグ、タップ Intent 処理、必要なら新規スクリーン生成）。
- 追加: `strings.xml` の `cc_task` チャンネル名/通知文言。

## エラーハンドリング

- フック→localhost POST 失敗: 無視（exit 0）。フックがブロックしない。
- WS 切断: KeepAliveService が指数バックオフで自動再接続。
- リレー未起動/未接続: 通知機能のみ無効（生存通知やアプリ本体には影響させない）。
- 突合不能な cwd: 抑制せず通知（取りこぼしより誤抑制を避ける）。

## テスト方針

- フックコマンド単体: stdin JSON → 期待ペイロードを localhost に POST すること。
- `/cc-notify` → WS ブロードキャスト: POST した内容が接続クライアントに届くこと。
- 出し分けロジック: 前面×該当スクリーン=抑制 / 背面=通知 / 別スクリーン=通知 / 未一致=通知 の 4 ケース。
- タップ Intent: 既存スクリーン select / 未オープン時の新規作成。

## 通知設定画面（追加要件）

Plugins システムスクリーン（plugins.html）のプラグイン一覧の下に「通知設定」セクションを追加する。内容は**種類別 ON/OFF のみ**（最小構成）:

- ✅ 応答完了 (Stop) — 既定 ON
- 🔔 許可待ち (Notification) — 既定 ON

種類別トグル両方 OFF で実質マスター OFF となるため、別途マスタートグルは作らない。設定は `SharedPreferences("cc_notify_prefs")` に保存し、`NotifyPrefs` 経由で MainActivity（ブリッジ）と KeepAliveService の両方から参照する。KeepAliveService は無効な種類の通知を出さない。JS↔native は既存の `window.CCStudio.*` ブリッジに `getNotifyPrefs()` / `setNotifyPref(kind, enabled)` を追加して接続する。

## ペンディング（将来）

- **通知に AI 応答本文の抜粋（`last_response`）を展開表示**: relay が hook の `transcript_path` を読み、最後のアシスタント発話を数百字に切って payload に載せ、アプリが `BigTextStyle` で展開表示する。タップ→スクリーンの導線は現状のまま。2026-06-29 時点でユーザー判断によりペンディング。

## スコープ外（YAGNI）

- アプリ完全終了中でも届くプッシュ（FCM/Firebase）。将来 `/cc-notify` の先に FCM を足せば拡張可能、という余地だけ残す。
- WebView 内 Web 通知 / DOM 監視。
- transcript ファイル監視による検出。
