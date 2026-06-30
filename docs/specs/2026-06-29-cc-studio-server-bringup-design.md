# cc-studio サーバ・ブリングアップ 設計

- 日付: 2026-06-29
- 状態: ドラフト（ブレインストーミング合意済み）
- 対象リポ: cc-studio（`<repo-root>`）

## 背景

cc-studio は「OSS の VS Code サーバ（code-server）+ そのフロントエンド」+「Claude Code 公式拡張」を
ベースに、モバイルで動かす際の公式ソースの不具合を自前アプリ側で回収・改善する単独アプリである。

ところがサーバの起動・セットアップ一式（code-server の install、起動、Tailnet 公開、推奨設定/拡張の投入）が
旧 cc-web リポと個人環境（systemd ユーザサービス・Windows 側 `tailscale serve`）に散らばっており、
cc-studio を clone しただけではワークベンチのサーバ側を再現できない。

本設計は、その**サーバ・ライフサイクル全体を cc-studio に集約**し、OSS 利用者が 1 コマンドで
立ち上げられるよう整備する。あわせて、現状は手編集している code-server の User 設定
（markdown を最初からプレビュー表示する等、モバイル向けの不具合回収を含む）と必須拡張を、
宣言的な単一の正（source of truth）からプロビジョニングできるようにする。

## ゴール / 非ゴール

### ゴール

- clone した人が `server/provision/setup.sh` 1 本で、**install → config → 常駐起動 → 設定/拡張プロビジョニング**まで到達できる。
- 個人固有値・秘密（password、tailnet ホスト名/IP、`<repo-root>/...` パス、ユーザ名）を**一切コミットしない**。すべて環境変数・実行時解決・テンプレで吸収する（OSS 汎用 / パラメータ化）。
- code-server の User 設定は「プロダクト推奨キーのみ」を**非破壊ディープ merge** で投入し、利用者のテーマ等の個人設定を壊さない。
- 必須拡張は Open VSX から ID 指定でインストールする。
- サーバ起動を駆動する `vsserver` スキルをリポ同梱にし、参照先を cc-studio に統一する。

### 非ゴール（YAGNI）

- keepalive ストリーム（MediaSession 無音オーディオ・ハック）の移植はしない。cc-studio は Foreground Service で接続維持を代替済みのため。
- start スクリプトに「未プロビジョニングなら自動 setup」を仕込む統合はしない。
- `product.json` オーバーレイやコア patch（code-server フォーク・ソースビルド）はしない。本設計は上流 submodule 無改変が前提。

## 確定した決定事項（ブレインストーミング）

| 論点 | 決定 |
|---|---|
| 配置 | cc-studio リポ。`server/provision/` 配下 |
| 自動化スコープ | install + config + 常駐 + provision（設定 + 拡張）+ tailscale 公開（手順表示）+ スキル |
| 作りの方向 | OSS 汎用（パラメータ化）。秘密はコミットせず setup 時に生成 |
| settings の入れ方 | プロダクト推奨キーのみ非破壊ディープ merge（個人設定は保全、`.bak` 退避） |
| 拡張のソース | Open VSX を `code-server --install-extension` で取得 |
| 同梱拡張 | `Anthropic.claude-code`（公式）と `ms-vscode.live-server`（HTML プレビュー）の 2 つ。`ShahadIshraq.vscode-claude-sessions`（セッション管理）は**入れない** |
| 起動方式 | systemd ユーザサービス常駐を既定、systemd 不在時は start スクリプトにフォールバック |
| スキル | リポ同梱（`.claude/skills/vsserver/`）。個人グローバル版はリポ版を指すよう更新 |

拡張の Open VSX 可用性は確認済み（3 つとも存在。`Anthropic.claude-code` も同一バージョンで取得可能）。

## ファイル構成

