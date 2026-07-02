# 観測ログ サーバ取得・突合（フェーズ2）設計

- 日付: 2026-07-02
- 種別: 設計（feature）
- 関連: [フェーズ1 設計](2026-07-01-observer-log-persistence-design.md) / [フェーズ1 計画](2026-07-01-observer-log-persistence-plan.md) / [接続改善メモ](../notes/2026-06-30-connection-tool-cancel.md)

## 目的

フェーズ1で端末に永続化した観測ログ（`observer.log` JSONL）を **agent1（サーバ）へ自動アップロード**し、
**私（Claude Code）が repo 内のファイルとして直接 `cat`/grep で解析できる**状態を作る。あわせて
**サーバ視点の keepalive WS 接続/切断**を記録し、アプリ側の断とサーバ側の断を突合できるようにする。

## 要件（ユーザ確定）

1. アップロードは **自動**（keepalive 復帰時＋定期＋アプリ前面復帰）。接続断中は端末に溜め、復帰後にまとめて送る。
2. サーバ保存先は **repo 内 `server/notify-relay/data/`（gitignore）**。私がすぐ読める場所。
3. サーバ側でも **keepalive WS の接続/切断をサーバ絶対時刻で記録**し、アプリ側ログと突合可能に。
4. 端末⇔サーバの**時計ズレ**を扱えるよう、各バッチにサーバ受信時刻を残す。

## トポロジ（既存事実）

- `server/notify-relay/relay.mjs` は素の Node http+WS。`127.0.0.1:8770` バインド。
  - POST（現状パス非依存・全部）→ `normalizeEvent` → WS クライアントへ broadcast（通知フック用）。
  - Upgrade → WS クライアント登録（アプリ `KeepAliveService` が購読）。
- 端末（phone）は **tailscale serve 経由**で `https://host/cc-notify`・`wss://host/cc-notify/ws` に到達（relay は localhost）。
- tailnet 前提・アプリ層認証なし（[[cc-studio-tailnet-only]]）。

## アーキテクチャ

### データフロー

```
[アプリ KeepAliveService]                         [relay.mjs (agent1)]
  onOpen(再接続) / 60s定期 / 前面復帰
    ├ readAll() から t>lastUploadedT の行を抽出
    ├ 無ければ何もしない
    └ POST https://host/cc-notify
         body={type:"cc-observer", device, sentAt, lines:"<JSONL>"}
                                          │
                    POST 判定: body.type==="cc-observer" ?
                       ├ yes → data/observer.jsonl へ lines を追記
                       │        ＋ サーバ受信マーカー行を1行追記
                       │        （t_server, device, count, sentAt）
                       │        → res {saved:N}
                       └ no  → 従来どおり broadcast（通知フック）
  onOpen/onClosed 時、relay 側も：
    handleUpgrade(接続) / socket close(切断)
       → data/observer.jsonl へ server-keepalive 行を追記（t_server, event）
```

### コンポーネント

#### 1. relay.mjs（サーバ）

- **ログ保存の振り分け**: POST ハンドラで本文 JSON を見て `type==="cc-observer"` なら保存経路、
  そうでなければ現状の broadcast。**パスに依存しない**（tailscale serve のパス挙動を避ける既存方針を踏襲）。
- **保存**: `server/notify-relay/data/observer.jsonl` に追記（`fs.appendFileSync`）。
  - 受信 `lines`（端末の JSONL・端末時刻 `t` 入り）をそのまま追記。
  - 続けて**サーバ受信マーカー**を1行追記: `{"src":"server","kind":"batch","t_server":<ms>,"device":"...","count":N,"sentAt":<ms>}`。
    → 端末 `sentAt` とサーバ `t_server` の差で**時計ズレ**を推定できる。
- **サーバ視点 keepalive**: `handleUpgrade` で接続時、socket `close/error/end` で切断時に
  `{"src":"server","kind":"keepalive","event":"connect|disconnect","t_server":<ms>}` を data/observer.jsonl に追記。
  → アプリ側 `src:"keepalive"`（端末時刻）とサーバ側（サーバ時刻）で二重に断を持ち、突合できる。
- **純関数として切り出す**（relay.test.mjs でテスト）: `isObserverBatch(body)`, `formatBatchRecords(body, tServer)`,
  `serverKeepaliveLine(event, tServer)`。ファイル追記の副作用は薄いラッパに閉じる。
- 保存ディレクトリは起動時に `mkdirSync(recursive)`。書き込み失敗はログのみ（relay を落とさない）。

#### 2. KeepAliveService（アプリ・アップロード）

- **送信先 URL**: 既存 `wsUrl()` と同様に `BuildConfig.TARGET_URL` から `https://host/cc-notify` を作る
  （scheme=https 固定、パス `/cc-notify`）。
- **差分抽出**: `ObserverLog.readAll(context)` を読み、各行を JSON パースして `t > lastUploadedT` の行だけ集める。
  ローテート（observer.1.log→log）を跨いでも readAll が古い順連結なので**バイトオフセット不要**で頑健。
