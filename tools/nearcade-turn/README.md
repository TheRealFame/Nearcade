# nearcade-turn — self-hosted TURN relay (Rust)

A minimal TURN server for Nearcade WebRTC fallback, built on the
`webrtc-rs` TURN implementation (MIT/Apache-2.0 — no GPL anywhere in this
dependency tree). Static long-term credentials; browsers and sidecars speak
standard RFC 5389 auth against it, no special client support needed.

Verified: builds offline-safe, allocates relays for standards-compliant
clients, forwards relayed data, sanitizes nothing it shouldn't. Tested
against aiortc (allocation + relayed candidates + relayed data path).

## Build

```sh
cargo build --release
# -> ./target/release/nearcade_turn
```

Needs GStreamer dev files only if you also build `gst-nearcade`; this crate
links just libc/tokio-class deps (no system media libraries).

## Deploy (VPS, 3 steps)

1. Copy the binary up and open UDP (TURN is UDP-first; TCP fallback works
   but relay quality is best on UDP):
   ```sh
   scp target/release/nearcade_turn you@vps:/usr/local/bin/
   # on the VPS, as root:
   ufw allow 3478/udp
   ufw allow 3478/tcp
   ```
2. Run it (use a long random password, not the example):
   ```sh
   nearcade_turn --port 3478 --username nearcade --password 'PUT-A-LONG-RANDOM-PASSWORD-HERE'
   ```
   Keep it alive with your supervisor of choice. Example systemd unit
   (`/etc/systemd/system/nearcade-turn.service`):
   ```ini
   [Unit]
   Description=Nearcade TURN relay
   After=network-online.target
   [Service]
   ExecStart=/usr/local/bin/nearcade_turn --port 3478 --username nearcade --password 'PUT-A-LONG-RANDOM-PASSWORD-HERE'
   Restart=always
   [Install]
   WantedBy=multi-user.target
   ```
   ```sh
   systemctl enable --now nearcade-turn
   ```
   Expected log: `Starting Nearcade Custom TURN Server on port 3478`.

3. Point Nearcade at it — on the HOME PC, in `.env`:
   ```
   TURN_URL=turn:<VPS_PUBLIC_IP>:3478
   TURN_USERNAME=nearcade
   TURN_CREDENTIAL=<same password as step 2>
   ```
   (Do NOT set TURN_SECRET alongside these — secret means coturn-style
   time-limited credentials; username/credential means static, which is
   what this server speaks.) Restart the Nearcade server.

## Verify

- `GET /api/turn` should return your URL/username/credential (never share
  this output — credentials relay bandwidth).
- Viewers behind strict NAT should now connect on the first offer.
  Without any TURN configured, `/api/turn` returns `null` and everything
  runs STUN-only (direct P2P or nothing).

## Notes / limits

- Single static credential pair (fine for personal use; do not publish it —
  anyone holding it can relay traffic through your VPS).
- UDP 3478 must actually arrive (many VPS providers filter UDP by
  default — check the provider firewall as well as ufw/iptables).
- Port 3478/TCP works as a fallback but relay over TCP adds latency.
- Known edge (upstream webrtc-rs behavior): two allocations landing in the
  same instant from different source addresses can both go unanswered;
  clients simply re-allocate on retry (Nearcade's ICE retry path covers
  this) and sequential joins are unaffected. Observed and characterized
  headlessly; does not affect steady-state relaying.
