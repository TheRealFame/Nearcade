'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Session & Navigation ──
  installDrivers: () => ipcRenderer.send('install-drivers'),
  backToDashboard: () => ipcRenderer.send('back-to-dashboard-from-host'),
  updateTrayIcon: (iconPath) => ipcRenderer.send('update-tray-icon', iconPath),
  joinSession: (url, meta, pin)   => ipcRenderer.invoke('join-session', { url, meta, pin }),
  pingSession: (url)              => ipcRenderer.invoke('ping-session', url),
  getServerInfo: ()               => ipcRenderer.invoke('get-server-info'),
  getVersion:    ()               => ipcRenderer.invoke('get-app-version'),
  getAccentColor: ()              => ipcRenderer.invoke('get-accent-color'),
  // FIX #7: openHost now accepts an optional version string ('new' | 'old')
  openHost:    (version)          => ipcRenderer.send('open-host', version || 'new'),
  openLog:     ()                 => ipcRenderer.send('open-log'),
  openInstallDir: ()              => ipcRenderer.send('open-dir'),
  readDoc:     (filename)         => ipcRenderer.invoke('read-doc', filename),
  getSettings:                    () => ipcRenderer.invoke('get-settings'),
  saveSettings:                   (s) => ipcRenderer.invoke('save-settings', s),
  // hydrateSettings: pushes localStorage-resident values into the config file
  // without overwriting keys the renderer doesn't manage. Bridges the split
  // between localStorage-only state and the persistent config file.
  hydrateSettings:                (patch) => ipcRenderer.invoke('hydrate-settings', patch),
  getConfigPath:                  () => ipcRenderer.invoke('get-config-path'),
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
  setSelectedSource: (id) => ipcRenderer.send('set-selected-source', id),

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
  continueBoot:                   () => ipcRenderer.send('continue-boot'),
  checkSystemSetup:               () => ipcRenderer.invoke('check-system-setup'),
  downloadTunnel:                 (name, url) => ipcRenderer.invoke('download-tunnel', { name, url }),
  checkTunnelInstalled:           (name) => ipcRenderer.invoke('check-tunnel-installed', name),
  checkHmBridge:                  () => ipcRenderer.invoke('check-hm-bridge'),
  openExternal:                   (url) => ipcRenderer.invoke('open-external', url),
  onSetupSuccess:                 (cb) => ipcRenderer.on('setup-success', () => cb()),
  onSetupFailed:                  (cb) => ipcRenderer.on('setup-failed', (_e, err) => cb(err)),

  // ── Event Listeners ──
  onServerLog:    (cb) => ipcRenderer.on('server-log',    (_e, v) => cb(v)),
  onViewerClosed: (cb) => ipcRenderer.on('viewer-closed', ()      => cb()),
  onUpdateReady:  (cb) => ipcRenderer.on('update-ready',  (_e, v) => cb(v)),
  onAppError:     (cb) => ipcRenderer.on('app-error',     (_e, msg, severity) => cb(msg, severity)),

  startNativeGamepadCapture: () => ipcRenderer.send('start-native-gamepad'),
  onNativeGamepadEvent: (cb) => ipcRenderer.on('native-gamepad-event', (_e, msg) => cb(msg)),
  sendNativeRumble: (padIndex, strong, weak, duration) => ipcRenderer.send('native-gamepad-rumble', { padIndex, strong, weak, duration }),

  isElectron: true,
});
