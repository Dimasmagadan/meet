#!/bin/sh
# Assembles the Swift menu-bar binary into a signed, Dock-less Meet.app bundle.
# Signed with a stable self-signed identity "Meet Self-Signed" when present, so
# TCC grants persist across rebuilds. Ad-hoc (-s -) mints a new cdhash every
# build, so TCC can't durably recognize the app and re-prompts each launch.
# Falls back to ad-hoc on machines without the cert (CI / other contributors).
set -e

cd "$(dirname "$0")/.."          # native/MenuBar

swift build -c release

APP="$PWD/.build/Meet.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp .build/release/MeetMenuBar "$APP/Contents/MacOS/MeetMenuBar"
cp Info.plist "$APP/Contents/Info.plist"

# Optional icon (drop Meet.icns next to Info.plist to pick it up):
if [ -f Meet.icns ]; then
  cp Meet.icns "$APP/Contents/Resources/Meet.icns"
fi

# Sign with a stable identity when available so TCC grants survive rebuilds;
# ad-hoc fallback otherwise. --deep not needed (no embedded frameworks).
if security find-identity -p codesigning | grep -q '"Meet Self-Signed"'; then
  SIGN_ID="Meet Self-Signed"
else
  SIGN_ID="-"
fi
codesign --force --sign "$SIGN_ID" "$APP"
echo "Signed with: $SIGN_ID"

echo "Built: $APP"
echo "Launch:  open \"$APP\"   # NOT the raw binary"
