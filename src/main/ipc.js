const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync, exec, execSync } = require('child_process');
const {
  app, BrowserWindow, ipcMain, shell, clipboard, desktopCapturer,
  systemPreferences, dialog, nativeImage, nativeTheme, utilityProcess
} = require('electron');
const { CONFIG_DIR, CONFIG_FILE, LOG_FILE, ROOT_DIR } = require('./config');
const { loadControllers, saveSettings, saveSettingsSync } = require('./config');

// #1: Direct input forwarding — bypass local WS relay
// Lazy-require InputOrchestrator so it's available after init()
let _inputDriver = null;
function _getInputDriver() {
  if (!_inputDriver) {
    try { _inputDriver = require('../sidecar/input_backends/InputOrchestrator'); }
    catch (_) { _inputDriver = null; }
  }
  return _inputDriver;
}

let selectedSourceId = null;

// ── NDI egress (utility process) ──────────────────────────────────────────────
let ndiProc = null;
function ndiForward(eventName, ...args) {
  try { if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send(eventName, ...args); } catch (_) { }
}
function ndiSpawnWorker() {
  if (ndiProc) return ndiProc;
  const { fork } = require('child_process');
  ndiProc = fork(path.join(__dirname, 'ndi-egress-worker.js'), [], { 
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, 
    stdio: 'ignore',
    serialization: 'advanced'
  });
  ndiProc.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.ev === 'error') ndiForward('ndi-status', { running: false, error: msg.msg });
    else ndiForward('ndi-status', msg);
  });
  ndiProc.on('exit', () => { ndiProc = null; ndiForward('ndi-status', { running: false, error: 'NDI worker exited' }); });
  ndiProc.send({ op: 'init' });
  return ndiProc;
}
function ndiKillWorker() {
  if (ndiProc) { try { ndiProc.send({ op: 'stop' }); } catch (_) { } try { ndiProc.kill(); } catch (_) { } ndiProc = null; }
}
app.on('before-quit', ndiKillWorker);

// ── Spout2 egress (utility process, Windows only) ─────────────────────────────
let spoutProc = null;
function spoutForward(eventName, ...args) {
  try { if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send(eventName, ...args); } catch (_) { }
}
function spoutSpawnWorker() {
  if (spoutProc) return spoutProc;
  spoutProc = utilityProcess.fork(path.join(__dirname, 'spout-egress-worker.js'), [], { stdio: 'ignore' });
  spoutProc.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.ev === 'error') spoutForward('spout-status', { running: false, error: msg.msg });
    else spoutForward('spout-status', msg);
  });
  spoutProc.on('exit', () => { spoutProc = null; spoutForward('spout-status', { running: false, error: 'Spout worker exited' }); });
  spoutProc.postMessage({ op: 'init' });
  return spoutProc;
}
function spoutKillWorker() {
  if (spoutProc) { try { spoutProc.postMessage({ op: 'stop' }); } catch (_) { } try { spoutProc.kill(); } catch (_) { } spoutProc = null; }
}
app.on('before-quit', spoutKillWorker);

