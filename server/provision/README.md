# server/provision — code-server ブリングアップ

cc-studio が WebView で包む **code-server ワークベンチ**を、1 コマンドで再現するための
プロビジョニング。install → config → 常駐 → 推奨設定/拡張の投入までを冪等に行う。

設計の一次資料: [docs/specs/2026-06-29-cc-studio-server-bringup-design.md](../../docs/specs/2026-06-29-cc-studio-server-bringup-design.md)

## 使い方

```bash
cp cc-studio.env.example cc-studio.env   # 必要なら編集（任意）
./setup.sh                               # install + config + 常駐 + provision
./setup.sh --force                       # 拡張を再インストール
```

`setup.sh` がやること:

1. **install** — `code-server` が無ければ**公式プレビルド配布**を standalone install（`$CC_PREFIX`）。
   `code-server.dev/install.sh --method standalone` で、Microsoft の VS Code をパッケージした
   今動いているプレビルド release を入れる。**リポジトリ同梱の `../code-server` submodule は
   このインストールには使わない**（submodule は開発中に上流ソースを読むための参照で、そこからビルドはしない）。
2. **config** — `~/.config/code-server/config.yaml` を**無い時だけ**生成（password はその場生成、既存は保全）。
3. **service** — systemd ユーザサービス `vsserver` を生成・有効化（linger 付きで boot 時自動）。
   systemd が無ければ `start-vsserver.sh` 案内にフォールバック。
4. **provision** — 推奨 User 設定（`settings.json`）を**非破壊ディープ merge**（既存は `.bak` 退避）し、
   `extensions.txt` の拡張を Open VSX からインストール。
5. **同梱拡張 cc-open** — `install-cc-open.sh` が [`cc-open/`](cc-open) を `.vsix` にパッケージして
   インストール（チャットのリンクから開いた `.md` をタブ内プレビューへ切替える補助拡張。同バージョン
   なら skip、`--force` で再インストール）。
6. **通知機能** — `install-notify.sh` を呼び、notify-relay の常駐化と Claude Code user フックの登録を行う（下記）。

## 公開（HTTPS / Tailnet）

HTTPS は前段のホストで `tailscale serve` を一度だけ設定する（スクリプトは自動実行しない）:

```bash
tailscale serve --bg 127.0.0.1:8088
# → https://<your-tailnet-host>/   （302 → ログインは正常）
```

WSL で動かす場合、`tailscale serve` は **Windows 側**で実行する（mirrored networking で
Windows loopback が WSL loopback に届く）。

## 通知機能（notify-relay + Claude Code フック）

`install-notify.sh`（setup.sh からも呼ばれる・冪等）がインストールする:

1. **user フック** — `~/.claude/settings.json` に `Stop`（ターン完了）と `Notification`
   （matcher `permission_prompt`・許可待ち）のフックを登録。イベント JSON を
   `http://127.0.0.1:8770/cc-notify` へ POST する（user スコープなので全プロジェクト共通）。
2. **notify-relay 常駐** — [`../notify-relay/relay.mjs`](../notify-relay/relay.mjs)（Node・`:8770`）を
   systemd user サービス `notify-relay` として常駐化。受けたイベントを WebSocket でアプリへ配信し、
   アプリからの観測ログバッチ（`type:"cc-observer"`）は `../notify-relay/data/observer.jsonl` に追記する。
   node が無ければ skip、systemd が無ければ `start-vsserver.sh` が起動を代行する。
3. **tailscale パス公開** — この環境から tailscale を操作できれば
   `tailscale serve --bg --set-path /cc-notify http://127.0.0.1:8770` を自動実行。できない場合
   （WSL 等）は前段ホストで手動実行する（Windows は PowerShell 推奨。Git Bash は
   `MSYS_NO_PATHCONV=1` を付ける）。

既に起動中の Claude セッションは一度リロードするとフックを読み込む。相手方（アプリ側）の挙動は
[docs/specs/2026-07-02-architecture-and-implementation-notes.md](../../docs/specs/2026-07-02-architecture-and-implementation-notes.md) 参照。

