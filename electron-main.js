const {
  app, BrowserWindow, ipcMain, shell, Tray, Menu,
  nativeImage, dialog, desktopCapturer, clipboard, systemPreferences,
} = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { powerSaveBlocker } = require('electron');
const { loadSettings, saveSettings, CONFIG_DIR, LOG_FILE } = require('./src/main/config');
const { registerIpcHandlers } = require('./src/main/ipc');

powerSaveBlocker.start('prevent-app-suspension');
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

const isArcadeWorker = process.argv.includes('--arcade-worker');
const isFFmpegExperimental = process.argv.includes('--ffmpeg-experimental');
let isWebCodecs = process.argv.includes('--webcodecs');
let isFFmpegCapture = process.argv.includes('--ffmpeg');
const gotTheLock = isArcadeWorker ? true : app.requestSingleInstanceLock();

function registerDiscordProtocol(clientId) {
  try {
    const protocol = 'discord-' + clientId;
    const home = os.homedir();
    const appsDir = path.join(home, '.local', 'share', 'applications');
    const desktopFile = path.join(appsDir, protocol + '.desktop');
    const mimeType = 'x-scheme-handler/' + protocol;

    const args = process.argv.slice(1).join(' ');
    const execLine = process.execPath + ' ' + args + ' %u';

    if (!fs.existsSync(appsDir)) fs.mkdirSync(appsDir, { recursive: true });

    fs.writeFileSync(desktopFile, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Nearcade (Discord Join)',
      'Exec=' + execLine,
      'MimeType=' + mimeType + ';',
      'StartupNotify=true',
      'Categories=Network;',
      'NoDisplay=true',
    ].join('\n'), 'utf-8');

    const mimeAppsPath = path.join(home, '.config', 'mimeapps.list');
    let mimeContent = '';
    if (fs.existsSync(mimeAppsPath)) {
      mimeContent = fs.readFileSync(mimeAppsPath, 'latin1')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter(l => {
          if (l.startsWith(mimeType + '=')) return false;
          if (l.includes(mimeType) && !l.startsWith('[') && !l.startsWith('#')) return false;
          return true;
        })
        .join('\n');
    }

    const marker = '[Default Applications]';
    const newLine = mimeType + '=' + protocol + '.desktop';
    if (mimeContent.includes(marker)) {
      mimeContent = mimeContent.replace(marker, marker + '\n' + newLine);
    } else {
      mimeContent += (mimeContent ? '\n' : '') + marker + '\n' + newLine + '\n';
    }

    fs.writeFileSync(mimeAppsPath, mimeContent, 'utf-8');
    console.log('[Discord] Protocol ' + protocol + ' registered (desktop file + mimeapps.list)');
    return true;
  } catch (e) {
    console.log('[Discord] Protocol registration failed:', e.message);
    return false;
  }
}

function getConfigDir() {
  const home = require('os').homedir();
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Nearcade');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Nearcade');
  return path.join(home, '.config', 'Nearcade');
}

var _discordClientId = null;
try {
  const _earlySettings = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(getConfigDir(), 'nearcade.config.json'), 'utf8')); } catch { return {}; }
  })();
  _discordClientId = _earlySettings.discordClientId || '1522864642953711776';
  if (!isArcadeWorker) registerDiscordProtocol(_discordClientId);
} catch (_) {}

try {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, `--- Nearcade Session Log (${new Date().toISOString()}) ---\n`);
} catch (e) { }

function appendLog(msg) {
  try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch (e) { }
}

const _nativeLog = console.log.bind(console);
const _nativeErr = console.error.bind(console);

console.log = function (...args) {
  _nativeLog(...args);
  const s = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(' ');
  appendLog(`[LOG] ${s}`);
};

console.error = function (...args) {
  _nativeErr(...args);
  const s = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(' ');
  appendLog(`[ERR] ${s}`);
};

