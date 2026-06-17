# VPS Server Setup Guide

This guide explains how to deploy the Nearsec Together central router on a Linux VPS. We use Caddy to handle SSL and WebSocket routing automatically.

## Prerequisites
* A Linux VPS running Ubuntu or Debian.
* A custom domain name pointing to your VPS public IP.
* Ports 80 and 443 open on your cloud firewall.

## 1. Install Caddy
Caddy sets up SSL certificates and routes WebSockets without extra configuration.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf '[https://dl.cloudsmith.io/public/caddy/stable/gpg.key](https://dl.cloudsmith.io/public/caddy/stable/gpg.key)' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf '[https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt](https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt)' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

## 2. Deploy the Code
SSH into your VPS and clone the repository.

```bash
cd /home/ubuntu
git clone [https://github.com/therealfame/nearsectogether.git](https://github.com/therealfame/nearsectogether.git)
cd nearsectogether
```

## 3. Automatic Updates
You do not need to move files when you update the frontend. 

1. SSH into your VPS.
2. Pull the latest code.
```bash
cd /home/ubuntu/nearsectogether
git pull
```
The server will reflect the new code.

## 4. Troubleshooting
* 502 Bad Gateway: The Caddy web server is running but the Rust router is offline. Check the status by running sudo systemctl status nearsec-router.
* View the logs by running journalctl -u nearsec-router -f.
* Input issues: Verify that the Rust router is receiving binary data from the viewers in the logs.
* 403 Forbidden: Caddy does not have permission to read your folder. Run sudo chmod -R 755 /home/ubuntu/nearsectogether/src.

## Nearsec Arcade
The platform includes an optional public lobby system. Hosts can list their sessions on the Arcade grid to let global players discover and join local co-op games. You can view the public lobby at https://nearsec.cutefame.net/arcade and join active sessions directly from your browser.

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