## 推奨設定：ファイルを「プレビュー既定」で開く（`settings.json`）

スマホで Claude Code に作業させると、編集された **Markdown / HTML の成果物をすぐ確認したい**。
だが VS Code 標準のプレビュー（特に Live Preview）は**横分割**で開くため、小さなスマホ画面では
プレビューが激狭になって使い物にならない。そこで、これらを**タブ内にフルサイズで開く既定**にする:

| パターン | 既定エディタ | 由来 |
|---|---|---|
| `*.md` | `vscode.markdown.preview.editor` | VS Code 組込み（分割せずタブ内プレビュー） |
| `*.html` | `aios.htmlPreview` | `kyledunne.aios-html-auto-preview`（カスタムエディタ。タブ内フルサイズ） |

`workbench.editorAssociations` で割り当てている。HTML を Live Preview の `ms-vscode.live-server` で
やらないのは、同拡張がプレビュー列を `ViewColumn.Beside`（横分割）でハードコードしており、
VS Code 側の設定では分割を止められないため（タブ内表示にはカスタムエディタを持つ拡張が要る）。

編集に戻すときはタブの「Reopen Editor With… → Text Editor」。プレビュー既定をやめたい人は
この 2 行を消すか、各自の `settings.json` で上書きすればよい（merge は非破壊）。

## 推奨設定：`claudeCode.autosave: false`（背面での突発キャンセル防止・必須級）

Claude Code 拡張の autosave 機能（既定 ON）は、Edit/Write/Read のたびに PreToolUse フックで
`openTextDocument` を呼ぶ。この呼び出しはワークベンチ（＝スマホの WebView）への RPC を要し、
**アプリが背面で WebView が凍結していると約 11 分ハングした末にツールが自動 deny され、
ターンが「The user doesn't want to take this action…」で突然止まる**。OFF にするとフックが
即 return するため、この経路が根絶される。詳細は
`docs/notes/2026-07-02-tool-cancel-analysis.md`（7〜9 回目）を参照。
トレードオフはエディタ上の未保存変更が自動保存されなくなることのみ（スマホ運用では実害なし）。

## 拡張の指定とローカル追加

インストールする拡張は [`extensions.txt`](extensions.txt)（1 行 1 ID、`#` でコメント）で指定する。
**tracked リストを触らず各自で足したい拡張**は、`extensions.local.txt`（gitignore 済み）に書けば
setup.sh が両方を読む。

## 調整値（cc-studio.env / 環境変数）

| 変数 | 既定 | 意味 |
|---|---|---|
| `CC_PORT` | `8088` | バインドポート（tailscale serve の転送先と一致） |
| `CC_BIND` | `127.0.0.1` | バインドアドレス |
| `CC_FOLDER` | `$HOME` | 起動時に開く既定フォルダ |
| `CC_USER_DIR` | `$HOME/.local/share/code-server/User` | User 設定ディレクトリ |
| `CC_PREFIX` | `$HOME/.local` | code-server install prefix |

`cc-studio.env`・`config.yaml`・`*.bak` は gitignore 済み（個人値・秘密はコミットしない）。

## ファイル

| ファイル | 役割 |
|---|---|
| `setup.sh` | オーケストレータ（冪等） |
| `settings.json` | 推奨 User 設定（merge するキーのみ） |
| `extensions.txt` | 拡張 ID（Open VSX） |
| `cc-open/` | 同梱拡張（.md をタブ内プレビューへ自動切替） |
| `install-cc-open.sh` | cc-open を vsix 化してインストール（冪等） |
| `install-notify.sh` | 通知機能（フック登録 + notify-relay 常駐 + serve 公開） |
| `notify-relay.service.tmpl` | notify-relay の systemd user unit テンプレ |
| `vsserver.service.tmpl` | systemd user unit テンプレ |
| `start-vsserver.sh` | systemd 無し用フォールバック起動（relay も代行起動） |
| `cc-studio.env.example` | 調整値テンプレ |
