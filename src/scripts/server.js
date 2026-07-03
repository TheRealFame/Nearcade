const express = require("express");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const crypto = require('crypto');
require('dotenv').config();
const si = require('systeminformation');

// Helper to anonymize IPs so we never store them
function hashIp(ip) { return crypto.createHash('sha256').update(ip).digest('hex'); }
const os = require("os");

// --- STREAMER PRIVACY SCRUBBER ---
const _origLog = console.log;
console.log = function (...args) {
  let msg = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a, null, 2); } catch (_) { return String(a); }
  }).join(' ');
  
  // Blur IPv4 addresses (except localhost)
  msg = msg.replace(/\b(?!127\.0\.0\.1)(?:\d{1,3}\.){3}\d{1,3}\b/g, '***.***.***.***');
  
  // Blur Cloudflare tunnel URLs
  msg = msg.replace(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g, 'https://********.trycloudflare.com');
  
  // Blur Zrok / Playit / localhost.run / serveo URLs
  msg = msg.replace(/https:\/\/[a-zA-Z0-9-]+\.(share\.zrok\.io|playit\.gg|lhr\.life|serveo\.net)/g, 'https://********.$1');
  
  // Blur VPS SSH strings
  msg = msg.replace(/([a-zA-Z0-9_-]+@\*\*\*\.\*\*\*\.\*\*\*\.\*\*\*)/g, '********@***.***.***.***');

  // Blur VPS Master Key (64-char hex)
  msg = msg.replace(/("?vpsMasterKey"?\s*:\s*['"]?)[a-fA-F0-9]{64}(['"]?)/g, '$1********$2');

  // Blur Session Password
  msg = msg.replace(/("?sessionPassword"?\s*:\s*['"]?)[^'"\s,]+(['"]?)/g, '$1********$2');

  // Blur global PIN
  if (typeof PIN !== 'undefined' && PIN) {
    msg = msg.replace(new RegExp(PIN, 'g'), '****');
  }

  _origLog.call(console, msg);
};

const net = require("net");
const fs = require("fs");
const path = require('path');
const sidecarPath = __dirname.includes('app.asar')
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'sidecar', 'input_driver.py')
  : path.join(__dirname, "..", "sidecar", "input_driver.py");
const { exec, spawn } = require("child_process");
const open = (...args) => import('open').then(({ default: open }) => open(...args));
const which = require("which");
const killPort = require("kill-port");
const captureManager = require('../sidecar/CaptureManager.js');
let activePort = 3000;
let hostWS = null;
let tunnelUrl = null;
let activeTunnelProc = null;
let uinputProc = null;
let audioProc = null;
let vidCount = 0;
const viewers = new Map();
const viewerNames = new Map();
const inputPerms = new Map();
const pinAttempts = new Map();

const { Worker } = require('worker_threads');

const PusherRaw = require('pusher-js');

const isPackaged = __dirname.includes('app.asar');
const inputDriver = require('../sidecar/input_backends/InputOrchestrator.js');
// ══════════════════════════════════════════════════════════════════════════════
// VIRTUAL AUDIO — delegated to audio_worker.js via worker_threads IPC
// The main event loop never calls pactl directly; all blocking OS shell work
// runs in the dedicated worker thread.
// ══════════════════════════════════════════════════════════════════════════════

// Prevents cleanup() running twice (e.g. SIGINT fires then process.exit fires)
let _cleanupDone = false;

// Module IDs are reported back by the worker so cleanup() can unload them
// synchronously via execSync if the worker has already exited by SIGINT time.
const _vAudioModules = { sink: null, remap: null, loopback: null, daemonHandle: null };

// Holds a reference to the running audio worker
let _audioWorker = null;

// ── Spawn and wire the audio worker ──────────────────────────────────────────
function spawnAudioWorker() {
  if (process.platform !== 'linux') return;

  const daemonPath = path.join(__dirname, '..', 'sidecar', 'audio_blacklist_daemon.js');

  _audioWorker = new Worker(path.join(__dirname, '..', 'sidecar', 'audio_worker.js'), {
    workerData: {
      isPackaged,
      daemonPath: fs.existsSync(daemonPath) ? daemonPath : null,
    }
  });

  _audioWorker.on('message', (msg) => {
    switch (msg.type) {
      case 'log': console.log(msg.message); break;
      case 'error': console.error(msg.message); break;
      case 'module-ids': Object.assign(_vAudioModules, msg.ids); break;
      case 'ready': console.log('[VirtualAudio] Worker ready.'); break;
      case 'destroyed': console.log('[VirtualAudio] Worker teardown complete.'); break;
      case 'backend-selected': console.log(`[VirtualAudio] Using ${msg.backend} backend.`); break;
    }
  });

  _audioWorker.on('error', (e) => console.error('[audio_worker] Runtime error:', e.message));
  _audioWorker.on('exit', (code) => {
    if (code !== 0) console.warn(`[audio_worker] Exited with code ${code}`);
    _audioWorker = null;
  });

  _audioWorker.postMessage({ type: 'init' });
}

/**
 * PUBLIC — Create all virtual audio modules in sequence.
 * Attempts PipeWire native (pw-loopback) first for zero-latency capture.
 * Falls back to PulseAudio (pactl) if PipeWire is unavailable.
 * Delegates heavy shell work to audio_worker.js.
 */
function initVirtualAudio(callback) {
  if (process.platform !== 'linux') {
    if (callback) callback(false, 'Linux only');
    return;
  }

  if (!_audioWorker) {
    spawnAudioWorker();
  } else {
    _audioWorker.postMessage({ type: 'init' });
  }

  // Probe PipeWire availability and pass the result to the worker
  // so it can choose the right capture path without the main thread blocking.
  const { execFile } = require('child_process');
  execFile('pw-cli', ['info', 'all'], { timeout: 2000 }, (err) => {
    const pwAvailable = !err;
    if (_audioWorker) {
      _audioWorker.postMessage({ type: 'set-audio-backend', pipewire: pwAvailable });
      console.log(`[VirtualAudio] Backend probe: ${pwAvailable ? 'PipeWire (native)' : 'PulseAudio (legacy)'}`);
    }
  });

  if (callback && _audioWorker) {
    const onMsg = (msg) => {
      if (msg.type === 'ready') {
        _audioWorker && _audioWorker.off('message', onMsg);
        callback(true);
      } else if (msg.type === 'error') {
        _audioWorker && _audioWorker.off('message', onMsg);
        callback(false, msg.message);
      }
    };
    _audioWorker.on('message', onMsg);
  }
}

/**
 * PUBLIC — Route game audio (delegates to worker).
 */
function routeGameAudio(gameProcessName) {
  if (_audioWorker) _audioWorker.postMessage({ type: 'route', processName: gameProcessName || null });
}

// Call it on boot
// ── Venmic must init BEFORE virtual audio so pb is ready when the sink
// appears in the PipeWire graph. initVirtualAudio() is async — we start it
// here but let venmic load synchronously first.

// Now create the sink — venmic is already listening to the PipeWire graph
initVirtualAudio();

// ── Bulletproof Electron/Node Module Extractor ──
let Pusher;
if (typeof PusherRaw === 'function') {
  Pusher = PusherRaw;
} else if (PusherRaw && typeof PusherRaw.Pusher === 'function') {
  Pusher = PusherRaw.Pusher;
} else if (PusherRaw && typeof PusherRaw.default === 'function') {
  Pusher = PusherRaw.default;
} else {
  console.error("PUSHER DIAGNOSTIC:", PusherRaw);
  Pusher = class DummyPusher {
    subscribe() { return { trigger: () => { } }; }
  };
}

const pusher = new Pusher('a93f5405058cd9fc7967', {
  cluster: 'us2',
  authEndpoint: 'https://nearsec.cutefame.net/api/pusher-auth'
});

const globalArcadeChannel = pusher.subscribe('private-arcade-global');

// ── Arcade Heartbeat Worker ───────────────────────────────────────────────────
// All arcadePingInterval / Pusher sync loops run in a dedicated thread so they
// can never delay the signaling event loop, even under heavy load.
let _arcadeWorker = null;

function spawnArcadeHeartbeatWorker() {
  _arcadeWorker = new Worker(path.join(__dirname, '..', 'sidecar', 'arcade_heartbeat_worker.js'), {
    workerData: { syncIntervalMs: 30_000, pingIntervalMs: 25_000 }
  });

  _arcadeWorker.on('message', (msg) => {
    switch (msg.type) {
      case 'log': console.log(msg.message); break;
      case 'error': console.error(msg.message); break;

      // Worker asks main thread to fire the Pusher trigger
      // (pusher-js channels must live on the thread that owns the WebSocket)
      case 'pusher-trigger':
        try {
          if (typeof globalArcadeChannel !== 'undefined') {
            globalArcadeChannel.trigger(msg.event, msg.data);
          }
        } catch (e) {
          console.warn('[arcade_heartbeat] Pusher trigger failed:', e.message);
        }
        break;
    }
  });

  _arcadeWorker.on('error', (e) => console.error('[arcade_heartbeat] Runtime error:', e.message));
  _arcadeWorker.on('exit', (code) => {
    if (code !== 0) console.warn(`[arcade_heartbeat] Exited with code ${code}`);
    _arcadeWorker = null;
  });
}

// Helper — post to arcade worker only when it's alive
function _arcadePost(msg) {
  if (_arcadeWorker) _arcadeWorker.postMessage(msg);
}

// Boot the worker immediately (it idles quietly until a session goes active)
spawnArcadeHeartbeatWorker();

function toUinput(msg) {
  // The Orchestrator handles routing to either the native binary or the Python stdin
  inputDriver.send(msg);
}

// ── Gamepad Wire-Format Normalizer ───────────────────────────────────────────
// viewer.js sends the raw Gamepad API format:
//   axes:    [lx, ly, rx, ry, ...]  as int16 (-32767..+32767)
//   buttons: [{pressed, value}...]  value is 0-255 int
// InputOrchestrator._handleGamepad expects NAMED scalar fields:
//   lx, ly, rx, ry  → int16 passed straight through to C++ buffer
//   lt, rt          → float 0..1
//   buttons         → 16-bit bitmask in JS viewer layout
//
// If msg already has named fields (Python path) it is returned as-is.
function normalizeGamepadMsg(msg) {
  // Already normalized — named axes present, nothing to do
  if (msg.lx !== undefined || !Array.isArray(msg.axes)) return msg;

  const axes = msg.axes || [];
  const btns = msg.buttons || [];

  // ── STRICT DATA VALIDATION REWRITE ──
  // Actively drop malformed or maliciously large data chunks.
  // NOTE: We do NOT reject empty arrays — an all-zero/rest state is
  // still valid and MUST be processed so that _claimSlot runs for new viewers.
  if (axes.length > 20 || btns.length > 40) {
    console.warn(`[input_validator] REJECTED: Gamepad API arrays exceed maximum size. Axes: ${axes.length}, Buttons: ${btns.length}`);
    return null;
  }

  // Axes arrive as int16 (-32767..+32767) — pass directly.
  // _validateGamepadMsg → _clampAxis handles range clamping.
  const lx = Number(axes[0]) || 0;
  const ly = Number(axes[1]) || 0;
  const rx = Number(axes[2]) || 0;
  const ry = Number(axes[3]) || 0;

  // Triggers: buttons[6]=LT, buttons[7]=RT (viewer encodes value 0-255)
  const lt = (Number((btns[6] && btns[6].value) || 0)) / 255;
  const rt = (Number((btns[7] && btns[7].value) || 0)) / 255;

  //  W3C Gamepad API index → JS viewer bitmask (correct per W3C spec)
  const W3C_TO_JS = [
    0x0001, // 0  A (South)
    0x0002, // 1  B (East)
    0x0004, // 2  X (West)
    0x0008, // 3  Y (North)
    0x0100, // 4  LB
    0x0200, // 5  RB
    0,      // 6  LT — handled as lt float above
    0,      // 7  RT — handled as rt float above
    0x2000, // 8  Select / Back
    0x1000, // 9  Start
    0x0400, // 10 L3
    0x0800, // 11 R3
    0x0010, // 12 D-Up
    0x0020, // 13 D-Down
    0x0040, // 14 D-Left
    0x0080, // 15 D-Right
    0x4000, // 16 Guide / Home
  ];
  let buttons = 0;
  for (let i = 0; i < btns.length && i < W3C_TO_JS.length; i++) {
    if (!W3C_TO_JS[i]) continue;
    if (btns[i] && (btns[i].pressed || btns[i].value > 127)) buttons |= W3C_TO_JS[i];
  }

  return {
    ...msg,
    axes, btns, // Preserving varying length arrays for python sidecar
    lx, ly, rx, ry, lt, rt, buttons,
  };
}

const projectRoot = path.join(__dirname, '..', '..');

// ── Safe App Data Pathing for Production ASAR ──
function getSafeDataDir() {
  const home = os.homedir();
  let p;
  if (process.platform === 'win32') p = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'NearsecTogether');
  else if (process.platform === 'darwin') p = path.join(home, 'Library', 'Application Support', 'NearsecTogether');
  else p = path.join(home, '.config', 'NearsecTogether');

  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

const dataDir = getSafeDataDir();
const envFile = path.join(dataDir, '.env');

// ── Convenience symlink for source-code devs ──────────────────────────────────
// Creates config/nearsectogether.config.json → ~/.config/NearsecTogether/…
// so you can always find/edit the live config right inside the project tree.
// Windows symlinks require elevated privilege — skip on win32.
(function ensureConfigSymlink() {
  if (process.platform === 'win32' || isPackaged) return;
  try {
    // Walk up from src/scripts to find the project root (two levels up)
    const projectRoot = path.resolve(__dirname, '..', '..');
    const configDir = path.join(projectRoot, 'config');
    const symlinkPath = path.join(configDir, 'nearsectogether.config.json');
    const realTarget = path.join(dataDir, 'nearsectogether.config.json');
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    try {
      const existing = fs.lstatSync(symlinkPath);
      // Remove stale symlinks or wrong files before re-creating
      if (existing.isSymbolicLink() && fs.realpathSync(symlinkPath) !== realTarget) {
        fs.unlinkSync(symlinkPath);
      } else if (!existing.isSymbolicLink()) {
        return; // A real file exists there — don't clobber it
      } else {
        return; // Already correct
      }
    } catch (_) { /* doesn't exist yet — fall through to create */ }
    fs.symlinkSync(realTarget, symlinkPath);
    console.log('[config] Symlink: config/nearsectogether.config.json → ' + realTarget);
  } catch (e) {
    // Non-fatal — just a convenience helper
    console.warn('[config] Could not create config symlink:', e.message);
  }
})();

if (!fs.existsSync(envFile)) {
  try {
    fs.writeFileSync(envFile, `CF_TOKEN=\nCUSTOM_URL=\nZROK_RESERVED_NAME=\nUSE_VPS=false\nVPS_HOST=\nIS_VPS=false\n`);
  } catch (e) { console.warn("[env] Could not create .env file:", e.message); }
}

try {
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) process.env[match[1]] = (match[2] || '').trim().replace(/^['"]|['"]$/g, '');
    });
  }
} catch (e) { }

function getLanIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const n of iface)
      if (n.family === "IPv4" && !n.internal) return n.address;
  return "127.0.0.1";
}
function shouldRequirePin(ip, hasTunnelHeader = false) {
  // REQ 5: Arcade Mode PIN Stripping
  if (process.argv.includes('--arcade-worker')) return false;

  if (!ip) return true;
  if (ip.startsWith('192.168.') || ip.startsWith('::ffff:192.168.')) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    if (hasTunnelHeader || process.env.USING_TUNNEL === 'true') return true;
    return false;
  }
  if (ip.startsWith('100.')) return false;
  return true;
}
function getTailscaleIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const n of iface)
      if (n.family === "IPv4" && n.address.startsWith("100.")) return n.address;
  return null;
}
function findFreePort(start) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(start, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", () => findFreePort(start + 1).then(resolve));
  });
}
function openBrowser(url) {
  open(url).catch(() => { });
}
function getPublicIP() {
  return new Promise(resolve => {
    https.get("https://api.ipify.org", res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d.trim()));
    }).on("error", () => resolve(null));
  });
}

// ── Binary path resolver ─────────────────────────────────────────────
const FALLBACK_PATHS = {
  cloudflared: [
    path.join(os.homedir(), 'cloudflared.exe'),
    path.join(os.homedir(), 'bin', 'cloudflared.exe'),
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(os.homedir(), 'cloudflared'),
    path.join(os.homedir(), 'bin', 'cloudflared'),
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared'
  ],
  zrok: [
    path.join(os.homedir(), 'zrok', 'zrok.exe'),
    path.join(os.homedir(), 'bin', 'zrok.exe'),
    path.join(os.homedir(), 'zrok', 'zrok'),
    path.join(os.homedir(), 'bin', 'zrok')
  ],
  playit: [
    path.join(os.homedir(), 'playit.exe'),
    path.join(os.homedir(), 'bin', 'playit.exe'),
    path.join(os.homedir(), 'playit'),
    path.join(os.homedir(), 'bin', 'playit')
  ],
  ssh: [
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
    '/usr/bin/ssh'
  ],
};

function findBinaryPath(name) {
  return which(name).then(p => p).catch(() => {
    const fallbacks = FALLBACK_PATHS[name] || [];
    for (const p of fallbacks) {
      if (fs.existsSync(p)) {
        console.log(`  [tunnel] Found ${name} at fallback path: ${p}`);
        return p;
      }
    }
    return null;
  });
}
// ── Tunnel providers ─────────────────────────────────────────────────────────

// Native fallback reader since dotenv is not in package dependencies
function readEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (let line of lines) {
        if (line.trim().startsWith(key + '=')) {
          return line.split('=')[1].trim();
        }
      }
    }
  } catch (e) { }
  return null;
}

function ensureExecutable(binPath) {
  if (!binPath) return;
  // System package paths are already executable and root-owned — chmod would EPERM.
  const sysPaths = ['/usr/bin/', '/usr/local/bin/', '/bin/', '/sbin/', '/usr/sbin/'];
  if (sysPaths.some(p => binPath.startsWith(p))) return;
  try { fs.chmodSync(binPath, 0o755); } catch (e) { console.warn('[chmod]', binPath, e.message); }
}

function startTunnelCloudflared(port) {
  return new Promise(resolve => {
    findBinaryPath('cloudflared').then(cloudflaredPath => {
      if (!cloudflaredPath) { resolve({ error: 'NOT_FOUND', provider: 'cloudflared' }); return; }
      ensureExecutable(cloudflaredPath);

      const cfToken = readEnv('CF_TOKEN');
      if (cfToken) {
        console.log("  \x1b[33m~\x1b[0m Starting persistent Cloudflare tunnel (Token)...");
        // Force HTTP2 to bypass UDP/QUIC blocks on Linux
        const proc = spawn(cloudflaredPath, ["tunnel", "--no-autoupdate", "--url", "http://localhost:" + port], { stdio: ["ignore", "pipe", "pipe"] });
        const url = (readEnv('CUSTOM_URL') || "https://your-custom-domain.com").replace(/\/$/, "") + '/?v3';
        console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
        activeTunnelProc = proc;
        return resolve({ url, proc });
      }

      const cfName = readEnv('CF_TUNNEL_NAME');
      if (cfName) {
        console.log("  \x1b[33m~\x1b[0m Starting persistent Cloudflare tunnel (Locally Managed)...");
        const proc = spawn(cloudflaredPath, ["tunnel", "--no-autoupdate", "--protocol", "http2", "run", cfName], { stdio: ["ignore", "pipe", "pipe"] });
        const url = (readEnv('CUSTOM_URL') || "https://your-custom-domain.com").replace(/\/$/, "") + '/?v3';
        console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
        activeTunnelProc = proc;
        return resolve({ url, proc });
      }

      console.log("  \x1b[33m~\x1b[0m Starting cloudflared tunnel...");
      console.log("  \x1b[31m!\x1b[0m WARNING: Free Cloudflare tunnels (trycloudflare.com) are currently heavily restricted by Cloudflare.");
      console.log("  \x1b[31m!\x1b[0m If your URL returns a 404 Not Found, Cloudflare has blocked the connection at their edge.");
      console.log("  \x1b[31m!\x1b[0m If this happens, please use Zrok instead (\x1b[36mTUNNEL=zrok node server.js\x1b[0m).");

      // CRITICAL FIX: Force HTTP2 and strictly bind to 127.0.0.1 to avoid IPv6 mismatches and QUIC drops
      const proc = spawn(cloudflaredPath, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", "http://127.0.0.1:" + port], { stdio: ["ignore", "pipe", "pipe"] });
      let done = false;
      const check = data => {
        const m = data.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m && !done) {
          done = true;
          activeTunnelProc = proc;
          const url = m[0] + '/?v3';
          console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
          resolve({ url: url, proc });
        }
      };
      proc.stderr.on("data", check);

      proc.on("error", () => { if (!done) { done = true; resolve(null); } });
      proc.on("close", () => { if (!done) { done = true; resolve(null); } });
    });
  });
}

function startTunnelVps(port, vpsHost) {
  return new Promise((resolve) => {
    if (!vpsHost || vpsHost.trim() === '') {
      console.log("  \x1b[31m~\x1b[0m VPS Host missing. Check your .env or GUI settings.");
      return resolve(null);
    }

    findBinaryPath('ssh').then(sshPath => {
      if (!sshPath) { resolve(null); return; }

      console.log(`  \x1b[33m~\x1b[0m Clearing ghost ports on VPS...`);

      const killCmd = spawn(sshPath, [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        vpsHost,
        `fuser -k ${port}/tcp || true`
      ]);

      killCmd.on('close', () => {
        console.log(`  \x1b[33m~\x1b[0m Starting VPS Reverse SSH Tunnel to ${vpsHost}...`);

        const proc = spawn(sshPath, [
          "-v", "-N", "-T",
          "-o", "ExitOnForwardFailure=yes",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "ServerAliveInterval=15",
          "-o", "ServerAliveCountMax=3",
          "-R", `0.0.0.0:${port}:127.0.0.1:${port}`, vpsHost
        ], { stdio: ["ignore", "pipe", "pipe"] });

        const customEnvUrl = readEnv('CUSTOM_URL');
        let url = (customEnvUrl && customEnvUrl.trim() !== '')
          ? customEnvUrl.trim().replace(/\/$/, "")
          : `http://${vpsHost.split('@').pop().trim()}:${port}`;

        // CRITICAL FIX: Append /?v3 for Discord Integration
        url += '/?v3';

        let done = false;

        proc.stderr.on("data", data => {
          const out = data.toString();
          if ((out.includes("remote forward success") || out.includes("Forwarding address")) && !done) {
            done = true;
            activeTunnelProc = proc;
            console.log("  \x1b[32m✓\x1b[0m VPS Tunnel URL: \x1b[1m" + url + "\x1b[0m");
            resolve({ url, proc });
          }
        });

        proc.on("error", () => { if (!done) { done = true; resolve(null); } });
        proc.on("close", () => { if (!done) { done = true; resolve(null); } });
      });
    });
  });
}

