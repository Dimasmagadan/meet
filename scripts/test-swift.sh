#!/bin/sh
# Swift side of the test suite (npm run test:swift). Debug builds on purpose:
# the MenuBar self-checks use assert(), which -O release builds strip, so a
# release binary's --self-test-* always prints OK without checking anything.
# AudioCapture has no runnable tests (Command Line Tools ship without XCTest),
# so it only gets a compile check.
set -e

cd "$(dirname "$0")/.."

echo "== AudioCapture: build"
(cd native/AudioCapture && swift build)

echo "== MenuBar: build + self-tests"
(cd native/MenuBar && swift build)
native/MenuBar/.build/debug/MeetMenuBar --self-test-notch
native/MenuBar/.build/debug/MeetMenuBar --self-test-calendar
