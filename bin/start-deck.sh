#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

export XDG_RUNTIME_DIR="/run/user/1000"
export DISPLAY="${DISPLAY:-:0}"
export SteamDeck=1
export SteamGamepadUI=1
export XDG_CURRENT_DESKTOP="gamescope"

unset LD_PRELOAD
unset ENABLE_GAMESCOPE_WSI

chmod +x "$DIR/nearcade" 2>/dev/null || true

# Force Gamescope to stretch the nested window to the full 16:10 1280x800 display with 0 black bars
DISPLAY=:0 xprop -root -f GAMESCOPE_NEW_SCALING_SCALER 32c -set GAMESCOPE_NEW_SCALING_SCALER 4 2>/dev/null || true

echo "=== Starting Nearcade on Steam Deck: $(date) ===" >> /tmp/nearcade-deck.log

exec "$DIR/nearcade" \
  --no-sandbox \
  --handheld \
  --remote-debugging-port=9222 \
  --enable-features=WebRTCPipeWireCapturer,VaapiVideoEncoder,VaapiVideoDecoder \
  --enable-zero-copy \
  "$@" >> /tmp/nearcade-deck.log 2>&1
