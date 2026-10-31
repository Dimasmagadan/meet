#!/bin/sh
# Swift side of the test suite (npm run test:swift). Debug builds on purpose:
# the MenuBar/AudioCapture self-checks use assert(), which -O release builds
# strip, so a release binary's --self-test-* always prints OK without checking
# anything.
set -e

cd "$(dirname "$0")/.."

echo "== AudioCapture: build"
(cd native/AudioCapture && swift build)

echo "== AudioCapture: WriterErrorBudget self-test"
native/AudioCapture/.build/debug/AudioCapture --output-dir /tmp/meet-selftest --self-test-writer

echo "== AudioAnalysis: WavIO self-test"
native/AudioCapture/.build/debug/AudioAnalysis self-test-wavio

echo "== MenuBar: build + self-tests"
(cd native/MenuBar && swift build)
native/MenuBar/.build/debug/MeetMenuBar --self-test-notch
native/MenuBar/.build/debug/MeetMenuBar --self-test-calendar
native/MenuBar/.build/debug/MeetMenuBar --self-test-recording
