#!/bin/bash
# Nearcade Python Sidecar Compiler
# Bundles Python sidecars into standalone native executables using Nuitka.
# Run this script once per platform before building a release.

set -e

cd "$(dirname "$0")/../src/sidecar/input_backends" || exit 1

echo "[compile_sidecars] Nearcade Sidecar Compiler"

# Auto-install Nuitka if missing
if ! python -m nuitka --version &> /dev/null; then
    echo "[compile_sidecars] Nuitka not found — installing..."
    pip install nuitka
fi

# Wipe old artifacts to avoid stale builds
rm -rf bin/
mkdir -p bin
echo "[compile_sidecars] Cleaned previous build artifacts."

OS="$(uname -s)"
echo "[compile_sidecars] Detected OS: $OS"

case "$OS" in
    Linux*)
        echo "[compile_sidecars] Building linux_uinput..."
        python -m nuitka --assume-yes-for-downloads --onefile --output-dir=bin linux_uinput.py
        
        echo "[compile_sidecars] Building experimental backends (Linux)..."
        for script in experimental/backend_*.py; do
            if [[ "$script" == *"win"* ]] || [[ "$script" == *"mac"* ]]; then continue; fi
            python -m nuitka --assume-yes-for-downloads --onefile --output-dir=bin "$script"
        done
        ;;
    Darwin*)
        echo "[compile_sidecars] Building mac_stub & mac_gamepad_bridge..."
        python -m nuitka --assume-yes-for-downloads --onefile --output-dir=bin mac_stub.py
        python -m nuitka --assume-yes-for-downloads --onefile --output-dir=bin mac_gamepad_bridge.py
        
        echo "[compile_sidecars] Building experimental backends (macOS)..."
        for script in experimental/backend_*.py; do
            if [[ "$script" == *"win"* ]] || [[ "$script" == *"linux"* ]]; then continue; fi
            python -m nuitka --assume-yes-for-downloads --onefile --output-dir=bin "$script"
        done
        ;;
    MINGW*|CYGWIN*|MSYS*)
        echo "[compile_sidecars] Building windows_hidmaestro & windows_vigem..."
        python -m nuitka --assume-yes-for-downloads --onefile --output-dir=bin windows_hidmaestro.py
        python -m nuitka --assume-yes-for-downloads --onefile --output-dir=bin windows_vigem.py
        
        echo "[compile_sidecars] Building experimental backends (Windows)..."
        for script in experimental/backend_*.py; do
            if [[ "$script" == *"linux"* ]] || [[ "$script" == *"mac"* ]]; then continue; fi
            python -m nuitka --assume-yes-for-downloads --onefile --output-dir=bin "$script"
        done
        ;;
    *)
        echo "[compile_sidecars] ERROR: Unknown OS '$OS'. Cannot determine which sidecars to build."
        exit 1
        ;;
esac

# read_gamepads.py is a universal utility used on all platforms
echo "[compile_sidecars] Building read_gamepads (cross-platform utility)..."
python -m nuitka --assume-yes-for-downloads --onefile --output-dir=bin read_gamepads.py

echo ""
echo "[compile_sidecars] Done! Binaries are in: src/sidecar/input_backends/bin/"

