---
name: vsserver
description: Bring up / check / restart the cc-studio code-server workbench that the Android app wraps. Use when the user says "vsserver 起動 / 立ち上げて", "code-server 起こして", the HTTPS workbench is unreachable, or right after cloning to provision the server.
---

# cc-studio code-server (vsserver) workbench

cc-studio が WebView で包む **code-server** をローカルで起動・管理する。サーバ側の
install〜常駐〜推奨設定/拡張は `server/provision/` に集約されている。

詳細: [server/provision/README.md](../../../server/provision/README.md) /
設計 [docs/specs/2026-06-29-cc-studio-server-bringup-design.md](../../../docs/specs/2026-06-29-cc-studio-server-bringup-design.md)

## 初回セットアップ（冪等）

```bash
./server/provision/setup.sh
```

install → `config.yaml` 生成 → **systemd ユーザサービス `vsserver` 常駐**（linger 付きで
boot 時自動）→ 推奨 User 設定の非破壊 merge → 拡張インストール。調整値は
`server/provision/cc-studio.env`（無ければ既定：ポート 8088 等）。

## 通常運用（systemd user service）

```bash
systemctl --user status vsserver        # 動いているか
systemctl --user restart vsserver        # 再起動
journalctl --user -u vsserver -f         # ログ
systemctl --user enable --now vsserver   # unit が消えていたら再インストール
```

## フォールバック（systemd 無し / 一回起動・別フォルダ）

```bash
./server/provision/start-vsserver.sh [folder]
```

冪等。既に起動済みなら早期 exit。`setsid` で起動シェルから切り離す。

## HTTPS 公開（Tailnet）

HTTPS は前段ホストで `tailscale serve` を一度だけ:

```bash
tailscale serve --bg 127.0.0.1:8088
```

WSL の場合、`tailscale serve` は **Windows 側**で実行（mirrored networking で loopback 共有）。
起動後 `https://<your-tailnet-host>/` が 302（→ ログイン）を返せば正常。

## チェック / 停止

```bash
ss -tln | grep :8088                     # listening?
systemctl --user stop vsserver           # 停止（推奨）
```

## なぜ素の `code-server` CLI を直接叩かないか

code-server / VS Code 統合ターミナルから叩くと、継承された `VSCODE_*` 環境変数
（`VSCODE_IPC_HOOK_CLI` / `VSCODE_ESM_ENTRYPOINT` / `CODE_SERVER_SESSION_SOCKET` 等）で
CLI が `error not spawned with IPC` になり、実行中インスタンスへ委譲して自分のサーバを
立てずに exit する。`setup.sh` / `start-vsserver.sh` は `env -i` でクリーンな環境にして回避する。
```
