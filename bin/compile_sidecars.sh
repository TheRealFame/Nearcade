#!/bin/bash
# Nearcade Python Sidecar Compiler
# Bundles Python sidecars into standalone native executables using PyInstaller.
# Run this script once per platform before building a release.

set -e

cd "$(dirname "$0")/../src/sidecar/input_backends" || exit 1

echo "[compile_sidecars] Nearcade Sidecar Compiler"

# Auto-install PyInstaller if missing
if ! command -v pyinstaller &> /dev/null; then
    echo "[compile_sidecars] PyInstaller not found — installing..."
    pip install pyinstaller
fi

# Wipe old artifacts to avoid stale builds
rm -rf build/ dist/ *.spec
echo "[compile_sidecars] Cleaned previous build artifacts."

OS="$(uname -s)"
echo "[compile_sidecars] Detected OS: $OS"

case "$OS" in
    Linux*)
        echo "[compile_sidecars] Building linux_uinput..."
        pyinstaller --onefile --name linux_uinput linux_uinput.py
        ;;
    Darwin*)
        echo "[compile_sidecars] Building mac_stub & mac_gamepad_bridge..."
        pyinstaller --onefile --name mac_stub mac_stub.py
        pyinstaller --onefile --name mac_gamepad_bridge mac_gamepad_bridge.py
        ;;
    MINGW*|CYGWIN*|MSYS*)
        echo "[compile_sidecars] Building windows_hidmaestro & windows_vigem..."
        pyinstaller --onefile --name windows_hidmaestro windows_hidmaestro.py
        pyinstaller --onefile --name windows_vigem windows_vigem.py
        ;;
    *)
        echo "[compile_sidecars] ERROR: Unknown OS '$OS'. Cannot determine which sidecars to build."
        exit 1
        ;;
esac

# read_gamepads.py is a universal utility used on all platforms
echo "[compile_sidecars] Building read_gamepads (cross-platform utility)..."
pyinstaller --onefile --name read_gamepads read_gamepads.py

echo ""
echo "[compile_sidecars] Done! Binaries are in: src/sidecar/input_backends/dist/"
