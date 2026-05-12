#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }

echo "=== meet setup ==="

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

SWIFT_BIN="$(pwd)/native/AudioCapture/.build/release/AudioCapture"
if [[ -f "$SWIFT_BIN" ]]; then
    ok "AudioCapture: $SWIFT_BIN"
else
    warn "AudioCapture not built. Run: cd native/AudioCapture && swift build -c release"
fi

OUTPUT_DIR="$HOME/Meetings"
mkdir -p "$OUTPUT_DIR"
ok "output dir: $OUTPUT_DIR"

CONFIG_DIR="$HOME/.meet"
mkdir -p "$CONFIG_DIR"
ok "config dir: $CONFIG_DIR"

echo ""
echo "Setup complete. Run: meet start \"My Meeting\""
