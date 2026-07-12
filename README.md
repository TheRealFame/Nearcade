<p align="left">
  <img src="assets/NearcadeTitle.png" width="400">
<h1>Nearcade <a href="https://discord.gg/Yz3NeEBdPQ" target="_blank" title="Join our Discord"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 127.14 96.36" width="24" height="18" style="vertical-align:middle;fill:#5865F2;"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg></a></h1>

[English](README.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt.md) | [日本語](README.ja.md)
## Screenshots -- Dashboard, Viewer Page, Arcade

<div align="center">
  <img src="assets/screenshots/nearcade-client-home.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-host.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-viewer.png" alt="Nearcade Viewer" width="45%">
  <img src="assets/screenshots/nearcade-arcade.png" alt="Nearcade Arcade" width="45%">
</div>

## Project Mission
Nearcade is an open-source platform that lets you play local co-op games over the internet with friends. It is built for self-hosted setups. It uses peer-to-peer connections and native operating system audio and input routing to keep input delay low.

The main focus is private setups. The host app requires no special network configuration. Viewers join through a standard web browser on desktop or mobile devices. The mobile viewer interface includes touch controls and a virtual joystick. Users do not need to download anything to play.

## System Requirements
You need specific software installed on your machine to run the host application.

### Required Software
* Node.js version 18 or newer.
* Python 3 for the controller virtualization bridge.
* Git to download the source code.

### Linux Requirements
* PipeWire must be your active audio server. The app targets PipeWire nodes directly to separate game audio from voice chats. It will not work with PulseAudio.
* Your kernel must have the uinput module enabled so the app can create native virtual gamepads.
* The system deploys native udev rules to block mouse and keyboard confusion flags. This bypasses normal Steam Input limits. The provided setup script handles this step.

### Windows Requirements
* You must install the ViGEmBus driver manually to enable gamepad support on Windows.

### Bundled Dependencies
The app bundles Cloudflared and Zrok binaries for tunneling and runs them natively. You do not need to install these manually. The network routing relies on an external Rust VPS Router for signaling, while media streaming happens over WebRTC.

## Platform Support Matrix

| Feature | Linux | Windows | macOS |
|---|---|---|---|
| WebRTC Streaming | Full | Full | Full |
| Gamepad Support | Full | Conditional | None |
| Keyboard and Mouse Input | Full | Limited | Full |
| Multi-Controller | Full | Limited | None |
| Audio Playback | Full | Full | Full |
| Stability Level | Production | Experimental | Experimental |

## Installation and Documentation
Most users will run the compiled executable file directly. The application handles system setup automatically on launch.

You only need to run the setup script manually if you are using the source code or if the compiled app fails to set up your system. To run the Linux setup script manually, navigate to the bin folder from the root of the project.

```bash
cd bin
sudo ./linux_setup.sh
```

We keep all technical setup instructions, dependency lists, and API guides in a dedicated documentation directory. This keeps the main page clean. You can read these files from the Host Dashboard book icon or by clicking the links below.

* [Getting Started Guide](src/docs/GETTING_STARTED.md)
* [Host Usage Manual](src/docs/HOST_USAGE.md)
* [API and Setup Guide](src/docs/API_AND_SETUP.md)
* [VPS Server Setup](src/docs/VPS_SETUP.md)
* [Advanced Logic Documentation](src/docs/ADVANCED_LOGIC.md)
* [Nearcade Arcade Info](src/docs/NEARCADE_ARCADE.md)

## Nearcade Arcade
The platform includes an optional public lobby system. Hosts can list their sessions on the Arcade grid to let global players discover and join local co-op games. You can view the public lobby at https://nearcade.cutefame.net and join active sessions directly from your browser.

This project uses artificial intelligence large language models for code generation and structure planning.