try {
  if (fs.existsSync(CONFIG_DIR)) {
    const configFile = path.join(CONFIG_DIR, 'nearcade.config.json');
    if (fs.existsSync(configFile)) {
      const rawConfig = fs.readFileSync(configFile, 'utf8');
      const parsedConfig = JSON.parse(rawConfig);
      if (!process.argv.includes('--webcodecs') && !process.argv.includes('--ffmpeg') && !process.argv.includes('--webrtc')) {
        if (parsedConfig.captureMethod === 'webcodecs') isWebCodecs = true;
        if (parsedConfig.captureMethod === 'ffmpeg') isFFmpegCapture = true;
        console.log(`[Main] Loaded capture method from config: ${parsedConfig.captureMethod || 'native'}`);
      } else {
        console.log(`[Main] Capture method forced by CLI arguments.`);
      }
    }
  }
} catch (err) {
  console.warn('[Main] Could not read nearcade.config.json, falling back to defaults.');
}

if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

process.on('uncaughtException', (e) => console.error('\n[electron] ⚠ Uncaught Exception:', e));
process.on('unhandledRejection', (e) => {
  if (!e?.message?.includes('could not be cloned') && !e?.message?.includes('no video stream')) {
    console.error('\n[electron] ⚠ Unhandled Rejection:', e);
  }
});

function _electronSignalCleanup(signal) {
  console.log(`\n[electron] Received ${signal} — triggering cleanup...`);
  if (serverCore && serverCore.cleanup) {
    serverCore.cleanup(false);
  } else {
    const { execSync } = require('child_process');
    if (process.platform === 'linux') {
      try {
        execSync(
          "pactl list short modules | awk '/NearsecVirtual|NearsecVirtualCapture/{print $1}' | xargs -r pactl unload-module",
          { stdio: 'ignore' }
        );
      } catch (_) { }
    }
    process.exit(0);
  }
}
process.on('SIGINT', () => _electronSignalCleanup('SIGINT'));
process.on('SIGTERM', () => _electronSignalCleanup('SIGTERM'));

if (process.platform === 'linux') {
  try {
    const { execSync } = require('child_process');
    const moduleList = execSync('pactl list short modules 2>/dev/null', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const staleIds = [];
    for (const line of moduleList.split('\n')) {
      if (
        line.includes('NearsecVirtual') || line.includes('NearsecVirtualCapture') ||
        line.includes('NearsecAppAudio') || line.includes('NearsecAppMic')
      ) {
        const id = line.trim().split(/\s+/)[0];
        if (id && /^\d+$/.test(id)) staleIds.push(id);
      }
    }
    if (staleIds.length > 0) {
      console.log(`[electron] Startup purge: removing ${staleIds.length} stale PA module(s)`);
      for (const id of staleIds) {
        try { execSync(`pactl unload-module ${id}`, { stdio: 'ignore' }); } catch (_) { }
      }
    }
  } catch (_) { }
}

if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'assets/NearcadeLogo.png'));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (isArcadeWorker && process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
} else if (process.platform === 'linux') {
  const isGamescope = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('gamescope') ||
    (process.env.DESKTOP_SESSION || '').toLowerCase().includes('gamescope') ||
    process.env.SteamDeck === '1' ||
    process.env.SteamGamepadUI === '1';

  if (isGamescope) {
    app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,CanvasOopRasterization');
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
  } else {
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,WaylandWindowDecorations,VaapiVideoEncoder,VaapiVideoDecoder,CanvasOopRasterization');
  }
  app.commandLine.appendSwitch('enable-zero-copy');
}

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('force-high-performance-gpu');
app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
app.commandLine.appendSwitch('disable-rtc-smoothness-algorithm');
app.commandLine.appendSwitch('disable-hardware-cursors');

let serverPort = null;
let serverCore = null;

function startServer() {
  return new Promise((resolve) => {
    process.env.ELECTRON_MODE = '1';

    serverCore = require('./src/scripts/server.js');
    const _appLog = console.log.bind(console);

    const _serverLog = console.log;
    console.log = function (...args) {
      _serverLog(...args);
      const s = args.join(' ');
      const m = s.match(/Listening on port (\d+)/);
      if (m && !serverPort) {
        serverPort = parseInt(m[1]);
        console.log = _serverLog;
        resolve(serverPort);
      }
    };
    setTimeout(() => { if (!serverPort) { serverPort = 3000; console.log = _serverLog; resolve(3000); } }, 6000);
  });
}

