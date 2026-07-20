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
