#!/bin/bash
# Nearcade - Automated TURN Server Setup for VPS
# This script installs and configures coturn for WebRTC P2P fallback.
# It includes cross-platform support for various Linux distributions.

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (use sudo ./bin/setup_turn.sh)"
  exit 1
fi

echo "--- Installing coturn ---"
if command -v apt-get &> /dev/null; then
    apt-get update || true
    apt-get install -y coturn
elif command -v dnf &> /dev/null; then
    dnf install -y coturn
elif command -v yum &> /dev/null; then
    yum install -y coturn epel-release
elif command -v pacman &> /dev/null; then
    pacman -Sy --noconfirm coturn
elif command -v apk &> /dev/null; then
    apk add coturn
else
    echo "WARNING: Could not detect package manager. Please install 'coturn' manually."
    exit 1
fi

if command -v turnserver &> /dev/null; then
    echo "--- Configuring /etc/turnserver.conf ---"
    mv /etc/turnserver.conf /etc/turnserver.conf.bak 2>/dev/null
    
    cat <<EOF > /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349

# Use long-term credentials for WebRTC
use-auth-secret
static-auth-secret=nearsec_turn_secret_change_me
realm=nearsec.local

# Performance limits
total-quota=100
bps-capacity=0
stale-nonce

# Logging
no-cli
EOF

    # Enable for Debian/Ubuntu specific daemon config
    if [ -f /etc/default/coturn ]; then
        sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
    fi

    echo "--- Restarting coturn service ---"
    systemctl restart coturn 2>/dev/null || service coturn restart 2>/dev/null
    systemctl enable coturn 2>/dev/null || chkconfig coturn on 2>/dev/null
    
    echo ""
    echo "=========================================================="
    echo "✅ TURN Server is now live on your VPS!"
    echo "=========================================================="
    echo "To use this in Nearcade, add this to your .env file on your HOME PC:"
    echo ""
    echo "STUN_URL=stun:YOUR_VPS_IP:3478"
    echo "TURN_URL=turn:YOUR_VPS_IP:3478"
    echo "TURN_USERNAME=username (can be anything when using auth secret)"
    echo "TURN_CREDENTIAL=nearsec_turn_secret_change_me"
    echo "=========================================================="
    echo "(Replace YOUR_VPS_IP with this VPS's public IP address)"
else
    echo "Error: coturn installation failed."
fi
