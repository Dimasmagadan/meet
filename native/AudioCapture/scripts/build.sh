#!/bin/sh
# Builds and codesigns the AudioCapture Swift binary. Signed with a stable
# self-signed identity "Meet Self-Signed" when present, so TCC grants persist
# across rebuilds. AudioCapture is the process that actually calls
# SCStream/AVAudioEngine, so macOS attributes Mic/Screen TCC grants to THIS
# binary — ad-hoc (-s -) mints a new cdhash every build, so TCC can't durably
# recognize it and re-prompts each launch. Falls back to ad-hoc on machines
# without the cert (CI / other contributors).
set -e

cd "$(dirname "$0")/.."   # native/AudioCapture

swift build -c release

BIN=".build/release/AudioCapture"
if security find-identity -p codesigning | grep -q '"Meet Self-Signed"'; then
  SIGN_ID="Meet Self-Signed"
else
  SIGN_ID="-"
fi
codesign --force --sign "$SIGN_ID" "$BIN"
echo "Signed with: $SIGN_ID"
echo "Built: $PWD/$BIN"
