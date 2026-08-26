# Investigation Results
I have investigated the Discord logs and the impact of the recent security patch (`GHSA-v53f-2pjc-7qjc`) on LAN viewers. Here is what I found:

1. **The Missing Offer**: The viewer logs show a successful connection to `/ws/viewer` and the fast-lane input socket, but the `[Signaling] WebRTC Offer received` event never fired. This implies the Host was either not connected to the server, or hadn't started its screen capture yet.
2. **Loopback Block**: The security patch strictly restricts `/ws/host` to `127.0.0.1` and `::1`. If the Host UI was being run from a separate PC on the LAN (e.g., using a reverse proxy without `X-Forwarded-For`), the Host connection would be rejected silently. This would result in the exact symptom shown in the logs: viewers connect, but no stream offer ever arrives.
3. **"Strictly as a Viewer"**: If the user's feedback is related to the recent removal of the OBS Direct Feed (`obs.html`), LAN viewers are now forced to use the full `index.html` interface (which includes PIN prompts, chat, and controller overlays). 

**Recommended Action**:
To resolve the "strictly as a viewer" feedback, we can introduce a `?theater=1` URL parameter to `index.html` that hides all non-essential UI (chat, controller visualizers, overlays) and provides a clean video feed akin to the old OBS mode. 

Please clarify if the user was intentionally running the Host UI from a LAN IP, or if they just want a clean viewer feed!
