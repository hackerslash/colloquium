#!/usr/bin/env bash
# Removes every local trace of a prior Haven install that used the old bundle
# identifier (havenapp): the app itself, its data and caches, the keychain
# identity entry, and macOS permission records. Run this before installing a
# colloquiumapp-identified build.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/hackerslash/Haven/main/scripts/cleanup-old-identifier-macos.sh | bash
set -euo pipefail

OLD_ID="havenapp"
APP="/Applications/Haven.app"

if [ "$(uname)" != "Darwin" ]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

echo "==> Quitting Haven if running"
osascript -e 'quit app "Haven"' >/dev/null 2>&1 || true
pkill -x haven 2>/dev/null || true

if [ -d "$APP" ]; then
  INSTALLED_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$INSTALLED_ID" = "$OLD_ID" ]; then
    echo "==> Removing $APP (old-identifier build)"
    rm -rf "$APP"
  else
    echo "==> Keeping $APP (identifier is '$INSTALLED_ID', not '$OLD_ID')"
  fi
fi

echo "==> Removing app data, caches, and saved state"
rm -rf \
  "$HOME/Library/Application Support/$OLD_ID" \
  "$HOME/Library/Caches/$OLD_ID" \
  "$HOME/Library/WebKit/$OLD_ID" \
  "$HOME/Library/HTTPStorages/$OLD_ID" \
  "$HOME/Library/Logs/$OLD_ID" \
  "$HOME/Library/Saved Application State/$OLD_ID.savedState"

defaults delete "$OLD_ID" >/dev/null 2>&1 || true
rm -f "$HOME/Library/Preferences/$OLD_ID.plist"

echo "==> Deleting keychain identity entry"
security delete-generic-password -s "$OLD_ID" >/dev/null 2>&1 || true

echo "==> Resetting permission records"
tccutil reset All "$OLD_ID" >/dev/null 2>&1 || true

echo "==> Done. No traces of $OLD_ID remain."
