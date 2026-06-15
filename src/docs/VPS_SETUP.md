# Nearsec Together - VPS SFU Deployment Guide

This guide explains how to deploy the Nearsec Together central router on a Linux VPS using Caddy for automatic SSL and WebSocket routing.

## Prerequisites

1. A Linux VPS (Ubuntu/Debian recommended).
2. A custom domain name pointing to your VPS public IP address (A Record).
3. Ports 80 (HTTP) and 443 (HTTPS) open on your VPS cloud firewall.

## Step 1: Install Caddy (Web Server & Reverse Proxy)

Caddy automatically provisions SSL certificates and natively handles WebSocket upgrades without complex configuration.

Run the following commands on your VPS to install Caddy:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf '[https://dl.cloudsmith.io/public/caddy/stable/gpg.key](https://dl.cloudsmith.io/public/caddy/stable/gpg.key)' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf '[https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt](https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt)' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

```

## Step 2: Clone the Repository

Instead of manually moving files, we run the frontend directly from your Git repository so it is easy to update.

1. SSH into your VPS and clone the repository into your home folder (replace `YourUsername` with your actual GitHub username):

```bash
cd /home/ubuntu
git clone [https://github.com/YourUsername/NearsecTogether.git](https://github.com/YourUsername/NearsecTogether.git)

```

2. Assign the correct permissions so your user owns the files and Caddy can read them:

```bash
sudo chown -R ubuntu:ubuntu /home/ubuntu/NearsecTogether
sudo chmod +x /home/ubuntu
sudo chmod -R 755 /home/ubuntu/NearsecTogether/src

```

## Step 3: Configure Caddy Routing

We need to tell Caddy to serve the web files directly from your repository and strictly route API and WebSocket traffic to the Rust backend.

1. Overwrite the Caddy configuration file:

```bash
sudo nano /etc/caddy/Caddyfile

```

2. Paste the following configuration (replace `yourdomain.com` with your actual domain):

```caddy
yourdomain.com {
    # 1. Route API and WebSocket traffic to the Rust Router
    @websockets {
        header Connection *Upgrade*
        header Upgrade websocket
    }
    reverse_proxy @websockets localhost:3000
    reverse_proxy /api/* localhost:3000

    # 2. Set the web root
    root * /home/ubuntu/NearsecTogether

    # 3. Direct HTML Routing
    rewrite / /src/pages/index.html
    rewrite /viewer.html /src/pages/viewer.html
    rewrite /host.html /src/pages/host.html
    rewrite /dashboard.html /src/pages/dashboard.html
    rewrite /gamepad-popup.html /src/pages/gamepad-popup.html
    
    # 4. Direct Javascript Routing
    rewrite /js/viewer.js /src/scripts/viewer.js
    rewrite /js/host.js /src/scripts/host.js
    rewrite /js/i18n.js /src/scripts/i18n.js
    rewrite /js/version.js /src/scripts/version.js
    rewrite /scripts/i18n.js /src/scripts/i18n.js
    rewrite /scripts/viewer.js /src/scripts/viewer.js
    rewrite /scripts/host.js /src/scripts/host.js

    # Serve the files
    file_server
}

```

3. Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`), then reload Caddy:

```bash
sudo systemctl reload caddy

```

## Step 4: Start the Rust Router

The Rust router (`nearsec-router`) acts as the SFU bridge, handling all video and input data between the Host and Viewers.

1. Ensure the `.env` file for the router specifies `PORT=3000` and contains your `MASTER_KEY`.
2. Install the provided `nearsec-router.service` file into `/etc/systemd/system/`.
3. Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nearsec-router

```

Your VPS is now fully configured. In your local Nearsec Together Host app, select the VPS tunnel option and enter your custom domain.

---

## The Update Workflow

Whenever the Nearsec frontend is updated, you do not need to manually transfer files.

1. SSH into your VPS.
2. Pull the latest code:

```bash
cd /home/ubuntu/NearsecTogether
git pull

```

Your live site will instantly update.

---

## Troubleshooting Q&A

**Q: I get a "502 Bad Gateway" error, or viewers cannot connect to the Host.**
A: A 502 error or a failed connection means Caddy is working, but the **Rust Router** (`nearsec-router`) is either offline, crashed, or failing to bridge the connections on port 3000.

* Check if the router is actively running: `sudo systemctl status nearsec-router`
* View the live router logs to see why inputs or connections are dropping: `journalctl -u nearsec-router -f`

**Q: Viewers are connecting but their inputs aren't working, or they don't show up in the Host UI.**
A: The Rust router is likely failing to inject the `viewer_id` or forward the WebSocket payloads back to the Host. Check the `journalctl` logs for the router to ensure it is successfully receiving and passing the binary DataChannel input chunks.

**Q: I get a "403 Forbidden" error when visiting my domain.**
A: Caddy does not have the correct Linux file permissions to read your repository. Run `sudo chmod -R 755 /home/ubuntu/NearsecTogether/src` to unlock the folder.

**Q: Do I still need to use Cloudflare Tunnels (trycloudflare.com)?**
A: No. By hosting the frontend directly on your VPS via Caddy, the entire architecture is handled natively by your custom domain.
