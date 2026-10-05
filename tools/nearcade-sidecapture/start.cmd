#!/bin/sh
# shellcheck disable=SC2039
: << 'BATCH_SECTION'
@echo off
goto :WINDOWS
BATCH_SECTION

# --- UNIX SECTION (Linux, Mac, FreeBSD, Arch) ---
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Auto-update the portable .desktop icon and exec path
if [ -f "NearcadeSidecapture.desktop" ]; then
    sed -i "s|^Icon=.*|Icon=$DIR/capture-gui/src-tauri/icons/icon.png|" NearcadeSidecapture.desktop
fi

echo "  ┌────────────────────────────────────────┐"
echo "  │        Nearcade Sidecapture            │"
echo "  └────────────────────────────────────────┘"

if ! command -v cargo >/dev/null 2>&1; then
    echo "X Rust/Cargo is missing! Please install from https://rustup.rs/"
    sleep 3
    exit 1
fi

GST_PLUGIN_SYSTEM_PATH_1_0=/usr/lib/x86_64-linux-gnu/gstreamer-1.0 exec cargo run -p nearcade-sidecapture-gui "$@"
exit 0


:WINDOWS
:: --- WINDOWS SECTION ---
@echo off
setlocal enabledelayedexpansion

:: Set UTF-8 code page
chcp 65001 > nul 2>&1

title Nearcade Sidecapture

cd /d "%~dp0"

echo.
echo ============================================
echo  Nearcade Sidecapture Launcher (Windows)
echo ============================================
echo.

cargo --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Rust/Cargo is not installed or not in PATH.
    echo Please install from https://rustup.rs/
    pause
    exit /b 1
)

cargo run -p nearcade-sidecapture-gui %*

if errorlevel 1 (
    echo.
    echo  Application exited with an error ^(code %errorlevel%^).
    echo  Press any key to close this window.
    pause > nul
)
endlocal
