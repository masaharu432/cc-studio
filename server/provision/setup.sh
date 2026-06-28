#!/usr/bin/env bash
# cc-studio サーバ・ブリングアップ（冪等）。
#   install code-server → config 生成 → systemd ユーザサービス常駐 →
#   推奨 User 設定の非破壊 merge → 拡張インストール → tailscale 公開手順を表示。
#
#   ./setup.sh            # 通常
#   ./setup.sh --force    # 拡張を再インストール（--install-extension --force）
#
# 調整値は cc-studio.env（無ければ既定）または環境変数。設計:
#   docs/specs/2026-06-29-cc-studio-server-bringup-design.md
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

log()  { printf '\033[36m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[setup] warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[setup] error:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1) env ----
if [[ -f "$HERE/cc-studio.env" ]]; then set -a; . "$HERE/cc-studio.env"; set +a; fi
CC_PORT="${CC_PORT:-8088}"
CC_BIND="${CC_BIND:-127.0.0.1}"
CC_FOLDER="${CC_FOLDER:-$HOME}"
CC_USER_DIR="${CC_USER_DIR:-$HOME/.local/share/code-server/User}"
CC_PREFIX="${CC_PREFIX:-$HOME/.local}"
CC_BIN="$CC_PREFIX/bin/code-server"

# code-server CLI を VS Code / code-server 統合ターミナルから叩くと、継承された
# VSCODE_* 環境変数（VSCODE_IPC_HOOK_CLI / VSCODE_ESM_ENTRYPOINT /
# CODE_SERVER_SESSION_SOCKET 等）で CLI が "not spawned with IPC" と誤動作する。
# env -i で完全にクリーンな環境にして素のバイナリを叩く。
cs() {
  env -i HOME="$HOME" USER="${USER:-$(id -un)}" LANG="${LANG:-C.UTF-8}" \
    PATH="$CC_PREFIX/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$CC_BIN" "$@"
}

# ---- 2) install ----
if [[ -x "$CC_BIN" ]]; then
  log "code-server already installed ($CC_BIN) — skip"
else
  command -v curl >/dev/null || die "curl が必要です"
  log "installing code-server (standalone) into $CC_PREFIX ..."
  curl -fsSL https://code-server.dev/install.sh | sh -s -- --method standalone --prefix "$CC_PREFIX"
  [[ -x "$CC_BIN" ]] || die "install 完了したが $CC_BIN が見つからない"
fi

# ---- 3) config（無い時だけ生成。既存の password は保全） ----
CONFIG="$HOME/.config/code-server/config.yaml"
if [[ -f "$CONFIG" ]]; then
  log "config exists ($CONFIG) — そのまま（password 保全）"
else
  log "generating $CONFIG （ランダム password をその場生成）"
  mkdir -p "$(dirname "$CONFIG")"
  if command -v openssl >/dev/null; then
    pw="$(openssl rand -hex 12)"
  elif [[ -r /dev/urandom ]]; then
    pw="$(head -c 18 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)"
  else
    die "password 生成に openssl か /dev/urandom が必要です"
  fi
  [[ -n "$pw" ]] || die "password を生成できませんでした"
  umask 077
  cat > "$CONFIG" <<EOF
bind-addr: $CC_BIND:$CC_PORT
auth: password
password: $pw
cert: false
EOF
  log "  password は $CONFIG に書きました"
fi

# ---- 4) service（systemd user 常駐。無ければフォールバック案内） ----
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/vsserver.service"
  mkdir -p "$(dirname "$UNIT")"
  sed -e "s#@CC_BIN@#$CC_BIN#g" -e "s#@CC_BIND@#$CC_BIND#g" \
      -e "s#@CC_PORT@#$CC_PORT#g" -e "s#@CC_FOLDER@#$CC_FOLDER#g" \
      "$HERE/vsserver.service.tmpl" > "$UNIT"
  loginctl enable-linger "$USER" >/dev/null 2>&1 || \
    warn "enable-linger 失敗（boot 時自動起動が効かないかも）"
  systemctl --user daemon-reload
  systemctl --user enable --now vsserver
  log "vsserver service enabled + started（$CC_BIND:$CC_PORT, folder $CC_FOLDER）"
else
  warn "systemd user instance が使えません — service はスキップ。"
  warn "  手動起動: $HERE/start-vsserver.sh [folder]"
fi

# ---- 5a) provision: 推奨 User 設定を非破壊ディープ merge ----
mkdir -p "$CC_USER_DIR"
US="$CC_USER_DIR/settings.json"
PRODUCT="$HERE/settings.json"
if [[ -s "$US" ]]; then
  cp "$US" "$US.bak"
  if command -v jq >/dev/null; then
    jq -s '.[0] * .[1]' "$US.bak" "$PRODUCT" > "$US"
  elif command -v python3 >/dev/null; then
    python3 - "$US.bak" "$PRODUCT" "$US" <<'PY'
import json, sys
def deep(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict): deep(a[k], v)
        else: a[k] = v
    return a
user = json.load(open(sys.argv[1])); prod = json.load(open(sys.argv[2]))
json.dump(deep(user, prod), open(sys.argv[3], "w"), indent=2, ensure_ascii=False)
PY
  else
    die "settings の merge に jq か python3 が必要です"
  fi
  log "merged 推奨設定 → $US（backup: $US.bak）"
else
  cp "$PRODUCT" "$US"
  log "seeded $US（既存が無かったので推奨設定をそのまま採用）"
fi

# ---- 5b) provision: 拡張インストール ----
# extensions.txt（tracked）+ extensions.local.txt（任意・gitignore）の両方を読む。
ext_failed=()
for listfile in "$HERE/extensions.txt" "$HERE/extensions.local.txt"; do
  [[ -f "$listfile" ]] || continue
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    id="${raw%%#*}"; id="$(printf '%s' "$id" | tr -d '[:space:]')"
    [[ -z "$id" ]] && continue
    args=(--install-extension "$id")
    [[ $FORCE -eq 1 ]] && args+=(--force)
    log "extension: $id"
    cs "${args[@]}" >/dev/null 2>&1 || ext_failed+=("$id")
  done < "$listfile"
done

# ---- 6) expose: tailscale serve は前段ホスト側で手動 ----
cat <<EOF

[setup] 公開（HTTPS）は前段ホストで tailscale serve を一度だけ:
    tailscale serve --bg $CC_BIND:$CC_PORT
  → https://<your-tailnet-host>/ で開ける（302→ログインは正常）。
  WSL の場合 serve は Windows 側で実行する（mirrored networking で loopback 共有）。
EOF

# ---- 7) summary ----
log "done. settings: $US"
if [[ ${#ext_failed[@]} -gt 0 ]]; then
  warn "拡張インストール失敗: ${ext_failed[*]}"
  exit 1
fi
log "extensions OK / service: systemctl --user status vsserver"
