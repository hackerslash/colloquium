#!/usr/bin/env bash
# Re-sign the macOS dev binary with the stable "Haven Dev" self-signed identity so
# that granted TCC permissions (Screen Recording, Accessibility, Camera, Mic)
# survive rebuilds. Without this, the linker's ad-hoc signature pins the grant to
# a cdhash that changes every build, forcing macOS to re-prompt each launch.
set -euo pipefail

IDENTITY="Haven Dev"
BIN="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/target/debug/haven"
ENTITLEMENTS="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/entitlements.plist"

[ "$(uname)" = "Darwin" ] || { echo "sign-dev: not macOS, skipping"; exit 0; }

if ! security find-identity -p codesigning | grep -q "$IDENTITY"; then
  echo "sign-dev: '$IDENTITY' code-signing identity not found in keychain — skipping."
  echo "         Create it once (Keychain Access > Certificate Assistant) or re-import the cert."
  exit 0
fi

[ -f "$BIN" ] || { echo "sign-dev: $BIN not built yet — run a build first."; exit 0; }

codesign --force --identifier haven --entitlements "$ENTITLEMENTS" -s "$IDENTITY" "$BIN"
echo "sign-dev: signed $BIN with '$IDENTITY'"
codesign -d --requirements - "$BIN" 2>&1 | grep designated || true
