This document provides a deep dive into the underlying systems powering Nearcade. It is intended for developers, contributors, and power users who need to understand the exact data flow of WebRTC, Linux audio virtualization, and kernel-level input injection.

## Table of Contents
1. [Input Injection Architecture](#1-input-injection-architecture)
2. [Audio Virtualization Pipeline](#2-audio-virtualization-pipeline)
3. [The WebRTC Transport Layer](#3-the-webrtc-transport-layer)
4. [Video Capture & Wayland](#4-video-capture--wayland)
5. [Connection State & Cleanup](#5-connection-state--cleanup)

---

### 1. Input Injection Architecture
Nearsec relies on a separate Python sidecar process (`input_driver.py`) to handle operating system-level input injection. The Node.js server receives WebSockets containing binary Gamepad API arrays, unpacks them into standard JSON structures, and pipes them to Python via `stdin`.

**Linux `uinput` Implementation**
On Linux, we utilize the `uinput` kernel module. Traditional emulators often combine mouse, keyboard, and gamepad capabilities into a single composite virtual device. This causes severe issues in modern game engines (like Unreal Engine 5 or Unity), which aggressively poll devices and often mistake analog stick drift for mouse movement, causing UI flickering. 

To solve this, `linux_uinput.py` strictly isolates devices:
* Gamepads are spawned explicitly as `Xbox 360` (VID `0x045e`, PID `0x028e`) or `DualSense` devices.
* Keyboard/Mouse events are spawned on entirely separate virtual USB buses.
* When a user changes their input profile (e.g., swapping from Gamepad to Emulated KBM), the Python script actively calls `old_gp.destroy()` to physically sever the virtual USB cable in the kernel before initializing the new profile. This prevents "controller flooding" where games crash due to detecting 16+ dead controllers.

---

### 2. Audio Virtualization Pipeline
Routing application-specific audio on Linux without capturing desktop notifications or Discord voice chat requires manipulating the PipeWire/PulseAudio graph directly.

**The Hybrid Loopback System**
When the Node.js server boots, `initVirtualAudio()` executes a chain of `pactl` commands:
1. **Module Null Sink:** Creates `NearsecAppAudio`. This acts as a digital black hole. It is an Output device that games can target.
2. **Module Remap Source:** Creates `NearsecAppMic`. This maps the monitor of the black hole to a recognizable Input device (a microphone) that the browser's `getUserMedia` API can safely capture.
3. **Module Loopback:** Creates an invisible, permanent wire from the `NearsecAppAudio` sink directly to the host's physical headphones. 
4. **Volume Control:** We explicitly run `pactl set-sink-volume NearsecAppAudio 70%` to ensure the loopback doesn't cause clipping or hearing damage when combined with local system volume.

**Auto-Routing and Blacklists**
The `routeGameAudio()` function in `server.js` interfaces with a Patchbay library to read all active audio nodes on the system. Instead of whitelisting games, it uses a smart blacklist (`AUDIO_BLACKLIST = ['discord', 'teamspeak', 'telegram']`). Every 3 seconds, it scans for new application binaries making sound; if they aren't on the blacklist, it physically links their PipeWire output nodes into the `NearsecAppAudio` sink.

---

### 3. The WebRTC Transport Layer
Nearsec is not a traditional streaming server; it is a signaling server that orchestrates direct Peer-to-Peer (P2P) connections. 

**ICE Negotiation and TURN**
Because most viewers reside behind Symmetric NAT routers, direct STUN connections frequently fail. Nearsec mitigates this by injecting OpenRelay TURN server credentials into the `RTCPeerConnection` configuration. If a direct UDP punch-through fails, traffic falls back to TCP port 443 via the TURN relay, ensuring a 99% connection success rate even on strict corporate or university networks.

**Bi-directional Audio (Voice Chat)**
To implement Voice-over-IP (VoIP) without crippling the Host's upload bandwidth, Nearsec uses a "Switchboard" architecture. 
* Viewers capture their local microphone and attach the track to their outbound `RTCPeerConnection`.
* The Host receives these tracks and spawns hidden `<audio autoplay>` tags.
* The Host *does not* re-broadcast this audio to other viewers. Instead, the Host's local browser mixes the incoming WebRTC audio tracks natively and outputs them to the physical speakers, completely bypassing the `NearsecAppAudio` sink to prevent infinite feedback loops.

---

### 4. Video Capture & Wayland
Capturing screens on Linux is notoriously fragmented. Nearsec leverages Electron's `desktopCapturer` coupled with modern Chromium flags to support both X11 and Wayland compositors smoothly.

When running under Wayland, Electron delegates the screen capture request to the native XDG Desktop Portal (`xdg-desktop-portal`). This pops up a native OS dialogue asking the user for permission to share a screen or window. 

Because this portal requires human interaction, there is an inherent delay. If the Host sends a WebRTC Offer before the Wayland portal returns the video track, the negotiation loop crashes. To fix this, `viewer.js` forces "Vanilla ICE" gathering—it waits until `e.candidate === null` before sending its SDP Answer. This artificially stalls the handshake just long enough for the Wayland portal to successfully allocate the PipeWire video stream and attach it to the Sender.

---

### 5. Connection State & Cleanup
Stability in a multi-client P2P environment requires aggressive garbage collection. 

**Ghost Port Mitigation**
If the Electron app is forcefully closed, Node.js might leave orphaned `cloudflared` tunnels or stuck TCP ports. On startup, Nearsec uses `kill-port` to scrub port 3000, ensuring the Express server can bind cleanly. 

**Orphaned Virtual Devices**
Similarly, if the Python sidecar is killed abruptly, `uinput` devices remain active in the `/dev/input/` directory forever. The Node.js `cleanup()` hook traps `SIGINT`, `SIGTERM`, and Electron `window-close` events. Before exiting, it sends a final `{ type: 'destroy_all' }` JSON payload to the Python `stdin`, forcing Python to un-register all controllers. It simultaneously issues a `pactl unload-module` command targeted specifically at the `loopbackModuleId` integer saved during startup, cleanly destroying the virtual audio cables and restoring the Linux audio graph to its default state.

This project uses artificial intelligence large language models for code generation and structure planning.
