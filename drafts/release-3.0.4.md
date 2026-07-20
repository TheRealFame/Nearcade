# Nearcade 3.0.4

This release focuses on quality-of-life improvements, fixing UI stutters, and handling larger game libraries more efficiently. We've also improved multi-instance routing and added a few updates for Steam Deck users.

## Changes & Improvements

### Core & Performance
- **Background Game Scanning:** Offloaded Steam game library detection (`@nearcade/launcher-detect`) to a background `worker_thread` with a 5-minute cache. This prevents the Node.js event loop from stalling for users with massive (1000+) Steam libraries.
- **Audio Fallback Timeout:** Re-enabled the Python OS-level audio fallback. If the browser fails to grab system audio, it will wait 3 seconds before automatically spinning up the Python audio driver.
- **Smart Windows Setup:** The boot script now checks for `ViGEmBus.sys` natively. If the driver is already installed, it silently skips the setup wizard and takes you straight to the dashboard.
- **Version Parity:** Synced the VPS router and `package-lock.json` up to 3.0.4.

### Viewer UI & Extensions
- **Identity Persist Extension Fix:** Rewrote the Tampermonkey script's sync loop. It now uses a bidirectional memory cache, fixing a bug where visiting a new Zrok subdomain would wipe your saved viewer settings.
- **Zero-Flicker Navigation:** Fixed visual stutters on the dashboard splash screen and viewer UI. Custom chat colors and splash visibility are now applied synchronously before the DOM paints.
- **Settings Modal & Controls:** Moved viewer options into a new settings modal. Added a client-side stick deadzone slider so viewers can counter stick drift themselves, plus toggles for rumble and stream bandwidth.

### Multi-Instance & Handhelds
- **Dynamic Track Swapping:** Moving a viewer to a different game instance on the Host Playground now swaps their WebRTC track on the fly without dropping the connection.
- **Gamepad-Friendly Routing:** Added an "Instance Assignment" dropdown to the roster cards so you can route players to games using just a controller (bypassing the need for drag-and-drop).
- **Process Isolation:** Inputs for viewers assigned to specific window instances are now strictly isolated to that game via `bind-evdev`.
- **Steam Deck Updates:** Added proper Steam Deck icon parsing for verified handheld users and fixed a `requestAnimationFrame` memory leak that was draining CPU when multiple controllers connected.

## Bug Fixes
- Removed hardcoded scroll limits on the Host Playground URL list.
- Fixed teardown logic issues in `stopCapture()` during Multi-Instance mode.
- Dropped the fake `StorageEvent` from the Tampermonkey script that was crashing third-party extension dashboards.
