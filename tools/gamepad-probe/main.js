'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// Forward renderer console.log to the terminal so the probe's compact log
// stream is visible to whoever runs the app.
app.commandLine.appendSwitch('enable-logging');

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#131316',
    autoHideMenuBar: true,
    title: 'Nearcade Gamepad Probe',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'www', 'index.html'));
}

function resolveConfigPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'config', 'controllers.json');
  }
  return path.join(__dirname, '..', '..', 'config', 'controllers.json');
}

ipcMain.handle('probe:load-config', () => {
  try {
    const p = resolveConfigPath();
    const raw = fs.readFileSync(p, 'utf8');
    const db = JSON.parse(raw);
    return {
      ok: true,
      path: p,
      count: Array.isArray(db) ? db.length : Object.keys(db).length,
      db
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('probe:save-log', async (_evt, defaultName, content) => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showSaveDialog(win, {
    title: 'Save Nearcade Gamepad Probe log',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'Text Log', extensions: ['txt'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('probe:copy-text', (_evt, text) => {
  try {
    clipboard.writeText(String(text || ''));
    return true;
  } catch (e) {
    return false;
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
