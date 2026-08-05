# Troubleshooting & Crash Recovery

This guide covers the most common crashes, freezes, and "it just stopped working" scenarios reported on Nearcade, and the exact steps to recover from each one. It is written for hosts and power users — no code knowledge required.

## Table of Contents
1. [Viewer sees a black screen](#1-viewer-sees-a-black-screen)
2. [Stream picture slowly gets worse over time](#2-stream-picture-slowly-gets-worse-over-time)
3. [Session never connects (stuck on "Connecting")](#3-session-never-connects-stuck-on-connecting)
4. [Virtual controller not detected by game](#4-virtual-controller-not-detected-by-game)
5. [Deafening audio buzz after the host shuts down (Linux)](#5-deafening-audio-buzz-after-the-host-shuts-down-linux)
6. [Voice chat echoes or feeds back](#6-voice-chat-echoes-or-feeds-back)
7. [Browser/session crashes on a very weak connection](#7-browsercapture-fails-on-a-very-weak-network)
8. [Roster shows ghost/duplicate players](#8-roster-shows-ghost-or-duplicate-players)
9. [A viewer left but their controls stay plugged in](#9-a-viewer-left-but-their-controls-stay-plugged-in)
10. [Permanent Unhandled error screen after a hardware change](#10-permanent-unhandled-error-screen-after-a-hardware-change)

---

### 1. Viewer sees a black screen

**Symptom:** The viewer connects fine (roster shows them, audio may even work) but the video is permanently black.

**Why it happens:** The WebCodecs decoder was never given its codec configuration. This is a known race: when the host network backs up, the host intentionally drops non-critical data to keep the stream alive — but it must **never** drop the JSON configuration packet that boots the viewer's `VideoDecoder`. If that packet is missed, the decoder can never initialize and stays black forever, even after the network recovers.

**Fix:**
1. Have the viewer refresh the page (F5) — do not just wait.
2. If it still happens repeatedly, reduce the host's bitrate/resolution one notch and reconnect; lower stress = fewer forced drops.
3. Confirm with the host that their internet upload is not saturated (green "Live" pill is fine; a yellow/red one means the encoder is backing up).

---

### 2. Stream latency slowly gets worse over time

**Symptom:** The game runs fine at first but after 10–20 minutes the live view lags further and further behind, and never recovers on its own.

**Why it happens:** WebRTC data channels and WebSockets buffer **infinitely**. If nothing enforces a drop, the encoder slowly queues stale frames and the latency becomes permanent. Nearcade enforces this with `bufferedAmount` checks that drop stale frames and force a keyframe — but if an older session (or a session started before the current build) is running, that protection may not be applied.

**Fix:**
1. First: stop and restart the session (drops the stale buffer).
2. If it keeps growing, update the host client to a current build.
3. Avoid running the host on Wi-Fi that is sharing the same connection as heavy downloads.

---

### 3. VIP session never connects controls (stuck on Connecting)

**Symptom:** Video works but no buttons/controller respond — or the whole session sits on "Connecting…" for 15s+.

**Why it happens:** WebRTC needs STUN/TURN candidates. If your network swaps between typed profiles (e.g., a dead or slow public TURN relay is in the pool), the handshake can stall for many seconds while certain servers time out. The ladder is supposed to try fast reliable servers first, then community relays as a last resort.

**Fix:**
1. Wait up to ~25s — the ladder eventually fails over and connects.
2. If it's a hard "Connecting" screen for minutes, hard-refresh the viewer URL (or re-open the link without a trailing `/`).
3. For the host: add your own trusted TURN server in Settings → Community TURN Servers. A responsive custom relay makes handshakes near-instant.

---

### 4. Virtual controller never created by your game

**Symptom:** The viewer joined as Gamepad mode, but no controller appears in the game.

**Why it happens:** The virtual controller is created by a kernel-side driver, which needs either privants granted at install time on Linux, or the third-party ViGEmBus driver on Windows.

**Fix:**
- **Windows:** Install ViGEmBus (the setup wizard prompts for this). Verify the driver exists under Device Manager → Software Devices → *ViGEm Bus Enumerator*.
- **Linux:** The host needs write access to `/dev/uinput`. Check with your setup script — run `bin/linux_setup.sh` (or `sudo modprobe uinput`), then restart the host.
- If the wingamepad was *working before* and then stopped, make sure the host app wasn't updated mid-driving — input handlers must be running with the same version as the web UI. Restart the host app fully.

---

### 5. Deafening audio buzz after the host shuts down (Linux)

**Symptom:** After the host quits, the speakers emit a loud permanent buzz that won't stop.

**Why it happens:** The Linux virtual audio engine is torn down in a specific order — the loopback module must be unloaded **before** the null-sink. Reversed order leaves a loopback wire pointing at a dead sink, producing a buzz until PulseAudio is killed.

**Fix (immediate):**
```bash
pactl list short modules   # note the module IDs
pactl unload-module <loopback_module_id>   # unload ringback FIRST
pactl unload-module <null_sink_module_id>  # then the sink
```
If it won't stop, restart the audio daemon:
- PulseAudio: `pulseaudio -k && systemctl --user restart pulseaudio`
- PipeWire: `systemctl --user restart pipewire pipewire-pulse`

Always use the normal "Stop Session / Quit" button from the host UI rather than killing the app mid-session — the app performs this teardown in the correct order on clean exit.

---

### 6. Voice chat echoes or feeds back

**Symptom:** Viewers hear themselves, or hear everything the host desktop plays.

**Why it happens:** Viewer voices are routed to the host's physical output device. If they get routed to the *virtual* capture sink instead, the game audio loopback picks them up and creates an endless echo.

**Fix:**
1. Host: routing is automatic — make sure the "Application Audio" capture is using the dedicated virtual sink (not the desktop/headphone sink).
2. If an echo appears after changing the host's audio output device, the host should return to device settings and select the physical output (not the virtual sink) for voice chat.

---

### 7. Host/capture fails on a very weak network, or a session dies when a viewer drives a device

**Symptom:** Capture stops, roster freezes, or the host disconnects when many viewers join/leave or when someone enables heavy processing (e.g., streaming + VR at once).

**Why it happens:** Aggressive frame drops and hot-swap teardown are resource-heavy; on weak hosts this saturates and the browser reclaims a stream mid-flight.

**Fix:**
1. Reduce the host's max resolution/bitrate.
2. Use "Input Only" mode when broadcasting **externally** (Discord/OBS) — this stops video processing for external capture, freeing the machine.
3. Enable/keep "Host Delay Equalization" ON — it dynamically factors in encode/transmit time so inputs stay synced under jitter.
4. In VR: keep the WiVRn RGB and the virtual sound out of the same network segments as the session.

---

### 8. Roster shows ghost/duplicate players

**Symptom:** Players remain in the roster after leaving, or appear twice.

**Why:** Roster DOM is re-rendered from async WebSocket messages. A classic bug is appending new elements after the old ones in a separate tick, producing duplicates. The fixed code clears and rebuilds in the same synchronous block — if you still see this, the client is stale.

**Fix:**
1. Hard-refresh the host (`Ctrl+Shift+R`).
2. If you run a custom host client from source, pull the latest build.
3. Wait a few seconds; the server prunes dead viewers on its own.

---

### 9. A viewer left, but their controller stays "pressed"

**Symptom:** After someone leaves, a key/button stays held down in the game.

**Why:** The host must replay a "rest state" payload so held buttons get released on disconnect. This works when the disconnect is handled cleanly (viewer clicks Leave). If the viewer's tab was killed abruptly, the virtual controller might linger until the server's heartbeat expires it.

**Fix:**
1. Kick the stale viewer from the roster (the kick path forces the release).
2. If a slot remands stuck, toggle the viewer's slot lock off then on, or restart the session — the virtual device is destroyed and recreated cleanly.

---

### 10. Permanent "Unhandled exception" screen after a hardware change

**Scenario:** Session died with E99 (or you see a red error toast), and now even restarting the session doesn't help, e.g. after adding/removing a GPU or audio device.

**Why:** The app holds references to a dead MediaStream/`peerConnection` and the nearest `try/catch` for the mutation is missing, so teardown throws before cleanup.

**Fix:**
1. Fully quit the host app (not just close the session).
2. Confirm OS-level audio/GPU drivers are OK (the device is still visible to other apps).
3. Re-open the host. Cleanup hooks now wrap teardown in try/catch and hard-stop/ null each track — this releases the stale device handle.
4. If the game never contributed to the stream, remove and re-add the instance.

---

## Debugging yourself quickly

- Open the browser DevTools (`Ctrl+Shift+I`) on the **host** page → Console tab. Look for the `[WebRTC]` notes (ladder telemetry), `[PPS]` (viewer flood kick), `[Congestion]` (bitrate reasons), and `[codec]` (H264/VP9 selection and iGPU detection).
- `npm test` (source builds only) validates the server: boot, virtual audio, REST APIs, and WebSocket handshake — `Verification Complete!` means the core is healthy.

This project uses artificial intelligence large language models for code generation and structure planning.