#!/bin/bash

cd "$(dirname "$0")"

if [ ! -f "electron-main.js" ]; then
    cd ..
fi

echo "Starting Nearcade Arcade Worker in Isolated Virtual Display..."

if ! command -v xvfb-run &> /dev/null; then
    echo "[ERROR] xvfb-run not found! Please install it (e.g., sudo apt install xvfb)"
    exit 1
fi

# 1. Route ALL audio for this isolated session exclusively to the virtual cable
export PULSE_SINK="NearsecVirtual"

# 2. THE SANDBOX LOCK: Blindfold Chromium and MAME to Wayland.
# If we do not unset these, the apps will escape the Xvfb sandbox,
# connect to your physical monitor, and trigger the OS screen-share popup!
unset WAYLAND_DISPLAY
export XDG_SESSION_TYPE=x11

# 3. Run the worker inside Xvfb (Virtual Framebuffer)
xvfb-run -a -s "-screen 0 1280x720x24 -ac +extension GLX +render -noreset" npx electron . --arcade-worker "$@"
