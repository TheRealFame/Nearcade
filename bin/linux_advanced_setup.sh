#!/bin/bash
echo "================================================="
echo " NearsecTogether Experimental Device Setup       "
echo "================================================="
echo "This script installs additional Python dependencies"
echo "required for the experimental hardware backends"
echo "(VR Headsets, Drawing Tablets, HOTAS, etc)."
echo ""
echo "Note: Standard gamepads and keyboards do NOT require this."
echo ""
read -p "Install experimental dependencies? (y/n): " confirm

if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Setup aborted."
    exit 0
fi

echo "Installing dependencies..."
# evdev is already installed by the main setup, but we ensure it here.
# mouse/pynput are used for the absolute mouse fallback on Mac/Windows.
# openvr is for the VR backend placeholder.
pip3 install evdev pynput mouse openvr pyusb

echo "================================================="
echo " Experimental setup complete!                    "
echo "================================================="
