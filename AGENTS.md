# Agents

This repository is maintained with the assistance of AI coding agents.

## Supported Agents
- GitHub Copilot
- Google DeepMind Gemini (Antigravity)

## Guidelines for Agents
1. **Consistency**: Maintain the existing architectural patterns (especially around the `ExperimentalOrchestrator.js` and `hidmaestro` layers).
2. **Platform Support**: Always consider cross-platform compatibility (Windows, Linux, macOS) before proposing OS-specific modules.
3. **Dependencies**: Minimize adding new heavy npm dependencies unless absolutely necessary. Rely on native browser APIs and C/Python sidecars where performance is critical.

## Dev Environment Tips
- **Core Server:** The main web server is executed via `npm start` (runs `src/scripts/server.js`). It is critical that changes to the WebRTC signaling logic are tested against this server.
- **Sidecars (Python & Rust):**
  - **Python Input Backend:** Located in `src/sidecar/input_backends`. Always verify that changes to evdev/uinput loops maintain strict multi-controller isolation.
  - **Rust VPS Router:** Located in `vps/`. Compile changes locally using `cargo build --release` inside the `vps` folder. The router utilizes `self_update` tied to the `AUTO_UPDATE_REPO` environment variable.
- **Electron Build:** To spin up the desktop environment, use `npm run dev`.

## Testing Instructions
- **Headless Verification:** Before finalizing any feature, you MUST run `npm test`. This triggers `bin/verify.js`, which executes a headless verification suite checking the server boot, virtual audio engine, REST APIs, and WebSocket handshakes.
- **WebRTC Validation:** If modifying `viewer.js` or `host.js`, test the `bind-evdev` hot-swapping logic thoroughly to ensure no memory leaks occur in the `requestAnimationFrame` polling loops.
- **Fix Errors:** Fix any warnings or failed connections emitted during `npm test` before committing. The output must end cleanly with `Shutting down server...`.
- **Rust Testing:** For changes within the `vps/` directory, always run `cargo check` before committing to ensure the router compiles cleanly without borrowing errors.

## PR and Commit Instructions
- **Title Format:** `feat(<component>): <description>`, `fix(<component>): <description>`, or `docs: <description>`.
- **Pre-commit Checklist:** 
  - Ensure `npm test` passes.
  - Verify backward compatibility for old `index.html` viewer clients.
  - Do not increment the major version arbitrarily (e.g., jump to 3.1.0); follow the current static versioning plan unless instructed otherwise.

## Critical System Architecture & Gotchas (MUST READ)

When modifying core systems, you MUST adhere to the following rules derived from past bug-fixes and architectural quirks:

### 1. WebCodecs & Streaming Pipeline (`host.js`)
- **Buffer Bloat:** WebRTC DataChannels and WebSockets buffer infinitely. In `broadcastToViewers()`, you MUST check `bufferedAmount`. If it exceeds 1-2MB, you must drop video frames and force a keyframe to prevent permanent stream latency degradation.
- **Config Protection:** During buffer bloat, you must explicitly exempt JSON configuration strings (`typeof data === 'string'`) from being dropped. If late-joining viewers miss the `_lastWcConfig` string, their `VideoDecoder` will never initialize, resulting in a permanent black screen.
- **Linux H264 VAAPI:** The Linux `VaapiVideoEncoder` natively fails to emit mandatory AVCC extradata (description) for H264. Custom polyfills and manual dynamic resolution handling are required.

### 2. WebRTC Signaling & Identity (`server.js`, `signaling.js`)
- **VPS UUIDs:** When routing through the Rust VPS, the `viewerId` is the full Rust UUID (e.g. `f4a38b29-9dee-...`), whereas standard local connections use shorter identifiers. Ensure ID parsing logic accommodates both.
- **Signaling Reconnection:** `signaling.js` does NOT auto-reconnect on its own. Auto-reconnect and state recovery logic is explicitly deferred to the consumers (`host.js` and `viewer.js`).
- **Input Payloads:** The Node server does NOT reject empty gamepad arrays. An all-zero/rest state is a valid and necessary payload for un-pressing buttons.

### 3. Input Handling Sidecars (`linux_uinput.py`, `backend_tablets.py`)
- **Key-Repeats:** You MUST completely ignore OS key-repeats in the Python loops. If a button is already held down, do not broadcast duplicate press events, or it will flood the event loop.
- **Mobile Quirk:** Mobile touch controls aggressively strip Gamepad IDs to save bandwidth; the input backends are designed to handle this specific parsing quirk.
- **Windows Digitizers:** Windows does not natively support user-mode virtual digitizers (pens with pressure), which affects tablet support parity with Linux.

### 4. Infrastructure & TURN Servers (`bin/setup_turn.sh`, `server.js`)
- **Bandwidth Theft Prevention:** Nearcade uses dynamic, time-limited TURN REST API credentials (`use-auth-secret`) for its VPS WebRTC fallback. Never hardcode static TURN passwords via `lt-cred-mech`, as it allows public bandwidth theft. The Node server automatically generates temporary HMACs based on the `TURN_SECRET`.

### 5. Frontend & UI Quirks (`host.js`, `viewer.js`)
- **WebGL Resizing:** In `viewer.js`, when resizing a WebGL canvas for WebCodecs, you must use hardware `codedWidth` and explicitly re-acquire the context after resize, otherwise the video frame drops completely.
- **Firefox Promises:** When dealing with older WebRTC APIs, code must be safe for Firefox, which sometimes does not return standard Promises.
- **WebRTC Negotiation:** Do NOT send `request-offer` unconditionally during connection setup, as it triggers state-machine race conditions during hot-swaps.
- **H264 Hardware Quirks:** Windows AMD/MediaFoundation has known bugs with specific H264 profiles. Furthermore, the Linux WebCodecs hardware encoder completely fails to encode H264 properly, requiring a forced fallback to VP9 on Linux.
- **Screen Capture Modals:** The custom desktop picker modal for WebRTC screen capture MUST be bypassed on Linux and macOS due to OS-level API limitations.
- **Audio Sink Routing:** Viewer voices in the voice chat system must be explicitly routed to the host's hardware output device using `setSinkId()`, otherwise they may play through the virtual sink and cause infinite echo loops.
- **Async DOM Duplication:** When updating DOM elements asynchronously from WebSocket events (like rosters), you must clear the innerHTML and append the new elements in the exact same synchronous block to prevent ghost duplicates.

### 6. Node Server Subprocesses & Audio (`server.js`)
- **Python Buffering:** When spawning Python sidecars, you MUST use the `-u` flag to bypass Python's stdout buffer lock. Without this, Node will never receive stdout data. Use `stdio: 'inherit'` or explicitly pipe so crashes are exposed.
- **PulseAudio Teardown Buzz:** When stopping the Linux virtual audio engine, you MUST unload `module-loopback` BEFORE unloading the `null-sink`. Reversing this order causes a permanent, deafening audio buzz until the PulseAudio daemon is forcefully killed.
- **Env Fallback:** Always use the `readEnv` helper to catch host environment variables in case the Electron GUI fails to pass them down.
