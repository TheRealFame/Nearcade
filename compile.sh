#!/bin/bash
# compile.sh - Local build orchestrator for Nearcade
# Usage: ./compile.sh [-linux] [-mac] [-windows] [-portable] [-setup] [-nuitka-only]

OS_LINUX=0
OS_MAC=0
OS_WIN=0
TARGET_PORTABLE=0
TARGET_SETUP=0
NUITKA_ONLY=0

for arg in "$@"; do
  case $arg in
    -linux) OS_LINUX=1 ;;
    -mac) OS_MAC=1 ;;
    -windows) OS_WIN=1 ;;
    -portable) TARGET_PORTABLE=1 ;;
    -setup) TARGET_SETUP=1 ;;
    -nuitka-only) NUITKA_ONLY=1 ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

if [ $OS_LINUX -eq 0 ] && [ $OS_MAC -eq 0 ] && [ $OS_WIN -eq 0 ]; then
    echo "No OS specified. Defaulting to -linux."
    OS_LINUX=1
fi

BIN_DIR="src/sidecar/input_backends/bin"
mkdir -p "$BIN_DIR"

compile_linux() {
    echo "[ Nuitka ] Compiling native Linux sidecar..."
    cd src/sidecar/input_backends
    python3 -m nuitka --onefile --output-dir=bin linux_uinput.py
    cd ../../../
}

compile_mac() {
    echo "[ Nuitka ] Compiling native Mac sidecar..."
    cd src/sidecar/input_backends
    python3 -m nuitka --onefile --output-dir=bin mac_gamepad_bridge.py
    cd ../../../
}

compile_windows() {
    echo "[ PyInstaller ] Compiling Windows sidecars via Wine..."
    # Ensure wine and python are available
    if ! command -v wine &> /dev/null; then
        echo "Error: 'wine' is not installed, cannot compile Windows sidecars locally."
        exit 1
    fi
    cd src/sidecar/input_backends
    # Assuming Wine has Python 3.11 installed inside it with pyinstaller
    wine python -m pyinstaller -y --onefile --distpath bin --name windows_hidmaestro windows_hidmaestro.py
    wine python -m pyinstaller -y --onefile --distpath bin --name windows_vigem windows_vigem.py
    cd ../../../
}

if [ $OS_LINUX -eq 1 ]; then
    compile_linux
fi
if [ $OS_MAC -eq 1 ]; then
    compile_mac
fi
if [ $OS_WIN -eq 1 ]; then
    compile_windows
fi

if [ $NUITKA_ONLY -eq 1 ]; then
    echo "Nuitka compilation finished. Skipping electron-builder."
    exit 0
fi

# Run electron-builder
if [ $OS_LINUX -eq 1 ]; then
    echo "[ Electron Builder ] Building for Linux..."
    npx electron-builder --linux
fi

if [ $OS_MAC -eq 1 ]; then
    echo "[ Electron Builder ] Building for Mac..."
    npx electron-builder --mac
fi

if [ $OS_WIN -eq 1 ]; then
    echo "[ Electron Builder ] Building for Windows..."
    
    # Check if they only want portable or setup
    if [ $TARGET_PORTABLE -eq 1 ] && [ $TARGET_SETUP -eq 0 ]; then
        npx electron-builder --win portable
    elif [ $TARGET_SETUP -eq 1 ] && [ $TARGET_PORTABLE -eq 0 ]; then
        npx electron-builder --win nsis
    else
        npx electron-builder --win
    fi
    
    # Move HmBridge to correct packaged location if available
    HM_SRC="src/sidecar/input_backends/HmBridge/HmBridge.exe"
    if [ -f "$HM_SRC" ]; then
        mkdir -p dist/win-unpacked/src/sidecar/input_backends/HmBridge/
        cp "$HM_SRC" dist/win-unpacked/src/sidecar/input_backends/HmBridge/HmBridge.exe
    fi
fi

echo "Done!"
