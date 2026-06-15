# Getting Started with Nearsec Together

Nearsec Together allows you to share your local games seamlessly with friends over the web using low-latency WebRTC technology.

## The Nearsec Arcade vs. Private Tunnels
You have two ways to host a game:
1. **Private Tunnel (Custom URLs):** By setting up a custom Cloudflare tunnel (e.g., `play.yourdomain.com`), you can send friends a permanent, unchanging link. This is best for private groups.
2. **Nearsec Arcade:** A public matchmaking directory for discovering local co-op games. Sessions here are restricted to 80 minutes to ensure the lobby stays active and prevents "ghost links". You must use a verified tunneling provider like Cloudflared or zrok to host on the Arcade.

## Launching a Session
1. Ensure you have Node.js v18+ and Python 3.8+ installed.
2. Open your terminal or command prompt and **navigate into the bin folder**:
   ```bash
   cd bin
3. On Linux, the app will automatically request `sudo` access to load the `uinput` kernel module for controller support.
4. Click "Host Session" to open the WebRTC capture dashboard.
5. Provide the generated URL and Session PIN to your viewers.
