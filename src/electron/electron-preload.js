'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Session & Navigation ──
  installDrivers: () => ipcRenderer.send('install-drivers'),
  backToDashboard: (tab) => ipcRenderer.send('back-to-dashboard-from-host', tab),
  updateTrayIcon: (iconPath) => ipcRenderer.send('update-tray-icon', iconPath),
  joinSession: (url, meta, pin)   => ipcRenderer.invoke('join-session', { url, meta, pin }),
  pingSession: (url)              => ipcRenderer.invoke('ping-session', url),
  getServerInfo: ()               => ipcRenderer.invoke('get-server-info'),
  getVersion:    ()               => ipcRenderer.invoke('get-app-version'),
  getAccentColor: ()              => ipcRenderer.invoke('get-accent-color'),
  getNativeTheme: ()              => ipcRenderer.invoke('get-native-theme'),
  openHost:    (version)          => ipcRenderer.send('open-host', version || 'new'),
  openLog:     ()                 => ipcRenderer.send('open-log'),
  openInstallDir: ()              => ipcRenderer.send('open-dir'),
  checkElevation: ()              => ipcRenderer.invoke('check-elevation'),
  elevateApp:     ()              => ipcRenderer.invoke('elevate-app'),
  readDoc:     (filename)         => ipcRenderer.invoke('read-doc', filename),
  getSettings:                    () => ipcRenderer.invoke('get-settings'),
  saveSettings:                   (s) => ipcRenderer.invoke('save-settings', s),
  saveSettingsSync:               (s) => ipcRenderer.invoke('save-settings-sync', s),
  // hydrateSettings: pushes localStorage-resident values into the config file
  // without overwriting keys the renderer doesn't manage. Bridges the split
  // between localStorage-only state and the persistent config file.
  hydrateSettings:                (patch) => ipcRenderer.invoke('hydrate-settings', patch),
  getConfigPath:                  () => ipcRenderer.invoke('get-config-path'),
  saveEnv:                        (key, val) => ipcRenderer.invoke('save-env', key, val),
  // Display server detection for capture pipeline routing
  getDisplayServer:               () => ipcRenderer.invoke('get-display-server'),
  getGpuInfo:                     () => ipcRenderer.invoke('get-gpu-info'),
  restartApp:                     () => ipcRenderer.invoke('restart-app'),
  getDeviceStatus:                () => ipcRenderer.invoke('get-device-status'),
  // VPS SFU config — dedicated handlers so the master key is handled explicitly
  getVpsConfig:   ()    => ipcRenderer.invoke('get-vps-config'),
  saveVpsConfig:  (cfg) => ipcRenderer.invoke('save-vps-config', cfg),
  getControllers: ()    => ipcRenderer.invoke('get-controllers'),
  toggleAlwaysOnTop:              () => ipcRenderer.invoke('toggle-always-on-top'),
  onSettingsUpdated:              (cb) => ipcRenderer.on('settings-updated', (_, s) => cb(s)),

  // FIX #22: Secure clipboard bridge — host → viewer text sync
  // Renderer asks main to read/write the real OS clipboard so the page
  // doesn't need the Clipboard API permission itself.
  // FIX #22: Secure clipboard bridge — host → viewer text sync
  // Renderer asks main to read/write the real OS clipboard so the page
  // doesn't need the Clipboard API permission itself.
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
  clipboardRead:  ()     => ipcRenderer.invoke('clipboard-read'),

  // ── CRITICAL FIX: Secure IPC routing for screen capture ──
  getWindowSources: () => ipcRenderer.invoke('get-window-sources'),
  setSelectedSource: (id, name) => ipcRenderer.invoke('set-selected-source', id, name),
  checkGstreamerDeps: () => ipcRenderer.invoke('check-gstreamer-deps'),
  getCursorPos: () => ipcRenderer.invoke('get-cursor-pos'),
  syncCursorPos: (x, y) => ipcRenderer.send('sync-cursor-pos', { x, y }),

  // ── Window Chrome & Discord ──
  minimize:                       () => ipcRenderer.send('window-minimize'),
  maximize:                       () => ipcRenderer.send('window-maximize'),
  close:                          () => ipcRenderer.send('window-close'),
  closeApp:                       () => ipcRenderer.send('app-quit'),
  fullscreen:                     () => ipcRenderer.send('window-fullscreen'),
  discordSetActivity: (activity)  => ipcRenderer.send('discord-set-activity', activity),
  discordClear:                   () => ipcRenderer.send('discord-clear'),
  installUpdate:                  () => ipcRenderer.send('install-update'),

  // ── Setup Hooks ──
  runSetup:                       () => ipcRenderer.send('run-setup'),
  runVbCableSetup:                () => ipcRenderer.send('run-vbcable-setup'),
  runAdvancedLinuxSetup:          () => ipcRenderer.send('run-advanced-linux-setup'),
  continueBoot:                   () => ipcRenderer.send('continue-boot'),
  checkSystemSetup:               () => ipcRenderer.invoke('check-system-setup'),
  downloadTunnel:                 (name, url) => ipcRenderer.invoke('download-tunnel', { name, url }),
  checkTunnelInstalled:           (name) => ipcRenderer.invoke('check-tunnel-installed', name),
  checkHmBridge:                  () => ipcRenderer.invoke('check-hm-bridge'),
  startWivrn:                     () => ipcRenderer.invoke('start-wivrn'),
  openExternal:                   (url) => ipcRenderer.invoke('open-external', url),
  onSetupSuccess:                 (cb) => ipcRenderer.on('setup-success', () => cb()),
  onSetupFailed:                  (cb) => ipcRenderer.on('setup-failed', (_e, err) => cb(err)),

  // ── DRM/KMS Native Capture (Wayland silent auto-capture) ──
  drmCaptureStart: () => ipcRenderer.invoke('drm-capture-start'),
  drmCaptureGetFrame: () => ipcRenderer.invoke('drm-capture-get-frame'),
  drmCaptureStop: () => ipcRenderer.invoke('drm-capture-stop'),

  // ── Event Listeners ──
  onServerLog:    (cb) => ipcRenderer.on('server-log',    (_e, v) => cb(v)),
  onViewerClosed: (cb) => ipcRenderer.on('viewer-closed', ()      => cb()),
  onUpdateReady:  (cb) => ipcRenderer.on('update-ready',  (_e, v) => cb(v)),
  onAppError:     (cb) => ipcRenderer.on('app-error',     (_e, msg, severity) => cb(msg, severity)),
  arcadeExit:     ()    => ipcRenderer.invoke('arcade-exit'),

  startNativeGamepadCapture: () => ipcRenderer.send('start-native-gamepad'),
  onNativeGamepadEvent: (cb) => ipcRenderer.on('native-gamepad-event', (_e, msg) => cb(msg)),
  sendNativeRumble: (padIndex, strong, weak, duration) => ipcRenderer.send('native-gamepad-rumble', { padIndex, strong, weak, duration }),

  // #1: Direct input forwarding — bypasses local WS relay
  forwardInput: (msg) => ipcRenderer.send('forward-input', msg),
  forwardInputBinary: (viewerId, buf) => ipcRenderer.send('forward-input-binary', viewerId, buf),

  // Diagnostics: save log to OS temp directory
  saveTempLog: (text, filename) => ipcRenderer.invoke('save-temp-log', text, filename),

  // ── NDI egress (broadcast window for OBS via LAN) ──
  ndiStart: (cfg) => ipcRenderer.send('ndi:start', cfg),
  ndiFrame: (meta, buf) => ipcRenderer.send('ndi:frame', meta, buf),
  ndiStop: () => ipcRenderer.send('ndi:stop'),
  onNdiStatus: (cb) => ipcRenderer.on('ndi-status', (_e, s) => cb(s)),

  // ── Spout2 egress (Windows only) ──
  spoutStart: (cfg) => ipcRenderer.send('spout:start', cfg),
  spoutFrame: (meta, buf) => ipcRenderer.send('spout:frame', meta, buf),
  spoutStop: () => ipcRenderer.send('spout:stop'),
  onSpoutStatus: (cb) => ipcRenderer.on('spout-status', (_e, s) => cb(s)),

  refocusWindow: () => ipcRenderer.send('refocus-gamescope-window'),
  onHardwareGamepad: (cb) => ipcRenderer.on('hardware-gamepad-event', (_e, data) => cb(data)),

  isElectron: true,
  isHandheld: (() => {
    const explicitCli = process.argv.includes('-handheld') || process.argv.includes('--handheld') || process.argv.includes('-tv') || process.argv.includes('--tv');
    if (explicitCli) return true;
    try {
      const os = require('os');
      const path = require('path');
      const fs = require('fs');
      const home = os.homedir();
      let configDir;
      if (process.platform === 'win32') configDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Nearcade');
      else if (process.platform === 'darwin') configDir = path.join(home, 'Library', 'Application Support', 'Nearcade');
      else configDir = path.join(home, '.config', 'Nearcade');
      const cfgPath = path.join(configDir, 'nearcade.config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (cfg && cfg.layoutMode) {
          if (cfg.layoutMode === 'default' || cfg.layoutMode === 'portrait') return false;
          if (cfg.layoutMode === 'handheld') return true;
        }
      }
    } catch (_) {}
    return (
      (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('gamescope') ||
      (process.env.DESKTOP_SESSION || '').toLowerCase().includes('gamescope') ||
      process.env.SteamDeck === '1' ||
      process.env.SteamGamepadUI === '1' ||
      process.env.USER === 'deck' ||
      (typeof location !== 'undefined' && location.search.includes('handheld=1')) ||
      (process.platform === 'linux' && (() => {
        try {
          const os = require('os');
          if (os && os.hostname && os.hostname() === 'steamdeck') return true;
        } catch (_) {}
        try {
          const fs = require('fs');
          const board = fs.existsSync('/sys/class/dmi/id/board_name') ? fs.readFileSync('/sys/class/dmi/id/board_name', 'utf8').trim() : '';
          const vendor = fs.existsSync('/sys/class/dmi/id/sys_vendor') ? fs.readFileSync('/sys/class/dmi/id/sys_vendor', 'utf8').trim() : '';
          return board === 'Jupiter' || board === 'Galileo' || vendor === 'Valve';
        } catch (_) {}
        return false;
      })())
    );
  })(),
  isPortrait: (() => {
    const explicitCli = process.argv.includes('-portrait') || process.argv.includes('--portrait');
    if (explicitCli) return true;
    try {
      const os = require('os');
      const path = require('path');
      const fs = require('fs');
      const home = os.homedir();
      let configDir;
      if (process.platform === 'win32') configDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Nearcade');
      else if (process.platform === 'darwin') configDir = path.join(home, 'Library', 'Application Support', 'Nearcade');
      else configDir = path.join(home, '.config', 'Nearcade');
      const cfgPath = path.join(configDir, 'nearcade.config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (cfg && cfg.layoutMode) {
          if (cfg.layoutMode === 'portrait') return true;
          if (cfg.layoutMode === 'default' || cfg.layoutMode === 'handheld') return false;
        }
      }
    } catch (_) {}
    return false;
  })(),
});

ipcRenderer.on('hardware-gamepad-event', (_e, data) => {
  try {
    window.postMessage({ type: 'NEARCADE_HARDWARE_GAMEPAD', data }, '*');
  } catch (_) {}
});
