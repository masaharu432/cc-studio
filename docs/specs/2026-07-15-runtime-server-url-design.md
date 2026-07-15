# ランタイム接続先設定（Server URL / 初期フォルダ）設計

- 日付: 2026-07-15
- ブランチ: `feature/runtime-server-url`
- 状態: 設計（実装前）

## 背景と問題

現在、アプリが開くワークベンチ（code-server）の接続先は **ビルド時に固定** される。

- `app/build.gradle` が `local.properties` の `ccstudio.targetUrl` を読み、`BuildConfig.TARGET_URL` として APK に焼き込む。
- ランタイムでは `MainActivity.TARGET_URL = BuildConfig.TARGET_URL` と `KeepAliveService` が直接 `BuildConfig.TARGET_URL` を参照する（計 5 箇所）。

コミットされたコード自体にテイルネットのホストは無く、未設定時は `https://localhost/` にフォールバックする。しかし **配布された APK の利用者は再ビルドしない限り接続先を変更できない** ＝実質固定。tailnet の別ホストへ向けたり、自分の環境に合わせることができない。

さらに、Claude Code 公式拡張の制約により接続先には次の条件がある:

- **HTTPS 必須**（http では拡張が機能しない）
- **ドメイン名（FQDN）必須。IP アドレス直打ちは不可**（証明書が効かず拡張が機能しない）。tailnet では MagicDNS 名（例 `workbench.tailnet.ts.net`）を使う。

## ゴール

1. アプリ内 UI から接続先オリジン（`https://<domain>`）をランタイムに設定・変更できる。
2. 起動時に最初に開くフォルダ（初期スクリーン）を設定できる。現状デフォルトはユーザーのホーム。
3. 初期フォルダは、サーバ接続中なら**ディレクトリを参照して選べる**。未接続でも手入力できる。
4. 設定はファイルとして永続化し、プロセス kill・アプリ更新（タップ更新）後も前の設定が残る。
5. HTTPS + ドメインのみ受け付け、IP・http は明確な理由とともに拒否する。

## 非ゴール（YAGNI）

- 複数サーバのプロファイル切り替え。今回は単一接続先のみ（将来 `server.json` を配列化する余地は残す）。
- サーバ側のファイル内容の閲覧・編集。ディレクトリ参照は**一覧のみ・読み取り専用**。
- アプリ層の認証。cc-studio は tailnet 前提・非公開の既存信頼モデルを踏襲する。

## アーキテクチャ

### 単一の真実源: `ServerConfig`（ファイルバック）

`filesDir/server.json` を読み書きする薄い層を新設する（`NotifyPrefs` と同型だが SharedPreferences ではなくファイル）。

```json
{ "origin": "https://workbench.tailnet.ts.net", "defaultFolder": "/home/user/projects" }
```

- `origin`: `scheme://host[:port]`。必ず https、ホストは FQDN。未設定なら欠落 or 空。
- `defaultFolder`: 起動初期スクリーンの絶対パス。空/欠落なら「サーバ既定」（origin ルート）。

API（すべて `Context` を取り、内部でファイルを読む/メモリキャッシュ）:

```
ServerConfig.origin(ctx): String?               // 未設定なら null
ServerConfig.defaultFolder(ctx): String?        // 未設定なら null
ServerConfig.setOrigin(ctx, origin)             // 原子的書き込み
ServerConfig.setDefaultFolder(ctx, path)        // 原子的書き込み
ServerConfig.normalizeOrigin(input): Result     // 検証+正規化（下記）
```

**永続化の性質:**

- 保存先は内部ストレージ `filesDir/server.json`（非公開・人間可読）。
- **原子的書き込み**: `server.json.tmp` に書いて `renameTo` で差し替え。書き込み途中に kill されても既存ファイルは無傷、前の設定が残る。
- 読み込みはアプリ起動時に 1 回。パース失敗時は「未設定扱い」にせず、壊れた tmp は無視して直近の正常ファイルを使う。
- 永続範囲: プロセス kill → 残る（data 領域）。タップ更新（同一署名・versionCode 増分）→ 残る。再インストール/機種変更 → 既存の `android:allowBackup="true"` による Auto Backup で復元。念のため `dataExtractionRules`/`fullBackupContent` に `server.json` を明示 include する。

### `BuildConfig.TARGET_URL` の降格（初回シード）

gradle 配管（`local.properties` → `BuildConfig.TARGET_URL`）は残すが、役割を「**初回シード**」に降格する。

