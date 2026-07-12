# WiVRn Integration for Nearcade

This document describes how to use WiVRn (OpenXR streaming) with Nearcade for VR game streaming to standalone headsets.

## Overview

WiVRn is a fully FOSS (GPL-3.0) Linux application that wirelessly streams VR games to standalone headsets like Meta Quest, Pico, HTC Vive Focus, etc. By integrating WiVRn with Nearcade, you can:

1. **Stream VR games to standalone headsets** - Play SteamVR/OpenVR games on Meta Quest, Pico, etc.
2. **Share with browser viewers** - Friends can watch via WebRTC in their browser
3. **Use OpenComposite** - Run SteamVR games without SteamVR runtime via OpenXR translation

## Quick Start

### 1. Install WiVRn

Run the setup script:
```bash
cd Nearcade
./bin/setup_wivrn.sh
```

Or install manually based on your distribution:

**Arch Linux:**
```bash
sudo pacman -S wivrn-dashboard wivrn-server
```

**Fedora:**
```bash
sudo dnf install wivrn
```

**Flatpak (all distributions):**
```bash
flatpak install flathub io.github.wivrn.wivrn
```

### 2. Install WiVRn on Your Headset

- **Meta Quest:** Install from [Meta Store](https://www.meta.com/experiences/7959676140827574/)
- **Other headsets:** Use the APK download from WiVRn dashboard

### 3. Start WiVRn

```bash
# Start the dashboard for setup
wivrn-dashboard

# Or start the server directly
wivrn-server
```

### 4. Pair Your Headset

1. Start WiVRn on your PC
2. Start WiVRn app on your headset
3. Your PC should appear in the headset's device list
4. Select your PC to connect

### 5. Launch VR Games

For **OpenXR games**: Just launch normally - WiVRn will detect and stream.

For **SteamVR/OpenVR games** (like VRChat):

1. **Method 1: Automatic (Recommended)**
   - WiVRn automatically sets the OpenVR runtime to `xrizer` when a headset connects
   - Just launch your SteamVR games normally

2. **Method 2: Manual Launch Options**
   - Right-click game in Steam → Properties → Launch Options
   - Add: `wivrn+udp://YOUR_PC_IP`
   - Example: `wivrn+udp://192.168.1.100`

### 6. Start Nearcade

```bash
# Start Nearcade host
./nearcade-host

# Or use the capture pipeline directly
node src/sidecar/pipewire-capture.js --wivrn
```

## Configuration

### WiVRn Settings

WiVRn can be configured via:
- **Dashboard:** Graphical configuration
- **Command line:** `wivrn-server --help`
- **Config file:** `~/.config/wivrn/config.yaml`

Recommended settings for Nearcade:
```yaml
encoding:
  encoder: auto      # Uses best available (nvenc > vaapi > libx264)
  bitrate: 20000000  # 20 Mbps for good quality
  resolution: 1920x1080
  framerate: 90

network:
  allow_wired: true  # Enable USB connection
```

### Nearcade Settings

Configure in `nearcade.config.json`:
```json
{
  "capture": {
    "method": "wivrn",
    "width": 1920,
    "height": 1080,
    "fps": 90,
    "bitrate": 20000000
  }
}
```

## OpenComposite for SteamVR Games

WiVRn includes **xrizer**, an OpenVR→OpenXR translation layer that works like OpenComposite. This allows SteamVR games to run without the SteamVR runtime.

### How It Works

1. When a headset connects, WiVRn sets the OpenVR runtime to `xrizer`
2. SteamVR games use the OpenVR API, which is translated to OpenXR by xrizer
3. WiVRn streams the OpenXR output to your headset

### Supported Games

Most SteamVR games work with xrizer/OpenComposite. For best compatibility:

- **VRChat:** ✅ Works well
- **Beat Saber:** ✅ Works well
- **The Room VR:** ✅ Works well
- **Accounting/Accounting+:** ✅ Works well
- **Pavlov VR:** ✅ Works well

### Troubleshooting OpenComposite

If a game doesn't work:

1. **Check runtime:**
   ```bash
   steam -get-openglruntime
   ```
   Should show `xrizer` when headset is connected.

2. **Manual override:**
   ```bash
   export SteamVR_Runtime=xrizer
   steam steam://rungameid/APP_ID
   ```

3. **Check logs:**
   ```bash
   journalctl -u wivrn-server -f
   ```

## Network Requirements

### Ports
- **UDP 5353:** Avahi/Bonjour for device discovery
- **TCP/UDP 9757:** WiVRn streaming protocol

### Firewall Configuration

**UFW:**
```bash
sudo ufw allow 5353/udp
sudo ufw allow 9757
```

**firewalld:**
```bash
sudo firewall-cmd --permanent --add-port=5353/udp
sudo firewall-cmd --permanent --add-port=9757/tcp
sudo firewall-cmd --permanent --add-port=9757/udp
sudo firewall-cmd --reload
```

### Wired Connection

For lower latency, use USB connection:
```bash
# Connect headset via USB
adb reverse tcp:9757 tcp:9757
adb shell am start -a android.intent.action.VIEW -d "wivrn+tcp://localhost" org.meumeu.wivrn
```

## Performance Optimization

### Encoding Settings

| Setting | Value | Notes |
|---------|-------|-------|
| Encoder | nvenc | Best for NVIDIA GPUs |
| Encoder | vaapi | Best for AMD/Intel GPUs |
| Encoder | libx264 | Software fallback |
| Bitrate | 15-25 Mbps | Adjust based on network |
| Resolution | 1600x1440 | Good balance for Quest 2/3 |
| FPS | 72-90 | Match your headset refresh rate |

### Reduce Latency

1. **Use wired connection** (USB) instead of WiFi
2. **Lower resolution** (1440x1600 instead of 1832x1920)
3. **Lower bitrate** (15 Mbps instead of 25 Mbps)
4. **Use hardware encoding** (nvenc/vaapi instead of libx264)
5. **Close background applications** that use network bandwidth

### GPU-Specific Tips

**NVIDIA:**
- Ensure NVENC is available: `nvidia-smi -q | grep NVENC`
- Use `nvenc` encoder for best performance

**AMD:**
- Ensure VA-API is available: `vainfo`
- Use `vaapi` encoder

**Intel:**
- Ensure VA-API is available: `vainfo`
- Use `vaapi` encoder

## Troubleshooting

### Common Issues

**"No headset found"**
- Ensure WiVRn app is running on your headset
- Check that both PC and headset are on the same network
- Verify Avahi is running: `systemctl status avahi-daemon`
- Check firewall: ports 5353/udp and 9757 must be open

**"Connection failed"**
- Ensure WiVRn server and client are the same version
- Try wired connection instead of WiFi
- Restart both WiVRn server and headset app

**"Black screen in headset"**
- Check that the game is running on your PC
- Verify OpenComposite/xrizer is enabled for SteamVR games
- Try a different game to test

**"High latency"**
- Use wired connection (USB) instead of WiFi
- Reduce resolution and bitrate
- Close other network-intensive applications
- Check for WiFi interference

### Debug Commands

```bash
# Check WiVRn server status
wivrn-cli status

# Check WiVRn server logs
journalctl -u wivrn-server -f

# Check connected headsets
wivrn-cli list-headsets

# Check WiVRn version
wivrn-server --version

# Check Avahi status
systemctl status avahi-daemon

# Check firewall
sudo ufw status
```

## Advanced Configuration

### Multiple Headsets

WiVRn supports multiple headsets connected simultaneously. Each headset will have its own stream.

### Custom Launch Options

For advanced users, you can specify custom launch options:
```bash
# UDP with specific port
wivrn+udp://192.168.1.100:9757

# TCP for wired connection
wivrn+tcp://192.168.1.100:9757
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WIVRN_HOST` | WiVRn server host | 127.0.0.1 |
| `WIVRN_PORT` | WiVRn server port | 9757 |
| `CAPTURE_WIDTH` | Capture width | 1920 |
| `CAPTURE_HEIGHT` | Capture height | 1080 |
| `CAPTURE_FPS` | Capture FPS | 90 |
| `CAPTURE_BITRATE` | Capture bitrate | 20000000 |

## Integration with Nearcade

### Capture Methods

Nearcade supports multiple capture methods:

1. **pipewire** - Capture from PipeWire nodes (Gamescope, SteamVR)
2. **wivrn** - Capture from WiVRn streams
3. **ffmpeg** - Direct FFmpeg capture
4. **webcodecs** - Browser-based encoding
5. **webrtc** - Native WebRTC

### Using WiVRn with Nearcade

```javascript
// In your Nearcade host code
const capture = require('./src/sidecar/CaptureManager');

// Start WiVRn capture
const result = await capture.start('wivrn', {
    width: 1920,
    height: 1080,
    fps: 90,
    bitrate: 20000000
});

console.log(`Stream available at: ${result.url}`);
```

### Command Line Usage

```bash
# Start WiVRn streaming
node src/sidecar/pipewire-capture.js --wivrn

# List available nodes (includes WiVRn)
node src/sidecar/pipewire-capture.js --list

# Start streaming from specific node
node src/sidecar/pipewire-capture.js --stream wivrn
```

## Supported Headsets

| Headset | Support | Notes |
|---------|---------|-------|
| Meta Quest 1 | ✅ Full | Original Quest |
| Meta Quest 2 | ✅ Full | Most popular |
| Meta Quest 3 | ✅ Full | Latest model |
| Meta Quest 3s | ✅ Full | Newest model |
| Meta Quest Pro | ✅ Full | High-end |
| Pico Neo 3 | ✅ Full | Alternative to Quest |
| Pico 4 | ✅ Full | Latest Pico |
| HTC Vive Focus 3 | ⚠️ Laggy | Performance issues |
| HTC Vive XR Elite | ⚠️ Laggy | Performance issues |
| Samsung Galaxy XR | ✅ Full | Samsung headset |

## Resources

- **WiVRn GitHub:** https://github.com/WiVRn/WiVRn
- **WiVRn Documentation:** https://github.com/WiVRn/WiVRn/blob/master/README.md
- **OpenComposite:** https://gitlab.com/znixian/OpenOVR
- **xrizer:** https://github.com/Supreeeme/xrizer
- **Monado (OpenXR Runtime):** https://monado.freedesktop.org/

## License

WiVRn is licensed under GPL-3.0. Nearcade is also GPL-3.0. This integration maintains compatibility with both licenses.
