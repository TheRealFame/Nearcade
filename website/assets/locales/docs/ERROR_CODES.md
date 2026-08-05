# Error Codes

If Nearsec encounters an issue, it will display a standardized error code.

### Network Errors
- **E10**: ICE Gathering failed. Your firewall may be completely blocking WebRTC STUN traffic.
- **E11**: Signaling WebSocket disconnected. The Host or Tunnel may have gone offline.

### Input Errors
- **E20**: Virtual Controller Creation Failed (Windows). Ensure ViGEmBus is installed and up to date.
- **E21**: uinput Permission Denied (Linux). The host must run Nearsec with appropriate `/dev/uinput` privileges.

### Audio Errors
- **E30**: Failed to capture loopback device. Ensure you have unlocked the audio context by clicking the UI.
- **E31**: Application Audio Blacklisting failed. PulseAudio/PipeWire backend returned an error.

### General
- **E99**: Unhandled generic exception. Check the developer console (`Ctrl+Shift+I`) for more details.
