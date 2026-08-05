# VPS Setup

If you cannot open ports (due to CGNAT or strict firewalls), you can route your Nearcade traffic through a cheap cloud VPS.

### 1. Prerequisites
- A cloud VPS running Linux (Ubuntu, Debian, or Oracle Cloud Linux)
- SSH access to the VPS
- Nearcade installed on your local host PC

### 2. Configure VPS Router
The Nearsec VPS Router (`/vps` directory) handles WebSocket signaling and proxying WebRTC handshake traffic.
On your VPS, download the Nearsec release and run the router:
```bash
./nearsec-router --port 8080
```

### 3. Connect Host
In the Nearsec app settings, under **Dedicated Tunnel Provider**, configure your VPS IP and port. 
Once configured, all P2P handshake data will be bounced off the VPS instead of requiring viewers to connect directly to your home network.