```
server/
  provision/
    setup.sh               # オーケストレータ（冪等・パラメータ化）
    settings.json          # プロダクト推奨 User 設定（merge するキーのみ）
    extensions.txt         # Open VSX 拡張 ID（# でコメント可）
    vsserver.service.tmpl  # systemd user unit テンプレ（パス/ポートを差込）
    start-vsserver.sh      # systemd 無し環境用フォールバック（cc-web から移植・汎用化）
    cc-studio.env.example  # 調整値テンプレ（CC_PORT/CC_FOLDER/CC_BIND…）tracked
    README.md              # tailscale serve 手順を含むセットアップ手順
  code-server/             # 既存 submodule（上流・無改変）。開発時にソースを読む参照のみで
                           #   install には使わない（install は公式プレビルド release を入れる）
.claude/skills/vsserver/
  SKILL.md                 # リポ同梱スキル（参照先を server/provision に）
.gitignore                 # cc-studio.env, config.yaml, *.bak を無視（既存に追記）
```

## 各ユニットの責務とインターフェース

### `cc-studio.env`（調整値）

tracked なのは `cc-studio.env.example` のみ。実値は `cc-studio.env`（gitignore）に置くか環境変数で渡す。

| 変数 | 既定 | 意味 |
|---|---|---|
| `CC_PORT` | `8088` | code-server バインドポート（tailscale serve の転送先と一致させる） |
| `CC_BIND` | `127.0.0.1` | バインドアドレス。HTTPS は前段の tailscale serve に任せるため loopback 既定 |
| `CC_FOLDER` | `$HOME` | 起動時に開く既定フォルダ |
| `CC_USER_DIR` | `~/.local/share/code-server/User` | code-server User 設定ディレクトリ |
| `CC_PREFIX` | `$HOME/.local` | code-server standalone install の prefix |

### `settings.json`（プロダクト推奨 User 設定）

プロダクトが所有するキーだけを持つ。テーマ等の個人設定は入れない。初期内容は最低限、
モバイル向けの不具合回収である markdown プレビュー既定を含む:

```json
{
  "workbench.editorAssociations": {
    "*.md": "vscode.markdown.preview.editor"
  }
}
```

将来モバイル向けの推奨キーが増えたらここに追記する。

### `extensions.txt`

```
# Claude Code 公式拡張（コア）
Anthropic.claude-code
# HTML プレビュー
ms-vscode.live-server
```

### `vsserver.service.tmpl`（systemd user unit テンプレ）

`@CC_BIN@` `@CC_BIND@` `@CC_PORT@` `@CC_FOLDER@` をプレースホルダとして持ち、setup.sh が実値で
置換して `~/.config/systemd/user/vsserver.service` を生成する。要点:

- `ExecStart` は絶対パスの code-server、`--bind-addr @CC_BIND@:@CC_PORT@ @CC_FOLDER@`
- `Restart=on-failure`
- `WantedBy=default.target`

### `setup.sh`（オーケストレータ）

冪等。各ステップは「すでに満たされていれば skip」。`--force` で再投入。

1. **env 読込** — `cc-studio.env` があれば source、無ければ既定。
2. **install** — `$CC_PREFIX/bin/code-server` が無ければ standalone install
   （`curl -fsSL https://code-server.dev/install.sh | sh -s -- --method standalone --prefix "$CC_PREFIX"`）。あれば skip。
3. **config** — `~/.config/code-server/config.yaml` が**無い時だけ**生成。
   `password` は `openssl rand -hex 12` でその場生成。`bind-addr` は `$CC_BIND:$CC_PORT`、`auth: password`、`cert: false`。
   既存ファイルは絶対に上書きしない（利用者の password を保全）。生成場所をログ表示。
4. **service** — テンプレを実値で埋めて unit を生成。`loginctl enable-linger "$USER"`、
   `systemctl --user enable --now vsserver`。systemd user が使えない環境なら警告し、
   フォールバックとして `start-vsserver.sh` の使い方を案内。
5. **provision** — `settings.json` を `$CC_USER_DIR/settings.json` へ非破壊ディープ merge（後述）。
   `extensions.txt` を 1 行ずつ `code-server --install-extension <id>`（導入済みは skip、`--force` で更新）。
6. **expose** — `tailscale serve` 手順を表示（自動実行しない。HTTPS 前段はホスト側＝別マシン/Windows のこともあるため）。
   例: `tailscale serve --bg 127.0.0.1:$CC_PORT`。
