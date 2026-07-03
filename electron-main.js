const {
  app, BrowserWindow, ipcMain, shell, Tray, Menu,
  nativeImage, dialog, desktopCapturer, clipboard,
} = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { powerSaveBlocker } = require('electron');
powerSaveBlocker.start('prevent-app-suspension');
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';
// ── CRITICAL FIX: Detect Arcade Worker immediately ──
const isArcadeWorker = process.argv.includes('--arcade-worker');
const isFFmpegExperimental = process.argv.includes('--ffmpeg-experimental');
let isWebCodecs = process.argv.includes('--webcodecs');
let isFFmpegCapture = process.argv.includes('--ffmpeg');
const gotTheLock = isArcadeWorker ? true : app.requestSingleInstanceLock();


// ── CONFIGURATION DIR UTILS ──
function _getConfigDir() {
  const home = require('os').homedir();
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'NearsecTogether');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'NearsecTogether');
  return path.join(home, '.config', 'NearsecTogether');
}
const CONFIG_DIR = _getConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'nearsectogether.config.json');
const BUNDLED_CONTROLLERS = path.join(__dirname, 'config', 'controllers.json');
const USER_CONTROLLERS = path.join(CONFIG_DIR, 'controllers.json');

// ── SESSION FILE LOGGER ──
const LOG_FILE = path.join(CONFIG_DIR, 'latest.log');
try { 
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, `--- Nearsec Session Log (${new Date().toISOString()}) ---\n`); 
} catch (e) {}

function appendLog(msg) {
  try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch (e) {}
}

const _nativeLog = console.log.bind(console);
const _nativeErr = console.error.bind(console);

console.log = function(...args) {
  _nativeLog(...args);
  const s = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch(_) { return String(a); }
  }).join(' ');
  appendLog(`[LOG] ${s}`);
};

console.error = function(...args) {
  _nativeErr(...args);
  const s = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch(_) { return String(a); }
  }).join(' ');
  appendLog(`[ERR] ${s}`);
};

// ── AUTOMATIC CONFIGURATION OVERRIDES ──
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const rawConfig = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsedConfig = JSON.parse(rawConfig);

    // Config applies ONLY if CLI args aren't forcing a specific mode
    if (!process.argv.includes('--webcodecs') && !process.argv.includes('--ffmpeg') && !process.argv.includes('--webrtc')) {
      if (parsedConfig.captureMethod === 'webcodecs') isWebCodecs = true;
      if (parsedConfig.captureMethod === 'ffmpeg') isFFmpegCapture = true;
      console.log(`[Main] Loaded capture method from config: ${parsedConfig.captureMethod || 'native'}`);
    } else {
      console.log(`[Main] Capture method forced by CLI arguments.`);
    }
  }
} catch (err) {
  console.warn('[Main] Could not read nearsectogether.config.json, falling back to defaults.');
}
// ──────────────────────────────────────────

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

// ── REQ 3: Robust signal handlers ────────────────────────────────────────────
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

// ── REQ 3: Startup purge ─────────────────────────────────────────────────────
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

if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'assets/NearsecTogetherLogo.png'));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── WAYLAND & HARDWARE ENCODING OPTIMIZATIONS ──
if (isArcadeWorker && process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
} else if (process.platform === 'linux') {
  const isGamescope = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('gamescope') ||
    (process.env.DESKTOP_SESSION || '').toLowerCase().includes('gamescope');

  if (isGamescope) {
    // Force X11/XWayland under Gamescope to prevent Electron crashes with native Wayland
    app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,VaapiVideoEncoder,VaapiVideoDecoder,CanvasOopRasterization');
  } else {
    // Force native Wayland with decorations on other Linux DEs
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,WaylandWindowDecorations,VaapiVideoEncoder,VaapiVideoDecoder,CanvasOopRasterization');
  }

  // Unlock zero-copy DMA-BUF memory passing
  app.commandLine.appendSwitch('enable-zero-copy');
}

