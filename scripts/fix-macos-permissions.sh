#!/usr/bin/env bash
# Clears the Gatekeeper quarantine flag from an installed Haven.app and re-signs
# it with a stable, locally-generated certificate (creating one on first run if
# needed) instead of the release build's ad-hoc signature.
#
# Why: Haven's release builds aren't signed with a paid Apple Developer ID, so
# the .app carries an ad-hoc signature with no Team Identifier. macOS won't
# persist Screen Recording / Camera / Mic grants across relaunches for an
# ad-hoc-signed app — it re-prompts every time, even after you approve it and
# even with the quarantine flag cleared. Re-signing with a real (if
# self-issued) certificate gives macOS a stable identity to bind the grant to.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/hackerslash/Haven/main/scripts/fix-macos-permissions.sh | bash
#   # or, for a non-default install location:
#   curl -fsSL .../fix-macos-permissions.sh | bash -s -- /path/to/Haven.app
set -euo pipefail

APP="${1:-/Applications/Haven.app}"
IDENTITY="Haven Local Signing"

if [ "$(uname)" != "Darwin" ]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

if [ ! -d "$APP" ]; then
  echo "Haven.app not found at $APP" >&2
  echo "Pass its path: fix-macos-permissions.sh /path/to/Haven.app" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> Removing quarantine flag from $APP"
xattr -cr "$APP"

if ! security find-identity -p codesigning | grep -q "$IDENTITY"; then
  echo "==> Creating local code-signing identity '$IDENTITY' (one-time)"

  cat > "$WORKDIR/codesign.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = $IDENTITY

[v3_req]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

  openssl req -x509 -newkey rsa:2048 -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" \
    -days 3650 -nodes -config "$WORKDIR/codesign.cnf" >/dev/null 2>&1

  PASSWORD="$(openssl rand -base64 24)"
  openssl pkcs12 -export -out "$WORKDIR/cert.p12" \
    -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" -passout "pass:$PASSWORD" >/dev/null 2>&1

  security import "$WORKDIR/cert.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
    -P "$PASSWORD" -T /usr/bin/codesign
fi

cat > "$WORKDIR/entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.device.audio-input</key>
	<true/>
	<key>com.apple.security.device.camera</key>
	<true/>
</dict>
</plist>
PLIST

echo "==> Signing $APP with '$IDENTITY'"
codesign --force --identifier haven --entitlements "$WORKDIR/entitlements.plist" -s "$IDENTITY" "$APP"

echo "==> Done. Fully quit Haven (Cmd+Q) if it's running, then reopen it."
echo "    Grant Screen Recording / Camera / Mic once more — after that they"
echo "    should persist across future launches."
