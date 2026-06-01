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
