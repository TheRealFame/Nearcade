const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog, desktopCapturer } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { powerSaveBlocker } = require('electron');
powerSaveBlocker.start('prevent-app-suspension');

process.on('uncaughtException', (e) => console.error('\n[electron] ⚠ Uncaught Exception:', e));
process.on('unhandledRejection', (e) => console.error('\n[electron] ⚠ Unhandled Rejection:', e));

// ── RESTORE SMART WAYLAND & PIPEWIRE DETECTION ──
if (process.platform === 'linux' && (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')) {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'assets/NearsecTogether.png'));

// ── CRITICAL FIX: Bypass Chromium's requirement for physical clicks to start capture ──
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── GPU / Performance flags ───────────────────────────────────────────────────
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// ── Settings ──────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(app.getPath('userData'), 'NearsecTogether');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');
const DEFAULTS = { encoder: 'gpu', codec: 'h264', preset: 'fast', alwaysOnTop: false, w: 1280, h: 800 };

function loadSettings() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch { }
  return Object.assign({}, DEFAULTS);
}
function saveSettings(s) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error('saveSettings:', e.message); }
}
let settings = loadSettings();

// ── Start server in-process ───────────────────────────────────────────────────
let serverPort = null;
let serverCore = null;

function startServer() {
  return new Promise((resolve) => {
    const origLog = console.log;
    process.env.ELECTRON_MODE = '1';

    serverCore = require('./src/scripts/server.js');

    const _log = console.log.bind(console);
    console.log = function (...args) {
      _log(...args);
      const s = args.join(' ');
      const m = s.match(/Listening on port (\d+)/);
      if (m && !serverPort) {
        serverPort = parseInt(m[1]);
        console.log = _log;
        resolve(serverPort);
      }
    };
    setTimeout(() => { if (!serverPort) { serverPort = 3000; resolve(3000); } }, 6000);
  });
}

// ── Window ────────────────────────────────────────────────────────────────────
let win = null;
let tray = null;

