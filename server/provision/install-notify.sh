#!/usr/bin/env bash
# 通知機能（notify-relay + user フック + tailscale パス公開）の冪等インストーラ。
# クローン後にこれを一度実行すれば、全スクリーン（全プロジェクト）で通知が出るようになる。
# setup.sh の末尾からも呼ばれる。何度実行しても安全。
#
#   ./install-notify.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/cc-studio.env" ]] && { set -a; . "$HERE/cc-studio.env"; set +a; }

RELAY_PORT="${CC_NOTIFY_RELAY_PORT:-8770}"
RELAY_JS="$HERE/../notify-relay/relay.mjs"
NODE_BIN="$(command -v node || true)"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"

log(){ echo "[notify] $*"; }

# ── 1) user スコープのフック（全プロジェクト/スクリーンで発火） ──
# プロジェクト単位だとそのプロジェクトでしか発火しないため、~/.claude に入れる。
mkdir -p "$CLAUDE_DIR"
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
RELAY_PORT="$RELAY_PORT" python3 - "$SETTINGS" <<'PY'
import json, os, shutil, sys
p = sys.argv[1]
port = os.environ.get("RELAY_PORT", "8770")
cmd = ("curl -s -m 3 -X POST -H 'Content-Type: application/json' --data-binary @- "
       '"http://127.0.0.1:${CC_NOTIFY_RELAY_PORT:-' + port + '}/cc-notify" >/dev/null 2>&1 || true')
# パース不能な settings.json を {} で潰すと既存のユーザ設定が全て消えるため、
# 失敗時は何も書かずにエラー終了する。
try:
    d = json.load(open(p))
except Exception as e:
    print(f"[notify] error: {p} を JSON としてパースできません（{e}）。修正してから再実行してください。",
          file=sys.stderr)
    sys.exit(1)
if not isinstance(d, dict):
    print(f"[notify] error: {p} のトップレベルが object ではありません。修正してから再実行してください。",
          file=sys.stderr)
    sys.exit(1)
h = d.get("hooks") or {}
# Stop / Notification だけ差し替え（他イベントの既存フックは温存）。
h["Stop"] = [{"hooks": [{"type": "command", "command": cmd, "timeout": 5}]}]
h["Notification"] = [{"matcher": "permission_prompt",
                      "hooks": [{"type": "command", "command": cmd, "timeout": 5}]}]
d["hooks"] = h
shutil.copy2(p, p + ".bak")           # 書き換え前に backup
tmp = p + ".tmp"
with open(tmp, "w") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
os.replace(tmp, p)                     # temp + rename で途中失敗しても本体を壊さない
print("ok")
PY
log "user フック登録: $SETTINGS （Stop / Notification → notify-relay へ POST）"

# ── 2) 旧 cc-config 由来マニフェスト掃除（本機能とは無関係） ──
rm -f "$HERE/../../.claude/.cc-notify-manifest.json" 2>/dev/null || true

# ── 3) relay を systemd user サービスで常駐（無ければ start-vsserver.sh に委譲） ──
if [[ -z "$NODE_BIN" ]]; then
  log "node が見つからないため relay サービスはスキップ（node 導入後に再実行）"
elif command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/notify-relay.service"
  mkdir -p "$(dirname "$UNIT")"
  sed -e "s#@NODE_BIN@#$NODE_BIN#g" -e "s#@RELAY_JS@#$RELAY_JS#g" \
      -e "s#@RELAY_PORT@#$RELAY_PORT#g" \
      "$HERE/notify-relay.service.tmpl" > "$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now notify-relay
  log "relay を systemd user で常駐化（確認: systemctl --user status notify-relay）"
else
  log "systemd user 不可 — relay は start-vsserver.sh 起動時に立ち上がります"
fi

# ── 4) tailscale serve でパス公開（前段ホストで実行が必要） ──
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  if tailscale serve --bg --set-path /cc-notify "http://127.0.0.1:${RELAY_PORT}"; then
    log "tailscale serve /cc-notify -> 127.0.0.1:${RELAY_PORT} 公開"
  else
    log "tailscale serve に失敗。前段ホストで手動実行してください"
  fi
else
  cat <<EOF
[notify] tailscale はこの環境から操作できません。前段ホスト（Windows 等）で一度だけ実行してください:
    tailscale serve --bg --set-path /cc-notify http://127.0.0.1:${RELAY_PORT}
  （Windows は PowerShell 推奨。Git Bash だと /cc-notify がパス変換されるため MSYS_NO_PATHCONV=1 を付ける）
EOF
fi

log "完了。既に起動中の Claude セッションは一度リロードすると user フックを読み込みます。"
