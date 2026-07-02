#!/usr/bin/env bash
# 同梱拡張 cc-open（.md をタブ内プレビューへ自動切替）を code-server へインストール（冪等）。
#   cc-open/ を .vsix にパッケージ → code-server --install-extension で入れる。
#   同じバージョンが入っていればスキップ。setup.sh から呼ばれるが単独実行も可。
#
#   ./install-cc-open.sh            # 通常
#   ./install-cc-open.sh --force    # 同バージョンでも再インストール
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

log()  { printf '\033[36m[cc-open]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[cc-open] error:\033[0m %s\n' "$*" >&2; exit 1; }

if [[ -f "$HERE/cc-studio.env" ]]; then set -a; . "$HERE/cc-studio.env"; set +a; fi
CC_PREFIX="${CC_PREFIX:-$HOME/.local}"
CC_BIN="$CC_PREFIX/bin/code-server"
[[ -x "$CC_BIN" ]] || die "code-server が見つかりません（$CC_BIN）— 先に setup.sh を実行"
command -v python3 >/dev/null || die "vsix パッケージに python3 が必要です"

# setup.sh と同じ理由（統合ターミナル継承の VSCODE_* 誤動作回避）で env -i。
cs() {
  env -i HOME="$HOME" USER="${USER:-$(id -un)}" LANG="${LANG:-C.UTF-8}" \
    PATH="$CC_PREFIX/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$CC_BIN" "$@"
}

SRC="$HERE/cc-open"
VER="$(python3 -c "import json;print(json.load(open('$SRC/package.json'))['version'])")"
ID="ccstudio.cc-open"

if [[ $FORCE -eq 0 ]] && cs --list-extensions --show-versions 2>/dev/null | grep -qx "$ID@$VER"; then
  log "$ID@$VER already installed — skip"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
VSIX="$TMP/cc-open-$VER.vsix"

# vsce を使わず最小構成の vsix（zip）を組む:
#   [Content_Types].xml / extension.vsixmanifest / extension/<ソース一式>
python3 - "$SRC" "$VSIX" "$VER" <<'PY'
import os, sys, zipfile
src, vsix, ver = sys.argv[1], sys.argv[2], sys.argv[3]
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="cc-open" Version="{ver}" Publisher="ccstudio"/>
    <DisplayName>CC Open</DisplayName>
    <Description xml:space="preserve">Auto-switch text-opened .md to in-tab preview.</Description>
    <Categories>Other</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
'''
ctypes = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
</Types>
'''
with zipfile.ZipFile(vsix, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", ctypes)
    z.writestr("extension.vsixmanifest", manifest)
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git")]
        for f in files:
            p = os.path.join(root, f)
            z.write(p, "extension/" + os.path.relpath(p, src))
PY

log "installing $ID@$VER from $(basename "$VSIX") ..."
args=(--install-extension "$VSIX")
[[ $FORCE -eq 1 ]] && args+=(--force)
cs "${args[@]}" >/dev/null
log "done（反映は code-server 再起動 or ウィンドウリロード後）"
