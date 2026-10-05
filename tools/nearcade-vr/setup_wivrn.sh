#!/bin/bash
# WiVRn Setup Script for Nearcade
# This script sets up WiVRn integration with Nearcade

set -e

echo "=========================================="
echo "WiVRn Setup for Nearcade"
echo "=========================================="

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "Please do not run this script as root. Use sudo only when prompted."
    exit 1
fi

# Detect distribution
DISTRO=""
if [ -f /etc/os-release ]; then
    DISTRO=$(grep "^ID=" /etc/os-release | cut -d= -f2 | tr -d '"')
fi

echo "Detected distribution: $DISTRO"

# Install WiVRn based on distribution
install_wivrn() {
    echo ""
    echo "Installing WiVRn..."
    
    case $DISTRO in
        arch|manjaro|endeavouros)
            echo "Installing WiVRn on Arch Linux..."
            sudo pacman -S --needed wivrn-dashboard wivrn-server
            ;;
        fedora)
            echo "Installing WiVRn on Fedora..."
            sudo dnf install wivrn
            ;;
        debian|ubuntu|pop)
            echo "Installing WiVRn on Debian/Ubuntu..."
            echo "Note: WiVRn is not available in official Debian/Ubuntu repos."
            echo "You can install from source or use Flatpak."
            
            # Try Flatpak
            if command -v flatpak &> /dev/null; then
                echo "Installing via Flatpak..."
                flatpak install flathub io.github.wivrn.wivrn -y
            else
                echo "Flatpak not installed. Please install Flatpak first:"
                echo "  sudo apt install flatpak"
                echo "  flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo"
                exit 1
            fi
            ;;
        nixos)
            echo "Installing WiVRn on NixOS..."
            echo "Add to your configuration.nix:"
            echo "  environment.systemPackages = [ pkgs.wivrn ];"
            echo "Then run: sudo nixos-rebuild switch"
            exit 1
            ;;
        *)
            echo "Unsupported distribution: $DISTRO"
            echo "Please install WiVRn manually from: https://github.com/WiVRn/WiVRn"
            exit 1
            ;;
    esac
    
    echo "WiVRn installed successfully!"
}

# Install OpenComposite/xrizer for SteamVR compatibility
install_opencomposite() {
    echo ""
    echo "Installing OpenComposite/xrizer for SteamVR compatibility..."
    
    # WiVRn includes xrizer, but we can also install OpenComposite
    case $DISTRO in
        arch|manjaro|endeavouros)
            echo "Installing OpenComposite on Arch Linux..."
            # OpenComposite is available in AUR
            if command -v yay &> /dev/null; then
                yay -S opencomposite
            elif command -v paru &> /dev/null; then
                paru -S opencomposite
            else
                echo "AUR helper not found. Please install OpenComposite manually:"
                echo "  git clone https://gitlab.com/znixian/OpenOVR.git"
                echo "  cd OpenOVR"
                echo "  mkdir build && cd build"
                echo "  cmake .. && make"
            fi
            ;;
        *)
            echo "OpenComposite installation varies by distribution."
            echo "WiVRn includes xrizer which provides similar functionality."
            echo "For manual OpenComposite installation, see: https://gitlab.com/znixian/OpenOVR"
            ;;
    esac
}

# Configure Avahi for headset discovery
configure_avahi() {
    echo ""
    echo "Configuring Avahi for headset discovery..."
    
    if ! systemctl is-active --quiet avahi-daemon; then
        echo "Enabling Avahi daemon..."
        systemctl enable --now avahi-daemon
        echo "Avahi daemon enabled and started."
    else
        echo "Avahi daemon is already running."
    fi
}

# Configure firewall for WiVRn
configure_firewall() {
    echo ""
    echo "Configuring firewall for WiVRn..."
    
    if command -v ufw &> /dev/null; then
        echo "Configuring UFW firewall..."
        sudo ufw allow 5353/udp comment "Avahi/Bonjour for WiVRn discovery"
        sudo ufw allow 9757 comment "WiVRn streaming"
        sudo ufw reload
        echo "Firewall configured for WiVRn."
    elif command -v firewall-cmd &> /dev/null; then
        echo "Configuring firewalld..."
        sudo firewall-cmd --permanent --add-port=5353/udp
        sudo firewall-cmd --permanent --add-port=9757/tcp
        sudo firewall-cmd --permanent --add-port=9757/udp
        sudo firewall-cmd --reload
        echo "Firewall configured for WiVRn."
    else
        echo "No supported firewall found. Please manually open ports:"
        echo "  UDP 5353 - Avahi/Bonjour for device discovery"
        echo "  TCP/UDP 9757 - WiVRn streaming"
    fi
}

# Create desktop entries for WiVRn
create_desktop_entries() {
    echo ""
    echo "Creating desktop entries..."
    
    # Create WiVRn Dashboard desktop entry
    cat > ~/.local/share/applications/wivrn-dashboard.desktop << 'EOF'
[Desktop Entry]
Name=WiVRn Dashboard
Comment=WiVRn PCVR Streaming Dashboard
Exec=wivrn-dashboard
Icon=wivrn
Terminal=false
Type=Application
Categories=Game;VirtualReality;
EOF
    
    # Create WiVRn Server desktop entry
    cat > ~/.local/share/applications/wivrn-server.desktop << 'EOF'
[Desktop Entry]
Name=WiVRn Server
Comment=WiVRn PCVR Streaming Server
Exec=wivrn-server
Icon=wivrn
Terminal=false
Type=Application
Categories=Game;VirtualReality;
EOF
    
    echo "Desktop entries created."
}

# Main setup function
main() {
    echo ""
    echo "Starting WiVRn setup..."
    
    # Step 1: Install WiVRn
    install_wivrn
    
    # Step 2: Install OpenComposite
    install_opencomposite
    
    # Step 3: Configure Avahi
    configure_avahi
    
    # Step 4: Configure firewall
    configure_firewall
    
    # Step 5: Create desktop entries
    create_desktop_entries
    
    echo ""
    echo "=========================================="
    echo "WiVRn Setup Complete!"
    echo "=========================================="
    echo ""
    echo "Next steps:"
    echo "1. Install WiVRn app on your VR headset:"
    echo "   - Meta Quest: Install from Meta Store"
    echo "   - Other headsets: Download APK from WiVRn dashboard"
    echo ""
    echo "2. Start WiVRn dashboard:"
    echo "   wivrn-dashboard"
    echo ""
    echo "3. Pair your headset with your PC"
    echo ""
    echo "4. Launch SteamVR games with WiVRn launch options"
    echo ""
    echo "5. Use Nearcade to capture and stream to browser viewers"
    echo ""
    echo "For more information, see: https://github.com/WiVRn/WiVRn"
}

# Run main function
main