// ── GLOBAL PERFORMANCE FLAGS ──
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('force-high-performance-gpu');
app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
app.commandLine.appendSwitch('disable-rtc-smoothness-algorithm');
app.commandLine.appendSwitch('disable-hardware-cursors');
// ── FIX: Unified config path ─────────────────────────────────────────────────
// BEFORE this fix, electron-main used app.getPath('userData') which on Linux
// resolves to ~/.config/NearsecTogether — so the nested join produced
// ~/.config/NearsecTogether/NearsecTogether/ (a DIFFERENT directory than server.js).
// server.js uses ~/.config/NearsecTogether/ directly.  Now both agree on one path.
// Duplicate definitions removed.


const DEFAULT_CONTROLLERS = {
  'Xbox 360 Controller (XInput STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 }, rt: { type: 'btn', idx: 7 }, rsx: 2, rsy: 3
  },
  'Xbox Wireless Controller (STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 }, rt: { type: 'btn', idx: 7 }, rsx: 2, rsy: 3
  },
  'DualSense Wireless Controller (STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 }, rt: { type: 'btn', idx: 7 }, rsx: 2, rsy: 3
  },
  'Wireless Controller (STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 }, rt: { type: 'btn', idx: 7 }, rsx: 2, rsy: 3
  },
};
const DEFAULTS = {
  // Window
  encoder: 'gpu', codec: 'h264', preset: 'fast',
  alwaysOnTop: false, w: 1280, h: 800,
  // App behaviour
  tray: true, rumble: true, discordRPC: true,
  hwDecode: true, fpsUnlock: false, vsyncOff: false, zeroCopy: false,
  // Streaming
  hidePreviewOnStart: false, captureMic: false,
  // Experimental
  ffmpegExperimental: false,
  // Identity
  hostName: '',
  // Controller
  forceXboxOne: false, enableDualShock: false, enableMotion: false,
  defaultInputMode: 'gamepad', hybridInput: false,
  // Tunnels
  tunnelProvider: null, neverAsk: false, vpsHost: '',
  // VPS SFU routing
  vpsEnabled: false, vpsUrl: '', vpsMasterKey: '',
  // Auto-hosts
  autoHosts: [],
  // Discord RPC
  discordClientId: '1241907722765324391', // Fallback default ID
  // First run
  firstRunComplete: false,
};

function loadSettings() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
    // Config missing (first run or deleted) — write defaults to disk immediately
    // so the file always exists after launch and settings persist correctly.
    const seed = Object.assign({}, DEFAULTS);
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(seed, null, 2)); } catch (_) { }
    return seed;
  } catch (_) { }
  return Object.assign({}, DEFAULTS);
}

function loadControllers() {
  let bundled = {};
  let user = {};
  try {
    if (fs.existsSync(BUNDLED_CONTROLLERS)) {
      bundled = JSON.parse(fs.readFileSync(BUNDLED_CONTROLLERS, 'utf8'));
    }
  } catch (_) { }
  try {
    if (!fs.existsSync(USER_CONTROLLERS)) {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
      const seed = Object.keys(bundled).length ? bundled : DEFAULT_CONTROLLERS;
      fs.writeFileSync(USER_CONTROLLERS, JSON.stringify(seed, null, 2));
      return seed;
    }
    user = JSON.parse(fs.readFileSync(USER_CONTROLLERS, 'utf8'));
  } catch (_) {
    user = {};
  }
  return Object.assign({}, DEFAULT_CONTROLLERS, bundled, user);
}

function saveSettings(s) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error('saveSettings:', e.message); }
}

let settings = loadSettings();

let serverPort = null;
let serverCore = null;

function startServer() {
  return new Promise((resolve) => {
    process.env.ELECTRON_MODE = '1';

    serverCore = require('./src/scripts/server.js');
    const _appLog = console.log.bind(console);
    
    // We must safely wrap whatever console.log server.js just created, 
    // and restore IT, not the original Node.js one.
    const _serverLog = console.log; 
    console.log = function (...args) {
      _serverLog(...args);
      const s = args.join(' ');
      const m = s.match(/Listening on port (\d+)/);
      if (m && !serverPort) {
        serverPort = parseInt(m[1]);
        console.log = _serverLog; // Restore the server.js scrubber
        resolve(serverPort);
      }
    };
    setTimeout(() => { if (!serverPort) { serverPort = 3000; console.log = _serverLog; resolve(3000); } }, 6000);
  });
}

