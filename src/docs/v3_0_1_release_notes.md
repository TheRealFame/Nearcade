# NearsecTogether v3.0.1 (Hotfix)

This update addresses several critical UI regressions and IPC bridge failures introduced in the v3.0.0 architecture migration. It primarily focuses on ensuring backwards compatibility for users on older clients (v2.0.8) and restoring essential desktop interface controls for Arcade mode.

## 🐛 Bug Fixes
* **Restored IPC Window Controls:** Fixed an issue where the Electron IPC bridge was missing the `window-fullscreen` listener. Users on older clients (like v2.0.8) who rely on the native window frame for fullscreen toggling will now have functioning buttons again. We also restored the `window-minimize` and `window-maximize` listeners.
* **Arcade Sidebar Accessibility:** Resolved a critical UI bug where desktop client users could not access the right-side control panel (`nsBar`) while playing in Live Arcade sessions. The sidebar now correctly opens when the mouse cursor touches the far-right edge of the screen.
* **Arcade UI Overlap Fix:** The client version text display no longer overlaps the game stream when viewing a Live Arcade session on the dashboard.
* **Discord RPC Stability:** Addressed missing IPC handlers that were contributing to Discord Rich Presence failing to sync correctly with the Electron app.

## ➕ Additions
* **Right-Edge Mouse Activation:** Added a new desktop interaction model for the `nsBar` sidebar. Previously relying entirely on a mobile touch-swipe gesture, desktop users can now intuitively slide open the options panel by moving their mouse to the edge of the window.
* **Decoding Architecture Roadmap:** Added a new internal documentation file (`decoding_roadmap.md`) outlining the future low-latency rendering pipeline (Insertable Streams + WebGL / Native C++ Addons) to push decoding speeds beyond standard WebRTC limitations.
