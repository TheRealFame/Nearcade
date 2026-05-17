const express = require("express");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const os = require("os");
const net = require("net");
const fs = require("fs");
const path = require('path');
const sidecarPath = __dirname.includes('app.asar')
? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'sidecar', 'input_driver.py')
: path.join(__dirname, "..", "sidecar", "input_driver.py");
const { exec, spawn } = require("child_process");
const open = (...args) => import('open').then(({default: open}) => open(...args));
const which = require("which");
const killPort = require("kill-port");
let hostWS = null;
let tunnelUrl = null;
let activeTunnelProc = null;
let uinputProc = null;
let vidCount = 0;
const viewers = new Map();
const viewerNames = new Map();
const inputPerms = new Map();
const pinAttempts = new Map();
const crypto = require("crypto");

const PusherRaw = require('pusher-js');

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
    subscribe() { return { trigger: () => {} }; }
  };
}

const pusher = new Pusher('a93f5405058cd9fc7967', {
  cluster: 'us2',
  authEndpoint: 'https://nearsec.cutefame.net/api/pusher-auth'
});

const globalArcadeChannel = pusher.subscribe('private-arcade-global');

function toUinput(msg) {
  if (!uinputProc || !uinputProc.stdin.writable) return;
  setImmediate(() => { try { uinputProc.stdin.write(JSON.stringify(msg) + "\n"); } catch { } });
}

const projectRoot = path.join(__dirname, '..', '..');
const envFile = path.join(projectRoot, '.env');
if (!fs.existsSync(envFile)) {
  fs.writeFileSync(envFile, `CF_TOKEN=\nCUSTOM_URL=\nZROK_RESERVED_NAME=\nUSE_VPS=false\nVPS_HOST=\nIS_VPS=false\n`);
}

try {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) process.env[match[1]] = (match[2] || '').trim().replace(/^['"]|['"]$/g, '');
  });
} catch (e) { }

function getLanIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const n of iface)
      if (n.family === "IPv4" && !n.internal) return n.address;
      return "127.0.0.1";
}
function shouldRequirePin(ip, hasTunnelHeader = false) {
  return true;
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

// ── Windows binary path resolver ─────────────────────────────────────────────
const WIN_BINARY_PATHS = {
  cloudflared: [
    path.join(os.homedir(), 'cloudflared.exe'),
    path.join(os.homedir(), 'bin', 'cloudflared.exe'),
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ],
  zrok: [
    path.join(os.homedir(), 'zrok', 'zrok.exe'),
    path.join(os.homedir(), 'bin', 'zrok.exe'),
  ],
  playit: [
    path.join(os.homedir(), 'playit.exe'),
    path.join(os.homedir(), 'bin', 'playit.exe'),
  ],
  ssh: [
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
  ],
};

function findBinaryPath(name) {
  return which(name).then(p => p).catch(() => {
    if (process.platform !== 'win32') return null;
    const fallbacks = WIN_BINARY_PATHS[name] || [];
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
function startTunnelCloudflared(port) {
  return new Promise(resolve => {
    findBinaryPath('cloudflared').then(cloudflaredPath => {
      if (!cloudflaredPath) { resolve(null); return; }

      if (process.env.CF_TOKEN) {
        console.log("  \x1b[33m~\x1b[0m Starting persistent Cloudflare tunnel (Token)...");
        const proc = spawn(cloudflaredPath, ["tunnel", "--no-autoupdate", "run", "--token", process.env.CF_TOKEN], { stdio: ["ignore", "pipe", "pipe"] });
        const url = process.env.CUSTOM_URL || "https://your-custom-domain.com";
        console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
        activeTunnelProc = proc;
        return resolve({ url, proc });
      }

      if (process.env.CF_TUNNEL_NAME) {
        console.log("  \x1b[33m~\x1b[0m Starting persistent Cloudflare tunnel (Locally Managed)...");
        const proc = spawn(cloudflaredPath, ["tunnel", "run", process.env.CF_TUNNEL_NAME], { stdio: ["ignore", "pipe", "pipe"] });
        const url = process.env.CUSTOM_URL || "https://your-custom-domain.com";
        console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
        activeTunnelProc = proc;
        return resolve({ url, proc });
      }

      console.log("  \x1b[33m~\x1b[0m Starting cloudflared tunnel...");
      const proc = spawn(cloudflaredPath, ["tunnel", "--url", "http://localhost:" + port], { stdio: ["ignore", "pipe", "pipe"] });
      let done = false;
      const check = data => {
        const m = data.toString().match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
        if (m && !done) { done = true; resolve({ url: m[0], proc }); console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + m[0] + "\x1b[0m"); }
      };
      proc.stdout.on("data", check); proc.stderr.on("data", check);
      proc.on("close", () => { if (!done) resolve(null); });
      setTimeout(() => { if (!done) { done = true; resolve(null); console.log("  \x1b[33m!\x1b[0m cloudflared timeout"); } }, 20000);
    }).catch(() => resolve(null));
  });
}

function startTunnelPlayit(port) {
  return new Promise(resolve => {
    findBinaryPath('playit').then(playitPath => {
      if (!playitPath) { resolve(null); return; }

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

function startTunnelVps(port, vpsHost) {
  return new Promise((resolve) => {
    findBinaryPath('ssh').then(sshPath => {
      if (!sshPath) { resolve(null); return; }

      console.log(`  \x1b[33m~\x1b[0m Clearing ghost ports on VPS...`);

      // 1. Force the VPS to kill any orphaned processes holding our port
      const killCmd = spawn(sshPath, [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        vpsHost,
        `fuser -k ${port}/tcp || true`
      ]);

      killCmd.on('close', () => {
        console.log(`  \x1b[33m~\x1b[0m Starting VPS Reverse SSH Tunnel to ${vpsHost}...`);

        // 2. Start the tunnel with aggressive keep-alive heartbeats
        const proc = spawn(sshPath, [
          "-v", "-N", "-T",
          "-o", "ExitOnForwardFailure=yes",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "ServerAliveInterval=15",
          "-o", "ServerAliveCountMax=3",
          "-R", `0.0.0.0:${port}:localhost:${port}`, vpsHost
        ], { stdio: ["ignore", "pipe", "pipe"] });

        const url = process.env.CUSTOM_URL || `http://${vpsHost.split('@').pop().trim()}:${port}`;
        let done = false;

        proc.stderr.on("data", data => {
          const out = data.toString();
          // Hide the verbose SSH logs unless debugging is needed to keep terminal clean
          if ((out.includes("remote forward success") || out.includes("Forwarding address")) && !done) {
            done = true;
            process.env.USING_TUNNEL = "true";
            activeTunnelProc = proc;
            resolve({ url, proc });
          }
        });

        proc.on("close", () => { if (!done) resolve(null); });

        setTimeout(() => {
          if (!done) {
            done = true;
            process.env.USING_TUNNEL = "true";
            activeTunnelProc = proc;
            resolve({ url, proc });
          }
        }, 5000);
      });
    }).catch(() => resolve(null));
  });
}

function startTunnelZrok(port) {
  return new Promise(async (resolve) => {
    // Check PATH and Windows home-dir fallbacks
    const zrokPath = await findBinaryPath('zrok').then(p => p).catch(() => null)
    || await findBinaryPath('zrok2').then(p => p).catch(() => null)
    || (function() {
      // Manual scan of known Linux/Windows locations
      const candidates = [
        '/usr/bin/zrok2', '/usr/bin/zrok', '/usr/local/bin/zrok',
        path.join(os.homedir(), 'bin/zrok'),
        './zrok',
        // Windows paths (already covered by findBinaryPath fallback, but belt-and-suspenders)
        path.join(os.homedir(), 'zrok', 'zrok.exe'),
      ];
      for (const c of candidates) if (fs.existsSync(c)) return c;
      return null;
    })();

    if (!zrokPath) { resolve(null); return; }

    console.log(`  \x1b[33m~\x1b[0m Starting zrok public share (${zrokPath})...`);
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
    proc.on("close", () => { if (!done) resolve(null); });
    setTimeout(() => { if (!done) { done = true; proc.kill(); resolve(null); } }, 20000);
  });
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
function makePin() { return String(Math.floor(1000 + Math.random() * 9000)); }

// ── Arcade session registry ───────────────────────────────────────────────────
const arcadeSessions = new Map();
const arcadeClients  = new Set();
let   arcadeHostId   = 0;

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
const CONFIG_FILE = path.join(projectRoot, 'config', 'nearsectogether.config.json');
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
    console.log("  AUDIO:    Using Windows Media Player (via PowerShell)");
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

  const PORT = await findFreePort(3000);
  const LAN_IP = getLanIP();
  const PUBLIC_IP = await getPublicIP();
  let PIN = makePin();
  let pinEnabled = true;

  console.log("\n  \x1b[1mNearsecTogether\x1b[0m");
  console.log("  Host page : http://localhost:" + PORT + "/host");
  console.log("  LAN URL   : http://" + LAN_IP + ":" + PORT + "/");
  if (PUBLIC_IP) console.log("  Public IP : http://" + PUBLIC_IP + ":" + PORT + "/ (needs port forward)");
    console.log("  PIN       : \x1b[1;32m" + PIN + "\x1b[0m\n");

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  app.use((req, res, next) => {
    res.setHeader("Permissions-Policy", "gamepad=*, display-capture=(self)");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  const APP_VERSION = "1.0.0";

  app.use("/js", express.static(path.join(__dirname, "..", "..", "src", "scripts")));
  app.use("/assets", express.static(path.join(__dirname, "..", "..", "assets")));

  const pagesDir = path.join(__dirname, "..", "..", "src/pages");

  app.get("/", (req, res) => res.sendFile(path.join(pagesDir, "index.html")));
  app.get("/host", (req, res) => res.sendFile(path.join(pagesDir, "host.html")));
  app.get("/gamepad-popup.html", (req, res) => res.sendFile(path.join(pagesDir, "gamepad-popup.html")));

  app.get("/api/info", (req, res) => res.json({ lanIP: LAN_IP, port: PORT, pin: PIN, publicIP: PUBLIC_IP || null, tunnelUrl: tunnelUrl || null, version: APP_VERSION }));
  app.get("/api/pin-required", (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const hasTunnelHeader = !!req.headers['x-forwarded-for'] || !!req.headers['cf-connecting-ip'];
    res.json({ required: pinEnabled && shouldRequirePin(clientIp, hasTunnelHeader) });
  });
  app.get("/api/config", (req, res) => res.json(loadConfig()));
  app.post("/api/config", express.json(), (req, res) => { res.json(saveConfig(req.body || {})); });

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
    if (process.platform !== 'linux') return res.json({ success: false, error: "Linux only feature" });

    // pactl load-module module-null-sink is the universal command for BOTH PulseAudio and PipeWire.
    exec('pactl load-module module-null-sink sink_name=NearsecAppAudio sink_properties=device.description="Nearsec_App_Audio"', (err) => {
      if (err) return res.json({ success: false, error: err.message });
      res.json({ success: true });
    });
  });

  app.get("/api/arcade/sessions", (req, res) => {
    res.json([...arcadeSessions.values()]);
  });

  app.post("/api/start-tunnel", express.json(), async (req, res) => {
    if (tunnelUrl) {
      const msg = JSON.stringify({ type: "tunnel-url", url: tunnelUrl });
      if (hostWS && hostWS.readyState === 1) hostWS.send(msg);
      return res.json({ url: tunnelUrl });
    }
    const provider = (req.body && req.body.provider) || "cloudflared";
    if (req.body && req.body.remember) saveConfig({ tunnelProvider: provider, neverAsk: true });
    res.json({ ok: true, starting: true });

    const fn = {
      zrok: startTunnelZrok,
      cloudflared: startTunnelCloudflared,
      playit: startTunnelPlayit,
      localhostrun: startTunnelLocalhostRun,
      vps: (p) => startTunnelVps(p, ((req.body && req.body.vpsHost) || process.env.VPS_HOST || '').trim()),
           portforward: async () => null
    }[provider] || startTunnel;

    if (provider === 'vps' && req.body && req.body.vpsHost) {
      saveConfig({ vpsHost: req.body.vpsHost });
    }

    const tun = await fn(PORT);
    if (tun) {
      tunnelUrl = tun.url;
      const msg = JSON.stringify({ type: "tunnel-url", url: tunnelUrl });
      if (hostWS && hostWS.readyState === 1) hostWS.send(msg);
      viewers.forEach(vws => { if (vws.readyState === 1) vws.send(msg); });
    } else {
      if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "tunnel-error", provider }));
    }
  });

  // ── uinput sidecar ─────────────────────────────────────────────────────────
  const sidecar = path.join(__dirname, "..", "sidecar", "input_driver.py");
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  if (fs.existsSync(sidecar)) {
    try {
      uinputProc = spawn(pythonCmd, [sidecar], { stdio: ["pipe", "inherit", "inherit"], detached: false });
      uinputProc.stdin.on("error", () => { });
      uinputProc.on("error", e => console.log("[uinput] spawn error:", e.message));
      uinputProc.on("close", () => { uinputProc = null; console.log("[uinput] sidecar exited"); });
      console.log("[uinput] sidecar started");
    } catch (err) {
      console.warn("[uinput] Failed to start Python sidecar:", err.message);
      uinputProc = null;
    }
  } else {
    console.log("[uinput] sidecar not found at", sidecar);
  }

  let hostStreaming = false;
  const audioViewers = new Set();
  const viewerGamepads = new Map();
  const viewerHasController = new Set();
  const hwIdToViewer = new Map();

  const JOIN_SOUND = require('path').join(__dirname, '../../assets/joinsound.wav');
  const LEAVE_SOUND = require('path').join(__dirname, '../../assets/leavesound.wav');
  const { playSound: playSoundUtil } = require('./audio-util');

  function playSound(file) {
    if (!fs.existsSync(file)) return;
    playSoundUtil(file, (err) => {
      if (err) console.log("[audio] Could not play sound on " + process.platform + ":", err.message);
    });
  }
  function playJoinSound() { playSound(JOIN_SOUND); }
  function playLeaveSound() { playSound(LEAVE_SOUND); }

  function broadcast(data) {
    viewers.forEach(vws => { if (vws.readyState === 1) vws.send(data); });
  }

  function controllerViewerCount() {
    return viewerHasController.size;
  }

  function broadcastRoster() {
    const roster = [];
    viewers.forEach((vws, id) => {
      const pads = viewerGamepads.get(id) || new Set([0]);
      pads.forEach(padIdx => {
        const isExtra = padIdx > 0;
        const nameSuffix = isExtra ? ' ' + (padIdx + 1) : '';
        const rosterId = id + '_' + padIdx;
        const p = inputPerms.get(rosterId) || { gp: true, kb: false, slot: null };

        let mode = 'gamepad';
        if (!p.gp && p.kb) mode = 'kbm';
        else if (p.gp && p.kb) mode = 'kbm_emulated';
        else if (!p.gp && !p.kb) mode = 'disabled';

        roster.push({
          id: rosterId,
          name: (viewerNames.get(id) || id) + nameSuffix,
                    gp: !!p.gp,
                    kb: !!p.kb,
                    slot: p.slot ?? null,
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
      viewers.forEach((_, id) => ws.send(JSON.stringify({ type: "viewer-joined", viewerId: id, name: viewerNames.get(id) || id })));
      if (tunnelUrl) ws.send(JSON.stringify({ type: "tunnel-url", url: tunnelUrl }));

      ws.on("message", raw => {
        try {
          const msg = JSON.parse(raw);

          if ((msg.type === "offer" || msg.type === "ice-host") && msg._viewerId) {
            const vws = viewers.get(msg._viewerId);
            if (vws && vws.readyState === 1) vws.send(JSON.stringify(msg));
            return;
          }

          if (msg.type === "set-pin") { pinEnabled = !!msg.enabled; return; }

          if (msg.type === "set-input") {
            const cur = inputPerms.get(msg.viewerId) || { gp: true, kb: false, slot: null };
            inputPerms.set(msg.viewerId, { gp: !!msg.gp, kb: !!msg.kb, slot: cur.slot });
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

          if (msg.type === "ctrl-settings") {
            toUinput({ type: 'set_force_xboxone',    value: !!msg.forceXboxOne });
            toUinput({ type: 'set_enable_dualshock', value: !!msg.enableDualShock });
            toUinput({ type: 'set_enable_motion',    value: !!msg.enableMotion });
            console.log("[host] ctrl-settings: forceXboxOne=%s enableDualShock=%s enableMotion=%s",
                        !!msg.forceXboxOne, !!msg.enableDualShock, !!msg.enableMotion);
            return;
          }

          if (msg.type === "panic_toggle") {
            toUinput({ type: 'panic_toggle', enabled: !!msg.enabled });
            console.log("[host] KBM Panic Mode: %s", !!msg.enabled ? "ACTIVATED" : "Released");
            return;
          }

          if (msg.type === "set-input-mode") {
            const modeMap = {
              gamepad:      { gp: true,  kb: false },
              kbm:          { gp: false, kb: true  },
              kbm_emulated: { gp: true,  kb: true  },
              disabled:     { gp: false, kb: false  }
            };
            const perms = modeMap[msg.mode] || { gp: true, kb: false };
            const cur = inputPerms.get(msg.viewerId) || { gp: true, kb: false, slot: null };
            inputPerms.set(msg.viewerId, { ...cur, ...perms });
            const realId = msg.viewerId.split('_')[0];
            const vws = viewers.get(realId);
            if (vws && vws.readyState === 1) {
              vws.send(JSON.stringify({ type: "input-state", gp: perms.gp, kb: perms.kb, mode: msg.mode }));
            }
            toUinput({ type: 'set-input-mode', viewerId: msg.viewerId, mode: msg.mode });
            broadcastRoster();
            return;
          }

          if (msg.type === "toggle-slot-lock") {
            const cur = inputPerms.get(msg.viewerId) || { gp: true, kb: false, slot: null };
            inputPerms.set(msg.viewerId, { ...cur, locked: !!msg.locked });
            broadcastRoster();
            return;
          }

          if (msg.type === "regen-pin") {
            PIN = makePin();
            console.log("[host] PIN regenerated:", PIN);
            if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "regen-pin", pin: PIN }));
            return;
          }

          if (msg.type === "arcade-session-start") {
            const arcadeUrl = msg.tunnelUrl || tunnelUrl;
            if (!arcadeUrl) {
              if (hostWS && hostWS.readyState === 1)
                hostWS.send(JSON.stringify({ type: 'arcade-session-error', reason: 'No tunnel URL active. Start a tunnel first.' }));
              return;
            }
            if (!isAllowedArcadeUrl(arcadeUrl)) {
              console.warn("[arcade] Rejected URL — not in whitelist:", arcadeUrl);
              if (hostWS && hostWS.readyState === 1)
                hostWS.send(JSON.stringify({ type: 'arcade-session-error', reason: 'Tunnel provider not allowed.' }));
              return;
            }
            if (!hostStreaming) {
              if (hostWS && hostWS.readyState === 1)
                hostWS.send(JSON.stringify({ type: 'arcade-session-error', reason: 'No active stream. Start sharing your screen first.' }));
              return;
            }
            const sessionId = 'ns-' + Date.now() + '-' + (++arcadeHostId);
            const session = {
              id: sessionId,
              game: sanitize(msg.config?.title || 'Arcade Game'),
            thumbnail: msg.config?.thumbnail || null,
            region: 'Nearsec Arcade',
            hasPin: !!msg.config?.requirePin,
            maxPlayers: parseInt(msg.config?.maxPlayers || 4),
            url: arcadeUrl,
            startedAt: Date.now(),
            isStreaming: true,
            };
            arcadeSessions.set(sessionId, session);
            console.log("[arcade] Session registered:", session.game, arcadeUrl);
            broadcastToArcade({ type: 'arcade-session-active', session });
            if (hostWS && hostWS.readyState === 1)
              hostWS.send(JSON.stringify({ type: 'arcade-session-active', session }));
            globalArcadeChannel.trigger('client-session-active', { session });
            return;
          }

          if (msg.type === "arcade-session-stop") {
            for (const [id, s] of arcadeSessions) {
              arcadeSessions.delete(id);
              broadcastToArcade({ type: 'arcade-session-stopped', id });
              console.log("[arcade] Session stopped:", s.game);
              globalArcadeChannel.trigger('client-session-stopped', { id });
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
      });

      // ── VIEWER ───────────────────────────────────────────────────────────────
    } else if (wsPath === "/ws/viewer") {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const hasTunnelHeader = !!req.headers['x-forwarded-for'] || !!req.headers['cf-connecting-ip'];
      const requirePin = shouldRequirePin(clientIp, hasTunnelHeader);

      if (pinEnabled && requirePin) {
        const attempt = pinAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };
        if (Date.now() < attempt.lockedUntil) {
          try { ws.send(JSON.stringify({ type: "pin-rejected", reason: "rate-limited" })); } catch { }
          ws.close();
          console.log(`[viewer] rejected — IP ${clientIp} is rate-limited`);
          return;
        }
        if (pin !== PIN) {
          attempt.count++;
          if (attempt.count >= 6) {
            attempt.lockedUntil = Date.now() + 2 * 60 * 1000;
            console.log(`[viewer] IP ${clientIp} locked out for 2 minutes (PIN brute-force)`);
          }
          pinAttempts.set(clientIp, attempt);
          try { ws.send(JSON.stringify({ type: "pin-rejected" })); } catch { }
          ws.close();
          console.log("[viewer] rejected — wrong PIN");
          return;
        }
        pinAttempts.delete(clientIp);
      } else {
        console.log(`[viewer] IP ${clientIp} (requirePin=${requirePin}) bypassing PIN check`);
      }

      let id = "v" + (++vidCount);
      const defaultName = "Guest" + (1000 + Math.floor(Math.random() * 9000));
      viewers.set(id, ws);
      viewerNames.set(id, defaultName);
      inputPerms.set(id + '_0', { gp: true, kb: false, slot: null });
      console.log("[viewer]", id, "(" + defaultName + ") joined (" + viewers.size + " total, " + controllerViewerCount() + " with controllers)");

      ws.send(JSON.stringify({ type: "your-id", viewerId: id, name: defaultName }));
      ws.send(JSON.stringify({ type: "input-state", gp: true, kb: false }));

      if (hostWS && hostWS.readyState === 1) {
        hostWS.send(JSON.stringify({ type: "viewer-joined", viewerId: id, name: defaultName }));

        // CRITICAL BUG FIX: Force the late viewer to recognize the host is online
        ws.send(JSON.stringify({ type: "host-connected" }));

        if (hostStreaming) {
          ws.send(JSON.stringify({ type: "host-stream-ready" }));
        }
      }

      broadcastRoster();

      ws.on("message", raw => {
        try {
          const msg = JSON.parse(raw);

          if (msg.type === "answer" || msg.type === "ice-viewer") {
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
              console.log("[viewer] slot cap reached (16 total pads), ignoring controller from", id);
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

          if (msg.type === "gamepad" || msg.type === "keyboard") {
            if (msg.type === "keyboard") msg.type = "kbm";
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

            const perms = inputPerms.get(rosterId) || { gp: true, kb: false };
            if (msg.type === "gamepad" && !perms.gp) return;
            if (msg.type === "kbm" && !perms.kb) return;

            msg.pad_id = rosterId;
            toUinput(msg);
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
          if (hostWS && hostWS.readyState === 1) hostWS.send(JSON.stringify({ type: "viewer-left", viewerId: id }));
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
          if (msg.type === "gamepad") { toUinput(msg); return; }
          if (msg.type === "keyboard") {
            if (!myId) return;
            const perms = inputPerms.get(myId) || { gp: true, kb: false };
            if (!perms.kb) return;
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

  server.listen(PORT, "0.0.0.0", async () => {
    console.log("Listening on port " + PORT);
    if (!process.env.ELECTRON_MODE) openBrowser("http://localhost:" + PORT + "/host");
      const cfg = loadConfig();

    if (process.env.USE_VPS === 'true' && process.env.VPS_HOST) {
      console.log("  ~ Tunnel: VPS (from .env)");
      const tun = await startTunnelVps(PORT, process.env.VPS_HOST.trim());
      if (tun) {
        tunnelUrl = tun.url;
        if (hostWS && hostWS.readyState === 1)
          hostWS.send(JSON.stringify({ type: "tunnel-url", url: tunnelUrl }));
      }
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
        if (hostWS && hostWS.readyState === 1)
          hostWS.send(JSON.stringify({ type: "tunnel-url", url: tunnelUrl }));
      }
    } else {
      console.log("  ~ Tunnel: waiting for host to choose provider...");
    }
  });
}

main();

function cleanup(isElectron = false) {
  console.log("\n  \x1b[33m!\x1b[0m Shutting down... cleaning up ports and processes.");

  if (process.platform === 'linux') {
    const { exec } = require("child_process");
    exec("pactl list short modules | grep NearsecAppAudio | cut -f1 | xargs -r pactl unload-module", () => {});
  }

  if (activeTunnelProc) {
    try { activeTunnelProc.kill(); } catch (e) { }
  }
  if (uinputProc) {
    try {
      if (uinputProc.stdin && uinputProc.stdin.writable) {
        uinputProc.stdin.write(JSON.stringify({ type: 'destroy_all' }) + "\n");
      }
      uinputProc.kill();
    } catch (e) { }
  }
  if (!isElectron) {
    killPort(3000).catch(() => {}).finally(() => process.exit());
  } else {
    killPort(3000).catch(() => {});
  }
}

process.on('SIGINT', () => cleanup(false));
process.on('SIGTERM', () => cleanup(false));

module.exports = { cleanup, toUinput };
