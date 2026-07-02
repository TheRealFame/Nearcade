# Experimental Architecture Concept: Data Flow Pipeline

If/when these experimental devices are implemented, the standard NearsecTogether input pipeline (which assumes an Xbox Controller shape) will need to be bypassed or augmented.

This document outlines how the data will flow from the remote user's specialized hardware all the way into the Host's game engine.

---

## 1. The Viewer (Web Browser) Data Capture
The web front-end must identify that a specialized device is being used instead of a standard Gamepad.

**Mechanism:**
1. A dropdown is added to the Viewer UI: "Input Mode: [Gamepad | Drawing Tablet | VR | HOTAS]".
2. Based on the mode, the Javascript payload changes:
   - **Tablet Mode**: Binds to `window.onpointermove` and packs `{x, y, pressure, tiltX, tiltY}`.
   - **VR Mode**: Binds to `navigator.xr.requestSession()` and packs `{head_quat, head_pos, left_hand, right_hand}`.
3. This payload is JSON stringified (or binary packed for speed) and sent over the existing **WebRTC RTCDataChannel** (`inputChannel`).

## 2. The Relay (Host Node.js Engine)
Currently, `host.js` and `InputOrchestrator.js` parse the incoming DataChannel packets and assume they are a 16-button, 4-axis array for standard gamepads.

**Required Changes:**
1. Add a `device_type` header to the WebRTC packets.
2. If `device_type == 'standard'`, route to `InputOrchestrator` as usual.
3. If `device_type == 'special'`, bypass the standard orchestrator.
4. Pass the raw specialized packet directly to the Python backend via the `stdin` pipe or a dedicated local UDP socket for high-bandwidth data (like VR/Eye tracking).

## 3. The Backend (Python Translators)
The `experimental/backend_*.py` files act as translation layers. 

**Execution:**
1. Node.js spawns the specific backend script based on the connected user's selected mode.
2. The Python script parses the incoming raw data stream.
3. It performs the necessary mathematical conversions (e.g., mapping WebXR coordinate spaces to OpenVR coordinate spaces, or mapping Web Canvas coordinates to absolute screen pixels).

## 4. The OS Injection (Kernel / API)
The final step is tricking the OS into thinking the physical hardware is plugged in locally.

- **Linux (`uinput`)**: For Tablets, Flight Sticks, and Wheels, Python uses the `evdev` library to create a virtual device node in `/dev/uinput` with specific capabilities (e.g. `EV_ABS`, `ABS_PRESSURE`).
- **Windows (`ViGEm` / `DirectInput`)**: Uses virtual driver frameworks to spoof DirectInput devices.
- **SteamVR (OpenVR)**: VR and Head Tracking data bypasses the OS input system entirely. The Python script sends UDP packets directly to a custom SteamVR C++ driver plugin, which tells the SteamVR compositor where the virtual headset is located.

---
**Summary Flow:**
`Hardware -> Viewer Browser API -> WebRTC DataChannel -> Host Node.js -> Local UDP/Pipe -> Python Translator -> OS Virtual Driver / SteamVR -> Game`
