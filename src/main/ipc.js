const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync, exec, execSync } = require('child_process');
const {
  app, ipcMain, shell, clipboard, desktopCapturer,
  systemPreferences, dialog, nativeImage,
} = require('electron');
const { CONFIG_DIR, CONFIG_FILE, LOG_FILE, ROOT_DIR } = require('./config');
const { loadControllers, saveSettings } = require('./config');

let selectedSourceId = null;

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
    const pyScript = path.join(basePath, 'src', 'sidecar', 'input_backends', 'read_gamepads.py');
    const pyExec = process.platform === 'win32' ? path.join(basePath, 'bin', 'python', 'python.exe') : 'python3';
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

  ipcMain.handle('get-settings', () => ctx.settings);

  ipcMain.handle('get-vps-config', () => ({
    vpsEnabled: !!ctx.settings.vpsEnabled,
    vpsUrl: String(ctx.settings.vpsUrl || ''),
    vpsMasterKey: String(ctx.settings.vpsMasterKey || ''),
  }));

  ipcMain.handle('save-vps-config', (_, cfg) => {
    if (typeof cfg.vpsEnabled !== 'undefined') ctx.settings.vpsEnabled = !!cfg.vpsEnabled;
    if (typeof cfg.vpsUrl !== 'undefined') ctx.settings.vpsUrl = String(cfg.vpsUrl).slice(0, 512);
    if (typeof cfg.vpsMasterKey !== 'undefined') ctx.settings.vpsMasterKey = String(cfg.vpsMasterKey).slice(0, 256);
    saveSettings(ctx.settings);
    return {
      vpsEnabled: !!ctx.settings.vpsEnabled,
      vpsUrl: String(ctx.settings.vpsUrl || ''),
      vpsMasterKey: String(ctx.settings.vpsMasterKey || '')
    };
  });

  ipcMain.handle('get-controllers', () => loadControllers());

  ipcMain.handle('save-settings', (_, s) => {
    ctx.settings = Object.assign(ctx.settings, s);
    saveSettings(ctx.settings);
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send('settings-updated', ctx.settings);
    return ctx.settings;
  });

  ipcMain.handle('hydrate-settings', (_, patch) => {
    if (!patch || typeof patch !== 'object') return ctx.settings;
    ctx.settings = Object.assign(ctx.settings, patch);
    saveSettings(ctx.settings);
    return ctx.settings;
  });

  ipcMain.handle('get-config-path', () => CONFIG_FILE);

  ipcMain.handle('toggle-always-on-top', () => {
    ctx.settings.alwaysOnTop = !ctx.settings.alwaysOnTop;
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.setAlwaysOnTop(ctx.settings.alwaysOnTop);
    saveSettings(ctx.settings);
    return ctx.settings.alwaysOnTop;
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

  ipcMain.on('set-selected-source', (event, id) => {
    selectedSourceId = id;
  });

  ipcMain.on('run-setup', (event) => {
    if (os.platform() === 'win32') {
      let scriptPath = path.join(ROOT_DIR, 'bin', 'windows_setup.ps1');
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
      try { fs.chmodSync(scriptPath, 0o755); } catch (e) { console.warn('[Setup] chmod:', e.message); }

      const wrapperPath = path.join(os.tmpdir(), 'nearsec_setup_wrapper.sh');
      const statusFile = path.join(os.tmpdir(), 'nearsec_setup_status');
      const wrapperContent = `#!/bin/bash\nclear\necho "Starting Nearsec Setup..."\ncp "${scriptPath}" /tmp/nearsec_setup.sh\ncp "${iconPath}" /tmp/NearcadeLogo.png 2>/dev/null\nchmod +x /tmp/nearsec_setup.sh\nsudo bash /tmp/nearsec_setup.sh\nif [ $? -eq 0 ]; then echo "SUCCESS" > "${statusFile}"; else echo "FAIL" > "${statusFile}"; fi\necho ""\nread -p "Press Enter to close..."\n`;

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
      if (process.platform === 'win32' || process.platform === 'darwin') {
        if (typeof systemPreferences.getAccentColor === 'function') {
          const color = systemPreferences.getAccentColor();
          if (color) return '#' + color.slice(0, 6);
        }
      }
      if (process.platform === 'linux') {
        const out = execFileSync('dbus-send', [
          '--session', '--print-reply',
          '--dest=org.freedesktop.portal.Desktop',
          '/org/freedesktop/portal/desktop',
          'org.freedesktop.portal.Settings.ReadOne',
          'string:org.freedesktop.appearance',
          'string:accent-color',
        ], { timeout: 3000, encoding: 'utf-8' });
        const doubles = [...out.matchAll(/double\s+([\d.]+)/g)];
        if (doubles.length >= 3) {
          const r = Math.round(parseFloat(doubles[0][1]) * 255).toString(16).padStart(2, '0');
          const g = Math.round(parseFloat(doubles[1][1]) * 255).toString(16).padStart(2, '0');
          const b = Math.round(parseFloat(doubles[2][1]) * 255).toString(16).padStart(2, '0');
          return `#${r}${g}${b}`;
        }
      }
    } catch (_) { }
    return '#8b5cf6';
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
    if (ctx.isWebCodecs) captureParams.push('wc=1');
    if (ctx.isFFmpegCapture) captureParams.push('ffmpeg=1');
    const qs = captureParams.length ? '?' + captureParams.join('&') : '';
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.loadURL(`http://localhost:${ctx.serverPort}${route}${qs}`);
  });

  ipcMain.handle('read-doc', async (event, filename) => {
    if (!filename || filename.includes('..') || filename.includes('/')) throw new Error('Invalid filename');
    return fs.promises.readFile(path.join(ROOT_DIR, 'src', 'docs', filename), 'utf8');
  });

  ipcMain.on('back-to-dashboard-from-host', () => {
    if (ctx.win && !ctx.win.isDestroyed()) {
      ctx.win.loadURL(`http://localhost:${ctx.serverPort}/dashboard?port=${ctx.serverPort}&noAutoHost=1`);
    }
  });

  ipcMain.on('back-to-dashboard', () => {
    if (ctx.win && !ctx.win.isDestroyed()) {
      ctx.win.loadURL(`http://localhost:${ctx.serverPort}/dashboard?port=${ctx.serverPort}&noAutoHost=1`);
    }
  });

  ipcMain.handle('check-system-setup', () => {
    if (ctx.settings.firstRunComplete || ctx.settings.neverBotherSetup) return { needsSetup: false };
    let artifactsFound = false;
    try {
      if (process.platform === 'linux') {
        artifactsFound = fs.existsSync('/etc/udev/rules.d/99-nearsec-input.rules');
      }
    } catch (_) {}

    if (artifactsFound) {
      ctx.settings.firstRunComplete = true;
      ctx.settings.neverBotherSetup = true;
      saveSettings(ctx.settings);
      return { needsSetup: false };
    }
    return { needsSetup: true };
  });

  ipcMain.on('continue-boot', () => {
    ctx.settings.firstRunComplete = true;
    ctx.settings.neverBotherSetup = true;
    saveSettings(ctx.settings);
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
      try { fs.chmodSync(destPath, 0o755); } catch (_) {}
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
        } catch (_) {}
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
    shell.openPath(ROOT_DIR);
  });

  ipcMain.on('window-close', () => { if (ctx.win && !ctx.win.isDestroyed()) ctx.win.close(); });
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

  ipcMain.on('discord-set-activity', (event, activity) => {
    console.log('[Discord RPC] Requested activity:', JSON.stringify(activity));
    if (!ctx.settings.discordRPC) {
      console.log('[Discord RPC] Aborted because settings.discordRPC is false');
      return;
    }
    latestActivity = activity;

    if (!rpc) {
      console.log('[Discord RPC] Initializing new client...');
      const DiscordRPC = require('discord-rpc');
      rpc = new DiscordRPC.Client({ transport: 'ipc' });

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

  if (ctx.win && !ctx.win.isDestroyed()) {
    ctx.win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
        if (sources && sources.length > 0) {
          let chosenSource = sources[0];
          if (selectedSourceId) {
            const match = sources.find(s => s.id === selectedSourceId);
            if (match) chosenSource = match;
            selectedSourceId = null;
          }
          if (process.platform === 'win32') callback({ video: chosenSource, audio: 'loopback' });
          else callback({ video: chosenSource });
        } else {
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
        }
      }).catch(err => {
        console.error('[electron] Capturer error:', err);
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
