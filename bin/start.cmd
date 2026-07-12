#!/bin/sh
# shellcheck disable=SC2039
: << 'BATCH_SECTION'
@echo off
goto :WINDOWS
BATCH_SECTION

# --- UNIX SECTION (Linux, Mac, FreeBSD, Arch) ---
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# 1. GRACEFUL GHOST CLEANUP (UNIX)
# Ask the process holding Port 3000 (Nearsec) to close nicely
PORT_PID=$(lsof -ti:3000)
if [ -n "$PORT_PID" ]; then
    echo "  ~ Asking previous Nearsec session to close nicely (saving VPS state)..."
    # Send SIGTERM (15) to trigger server.js cleanup() and cleanly drop SSH tunnels
    kill -15 $PORT_PID >/dev/null 2>&1
    sleep 2 # Give Node/Electron 2 seconds to gracefully close

    # Force kill only if it completely froze
    kill -9 $PORT_PID >/dev/null 2>&1
fi

# Failsafe: Clean up the Nearsec Python controller sidecar
pkill -15 -f "sidecar/input_driver.py" >/dev/null 2>&1

cleanup() {
    echo "\n  ! Shutting down... cleaning up port 3000"
    C_PID=$(lsof -ti:3000)
    if [ -n "$C_PID" ]; then
        kill -15 $C_PID >/dev/null 2>&1
        sleep 1
        kill -9 $C_PID >/dev/null 2>&1
    fi
    exit
}
trap cleanup 2 15

echo "  ┌─────────────────────────────────────┐"
echo "  │      Nearcade Launcher      │"
echo "  └─────────────────────────────────────┘"

# OS Detection & Environment Logic
OS="$(uname -s)"
if [ "$OS" = "Linux" ]; then
    if [ ! -w /dev/uinput ]; then
        echo "  [WARN] /dev/uinput is not writable. Controllers may not work."
        echo "  Run 'sudo ./linux_setup.sh' to fix permissions."
    fi
fi

if [ "$OS" = "Darwin" ]; then
    echo "  [WARNING] macOS Experimental Mode:"
    echo "  - Gamepad injection is NOT supported"
    echo "  - Keyboard/Mouse passthrough available only"
    echo "  - Install pyautogui: pip3 install pyautogui"
    echo ""
fi

[ ! -f .env ] && printf "CF_TOKEN=\nUSE_VPS=false\n" > .env
! command -v node >/dev/null 2>&1 && { echo "X Node.js missing"; exit 1; }
[ ! -d node_modules ] && npm install --silent

if [ -f node_modules/.bin/electron ]; then
    ./node_modules/.bin/electron . "$@"
else
    exec node src/scripts/server.js "$@"
fi
exit 0


:WINDOWS
:: --- WINDOWS SECTION ---
@echo off
setlocal enabledelayedexpansion

:: Set UTF-8 code page so Unicode characters render correctly in this terminal
chcp 65001 > nul 2>&1

:: Set window title
title Nearcade

cd /d "%~dp0.."

:: 1. GRACEFUL GHOST CLEANUP (WINDOWS)
:: Find the process ID holding Port 3000
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr :3000') do (
    if not "%%a"=="0" (
        echo   ~ Asking previous Nearsec session to close nicely...
        :: Try graceful shutdown first (no /f flag sends WM_CLOSE/SIGTERM)
        taskkill /pid %%a >nul 2>&1
        :: Wait 2 seconds for Node to clean up
        timeout /t 2 /nobreak >nul
        :: Force kill if it refused to close gracefully
        taskkill /f /pid %%a >nul 2>&1
    )
)

if not exist .env (
    echo CF_TOKEN= > .env
)

echo.
echo ========================================
echo  Nearcade Launcher (Windows)
echo ========================================
echo.
echo  Gamepad support requires ViGEmBus driver:
echo  https://github.com/nefarius/ViGEmBus/releases
echo.
echo  Tunnel setup: run bin\windows_setup.ps1 if needed
echo  (installs cloudflared, zrok, and/or playit)
echo.

node -v >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing npm dependencies...
    call npm install --silent
    if errorlevel 1 (
        echo ERROR: npm install failed
        pause
        exit /b 1
    )
)

if exist node_modules\.bin\electron.cmd (
    call node_modules\.bin\electron.cmd . %*
) else (
    node src\scripts\server.js %*
)

:: Only pause if the app exited with an error so the user can read it.
:: Normal Electron close exits with code 0 and this window will auto-close.
if errorlevel 1 (
    echo.
    echo  Application exited with an error ^(code %errorlevel%^).
    echo  Press any key to close this window.
    pause > nul
)

endlocal