function startTunnelPlayit(port) {
  return new Promise(resolve => {
    findBinaryPath('playit').then(playitPath => {
      if (!playitPath) { resolve(null); return; }
      ensureExecutable(playitPath);

      console.log("  \x1b[33m~\x1b[0m Starting playit tunnel...");
      const proc = spawn(playitPath, [], { stdio: ["ignore", "pipe", "pipe"] });
      let done = false;
      const check = data => {
        const str = data.toString();
        const claim = str.match(/https:\/\/playit\.gg\/claim\/[a-z0-9\-]+/i);
        if (claim) { console.log("  \x1b[33m!\x1b[0m playit first-run — visit: \x1b[1m" + claim[0] + "\x1b[0m"); openBrowser(claim[0]); }
        const url = str.match(/https?:\/\/[a-z0-9\-]+\.at\.playit\.gg(?::\d+)?/i)
          || str.match(/https?:\/\/[a-z0-9\-]+\.playit\.gg(?::\d+)?/i);
        if (url && !done) { done = true; resolve({ url: url[0], proc }); console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url[0] + "\x1b[0m"); }
      };
      proc.stdout.on("data", check); proc.stderr.on("data", check);
      proc.on("close", () => { if (!done) resolve(null); });
      setTimeout(() => { if (!done) { done = true; resolve(null); console.log("  \x1b[33m!\x1b[0m playit timeout"); } }, 45000);
    }).catch(() => resolve(null));
  });
}

