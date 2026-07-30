#!/bin/sh
# Assembles the Swift menu-bar binary into a signed, Dock-less Meet.app bundle.
# Ad-hoc signature (-s -) is stable per bundle path, so TCC grants persist for
# a bundle kept at a fixed location (recommended: ~/Applications/Meet.app).
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

# Ad-hoc sign. --deep not needed (no embedded frameworks).
codesign --force --sign - "$APP"

echo "Built: $APP"
echo "Install (stable path for TCC):  cp -R \"$APP\" ~/Applications/Meet.app"
echo "Launch:                          open \"$APP\"   # NOT the raw binary"
