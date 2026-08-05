# Nearsec Arcade

The Nearsec Arcade is a global matchmaking service where anyone can list their active sessions publicly.

### Listing Your Session
When starting a Host Session, click the "List on Live Arcade" toggle. Your session will appear immediately on the Arcade tab for all Nearsec users.

### Security
- **No Direct IP Leakage**: If you are using a tunnel (zrok, cloudflared) or a VPS, your real home IP address is masked from the Arcade listing.
- **PIN Protection**: You can still enforce a PIN code on Arcade sessions. Viewers will see your lobby but must know the PIN to join.

### Arcade Heartbeats
The host application sends a "heartbeat" ping to the Arcade every 30 seconds. If you close Nearsec or lose connection, your listing will automatically be removed within 1 minute.
