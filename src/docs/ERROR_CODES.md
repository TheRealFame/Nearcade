# Nearcade Error Codes

This document outlines the standardized error codes used across the Nearcade ecosystem, including their severity and how they are presented to the user.

## Error Severities
- **Yellow (Warning):** Non-fatal issues that degraded the experience or require setup but don't prevent the app from running (e.g., Setup not run, minor cache corruption).
- **Red (Critical):** Fatal issues that prevent core functionality from working (e.g., Input driver failed to load, WebRTC fatal crash, Tunnel failure).

---

## 1. Setup & Environment Errors

| Code | Severity | Context | Description | UI Action |
|---|---|---|---|---|
| **E100** | Yellow | Host | **Setup Not Run:** The Linux udev rules or virtual input kernel modules (`uinput`) have not been configured on this host. Gamepad injection will not work. | Shows a yellow banner on the host dashboard prompting the user to run setup. |
| **E101** | Yellow | Viewer | **i18n Cache Corrupt:** Localized language strings in the browser cache were corrupted and had to be wiped. | Silent or minor console warning. |

## 2. Input Driver Errors

| Code | Severity | Context | Description | UI Action |
|---|---|---|---|---|
| **E200** | Red | Host | **Native uinputBridge Failed:** The C++ virtual controller node module failed to load. The host cannot spawn gamepads. | Shows a red critical popup on the host dashboard. |
| **E201** | Red | Host | **Python Gamepad Bridge Failed:** The fallback Python gamepad reader crashed or failed to spawn. Native host controllers will not be read. | Shows a red critical popup on the host dashboard. |
| **E202** | Red | Host | **Experimental Backend Crashed:** A specific sidecar backend (e.g., Eyetracking or HOTAS) encountered a fatal exception and terminated. | Shows a red popup on the host dashboard. |

## 3. Streaming & Audio Errors

| Code | Severity | Context | Description | UI Action |
|---|---|---|---|---|
| **E300** | Red | Host | **Virtual Audio Cable Failed:** PipeWire/PulseAudio failed to create the `NearsecVirtualCapture` loopback. Stream audio will not work. | Shows a red critical popup on the host dashboard. |
| **E301** | Red | Viewer | **WebRTC Handshake Failed:** The WebRTC peer connection to the host failed to negotiate. | Shows a red critical popup overlay on the viewer stream. |
| **E302** | Red | Host | **Desktop Capture Blocked:** OS-level screen recording permissions are denied, or PipeWire capturer crashed. | Shows a red critical popup on the host dashboard. |

## 4. Tunneling & Network Errors

| Code | Severity | Context | Description | UI Action |
|---|---|---|---|---|
| **E400** | Red | Host | **Tunnel Provider Failed:** Cloudflared, Zrok, or local ngrok failed to spawn or crashed unexpectedly. | Shows a red critical popup on the host dashboard. |
| **E401** | Red | Viewer | **Signaling Socket Dropped:** The Pusher/Websocket signaling server disconnected abruptly. | Shows a red critical popup overlay on the viewer stream. |
