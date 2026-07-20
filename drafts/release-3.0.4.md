# Nearcade v3.0.4 Release Notes

Nearcade v3.0.4 is a major polish and stability update focused heavily on the **Multi-Instance Co-op Engine**, **Steam Deck/Handheld Accessibility**, and **VPS Auto-Updating**.

## What's New

### Multi-Instance Orchestration
*   **WebRTC Dynamic Hot-Swapping:** Implemented full multiplexing backend for the Host Playground. Assigning a viewer to a specific game instance now triggers an on-the-fly WebRTC track swap without tearing down their connection.
*   **Gamepad-Accessible Router:** HTML5 Drag-and-Drop does not natively support gamepads. To fix this, we added an accessible "Instance Assignment" dropdown directly on the Roster cards in the Host UI, allowing full Multi-Instance orchestration using only a D-pad/Controller.
*   **Input Isolation via `bind-evdev`:** Viewers assigned to a specific window instance now have their virtual inputs isolated exclusively to that game's process via the Python input driver.

### Steam Deck & Handheld Polish
*   **True-Black Vector Iconography:** Rebuilt the Steam Deck asset (`steamdeck.svg`) to perfectly match the sleek roster aesthetics.
*   **Automatic Client Detection:** The server now accurately parses client identifiers and automatically assigns the Steam Deck iconography to verified handheld users on the roster.
*   **Memory Leak Fixes:** Resolved an issue where multiple controller connections would duplicate `requestAnimationFrame` polling loops, causing significant CPU drain on handhelds.

### Viewer UI Experience
*   **Advanced Settings Modal:** Removed the cluttered sidebar buttons in favor of a sleek, glassmorphic settings modal for viewers.
*   **Client-Side Deadzones:** Added an analog stick deadzone slider that directly overrides the gamepad polling loop, allowing viewers to fix their own "stick drift" without host intervention.
*   **Stream & Rumble Overrides:** Viewers can now toggle rumble, switch bandwidth profiles, and force-reload streams effortlessly from the new settings menu.

### VPS Router Architecture
*   **Self-Updating Binaries:** The Rust VPS router now supports fully automated background updates. By configuring the `AUTO_UPDATE_REPO` environment variable, the VPS will check GitHub hourly and seamlessly pull/reboot into the latest compiled binary release.
*   **Version Sync:** The VPS router binary version has been explicitly bumped to align with the `3.0.4` ecosystem.

## Bug Fixes
*   Removed hardcoded scroll constraints on the URL list in the Host Playground, allowing all links to display naturally.
*   Fixed memory leaks and improper teardowns in the `stopCapture()` lifecycle during Multi-Instance mode.