function registerIpcHandlers(ctx) {
  let gamepadProc = null;

  ipcMain.handle('join-session', async (event, data) => {
    if (ctx.win && !ctx.win.isDestroyed()) {
      let url = data?.url || data || '';
      if (typeof url !== 'string') url = '';

      let viewerUrl = `http://localhost:${ctx.serverPort}/?client=1&compat=1&host=${encodeURIComponent(url)}`;
      if (data?.pin) {
        viewerUrl += `&pin=${encodeURIComponent(data.pin)}`;
      }
      if (data?.meta?.game && data.meta.game !== 'Direct Connect' && data.meta.game !== 'P2P Session') {
        viewerUrl += `&arcade=1`;
      }
      ctx.win.loadURL(viewerUrl);
    }
    return true;
  });

  ipcMain.on('start-native-gamepad', (event) => {
    if (gamepadProc) return;
    let basePath = ROOT_DIR;
    if (basePath.includes('app.asar')) {
      basePath = basePath.replace('app.asar', 'app.asar.unpacked');
    }
    const pyScript = path.join(basePath, 'src', 'sidecar', 'input_backends', 'read_gamepads.py');
    const pyExec = process.platform === 'win32' ? path.join(basePath, 'bin', 'python', 'python.exe') : 'python3';
    const actualExec = (process.platform === 'win32' && !fs.existsSync(pyExec)) ? 'python' : pyExec;

    gamepadProc = spawn(actualExec, ['-u', pyScript]);
    let lineBuffer = '';
    gamepadProc.stdout.on('data', (data) => {
      lineBuffer += data.toString();
      let lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // Keep the last incomplete line in the buffer
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

  // #1 + #8: Direct input forwarding — bypasses the local WebSocket relay
  ipcMain.on('forward-input', (_event, msg) => {
    const driver = _getInputDriver();
    if (driver && driver.send) {
      try { driver.send(msg); } catch (e) {
        console.error('[ipc] forward-input error:', e.message);
      }
    }
  });
  ipcMain.on('forward-input-binary', (_event, viewerId, buf) => {
    const driver = _getInputDriver();
    if (driver && driver.sendBinary) {
      try { driver.sendBinary(viewerId, Buffer.from(buf)); } catch (e) {
        console.error('[ipc] forward-input-binary error:', e.message);
      }
    }
  });

  ipcMain.handle('get-settings', () => {
    const s = { ...ctx.settings };
    try {
      let envFile = path.join(ROOT_DIR, '.env');
      if (!fs.existsSync(envFile)) envFile = path.join(CONFIG_DIR, '.env');
      if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf8');
        envContent.split('\n').forEach(line => {
          const match = line.match(/^\s*CUSTOM_URL\s*=\s*(.*)?\s*$/);
          if (match) s.customUrl = (match[1] || '').trim().replace(/^['"]|['"]$/g, '');
        });
      }
    } catch (_) { }
    if (process.env.CUSTOM_URL && !s.customUrl) s.customUrl = process.env.CUSTOM_URL.trim();
    return s;
  });

  ipcMain.handle('get-vps-config', () => ({
    vpsEnabled: !!ctx.settings.vpsEnabled,
    vpsUrl: String(ctx.settings.vpsUrl || ''),
    vpsMasterKey: String(ctx.settings.vpsMasterKey || ''),
  }));

  ipcMain.handle('save-vps-config', (_, cfg) => {
    const delta = {};
    if (typeof cfg.vpsEnabled !== 'undefined') delta.vpsEnabled = ctx.settings.vpsEnabled = !!cfg.vpsEnabled;
    if (cfg.vpsUrl !== undefined) delta.vpsUrl = ctx.settings.vpsUrl = String(cfg.vpsUrl).slice(0, 512);
    if (cfg.vpsMasterKey !== undefined) delta.vpsMasterKey = ctx.settings.vpsMasterKey = String(cfg.vpsMasterKey).slice(0, 256);
    saveSettings(delta);
    return {
      vpsEnabled: !!ctx.settings.vpsEnabled,
      vpsUrl: String(ctx.settings.vpsUrl || ''),
      vpsMasterKey: String(ctx.settings.vpsMasterKey || '')
    };
  });

  ipcMain.handle('get-controllers', () => loadControllers());

  ipcMain.handle('save-settings', (_, s) => {
    ctx.settings = Object.assign(ctx.settings, s);
    saveSettings(s);
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send('settings-updated', ctx.settings);
    return ctx.settings;
  });

  ipcMain.handle('save-settings-sync', (_, s) => {
    ctx.settings = Object.assign(ctx.settings, s);
    saveSettingsSync(s);
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send('settings-updated', ctx.settings);
    return ctx.settings;
  });

  ipcMain.handle('hydrate-settings', (_, patch) => {
    if (!patch || typeof patch !== 'object') return ctx.settings;
    ctx.settings = Object.assign(ctx.settings, patch);
    saveSettings(patch);
    return ctx.settings;
  });

  ipcMain.handle('get-config-path', () => CONFIG_FILE);

  ipcMain.handle('toggle-always-on-top', () => {
    ctx.settings.alwaysOnTop = !ctx.settings.alwaysOnTop;
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.setAlwaysOnTop(ctx.settings.alwaysOnTop);
    saveSettings({ alwaysOnTop: ctx.settings.alwaysOnTop });
    return ctx.settings.alwaysOnTop;
  });

  ipcMain.handle('get-cursor-pos', () => {
    const { screen } = require('electron');
    return screen.getCursorScreenPoint();
  });

  ipcMain.handle('check-gstreamer-deps', () => {
    if (process.platform !== 'linux') return false;
    try {
      const { execSync } = require('child_process');
      // Python will exit 0 if the module is found and imports successfully.
      execSync('python3 -c "import gi; gi.require_version(\'GstWebRTC\', \'1.0\')"', { stdio: 'ignore' });
      return true;
    } catch (_) {
      return false;
    }
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

  ipcMain.handle('set-selected-source', (event, id) => {
    selectedSourceId = id;
  });

  ipcMain.on('run-setup', (event) => {
    if (os.platform() === 'win32') {
      let scriptPath = path.join(ROOT_DIR, 'bin', 'windows_setup.ps1');
      if (__dirname.includes('app.asar')) {
        scriptPath = path.join(process.resourcesPath, 'bin', 'windows_setup.ps1');
      }
      if (!fs.existsSync(scriptPath)) {
        console.error('[Setup] windows_setup.ps1 not found at', scriptPath);
        event.reply('setup-failed', 'Setup script not found: ' + scriptPath);
        return;
      }
      const psCommand = `Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File ""${scriptPath}""' -Verb RunAs -Wait`;
      exec(`powershell -NoProfile -Command "${psCommand}"`, (error) => {
        if (error) {
          console.error('[Setup] Windows setup failed:', error.message);
          event.reply('setup-failed', error.message);
        } else {
          event.reply('setup-success');
        }
      });
    } else if (os.platform() === 'linux') {
      let scriptPath = path.join(ROOT_DIR, 'bin', 'linux_setup.sh');
      let iconPath = path.join(ROOT_DIR, 'assets', 'NearcadeLogo.png');
      if (__dirname.includes('app.asar')) {
        scriptPath = path.join(process.resourcesPath, 'bin', 'linux_setup.sh');
        iconPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'NearcadeLogo.png');
      }
      try { fs.chmodSync(scriptPath, 0o755); } catch (e) { console.warn('[Setup] chmod:', e.message); }

      const wrapperPath = path.join(os.tmpdir(), 'nearcade_setup_wrapper.sh');
      const statusFile = path.join(os.tmpdir(), 'nearcade_setup_status');
      const wrapperContent = `#!/bin/bash\nclear\necho "Starting Nearcade Setup..."\ncp "${scriptPath}" /tmp/nearcade_setup.sh\ncp "${iconPath}" /tmp/NearcadeLogo.png 2>/dev/null\nchmod +x /tmp/nearcade_setup.sh\nsudo bash /tmp/nearcade_setup.sh\nif [ $? -eq 0 ]; then echo "SUCCESS" > "${statusFile}"; else echo "FAIL" > "${statusFile}"; fi\necho ""\nread -p "Press Enter to close..."\n`;

      try {
        fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
        if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile);
      } catch (e) {
        console.error('[Setup] Failed to write wrapper:', e);
        event.reply('setup-failed', e.message);
        return;
      }

      const command = `x-terminal-emulator -e "${wrapperPath}" || konsole -e "${wrapperPath}" || gnome-terminal -- "${wrapperPath}" || xterm -e "${wrapperPath}"`;
      exec(command, (error) => {
        try {
          const status = fs.readFileSync(statusFile, 'utf8');
          if (status.includes('SUCCESS')) event.reply('setup-success');
          else event.reply('setup-failed', 'Setup aborted or failed.');
        } catch (e) {
          event.reply('setup-failed', 'Terminal closed early.');
        }
      });
    }
  });

  ipcMain.on('run-vbcable-setup', (event) => {
    if (os.platform() === 'win32') {
      let scriptPath = path.join(ROOT_DIR, 'bin', 'install_vbcable.ps1');
      if (__dirname.includes('app.asar')) {
        scriptPath = path.join(process.resourcesPath, 'bin', 'install_vbcable.ps1');
      }
      if (!fs.existsSync(scriptPath)) {
        console.error('[Setup] install_vbcable.ps1 not found at', scriptPath);
        return;
      }
      const psCommand = `Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File ""${scriptPath}""' -Verb RunAs`;
      exec(`powershell -NoProfile -Command "${psCommand}"`, (error) => {
        if (error) console.error('[Setup] VB-Cable setup failed to launch:', error.message);
      });
    }
  });

  ipcMain.on('run-advanced-linux-setup', (event) => {
    if (os.platform() === 'linux') {
      let scriptPath = path.join(ROOT_DIR, 'bin', 'linux_advanced_setup.sh');
      if (__dirname.includes('app.asar')) {
        scriptPath = path.join(process.resourcesPath, 'bin', 'linux_advanced_setup.sh');
      }
      if (!fs.existsSync(scriptPath)) return;
      const command = `x-terminal-emulator -e "bash ${scriptPath}" || konsole -e "bash ${scriptPath}" || gnome-terminal -- bash ${scriptPath} || xterm -e "bash ${scriptPath}"`;
      exec(command, (error) => {
        if (error) console.error('[Setup] Linux advanced setup failed to launch:', error.message);
      });
    }
  });

  ipcMain.handle('clipboard-write', (_, text) => {
    try { clipboard.writeText(String(text)); return true; } catch (_) { return false; }
  });

  ipcMain.handle('clipboard-read', () => {
    try { return clipboard.readText(); } catch (_) { return ''; }
  });

  ipcMain.handle('open-external', (_event, url) => {
    try { shell.openExternal(url); return true; } catch (_) { return false; }
  });

  ipcMain.handle('get-accent-color', () => {
    try {
      const accent = require('../../packages/accent-color');
      const c = accent.get();
      if (c && c.hex) return c.hex;
    } catch (_) { }

    try {
      if (process.platform === 'win32' || process.platform === 'darwin') {
        if (typeof systemPreferences.getAccentColor === 'function') {
          const color = systemPreferences.getAccentColor();
          if (color) return '#' + color.slice(0, 6);
        }
      }
    } catch (_) { }
    return '#8b5cf6';
  });

  ipcMain.handle('get-native-theme', () => {
    try {
      const { getThemeColors } = require('../../packages/native-palette');
      const theme = getThemeColors();

      // Force Electron to synchronize the titlebar and dialog colors with the OS
      nativeTheme.themeSource = 'system';

      return theme;
    } catch (e) {
      console.error('[ipc] Failed to fetch native theme:', e);
      return null;
    }
  });

  ipcMain.handle('get-app-version', () => {
    const pkgPath = path.join(ROOT_DIR, 'package.json');
    let version = '1.0.0';
    try { version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version; } catch (_) { }
    let commit = '';
    try { commit = fs.readFileSync(path.join(ROOT_DIR, 'commit.txt'), 'utf8').trim().substring(0, 7); } catch (_) { }
    return { version, commit };
  });

  ipcMain.on('open-host', (event, version) => {
    let route = '/host';
    if (version === 'old') route = '/old_host';
    else if (version === 'minimal') route = '/host-minimal';
    else if (version === 'playground') route = '/host-playground';
    else if (version === 'custom') route = '/host-custom';

    const captureParams = [];
    if (ctx.settings.captureMethod) {
      captureParams.push(`pipeline=${encodeURIComponent(ctx.settings.captureMethod)}`);
    }
    // Legacy fallback flags
    if (ctx.settings.captureMethod === 'custom_webcodecs') captureParams.push('wc=2');
    else if (ctx.settings.captureMethod === 'webcodecs' || ctx.isWebCodecs) captureParams.push('wc=1');
    if (ctx.settings.captureMethod === 'ffmpeg' || ctx.isFFmpegCapture) captureParams.push('ff=1');
    if (ctx.settings.captureMethod === 'gstreamer_webrtc' || ctx.isGstWebRTC) captureParams.push('gst=1');
    const qs = captureParams.length ? '?' + captureParams.join('&') : '';
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.loadURL(`http://localhost:${ctx.serverPort}${route}${qs}`);
  });

  ipcMain.handle('read-doc', async (event, filename) => {
    if (!filename || typeof filename !== 'string') throw new Error('Invalid filename');
    const docPath = path.resolve(path.join(__dirname, '..', '..', 'assets', 'locales', 'docs'), filename);
    if (!docPath.startsWith(path.resolve(path.join(__dirname, '..', '..', 'assets', 'locales', 'docs')))) {
      throw new Error('Invalid filename');
    }
    return fs.promises.readFile(docPath, 'utf8');
  });

  ipcMain.on('back-to-dashboard-from-host', (_, tab) => {
    if (ctx.win && !ctx.win.isDestroyed()) {
      const t = tab || 'connect';
      ctx.win.loadURL(`http://localhost:${ctx.serverPort}/dashboard?port=${ctx.serverPort}&noAutoHost=1&tab=${t}`);
    }
  });

  ipcMain.on('back-to-dashboard', (_, tab) => {
    if (ctx.win && !ctx.win.isDestroyed()) {
      const t = tab || 'connect';
      ctx.win.loadURL(`http://localhost:${ctx.serverPort}/dashboard?port=${ctx.serverPort}&noAutoHost=1&tab=${t}`);
    }
  });

  // Arcade exit: stop arcade session but keep stream alive, return to dashboard
  ipcMain.handle('arcade-exit', async () => {
    if (ctx.win && !ctx.win.isDestroyed()) {
      try {
        await ctx.win.webContents.executeJavaScript(
          `if (typeof stopArcadeOnly === 'function') stopArcadeOnly();`
        );
      } catch (_) { }
      await ctx.win.loadURL(`http://localhost:${ctx.serverPort}/dashboard?port=${ctx.serverPort}&noAutoHost=1`);
    }
    return true;
  });

  ipcMain.handle('check-system-setup', () => {
    if (ctx.settings.firstRunComplete || ctx.settings.neverBotherSetup) return { needsSetup: false };
    let artifactsFound = false;
    try {
      if (process.platform === 'linux') {
        artifactsFound = fs.existsSync('/etc/udev/rules.d/99-nearcade-input.rules');
      } else if (process.platform === 'win32') {
        artifactsFound = fs.existsSync('C:\\Windows\\System32\\drivers\\ViGEmBus.sys');
      }
    } catch (_) { }

    if (artifactsFound) {
      ctx.settings.firstRunComplete = true;
      ctx.settings.neverBotherSetup = true;
      saveSettings({ firstRunComplete: true, neverBotherSetup: true });
      return { needsSetup: false };
    }
    return { needsSetup: true };
  });

  ipcMain.on('continue-boot', () => {
    ctx.settings.firstRunComplete = true;
    ctx.settings.neverBotherSetup = true;
    saveSettings({ firstRunComplete: true, neverBotherSetup: true });
    if (ctx.win && !ctx.win.isDestroyed()) {
      ctx.win.loadURL(`http://localhost:${ctx.serverPort}/dashboard?port=${ctx.serverPort}`);
    }
  });

  ipcMain.handle('download-tunnel', async (_event, { name, url }) => {
    const destDir = path.join(CONFIG_DIR, 'bin');
    try {
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      const ext = process.platform === 'win32' ? '.exe' : '';
      const destPath = path.join(destDir, name + ext);
      const res = await fetch(url);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destPath, buf);
      try { fs.chmodSync(destPath, 0o755); } catch (_) { }
      return { success: true, path: destPath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('check-hm-bridge', () => {
    const hmPath = path.join(ROOT_DIR, 'src', 'sidecar', 'input_backends', 'HmBridge', 'HmBridge.exe');
    const altPath = hmPath.replace('app.asar', 'app.asar.unpacked');
    const exists = fs.existsSync(hmPath) || fs.existsSync(altPath);
    return { exists, path: fs.existsSync(hmPath) ? hmPath : (fs.existsSync(altPath) ? altPath : null) };
  });

  ipcMain.handle('start-wivrn', async () => {
    try {
      const { spawn } = require('child_process');
      const relayPath = path.join(ROOT_DIR, 'src', 'wivrn', 'relay.js');
      const p = spawn('node', [relayPath], { detached: true, stdio: 'ignore' });
      p.unref();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('check-tunnel-installed', (_event, name) => {
    const destDir = path.join(CONFIG_DIR, 'bin');
    const ext = process.platform === 'win32' ? '.exe' : '';
    const altNames = { zrok: ['zrok', 'zrok2'] };
    const names = altNames[name] || [name];
    let inConfig = false;
    for (const n of names) {
      if (fs.existsSync(path.join(destDir, n + ext))) { inConfig = true; break; }
    }
    let onPath = false;
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execSync(`${cmd} ${names.join(' ')}`, { stdio: 'ignore' });
      onPath = true;
    } catch (_) {
      for (const n of names) {
        try {
          const c = process.platform === 'win32' ? 'where' : 'which';
          execSync(`${c} ${n}`, { stdio: 'ignore' });
          onPath = true;
          break;
        } catch (_) { }
      }
    }
    return { installed: inConfig || onPath, inConfig, onPath };
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
    if (fs.existsSync(LOG_FILE)) {
      shell.openPath(LOG_FILE);
    } else {
      console.error('[electron] Log file not found at:', LOG_FILE);
    }
  });

  ipcMain.on('open-dir', () => {
    shell.openPath(CONFIG_DIR);
  });

  ipcMain.on('window-close', () => { if (ctx.win && !ctx.win.isDestroyed()) ctx.win.close(); });

  // ── NDI egress IPC ──
  ipcMain.on('ndi:start', (_e, cfg) => {
    try {
      ndiSpawnWorker().send({ op: 'start', cfg: cfg || {} });
    } catch (err) {
      ndiForward('ndi-status', { running: false, error: String(err && err.message || err) });
    }
  });
  ipcMain.on('ndi:frame', (_e, meta, buffer) => {
    if (!ndiProc) return;
    try { ndiProc.send({ op: 'frame', meta: meta || {}, buffer }); } catch (_) { }
  });
  ipcMain.on('ndi:stop', () => ndiKillWorker());

  // ── Spout2 egress IPC (Windows only — worker fails open on other platforms) ──
  ipcMain.on('spout:start', (_e, cfg) => {
    try {
      spoutSpawnWorker().postMessage({ op: 'start', cfg: cfg || {} });
    } catch (err) {
      spoutForward('spout-status', { running: false, error: String(err && err.message || err) });
    }
  });
  ipcMain.on('spout:frame', (_e, meta, buffer) => {
    if (!spoutProc) return;
    try { spoutProc.postMessage({ op: 'frame', meta: meta || {}, buffer }); } catch (_) { }
  });
  ipcMain.on('spout:stop', () => spoutKillWorker());

  ipcMain.on('window-minimize', () => { if (ctx.win && !ctx.win.isDestroyed()) ctx.win.minimize(); });
  ipcMain.on('window-maximize', () => { if (ctx.win && !ctx.win.isDestroyed()) { ctx.win.isMaximized() ? ctx.win.unmaximize() : ctx.win.maximize(); } });
  ipcMain.on('window-fullscreen', () => { if (ctx.win && !ctx.win.isDestroyed()) ctx.win.setFullScreen(!ctx.win.isFullScreen()); });
  ipcMain.on('app-quit', () => { app.isQuiting = true; app.quit(); });

  ipcMain.on('update-tray-icon', (event, iconName) => {
    if (ctx.tray && !ctx.tray.isDestroyed()) {
      try {
        const p = path.join(ROOT_DIR, 'assets', iconName);
        if (fs.existsSync(p)) {
          const newIcon = nativeImage.createFromPath(p).resize({ height: 22 });
          ctx.tray.setImage(newIcon);
        }
      } catch (e) {
        console.error("Failed to update tray icon", e);
      }
    }
  });

  let rpc = null;
  let rpcReady = false;
  let latestActivity = null;

  // ── Discord RPC socket bridge helpers ─────────────────────────────────────
  // discord-rpc only probes `$XDG_RUNTIME_DIR/discord-ipc-0..9`. This fixes
  // three real-world failures:
  //   1. Stale sockets: after a crash the socket file remains but nothing is
  //      listening — ECONNREFUSED forever. We unlink stale files first.
  //   2. Vesktop (Flatpak): its arRPC socket lives in a sandbox path
  //      ($XDG_RUNTIME_DIR/.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-0).
  //      We bridge it to the standard path so the library can connect.
  //   3. Vesktop (any build) exposes a websocket on 127.0.0.1:6463 as an
  //      alternative — we fall back to the 'websocket' transport when IPC
  //      cannot connect at all.
  function _runtimeDir() {
    if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR;
    if (typeof process.getuid === 'function') return `/run/user/${process.getuid()}`;
    return null;
  }

  function _probeSocket(path, timeoutMs = 800) {
    return new Promise((resolve) => {
      const net = require('net');
      const sock = net.createConnection({ path });
      const done = (ok) => {
        try { sock.destroy(); } catch (_) { }
        resolve(ok);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.on('connect', () => done(true));
      sock.on('error', () => done(false));
      sock.on('timeout', () => done(false));
    });
  }

  function _unlinkStaleSocket(path) {
    const fs = require('fs');
    try {
      const st = fs.lstatSync(path);
      if (!st.isSocket() && !st.isSymbolicLink()) return;
      // Reached only after probing failed (ECONNREFUSED): nothing is listening.
      fs.unlinkSync(path);
      console.log(`[Discord RPC] Removed stale socket ${path}`);
    } catch (_) { }
  }

  function _bridgeVesktopSockets() {
    const fs = require('fs');
    const runtimeDir = _runtimeDir();
    if (!runtimeDir || !fs.existsSync(runtimeDir)) return;

    // Sandboxed sockets that OTHER Discord clients may be listening on.
    const bridges = [
      { label: 'Vesktop (Flatpak)', socket: `${runtimeDir}/.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-0` },
      { label: 'Vesktop (Flatpak, legacy)', socket: `${runtimeDir}/app/dev.vencord.Vesktop/discord-ipc-0` },
      { label: 'Discord (Flatpak)', socket: `${runtimeDir}/app/com.discordapp.Discord/discord-ipc-0` },
    ];

    for (const b of bridges) {
      try {
        if (!fs.existsSync(b.socket)) continue;
        const target = `${runtimeDir}/discord-ipc-0`;
        if (fs.existsSync(target)) continue; // real listener already there
        // Only bridge if the sandbox socket is actually alive
        _probeSocket(b.socket).then((alive) => {
          if (!alive) return;
          try {
            fs.symlinkSync(b.socket, target, 'socket');
            console.log(`[Discord RPC] Bridged ${b.label} socket → ${target}`);
          } catch (e) {
            if (e.code !== 'EEXIST') console.log(`[Discord RPC] Bridge ${b.label} failed:`, e.message);
          }
        });
      } catch (_) { }
    }
  }

  async function _findLiveSocketPath() {
    const fs = require('fs');
    const runtimeDir = _runtimeDir();
    if (!runtimeDir) return null;
    for (let i = 0; i < 10; i++) {
      const p = `${runtimeDir}/discord-ipc-${i}`;
      try {
        if (!fs.existsSync(p)) continue;
        if (!fs.lstatSync(p).isSocket() && !fs.lstatSync(p).isSymbolicLink()) continue;
        if (await _probeSocket(p)) return p;
        _unlinkStaleSocket(p);
      } catch (_) { }
    }
    return null;
  }

  async function _createDiscordClient() {
    const DiscordRPC = require('discord-rpc');

    if (process.platform === 'linux') {
      _bridgeVesktopSockets();
      const livePath = await _findLiveSocketPath();
      if (livePath) {
        console.log(`[Discord RPC] IPC socket found: ${livePath}`);
        return new DiscordRPC.Client({ transport: 'ipc' });
      }

      // Check if Vesktop arRPC websocket 6463 is actually up before trying
      const wsPort = 6463;
      const wsAlive = await new Promise(resolve => {
        const sock = new (require('net')).Socket();
        sock.setTimeout(800);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.connect(wsPort, '127.0.0.1');
      });
      if (!wsAlive) {
        console.log('[Discord RPC] No IPC socket and ws 6463 not listening — skipping RPC');
        return null;
      }

      console.log('[Discord RPC] No live IPC socket; trying websocket transport (6463)…');
      try {
        return new DiscordRPC.Client({ transport: 'websocket' });
      } catch (err) {
        console.log('[Discord RPC] Failed to create websocket client:', err.message);
        return null;
      }
    } else {
      console.log('[Discord RPC] Native IPC transport initialized');
      return new DiscordRPC.Client({ transport: 'ipc' });
    }
  }

  ipcMain.on('discord-set-activity', (event, activity) => {
    console.log('[Discord RPC] Requested activity:', JSON.stringify(activity));
    if (!ctx.settings.discordRPC) {
      console.log('[Discord RPC] Aborted because settings.discordRPC is false');
      return;
    }
    latestActivity = activity;

    if (!rpc) {
      console.log('[Discord RPC] Initializing new client...');
      _createDiscordClient().then((client) => {
        if (!client) {
          console.log('[Discord RPC] No transport available — RPC will not activate.');
          return;
        }
        rpc = client;

        rpc.on('error', (err) => {
          console.log('[Discord RPC] Error:', err.message || err);
        });

        rpc.on('ready', () => {
          console.log('[Discord RPC] Client Ready');
          rpcReady = true;

          try {
            rpc.subscribe('ACTIVITY_JOIN', (args) => {
              console.log('[Discord RPC] Received ACTIVITY_JOIN:', JSON.stringify(args));
              if (args && args.secret && ctx.win && !ctx.win.isDestroyed()) {
                const isUrl = args.secret.startsWith('http://') || args.secret.startsWith('https://');
                const viewerUrl = isUrl
                  ? `http://localhost:${ctx.serverPort}/?client=1&compat=1&host=${encodeURIComponent(args.secret)}`
                  : `http://localhost:${ctx.serverPort}/?client=1&compat=1&host=${encodeURIComponent('p2p://' + args.secret)}`;
                console.log('[Discord RPC] Navigating to session via ACTIVITY_JOIN:', viewerUrl);
                ctx.win.loadURL(viewerUrl);
              }
            });
            rpc.subscribe('ACTIVITY_JOIN_REQUEST', (args) => {
              console.log('[Discord RPC] Received ACTIVITY_JOIN_REQUEST:', JSON.stringify(args));
            });
            console.log('[Discord RPC] Subscribed to JOIN events');
          } catch (e) {
            console.log('[Discord RPC] Subscribe error:', e.message);
          }

          if (latestActivity) {
            rpc.setActivity(latestActivity)
              .then(() => console.log('[Discord RPC] Activity successfully set!'))
              .catch(err => console.log('[Discord RPC] setActivity failed:', err.message));
          }
        });

        rpc.on('disconnected', () => {
          console.log('[Discord RPC] Disconnected');
          rpcReady = false;
          rpc = null;
        });

        rpc.login({ clientId: ctx.settings.discordClientId }).catch(err => {
          console.log('[Discord RPC] login failed:', err.message);
          rpc = null;
          rpcReady = false;
        });
      });
    } else if (rpcReady) {
      rpc.setActivity(latestActivity)
        .then(() => console.log('[Discord RPC] Activity successfully updated!'))
        .catch(err => console.log('[Discord RPC] updateActivity failed:', err.message));
    } else {
      console.log('[Discord RPC] Client exists but not ready yet. Caching activity.');
    }
  });

  ipcMain.on('discord-clear', () => {
    latestActivity = null;
    if (rpc && rpcReady) {
      rpc.clearActivity().catch(console.error);
    }
  });

  // ── DRM/KMS native capture addon (Wayland silent capture) ──
  // Runs in a worker thread to avoid blocking the main process event loop.
  // Frames are transferred between threads with zero-copy ArrayBuffers.
  const { Worker } = require('worker_threads');
  let drmChild = null;
  let drmReady = false;
  let drmDims = null;
  let drmReqId = 0;
  const drmPending = new Map();

  function _drmSpawnWorker() {
    return new Promise((resolve, reject) => {
      const workerPath = path.join(__dirname, '..', 'sidecar', 'capture', 'drm-worker.js');
      let child;
      try {
        child = new Worker(workerPath);
      } catch (e) {
        return reject(new Error('Failed to spawn DRM worker: ' + e.message));
      }
      const timeout = setTimeout(() => {
        child.terminate();
        reject(new Error('DRM worker timed out'));
      }, 8000);
      child.on('message', msg => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          drmChild = child;
          drmReady = true;
          drmDims = msg;
          resolve({ width: msg.width, height: msg.height });
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          child.terminate();
          reject(new Error(msg.message || 'DRM worker error'));
        } else if (msg.reqId !== undefined && drmPending.has(msg.reqId)) {
          const { resolve: r, timeout: t } = drmPending.get(msg.reqId);
          drmPending.delete(msg.reqId);
          clearTimeout(t);
          r(msg);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        drmReady = false;
        drmChild = null;
        // Reject all pending requests
        for (const [, p] of drmPending) { clearTimeout(p.timeout); p.resolve({ type: 'error', error: 'DRM worker exited' }); }
        drmPending.clear();
        if (!drmReady) reject(new Error('DRM worker exited with code ' + code));
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        drmReady = false;
        drmChild = null;
        for (const [, p] of drmPending) { clearTimeout(p.timeout); p.resolve({ type: 'error', error: err.message }); }
        drmPending.clear();
        reject(new Error('DRM worker error: ' + err.message));
      });
    });
  }

  ipcMain.handle('drm-capture-start', async () => {
    if (drmChild && drmReady && drmDims) return { width: drmDims.width, height: drmDims.height };
    try {
      return await _drmSpawnWorker();
    } catch (e) {
      console.error('[drm] Worker failed:', e.message);
      throw e;
    }
  });

  ipcMain.handle('drm-capture-get-frame', async () => {
    if (!drmChild || !drmReady) throw new Error('DRM capture not started');
    const reqId = ++drmReqId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        drmPending.delete(reqId);
        reject(new Error('DRM get-frame timed out'));
      }, 5000);
      drmPending.set(reqId, { resolve, timeout });
      drmChild.postMessage({ type: 'get-frame', reqId });
    }).then(msg => {
      if (msg.type === 'frame' && msg.buf) {
        // Zero-copy: the worker transferred its frame buffer; wrap the memory
        // without copying (msg.buf is a Uint8Array view over the ArrayBuffer).
        const ab = msg.buf.buffer || msg.buf;
        const off = msg.buf.byteOffset || 0;
        const len = msg.buf.byteLength || ab.byteLength;
        return Buffer.from(ab, off, len);
      }
      if (msg.type === 'frame') return msg.data || null;
      throw new Error(msg.error || 'DRM get-frame failed');
    });
  });

  ipcMain.handle('drm-capture-stop', async () => {
    if (drmChild) {
      try { drmChild.postMessage({ type: 'stop' }); } catch { }
      setTimeout(() => { if (drmChild) { drmChild.terminate(); drmChild = null; drmReady = false; drmDims = null; } }, 1000);
    }
    drmReady = false;
    drmDims = null;
  });

  if (ctx.win && !ctx.win.isDestroyed()) {
    // ── UNIFIED CAPTURE HANDLER ──────────────────────────────────────────────
    // IMPORTANT: The callback MUST receive a real DesktopCapturerSource object
    // from getSources(). Passing a plain {id, name, ...} object works for the
    // desktop screen source but crashes Electron's media pipeline for any
    // window/application source (regression introduced in refactor from 3.0.1).
    // Fix: always call getSources() first, then find the selected source by ID.
    ctx.win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      // Thumbnail size 1x1 is sufficient — we just need the real source objects.
      desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } }).then(sources => {
        if (!sources || sources.length === 0) {
          console.log('[electron] Capture blocked or no sources found. Cancelling.');
          callback();
          if (ctx.win && !ctx.win.isDestroyed()) {
            ctx.win.webContents.executeJavaScript(`
            if (typeof _elDisabled === 'function') {
              _elDisabled('btnStart', false);
              _elDisabled('btnSwitch', false);
              _elDisabled('btnStop', true);
              if (typeof setCapDot === 'function') setCapDot('');
            }
            `).catch(() => { });
          }
          return;
        }

        // Consume any pending source selection from the picker UI
        let chosenSource = sources[0]; // default: first screen
        if (selectedSourceId) {
          const id = selectedSourceId;
          selectedSourceId = null;
          const match = sources.find(s => s.id === id);
          if (match) {
            chosenSource = match;
          } else {
            // ID no longer in source list (window closed etc.) — fall back to screen
            const firstScreen = sources.find(s => s.id.startsWith('screen:'));
            if (firstScreen) chosenSource = firstScreen;
            console.warn('[electron] Selected source ID not found, falling back to primary screen.');
          }
        }

        // WINDOWS AUDIO FIX: 'loopback' enables capturing desktop audio on Windows.
        // Do not pass audio on other platforms; PipeWire handles it separately.
        if (process.platform === 'win32') callback({ video: chosenSource, audio: 'loopback' });
        else callback({ video: chosenSource });
      }).catch(err => {
        console.error('[electron] Capturer error:', err);
        selectedSourceId = null; // discard stale selection on error
        callback();
        if (ctx.win && !ctx.win.isDestroyed()) {
          ctx.win.webContents.executeJavaScript(`
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
  }
}

module.exports = { registerIpcHandlers };

module.exports = { registerIpcHandlers };
