#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

# Resolve relative to the script's own location, not the caller's cwd — this
# script is meant to be runnable from anywhere (`bash /path/to/meet/scripts/setup.sh`),
# and `$(pwd)`-based paths silently resolved to the wrong repo (or nothing).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== meet setup ($REPO_ROOT) ==="

if [[ "$(uname)" != "Darwin" ]]; then
    fail "macOS required"
    exit 1
fi
ok "macOS detected"

if [[ "$(uname -m)" != "arm64" ]]; then
    warn "Not Apple Silicon (arm64). Build may work but is untested."
fi

if command -v whisper-cli &>/dev/null; then
    ok "whisper-cli: $(which whisper-cli)"
else
    fail "whisper-cli not found"
    echo "  Install: brew install whisper-cpp"
    exit 1
fi

MODEL_DIR="$HOME/.meet/models"
MODEL_FILE="$MODEL_DIR/ggml-small.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"

mkdir -p "$MODEL_DIR"

if [[ -f "$MODEL_FILE" ]]; then
    ok "model: $MODEL_FILE"
else
    echo "Downloading ggml-small.bin (466MB)..."
    curl -L -o "$MODEL_FILE" "$MODEL_URL"
    ok "model downloaded: $MODEL_FILE"
fi

SWIFT_BIN="$REPO_ROOT/native/AudioCapture/.build/release/AudioCapture"
if [[ -f "$SWIFT_BIN" ]]; then
    ok "AudioCapture: $SWIFT_BIN"
else
    warn "AudioCapture not built, building now..."
    if "$REPO_ROOT/native/AudioCapture/scripts/build.sh"; then
        ok "AudioCapture built: $SWIFT_BIN"
    else
        fail "AudioCapture build failed"
    fi
fi

OUTPUT_DIR="$HOME/Meetings"
mkdir -p "$OUTPUT_DIR"
ok "output dir: $OUTPUT_DIR"

CONFIG_DIR="$HOME/.meet"
mkdir -p "$CONFIG_DIR"
ok "config dir: $CONFIG_DIR"

echo ""
if [[ ! -f "$SWIFT_BIN" ]]; then
    fail "Setup incomplete: AudioCapture is not built, meet start would fail."
    exit 1
fi
echo "Setup complete. Run: meet start \"My Meeting\""
