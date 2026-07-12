#!/bin/bash
echo "================================================="
echo " Nearcade Experimental Device Setup       "
echo "================================================="
echo "1) VR Headset (SteamVR driver installation)"
echo "0) Install everything"
echo "q) Quit"
echo ""
read -p "Select an option: " confirm

if [[ "$confirm" == "q" || "$confirm" == "Q" ]]; then
    echo "Setup aborted."
    exit 0
fi

echo "Installing dependencies..."
pip3 install evdev pynput mouse openvr pyusb

if [[ "$confirm" == "1" || "$confirm" == "0" ]]; then
    echo "================================================="
    echo " Installing NearsecVR SteamVR Driver"
    echo "================================================="
    
    DRIVER_SRC="$(dirname "$0")/../src/sidecar/input_backends/experimental/steamvr_driver/build/driver_nearsecvr.so"
    
    if [ ! -f "$DRIVER_SRC" ]; then
        echo "Error: driver_nearsecvr.so not found! Please build it first using CMake."
    else
        PATHS=(
            "$HOME/.local/share/Steam/steamapps/common/SteamVR/drivers"
            "$HOME/.steam/steam/steamapps/common/SteamVR/drivers"
            "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/SteamVR/drivers"
        )
        
        INSTALLED=false
        for p in "${PATHS[@]}"; do
            # Only install if SteamVR directory exists
            if [ -d "$(dirname "$p")" ]; then
                mkdir -p "$p/nearsecvr/bin/linux64"
                cp "$DRIVER_SRC" "$p/nearsecvr/bin/linux64/"
                echo '{"name": "nearsecvr", "version": "1.0", "alwaysActivate": true}' > "$p/nearsecvr/driver.vrdrivermanifest"
                echo "Installed SteamVR driver to: $p"
                INSTALLED=true
            fi
        done
        
        if [ "$INSTALLED" = false ]; then
            echo "Warning: Could not find SteamVR installation directory."
        fi
    fi
fi

echo "================================================="
echo " Experimental setup complete!                    "
echo "================================================="
