#!/usr/bin/env bash
# Pre-publish guard: fail if any personal/host-specific token leaked into tracked
# files. Run before opening the repo (or any copy of it) to the public.
#
#   ./scripts/check-clean.sh
#
# The token list is itself sensitive, so it is NOT stored in this tracked script.
# Provide it in a gitignored file (default scripts/personal-tokens.txt), one
# extended-regex (ERE) pattern per line; blank lines and #comments are ignored.
# Without that file the scan falls back to generic secret-shaped patterns.
#
# Scans git-tracked files only, excludes the upstream code-server submodule.
# Exit 0 = clean, 1 = leak(s) found (printed with file:line).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

TOKENS_FILE="${CC_TOKENS_FILE:-scripts/personal-tokens.txt}"

patterns=()
if [[ -f "$TOKENS_FILE" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    patterns+=("$line")
  done < "$TOKENS_FILE"
else
  echo "note: $TOKENS_FILE not found — using generic fallback patterns" >&2
  # email addresses and private CGNAT-range IPs (the tailscale 100.64/10 block)
  patterns+=('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
  patterns+=('100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}')
fi

PATTERN="$(IFS='|'; printf '%s' "${patterns[*]}")"
if [[ -z "$PATTERN" ]]; then
  echo "error: assembled pattern is empty ($TOKENS_FILE has no usable lines) — refusing to report clean" >&2
  exit 2
fi

# git grep: 0 = hits, 1 = clean, anything else (e.g. 128 invalid ERE) = real error.
# Do NOT mask non-1 failures with `|| true` — that would print "clean" having scanned nothing.
set +e
hits="$(git grep -nIE "$PATTERN" -- . ':(exclude)server/code-server')"
status=$?
set -e
if [[ $status -eq 0 ]]; then
  echo "✗ personal tokens found in tracked files:" >&2
  echo "$hits" >&2
  exit 1
elif [[ $status -ne 1 ]]; then
  echo "error: git grep failed with exit $status (invalid pattern?) — scan did not complete" >&2
  exit "$status"
fi

echo "✓ clean — no personal tokens in tracked files (submodule excluded)"
