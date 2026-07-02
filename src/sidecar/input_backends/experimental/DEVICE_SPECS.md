# Experimental Device Specifications

This document outlines the theoretical web APIs and host-side injection methods required for each experimental device category.

## 1. Drawing Tablets (`backend_tablets.py`)
- **Web API**: `PointerEvent` (HTML5). Provides `pressure`, `tiltX`, and `tiltY` natively when a stylus interacts with an HTML Canvas.
- **Host Injection**: Python `uinput` (Linux) or `SendInput` (Windows) configuring an absolute pointer device with pressure axes.
- **Complexity**: Low.

## 2. Guitars & Rhythm Controllers (`backend_guitars.py`)
- **Web API**: `Gamepad API` (`navigator.getGamepads()`).
- **Host Injection**: Xbox 360 Controller emulation (`uinput` / `ViGEmBus`). 
- **Complexity**: Low. Games natively accept Xbox inputs for guitars. Only requires a custom mapping layer to ensure the Strum Bar and Frets map perfectly to the D-Pad/Face buttons.

## 3. Flight Sticks (HOTAS) & Steering Wheels (`backend_hotas.py`, `backend_wheels.py`)
- **Web API**: `Gamepad API` (`navigator.getGamepads()`).
- **Host Injection**: Generic DirectInput/uinput joystick emulation with massive axis counts (e.g. 8 axes, 32 buttons).
- **Complexity**: Medium. The Gamepad API reads these devices, but scrambles the axis IDs. Requires a front-end "Calibration/Mapping UI" for users to assign physical axes to logical outputs before streaming. (No Force Feedback over web).

## 4. Balance Boards (`backend_balanceboard.py`)
- **Web API**: Web Bluetooth or standard Gamepad API (depending on OS pairing).
- **Host Injection**: Python `uinput` emitting coordinate data.
- **Complexity**: Medium. Requires calculating Center of Gravity (CoG) from four corner weight sensors and passing it as analog joystick data.

## 5. Eye & Head Tracking (`backend_eyetracking.py`)
- **Web API**: `WebGazer.js` (Webcam tracking) or WebXR API (for HMD head position). Raw Tobii devices cannot be accessed via web.
- **Host Injection**: Virtual joystick, FreeTrack, or OpenTrack UDP protocols.
- **Complexity**: High. Must translate absolute web coordinates into FreeTrack/TrackIR protocol packets so games (like MSFS) pick them up natively.

## 6. VR Headsets (`backend_vr.py`)
- **Web API**: `WebXR API` (HTML5). Provides 6-DOF (Position + Rotation) for Headset and Controllers at 90hz+.
- **Host Injection**: Custom C++ SteamVR (OpenVR) Driver.
- **Complexity**: Extreme. Python receives UDP coordinates and forwards them via IPC to a compiled `.dll`/`.so` SteamVR driver. Relies on Asynchronous Timewarp (ATW) on the viewer's browser to mitigate motion-to-photon latency.

## 7. Light Guns (`backend_lightguns.py`)
- **Web API**: `PointerEvent` / `MouseEvent` (if acting as a mouse) or Gamepad API.
- **Host Injection**: Absolute mouse positioning.
- **Complexity**: High. Web browsers trap the mouse to the window. Requires raw coordinate scaling from the web resolution to the host's monitor resolution.

## 8. Android Host (`backend_android.py`)
- **Web API**: Standard WebRTC.
- **Host Injection**: Executing `su` shell commands to write to `/dev/uinput`.
- **Complexity**: Impossible over Web. The *Host* must be a native, rooted Android APK running a background service. Cannot be hosted from a mobile browser.
