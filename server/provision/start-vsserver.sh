#!/usr/bin/env bash
# systemd を使わない環境用のフォールバック起動（冪等）。一回起動・別フォルダ起動に。
# 通常は setup.sh が入れる systemd user service `vsserver` を使う。
#
#   ./start-vsserver.sh [folder]
#
# なぜ env -i するか: VS Code 統合ターミナルから起動すると VSCODE_IPC_HOOK_CLI で
# code-server が実行中インスタンスへ転送して自分のサーバを立てずに exit(0) する。
# 環境を絞って必ず新規サーバを起動する。setsid で起動シェルから切り離す。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/cc-studio.env" ]] && { set -a; . "$HERE/cc-studio.env"; set +a; }

PORT="${CC_PORT:-8088}"
BIND="${CC_BIND:-127.0.0.1}"
FOLDER="${1:-${CC_FOLDER:-$HOME}}"
PREFIX="${CC_PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin/code-server"
LOG="$HOME/.local/share/code-server/start.log"
RELAY_PORT="${CC_NOTIFY_RELAY_PORT:-8770}"
RELAY_JS="$HERE/../notify-relay/relay.mjs"
RELAY_LOG="$HOME/.local/share/code-server/notify-relay.log"

[[ -x "$BIN" ]] || { echo "code-server not found at $BIN（先に setup.sh）" >&2; exit 1; }

if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
  echo "code-server already listening on ${BIND}:${PORT}"
  exit 0
fi

setsid env -i HOME="$HOME" USER="${USER:-$(id -un)}" LANG="${LANG:-C.UTF-8}" \
  PATH="$PREFIX/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  "$BIN" --bind-addr "${BIND}:${PORT}" "$FOLDER" >"$LOG" 2>&1 &

for _ in $(seq 1 30); do
  ss -tln 2>/dev/null | grep -q ":${PORT} " && break
  sleep 1
done

if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
  echo "code-server UP on ${BIND}:${PORT}  (folder: ${FOLDER})"
  echo "  log: ${LOG}  |  stop: pkill -f 'lib/code-server'"
else
  echo "code-server failed to start; tail of ${LOG}:" >&2
  tail -20 "$LOG" >&2 || true
  exit 1
fi

# notify-relay（未起動なら起動）
if ! ss -tln 2>/dev/null | grep -q "127.0.0.1:${RELAY_PORT} "; then
  if command -v node >/dev/null 2>&1 && [[ -f "$RELAY_JS" ]]; then
    setsid env -i HOME="$HOME" PATH="$PREFIX/bin:/usr/local/bin:/usr/bin:/bin" \
      CC_NOTIFY_RELAY_PORT="$RELAY_PORT" node "$RELAY_JS" >"$RELAY_LOG" 2>&1 &
    echo "notify-relay starting on 127.0.0.1:${RELAY_PORT}  (log: ${RELAY_LOG})"
  else
    echo "notify-relay skipped (node not found or relay.mjs missing)" >&2
  fi
else
  echo "notify-relay already on 127.0.0.1:${RELAY_PORT}"
fi