- **送信**: OkHttp で `POST /cc-observer` 本文 `{type,device,sentAt,lines}`。成功(2xx)なら
  `lastUploadedT = 送った最大 t` を SharedPreferences に保存。失敗は次トリガーで再試行（溜まったまま）。
- **トリガー**: (a) WS `onOpen`（再接続直後）, (b) 60s 定期（既存 handler/Runnable に相乗り）,
  (c) アプリ前面復帰（MainActivity onResume → Service へ ACTION_UPLOAD or 共有フラグ）。
- **device id**: 初回に乱数生成し SharedPreferences に保存。バッチに含める（再インストール/複数端末の区別）。
- 送信は同時多重を避ける（`@Volatile uploading` ガード）。ネットワークは既存 OkHttp を流用。

#### 3. .gitignore

- `server/notify-relay/data/` を gitignore（受信ログ実体はコミットしない）。

### 記録される突合データ（例・data/observer.jsonl）

```
{"t":...,"src":"screen","kind":"state","screen":"cc-studio","cwd":"/mnt/.../cc-studio","busy":false,"disconnected":true,"matched":"overlay:reconnecting"}
{"t":...,"src":"keepalive","kind":"ws","event":"failure","detail":"...","active":"/mnt/.../cc-studio"}   ← 端末視点の断
{"src":"server","kind":"keepalive","event":"disconnect","t_server":...}                                  ← サーバ視点の断
{"src":"server","kind":"batch","t_server":...,"device":"...","count":12,"sentAt":...}                     ← 受信＋時計ズレ用
```

→ 私はこのファイルを開いて、`disconnected:true` / 端末 `keepalive failure` / サーバ `keepalive disconnect` の
時刻を並べ、突発キャンセルが**ネットワーク全体の瞬断か個別か・どのフォルダで起きたか**を解析できる。

## エラー処理・制約

- アップロード失敗・保存失敗はどちらも握りつぶし（アプリ/relay を落とさない）。未送信分は次回再試行。
- 本文サイズ: relay の既存 1MB 上限に収まるよう、1バッチの `lines` が大きければ分割送信（上限 ~512KB/バッチ）。
- 重複/欠落: `t > lastUploadedT` の境界で同一 ms が複数あると稀に欠落し得る。イベントは低頻度なので許容。
  厳密化が要れば将来 device+t+ハッシュでサーバ側 dedup。
- 認証なし（tailnet 前提）。保存先は gitignore で公開されない。

## テスト

- **relay（Node, relay.test.mjs）**: `isObserverBatch`（type 判定）、`formatBatchRecords`（lines＋batchマーカー生成、
  t_server 反映）、`serverKeepaliveLine`（connect/disconnect 行）。broadcast 側が壊れていないこと。
- **アプリ（Kotlin JVM）**: 差分抽出ロジックを純関数に切り出しテスト（`UploadDelta.select(text, lastT): (lines, maxT)`）。
- **実機**: 断→復帰後に `server/notify-relay/data/observer.jsonl` が増え、端末行＋サーバ keepalive 行＋batch 行が並ぶ。

## 追補: トランスクリプト走査（キャンセル発生時刻の自動収集・実装済み）

DOM 文字列検知（アプリ側）は「パネルが見えている時しか拾えない・検知時刻が発生時刻と
最大27分ズレる（実測）」ため補助に格下げし、**一次証拠＝セッショントランスクリプトの自動走査**を
relay に実装した（commit f2d8547）。

- 対象: `~/.claude/projects/**/**.jsonl`。60秒ごとに**増分走査**（オフセットを
  `data/tx-scan-state.json` に永続化。初見の古いファイル＝mtime 48h超は末尾から追従）。
- 判定: `type:"user"` の `message.content[]` に、content が CLI のツール拒否定数
  `"The user doesn't want to take this action right now."` で**始まる** `tool_result` がある行のみ
  （CLI 自身と同じ startsWith 判定。引用・ノート・会話中の言及は除外される）。
- 出力: `{"t":<発生epoch ms>,"iso":...,"src":"cancel","kind":"cancel","via":"transcript","cwd":...,"session":<先頭8桁>}`
  を observer.jsonl へ追記。アプリ側 DOM 検知のレコード（via 無し）とは `via` で区別する。
  **解析は via:transcript を正とする。**
- 検収: 2026-07-02 16:03:05 の実キャンセル（別セッションの Write 拒否）を正確な時刻で捕捉。
  偽ヒット（引用73件）は全除外。過去48hの本物7件をバックフィル。

## スコープ外（フェーズ2）

- 解析の自動化（ダッシュボード/アラート）。当面は私が手で cat/grep 解析。
- reconnectguard 相当の移植（突発キャンセルの根本対策）は別タスク。
- 複数端末の集約・ローテート/保持ポリシー（当面は単一 jsonl・手動運用）。