let win = null;
let tray = null;
const isGamescopeEnv = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('gamescope') ||
  (process.env.DESKTOP_SESSION || '').toLowerCase().includes('gamescope');

async function createWindow() {
  const port = await startServer();
  console.log('[electron] server ready on port', port);

  win = new BrowserWindow({
    width: Math.max(settings.w, 600),
    height: Math.max(settings.h, 500),
    minWidth: 600,
    minHeight: 500,
    title: 'NearsecTogether',
    icon: path.join(__dirname, 'assets/NearsecTogetherLogo.png'),
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

  // Intercept frontend logs to save them to the session file (but DO NOT spam terminal)
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

  // ── Dashboard Button Injection ──
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

  win.webContents.session.setPermissionCheckHandler(() => true);
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(true));

  // ── UNIFIED CAPTURE HANDLER (Fixes PipeWire Deadlocks & UI Freezes) ──
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
      if (sources && sources.length > 0) {
        let pick = sources[0];
        if (_pendingCaptureSourceId) {
          const match = sources.find(s => s.id === _pendingCaptureSourceId);
          if (match) pick = match;
        }
        _pendingCaptureSourceId = null;
        if (process.platform === 'win32') callback({ video: pick, audio: 'loopback' });
        else callback({ video: pick });
      } else {
        console.log('[electron] Capture blocked or no sources found. Cancelling.');
        callback(); // Empty callback safely aborts without crashing PipeWire

        // ANTI-FREEZE INJECTION: Forcefully unlock the frontend UI buttons
        if (win && !win.isDestroyed()) {
          win.webContents.executeJavaScript(`
          if (typeof _elDisabled === 'function') {
            _elDisabled('btnStart', false);
            _elDisabled('btnSwitch', false);
            _elDisabled('btnStop', true);
            if (typeof setCapDot === 'function') setCapDot('');
          }
          `).catch(() => { });
        }
      }
    }).catch(err => {
      console.error('[electron] Capturer error:', err);
      callback(); // Empty callback safely aborts without crashing PipeWire

      // ANTI-FREEZE INJECTION: Forcefully unlock the frontend UI buttons
      if (win && !win.isDestroyed()) {
        win.webContents.executeJavaScript(`
        if (typeof _elDisabled === 'function') {
          _elDisabled('btnStart', false);
          _elDisabled('btnSwitch', false);
          _elDisabled('btnStop', true);
          if (typeof setCapDot === 'function') setCapDot('');
        }
        `).catch(() => { });
      }
    });
  });

  win.on('resize', () => {
    const [w, h] = win.getSize();
    settings.w = w; settings.h = h;
    saveSettings(settings);
  });
  win.on('closed', () => { win = null; });

  // ── Tray ──
  if (!isGamescopeEnv) {    // We only specify height so Electron maintains the natural aspect ratio of the logo
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets/NearsecTogetherLogo.png')).resize({ height: 22 });
    tray = new Tray(trayIcon);
    tray.setToolTip('NearsecTogether');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Dashboard', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } },
    ]));
    tray.on('click', () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });
  }

  win.on('close', (e) => {
    if (!app.isQuiting) {
      if (isGamescopeEnv) {
        app.isQuiting = true;
        app.quit();
      } else {
        e.preventDefault();
        win.hide();
        if (tray && tray.displayBalloon) tray.displayBalloon({ title: 'NearsecTogether', content: 'Running in background.' });
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

  // ── IPC Handlers ──
  ipcMain.handle('join-session', async (event, data) => {
    // When the user clicks "Join" from the dashboard, load the viewer UI
    // and pass the host connection data in the URL
    if (win && !win.isDestroyed()) {
      let url = data?.url || data || '';
      if (typeof url !== 'string') url = '';

      let viewerUrl = `http://localhost:${serverPort}/?client=1&compat=1&host=${encodeURIComponent(url)}`;
      if (data?.pin) {
        viewerUrl += `&pin=${encodeURIComponent(data.pin)}`;
      }

      win.loadURL(viewerUrl);
    }
    return true;
  });

  let gamepadProc = null;
  ipcMain.on('start-native-gamepad', (event) => {
    if (gamepadProc) return;
    const { spawn } = require('child_process');
    let basePath = __dirname;
    if (basePath.includes('app.asar')) {
      basePath = basePath.replace('app.asar', 'app.asar.unpacked');
    }
    const pyScript = path.join(basePath, 'src', 'sidecar', 'input_backends', 'read_gamepads.py');
    const pyExec = process.platform === 'win32' ? path.join(basePath, 'bin', 'python', 'python.exe') : 'python3';

    // Fallback to system python on windows if bin/python doesn't exist
    const actualExec = (process.platform === 'win32' && !fs.existsSync(pyExec)) ? 'python' : pyExec;

    gamepadProc = spawn(actualExec, [pyScript]);
    gamepadProc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          event.reply('native-gamepad-event', msg);
        } catch (_) { }
      }
    });
    gamepadProc.stderr.on('data', d => console.error('[native-gamepad]', d.toString().trim()));
    gamepadProc.on('close', () => { gamepadProc = null; });
  });

  ipcMain.on('native-gamepad-rumble', (event, data) => {
    if (gamepadProc && gamepadProc.stdin && !gamepadProc.stdin.destroyed) {
      try {
        gamepadProc.stdin.write(JSON.stringify({ type: 'rumble', ...data }) + '\n');
      } catch (err) {
        console.error('[native-gamepad] Failed to write rumble data:', err.message);
      }
    }
  });

  ipcMain.handle('get-settings', () => settings);
  // Dedicated VPS config handler — exposes only VPS fields to the renderer,
  // keeping the master key separate from general settings for clarity.
  ipcMain.handle('get-vps-config', () => ({
    vpsEnabled: !!settings.vpsEnabled,
    vpsUrl: String(settings.vpsUrl || ''),
    vpsMasterKey: String(settings.vpsMasterKey || ''),
  }));
  ipcMain.handle('save-vps-config', (_, cfg) => {
    if (typeof cfg.vpsEnabled !== 'undefined') settings.vpsEnabled = !!cfg.vpsEnabled;
    if (typeof cfg.vpsUrl !== 'undefined') settings.vpsUrl = String(cfg.vpsUrl).slice(0, 512);
    if (typeof cfg.vpsMasterKey !== 'undefined') settings.vpsMasterKey = String(cfg.vpsMasterKey).slice(0, 256);
    
    saveSettings(settings);
    return {
      vpsEnabled: !!settings.vpsEnabled,
      vpsUrl: String(settings.vpsUrl || ''),
      vpsMasterKey: String(settings.vpsMasterKey || '')
    };
  });
  ipcMain.handle('get-controllers', () => loadControllers());
  ipcMain.handle('save-settings', (_, s) => {
    settings = Object.assign(settings, s);
    saveSettings(settings);
    if (win) win.webContents.send('settings-updated', settings);
    return settings;
  });
  // hydrate-settings: merges a patch from the renderer into the config WITHOUT
  // overwriting keys the renderer doesn't know about. Used to migrate
  // localStorage-only values (ctrlSettings, quality_*, captureMethod, etc.)
  // into the authoritative config file on first load.
  ipcMain.handle('hydrate-settings', (_, patch) => {
    if (!patch || typeof patch !== 'object') return settings;
    settings = Object.assign(settings, patch);
    saveSettings(settings);
    return settings;
  });
  ipcMain.handle('get-config-path', () => CONFIG_FILE);

  ipcMain.handle('toggle-always-on-top', () => {
    settings.alwaysOnTop = !settings.alwaysOnTop;
    if (win) win.setAlwaysOnTop(settings.alwaysOnTop);
    saveSettings(settings);
    return settings.alwaysOnTop;
  });
  ipcMain.handle('get-window-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });
      return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), isScreen: s.id.startsWith('screen:') }));
    } catch (_) { return []; }
  });

  let _pendingCaptureSourceId = null;
  ipcMain.on('set-capture-source', (_event, sourceId) => {
    _pendingCaptureSourceId = sourceId || null;
  });

  // Fix: Listen for 'run-setup', matching what the dashboard actually sends
  ipcMain.on('run-setup', (event) => {
    const { exec } = require('child_process');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');

    if (os.platform() === 'win32') {
      // WINDOWS: Run the PowerShell setup script natively as Administrator
      const scriptPath = path.join(__dirname, 'bin', 'windows_setup.ps1');
      const psCommand = `Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File ""${scriptPath}""' -Verb RunAs`;

      exec(`powershell -Command "${psCommand}"`, (error) => {
        if (error) {
          console.error('[Setup] Windows setup failed:', error.message);
          event.reply('setup-failed', error.message);
        } else {
          event.reply('setup-success');
        }
      });
    }
    else if (os.platform() === 'linux') {
      let scriptPath = path.join(__dirname, 'bin', 'linux_setup.sh');
      let iconPath = path.join(__dirname, 'assets', 'NearsecTogetherLogo.png');
      
      // If running from an AppImage or built executable, extraResources places 'bin' directly in resourcesPath
      if (__dirname.includes('app.asar')) {
        scriptPath = path.join(process.resourcesPath, 'bin', 'linux_setup.sh');
        iconPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'NearsecTogetherLogo.png');
      }
      
      try { fs.chmodSync(scriptPath, 0o755); } catch (e) { console.warn('[Setup] chmod:', e.message); }
      
      const wrapperPath = path.join(os.tmpdir(), 'nearsec_setup_wrapper.sh');
      const statusFile = path.join(os.tmpdir(), 'nearsec_setup_status');

      // Create a clean wrapper that forces the native password prompt and logs the exit code
      // We copy the script to /tmp first because root (sudo) cannot read FUSE mounts like AppImage's /tmp/.mount_*
      const wrapperContent = `#!/bin/bash\nclear\necho "Starting Nearsec Setup..."\ncp "${scriptPath}" /tmp/nearsec_setup.sh\ncp "${iconPath}" /tmp/NearsecTogetherLogo.png 2>/dev/null\nchmod +x /tmp/nearsec_setup.sh\nsudo bash /tmp/nearsec_setup.sh\nif [ $? -eq 0 ]; then echo "SUCCESS" > "${statusFile}"; else echo "FAIL" > "${statusFile}"; fi\necho ""\nread -p "Press Enter to close..."\n`;

      try {
        fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
        if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile); // Clear old status
      } catch (e) {
        console.error('[Setup] Failed to write wrapper:', e);
        event.reply('setup-failed', e.message);
        return;
      }

      // x-terminal-emulator respects the OS's chosen default terminal.
      // The rest are strictly fallbacks for non-Debian distros.
      const command = `x-terminal-emulator -e "${wrapperPath}" || konsole -e "${wrapperPath}" || gnome-terminal -- "${wrapperPath}" || xterm -e "${wrapperPath}"`;

      exec(command, (error) => {
        // Read the status file to tell the UI if the drivers actually installed
        try {
          const status = fs.readFileSync(statusFile, 'utf8');
          if (status.includes('SUCCESS')) {
            event.reply('setup-success');
          } else {
            event.reply('setup-failed', 'Setup aborted or failed.');
          }
        } catch (e) {
          event.reply('setup-failed', 'Terminal closed early.');
        }
      });
    }
  });

  // FIX #22: Clipboard IPC bridge
  ipcMain.handle('clipboard-write', (_, text) => {
    try { clipboard.writeText(String(text)); return true; } catch (_) { return false; }
  });
  ipcMain.handle('clipboard-read', () => {
    try { return clipboard.readText(); } catch (_) { return ''; }
  });

  ipcMain.handle('get-app-version', () => {
    const pkgPath = path.join(__dirname, 'package.json');
    let version = '1.0.0';
    try { version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; } catch (_) {}
    let commit = '';
    try { commit = fs.readFileSync(path.join(__dirname, 'commit.txt'), 'utf8').trim().substring(0, 7); } catch (_) {}
    return { version, commit };
  });

  // FIX #7 / openHost: version param forwarded correctly from preload
  ipcMain.on('open-host', (event, version) => {
    // FIX #7: version param ('new' | 'old') is now forwarded from preload
    const route = version === 'old' ? '/old_host' : '/host';
    const captureParams = [];
    if (isWebCodecs) captureParams.push('wc=1');
    if (isFFmpegCapture) captureParams.push('ffmpeg=1');
    const qs = captureParams.length ? '?' + captureParams.join('&') : '';
    if (win && !win.isDestroyed()) win.loadURL(`http://localhost:${serverPort}${route}${qs}`);
  });

  ipcMain.handle('read-doc', async (event, filename) => {
    if (!filename || filename.includes('..') || filename.includes('/')) throw new Error('Invalid filename');
    return require('fs').promises.readFile(path.join(__dirname, 'src', 'docs', filename), 'utf8');
  });

  ipcMain.on('back-to-dashboard-from-host', () => {
    if (win && !win.isDestroyed()) {
      win.loadURL(`http://localhost:${serverPort}/dashboard?port=${serverPort}&noAutoHost=1`);
    }
  });

  ipcMain.on('back-to-dashboard', () => {
    if (win && !win.isDestroyed()) {
      win.loadURL(`http://localhost:${serverPort}/dashboard?port=${serverPort}&noAutoHost=1`);
    }
  });

  ipcMain.on('install-update', () => {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.quitAndInstall();
    } catch (e) {
      console.error('[electron] Failed to install update:', e);
    }
  });

  ipcMain.on('open-log', () => {
    const { shell } = require('electron');
    if (fs.existsSync(LOG_FILE)) {
      shell.openPath(LOG_FILE);
    } else {
      console.error('[electron] Log file not found at:', LOG_FILE);
    }
  });

  ipcMain.on('open-dir', () => {
    const { shell } = require('electron');
    shell.openPath(__dirname);
  });

  ipcMain.on('window-close', () => { if (win && !win.isDestroyed()) win.close(); });
  ipcMain.on('app-quit', () => { app.isQuiting = true; app.quit(); });
  ipcMain.on('update-tray-icon', (event, iconName) => {
    if (tray && !tray.isDestroyed()) {
      try {
        const p = path.join(__dirname, 'assets', iconName);
        if (fs.existsSync(p)) {
          const newIcon = nativeImage.createFromPath(p).resize({ height: 22 });
          tray.setImage(newIcon);
        }
      } catch (e) {
        console.error("Failed to update tray icon", e);
      }
    }
  });

  // ── Discord RPC ──
  let rpc = null;
  const DiscordRPC = require('discord-rpc');
  
  ipcMain.on('discord-set-activity', (event, activity) => {
    if (!settings.discordRPC) return;
    if (!rpc) {
      DiscordRPC.register(settings.discordClientId);
      rpc = new DiscordRPC.Client({ transport: 'ipc' });
      rpc.on('ready', () => {
        console.log('[Discord] RPC Ready');
        rpc.setActivity(activity).catch(console.error);
      });
      rpc.login({ clientId: settings.discordClientId }).catch(err => {
        console.error('[Discord] login failed:', err.message);
        rpc = null;
      });
    } else {
      rpc.setActivity(activity).catch(console.error);
    }
  });

  ipcMain.on('discord-clear', () => {
    if (rpc) {
      rpc.clearActivity().catch(console.error);
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  const { globalShortcut } = require('electron');
  let isPanicActive = false;

  globalShortcut.register('CommandOrControl+Shift+Backspace', () => {
    isPanicActive = !isPanicActive;
    console.log(`\n[electron] PANIC MODE ${isPanicActive ? 'ACTIVATED' : 'DEACTIVATED'}`);
    if (serverCore && serverCore.toUinput) {
      serverCore.toUinput({ type: 'panic_toggle', enabled: isPanicActive });
    }
  });

  // Auto-updater logic
  if (settings.checkForUpdates !== false) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      
      autoUpdater.on('update-downloaded', (info) => {
        console.log('[electron] Update downloaded:', info.version);
        if (win && !win.isDestroyed()) {
          win.webContents.send('update-ready', info.version);
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

// FIX #18 + FIX #23: before-quit ensures tunnel PGID kill and virtual gamepad teardown
app.on('before-quit', () => {
  if (serverCore && serverCore.cleanup) serverCore.cleanup(true);
});

app.on('window-all-closed', () => app.quit());

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }
});
