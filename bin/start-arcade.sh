#!/bin/bash

cd "$(dirname "$0")"

if [ ! -f "electron-main.js" ]; then
    cd ..
fi

# 0. FIREJAIL BYPASS (same guard as bin/start.cmd)
#    `sudo firecfg` symlinked ~211 binaries in /usr/local/bin to /usr/bin/firejail,
#    Xvfb among them. xvfb-run invokes a bare `Xvfb`, so it gets firejail — which
#    runs Xvfb in a private /tmp where it CANNOT bind its socket:
#        _XSERVTransSocketCreateListener: failed to bind listener
#    Xvfb then stays alive with no socket at all, and every X client below blocks
#    forever waiting for a display that never exists (banner, then silence).
#    Prefer the real binaries in /usr/bin while any of these resolve to firejail.
for _b in Xvfb Xephyr node npx npm; do
    if [ "$(readlink -f "$(command -v "$_b" 2>/dev/null)" 2>/dev/null)" = "/usr/bin/firejail" ]; then
        echo "[guard] $_b resolves to firejail — using /usr/bin instead"
        export PATH="/usr/bin:$PATH"
        break
    fi
done

echo "Starting Nearcade Arcade Worker in Isolated Virtual Display..."

if ! command -v xvfb-run &> /dev/null; then
    echo "[ERROR] xvfb-run not found! Please install it (e.g., sudo apt install xvfb)"
    exit 1
fi

# 1. Route ALL audio for this isolated session exclusively to the virtual cable
#    (NearcadeVirtual is the sink audio_worker.js / audio_driver.py create —
#     the old "NearsecVirtual" name no longer exists.)
export PULSE_SINK="NearcadeVirtual"

# 2. THE SANDBOX LOCK: Blindfold Chromium and MAME to Wayland.
# If we do not unset these, the apps will escape the Xvfb sandbox,
# connect to your physical monitor, and trigger the OS screen-share popup!
unset WAYLAND_DISPLAY
export XDG_SESSION_TYPE=x11

# 3. Run the worker inside Xvfb (Virtual Framebuffer)
xvfb-run -a -s "-screen 0 1280x720x24 -ac +extension GLX +render -noreset" npx electron . --arcade-worker "$@"