function startTunnelLocalhostRun(port) {
  return new Promise(resolve => {
    findBinaryPath('ssh').then(sshPath => {
      if (!sshPath) { resolve(null); return; }

      console.log("  \x1b[33m~\x1b[0m Starting localhost.run tunnel (SSH)...");
      const proc = spawn(sshPath, [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "ServerAliveInterval=30",
        "-R", "80:localhost:" + port,
        "nokey@localhost.run"
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let done = false;
      const check = data => {
        const m = data.toString().match(/https:\/\/[a-z0-9\-]+\.(?:lhr\.life|localhost\.run)/);
        if (m && !done) { done = true; resolve({ url: m[0], proc }); console.log("  \x1b[32m\u2713\x1b[0m Tunnel URL: \x1b[1m" + m[0] + "\x1b[0m"); }
      };
      proc.stdout.on("data", check); proc.stderr.on("data", check);
      proc.on("close", c => { if (!done) { resolve(null); console.log("  \x1b[33m!\x1b[0m localhost.run closed (code " + c + ")"); } });
      setTimeout(() => { if (!done) { done = true; proc.kill(); resolve(null); console.log("  \x1b[33m!\x1b[0m localhost.run timeout — port 22 may be blocked"); } }, 25000);
    }).catch(() => resolve(null));
  });
}

function startTunnelServeo(port) {
  return new Promise(resolve => {
    findBinaryPath('ssh').then(sshPath => {
      if (!sshPath) { resolve(null); return; }

      console.log("  \x1b[33m~\x1b[0m Starting serveo.net tunnel (SSH)...");
      const proc = spawn(sshPath, [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "ServerAliveInterval=30",
        "-R", "80:localhost:" + port,
        "serveo.net"
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let done = false;
      const check = data => {
        const m = data.toString().match(/https:\/\/[a-z0-9\-]+\.serveo\.net/);
        if (m && !done) { done = true; resolve({ url: m[0], proc }); console.log("  \x1b[32m\u2713\x1b[0m Tunnel URL: \x1b[1m" + m[0] + "\x1b[0m"); }
      };
      proc.stdout.on("data", check); proc.stderr.on("data", check);
      proc.on("close", c => { if (!done) { resolve(null); console.log("  \x1b[33m!\x1b[0m serveo closed (code " + c + ")"); } });
      setTimeout(() => { if (!done) { done = true; proc.kill(); resolve(null); console.log("  \x1b[33m!\x1b[0m serveo timeout — port 22 may be blocked"); } }, 25000);
    }).catch(() => resolve(null));
  });
}

function startTunnelZrok(port, retries = 3) {
  return new Promise(async (resolve) => {
    const zrokPath = await findBinaryPath('zrok').then(p => p).catch(() => null)
      || await findBinaryPath('zrok2').then(p => p).catch(() => null)
      || (function () {
        const candidates = [
          '/usr/bin/zrok2', '/usr/bin/zrok', '/usr/local/bin/zrok',
          path.join(os.homedir(), 'bin/zrok'), './zrok',
          path.join(os.homedir(), 'zrok', 'zrok.exe'),
        ];
        for (const c of candidates) if (fs.existsSync(c)) return c;
        return null;
      })();

    if (!zrokPath) { resolve({ error: 'NOT_FOUND', provider: 'zrok' }); return; }
    ensureExecutable(zrokPath);

    console.log(`  \x1b[33m~\x1b[0m Starting zrok public share (${zrokPath})... (Retries left: ${retries})`);
    const args = ["share", "public", "http://localhost:" + port, "--backend-mode", "proxy", "--headless"];
    const proc = spawn(zrokPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let done = false;
    const check = data => {
      const out = data.toString();
      const m = out.match(/(https:\/\/)?([a-z0-9\-]+\.shares?\.zrok\.io)/i);
      if (m && !done) {
        done = true;
        const url = m[1] ? m[0] : "https://" + m[2];
        process.env.USING_TUNNEL = "true";
        activeTunnelProc = proc; resolve({ url, proc });
        console.log("  \x1b[32m\u2713\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
      }
    };
    proc.stdout.on("data", check); proc.stderr.on("data", check);
    proc.on("close", c => {
      if (!done) {
        console.log("  \x1b[33m!\x1b[0m zrok share failed or closed (code " + c + ")");
        if (retries > 0) {
          console.log("  \x1b[33m~\x1b[0m Retrying Zrok tunnel in 3 seconds...");
          setTimeout(() => resolve(startTunnelZrok(port, retries - 1)), 3000);
        } else {
          resolve(null);
        }
      }
    });
    setTimeout(() => {
      if (!done) {
        done = true; proc.kill();
        if (retries > 0) {
          console.log("  \x1b[33m~\x1b[0m Zrok timeout. Retrying in 3 seconds...");
          setTimeout(() => resolve(startTunnelZrok(port, retries - 1)), 3000);
        } else {
          resolve(null);
          console.log("  \x1b[33m!\x1b[0m zrok share timeout.");
        }
      }
    }, 20000);
  }).catch(() => null);
}

async function startTunnel(port) {
  const forced = (process.env.TUNNEL || "").toLowerCase();
  if (forced === "zrok") return startTunnelZrok(port);
  if (forced === "vps") return startTunnelVps(port, process.env.VPS_HOST);
  if (forced === "cloudflared") return startTunnelCloudflared(port);
  if (forced === "playit") return startTunnelPlayit(port);
  if (forced === "localhostrun") return startTunnelLocalhostRun(port);
  if (forced === "serveo") return startTunnelServeo(port);
  // Auto: try cloudflared → zrok → playit → SSH providers
  const cf = await startTunnelCloudflared(port);
  if (cf) return cf;
  const z = await startTunnelZrok(port);
  if (z) return z;
  const pl = await startTunnelPlayit(port);
  if (pl) return pl;
  console.log("  \x1b[33m~\x1b[0m Trying localhost.run and serveo in parallel...");
  const ssh = await Promise.any([
    startTunnelLocalhostRun(port),
    startTunnelServeo(port)
  ].map(p => p.then(r => r || Promise.reject()))).catch(() => null);
  if (ssh) return ssh;
  console.log("  \x1b[33m!\x1b[0m All tunnels failed. Options:");
  console.log("    cloudflared  : https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  console.log("    serveo/lhr   : outbound SSH (port 22) may be blocked by your router/ISP");
  console.log("    TUNNEL=cloudflared  node server.js   # force a specific provider");
  return null;
}

function sanitize(str) {
  return String(str).replace(/[<>&"']/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])).slice(0, 300);
}
function makePin() { 
  return String(crypto.randomInt(1000, 10000));
}

// ── Arcade session registry ───────────────────────────────────────────────────
const arcadeSessions = new Map();
const arcadeClients = new Set();
let arcadeHostId = 0;

const ARCADE_ALLOWED_DOMAINS = [
  'trycloudflare.com',
  'zrok.io',
  'localhost.run',
  'serveo.net',
];
function isAllowedArcadeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    return ARCADE_ALLOWED_DOMAINS.some(d =>
      u.hostname === d || u.hostname.endsWith('.' + d)
    );
  } catch { return false; }
}
function broadcastToArcade(msg) {
  const data = JSON.stringify(msg);
  arcadeClients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// ── Persistent config ────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(dataDir, 'nearsectogether.config.json');
function loadConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return data && typeof data === 'object' ? data : {};
  } catch (e) { return {}; }
}
function saveConfig(updates) {
  try {
    const cfg = { ...loadConfig(), ...updates };
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8', flag: 'w' });
    console.log("[config] Saved tunnel preference:", cfg);
    return cfg;
  } catch (e) {
    console.error("[config] Error saving config:", e.message);
    return {};
  }
}

async function main() {
  // ── Platform Detection & Warnings ──────────────────────────────────────────
  console.log("");
  if (process.platform === 'win32') {
    console.log("============================================================");
    console.log("  WINDOWS - EXPERIMENTAL MODE");
    console.log("============================================================");
    console.log("  GAMEPAD:  Requires ViGEmBus driver");
    console.log("            https://github.com/nefarius/ViGEmBus/releases");
    console.log("  INPUT:    KBM (keyboard/mouse) working");
    console.log("  AUDIO:    No loopback capture available natively");
    console.log("  NOTES:    Process priority may be limited without admin");
    console.log("============================================================");
  } else if (process.platform === 'darwin') {
    console.log("============================================================");
    console.log("  macOS - EXPERIMENTAL MODE");
    console.log("============================================================");
    console.log("  GAMEPAD:  NOT SUPPORTED (no injection API on macOS)");
    console.log("  INPUT:    KBM only (keyboard/mouse via pyautogui)");
    console.log("  AUDIO:    Using afplay (native)");
    console.log("  SETUP:    pip3 install pyautogui");
    console.log("============================================================");
  } else if (process.platform === 'linux') {
    console.log("✓ Linux - Fully supported (stable)");
  }
  console.log("");

  activePort = await findFreePort(3000);
  const PORT = activePort;
  const LAN_IP = getLanIP();
  const PUBLIC_IP = await getPublicIP();
  const initialCfg = loadConfig();
  let sessionPassword = initialCfg.persistentPassword || '';
  let PIN = sessionPassword ? sessionPassword : makePin();
  let pinEnabled = true;

  console.log("\n  \x1b[1mNearsecTogether\x1b[0m");
  console.log("  Host page : http://localhost:" + PORT + "/host");
  console.log("  LAN URL   : http://***.***.***.***:" + PORT + "/");
  if (PUBLIC_IP) console.log("  Public IP : http://***.***.***.***:" + PORT + "/ (needs port forward)");
  console.log("  PIN       : \x1b[1;32m****\x1b[0m\n");

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, perMessageDeflate: false });

  app.use((req, res, next) => {
    res.setHeader("Permissions-Policy", "gamepad=*, display-capture=(self)");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  const APP_VERSION = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
      return pkg.version || '1.0.0';
    } catch (e) { return '1.0.0'; }
  })();
  const COMMIT_HASH = (() => {
    try {
      return fs.readFileSync(path.join(projectRoot, 'commit.txt'), 'utf8').trim().substring(0, 7);
    } catch (e) { return ''; }
  })();
  app.use('/docs', express.static(path.join(__dirname, '..', '..', 'assets', 'locales', 'docs')));

  // ── Dynamic version.js — always reflects package.json ──────────────────
  app.get('/js/version.js', (req, res) => {
    res.type('application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(`window.NEARSEC_VERSION = "${APP_VERSION}";\nwindow.NEARSEC_COMMIT = "${COMMIT_HASH}";\nconsole.log("[Nearsec] Version loaded:", window.NEARSEC_VERSION, window.NEARSEC_COMMIT ? "("+window.NEARSEC_COMMIT+")" : "");`);
  });

  app.use("/js", express.static(path.join(__dirname, "..", "..", "src", "scripts"), { setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0'); } }));
  app.use("/assets", express.static(path.join(__dirname, "..", "..", "assets")));

  const pagesDir = path.join(__dirname, "..", "..", "src/pages");

  // FIX: Serve the favicon explicitly so the browser finds it
  app.get("/favicon.ico", (req, res) => res.sendFile(path.join(projectRoot, "favicon.ico")));

  app.get("/", (req, res) => {
    const indexPath = path.join(pagesDir, "index.html");
    let html;
    try { html = fs.readFileSync(indexPath, "utf8"); } catch (_) { return res.sendFile(indexPath); }
    const sess = arcadeSessions.size > 0 ? [...arcadeSessions.values()][0] : null;

    // Grab the host name from the URL query, fallback to "A player"
    const hostName = req.query.host || "A player";

    // Inject the host name dynamically into the Discord tags
    const ogTitle = sess ? sess.game : `${hostName} is looking to play!`;
    const ogDesc = sess ? `Join the live ${sess.game} session on Nearsec.` : `${hostName} is hosting a peer-to-peer gaming session on Nearsec.`;
    const ogImage = (sess && sess.thumbnail) ? sess.thumbnail : "https://nearsec.cutefame.net/assets/NearsecTogetherLogo.png";

    html = html
      .replace(/(<meta property="og:title"\s+content=")[^"]*"/, `$1${ogTitle}"`)
      .replace(/(<meta property="og:description"\s+content=")[^"]*"/, `$1${ogDesc}"`)
      .replace(/(<meta property="og:image"\s+content=")[^"]*"/, `$1${ogImage}"`);
    res.type("html").send(html);
  });
  app.get("/dashboard", (req, res) => { res.setHeader('Content-Type', 'text/html'); res.sendFile(path.join(pagesDir, "dashboard.html")); });
  app.get("/host", (req, res) => { res.setHeader('Content-Type', 'text/html'); res.sendFile(path.join(pagesDir, "host.html")); });

  app.get("/old_host", (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.sendFile(path.join(pagesDir, "old_host.html"));
  });
  app.get("/gamepad-popup.html", (req, res) => { res.setHeader('Content-Type', 'text/html'); res.sendFile(path.join(pagesDir, "gamepad-popup.html")); });
  app.use('/css', express.static(path.join(__dirname, '..', 'css')));
  app.get("/api/info", (req, res) => res.json({ lanIP: LAN_IP, port: PORT, pin: PIN, publicIP: PUBLIC_IP || null, tunnelUrl: tunnelUrl || null, version: APP_VERSION }));
  app.post("/api/fe-log", express.json(), (req, res) => {
    const { msg, src, line } = req.body || {};
    console.error(`[renderer] ${msg} @ ${src}:${line}`);
    res.json({ ok: true });
  });

  app.get("/api/pin-required", (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const hasTunnelHeader = !!req.headers['x-forwarded-for'] || !!req.headers['cf-connecting-ip'];
    res.json({ required: pinEnabled && shouldRequirePin(clientIp, hasTunnelHeader) });
  });
  app.get("/api/config", (req, res) => res.json(loadConfig()));
  app.post("/api/config", express.json(), (req, res) => { res.json(saveConfig(req.body || {})); });

  app.post('/api/set-session-password', express.json(), (req, res) => {
    const newPass = (req.body?.password || '').trim();
    saveConfig({ persistentPassword: newPass });
    sessionPassword = newPass;
    PIN = sessionPassword ? sessionPassword : makePin();
    console.log(`[host] Session password ${sessionPassword ? 'set' : 'cleared'}`);
    if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "regen-pin", pin: PIN }));
    res.json({ ok: true, hasPassword: !!sessionPassword });
  });

  app.get('/api/session-password-status', (req, res) => {
    res.json({ hasPassword: !!sessionPassword, password: sessionPassword });
  });

  app.get("/api/sysinfo", async (req, res) => {
    try {
      const [cpu, mem, net] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.networkStats()
      ]);
      const activeNet = net.find(n => n.tx_sec > 0 || n.rx_sec > 0) || net[0];
      res.json({
        cpu: cpu.currentLoad.toFixed(1) + '%',
        ram: (mem.active / 1024 / 1024 / 1024).toFixed(1) + 'GB / ' + (mem.total / 1024 / 1024 / 1024).toFixed(1) + 'GB',
        netTx: activeNet ? (activeNet.tx_sec / 1024).toFixed(1) + ' KB/s' : '0 KB/s',
        netRx: activeNet ? (activeNet.rx_sec / 1024).toFixed(1) + ' KB/s' : '0 KB/s',
        latency: 'Local'
      });
    } catch (e) {
      res.json({ error: true });
    }
  });

  app.get("/api/turn", (req, res) => {
    const iceServers = [];

    // ── Custom STUN server (optional) ───────────────────────────────────────
    if (process.env.STUN_URL) {
      iceServers.push({ urls: process.env.STUN_URL });
    }

    // ── Custom TURN server (optional) ───────────────────────────────────────
    if (process.env.TURN_URL) {
      const entry = { urls: [] };
      entry.urls.push(process.env.TURN_URL);
      if (process.env.TURN_URL_TLS) entry.urls.push(process.env.TURN_URL_TLS);
      if (process.env.TURN_USERNAME) entry.username = process.env.TURN_USERNAME;
      if (process.env.TURN_CREDENTIAL) entry.credential = process.env.TURN_CREDENTIAL;
      iceServers.push(entry);
    }

    // ── Legacy Metered.ca env vars (backward compat) ────────────────────────
    if (!process.env.TURN_URL && process.env.METERED_TURN_URL) {
      iceServers.push({
        urls: [
          process.env.METERED_TURN_URL,
          process.env.METERED_TURN_URL_SECURE || ''
        ].filter(Boolean),
        username: process.env.METERED_TURN_USERNAME || 'openrelayproject',
        credential: process.env.METERED_TURN_CREDENTIAL || 'openrelayproject'
      });
    }

    // Return null if nothing is configured — clients will use their built-in STUN pool
    if (iceServers.length === 0) return res.json(null);
    res.json(iceServers.length === 1 ? iceServers[0] : iceServers);
  });

  app.get("/api/status", (req, res) => {
    res.json({
      online: !!hostWS,
      streaming: hostStreaming,
      viewers: viewers.size,
      controllers: controllerViewerCount(),
      tunnel: tunnelUrl,
      version: APP_VERSION,
      uptime: process.uptime()
    });
  });

  app.post("/api/create-virtual-audio", (req, res) => {
    initVirtualAudio((success, error) => {
      res.json({ success, error: error || null });
    });
  });

  // ── Input Visualizer — SSE stream of parsed driver packets ────────────────
  app.get('/api/input-visualizer', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const onPacket = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    inputDriver.events.on('input-packet', onPacket);

    req.on('close', () => {
      inputDriver.events.off('input-packet', onPacket);
    });
  });

  // ── Viewer Input Permission — revoke / restore ────────────────────────────
  app.post('/api/viewer-input-perm', express.json(), (req, res) => {
    const { viewerId, revoked } = req.body || {};
    if (!viewerId) return res.status(400).json({ ok: false, reason: 'missing viewerId' });
    const padId = viewerId + '_0';
    const cur = inputPerms.get(padId) || { gp: true, kb: false, slot: null };
    const updated = { ...cur, gp: !revoked, kb: revoked ? false : cur.kb, revokedByHost: !!revoked };
    inputPerms.set(padId, updated);
    // Flush neutral state so the game doesn't see a stuck button
    if (revoked) {
      inputDriver.send({ type: 'flush_neutral', viewer_id: padId });
    }
    // Notify host WS client so the viewer panel updates live
    if (typeof hostWS !== 'undefined' && hostWS && hostWS.readyState === 1) {
      hostWS.send(JSON.stringify({ type: 'input-perm-changed', viewerId, revoked: !!revoked }));
    }
    res.json({ ok: true, viewerId, revoked: !!revoked });
  });

  app.get("/api/arcade/sessions", (req, res) => {
    res.json([...arcadeSessions.values()]);
  });
  app.post("/api/open-terminal", express.json(), (req, res) => {
    if (process.platform !== "linux") return res.status(400).json({ ok: false, reason: "Linux only" });
    const { cmd, name } = req.body || {};
    if (!cmd) return res.status(400).json({ ok: false });
    const title = (name || "Auto-Host").replace(/"/g, "'");
    const terms = [`gnome-terminal --title="${title}" -- bash -c "${cmd}; exec bash"`, `xterm -title "${title}" -e bash -c "${cmd}; exec bash"`, `konsole --title "${title}" -e bash -c "${cmd}; exec bash"`];
    const { exec: _exec } = require("child_process");
    let i = 0; (function t() { if (i >= terms.length) return res.json({ ok: false, reason: "no terminal found" }); _exec(terms[i++], err => { if (err) t(); else res.json({ ok: true }); }); })();
  });

  let activeGameProc = null;

  app.post("/api/force-route", express.json(), (req, res) => {
    if (!pb) {
      console.warn("[Audio] PatchBay not ready.");
      return res.json({ success: false });
    }
    const targetProcess = req.body.processName || "ALL_DESKTOP";
    console.log(`[Audio] Engaging auto-router: ${targetProcess}`);
    routeGameAudio(targetProcess);
    res.json({ success: true });
  });

  // ── Unified Capture Manager API ───────────────────────────────────────────
  app.get('/api/capture/status', (req, res) => {
    res.json(captureManager.getStatus());
  });

  app.post('/api/capture/start', express.json(), async (req, res) => {
    const { method, options } = req.body || {};
    if (!method) return res.status(400).json({ ok: false, reason: 'method is required (webcodecs | ffmpeg | webrtc)' });
    try {
      const result = await captureManager.start(method, options || {});
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[capture] start failed:', e.message);
      res.status(500).json({ ok: false, reason: e.message });
    }
  });

  app.post('/api/capture/stop', async (req, res) => {
    try {
      await captureManager.stop();
      res.json({ ok: true });
    } catch (e) {
      console.error('[capture] stop failed:', e.message);
      res.status(500).json({ ok: false, reason: e.message });
    }
  });

  app.post("/api/restart-game", express.json(), (req, res) => {
    if (activeGameProc) {
      try { process.kill(-activeGameProc.pid); } catch (e) { }
      try { activeGameProc.kill(); } catch (e) { }
      activeGameProc = null;
    }

    if (req.body && req.body.command && req.body.command !== 'KILL_ONLY') {
      const parts = req.body.command.split(' ');
      const cmd = parts.shift();
      console.log("  \x1b[35m~\x1b[0m Launching game process:", req.body.command);

      // ── CRITICAL AUDIO ROUTING: Force game audio into the virtual sink ──
      const spawnEnv = Object.assign({}, process.env);
      spawnEnv.PULSE_SINK = "NearsecAppAudio";

      // ── LIFECYCLE MONITORING: Do NOT detach. Monitor the game and crash if it dies. ──
      activeGameProc = spawn(cmd, parts, {
        stdio: 'ignore',
        env: spawnEnv
      });

      // Extract the binary name to look for in PipeWire
      // (If launching via Steam, you might need to hardcode specific names here based on the command)
      let binaryName = cmd;
      if (req.body.command.includes('cs2')) binaryName = 'cs2';

      // Wait 4 seconds for the game window and audio engine to open, then route it
      setTimeout(() => {
        routeGameAudio(binaryName);
      }, 4000);

      activeGameProc.on('exit', (code) => {
        console.log(`[server] Game process exited with code ${code}.`);
        activeGameProc = null;
        if (process.argv.includes('--arcade-worker')) {
          console.log("[server] Arcade Worker: Game terminated externally. Executing suicide protocol...");
          process.exit(0);
        }
      });
    }
    res.json({ success: true });
  });

  app.post("/api/start-tunnel", express.json(), async (req, res) => {

    if (activeTunnelProc) {
      console.log("  \x1b[33m~\x1b[0m Stopping existing tunnel process before switching...");
      try { activeTunnelProc.kill(); } catch (e) { }
      activeTunnelProc = null;
    }
    tunnelUrl = null;

    const provider = (req.body && req.body.provider) || "cloudflared";
    if (req.body && req.body.remember) saveConfig({ tunnelProvider: provider, neverAsk: true });

    res.json({ ok: true, starting: true });

    if (provider === 'p2p' || provider === 'vps-sfu' || provider === 'portforward') {
      return; // Handled entirely by the browser, no local Node tunnel needed
    }

    // CRITICAL FIX: Use readEnv to catch the host if the GUI fails to pass it!
    const resolvedVpsHost = (req.body && req.body.vpsHost)
      ? req.body.vpsHost.trim()
      : (readEnv('VPS_HOST') || '').trim();

    const fn = {
      zrok: startTunnelZrok,
      cloudflared: startTunnelCloudflared,
      playit: startTunnelPlayit,
      localhostrun: startTunnelLocalhostRun,
      serveo: startTunnelServeo,
      vps: (p) => startTunnelVps(p, resolvedVpsHost),
      portforward: async () => null
    }[provider] || startTunnel;

    if (provider === 'vps' && resolvedVpsHost) {
      saveConfig({ vpsHost: resolvedVpsHost });
    }

    try {
      const tun = await fn(PORT);
      if (tun && tun.url) {
        tunnelUrl = tun.url;
        const msg = JSON.stringify({ type: "tunnel-url", url: tunnelUrl });
        if (hostWS && hostWS.readyState === 1) hostWS.send(msg);
      } else if (tun && tun.error === 'NOT_FOUND') {
        console.log(`  \x1b[31m~\x1b[0m Tunnel provider '${provider}' binary not found.`);
        if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "tunnel-not-found", provider: provider }));
      } else {
        console.log(`  \x1b[31m~\x1b[0m Tunnel provider '${provider}' failed.`);
        if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "tunnel-error", provider: provider }));
      }
    } catch (e) {
      console.log(`  \x1b[31m~\x1b[0m Tunnel error:`, e.message);
      if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "tunnel-error", provider: provider }));
    }
  });

  // ── INPUT ORCHESTRATOR (Hybrid C++ / Python) ──
  const screenW = global.currentResW || 1920;
  const screenH = global.currentResH || 1080;

  // This will try C++ first, and automatically fall back to Python if the .node file is missing
  const inputReady = inputDriver.init(screenW, screenH);

  // Forward input driver errors (e.g. ViGEmBus missing on Windows) to the host UI
  inputDriver.events.on('input-error', (err) => {
    console.error('[InputOrchestrator] input-error:', err.message, '(code:', err.code + ')');
    if (hostWS && hostWS.readyState === 1) {
      hostWS.send(JSON.stringify({ type: 'input-error', message: err.message, code: err.code || '' }));
    }
  });
  inputDriver.events.on('input-ready', (info) => {
    console.log('[InputOrchestrator] input-ready:', info.message || '');
    if (hostWS && hostWS.readyState === 1) {
      hostWS.send(JSON.stringify({ type: 'input-ready', message: info.message || '' }));
    }
  });

  // ── C++ rumble callback — registered immediately after init so it fires
  // whether or not the Python sidecar is also running.
  // input-ready is a Python-only event so the old placement meant the callback
  // was never registered when the C++ bridge loaded successfully.
  if (inputDriver._bridge && inputDriver._bridge.setRumbleCallback) {
    inputDriver._bridge.setRumbleCallback((data) => {
      // getViewerForSlot returns the padId (e.g. "uuid_0"); strip the _N suffix
      // to get the bare viewer UUID that keys the viewers map.
      const padId = inputDriver.getViewerForSlot ? inputDriver.getViewerForSlot(data.slot) : null;
      const realId = padId ? padId.replace(/_\d+$/, '') : null;
      console.log(`[Rumble] C++ callback fired — slot=${data.slot} padId=${padId} viewer=${realId || 'unknown'} strong=${data.strong.toFixed(3)} weak=${data.weak.toFixed(3)}`);
      const rumbleMsg = JSON.stringify({
        type: 'rumble',
        strong: data.strong,
        weak: data.weak,
        duration: data.duration || 200,
      });
      if (realId) {
        const vws = viewers.get(realId);
        if (vws && vws.readyState === 1) {
          // Direct local WebSocket viewer
          vws.send(rumbleMsg);
          console.log(`[Rumble] Sent directly to viewer ${realId}`);
        } else if (vws === null) {
          // VPS viewer — no direct WS. Bounce via hostWS so host.js
          // can dispatch it over _vpsWs to the Rust router.
          if (hostWS && hostWS.readyState === 1) {
            hostWS.send(JSON.stringify({
              type: 'rumble',
              targetViewerId: realId,
              strong: data.strong,
              weak: data.weak,
              duration: data.duration || 200,
            }));
            console.log(`[Rumble] Bounced via hostWS to VPS viewer ${realId}`);
          } else {
            console.warn(`[Rumble] hostWS not open, cannot reach VPS viewer ${realId}`);
          }
        } else {
          console.warn(`[Rumble] Viewer ${realId} WebSocket not open (state: ${vws?.readyState})`);
        }
      } else {
        // Slot not yet resolved — broadcast to all viewers best-effort
        console.warn(`[Rumble] No viewer for slot ${data.slot} — broadcasting best-effort`);
        viewers.forEach((vws, vid) => {
          if (vws && vws.readyState === 1) try { vws.send(rumbleMsg); } catch (_) { }
          else if (vws === null && hostWS && hostWS.readyState === 1) {
            hostWS.send(JSON.stringify({ type: 'rumble', targetViewerId: vid, strong: data.strong, weak: data.weak, duration: data.duration || 200 }));
          }
        });
      }
    });
    console.log('[InputOrchestrator] C++ rumble callback registered.');
  }

  // ── Python sidecar rumble forwarding ─────────────────────────────────────────
  // When the Python backend detects an EV_FF/FF_RUMBLE event it emits 'rumble'
  // on the events bus. Route that to the specific viewer's WebSocket.
  inputDriver.events.on('rumble', (data) => {
    const rumbleMsg = JSON.stringify({
      type: 'rumble',
      strong: data.strong || 0,
      weak: data.weak || 0,
      duration: data.duration || 200,
    });
    if (data.viewerId) {
      const vws = viewers.get(data.viewerId);
      if (vws && vws.readyState === 1) vws.send(rumbleMsg);
    } else {
      // viewerId unknown — broadcast to all connected viewers (best-effort)
      viewers.forEach((vws) => {
        if (vws.readyState === 1) try { vws.send(rumbleMsg); } catch (_) { }
      });
    }
  });

  let hostStreaming = false;
  const audioViewers = new Set();
  const viewerGamepads = new Map();
  const viewerHasController = new Set();
  const hwIdToViewer = new Map();

  const JOIN_SOUND = __dirname.includes('app.asar')
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'joinsound.wav')
    : path.join(__dirname, '../../assets/joinsound.wav');

  const LEAVE_SOUND = __dirname.includes('app.asar')
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'leavesound.wav')
    : path.join(__dirname, '../../assets/leavesound.wav');

  const { playSound: playSoundUtil } = require('./audio-util');

  function playSound(file) {
    if (!fs.existsSync(file)) return;
    playSoundUtil(file, (err) => {
      if (err) console.log("[audio] Could not play sound on " + process.platform + ":", err.message);
    });
  }
  function playJoinSound() {
    if (hostWS && hostWS.readyState === 1) {
      hostWS.send(JSON.stringify({ type: 'play-system-sound', action: 'join' }));
    }
  }
  function playLeaveSound() {
    if (hostWS && hostWS.readyState === 1) {
      hostWS.send(JSON.stringify({ type: 'play-system-sound', action: 'leave' }));
    }
  }

  function broadcast(data) {
    let sentToVps = false;
    viewers.forEach(vws => {
      if (vws && vws.readyState === 1) vws.send(data);
      else if (vws === null && !sentToVps && hostWS && hostWS.readyState === 1) {
        hostWS.send(JSON.stringify({ type: 'vps-broadcast', payload: data }));
        sentToVps = true;
      }
    });
  }

  function controllerViewerCount() {
    return viewerHasController.size;
  }

  function broadcastRoster() {
    const roster = [];
    roster.push({ id: 'host_0', name: 'Host', gp: false, kb: false, slot: 0, locked: true, inputMode: 'host' });
    let autoSlot = 1;
    viewers.forEach((vws, id) => {
      const pads = viewerGamepads.get(id) || new Set([0]);
      pads.forEach(padIdx => {
        const isExtra = padIdx > 0;
        const nameSuffix = isExtra ? ' ' + (padIdx + 1) : '';
        const rosterId = id + '_' + padIdx;
        const pBase = inputPerms.get(id) || {};
        const pPad = inputPerms.get(rosterId) || {};
        const p = { gp: true, kb: false, slot: null, locked: false, ...pBase, ...pPad };

        let mode = 'gamepad';
        if (!p.gp && p.kb) mode = 'kbm';
        else if (p.gp && p.kb) mode = 'kbm_emulated';
        else if (!p.gp && !p.kb) mode = 'disabled';

        roster.push({
          id: rosterId,
          name: (viewerNames.get(id) || id) + nameSuffix,
          gp: !!p.gp,
          kb: !!p.kb,
          slot: p.slot ?? autoSlot++,
          locked: !!p.locked,
          inputMode: mode
        });
      });
    });
    const count = controllerViewerCount();
    const msg = JSON.stringify({ type: "roster", viewers: roster, controllerCount: count });
    broadcast(msg);
    if (hostWS && hostWS.readyState === 1) hostWS.send(msg);
  }

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const url = new URL(req.url, "http://x");
    const wsPath = url.pathname;
    const pin = url.searchParams.get("pin") || "";

    // ── HOST ─────────────────────────────────────────────────────────────────
    if (wsPath === "/ws/host") {
      console.log("[host] connected");
      hostWS = ws;
      broadcast(JSON.stringify({ type: "host-connected" }));

      // Start audio routing as soon as the host session opens
      if (_audioWorker) _audioWorker.postMessage({ type: 'route', processName: null });
      viewers.forEach((_, id) => hostWS.send(JSON.stringify({ type: "viewer-joined", viewerId: id, name: viewerNames.get(id) || id })));

      if (tunnelUrl) ws.send(JSON.stringify({ type: "tunnel-url", url: tunnelUrl }));

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          // Tunnel WebCodecs binary frames from Host -> Node.js Server -> Viewers
          viewers.forEach(vws => {
            if (vws && vws.readyState === 1) vws.send(raw);
          });
          return;
        }

        try {
          let msg = JSON.parse(raw);

          if (msg.type === "webcodecs-config") {
            broadcast(raw);
            return;
          }

          // ── OS-LEVEL AUDIO FALLBACK COMMANDS ──
          if (msg.type === "start-audio-fallback") {
            if (audioProc) {
              audioProc.kill();
              audioProc = null;
            }
            console.log("  [host] Engaging Python OS-Level Audio Fallback...");
            const audioScript = path.join(__dirname, "..", "sidecar", "audio_driver.py");

            // FIX: Added "-u" to bypass buffer lock, and "inherit" to expose Python crashes!
            audioProc = spawn(process.platform === "win32" ? "python" : "python3", ["-u", audioScript], { stdio: ['ignore', 'pipe', 'inherit'] });

            audioProc.stdout.on('data', (chunk) => {
              viewers.forEach(v => {
                if (v.readyState === WebSocket.OPEN) v.send(chunk);
              });
            });
            return;
          }

          if (msg.type === "stop-audio-fallback") {
            if (audioProc) {
              audioProc.kill();
              audioProc = null;
            }
            return;
          }

          // ── STANDARD SIGNALING ──
          if ((msg.type === "offer" || msg.type === "ice-host") && msg._viewerId) {
            const vws = viewers.get(msg._viewerId);
            if (vws && vws.readyState === 1) {
              vws.send(JSON.stringify(msg));
            } else if (vws === null && hostWS && hostWS.readyState === 1) {
              hostWS.send(JSON.stringify(msg));
            }
            return;
          }

          // ── VOICE COMMANDS ────────────────────────────────────────────────
          // Individual viewer: relay to that specific viewer
          if (msg.type === "host-voice-cmd" && msg.targetViewerId) {
            const realId = msg.targetViewerId.split('_')[0];
            const targetWs = viewers.get(realId);
            if (targetWs && targetWs.readyState === 1) {
              targetWs.send(JSON.stringify(msg));
            } else if (targetWs === null && hostWS && hostWS.readyState === 1) {
              hostWS.send(JSON.stringify(msg));
            }
            return;
          }
          // Broadcast: relay mute/unmute to every connected viewer
          if (msg.type === "host-voice-broadcast" && msg.action) {
            viewers.forEach((vws, id) => {
              if (vws && vws.readyState === 1) {
                vws.send(JSON.stringify({ type: "host-voice-cmd", action: msg.action, targetViewerId: id }));
              } else if (vws === null && hostWS && hostWS.readyState === 1) {
                hostWS.send(JSON.stringify({ type: "host-voice-cmd", action: msg.action, targetViewerId: id }));
              }
            });
            return;
          }
          // ─────────────────────────────────────────────────────────────────

          if (msg.type === "kick-viewer") {
            const realId = msg.viewerId.split('_')[0];
            const targetWs = viewers.get(realId);

            viewers.delete(realId);
            viewerNames.delete(realId);
            inputPerms.delete(realId);

            if (targetWs) {
              try { targetWs.send(JSON.stringify({ type: "pin-rejected", reason: "kicked" })); } catch { }
              targetWs.close(4003, "KICKED");
              console.log(`[host] Kicked viewer ${realId}`);
            } else if (hostWS && hostWS.readyState === 1) {
              hostWS.send(JSON.stringify({ type: "pin-rejected", reason: "kicked", targetViewerId: realId }));
              console.log(`[host] Kicked VPS viewer ${realId}`);
            }

            broadcastRoster();
            return;
          }

          if (msg.type === "set-pin") { pinEnabled = !!msg.enabled; return; }

          if (msg.type === "set-input") {
            const cur = inputPerms.get(msg.viewerId) || { gp: true, kb: false, slot: null, mode: 'gamepad' };
            inputPerms.set(msg.viewerId, { ...cur, gp: !!msg.gp, kb: !!msg.kb });
            const realId = msg.viewerId.split('_')[0];
            const vws = viewers.get(realId);
            if (vws && vws.readyState === 1 && msg.viewerId.endsWith('_0')) {
              vws.send(JSON.stringify({ type: "input-state", gp: !!msg.gp, kb: !!msg.kb }));
            }
            broadcastRoster();
            return;
          }

          if (msg.type === "assign-slot") {
            const cur = inputPerms.get(msg.viewerId) || { gp: true, kb: false, slot: null };
            inputPerms.set(msg.viewerId, { ...cur, slot: msg.slot });
            const realId = msg.viewerId.split('_')[0];
            const vws = viewers.get(realId);
            if (vws && vws.readyState === 1 && msg.viewerId.endsWith('_0')) {
              vws.send(JSON.stringify({ type: "slot-assigned", slot: msg.slot }));
            }
            broadcastRoster();
            return;
          }

          if (msg.type === "chat") { broadcast(JSON.stringify(msg)); return; }

          // FIX 1: Catch the direct profile change from the UI and send to Python
          if (msg.type === "set-ctrl-type") {
            global.currentCtrlType = msg.ctrlType;
            toUinput(msg);
            return;
          }

          if (msg.type === "ctrl-settings") {
            toUinput({ type: 'set_force_xboxone', value: !!msg.forceXboxOne });
            toUinput({ type: 'set_enable_dualshock', value: !!msg.enableDualShock });
            toUinput({ type: 'set_enable_motion', value: !!msg.enableMotion });
            toUinput({ type: 'ctrl-settings-hybrid', enabled: !!msg.hybridInput });

            // Save global states
            global.currentCtrlType = msg.ctrlType || 'xbox360';
            global.hybridInputActive = msg.hybridInput;
            global.defaultInputMode = msg.defaultInputMode || 'gamepad';
            global.touchLayout = msg.touchLayout || 'default';
            global.enableMotion = !!msg.enableMotion;
            saveConfig({ defaultInputMode: global.defaultInputMode });

            // Update the orchestrator's global default FIRST (no viewerId = set global default),
            // then update each connected viewer's per-viewer entry.
            toUinput({ type: 'set-ctrl-type', viewerId: null, ctrlType: global.currentCtrlType });
            viewers.forEach((_, vid) => {
              toUinput({ type: 'set-ctrl-type', viewerId: vid, ctrlType: global.currentCtrlType });
            });

            // Broadcast to viewers so they update their touch layout
            broadcast(JSON.stringify({ type: 'ctrl-settings', touchLayout: global.touchLayout, enableMotion: global.enableMotion }));

            console.log("[host] ctrl-settings: forceXboxOne=%s enableDualShock=%s enableMotion=%s hybrid=%s ctrlType=%s touchLayout=%s",
              !!msg.forceXboxOne, !!msg.enableDualShock, !!msg.enableMotion, !!msg.hybridInput, global.currentCtrlType, global.touchLayout);
            return;
          }

          if (msg.type === "panic_toggle") {
            toUinput({ type: 'panic_toggle', enabled: !!msg.enabled });
            console.log("[host] KBM Panic Mode: %s", !!msg.enabled ? "ACTIVATED" : "Released");
            return;
          }

          // Auto-map: host notifies which window is focused → uinput picks preset from CSV
          if (msg.type === "window-focus") {
            toUinput({ type: "window-focus", title: msg.title });
            return;
          }
          if (msg.type === "set-input-mode") {
            const modeMap = {
              gamepad: { gp: true, kb: false },
              kbm: { gp: false, kb: true },
              kbm_emulated: { gp: true, kb: true },
              disabled: { gp: false, kb: false }
            };
            const perms = modeMap[msg.mode] || { gp: true, kb: false };
            const cur = inputPerms.get(msg.viewerId) || { gp: true, kb: false, slot: null, mode: 'gamepad' };
            inputPerms.set(msg.viewerId, { ...cur, ...perms, mode: msg.mode });

            const realId = msg.viewerId.split('_')[0];
            const vws = viewers.get(realId);
            if (vws && vws.readyState === 1) {
              vws.send(JSON.stringify({ type: "input-state", gp: perms.gp, kb: perms.kb, mode: msg.mode }));
            } else if (vws === null && hostWS && hostWS.readyState === 1) {
              hostWS.send(JSON.stringify({ type: "input-state", gp: perms.gp, kb: perms.kb, mode: msg.mode, targetViewerId: realId }));
            }
            toUinput({ type: 'set-input-mode', viewerId: msg.viewerId, mode: msg.mode });
            broadcastRoster();
            return;
          }

          if (msg.type === "toggle-slot-lock") {
            const realId = msg.viewerId.split('_')[0];
            const cur = inputPerms.get(realId) || { gp: true, kb: false, slot: null };
            inputPerms.set(realId, { ...cur, locked: !!msg.locked });
            broadcastRoster();
            return;
          }

          if (msg.type === "regen-pin") {
            if (sessionPassword && arcadeSessions.size === 0) {
              console.log("[host] Ignoring regen-pin because persistent PIN is set.");
              return;
            }
            PIN = makePin();
            console.log("[host] PIN regenerated: ****");
            if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "regen-pin", pin: PIN }));
            return;
          }

          if (msg.type === "arcade-session-start") {
            if (sessionPassword) {
              PIN = makePin();
              if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "regen-pin", pin: PIN }));
            }
            
            const arcadeUrl = msg.tunnelUrl || tunnelUrl;
            if (!arcadeUrl) { /* error logic */ return; }

            const cfg = loadConfig(); // Fetch live config
            const sessionName = cfg.hostName || 'Host';
            const sessionId = 'ns-' + Date.now() + '-' + (++arcadeHostId);
            const session = {
              id: sessionId,
              game: msg.config?.title || 'Arcade Game',
              thumbnail: msg.config?.thumbnail || null,
              region: `${sessionName}'s Arcade`, // FIXED: Uses actual name for Rich Presence
              hasPin: !!msg.config?.requirePin,
              maxPlayers: parseInt(msg.config?.maxPlayers || 4),
              url: arcadeUrl,
              startedAt: Date.now(),
              isStreaming: true,
            };
            arcadeSessions.set(sessionId, session);
            console.log("[arcade] Session registered:", session.game, arcadeUrl);
            broadcastToArcade({ type: 'arcade-session-active', session });
            if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: 'arcade-session-active', session }));
            _arcadePost({ type: 'session-active', session });
            return;
          }

          if (msg.type === "arcade-session-stop") {
            if (sessionPassword) {
              PIN = sessionPassword;
              if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "regen-pin", pin: PIN }));
            }
            for (const [id, s] of arcadeSessions) {
              arcadeSessions.delete(id);
              broadcastToArcade({ type: 'arcade-session-stopped', id });
              console.log("[arcade] Session stopped:", s.game);
              _arcadePost({ type: 'session-stopped', id });
            }
            return;
          }

          if (msg.type === "host-stream-ready") hostStreaming = true;
          if (msg.type === "host-stream-stopped") {
            hostStreaming = false;
            for (const [id, s] of arcadeSessions) {
              arcadeSessions.delete(id);
              broadcastToArcade({ type: 'arcade-session-stopped', id });
            }
            if (sessionPassword && PIN !== sessionPassword) {
              PIN = sessionPassword;
              if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "regen-pin", pin: PIN }));
            }
          }

          // ── VPS viewer registration ───────────────────────────────────────
          // When a viewer connects via the Rust SFU router, host.js forwards
          // synthetic join/leave messages so the server can manage the roster,
          // input permissions, and controller slots without a direct viewer WS.
          if (msg.type === 'vps-viewer-join') {
            const id = String(msg.viewerId || '').slice(0, 64);
            if (!id) return;
            if (!viewers.has(id)) {
              viewers.set(id, null);
              viewerNames.set(id, String(msg.name || id).slice(0, 48));
              const cfg = loadConfig();
              const defaultMode = cfg.defaultInputMode || global.defaultInputMode || 'gamepad';
              const padId = id + '_0';
              inputPerms.set(padId, {
                gp: defaultMode !== 'kbm',
                kb: defaultMode !== 'gamepad',
                slot: null,
                mode: defaultMode,
              });
              toUinput({ type: 'set-ctrl-type', viewerId: padId, ctrlType: global.currentCtrlType || 'xbox360' });
              if (hostWS && hostWS.readyState === 1) {
                hostWS.send(JSON.stringify({
                  type: 'viewer-joined',
                  viewerId: id,
                  name: viewerNames.get(id),
                  viewerRegion: msg.viewerRegion || null,
                  isDesktopApp: !!msg.isDesktopApp,
                }));
              }
              broadcastRoster();
              console.log('[VPS] Viewer joined:', id);
            }
            return;
          }

          if (msg.type === 'vps-viewer-leave') {
            const id = String(msg.viewerId || '').slice(0, 64);
            if (!id || !viewers.has(id)) return;
            viewers.delete(id);
            viewerNames.delete(id);
            const padId = id + '_0';
            toUinput({ type: 'flush_neutral', viewer_id: padId });
            toUinput({ type: 'disconnect_viewer', viewer_id: padId });
            inputPerms.delete(padId);
            if (hostWS && hostWS.readyState === 1) {
              hostWS.send(JSON.stringify({ type: 'viewer-left', viewerId: id }));
            }
            broadcastRoster();
            console.log('[VPS] Viewer left:', id);
            return;
          }

          // ── VPS viewer input ──────────────────────────────────────────────
          // Gamepad/KBM packets stamped with viewerId by host.js VPS bridge.
          // Route directly to the uinput driver — same path as local viewers.
          // IMPORTANT: viewerId here is the full Rust UUID (e.g. "f4a38b29-9dee-...")
          // inputPerms is keyed by "UUID_padIndex" — do NOT split on '_' or you lose the UUID.
          if ((msg.type === 'gamepad' || msg.type === 'keyboard' || msg.type === 'kbm' || msg.type === 'gpid') && msg.viewerId) {

            // Use the full UUID as canonical viewer id
            const id = String(msg.viewerId);
            const padIdx = (msg.type === 'gpid' ? (msg.padIndex || 0) : (msg.padIndex || 0));
            const padId = id + '_' + padIdx;

            if (msg.type === 'gpid') {
              const pads = viewerGamepads.get(id) || new Set();
              if (!pads.has(padIdx)) {
                pads.add(padIdx);
                viewerGamepads.set(id, pads);
                msg.pad_id = padId;
                msg.viewer_id = id;
                if (!inputPerms.has(padId)) inputPerms.set(padId, { gp: true, kb: false, slot: null, mode: 'gamepad' });
                if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "viewer-gpid", viewerId: id, id: msg.id }));
                toUinput(msg);
                broadcastRoster();
              }
              return;
            }

            if (msg.type === 'keyboard') msg.type = 'kbm';

            // Always stamp with server-canonical padId so it matches inputPerms
            msg.pad_id = padId;
            msg.viewer_id = id;
            msg.viewerId = id;

            const perms = inputPerms.get(padId) || inputPerms.get(id + '_0') || { gp: true, kb: false };

            if (msg.type === 'gamepad') {
              if (!perms.gp) return;
              const norm = normalizeGamepadMsg(msg);
              if (!norm) return;
              inputDriver.send(norm);
              return;
            }
            if (msg.type === 'kbm' && !perms.kb) return;
            inputDriver.send(msg);
            return;
          }

          broadcast(JSON.stringify(msg));

        } catch (err) {
          console.error("[host] Message parsing error:", err.message);
        }
      });

      ws.on("close", () => {
        console.log("[host] disconnected");
        hostWS = null;
        hostStreaming = false;
        for (const [id] of arcadeSessions) {
          arcadeSessions.delete(id);
          broadcastToArcade({ type: 'arcade-session-stopped', id });
        }
        broadcast(JSON.stringify({ type: "host-disconnected" }));
        // Stop routing daemon — no session active, audio should return to normal
        if (_audioWorker) _audioWorker.postMessage({ type: 'route-stop' });
      });

      // ── VIEWER ───────────────────────────────────────────────────────────────
    } else if (wsPath === "/ws/viewer") {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const hasTunnelHeader = !!req.headers['x-forwarded-for'] || !!req.headers['cf-connecting-ip'];
      const requirePin = shouldRequirePin(clientIp, hasTunnelHeader);
      const anonHash = hashIp(clientIp);

      if (pinEnabled && requirePin) {
        const attempt = pinAttempts.get(anonHash) || { count: 0, lockedUntil: 0 };
        if (Date.now() < attempt.lockedUntil) {
          try { ws.send(JSON.stringify({ type: "pin-rejected", reason: "rate-limited" })); } catch { }
          ws.close(4001, "PIN_RATE_LIMITED");
          console.log(`[viewer] rejected — an anonymous user is rate-limited`);
          return;
        }
        if (pin !== PIN) {
          attempt.count++;
          if (attempt.count >= 6) {
            attempt.lockedUntil = Date.now() + 2 * 60 * 1000;
            console.log(`[viewer] anonymous user locked out for 2 minutes (PIN brute-force)`);
          }
          pinAttempts.set(anonHash, attempt);
          try { ws.send(JSON.stringify({ type: "pin-rejected" })); } catch { }
          ws.close(4002, "PIN_REJECTED");
          console.log("[viewer] rejected — wrong PIN");
          return;
        }
        pinAttempts.delete(anonHash);
      } else {
        console.log(`[viewer] anonymous user (requirePin=${requirePin}) bypassing PIN check`);
      }

      // ── Session password check ────────────────────────────────────────────
      // Only run when there is NO active pin gate. When pinEnabled && requirePin
      // is true AND sessionPassword is set, PIN === sessionPassword, so the PIN
      // check above already validated the credential — checking again here causes
      // spurious session-password-required rejections for correctly authenticated viewers.
      if (sessionPassword && !(pinEnabled && requirePin)) {
        const provided = url.searchParams.get('password') || url.searchParams.get('pin') || '';
        if (provided !== sessionPassword) {
          try { ws.send(JSON.stringify({ type: 'session-password-required', reason: 'Session password incorrect.' })); } catch {}
          ws.close();
          console.log(`[viewer] rejected — wrong session password (non-PIN path) from ${clientIp}`);
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      let id = "v" + (++vidCount);
      const defaultName = "Guest" + (1000 + Math.floor(Math.random() * 9000));

      // ── Arcade viewer cap ─────────────────────────────────────────────────
      // If an arcade session is active and has a maxPlayers limit, reject
      // viewers beyond that count before they are added to the viewers map.
      if (arcadeSessions.size > 0) {
        const sess = [...arcadeSessions.values()][0];
        if (sess && sess.maxPlayers && viewers.size >= sess.maxPlayers) {
          console.log(`[viewer] ${id} rejected — arcade session full (${viewers.size}/${sess.maxPlayers})`);
          ws.send(JSON.stringify({
            type: 'session-full',
            max: sess.maxPlayers,
            reason: `This session is full (${sess.maxPlayers} players max).`,
          }));
          ws.close();
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      viewers.set(id, ws);
      viewerNames.set(id, defaultName);

      const cfg = loadConfig();
      const defaultMode = global.defaultInputMode || cfg.defaultInputMode || 'gamepad';
      const startGp = defaultMode !== 'kbm';
      const startKb = defaultMode !== 'gamepad';
      inputPerms.set(id + '_0', { gp: startGp, kb: startKb, slot: null, mode: defaultMode });

      console.log("[viewer]", id, "(" + defaultName + ") joined (" + viewers.size + " total, " + controllerViewerCount() + " with controllers)");

      // Immediately tell Python to apply the correct profile to this new viewer
      toUinput({ type: 'set-ctrl-type', viewerId: id, ctrlType: global.currentCtrlType || 'xbox360' });

      toUinput({ type: 'set-input-mode', viewerId: id + '_0', mode: defaultMode });

      ws.send(JSON.stringify({ type: "your-id", viewerId: id, name: defaultName }));
      ws.send(JSON.stringify({ type: "input-state", gp: startGp, kb: startKb, mode: defaultMode }));

      // NOTE: viewer-joined is sent to the host inside the 'join' message handler below,
      // AFTER the viewer's chosen display name has arrived. This ensures the host dashboard
      // always shows the real name rather than the server-assigned Guest#### placeholder.

      ws.on("message", raw => {
        try {
          const msg = JSON.parse(raw);

          // ── NAME HANDSHAKE: viewer sends { type:'join', name, viewerId, pin } ──
          // This is the first message from the viewer after ws.onopen.
          // We update the name here, then fire viewer-joined to the host.
          if (msg.type === "join") {
            const joinName = sanitize(String(msg.name || '')).slice(0, 20) || defaultName;
            viewerNames.set(id, joinName);
            console.log("[viewer]", id, "name resolved to:", joinName);

            if (hostWS && hostWS.readyState === 1) {
              hostWS.send(JSON.stringify({
                type: "viewer-joined",
                viewerId: id,
                name: joinName,
                viewerRegion: msg.viewerRegion || null,
                isDesktopApp: !!msg.isDesktopApp
              }));
              // Include the saved host name so the viewer can display "HOST SESSION — Name"
              const hCfg = loadConfig();
              ws.send(JSON.stringify({ type: "host-connected", hostName: hCfg.hostName || 'Host' }));
              ws.send(JSON.stringify({
                type: "ctrl-settings",
                enableMotion: !!global.enableMotion,
                touchLayout: global.touchLayout || 'default'
              }));
              if (hostStreaming) {
                ws.send(JSON.stringify({ type: "host-stream-ready" }));
              }
            }

            broadcastRoster();
            return;
          }

          // Inject viewer ID for answers AND mic renegotiation requests
          if (msg.type === "answer" || msg.type === "ice-viewer" || msg.type === "viewer-mic-ready") {
            msg._viewerId = id;
            if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify(msg));
            return;
          }

          if (msg.type === "host-not-streaming") {
            const vws = viewers.get(msg.viewerId);
            if (vws && vws.readyState === 1) vws.send(JSON.stringify(msg));
            return;
          }

          if (msg.type === "viewer-rejoin") {
            const claimedId = msg.viewerId;
            if (claimedId && viewers.has(claimedId)) {
              const tempId = id;
              viewers.set(claimedId, ws);
              viewers.delete(tempId);
              viewerNames.set(claimedId, viewerNames.get(tempId) || viewerNames.get(claimedId) || "Guest");
              viewerNames.delete(tempId);
              if (viewerHasController.has(tempId)) {
                viewerHasController.delete(tempId);
                viewerHasController.add(claimedId);
              }
              console.log("[viewer]", claimedId, "rejoined (slot reused, no duplicate)");
              id = claimedId;
              if (hostWS && hostWS.readyState === 1) {
                hostWS.send(JSON.stringify({ type: "viewer-left", viewerId: tempId }));
                hostWS.send(JSON.stringify({ type: "viewer-joined", viewerId: id, name: viewerNames.get(id) }));
              }
              ws.send(JSON.stringify({ type: "your-id", viewerId: id, name: viewerNames.get(id) }));
              broadcastRoster();
            }
            return;
          }

          if (msg.type === "request-offer") {
            if (hostWS && hostWS.readyState === 1)
              hostWS.send(JSON.stringify({ type: "viewer-joined", viewerId: id, name: viewerNames.get(id) || id }));
            return;
          }

          if (msg.type === "gpid") {
            const padIdx = msg.padIndex || 0;
            const pads = viewerGamepads.get(id) || new Set();
            if (pads.has(padIdx)) return;

            const hwKey = (msg.id || 'unknown') + ':' + padIdx;
            const staleViewerId = hwIdToViewer.get(hwKey);
            if (staleViewerId && staleViewerId !== id) {
              console.log("[viewer] evicting stale hw registration:", hwKey, "from", staleViewerId, "→", id);
              const stalePads = viewerGamepads.get(staleViewerId);
              if (stalePads) {
                stalePads.delete(padIdx);
                if (stalePads.size === 0) {
                  viewerGamepads.delete(staleViewerId);
                  viewerHasController.delete(staleViewerId);
                }
              }
              inputPerms.delete(staleViewerId + '_' + padIdx);
              toUinput({ type: 'disconnect_viewer', viewer_id: staleViewerId });
            }
            hwIdToViewer.set(hwKey, id);

            const totalPads = [...viewerGamepads.values()].reduce((sum, s) => sum + s.size, 0);
            if (totalPads >= 16) {
              console.log("[viewer] global slot cap (16) reached, ignoring from", id);
              return;
            }
            if ((viewerGamepads.get(id) || new Set()).size >= 4) {
              console.log("[viewer] per-viewer cap (4) reached for", id);
              return;
            }

            pads.add(padIdx);
            viewerGamepads.set(id, pads);
            msg.pad_id = id + '_' + padIdx;
            if (!inputPerms.has(msg.pad_id)) inputPerms.set(msg.pad_id, { gp: true, kb: false, slot: null });

            const isNewController = !viewerHasController.has(id);
            viewerHasController.add(id);
            if (isNewController) {
              playJoinSound();
              console.log("[viewer]", id, "controller detected — now counted (" + controllerViewerCount() + " with controllers)");
            }
            if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "viewer-gpid", viewerId: id, id: msg.id }));
            toUinput(msg);
            broadcastRoster();
            return;
          }

          if (msg.type === "set-name") {
            const name = sanitize(String(msg.name || '')).slice(0, 20) || viewerNames.get(id);
            viewerNames.set(id, name);
            ws.send(JSON.stringify({ type: "name-confirmed", name }));
            if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "viewer-renamed", viewerId: id, name }));
            broadcastRoster();
            return;
          }

          if (msg.type === "chat") {
            msg.msg = sanitize(msg.msg);
            msg.from = sanitize(viewerNames.get(id) || msg.from || 'Guest').slice(0, 20);
            broadcast(JSON.stringify(msg));
            if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify(msg));
            return;
          }

          if (msg.type === "touch-disconnect") {
            const padIdx = 99;
            const rosterId = id + '_' + padIdx;
            const pads = viewerGamepads.get(id);
            if (pads) pads.delete(padIdx);
            toUinput({ type: 'flush_neutral', viewer_id: rosterId });
            toUinput({ type: 'disconnect_viewer', viewer_id: rosterId });
            broadcastRoster();
            return;
          }

          if (msg.type === "gamepad" || msg.type === "keyboard") {
            if (msg.type === "keyboard") msg.type = "kbm";

            // ── PPS flood protection ──────────────────────────────────────────
            // Track packets per second per viewer. Drop the packet and kick the
            // viewer if they exceed 300 input messages per second.
            const _ppsNow = Date.now();
            if (!ws._ppsWindow || _ppsNow - ws._ppsWindow >= 1000) {
              ws._ppsWindow = _ppsNow;
              ws._ppsCount = 1;
            } else {
              ws._ppsCount = (ws._ppsCount || 0) + 1;
              if (ws._ppsCount > 300) {
                console.warn(`[PPS] Viewer ${id} exceeded 300 inputs/sec — disconnecting`);
                if (hostWS && hostWS.readyState === 1) {
                  hostWS.send(JSON.stringify({ type: 'viewer-flood-kick', viewerId: id }));
                }
                ws.close(1008, 'pps_flood');
                return;
              }
            }
            // ─────────────────────────────────────────────────────────────────
            const padIdx = msg.padIndex || 0;
            const rosterId = msg.type === "gamepad" ? id + '_' + padIdx : id + '_0';

            if (msg.type === "gamepad") {
              const pads = viewerGamepads.get(id) || new Set();
              if (!pads.has(padIdx)) {
                pads.add(padIdx);
                viewerGamepads.set(id, pads);
                if (!inputPerms.has(rosterId)) inputPerms.set(rosterId, { gp: true, kb: false, slot: null });
                const isNew = !viewerHasController.has(id);
                viewerHasController.add(id);
                if (isNew) {
                  playJoinSound();
                  console.log("[viewer]", id, "controller auto-detected from input");
                }
                broadcastRoster();
              }
            }

            const perms = inputPerms.get(id) || inputPerms.get(rosterId) || { gp: true, kb: false };

            if (msg.type === "gamepad" && !perms.gp) return;
            if (msg.type === "kbm" && !perms.kb) return;

            // If viewer's primary slot is kbm_emulated, suppress any extra gamepad devices
            // (e.g. touch padIndex:99) to prevent a second virtual gamepad appearing in the OS.
            if (msg.type === "gamepad" && padIdx !== 0) {
              const primaryPerms = inputPerms.get(id + '_0') || {};
              const primaryMode = primaryPerms.gp && primaryPerms.kb ? 'kbm_emulated' : 'gamepad';
              if (primaryMode === 'kbm_emulated') return;
            }

            msg.pad_id = rosterId;
            const norm = normalizeGamepadMsg(msg);
            if (norm) toUinput(norm);
            return;
          }
        } catch { }
      });

      ws.on("close", () => {
        const hadController = viewerHasController.has(id);
        const wasActive = viewers.get(id) === ws;
        if (wasActive) {
          viewers.delete(id);
          viewerNames.delete(id);
          viewerGamepads.delete(id);
          viewerHasController.delete(id);
          for (const [hwKey, vid] of hwIdToViewer) {
            if (vid === id) hwIdToViewer.delete(hwKey);
          }
          if (hadController) {
            playLeaveSound();
            toUinput({ type: 'flush_neutral', viewer_id: id });
            toUinput({ type: 'disconnect_viewer', viewer_id: id });
          }
          broadcastRoster();
          if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "viewer-left", viewerId: id, name: viewerNames.get(id) || id }));
        }
        console.log("[viewer]", id, "left (" + viewers.size + " total, " + controllerViewerCount() + " with controllers)");
      });

      // ── ARCADE CLIENTS ────────────────────────────────────────────────────────
    } else if (wsPath === "/ws/arcade") {
      arcadeClients.add(ws);
      ws.send(JSON.stringify({ type: 'arcade-sessions', sessions: [...arcadeSessions.values()] }));
      ws.on("message", raw => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'arcade-query') {
            ws.send(JSON.stringify({ type: 'arcade-sessions', sessions: [...arcadeSessions.values()] }));
          }
        } catch { }
      });
      ws.on("close", () => arcadeClients.delete(ws));

      // ── AUDIO ─────────────────────────────────────────────────────────────────
    } else if (wsPath === "/ws/audio-host") {
      ws.on("message", raw => { audioViewers.forEach(v => { if (v.readyState === 1) v.send(raw); }); });

    } else if (wsPath === "/ws/audio") {
      audioViewers.add(ws);
      ws.on("close", () => audioViewers.delete(ws));

      // ── DEDICATED INPUT CHANNEL ───────────────────────────────────────────────
    } else if (wsPath === "/ws/input") {
      let myId = null;
      ws.on("message", raw => {
        try {
          const msg = JSON.parse(raw);
          if (msg.type === "identify") { myId = msg.viewerId; console.log("[input] identified as", myId); return; }
          if (msg.type === "gpid") {
            if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "viewer-gpid", viewerId: myId, id: msg.id }));
            return;
          }
          if (msg.type === "gamepad") { toUinput(normalizeGamepadMsg(msg)); return; }

          if (msg.type === "keyboard" || msg.type === "kbm") {
            if (!myId) return;
            const padId = myId + '_0';
            const perms = inputPerms.get(padId) || inputPerms.get(myId) || { gp: true, kb: false };
            if (!perms.kb) return;
            msg.pad_id = msg.pad_id || padId;
            msg.viewerId = msg.viewerId || myId;
            msg.viewer_id = msg.viewer_id || myId;
            toUinput(msg);
            return;
          }
        } catch (e) { console.error("[input] error:", e.message); }
      });
    }
  });

  // Heartbeat — reap dead WebSockets every 30 seconds
  const interval = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  wss.on('close', () => clearInterval(interval));

  server.listen(PORT, async () => {
    console.log("Listening on port " + PORT);
    if (!process.env.ELECTRON_MODE) openBrowser("http://localhost:" + PORT + "/host");

    const cfg = loadConfig();

    if (process.env.USE_VPS === 'true' && process.env.VPS_HOST) {
      console.log("  ~ Tunnel: VPS (from .env)");
      const tun = await startTunnelVps(PORT, process.env.VPS_HOST.trim());
      if (tun) {
        tunnelUrl = tun.url;
        if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "tunnel-url", url: tunnelUrl }));
      } else {
        console.log(`  \x1b[31m~\x1b[0m VPS Tunnel failed to start on boot.`);
        if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "tunnel-error", provider: 'vps' }));
      }
    } else if (cfg.tunnelProvider === 'vps-sfu') {
      // VPS SFU mode — the host app manages its own WebSocket to the Rust router.
      // The local server must NOT start any tunnel process. The domain is defined
      // by the user's saved VPS URL, not by any local tunnel provider.
      console.log("  \x1b[36m~\x1b[0m Tunnel: VPS SFU mode (managed by host app — no local tunnel started)");
      // Do NOT modify tunnelProvider or neverAsk here.
    } else if (cfg.tunnelProvider === 'p2p') {
      console.log("  \x1b[36m~\x1b[0m Tunnel: P2P mode (managed by host app — no local tunnel started)");
    } else if (cfg.neverAsk && cfg.tunnelProvider === 'portforward') {
      console.log("  ~ Tunnel: port forward mode (saved).");
    } else if (cfg.neverAsk && cfg.tunnelProvider) {
      console.log("  ~ Tunnel: using saved provider '" + cfg.tunnelProvider + "'");

      const fn = {
        zrok: startTunnelZrok,
        cloudflared: startTunnelCloudflared,
        playit: startTunnelPlayit,
        localhostrun: startTunnelLocalhostRun,
        serveo: startTunnelServeo,
        vps: (p) => startTunnelVps(p, cfg.vpsHost || process.env.VPS_HOST || '')
      }[cfg.tunnelProvider] || startTunnel;

      const tun = await fn(PORT);
      if (tun) {
        tunnelUrl = tun.url;
        if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "tunnel-url", url: tunnelUrl }));
      } else {
        console.log(`  \x1b[31m~\x1b[0m Tunnel provider '${cfg.tunnelProvider}' failed to start on boot.`);
        if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "tunnel-error", provider: cfg.tunnelProvider }));
      }
    } else {
      console.log("  ~ Tunnel: waiting for host to choose provider...");
    }
  });
}

