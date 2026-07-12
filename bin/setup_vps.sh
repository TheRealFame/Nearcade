#!/bin/bash
# Nearcade - VPS High-Performance Signaling Setup

# 1. Firewall Setup for WebRTC and Signaling
sudo ufw allow 22/tcp
sudo ufw allow 3000/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp
sudo ufw --force enable

if ! sudo iptables -C INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 5 -p tcp --dport 3000 -j ACCEPT
    sudo netfilter-persistent save
    echo "Port 3000 opened and saved."
else
    echo "Port 3000 is already open."
fi

# 2. BBR Optimization (Low Latency Tuning)
echo "net.core.default_qdisc=fq" | sudo tee -a /etc/sysctl.conf
echo "net.ipv4.tcp_congestion_control=bbr" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

echo ""
echo "--- VPS PREP COMPLETE ---"
echo "Next Steps:"
echo "1. Run Caddy and the nearsec-router (refer to src/docs/VPS_SETUP.md)."
echo "2. Set the VPS URL in the Nearsec host GUI and select VPS (SFU)."
echo ""
echo "Note: The VPS handles signaling and data routing natively."