- 初回起動で `server.json` が無い場合:
  - `BuildConfig.TARGET_URL` が **実 HTTPS ドメイン**（localhost プレースホルダでない・IP でない）なら、そのオリジンを `server.json` にシード移送する。開発者は従来通り無設定で使える。
  - それ以外（空 / localhost / http / IP）はシードせず未設定のまま。起動時に設定パネルを自動表示（後述）。

### `TARGET_URL` 参照 5 箇所の置換

| 箇所 | 現状 | 変更後 |
|---|---|---|
| `MainActivity` 初期スクリーン生成 | `createWebScreen(TARGET_URL)` | `defaultFolder` があれば `folderUrl(origin, defaultFolder)`、無ければ `origin + "/"` |
| `MainActivity` 新規スクリーン | `createWebScreen(TARGET_URL)` | 初期スクリーンと同じ `initialScreenUrl()`（`defaultFolder` があれば `folderUrl(origin, defaultFolder)`、無ければ `origin + "/"`）。ルートだと code-server が直近ワークスペースを復元し既定フォルダが無視されるため |
| `MainActivity` 通知タップ cwd→URL | `folderUrl(TARGET_URL, cwd)` | `folderUrl(origin, cwd)` |
| `MainActivity.workbenchHost`（外部リンク判定） | `Uri.parse(TARGET_URL).host` | `Uri.parse(origin).host` |
| `KeepAliveService` wss / cc-notify | `BuildConfig.TARGET_URL` ×2 | `ServerConfig.origin(ctx)` |

`ScreenStore`（復元 URL 群）は従来通り。復元状態があるときはそちらを優先し、`defaultFolder` は復元状態が無い初回/リセット時にのみ効く。

## 検証: `normalizeOrigin(input)`

1. スキーム: `https` のみ。無記入なら https を補完。`http://` は拒否。
2. ホスト: **FQDN 必須**。ドットを含む・全体が IPv4 リテラルでない・`[...]`（IPv6）でない・末尾がドット付き数値でない。
3. path / query / fragment は破棄（オリジンのみ保持）。ホストは小文字化。ポートは許容。
4. 不合格は理由コードを返す: `empty` / `not_https` / `is_ip` / `no_dot`。UI が理由に応じた文言を出す。

エラー文言（frontend-design の writing 方針: 謝らず、何が起きたか・どう直すか）:

- `is_ip`: 「IP アドレスは使えません。証明書付きのドメイン名（例 xxx.ts.net）を入力してください。」
- `not_https`: 「HTTPS が必要です。https のドメインを入力してください。」
- `no_dot`: 「ドメイン名を入力してください（例 host.example.ts.net）。」

## 初期フォルダとディレクトリ参照

### サーバ側 endpoint（`server/notify-relay/relay.mjs` に追加）

読み取り専用のディレクトリ一覧を 1 つ追加する。code-server サブモジュールは触らない。

- `GET /cc-notify/ls?path=<abs>`
- レスポンス: `{ "path": "/home/user", "parent": "/home", "dirs": ["projects","documents",...], "truncated": false }`
- ディレクトリのみ列挙・読み取り専用。`path` 未指定は `$HOME`（`process.env.HOME`）。存在しない/ファイル指定は 400。権限エラー・壊れたシンボリックリンクは握り潰してスキップ。
- 上限 500 エントリで打ち切り `truncated: true`。名前昇順。
- `relay.mjs` は現状 POST（通知/オブザーバ）と WS upgrade のみ。GET 分岐を追加する。

### ネイティブ橋（CORS/mixed-content 回避）

`file://` の設定ページから直接 `https://host` を fetch すると CORS/mixed-content になるため、ネイティブが取得する。

- `CcBridge.browseDir(path)`: 既存 `KeepAliveService` 相当の OkHttp で `https://<origin>/cc-notify/ls?path=...` を **非同期** GET し、結果を `window.__ccDirResult(json)` で WebView へ返す。
- `origin` 未設定 / ネットワーク失敗 → `window.__ccDirResult({error:"..."})`。
- ネットワークはワーカースレッド、結果注入は `runOnUiThread` + `evaluateJavascript`。

### 設定 UI: `server.html`（新規 asset）

`notify.html` と同じ骨格（`.bar` / `.body` / `.sect` / mono eyebrow / safe-area / ja-en 切替 / reduced-motion）を踏襲。

