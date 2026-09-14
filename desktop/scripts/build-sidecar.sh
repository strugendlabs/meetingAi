#!/usr/bin/env bash
# Builds the Swift system-audio sidecar and installs it where Tauri's
# externalBin expects it: src-tauri/binaries/system-audio-<target-triple>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"
SIDECAR_DIR="$DESKTOP_DIR/sidecar"
OUT_DIR="$DESKTOP_DIR/src-tauri/binaries"
TRIPLE="${TARGET_TRIPLE:-aarch64-apple-darwin}"

cd "$SIDECAR_DIR"
swift build -c release
BIN_PATH="$(swift build -c release --show-bin-path)/system-audio"

mkdir -p "$OUT_DIR"
cp "$BIN_PATH" "$OUT_DIR/system-audio-$TRIPLE"
chmod +x "$OUT_DIR/system-audio-$TRIPLE"
"$OUT_DIR/system-audio-$TRIPLE" --help >/dev/null
echo "sidecar installed: $OUT_DIR/system-audio-$TRIPLE"
