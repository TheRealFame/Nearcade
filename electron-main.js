const {
  app, BrowserWindow, ipcMain, shell, Tray, Menu,
  nativeImage, dialog, desktopCapturer, clipboard,
} = require('electron');
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { powerSaveBlocker } = require('electron');
powerSaveBlocker.start('prevent-app-suspension');

// ── CRITICAL FIX: Detect Arcade Worker immediately ──
const isArcadeWorker      = process.argv.includes('--arcade-worker');
const isFFmpegExperimental = process.argv.includes('--ffmpeg-experimental');
const gotTheLock          = isArcadeWorker ? true : app.requestSingleInstanceLock();

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
      } catch (_) {}
    }
    process.exit(0);
  }
}
process.on('SIGINT',  () => _electronSignalCleanup('SIGINT'));
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
        try { execSync(`pactl unload-module ${id}`, { stdio: 'ignore' }); } catch (_) {}
      }
    }
  } catch (_) {}
}

if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'assets/NearsecTogether.png'));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── WAYLAND & HARDWARE ENCODING OPTIMIZATIONS ──
if (isArcadeWorker && process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
} else if (process.platform === 'linux' && (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')) {
  // Force native Wayland with decorations
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  // Combine WebRTC PipeWire capture with VAAPI Hardware Encoding for AMD
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,WaylandWindowDecorations,VaapiVideoEncoder,VaapiVideoDecoder,CanvasOopRasterization');
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
// ── FIX #12: Single centralized config ───────────────────────────────────────
// All settings live here. Renderer pages MUST go through electronAPI.getSettings /
// saveSettings — never use localStorage as the authoritative source for Electron
// state. localStorage in the renderer is treated as a UI-layer cache only.
const CONFIG_DIR  = path.join(app.getPath('userData'), 'NearsecTogether');
const CONFIG_FILE = path.join(CONFIG_DIR, 'nearsectogether.config.json');
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
  // Auto-hosts
  autoHosts: [],
  // First run
  firstRunComplete: false,
};

function loadSettings() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
  } catch (_) {}
  return Object.assign({}, DEFAULTS);
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

    // If launched with --ffmpeg-experimental, persist it to config and tell server
    if (isFFmpegExperimental) {
      settings.ffmpegExperimental = true;
      saveSettings(settings);
      process.env.FFMPEG_EXPERIMENTAL = '1';
      console.log('[electron] ⚠  FFmpeg experimental pipeline ENABLED via launch flag.');
    } else if (settings.ffmpegExperimental) {
      // Also honour the saved config preference without needing the flag every time
      process.env.FFMPEG_EXPERIMENTAL = '1';
      console.log('[electron] ⚠  FFmpeg experimental pipeline ENABLED via saved config.');
    }

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

let win  = null;
let tray = null;

async function createWindow() {
  const port = await startServer();
  console.log('[electron] server ready on port', port);

  win = new BrowserWindow({
    width:  Math.max(settings.w, 600),
    height: Math.max(settings.h, 500),
    minWidth:  600,
    minHeight: 500,
    title: 'NearsecTogether',
    icon:  path.join(__dirname, 'assets/NearsecTogether.png'),
    backgroundColor: '#111111',
    alwaysOnTop: settings.alwaysOnTop,
    show: false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron-preload.js'),
    },
    autoHideMenuBar: true,
  });

  win.once('ready-to-show', () => { if (!isArcadeWorker) win.show(); });

  const PAGES_DIR = path.join(__dirname, 'src', 'pages');

  if (isArcadeWorker) {
    function getCliArg(flag) {
      const idx = process.argv.indexOf(flag);
      return idx > -1 ? process.argv[idx + 1] : null;
    }
    const gameName   = getCliArg('--game-name')   || 'Arcade Game';
    const tunnelProv = getCliArg('--game-tunnel')  || 'cloudflared';
    win.loadURL(`http://localhost:${port}/host?auto=1&title=${encodeURIComponent(gameName)}&tunnel=${encodeURIComponent(tunnelProv)}`);
  } else {
    win.loadFile(path.join(PAGES_DIR, 'dashboard.html'), { query: { port: String(port) } });
  }

  win.webContents.on('did-fail-load', (e, code, desc) => {
    if (code === -3) return;
    console.error('[electron] failed to load:', code, desc);
    setTimeout(() => {
      if (isArcadeWorker) win.loadURL(`http://localhost:${port}/host?auto=1`);
      else win.loadFile(path.join(PAGES_DIR, 'dashboard.html'), { query: { port: String(port) } });
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

  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
      if (sources && sources.length > 0) {
        if (process.platform === 'win32') callback({ video: sources[0], audio: 'loopback' });
        else callback({ video: sources[0] });
      } else {
        console.log('[electron] Capture blocked or no sources found. Cancelling.');
        callback();
      }
    }).catch(err => { console.error('[electron] Capturer error:', err); callback(); });
  });

  win.on('resize', () => {
    const [w, h] = win.getSize();
    settings.w = w; settings.h = h;
    saveSettings(settings);
  });
  win.on('closed', () => { win = null; });

  // ── Tray ──
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

  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_HIGH); } catch (_) {}

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
      win.loadURL(`http://localhost:${serverPort}/?client=1&host=${encodeURIComponent(data || '')}`);
    }
    return true;
  });
  ipcMain.handle('get-settings', () => settings);
  ipcMain.handle('save-settings', (_, s) => {
    settings = Object.assign(settings, s);
    saveSettings(settings);
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
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });
      return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), isScreen: s.id.startsWith('screen:') }));
    } catch (_) { return []; }
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
      const scriptPath = path.join(__dirname, 'bin', 'linux_setup.sh');
      const wrapperPath = path.join(os.tmpdir(), 'nearsec_setup_wrapper.sh');
      const statusFile = path.join(os.tmpdir(), 'nearsec_setup_status');

      // Create a clean wrapper that forces the native password prompt and logs the exit code
      const wrapperContent = `#!/bin/bash\nclear\necho "Starting Nearsec Setup..."\nsudo bash "${scriptPath}"\nif [ $? -eq 0 ]; then echo "SUCCESS" > "${statusFile}"; else echo "FAIL" > "${statusFile}"; fi\necho ""\nread -p "Press Enter to close..."\n`;

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
        } catch(e) {
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

  // FIX #7 / openHost: version param forwarded correctly from preload
  ipcMain.on('open-host', (event, version) => {
    // FIX #7: version param ('new' | 'old') is now forwarded from preload
    const route = version === 'old' ? '/old_host' : '/host';
    if (win && !win.isDestroyed()) win.loadURL(`http://localhost:${serverPort}${route}`);
  });

  ipcMain.on('back-to-dashboard-from-host', () => {
    if (win && !win.isDestroyed()) {
      win.loadFile(path.join(__dirname, 'src', 'pages', 'dashboard.html'), {
        query: { port: String(serverPort), noAutoHost: '1' },
      });
    }
  });

  ipcMain.on('window-close', () => { if (win && !win.isDestroyed()) win.close(); });
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
