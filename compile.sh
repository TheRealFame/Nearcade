#!/bin/bash
# compile.sh - Local build orchestrator for Nearcade
# Usage: ./compile.sh [-linux] [-mac] [-windows] [-portable] [-setup] [-cargo-only]

OS_LINUX=0
OS_MAC=0
OS_WIN=0
TARGET_PORTABLE=0
TARGET_SETUP=0
CARGO_ONLY=0

for arg in "$@"; do
  case $arg in
    -linux) OS_LINUX=1 ;;
    -mac) OS_MAC=1 ;;
    -windows) OS_WIN=1 ;;
    -portable) TARGET_PORTABLE=1 ;;
    -setup) TARGET_SETUP=1 ;;
    -cargo-only) CARGO_ONLY=1 ;;
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
    echo "[ Cargo ] Compiling native Linux sidecars..."
    cd src/sidecar/input_backends/rust_uinput
    cargo build --release
    cp target/release/linux_uinput ../bin/linux_uinput
    cd ../rust_read_gamepads
    cargo build --release
    cp target/release/read_gamepads ../bin/read_gamepads
    cd ../../../../
}

compile_mac() {
    echo "[ Cargo ] Compiling native Mac sidecars..."
    cd src/sidecar/input_backends/rust_mac_bridge
    cargo build --release
    cp target/release/mac_gamepad_bridge ../bin/mac_gamepad_bridge
    cd ../rust_read_gamepads
    cargo build --release
    cp target/release/read_gamepads ../bin/read_gamepads
    cd ../../../../
}

compile_windows() {
    echo "[ Cargo ] Compiling Windows sidecars..."
    cd src/sidecar/input_backends/rust_hidmaestro
    cargo build --release --target x86_64-pc-windows-gnu || cargo build --release
    cp target/x86_64-pc-windows-gnu/release/windows_hidmaestro.exe ../bin/windows_hidmaestro.exe 2>/dev/null || cp target/release/windows_hidmaestro.exe ../bin/windows_hidmaestro.exe 2>/dev/null || true
    cd ../rust_vigem
    cargo build --release --target x86_64-pc-windows-gnu || cargo build --release
    cp target/x86_64-pc-windows-gnu/release/windows_vigem.exe ../bin/windows_vigem.exe 2>/dev/null || cp target/release/windows_vigem.exe ../bin/windows_vigem.exe 2>/dev/null || true
    cd ../rust_read_gamepads
    cargo build --release --target x86_64-pc-windows-gnu || cargo build --release
    cp target/x86_64-pc-windows-gnu/release/read_gamepads.exe ../bin/read_gamepads.exe 2>/dev/null || cp target/release/read_gamepads.exe ../bin/read_gamepads.exe 2>/dev/null || true
    cd ../../../../
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

if [ $CARGO_ONLY -eq 1 ]; then
    echo "Cargo compilation finished. Skipping electron-builder."
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