**設定リストへのカード追加**: `PanelJson.settingsList` に `server` エントリを追加する。グループ「システム」の先頭（通知の上）。アイコン 🖥️（言語が既に 🌐 を使うため区別）、タイトル「接続先」、サブは現在値 `<host> · <defaultFolder>`（未設定時は「未設定 — タップして接続先を入力」で `attn` 強調）。`openSettingsEntry("server")` で詳細を `OverlayPanel` として開く。

詳細ページ構成:

1. **WORKBENCH ORIGIN**: `https://` は入力欄の**上のラベル行**（🔒 HTTPS 固定 · https:// / DOMAIN ONLY）に逃がし、ホスト入力欄を**フル幅**にする。プレフィックスを同一行に置くと tailnet の長いホスト名が見切れるため。`oninput` で検証 3 行（HTTPS / ドメイン / IP 不可）をリアルタイム更新。全 pass 時のみ「接続先を保存」活性。余白は詰めてスクロール最小化。
2. **INITIAL SCREEN / 最初に開くフォルダ**: パス手入力欄（常時有効）+ [参照] ボタン。参照タップで同パネル内をディレクトリブラウザに切替（breadcrumb + フォルダ一覧、タップで降りる、「ここを選択」で確定）。origin 未設定/未接続なら参照は無効化し「サーバに接続すると参照できます」を表示。

保存操作（native 側）:

- **origin 変更保存**: **保存するだけ**。スクリーンは作らない・画面遷移しない・設定パネルも閉じない（設定ページはそのまま残る）。既存スクリーンも保持。`KeepAliveService` を再起動（新ホストへ再購読）→ トースト「接続先を更新しました」。（旧スクリーンは旧ホストを指したままになるが、リロード/新規スクリーンで新ホストに切り替わる。破壊的な全消し・作り直しはしない。）ワークベンチへは、ユーザーが自分でパネルを閉じる/スクリーンを開くことで移動する。
- **defaultFolder 保存**: `server.json` に原子的書き込み。次回の初期スクリーンから反映（既存スクリーンは変えない）。パスはホスト非依存なので origin 変更時も保持。

### 初回誘導

- `server.json` 未設定かつシード不可の初回起動時: `MainActivity` は localhost へ繋ぎに行かず、`server` パネルを自動表示。保存が完了したら通常起動フローに合流。

## コンポーネント境界

- `ServerConfig`（新規, Kotlin）: `server.json` の read/write/検証。UI・Service から使う唯一の入口。
- `server.html`（新規 asset）: 設定 UI。native とは `CCStudio` 橋のみで通信。
- `CcBridge` 拡張: `serverConfigJson()` / `saveServerOrigin(host)` / `saveDefaultFolder(path)` / `browseDir(path)` を追加。
- `relay.mjs` 拡張: `GET /cc-notify/ls`。
- `MainActivity` / `KeepAliveService`: `TARGET_URL` 参照を `ServerConfig.origin(ctx)` に置換。

## エラーハンドリング

- 検証失敗: 保存ボタン不活性 + 理由文言（上記）。
- `browseDir` 失敗/未接続: ブラウザは開かず「サーバに接続すると参照できます」、手入力は継続可能。
- `server.json` 破損: tmp を無視し直近正常値を採用。両方壊れていれば未設定扱い→初回誘導。
- origin 変更後にワークベンチへ到達不能: 既存の切断表示（session disconnected）に委ねる。設定自体は保存済み。

## テスト

- `ServerConfig.normalizeOrigin`: https 補完 / http 拒否 / IPv4 拒否 / IPv6 拒否 / ドット無し拒否 / path・query 除去 / ポート保持 / 大文字ホスト小文字化。既存 `UrlPolicyTest` と同じ JVM ユニットテスト方式。
- 原子的書き込み: tmp→rename、破損 tmp 無視。
- `relay.test.mjs` に `ls` の単体を追加: 通常一覧 / `$HOME` フォールバック / 非存在 400 / truncated / 権限スキップ。
- `folderUrl(origin, defaultFolder)` の既存挙動が維持されること（`UrlPolicyTest` 準拠）。

## デザインレビュー用モックアップ

この設定ページの見た目は `docs/specs/mockups/2026-07-15-server-settings.html` に単体で開けるモックアップとして用意する（アプリの計器盤トークンを再現。origin 検証のライブ挙動とディレクトリブラウザの状態遷移を確認できる）。
