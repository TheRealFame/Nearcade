#!/bin/bash

# Nearcade - macOS Automated Setup
echo "================================================"
echo "   Nearcade macOS Setup Utility"
echo "================================================"
echo "[WARNING] macOS Mode: Gamepad injection is NOT supported "
echo "Keyboard/Mouse passthrough will be used instead."

# 1. Check for Node.js
if command -v node >/dev/null 2>&1; then
    echo "[OK] Node.js is installed"
else
    echo "[!] Node.js NOT found. Install via 'brew install node' or nodejs.org"
    exit 1
fi

# 2. Check for Python
if command -v python3 >/dev/null 2>&1; then
    echo "[OK] Python3 is installed"
else
    echo "[!] Python3 NOT found. Please install Python 3."
    exit 1
fi

# 3. Install Dependencies
echo "Installing Python dependencies (pyautogui)..."
pip3 install -r bin/requirements-mac.txt

echo "Installing Node.js dependencies..."
npm install --silent [cite: 8]

# 4. Accessibility Check
echo ""
echo "------------------------------------------------"
echo "IMPORTANT: macOS Security Permissions"
echo "------------------------------------------------"
echo "To allow Keyboard/Mouse passthrough, you MUST:"
echo "1. Open System Settings -> Privacy & Security -> Accessibility"
echo "2. Click '+' and add your Terminal (or iTerm2)"
echo "3. Ensure the toggle is turned ON"
echo "------------------------------------------------"

# 5. Optional Tunnel Selection
echo "Would you like to install a tunnel provider?"
echo "1) Cloudflare (brew install cloudflared)"
echo "2) Zrok (Self-install)"
echo "3) Skip"
read -p "Select an option (1-3): " choice

case $choice in
    1) brew install cloudflared ;;
    2) echo "Please visit zrok.io for installation instructions." ;;
    *) echo "Skipping tunnels." ;;
esac

echo "Setup Complete! Run: ./bin/start.cmd"