7. **サマリ** — 入れた拡張 / merge したキー / アクセス URL を表示。

### `start-vsserver.sh`（フォールバック）

cc-web 版を移植・汎用化。ハードコードされた `<repo-root>/...` 既定や `<user>` を env 由来にする。
`env -i` で VS Code 統合ターミナルの `VSCODE_IPC_HOOK_CLI` を切って素のサーバを起動する挙動は維持する。
`setsid` でデタッチ。systemd を使わない一回起動・別フォルダ起動用。

## データフロー: 設定の非破壊ディープ merge

要件は「プロダクト推奨キーは投入しつつ、利用者の他キーは保全」。これは
「既存 User 設定」と「プロダクト settings.json」のディープ merge（衝突キーはプロダクト側が勝つが、
プロダクトが持つキーに限る）。

- 一次手段: `jq -s '.[0] * .[1]' <user> <product>`（`*` 演算子はオブジェクトを再帰 merge する）。
- フォールバック: `jq` 不在なら python3 で同等のディープ merge。
- 両方無ければ明確に中断し、jq か python3 の導入を案内。
- 書き換え前に既存 `settings.json` を `settings.json.bak` に退避。
- User 設定ファイルが存在しない/空なら、プロダクト settings.json をそのまま採用。

冪等性: 同じ入力で繰り返し流しても収束する（merge 結果は不変、拡張は skip）。

## エラー処理

- `openssl` 不在時は password 生成を代替（`head -c 18 /dev/urandom | base64` 等）し、それも無ければ中断。
- install の network 失敗はそのまま中断（部分状態を作らない）。
- service ステップは systemd user 不在を検知して非致命的にフォールバック案内へ。
- provision の各拡張インストールは失敗しても残りを続行し、最後に失敗一覧を表示（全体は非ゼロ終了）。

## 秘密・個人値の扱い

- コミット対象は `*.example` とテンプレ（プレースホルダのみ）だけ。
- `.gitignore` に `server/provision/cc-studio.env`、`config.yaml` 系、`*.bak` を追加。
- パス/ホスト/ユーザ/ポートはすべて env または実行時解決。リポ内にハードコードしない。
- 既存 `config.yaml` の password は読み取り・上書きしない。

## スキル

- `cc-studio/.claude/skills/vsserver/SKILL.md` に正を同梱。内容は現行スキルを下敷きに、
  参照先を cc-web から `server/provision/*` に差し替え、systemd 通常運用 + フォールバックの両方を記述。
  個人固有のホスト名/パスは「例」として明示し、汎用手順と分離する。
- 個人グローバル版 `~/.claude/skills/vsserver` は、リポ同梱版を指す（重複の正を残さない）よう更新する。

## テスト / 検証

純ロジックの自動テストは持ちにくい領域のため、検証は手順ベースで行う:

1. **merge 単体** — ダミーの User 設定（テーマ等を含む）に対し setup の merge 部分だけを流し、
   テーマが残りつつ `workbench.editorAssociations` が入ることを確認。`.bak` 生成も確認。
2. **冪等性** — `setup.sh` を 2 回流し、2 回目が install/config/extension を skip し差分が出ないことを確認。
3. **クリーン再現** — `CC_USER_DIR` を一時ディレクトリに向けて素の状態から流し、設定・拡張が入ることを確認。
4. **フォールバック** — systemd を使わない経路で `start-vsserver.sh` から起動できることを確認。

実機（スマホ / <tailnet-host>）での起動確認は既存の運用手順（`systemctl --user status vsserver`、
`https://<tailnet-host>/` が 302 を返す）で行う。

## 段階的な実装の指針

1. `server/provision/` の宣言ファイル（`settings.json`、`extensions.txt`、`cc-studio.env.example`、テンプレ）を先に置く。
2. `setup.sh` の provision ステップ（merge + 拡張）から実装・検証（既存サーバに対して安全に試せる）。
3. config / service / install ステップを足す。
4. `start-vsserver.sh` を移植・汎用化。
5. スキルをリポ同梱に移し、個人グローバル版を更新。
6. README の cc-web 分割に関する古い記述を是正（別タスクで予定）。