let settings = loadSettings();
let win = null;
let tray = null;
const isGamescopeEnv = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('gamescope') ||
  (process.env.DESKTOP_SESSION || '').toLowerCase().includes('gamescope') ||
  process.env.SteamDeck === '1' ||
  process.env.SteamGamepadUI === '1';

async function createWindow() {
  settings = loadSettings();

  const port = await startServer();
  console.log('[electron] server ready on port', port);

  win = new BrowserWindow({
    width: Math.max(settings.w, 600),
    height: Math.max(settings.h, 500),
    minWidth: 600,
    minHeight: 500,
    title: 'Nearcade',
    icon: path.join(__dirname, 'assets/NearcadeLogo.png'),
    backgroundColor: '#111111',
    alwaysOnTop: settings.alwaysOnTop,
    show: isGamescopeEnv ? true : false,
    fullscreen: isGamescopeEnv ? true : false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron-preload.js'),
    },
    autoHideMenuBar: true,
  });

  if (!isGamescopeEnv) {
    win.once('ready-to-show', () => { if (!isArcadeWorker) win.show(); });
  }

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
    win.loadURL(`http://localhost:${port}/dashboard?port=${port}`);
  }

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    let prefix = '[FrontEnd]';
    if (level === 2) prefix = '[FrontEnd WARN]';
    if (level === 3) prefix = '[FrontEnd ERR]';
    appendLog(`${prefix} ${message}`);
  });

  win.webContents.on('did-fail-load', (e, code, desc) => {
    if (code === -3) return;
    console.error('[electron] failed to load:', code, desc);
    setTimeout(() => {
      if (isArcadeWorker) win.loadURL(`http://localhost:${port}/host?auto=1`);
      else win.loadURL(`http://localhost:${port}/dashboard?port=${port}`);
    }, 1000);
  });

  win.webContents.on('did-navigate', (e, url) => {
    if (url.includes('/host')) {
      win.webContents.insertCSS(`
        body { animation: nsFadeIn 1.5s ease both; }
        @keyframes nsFadeIn { from { opacity: 0; } to { opacity: 1; } }
      `);
    }
  });

  win.webContents.on('did-finish-load', () => {
    const currentURL = win.webContents.getURL();
    if (currentURL.includes('/old_host')) {
      win.webContents.executeJavaScript(`
      if (!document.getElementById('ns-dash-btn') && window.electronAPI) {
        const btn = document.createElement('button');
        btn.id = 'ns-dash-btn';
        btn.innerHTML = '← Dashboard';
        btn.style.cssText = 'position:fixed;bottom:24px;left:0;opacity:0.8;z-index:999999;padding:12px 20px;background:#141414;color:#aaa;border:1px solid #252525;border-left:none;border-radius:0 8px 8px 0;font-family:monospace;font-weight:bold;cursor:pointer;transition:all 0.2s;';
        btn.onmouseover = () => { btn.style.opacity='1'; btn.style.color='#c084fc'; btn.style.borderColor='#c084fc'; };
        btn.onmouseleave = () => { btn.style.opacity='0.8'; btn.style.color='#aaa'; btn.style.borderColor='#252525'; };
        btn.onclick = () => window.electronAPI.backToDashboard();
        document.body.appendChild(btn);
      }
      `);
    }
  });

  if (process.argv.includes('--show-warning')) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(`
        if (location.pathname.includes('/host') && !document.getElementById('ns-test-warning')) {
          const el = document.createElement('div');
          el.id = 'ns-test-warning';
          el.style.cssText = 'width:100%;background:#fbbf24;color:#000;text-align:center;padding:12px 16px;font-weight:600;font-size:14px;font-family:sans-serif;border-bottom:2px solid #f59e0b;flex-shrink:0;';
          el.textContent = '⚠ --show-warning was used — host warning banner is working. Restart without the flag to dismiss.';
          document.body.prepend(el);
          requestAnimationFrame(function() {
            var el2 = document.getElementById('ns-test-warning');
            var h = el2 ? el2.offsetHeight : 0;
            var c = document.querySelector('.app-layout') || document.querySelector('.app-shell') || document.body;
            if (c) c.style.height = 'calc(100vh - ' + h + 'px)';
          });
        }
      `);
    });
  }

  win.webContents.session.setPermissionCheckHandler(() => true);
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(true));

  const ctx = { win, tray, serverPort: port, settings, isWebCodecs, isFFmpegCapture };
  registerIpcHandlers(ctx);

  win.on('resize', () => {
    const [w, h] = win.getSize();
    settings.w = w; settings.h = h;
    saveSettings(settings);
  });

  win.on('closed', () => { win = null; ctx.win = null; });

  if (!isGamescopeEnv) {
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets/NearcadeLogo.png')).resize({ height: 22 });
    tray = new Tray(trayIcon);
    ctx.tray = tray;
    tray.setToolTip('Nearcade');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Dashboard', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } },
    ]));
    tray.on('click', () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });
  }

  win.on('close', (e) => {
    if (!app.isQuiting) {
      if (isGamescopeEnv || !settings.tray) {
        app.isQuiting = true;
        app.quit();
      } else {
        e.preventDefault();
        win.hide();
        if (tray && tray.displayBalloon) tray.displayBalloon({ title: 'Nearcade', content: 'Running in background.' });
      }
    }
  });

  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_HIGH); } catch (_) { }

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  win.webContents.on('before-input-event', (event, input) => {
    if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  win.webContents.on('media-started-playing', () => { win.focus(); win.webContents.focus(); });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.warn('[electron] Renderer process gone:', details.reason);
    if (details.reason !== 'clean-exit' && serverCore && serverCore.cleanup) {
      serverCore.cleanup(true);
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  const { dialog, globalShortcut } = require('electron');
  let isPanicActive = false;

  globalShortcut.register('CommandOrControl+Shift+Backspace', () => {
    isPanicActive = !isPanicActive;
    console.log(`\n[electron] PANIC MODE ${isPanicActive ? 'ACTIVATED' : 'DEACTIVATED'}`);
    if (serverCore && serverCore.toUinput) {
      serverCore.toUinput({ type: 'panic_toggle', enabled: isPanicActive });
    }
  });

  if (settings.checkForUpdates !== false) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on('update-downloaded', (info) => {
        console.log('[electron] Update downloaded:', info.version);
        if (win && !win.isDestroyed()) {
          win.webContents.send('update-ready', info.version);

          win.webContents.executeJavaScript(`
            if (!document.getElementById('ns-update-btn') && window.electronAPI) {
              const btn = document.createElement('button');
              btn.id = 'ns-update-btn';
              btn.innerHTML = 'Update Required (' + '${info.version}' + ')';
              btn.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:999999;padding:12px 24px;background:#d32f2f;color:#fff;border:none;border-radius:8px;font-family:monospace;font-weight:bold;cursor:pointer;box-shadow:0 8px 16px rgba(0,0,0,0.5);';
              btn.onclick = () => window.electronAPI.installUpdate();
              document.body.appendChild(btn);
            }
          `).catch(() => {});
        }
      });

      autoUpdater.checkForUpdatesAndNotify().catch(e => console.error('[electron] Auto-update check failed:', e));
    } catch (e) {
      console.error('[electron] autoUpdater error:', e);
    }
  }
});

app.on('will-quit', () => {
  if (app.isReady()) {
    const { globalShortcut } = require('electron');
    globalShortcut.unregisterAll();
  }
  if (serverCore && serverCore.cleanup) serverCore.cleanup(true);
});

app.on('before-quit', () => {
  if (serverCore && serverCore.cleanup) serverCore.cleanup(true);
});

app.on('window-all-closed', () => app.quit());

app.on('second-instance', (_event, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  if (!win || !serverPort) return;
  const joinArg = argv.find(a => a.startsWith('discord-'));
  if (!joinArg) return;

  try {
    const url = new URL(joinArg);
    const secret = url.searchParams.get('secret');
    if (!secret || secret === 'none') return;

    console.log('[Discord] Ask-to-Join received, secret:', secret);

    const isUrl = secret.startsWith('http://') || secret.startsWith('https://');
    const viewerUrl = isUrl
      ? `http://localhost:${serverPort}/?client=1&compat=1&host=${encodeURIComponent(secret)}`
      : `http://localhost:${serverPort}/?client=1&compat=1&host=${encodeURIComponent('p2p://' + secret)}`;

    win.loadURL(viewerUrl);
  } catch (e) {
    console.error('[Discord] Failed to parse join URI:', e.message);
  }
});