main();


function cleanup(isElectron = false) {
  if (_cleanupDone) return;
  _cleanupDone = true;

  console.log('\n[server] Shutting down — running cleanup...');

  // ── Terminate worker threads gracefully ──────────────────────────────────
  // Audio worker: ask it to destroy virtual audio, then terminate
  if (_audioWorker) {
    try {
      _audioWorker.postMessage({ type: 'destroy' });
      // Give it 800ms to run pactl teardown asynchronously, then force-terminate
      setTimeout(() => { try { _audioWorker && _audioWorker.terminate(); } catch (_) { } }, 800);
    } catch (_) { }
  }

  // Arcade heartbeat worker: clean shutdown
  if (_arcadeWorker) {
    try { _arcadeWorker.postMessage({ type: 'stop' }); } catch (_) { }
    setTimeout(() => { try { _arcadeWorker && _arcadeWorker.terminate(); } catch (_) { } }, 500);
  }

  if (activeTunnelProc) { try { activeTunnelProc.kill(); } catch (_) { } }
  if (activeTunnelProc) { try { activeTunnelProc.kill(); } catch (_) { } }

  // Cleanly destroy the input driver (whether it's using C++ or Python)
  try {
    inputDriver.destroy();
  } catch (e) {
    console.error("[Server] Input driver cleanup error:", e);
  }

  if (audioProc) { try { audioProc.kill(); } catch (_) { } }

  if (process.platform === 'linux') {
    const { execSync } = require('child_process');

    // THE FIX: Unload loopback BEFORE the sink to prevent the audio buzz
    const unloadOrder = ['loopback', 'remap', 'sink', 'daemonHandle'];
    for (const key of unloadOrder) {
      const id = _vAudioModules[key];
      if (id) {
        try { execSync(`pactl unload-module ${id}`, { stdio: 'ignore' }); } catch (_) { }
        console.log(`[VirtualAudio] Cleaned up ${key} module ${id}`);
      }
    }

    // Belt and braces PulseAudio cleanup
    try { execSync("pactl list short modules | awk '/NearsecAppAudio|NearsecAppMic|NearsecVirtualCapture|NearsecVirtual/{print $1}' | xargs -r pactl unload-module", { stdio: 'ignore' }); } catch (_) { }

    // PipeWire node cleanup — destroy any pw-loopback nodes created by the worker
    try {
      execSync("pw-cli list-objects | grep -A2 'Nearsec' | grep 'id ' | awk '{print $2}' | tr -d ',' | xargs -r -I{} pw-cli destroy {}", { stdio: 'ignore', timeout: 2000 });
    } catch (_) { }
    // Belt-and-braces: kill any dangling pw-loopback processes we spawned
    try { execSync("pkill -f 'pw-loopback.*Nearsec'", { stdio: 'ignore' }); } catch (_) { }
  }

  if (!isElectron) {
    killPort(activePort).catch(() => { }).finally(() => process.exit(0));
  } else {
    killPort(activePort).catch(() => { });
  }
}

process.on('SIGINT', () => cleanup(false));
process.on('SIGTERM', () => cleanup(false));

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception during runtime:', err);
  cleanup(false);
});

module.exports = { cleanup, toUinput };
