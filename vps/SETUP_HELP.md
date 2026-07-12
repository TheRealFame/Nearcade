# Nearcade VPS Deployment Guide

This guide covers everything needed to deploy Nearcade on a Linux VPS using the provided automation script and Caddy as the TLS reverse proxy.

---

## Port Requirements

| Service | Port | Description |
|---|---|---|
| Node.js application server | 3001 | Serves the web UI, API routes, and local WebSocket paths |
| Rust SFU router | 3000 | Handles VPS viewer relay and standby lane connections |
| Caddy HTTPS proxy | 443 | Terminates TLS and routes traffic to the services above |

Caddy handles all public-facing traffic on port 443. Neither port 3000 nor port 3001 should be exposed to the internet directly.

---

## deploy.sh

The `deploy.sh` script is the single command needed to bring the VPS deployment up. It handles all setup and process management automatically.

**Location:** `vps/deploy.sh`

### What the script does

1. Reads the application version from the root `package.json` and displays it.
2. Installs all Node.js production dependencies in the project root.
3. Builds the Rust SFU router binary if the binary is missing or the source code has changed since the last build.
4. Clears any stale processes on ports 3000 and 3001.
5. Launches the Node.js server on port 3001 in the background.
6. Launches the Rust SFU router on port 3000 in the background.
7. Writes a PID file for each process so you can stop them later.

### How to run it

From the project root on your VPS:

```bash
cd /home/ubuntu/Nearcade/vps
bash deploy.sh
```

Or if the script has been made executable:

```bash
./vps/deploy.sh
```

### Stopping the services

The script writes PID files to the `vps` directory. To stop both services:

```bash
kill $(cat vps/node.pid) $(cat vps/router.pid)
```

### Viewing logs

Both processes write their output to log files in the `vps` directory:

```bash
tail -f vps/node.log    # Node.js application server
tail -f vps/router.log  # Rust SFU router
```

---

## Caddy Setup

Caddy handles TLS automatically via ACME. Point your domain DNS A record to the VPS IP address, then install and configure Caddy.

Copy the provided `Caddyfile` from the `vps` directory to `/etc/caddy/Caddyfile`:

```bash
sudo cp vps/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### Required file system permissions

Caddy runs as its own system user. Grant it read access to the project directory:

```bash
sudo chmod +x /home
sudo chmod +x /home/ubuntu
sudo chmod -R 755 /home/ubuntu/Nearcade
```

For production deployments it is safer to serve from `/var/www/` rather than a home directory.

---

## Rust Router as a Persistent Service

For production use you should run the Rust router under systemd rather than in a shell session. A ready-made service file is provided:

```bash
sudo cp vps/nearsec-router.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nearsec-router
sudo systemctl status nearsec-router
```

See the comments inside `nearsec-router.service` for the full setup steps including the secrets file and dedicated service user.

---

## Environment Variables

The Rust router reads its configuration from environment variables or from `/etc/nearsec/.env` when running under systemd.

| Variable | Required | Description |
|---|---|---|
| MASTER_KEY | Yes | Shared secret between the host application and the Rust router |
| PORT | No | Port for the Rust router, defaults to 9000 if omitted |

The Node.js server reads its configuration from the `.env` file in the project root. The version number it reports to clients is always read live from `package.json` at startup, so no manual version updates are needed after a `git pull`.
