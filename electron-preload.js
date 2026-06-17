'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Session & Navigation ──
  installDrivers: () => ipcRenderer.send('install-drivers'),
  backToDashboard: () => ipcRenderer.send('back-to-dashboard-from-host'),
  joinSession: (url, meta)        => ipcRenderer.invoke('join-session', { url, meta }),
  pingSession: (url)              => ipcRenderer.invoke('ping-session', url),
  getServerInfo: ()               => ipcRenderer.invoke('get-server-info'),
  // FIX #7: openHost now accepts an optional version string ('new' | 'old')
  openHost:    (version)          => ipcRenderer.send('open-host', version || 'new'),
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
  onSetupSuccess:                 (cb) => ipcRenderer.on('setup-success', () => cb()),
  onSetupFailed:                  (cb) => ipcRenderer.on('setup-failed', (_e, err) => cb(err)),

  // ── Event Listeners ──
  onServerLog:    (cb) => ipcRenderer.on('server-log',    (_e, v) => cb(v)),
  onViewerClosed: (cb) => ipcRenderer.on('viewer-closed', ()      => cb()),
  onUpdateReady:  (cb) => ipcRenderer.on('update-ready',  (_e, v) => cb(v)),

  isElectron: true,
});
