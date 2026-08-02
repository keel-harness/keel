#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: smoke-release-carrier.sh /absolute/path/to/keel-harness-VERSION.tgz" >&2
  exit 2
fi

TARBALL="$1"
case "$TARBALL" in
  /*) ;;
  *) echo "release carrier path must be absolute" >&2; exit 2 ;;
esac
test -f "$TARBALL"

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
WORK=$(realpath "$WORK")
trap 'rm -rf "$WORK"' EXIT
export PNPM_HOME="$WORK/pnpm-home"
export XDG_CACHE_HOME="$WORK/cache"
export XDG_CONFIG_HOME="$WORK/config"
export XDG_DATA_HOME="$WORK/data"
export KEEL_HOME="$WORK/keel-home"
mkdir -p "$PNPM_HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$KEEL_HOME"
chmod 700 "$KEEL_HOME"
export PATH="$PNPM_HOME:$PATH"

pnpm add --global "$TARBALL"
KEEL_BIN="$PNPM_HOME/keel"
test -x "$KEEL_BIN"
"$KEEL_BIN" --version | grep -Fx "keel 0.1.1"
"$KEEL_BIN" doctor

OUT=$("$KEEL_BIN" run -p "verify the release carrier" --verbose --replay "$REPO_ROOT/packaging/smoke.recording.json" 2>&1)
echo "$OUT" | grep -Fq 'bash  done'
echo "$OUT" | grep -Fq 'result: stdout: keel-replay-ok'
echo "$OUT" | grep -Fq 'replay-smoke-complete'

SESSION_FILE=$(find "$KEEL_HOME/audit" -maxdepth 1 -type f -name 'ses_*.jsonl' | sort | head -1)
test -n "$SESSION_FILE"
SESSION_ID=$(basename "$SESSION_FILE" .jsonl)
EXPORT_OUT=$("$KEEL_BIN" audit export "$SESSION_ID" --out "$WORK/bundles" 2>&1)
echo "$EXPORT_OUT" | grep -Fq 'exported audit bundle:'
BUNDLE="$WORK/bundles/bundle_$SESSION_ID"
VERIFY_OUT=$("$KEEL_BIN" audit verify "$BUNDLE" 2>&1)
echo "$VERIFY_OUT" | grep -Fq 'verified audit bundle:'
OFFLINE_OUT=$(node "$BUNDLE/verify/verify-bundle.mjs" "$BUNDLE" 2>&1)
echo "$OFFLINE_OUT" | grep -Fq 'OK sha256:'

node "$REPO_ROOT/packaging/smoke-npx-mcp-review.mjs" "$KEEL_BIN"
node "$REPO_ROOT/packaging/smoke-dotenv-isolation.mjs" "$KEEL_BIN"

DLX_OUT=$(pnpm --package "$TARBALL" dlx keel --version)
echo "$DLX_OUT" | grep -Fx "keel 0.1.1"
echo "release carrier smoke passed with Node $(node --version)"
