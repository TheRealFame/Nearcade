# Nearsec Together

[English](README.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português](README.pt.md) | [日本語](README.ja.md)

## Project Mission
Nearsec Together is an open-source platform that lets you play local co-op games over the internet with friends. It is built for self-hosted setups. It uses peer-to-peer connections and native operating system audio and input routing to keep input delay low.

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

* src/docs/GETTING_STARTED.md
* PLATFORM_SETUP.md
* src/docs/HOST_USAGE.md
* src/docs/API_AND_SETUP.md
* src/docs/ADVANCED_LOGIC.md

## Nearsec Arcade
The platform includes an optional public lobby system. Hosts can list their sessions on the Arcade grid to let global players discover and join local co-op games. You can view the public lobby at https://nearsec.cutefame.net/arcade and join active sessions directly from your browser.

This project uses artificial intelligence large language models for code generation and structure planning.
