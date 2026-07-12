# WiVRn Integration — Nearcade Pipeline

Nearcade uses WiVRn (OpenXR streaming server) to bridge standalone VR headsets
(Meta Quest, Pico, Vive Focus) with the host PC's game capture pipeline. This document
explains how the pieces connect and what each layer does.

## Architecture

```
Standalone Headset               Host PC (Ubuntu 26.04)
(Quest/Pico)
┌─────────────────┐     TCP/UDP     ┌──────────────────────────┐
│  WiVRn Client    │◄──────────────►│  wivrn-server             │
│  (Android APK)   │   stream +     │  port 9757                │
│                  │   tracking     │  D-Bus: io.github.wivrn   │
└──────────────────┘               │  Avahi: _wivrn._tcp       │
                                    └───────────┬──────────────┘
                                      renders game → display
                                                │
                                    ┌───────────▼──────────────┐
                                    │  X11 / Gamescope         │
                                    │  (compositor output)     │
                                    └───────────┬──────────────┘
                                                │ x11grab / PipeWire
                                    ┌───────────▼──────────────┐
                                    │  FFmpeg (CaptureManager) │
                                    │  hardware encode via     │
                                    │  VA-API / NVENC / x264   │
                                    └───────────┬──────────────┘
                                                │ fragmented MP4
                                    ┌───────────▼──────────────┐
                                    │  HTTP relay              │
                                    │  (localhost:port)        │
                                    └───────────┬──────────────┘
                                                │ WebRTC
                                    ┌───────────▼──────────────┐
                                    │  Browser Viewer          │
                                    │  (index.html)            │
                                    │  WebXR immersive-vr mode │
                                    └──────────────────────────┘
```

## Layers

### 1. WiVRn Server (`wivrn-server`)
- Built from source via `bin/build_wivrn.sh` (Ubuntu 26.04 container)
- Runs as a systemd user service or daemonized process
- Registers on the D-Bus session bus as `io.github.wivrn.Server`
- Publishes Avahi service `_wivrn._tcp` for headset discovery
- Generates a PIN for pairing (obtainable via `dbus-send`)

### 2. Nearcade Integration (`src/sidecar/wivrn-integration.js`)
- Starts/stops `wivrn-server` as a child process
- Communicates via `dbus-send` for all status and control:
  - `HeadsetConnected`, `SessionRunning`, `Pin`, `Bitrate` properties
  - `Quit()`, `Disconnect()`, `EnablePairing()`, `SetClientTab()` methods
- Sets `WIVRN_SUPPRESS_PIN_POPUP=1` to suppress desktop notifications
  (the PIN is already relayed to the host dashboard via D-Bus)

### 3. Capture Pipeline (`CaptureManager._startWiVRn()`)
- After WiVRn starts and a headset connects, the host compositor output
  is captured via X11 (`x11grab`) or PipeWire
- Captured frames are hardware-encoded (VA-API / NVENC / x264)
- Encoded fragmented MP4 is served over HTTP for WebRTC relay

### 4. WebXR Viewer (`src/scripts/viewer.js`)
- Browser viewer enters WebXR `immersive-vr` session
- Lobby environment rendered (dark room with grid floor + status panel)
- When host streams: video frame rendered as a large floating screen
  (cinema mode) in the VR scene
- HMD + controller tracking data sent via WebSocket datachannel

## Usage

### Building WiVRn from source
```bash
bash bin/build_wivrn.sh          # distrobox
bash bin/build_wivrn.sh --docker # or Docker
```

### Starting the pipeline (manual test)
```bash
# Terminal 1: Start WiVRn server
wivrn-server --no-manage-active-runtime

# Terminal 2: Start Nearcade
npm start

# Connect a headset via WiVRn client app
# Pair using PIN code (shown on D-Bus or in server log)

# Host dashboard → Start Streaming (WiVRn)
# Viewer → Enter VR Mode
```

### Starting with Nearcade (normal flow)
```bash
npm start
# Dashboard → Start Streaming → selects wivrn
# Integration module handles wifi-vr server lifecycle
```

## D-Bus Interface (for debugging)

```bash
# Check if server is running
dbus-send --session --print-reply \
  --dest=org.freedesktop.DBus /org/freedesktop/DBus \
  org.freedesktop.DBus.NameHasOwner \
  string:"io.github.wivrn.Server"
# Returns boolean true/false

# Read headset status
dbus-send --session --print-reply \
  --dest=io.github.wivrn.Server /io/github/wivrn/Server \
  org.freedesktop.DBus.Properties.Get \
  string:"io.github.wivrn.Server" string:"HeadsetConnected"

# Read PIN
dbus-send --session --print-reply \
  --dest=io.github.wivrn.Server /io/github/wivrn/Server \
  org.freedesktop.DBus.Properties.Get \
  string:"io.github.wivrn.Server" string:"Pin"

# Enable pairing with 2min timeout
dbus-send --session --type=method_call \
  --dest=io.github.wivrn.Server /io/github/wivrn/Server \
  io.github.wivrn.Server.EnablePairing int32:120

# Change headset UI tab to stats
dbus-send --session --type=method_call \
  --dest=io.github.wivrn.Server /io/github/wivrn/Server \
  io.github.wivrn.Server.SetClientTab string:"stats"

# Stop server
dbus-send --session --type=method_call \
  --dest=io.github.wivrn.Server /io/github/wivrn/Server \
  io.github.wivrn.Server.Quit
```

## Known Limitations
- Audio: captured via PulseAudio/ALSA loopback (no WebRTC audio passthrough yet)
- Lobby: static environment, no interactive elements yet
- Video panel: flat cinema screen, not stereoscopic depth-corrected
- PIN popup suppressed via env var; PIN shown on host dashboard