async function createWindow() {
  const port = await startServer();
  console.log('[electron] server ready on port', port);

  win = new BrowserWindow({
    width: Math.max(settings.w, 600),
                          height: Math.max(settings.h, 500),
                          minWidth: 600,
                          minHeight: 500,
                          title: 'NearsecTogether',
                          icon: path.join(__dirname, 'assets/NearsecTogether.png'),
                          backgroundColor: '#111111',
                          alwaysOnTop: settings.alwaysOnTop,
                          show: false,
                          webPreferences: {
                            nodeIntegration: false,
                            contextIsolation: true,
                            preload: path.join(__dirname, 'electron-preload.js'),
                          },
                          autoHideMenuBar: true,
  });

  const isArcadeWorker = process.argv.includes('--arcade-worker');

  win.once('ready-to-show', () => {
    if (!isArcadeWorker) win.show();
  });

    const PAGES_DIR = path.join(__dirname, 'src', 'pages');

    if (isArcadeWorker) {
      function getCliArg(flag) {
        const idx = process.argv.indexOf(flag);
        return idx > -1 ? process.argv[idx + 1] : null;
      }
      const gameName = getCliArg('--game-name') || 'Arcade Game';
      const tunnelProv = getCliArg('--game-tunnel') || 'cloudflared';
      win.loadURL(`http://localhost:${port}/host?auto=1&title=${encodeURIComponent(gameName)}&tunnel=${encodeURIComponent(tunnelProv)}`);
    } else {
      win.loadFile(path.join(PAGES_DIR, 'dashboard.html'), { query: { port: String(port) } });
    }

    win.webContents.on('did-fail-load', (e, code, desc) => {
      console.error('[electron] failed to load:', code, desc);
      setTimeout(() => {
        if (isArcadeWorker) {
          win.loadURL(`http://localhost:${port}/host?auto=1`);
        } else {
          win.loadFile(path.join(PAGES_DIR, 'dashboard.html'), { query: { port: String(port) } });
        }
      }, 1000);
    });

    // ── ON-SCREEN BACK BUTTON INJECTION ──
    win.webContents.on('did-finish-load', () => {
      const currentURL = win.webContents.getURL();
      if (currentURL.includes('/host')) {
        win.webContents.executeJavaScript(`
        if (!document.getElementById('ns-dash-btn') && window.electronAPI) {
          const btn = document.createElement('button');
          btn.id = 'ns-dash-btn';
          btn.innerHTML = '← Dashboard';
          btn.style.cssText = 'position:fixed;bottom:24px;left:0;opacity:0.8;z-index:999999;padding:12px 20px;background:#141414;color:#aaa;border:1px solid #252525;border-left:none;border-radius:0 8px 8px 0;font-family:monospace;font-weight:bold;cursor:pointer;transition:all 0.2s;';
          btn.onmouseover = () => { btn.style.opacity = '1'; btn.style.color = '#c084fc'; btn.style.borderColor = '#c084fc'; };
          btn.onmouseleave = () => { btn.style.opacity = '0.8'; btn.style.color = '#aaa'; btn.style.borderColor = '#252525'; };
          btn.onclick = () => window.electronAPI.backToDashboard();
          document.body.appendChild(btn);
        }
        `);
      }
    });

    // ── Auto-Capture Handler (Grabs displays natively) ──
    win.webContents.session.setPermissionCheckHandler(() => true);
    win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      callback(true);
    });

    win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
        if (sources && sources.length > 0) {
          if (process.platform === 'win32') {
            callback({ video: sources[0], audio: 'loopback' });
          } else {
            callback({ video: sources[0] });
          }
        } else {
          callback({});
        }
      }).catch(err => { callback({}); });
    });

    win.on('resize', () => {
      const [w, h] = win.getSize();
      settings.w = w; settings.h = h;
      saveSettings(settings);
    });

    win.on('closed', () => { win = null; });

    const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets/NearsecTogether.png')).resize({ width: 22, height: 22 });
    tray = new Tray(trayIcon);
    tray.setToolTip('NearsecTogether');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Dashboard', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
                                               { type: 'separator' },
                                               { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } },
    ]));
    tray.on('click', () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });

    win.on('close', (e) => {
      if (!app.isQuiting) {
        e.preventDefault();
        win.hide();
        if (tray.displayBalloon) tray.displayBalloon({ title: 'NearsecTogether', content: 'Running in background.' });
      }
    });

    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_HIGH); } catch (e) {}

    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

    win.webContents.on('before-input-event', (event, input) => {
      if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
        if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
        else win.webContents.openDevTools({ mode: 'detach' });
      }
    });

    win.webContents.on('media-started-playing', () => { win.focus(); win.webContents.focus(); });

    ipcMain.handle('get-settings', () => settings);
    ipcMain.handle('save-settings', (_, s) => {
      settings = Object.assign(settings, s); saveSettings(settings);
      if (win) win.webContents.send('settings-updated', settings);
      return settings;
    });
    ipcMain.handle('toggle-always-on-top', () => {
      settings.alwaysOnTop = !settings.alwaysOnTop;
      if (win) win.setAlwaysOnTop(settings.alwaysOnTop);
      saveSettings(settings);
      return settings.alwaysOnTop;
    });
    ipcMain.handle('get-window-sources', async () => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
        return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), isScreen: s.id.startsWith('screen:') }));
      } catch (err) { return []; }
    });

    ipcMain.on('open-host', () => {
      if (win && !win.isDestroyed()) win.loadURL(`http://localhost:${serverPort}/host`);
    });

    ipcMain.on('back-to-dashboard', () => {
      if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'src', 'pages', 'dashboard.html'), { query: { port: String(serverPort) } });
    });
}

app.whenReady().then(() => {
  createWindow();

  const { globalShortcut } = require('electron');
  let isPanicActive = false;

  globalShortcut.register('CommandOrControl+Shift+Backspace', () => {
    isPanicActive = !isPanicActive;
    console.log(`\n[electron] PANIC MODE ${isPanicActive ? 'ACTIVATED (Inputs Frozen)' : 'DEACTIVATED (Inputs Resumed)'}`);
    if (serverCore && serverCore.toUinput) {
      serverCore.toUinput({ type: 'panic_toggle', enabled: isPanicActive });
    }
  });
});

app.on('will-quit', () => {
  if (app.isReady()) {
    const { globalShortcut } = require('electron');
    globalShortcut.unregisterAll();
  }
  if (serverCore && serverCore.cleanup) serverCore.cleanup(true);
});

app.on('window-all-closed', () => app.quit());

const isArcadeWorker = process.argv.includes('--arcade-worker');
const gotTheLock = isArcadeWorker ? true : app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });
}
