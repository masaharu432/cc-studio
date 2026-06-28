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

1. **install** — `code-server` が無ければ standalone install（`$CC_PREFIX`）。
2. **config** — `~/.config/code-server/config.yaml` を**無い時だけ**生成（password はその場生成、既存は保全）。
3. **service** — systemd ユーザサービス `vsserver` を生成・有効化（linger 付きで boot 時自動）。
   systemd が無ければ `start-vsserver.sh` 案内にフォールバック。
4. **provision** — 推奨 User 設定（`settings.json`）を**非破壊ディープ merge**（既存は `.bak` 退避）し、
   `extensions.txt` の拡張を Open VSX からインストール。

## 公開（HTTPS / Tailnet）

HTTPS は前段のホストで `tailscale serve` を一度だけ設定する（スクリプトは自動実行しない）:

```bash
tailscale serve --bg 127.0.0.1:8088
# → https://<your-tailnet-host>/   （302 → ログインは正常）
```

WSL で動かす場合、`tailscale serve` は **Windows 側**で実行する（mirrored networking で
Windows loopback が WSL loopback に届く）。

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
| `vsserver.service.tmpl` | systemd user unit テンプレ |
| `start-vsserver.sh` | systemd 無し用フォールバック起動 |
| `cc-studio.env.example` | 調整値テンプレ |
