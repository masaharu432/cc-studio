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
