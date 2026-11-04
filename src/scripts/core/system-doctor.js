/**
 * Nearcade System Doctor & Preflight Diagnostic Engine
 * Validates host environment, permissions, display compositor, audio daemon,
 * hardware encoders, network interfaces, and system limits.
 *
 * Design principle: State findings clearly, provide exact remediation commands,
 * and never interactively escalate or alter system files without explicit user action.
 *
 * License: MIT
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { execSync, execFileSync } = require('child_process');

class SystemDoctor {
  constructor() {
    this._cachedReport = null;
    this._inFlightPromise = null;
  }

  /**
   * Helper to safely read user configuration from nearcade.config.json.
   */
  _loadUserConfig() {
    try {
      const home = os.homedir();
      let cfgDir;
      if (process.platform === 'win32') cfgDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Nearcade');
      else if (process.platform === 'darwin') cfgDir = path.join(home, 'Library', 'Application Support', 'Nearcade');
      else cfgDir = path.join(home, '.config', 'Nearcade');
      const cfgPath = path.join(cfgDir, 'nearcade.config.json');
      if (fs.existsSync(cfgPath)) {
        return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {};
      }
    } catch (_) {}
    return {};
  }

  /**
   * Helper to safely execute a shell command with a timeout.
   * Returns stdout string, or empty string on error/timeout.
   */
  _safeExec(cmd, timeoutMs = 1200) {
    try {
      return execSync(cmd, {
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8'
      }).trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * Probe STUN UDP reachability on port 19302 with a strict timeout.
   */
  _probeStunUdp(host = 'stun.l.google.com', port = 19302, timeoutMs = 1200) {
    return new Promise((resolve) => {
      let resolved = false;
      const socket = dgram.createSocket('udp4');

      const cleanup = (result) => {
        if (resolved) return;
        resolved = true;
        try { socket.close(); } catch (_) { }
        resolve(result);
      };

      const timer = setTimeout(() => cleanup(false), timeoutMs);

      socket.on('error', () => cleanup(false));
      socket.on('message', () => {
        clearTimeout(timer);
        cleanup(true);
      });

      // Standard STUN Binding Request packet (20 bytes)
      // Magic Cookie: 0x2112A442
      const packet = Buffer.alloc(20);
      packet.writeUInt16BE(0x0001, 0); // Binding Request
      packet.writeUInt16BE(0x0000, 2); // Message Length: 0
      packet.writeUInt32BE(0x2112A442, 4); // Magic Cookie
      for (let i = 8; i < 20; i++) packet[i] = Math.floor(Math.random() * 256); // Transaction ID

      try {
        socket.send(packet, 0, packet.length, port, host, (err) => {
          if (err) {
            clearTimeout(timer);
            cleanup(false);
          }
        });
      } catch (_) {
        clearTimeout(timer);
        cleanup(false);
      }
    });
  }

  /**
   * Filter network interfaces to return the best physical LAN IP.
   * Excludes virtual bridges, Docker, VM, and VPN interfaces.
   */
  sanitizeLanInterfaces(interfaces = os.networkInterfaces()) {
    const virtualPattern = /^(docker|vboxnet|virbr|tailscale|wg|tun|tap|vEthernet|br-|veth|dummy)/i;
    const candidates = [];

    for (const [ifaceName, addrs] of Object.entries(interfaces)) {
      if (!Array.isArray(addrs)) continue;
      const isVirtual = virtualPattern.test(ifaceName);

      for (const addr of addrs) {
        if (addr.family !== 'IPv4' || addr.internal) continue;

        // Skip APIPA link-local (169.254.x.x)
        if (addr.address.startsWith('169.254.')) continue;

        candidates.push({
          interface: ifaceName,
          address: addr.address,
          netmask: addr.netmask,
          isVirtual,
          score: isVirtual ? 1 : (ifaceName.startsWith('w') || ifaceName.startsWith('e') ? 10 : 5)
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    const primary = candidates.find(c => !c.isVirtual) || candidates[0] || null;
    return {
      primaryIp: primary ? primary.address : '127.0.0.1',
      primaryInterface: primary ? primary.interface : 'lo',
      allCandidates: candidates
    };
  }

  /**
   * Probe 1: Input Subsystem & Kernel Permissions
   */
  checkInputSubsystem() {
    const platform = process.platform;
    const checks = [];

    if (platform === 'linux') {
      const uinputPath = '/dev/uinput';
      const exists = fs.existsSync(uinputPath);

      if (!exists) {
        const modLoaded = fs.existsSync('/sys/class/misc/uinput');
        checks.push({
          id: 'linux_uinput_node',
          subsystem: 'input',
          name: 'Linux uinput Kernel Device',
          status: 'fail',
          message: '/dev/uinput device node does not exist.',
          remediation: 'sudo modprobe uinput && echo "uinput" | sudo tee -a /etc/modules-load.d/uinput.conf',
          details: { exists: false, moduleLoaded: modLoaded }
        });
      } else {
        let isWritable = false;
        try {
          fs.accessSync(uinputPath, fs.constants.R_OK | fs.constants.W_OK);
          isWritable = true;
        } catch (_) {
          isWritable = false;
        }

        const userGroups = this._safeExec('groups');
        const inInputGroup = userGroups.split(/\s+/).includes('input');

        if (isWritable) {
          checks.push({
            id: 'linux_uinput_permissions',
            subsystem: 'input',
            name: 'Linux uinput Permissions',
            status: 'ok',
            message: '/dev/uinput is readable and writable by current user.',
            remediation: null,
            details: { path: uinputPath, writable: true, inInputGroup }
          });
        } else {
          checks.push({
            id: 'linux_uinput_permissions',
            subsystem: 'input',
            name: 'Linux uinput Permissions',
            status: 'fail',
            message: '/dev/uinput permission denied. Virtual gamepads and mouse injection will fail.',
            remediation: 'sudo usermod -aG input $USER && echo \'KERNEL=="uinput", MODE="0660", GROUP="input", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/99-uinput.rules && sudo udevadm control --reload-rules && sudo udevadm trigger',
            details: { path: uinputPath, writable: false, inInputGroup, userGroups }
          });
        }
      }
    } else if (platform === 'win32') {
      const scOutput = this._safeExec('sc query ViGEmBus');
      const isRunning = scOutput.includes('RUNNING');
      const isInstalled = scOutput.includes('ViGEmBus') || isRunning;

      if (isRunning) {
        checks.push({
          id: 'win_vigembus_service',
          subsystem: 'input',
          name: 'Windows ViGEmBus Virtual Gamepad Driver',
          status: 'ok',
          message: 'ViGEmBus service is running.',
          remediation: null,
          details: { installed: true, running: true }
        });
      } else if (isInstalled) {
        checks.push({
          id: 'win_vigembus_service',
          subsystem: 'input',
          name: 'Windows ViGEmBus Virtual Gamepad Driver',
          status: 'warn',
          message: 'ViGEmBus driver is installed but the service is stopped.',
          remediation: 'net start ViGEmBus',
          details: { installed: true, running: false }
        });
      } else {
        checks.push({
          id: 'win_vigembus_service',
          subsystem: 'input',
          name: 'Windows ViGEmBus Virtual Gamepad Driver',
          status: 'warn',
          message: 'ViGEmBus driver not detected. Gamepad emulation will be unavailable.',
          remediation: 'Download and install ViGEmBus from: https://github.com/nefarius/ViGEmBus/releases',
          details: { installed: false, running: false }
        });
      }
    } else if (platform === 'darwin') {
      // macOS synthetic input requires Accessibility TCC permissions
      checks.push({
        id: 'mac_accessibility_tcc',
        subsystem: 'input',
        name: 'macOS Accessibility Input Permissions',
        status: 'warn',
        message: 'Ensure Terminal or Nearcade has Accessibility permission in System Settings.',
        remediation: 'Open System Settings > Privacy & Security > Accessibility and enable Nearcade.',
        details: { platform: 'darwin' }
      });
    }

    return checks;
  }

  /**
   * Probe 2: Display Server, Compositor & Screen Capture Portal
   */
  checkDisplayAndCompositor() {
    const platform = process.platform;
    const checks = [];

    if (platform === 'linux') {
      const sessionType = (process.env.XDG_SESSION_TYPE || 'unknown').toLowerCase();
      const currentDesktop = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
      const isGamescope = currentDesktop.includes('gamescope') ||
        Boolean(process.env.SteamDeck === '1' || process.env.SteamGamepadUI === '1');

      let boardName = '';
      try {
        if (fs.existsSync('/sys/class/dmi/id/board_name')) {
          boardName = fs.readFileSync('/sys/class/dmi/id/board_name', 'utf8').trim();
        }
      } catch (_) { }
      const isSteamDeck = boardName === 'Jupiter' || boardName === 'Galileo';

      checks.push({
        id: 'linux_display_session',
        subsystem: 'display',
        name: 'Display Server Session',
        status: 'ok',
        message: `Display session: ${sessionType} (Desktop: ${currentDesktop || 'default'})`,
        remediation: null,
        details: { sessionType, currentDesktop, isGamescope, isSteamDeck, boardName }
      });

      if (sessionType === 'wayland') {
        const portalActive = this._safeExec('systemctl --user is-active xdg-desktop-portal 2>/dev/null') === 'active';
        if (portalActive) {
          checks.push({
            id: 'linux_wayland_portal',
            subsystem: 'display',
            name: 'XDG Desktop Portal Service',
            status: 'ok',
            message: 'xdg-desktop-portal service is active on user session.',
            remediation: null,
            details: { active: true }
          });
        } else {
          checks.push({
            id: 'linux_wayland_portal',
            subsystem: 'display',
            name: 'XDG Desktop Portal Service',
            status: 'warn',
            message: 'xdg-desktop-portal is inactive. WebRTC screen selection dialog may time out on Wayland.',
            remediation: 'systemctl --user start xdg-desktop-portal',
            details: { active: false }
          });
        }
      }
    } else if (platform === 'darwin') {
      checks.push({
        id: 'mac_screen_recording_tcc',
        subsystem: 'display',
        name: 'macOS Screen Recording Permissions',
        status: 'info',
        message: 'Screen Recording permission is required by macOS 10.15+ for video capture.',
        remediation: 'Open System Settings > Privacy & Security > Screen Recording and verify Nearcade is enabled.',
        details: { platform: 'darwin' }
      });
    }

    return checks;
  }

  /**
   * Probe 3: Audio Infrastructure & Loopback Routing
   */
  checkAudioSubsystem() {
    const platform = process.platform;
    const checks = [];

    if (platform === 'linux') {
      const pwCheck = this._safeExec('pw-cli info 0 2>/dev/null');
      const hasPipeWire = pwCheck.includes('PipeWire') || pwCheck.length > 0;

      const pactlInfo = this._safeExec('pactl info 2>/dev/null');
      const hasPulse = pactlInfo.includes('Server Name:') || pactlInfo.length > 0;

      const pactlBin = this._safeExec('which pactl 2>/dev/null');

      if (hasPipeWire || hasPulse) {
        checks.push({
          id: 'linux_audio_daemon',
          subsystem: 'audio',
          name: 'Linux Audio Daemon',
          status: 'ok',
          message: `Audio server active: ${hasPipeWire ? 'PipeWire' : 'PulseAudio'}.`,
          remediation: null,
          details: { hasPipeWire, hasPulse, pactlInstalled: Boolean(pactlBin) }
        });
      } else {
        checks.push({
          id: 'linux_audio_daemon',
          subsystem: 'audio',
          name: 'Linux Audio Daemon',
          status: 'warn',
          message: 'Neither PipeWire nor PulseAudio server could be contacted. Virtual audio routing may be silent.',
          remediation: 'systemctl --user start pipewire pipewire-pulse || systemctl --user start pulseaudio',
          details: { hasPipeWire: false, hasPulse: false }
        });
      }

      if (!pactlBin && !hasPipeWire) {
        checks.push({
          id: 'linux_pactl_cli',
          subsystem: 'audio',
          name: 'PulseAudio pactl Utility',
          status: 'warn',
          message: 'pactl command not found. PulseAudio loopback module management requires pulseaudio-utils.',
          remediation: 'sudo apt install pulseaudio-utils || sudo dnf install pulseaudio-utils || sudo pacman -S libpulse',
          details: { pactlInstalled: false }
        });
      }
    } else if (platform === 'darwin') {
      const hasBlackHole = fs.existsSync('/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver') ||
        fs.existsSync('/Library/Audio/Plug-Ins/HAL/BlackHole16ch.driver');

      if (hasBlackHole) {
        checks.push({
          id: 'mac_blackhole_driver',
          subsystem: 'audio',
          name: 'macOS Virtual Audio Loopback Driver',
          status: 'ok',
          message: 'BlackHole virtual audio loopback driver is installed.',
          remediation: null,
          details: { installed: true }
        });
      } else {
        checks.push({
          id: 'mac_blackhole_driver',
          subsystem: 'audio',
          name: 'macOS Virtual Audio Loopback Driver',
          status: 'warn',
          message: 'BlackHole audio driver not detected. Desktop audio capture requires a virtual loopback device on macOS.',
          remediation: 'brew install blackhole-2ch && sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod',
          details: { installed: false }
        });
      }
    } else if (platform === 'win32') {
      checks.push({
        id: 'win_audio_routing',
        subsystem: 'audio',
        name: 'Windows Audio Routing',
        status: 'ok',
        message: 'Windows audio capture supported via native loopback and getDisplayMedia audio tracks.',
        remediation: null,
        details: { platform: 'win32' }
      });
    }

    return checks;
  }

  /**
   * Probe 4: Hardware Video Encoders & GPU Permissions
   */
  checkHardwareVideoEncoding() {
    const platform = process.platform;
    const checks = [];

    if (platform === 'linux') {
      const renderNode = '/dev/dri/renderD128';
      const exists = fs.existsSync(renderNode);

      if (exists) {
        let rw = false;
        try {
          fs.accessSync(renderNode, fs.constants.R_OK | fs.constants.W_OK);
          rw = true;
        } catch (_) {
          rw = false;
        }

        const userGroups = this._safeExec('groups');
        const inRenderGroup = userGroups.split(/\s+/).some(g => g === 'render' || g === 'video');

        if (rw) {
          checks.push({
            id: 'linux_gpu_render_node',
            subsystem: 'encoder',
            name: 'GPU DRM Render Node (/dev/dri/renderD128)',
            status: 'ok',
            message: 'GPU render node is readable and writable by current user.',
            remediation: null,
            details: { path: renderNode, writable: true, inRenderGroup }
          });
        } else {
          checks.push({
            id: 'linux_gpu_render_node',
            subsystem: 'encoder',
            name: 'GPU DRM Render Node (/dev/dri/renderD128)',
            status: 'warn',
            message: '/dev/dri/renderD128 has restricted permissions. Hardware VA-API encoding will fall back to software CPU encoding.',
            remediation: 'sudo usermod -aG render,video $USER',
            details: { path: renderNode, writable: false, inRenderGroup }
          });
        }
      } else {
        checks.push({
          id: 'linux_gpu_render_node',
          subsystem: 'encoder',
          name: 'GPU DRM Render Node (/dev/dri/renderD128)',
          status: 'info',
          message: 'No GPU DRM render node found at /dev/dri/renderD128.',
          remediation: null,
          details: { exists: false }
        });
      }

      // Check VA-API slice encoding capabilities
      const vainfoOutput = this._safeExec('vainfo --display drm --device /dev/dri/renderD128 2>/dev/null || vainfo 2>/dev/null');
      if (vainfoOutput.includes('VAEntrypointEncSlice')) {
        checks.push({
          id: 'linux_vaapi_encoding',
          subsystem: 'encoder',
          name: 'VA-API Hardware Video Encoding',
          status: 'ok',
          message: 'Hardware encoder supports VAEntrypointEncSlice (hardware encoding ready).',
          remediation: null,
          details: { supportsEncSlice: true }
        });
      } else if (vainfoOutput.includes('VAProfile')) {
        checks.push({
          id: 'linux_vaapi_encoding',
          subsystem: 'encoder',
          name: 'VA-API Hardware Video Encoding',
          status: 'warn',
          message: 'VA-API profiles detected for decode, but VAEntrypointEncSlice was not found. Software CPU encode will be used.',
          remediation: 'Verify non-free media drivers are installed (e.g. intel-media-va-driver-non-free or mesa-va-drivers).',
          details: { supportsEncSlice: false }
        });
      }

      // Check NVIDIA driver state
      if (fs.existsSync('/dev/nvidia0')) {
        const hasUvm = fs.existsSync('/dev/nvidia-uvm');
        const isNouveau = fs.existsSync('/sys/module/nouveau');

        if (isNouveau) {
          checks.push({
            id: 'linux_nvidia_driver',
            subsystem: 'encoder',
            name: 'NVIDIA GPU Driver',
            status: 'warn',
            message: 'Open-source Nouveau driver detected. NVENC hardware encoding is not supported on Nouveau.',
            remediation: 'Install the official proprietary NVIDIA drivers for NVENC hardware acceleration.',
            details: { driver: 'nouveau', nvencSupported: false }
          });
        } else if (hasUvm) {
          checks.push({
            id: 'linux_nvidia_driver',
            subsystem: 'encoder',
            name: 'NVIDIA GPU Driver & UVM',
            status: 'ok',
            message: 'NVIDIA proprietary driver and /dev/nvidia-uvm detected (NVENC ready).',
            remediation: null,
            details: { driver: 'nvidia', uvm: true }
          });

          const userCfg = this._loadUserConfig();
          if (userCfg.zeroCopy === true) {
            checks.push({
              id: 'linux_nvidia_zerocopy',
              subsystem: 'encoder',
              name: 'NVIDIA Zero-Copy Capture Compatibility',
              status: 'warn',
              message: 'GPU-Direct Capture (zeroCopy) is enabled in settings while running on NVIDIA drivers. Chromium DMA-BUF zero-copy frequently fails on proprietary NVIDIA drivers, which can cause black screen captures.',
              remediation: 'Disable GPU-Direct Capture (zeroCopy) in Nearcade Settings for NVIDIA stability.',
              details: { driver: 'nvidia', zeroCopy: true }
            });
          }
        }
      }
    } else if (platform === 'win32') {
      // On Windows, inspect the GPU topology stored by electron-main after app.getGPUInfo().
      // This covers: dGPU-only, hybrid iGPU+dGPU, iGPU-only, APU (no discrete), and the
      // "none_active" failure state that triggers DXGI_ERROR_UNSUPPORTED on every capture path.
      checks.push(...this.checkWindowsGPUAdapter());
    } else {
      checks.push({
        id: 'platform_hw_encoding',
        subsystem: 'encoder',
        name: 'Hardware Encoding Support',
        status: 'ok',
        message: 'VideoToolbox hardware acceleration supported.',
        remediation: null,
        details: { platform }
      });
    }

    return checks;
  }

  /**
   * Probe 4b (Windows-only): GPU adapter classification for DXGI capture safety.
   *
   * Reads the GPU topology that electron-main populated via app.getGPUInfo() after
   * app.whenReady(). Results are stored in process.env.NEARCADE_GPU_INFO so this
   * server-side module can access them without Electron IPC.
   *
   * GPU classes and their implications:
   *   dgpu       → discrete-only, ideal (DXGI capture and hardware encoding optimal)
   *   hybrid     → iGPU + dGPU coexist; display may be on either adapter.
   *                Nearcade now leaves adapter selection to the OS so DXGI picks the
   *                correct one automatically (fixed in electron-main.js).
   *   igpu       → integrated-only, single adapter, no ambiguity — capture works.
   *   apu        → AMD/Intel CPU-integrated graphics, no discrete GPU partner.
   *                Capture works but encoding throughput is constrained; the CPU
   *                die also handles rendering load during gameplay.
   *   none_active → all GPU devices report Active: false (original hybrid-GPU bug
   *                 symptom). DXGI Desktop Duplication will fail on every attempt.
   */
  checkWindowsGPUAdapter() {
    const checks = [];

    const rawInfo = process.env.NEARCADE_GPU_INFO;
    if (!rawInfo) {
      // Electron hasn't finished app.whenReady() yet, or GPU info collection
      // was skipped (non-Electron mode). Surface as info, not an error.
      checks.push({
        id: 'win_gpu_adapter',
        subsystem: 'encoder',
        name: 'Windows GPU Adapter (DXGI Capture)',
        status: 'info',
        message: 'GPU adapter info not yet available. Run the System Doctor after the app has fully started.',
        remediation: null,
        details: { reason: 'NEARCADE_GPU_INFO not populated' }
      });
      return checks;
    }

    let info;
    try {
      info = JSON.parse(rawInfo);
    } catch (_) {
      checks.push({
        id: 'win_gpu_adapter',
        subsystem: 'encoder',
        name: 'Windows GPU Adapter (DXGI Capture)',
        status: 'warn',
        message: 'GPU info could not be parsed. DXGI capture state is unknown.',
        remediation: null,
        details: { raw: rawInfo }
      });
      return checks;
    }

    const { gpuClass, hasActive, isHybrid, isApu, devices } = info;

    // --- none_active: the original hybrid-GPU bug symptom ---
    if (gpuClass === 'none_active') {
      checks.push({
        id: 'win_gpu_adapter',
        subsystem: 'encoder',
        name: 'Windows GPU Adapter (DXGI Capture)',
        status: 'fail',
        message: 'All GPU devices report Active: false. DXGI Desktop Duplication will fail on every capture path (window, full-screen, WinRT, and legacy fallback all return DXGI_ERROR_UNSUPPORTED). This is likely caused by a corrupt GPU driver or an incompatible D3D adapter configuration.',
        remediation: 'Update or reinstall your GPU driver (Device Manager → Display Adapters → Update Driver). If the issue persists, run: dxdiag /t %TEMP%\\dxdiag.txt and inspect for adapter errors.',
        details: { gpuClass, devices }
      });
    } else if (gpuClass === 'apu') {
      // --- APU: integrated-only, no discrete GPU partner ---
      checks.push({
        id: 'win_gpu_adapter',
        subsystem: 'encoder',
        name: 'Windows GPU Adapter (DXGI Capture)',
        status: 'warn',
        message: 'APU detected — no discrete GPU present. Screen capture will work, but your CPU-integrated graphics engine handles both rendering and video encoding simultaneously. During gameplay this may cause encoder frame drops or latency spikes, especially at high resolutions.',
        remediation: 'Lower the stream resolution or bitrate in Nearcade settings. For sustained high-quality streaming, an external discrete GPU (NVIDIA/AMD dGPU) is recommended.',
        details: { gpuClass, devices }
      });
    } else if (gpuClass === 'hybrid') {
      // --- hybrid: iGPU + dGPU coexist ---
      checks.push({
        id: 'win_gpu_adapter',
        subsystem: 'encoder',
        name: 'Windows GPU Adapter (DXGI Capture)',
        status: 'ok',
        message: 'Hybrid GPU system detected (integrated + discrete). Nearcade leaves GPU adapter selection to the OS so DXGI Desktop Duplication automatically runs on the adapter that owns the display output. Capture and hardware encoding should work correctly.',
        remediation: null,
        details: { gpuClass, isHybrid: true, devices }
      });
    } else if (gpuClass === 'dgpu') {
      // --- dgpu: discrete-only, optimal ---
      checks.push({
        id: 'win_gpu_adapter',
        subsystem: 'encoder',
        name: 'Windows GPU Adapter (DXGI Capture)',
        status: 'ok',
        message: 'Discrete GPU detected. DXGI Desktop Duplication and hardware video encoding (NVENC / AMF) are fully supported.',
        remediation: null,
        details: { gpuClass, devices }
      });
    } else if (gpuClass === 'igpu') {
      // --- igpu: integrated-only (Intel/AMD without discrete partner) ---
      checks.push({
        id: 'win_gpu_adapter',
        subsystem: 'encoder',
        name: 'Windows GPU Adapter (DXGI Capture)',
        status: 'ok',
        message: 'Integrated GPU detected (single adapter). DXGI capture is unambiguous and should work correctly. Hardware encoding via Intel QuickSync or AMD VCE is available.',
        remediation: null,
        details: { gpuClass, devices }
      });
    } else {
      // --- fallback: unknown class but at least something is active ---
      checks.push({
        id: 'win_gpu_adapter',
        subsystem: 'encoder',
        name: 'Windows GPU Adapter (DXGI Capture)',
        status: hasActive ? 'ok' : 'warn',
        message: hasActive
          ? 'GPU adapter active. DXGI capture should work.'
          : 'GPU adapter state could not be determined.',
        remediation: hasActive ? null : 'Check GPU driver installation in Device Manager.',
        details: { gpuClass, devices }
      });
    }

    // Config validation checks
    const userCfg = this._loadUserConfig();
    if (isHybrid && userCfg.gpuPreference === 'integrated') {
      checks.push({
        id: 'win_hybrid_gpu_pref',
        subsystem: 'encoder',
        name: 'Hybrid GPU Preference Setting',
        status: 'warn',
        message: 'GPU Preference is set to "integrated" on a hybrid GPU system. If your display is driven by the discrete GPU, DXGI screen capture will fail with "Could not start video source" (DXGI_ERROR_UNSUPPORTED).',
        remediation: 'Set GPU Preference to "Auto (System Default)" in Nearcade Settings to let Windows choose the display adapter.',
        details: { gpuPreference: userCfg.gpuPreference, isHybrid: true }
      });
    }

    if (userCfg.zeroCopy === true) {
      checks.push({
        id: 'win_zerocopy_config',
        subsystem: 'encoder',
        name: 'Windows Zero-Copy Capture Compatibility',
        status: 'warn',
        message: 'GPU-Direct Capture (zeroCopy) is enabled in settings. On Windows, forcing zeroCopy can cause DXGI capture failures or black frames depending on driver support.',
        remediation: 'Disable GPU-Direct Capture (zeroCopy) in Nearcade Settings if you experience capture errors.',
        details: { zeroCopy: true }
      });
    }

    return checks;
  }

  /**
   * Probe 5: Network, LAN IP Sanitization & Port Reachability
   */
  async checkNetworkAndPorts() {
    const checks = [];
    const lanInfo = this.sanitizeLanInterfaces();

    if (lanInfo.primaryIp && lanInfo.primaryIp !== '127.0.0.1') {
      checks.push({
        id: 'net_lan_resolution',
        subsystem: 'network',
        name: 'Physical LAN Interface Resolution',
        status: 'ok',
        message: `Primary LAN IP: ${lanInfo.primaryIp} on interface ${lanInfo.primaryInterface}.`,
        remediation: null,
        details: lanInfo
      });
    } else {
      checks.push({
        id: 'net_lan_resolution',
        subsystem: 'network',
        name: 'Physical LAN Interface Resolution',
        status: 'warn',
        message: 'Could not resolve a non-virtual LAN interface. Remote viewers on LAN may not be able to connect.',
        remediation: 'Verify your Ethernet or Wi-Fi adapter is active and connected to a local subnet.',
        details: lanInfo
      });
    }

    // Local firewall detection
    if (process.platform === 'linux') {
      const ufwStatus = this._safeExec('ufw status 2>/dev/null');
      if (ufwStatus.includes('Status: active')) {
        const portOpen = ufwStatus.includes('3000');
        if (portOpen) {
          checks.push({
            id: 'linux_firewall_status',
            subsystem: 'network',
            name: 'Local Firewall Status (UFW)',
            status: 'ok',
            message: 'UFW is active and port 3000 is open.',
            remediation: null,
            details: { ufwActive: true, port3000Open: true }
          });
        } else {
          checks.push({
            id: 'linux_firewall_status',
            subsystem: 'network',
            name: 'Local Firewall Status (UFW)',
            status: 'warn',
            message: 'UFW is active, but port 3000 does not appear to be explicitly allowed.',
            remediation: 'sudo ufw allow 3000/tcp comment "Nearcade Web Server"',
            details: { ufwActive: true, port3000Open: false }
          });
        }
      }
    }

    // Outbound STUN UDP probe
    const stunOk = await this._probeStunUdp('stun.l.google.com', 19302, 1000);
    if (stunOk) {
      checks.push({
        id: 'net_stun_reachability',
        subsystem: 'network',
        name: 'Outbound STUN Connectivity (UDP 19302)',
        status: 'ok',
        message: 'Outbound STUN ping to stun.l.google.com:19302 succeeded.',
        remediation: null,
        details: { target: 'stun.l.google.com:19302', reachable: true }
      });
    } else {
      checks.push({
        id: 'net_stun_reachability',
        subsystem: 'network',
        name: 'Outbound STUN Connectivity (UDP 19302)',
        status: 'warn',
        message: 'Outbound UDP to STUN server timed out. Direct WebRTC P2P hole-punching may require TURN relay fallback.',
        remediation: 'Ensure UDP traffic on port 19302 is not blocked by your router or network firewall.',
        details: { target: 'stun.l.google.com:19302', reachable: false }
      });
    }

    return checks;
  }

  /**
   * Probe 6: Power & System Limits
   */
  checkSystemLimits() {
    const checks = [];

    if (process.platform === 'linux' || process.platform === 'darwin') {
      const ulimitVal = parseInt(this._safeExec('ulimit -n'), 10);
      if (!isNaN(ulimitVal)) {
        if (ulimitVal >= 2048) {
          checks.push({
            id: 'sys_file_descriptors',
            subsystem: 'system',
            name: 'Open File Descriptor Limit (nofile)',
            status: 'ok',
            message: `File descriptor limit: ${ulimitVal} (adequate for multi-viewer streaming).`,
            remediation: null,
            details: { limit: ulimitVal }
          });
        } else {
          checks.push({
            id: 'sys_file_descriptors',
            subsystem: 'system',
            name: 'Open File Descriptor Limit (nofile)',
            status: 'info',
            message: `File descriptor limit is ${ulimitVal}. Heavy multi-viewer streams may benefit from a limit of 4096.`,
            remediation: 'Increase limits in /etc/security/limits.conf: * soft nofile 4096',
            details: { limit: ulimitVal }
          });
        }
      }
    }

    return checks;
  }

  /**
   * Execute all system probes asynchronously and compile a complete diagnostic report.
   * Caches the report and ensures concurrent callers await the same in-flight audit.
   */
  async runAllChecks() {
    if (this._inFlightPromise) {
      return this._inFlightPromise;
    }

    this._inFlightPromise = (async () => {
      const startTime = Date.now();
      const allChecks = [];

      try {
        allChecks.push(...this.checkInputSubsystem());
        allChecks.push(...this.checkDisplayAndCompositor());
        allChecks.push(...this.checkAudioSubsystem());
        allChecks.push(...this.checkHardwareVideoEncoding());
        allChecks.push(...this.checkSystemLimits());

        const netChecks = await this.checkNetworkAndPorts();
        allChecks.push(...netChecks);
      } catch (err) {
        allChecks.push({
          id: 'doctor_internal_error',
          subsystem: 'system',
          name: 'Doctor Diagnostic Runner',
          status: 'warn',
          message: `Unexpected diagnostic failure: ${err.message}`,
          remediation: null,
          details: { error: err.stack }
        });
      }

      const failCount = allChecks.filter(c => c.status === 'fail').length;
      const warnCount = allChecks.filter(c => c.status === 'warn').length;
      const okCount = allChecks.filter(c => c.status === 'ok').length;

      const report = {
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        allPassed: failCount === 0 && warnCount === 0,
        hasFatal: failCount > 0,
        stats: { ok: okCount, warn: warnCount, fail: failCount, total: allChecks.length },
        checks: allChecks
      };

      this._cachedReport = report;
      this._inFlightPromise = null;
      return report;
    })();

    return this._inFlightPromise;
  }

  /**
   * Return cached report or a synchronous baseline placeholder.
   */
  getCachedReport() {
    if (this._cachedReport) {
      return this._cachedReport;
    }
    const lan = this.sanitizeLanInterfaces();
    return {
      timestamp: Date.now(),
      platform: process.platform,
      allPassed: true,
      hasFatal: false,
      stats: { ok: 0, warn: 0, fail: 0, total: 0 },
      primaryLanIp: lan.primaryIp,
      checks: []
    };
  }
}

const systemDoctor = new SystemDoctor();
module.exports = systemDoctor;
