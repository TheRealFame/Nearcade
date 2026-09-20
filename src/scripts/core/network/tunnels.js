const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const which = require("which");

let currentTunnelProc = null;
let currentTunnelUrl = null;
let currentTunnelProvider = null;
let currentZrokShareToken = null;
// Every share token minted by this process (bounded). zrok hands out a NEW
// random token per `share public`, so retries/timeouts orphan reservations
// the single `currentZrokShareToken` never knew about — this list + the
// on-disk list close that gap. Tokens are capabilities: never logged.
let createdZrokShareTokens = [];
const MAX_TRACKED_TOKENS = 20;

function shareFilePath() {
  return path.join(__dirname, '..', '..', '.zrok_last_share');
}

function readShareTokens() {
  try {
    const f = shareFilePath();
    if (!fs.existsSync(f)) return [];
    const raw = fs.readFileSync(f, 'utf8').trim();
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string');
    } catch (_) {}
    return raw.length >= 3 ? [raw] : []; // legacy single-token format
  } catch (_) { return []; }
}

function writeShareTokens(arr) {
  try {
    fs.writeFileSync(shareFilePath(), JSON.stringify(arr.slice(0, MAX_TRACKED_TOKENS)), { mode: 0o600 });
    try { fs.chmodSync(shareFilePath(), 0o600); } catch (_) {}
  } catch (_) {}
}

function rememberZrokToken(t) {
  if (!t || typeof t !== 'string') return;
  createdZrokShareTokens = [t, ...createdZrokShareTokens.filter((x) => x !== t)].slice(0, MAX_TRACKED_TOKENS);
  try {
    const arr = readShareTokens();
    if (!arr.includes(t)) {
      arr.unshift(t);
      writeShareTokens(arr);
    }
  } catch (_) {}
}

function forgetZrokToken(t) {
  createdZrokShareTokens = createdZrokShareTokens.filter((x) => x !== t);
  try { writeShareTokens(readShareTokens().filter((x) => x !== t)); } catch (_) {}
}

// Best-effort synchronous delete. Returns true when the reservation is gone
// (or was already gone). Never logs the token. SYNC BLOCKS THE EVENT LOOP —
// the server runs IN-PROCESS in Electron's main thread, so this is ONLY for
// the shutdown sweep (bounded, app is exiting). Everything else uses the
// async variant below.
// CAUTION: zrok2 has no `delete share` subcommand (it 404s) — v2 releases
// reservations via `delete name <token>`. v1 keeps `release <token>`.
function deleteZrokShareSync(zrokPath, token) {
  try {
    if (!zrokPath || !token) return false;
    const args = zrokPath.includes('zrok2') ? ['delete', 'name', token] : ['release', token];
    const r = require('child_process').spawnSync(zrokPath, args, { stdio: 'ignore', timeout: 8000 });
    return !!(r && r.status === 0);
  } catch (_) { return false; }
}

// Async twin: same semantics, never blocks. Use everywhere except shutdown.
function deleteZrokShareAsync(zrokPath, token) {
  return new Promise((resolve) => {
    try {
      if (!zrokPath || !token) return resolve(false);
      const args = zrokPath.includes('zrok2') ? ['delete', 'name', token] : ['release', token];
      require('child_process').execFile(zrokPath, args, { timeout: 8000 }, (err) => resolve(!err));
    } catch (_) { resolve(false); }
  });
}

// Orphan reaper: list IDLE shares and delete the ones pointing at our local
// port that are not live. Heals reservations orphaned by timeouts, retries
// and crashes (whose tokens we never learned). Never touches shares for
// other targets, never touches the live share. Silent unless it reaps.
async function reapStaleZrokShares(port) {
  const run = async () => {
    const zrokPath = findZrokBinarySync();
    if (!zrokPath) return 0;
    const { execFile } = require('child_process');
    const out = await new Promise((resolve) => {
      execFile(zrokPath, ['list', 'shares', '--json', '-I'], { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout);
      });
    });
    if (!out) return 0;
    let items;
    try {
      const d = JSON.parse(out);
      items = Array.isArray(d) ? d : (d.data || d.shares || d.items || []);
    } catch (_) { return 0; }
    if (!Array.isArray(items)) return 0;
    const portStr = ':' + port;
    const live = new Set([currentZrokShareToken, ...createdZrokShareTokens].filter(Boolean));
    const nowMs = Date.now();
    let n = 0;
    for (const s of items) {
      try {
        const token = s.shareToken || s.token;
        const target = String(s.target || s.backendTarget || '');
        if (!token || live.has(token)) continue;
        if (!target.includes(portStr)) continue;
        // Age guard (10 min): a freshly minted share is idle until its first
        // viewer, and a sibling process (second server, Electron + node) may
        // legitimately own it — this reaper must never eat live shares.
        // Unknown-age entries are still reaped (idle + port-match + not-live
        // is enough); known-young ones are left alone.
        let ageMs = Infinity;
        try {
          const cands = [Date.parse(s.createdAt), Date.parse(s.updatedAt)].filter((v) => Number.isFinite(v));
          if (cands.length) ageMs = nowMs - Math.max(...cands);
        } catch (_) {}
        if (ageMs <= 600000) continue;
        // Async: the sync variant freezes Electron's main thread (in-process
        // server) for up to 8s PER SHARE — with dozens of orphans that was
        // a minute-plus app freeze on every tunnel start.
        if (await deleteZrokShareAsync(zrokPath, token)) { n++; forgetZrokToken(token); }
      } catch (_) {}
    }
    return n;
  };
  try {
    const n = await Promise.race([
      run(),
      new Promise((res) => setTimeout(() => res(-1), 20000)),
    ]);
    if (n > 0) console.log(`  [tunnel] Reaped ${n} stale zrok share(s).`);
  } catch (_) {}
}

function stopCurrentTunnel() {
  // zrok2 share ignores SIGTERM (orphaned procs piled up for hours) — it
  // needs SIGKILL. Others get TERM with a KILL fallback.
  const hardKill = currentTunnelProvider === 'zrok';
  const stoppedProvider = currentTunnelProvider;
  if (currentTunnelProc) {
    try {
      if (hardKill) currentTunnelProc.kill('SIGKILL');
      else {
        currentTunnelProc.kill();
        const _p = currentTunnelProc;
        setTimeout(() => { try { if (_p.exitCode === null) _p.kill('SIGKILL'); } catch (_) {} }, 1500);
      }
    } catch (e) {}
    currentTunnelProc = null;
  }
  // Delete the live share plus tracked tokens (this run + file from
  // previous runs). Each delete is verified; survivors stay tracked.
  // Bounded by count AND wall-clock: sync deletes that outlive a 4s budget
  // (slow/flaky controller) must never stall server shutdown past the
  // test-suite failsafe — leftovers are picked up by the background reaper.
  const t0 = Date.now();
  const zrokPath = findZrokBinarySync();
  const tokens = [...new Set([currentZrokShareToken, ...createdZrokShareTokens, ...readShareTokens()].filter(Boolean))].slice(0, 5);
  for (const t of tokens) {
    if (Date.now() - t0 > 4000) break;
    if (deleteZrokShareSync(zrokPath, t)) forgetZrokToken(t);
  }
  currentZrokShareToken = null;
  createdZrokShareTokens = [];
  // `tailscale serve` writes daemon-side state that outlives both the proc
  // (there is none tracked) and this stop: without an explicit reset, ghost
  // routes keep serving a dead port on the tailnet after every switch/stop.
  // Async fire-and-forget only — never block shutdown on the daemon.
  // NOTE: reset clears all serve configs; the app owns the tunnel lifecycle,
  // so a stale dead route is worse than a wiped custom one.
  if (stoppedProvider === 'tailscale-serve') {
    findBinaryPath('tailscale').then((tp) => {
      if (!tp) return;
      require('child_process').execFile(tp, ['serve', 'reset'], { timeout: 10000 }, () => {});
    }).catch(() => {});
  }
  currentTunnelUrl = null;
  currentTunnelProvider = null;
}

// ── Last-Provider Persistence ────────────────────────────────────────────────

const LAST_PROV_FILE = path.join(os.homedir(), '.config', 'Nearcade', '.last-provider');

function saveLastProvider(provider) {
  if (!provider) return;
  try {
    const dir = path.dirname(LAST_PROV_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LAST_PROV_FILE, provider, 'utf8');
  } catch (_) {}
}

function getLastProvider() {
  try {
    if (fs.existsSync(LAST_PROV_FILE)) return fs.readFileSync(LAST_PROV_FILE, 'utf8').trim() || null;
  } catch (_) {}
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

const isArm = os.arch() === 'arm64';
const appBinDir = path.join(__dirname, '..', '..', '..', '..', 'bin', 'bin');
const appDataBinDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Nearcade', 'bin');

const FALLBACK_PATHS = {
  cloudflared: [
    isArm ? path.join(appBinDir, 'cloudflared-arm64.exe') : path.join(appBinDir, 'cloudflared.exe'),
    isArm ? path.join(appBinDir, 'cloudflared-arm64') : path.join(appBinDir, 'cloudflared'),
    path.join(appDataBinDir, 'cloudflared.exe'),
    path.join(appDataBinDir, 'cloudflared-windows-amd64.exe'),
    path.join(appDataBinDir, 'cloudflared'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'cloudflared.exe'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'cloudflared'),
    path.join(os.homedir(), 'cloudflared.exe'),
    path.join(os.homedir(), 'bin', 'cloudflared.exe'),
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(os.homedir(), 'cloudflared'),
    path.join(os.homedir(), 'bin', 'cloudflared'),
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared'
  ],
  zrok: [
    isArm ? path.join(appBinDir, 'zrok2-arm64.exe') : path.join(appBinDir, 'zrok2.exe'),
    isArm ? path.join(appBinDir, 'zrok2-arm64') : path.join(appBinDir, 'zrok2'),
    path.join(appDataBinDir, 'zrok2.exe'),
    path.join(appDataBinDir, 'zrok.exe'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'zrok2.exe'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'zrok.exe'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'zrok2'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'zrok'),
    path.join(os.homedir(), 'zrok', 'zrok.exe'),
    path.join(os.homedir(), 'bin', 'zrok.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'zrok', 'zrok.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'zrok', 'zrok.exe'),
    'C:\\Program Files\\zrok\\zrok.exe',
    'C:\\Program Files (x86)\\zrok\\zrok.exe',
    path.join(os.homedir(), 'zrok', 'zrok'),
    path.join(os.homedir(), 'bin', 'zrok'),
    path.join(os.homedir(), 'bin', 'zrok2')
  ],
  zrok2: [
    isArm ? path.join(appBinDir, 'zrok2-arm64.exe') : path.join(appBinDir, 'zrok2.exe'),
    isArm ? path.join(appBinDir, 'zrok2-arm64') : path.join(appBinDir, 'zrok2'),
    path.join(appDataBinDir, 'zrok2.exe'),
    path.join(appDataBinDir, 'zrok.exe'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'zrok2.exe'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'zrok.exe'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'zrok2'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'zrok'),
    path.join(os.homedir(), 'zrok', 'zrok2.exe'),
    path.join(os.homedir(), 'bin', 'zrok2.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'zrok', 'zrok2.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'zrok', 'zrok2.exe'),
    'C:\\Program Files\\zrok\\zrok2.exe',
    path.join(os.homedir(), 'zrok', 'zrok2'),
    path.join(os.homedir(), 'bin', 'zrok2')
  ],
  playit: [
    path.join(appDataBinDir, 'playit.exe'),
    path.join(appDataBinDir, 'playit'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'playit.exe'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'playit'),
    path.join(os.homedir(), 'playit.exe'),
    path.join(os.homedir(), 'bin', 'playit.exe'),
    path.join(os.homedir(), 'playit'),
    path.join(os.homedir(), 'bin', 'playit')
  ],
  ssh: [
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
  ],
  tailscale: [
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    path.join(os.homedir(), 'bin', 'tailscale'),
  ],
  'zerotier-cli': [
    '/usr/bin/zerotier-cli',
    '/usr/local/bin/zerotier-cli',
    path.join(os.homedir(), 'bin', 'zerotier-cli'),
  ],
  wg: ['/usr/bin/wg', '/usr/local/bin/wg'],
  'wg-quick': ['/usr/bin/wg-quick', '/usr/local/bin/wg-quick'],
};

async function findBinaryPath(name) {
  return which(name).then(p => p).catch(async () => {
    const fallbacks = FALLBACK_PATHS[name] || [];
    for (const p of fallbacks) {
      if (fs.existsSync(p)) {
        try {
          const stat = fs.statSync(p);
          if (!stat.isFile()) continue;
          if (process.platform !== 'win32') ensureExecutable(p);
          const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
          await fs.promises.access(p, mode);
          console.log(`  [tunnel] Found ${name} at fallback path: ${p}`);
          return p;
        } catch (_) {}
      }
    }
    return null;
  });
}

function ensureExecutable(binPath) {
  if (!binPath) return;
  const sysPaths = ['/usr/bin/', '/usr/local/bin/', '/bin/', '/sbin/', '/usr/sbin/'];
  if (sysPaths.some(p => binPath.startsWith(p))) return;
  try { fs.chmodSync(binPath, 0o755); } catch (e) { console.warn('[chmod]', binPath, e.message); }
}

function findZrokBinarySync() {
  // Synchronous version for cleanup on shutdown
  const candidates = [
    'zrok2', 'zrok',
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'zrok2'),
    path.join(os.homedir(), '.config', 'Nearcade', 'bin', 'zrok'),
    '/usr/bin/zrok2', '/usr/bin/zrok', '/usr/local/bin/zrok2', '/usr/local/bin/zrok',
    path.join(os.homedir(), 'bin', 'zrok2'), path.join(os.homedir(), 'bin', 'zrok'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (!stat.isFile()) continue;
        if (process.platform !== 'win32') ensureExecutable(p);
        const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
        fs.accessSync(p, mode);
        return p;
      }
    } catch (_) {}
  }
  return null;
}

function getTailscaleIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const n of iface)
      if (n.family === "IPv4" && n.address.startsWith("100.")) return n.address;
  return null;
}

function openBrowser(url) {
  import('open').then(({ default: open }) => open(url)).catch(() => { });
}

// ── Primary tunnel implementations ──────────────────────────────────────────

// Shared end-to-end check: a printed URL is NOT a working tunnel (zrok taught
// us that; Cloudflare's restricted edges answer 404/530 HTML). Resolves true
// only when the public URL serves OUR /api/info with a version field.
function verifyTunnelUrl(url, { tries = 4, gapMs = 1500, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let n = 0, done = false;
    const apiUrl = url.replace(/\/?(\?.*)?$/, '/api/info$1');
    const probe = async () => {
      if (done) return;
      n++;
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), timeoutMs);
        const r = await fetch(apiUrl, { signal: ctl.signal });
        clearTimeout(to);
        if (r && r.ok) {
          const j = await r.json().catch(() => null);
          if (j && j.version) { done = true; return resolve(true); }
        }
      } catch (_) {}
      if (!done && n < tries) setTimeout(probe, gapMs);
      else if (!done) { done = true; resolve(false); }
    };
    probe();
  });
}

function startTunnelCloudflared(port, retries = 2) {
  return new Promise(resolve => {
    findBinaryPath('cloudflared').then(cloudflaredPath => {
      if (!cloudflaredPath) { resolve({ error: 'NOT_FOUND', provider: 'cloudflared' }); return; }
      ensureExecutable(cloudflaredPath);

      const cfToken = readEnv('CF_TOKEN');
      if (cfToken) {
        console.log("  \x1b[33m~\x1b[0m Starting persistent Cloudflare tunnel (Token)...");
        const proc = spawn(cloudflaredPath, ["tunnel", "--no-autoupdate", "--url", "http://localhost:" + port], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const url = (readEnv('CUSTOM_URL') || "https://your-custom-domain.com").replace(/\/$/, "") + '/?v3';
        verifyTunnelUrl(url, { tries: 3 }).then((ok) => {
          if (ok) {
            console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
            console.log("  \x1b[32m✓\x1b[0m Tunnel verified end-to-end.");
            resolve({ url, proc });
          } else {
            console.log("  \x1b[31m!\x1b[0m Custom domain did not serve our API — check the tunnel routing.");
            try { proc.kill(); } catch (_) {}
            resolve(null);
          }
        });
        return;
      }

      const cfName = readEnv('CF_TUNNEL_NAME');
      if (cfName) {
        console.log("  \x1b[33m~\x1b[0m Starting persistent Cloudflare tunnel (Locally Managed)...");
        const proc = spawn(cloudflaredPath, ["tunnel", "--no-autoupdate", "--protocol", "http2", "run", cfName], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const url = (readEnv('CUSTOM_URL') || "https://your-custom-domain.com").replace(/\/$/, "") + '/?v3';
        verifyTunnelUrl(url, { tries: 3 }).then((ok) => {
          if (ok) {
            console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
            console.log("  \x1b[32m✓\x1b[0m Tunnel verified end-to-end.");
            resolve({ url, proc });
          } else {
            console.log("  \x1b[31m!\x1b[0m Named tunnel did not serve our API — check `cloudflared tunnel info " + cfName + "`.");
            try { proc.kill(); } catch (_) {}
            resolve(null);
          }
        });
        return;
      }

      console.log("  \x1b[33m~\x1b[0m Starting cloudflared tunnel...");
      console.log("  \x1b[33m~\x1b[0m (binary: " + cloudflaredPath + ")");
      console.log("  \x1b[31m!\x1b[0m WARNING: Free Cloudflare tunnels (trycloudflare.com) are currently heavily restricted.");

      const proc = spawn(cloudflaredPath, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", "http://127.0.0.1:" + port], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let done = false, verifying = false;
      const check = data => {
        const m = data.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m && !done && !verifying) {
          verifying = true;
          const url = m[0] + '/?v3';
          console.log("  \x1b[33m~\x1b[0m Edge URL printed — verifying it actually reaches us (restricted edges answer 404/530)...");
          verifyTunnelUrl(url).then((ok) => {
            if (done) return;
            if (ok) {
              done = true;
              clearTimeout(timeoutHandle);
              console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
              console.log("  \x1b[32m✓\x1b[0m Tunnel verified end-to-end.");
              resolve({ url, proc });
            } else {
              console.log("  \x1b[33m!\x1b[0m Edge is restricted (no our-server answer) — respawning for a clean edge...");
              try { proc.kill('SIGKILL'); } catch (_) {}
              if (retries > 0) setTimeout(() => resolve(startTunnelCloudflared(port, retries - 1)), 2000);
              else { done = true; clearTimeout(timeoutHandle); resolve(null); }
            }
          });
        }
      };
      proc.stderr.on("data", check);
      // Surface the binary's own diagnostics on early death: a proc that
      // exits before printing a URL otherwise fails with zero explanation.
      let _cfErrBuf = '';
      proc.stderr.on('data', (d) => { _cfErrBuf = (_cfErrBuf + d.toString()).slice(-3000); });
      proc.on("error", (e) => {
        if (!done) {
          done = true; clearTimeout(timeoutHandle);
          console.log("  \x1b[33m!\x1b[0m cloudflared spawn error: " + (e && e.message ? e.message : e));
          resolve(null);
        }
      });
      proc.on("close", (code) => {
        if (!done) {
          done = true; clearTimeout(timeoutHandle);
          const tail = _cfErrBuf.split('\n').map((l) => l.trim()).filter(Boolean)
            .filter((l) => !/trycloudflare\.com/.test(l)).slice(-6);
          console.log("  \x1b[33m!\x1b[0m cloudflared exited before printing a URL (code " + code + ")");
          // Redact share subdomains AND bare IPs (cloudflared logs its own
          // source addresses) — logs stay local, but never print them anyway.
          for (const line of tail) console.log("  \x1b[33m!\x1b[0m [cloudflared] " + line.replace(/^[0-9TZ:\-\.]+Z?\s+INF\s+/, '').replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '[ip]').slice(0, 300));
          resolve(null);
        }
      });
      const timeoutHandle = setTimeout(() => {
        if (!done) { done = true; try { proc.kill('SIGKILL'); } catch (_) {} resolve(null); console.log("  \x1b[33m!\x1b[0m cloudflared printed no URL in 45s."); }
      }, 45000);
    });
  });
}

function startTunnelVps(port, vpsHost) {
  return new Promise((resolve) => {
    if (!vpsHost || vpsHost.trim() === '') {
      console.log("  \x1b[31m~\x1b[0m VPS Host missing.");
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
        ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

        const customEnvUrl = readEnv('CUSTOM_URL');
        let url = (customEnvUrl && customEnvUrl.trim() !== '')
          ? customEnvUrl.trim().replace(/\/$/, "")
          : `http://${vpsHost.split('@').pop().trim()}:${port}`;
        url += '/?v3';

        let done = false;
        // A "forward success" line is not a working tunnel (the VPS sshd may
        // bind loopback-only without GatewayPorts, or filter the port) —
        // verify end-to-end like every other provider. Plus a stall timeout:
        // previously a failed forward never resolved at all (API hang).
        const timeoutHandle = setTimeout(() => {
          if (!done) {
            done = true;
            try { proc.kill('SIGKILL'); } catch (_) {}
            console.log("  \x1b[33m!\x1b[0m VPS tunnel stalled (no forward confirmation in 30s).");
            resolve(null);
          }
        }, 30000);
        proc.stderr.on("data", data => {
          const out = data.toString();
          if ((out.includes("remote forward success") || out.includes("Forwarding address")) && !done) {
            console.log("  \x1b[33m~\x1b[0m Forward confirmed — verifying it serves our API...");
            verifyTunnelUrl(url, { tries: 3 }).then((ok) => {
              if (done) return; // stall timeout won
              done = true;
              clearTimeout(timeoutHandle);
              if (ok) {
                console.log("  \x1b[32m✓\x1b[0m VPS Tunnel URL: \x1b[1m" + url + "\x1b[0m");
                console.log("  \x1b[32m✓\x1b[0m Tunnel verified end-to-end.");
                resolve({ url, proc });
              } else {
                try { proc.kill('SIGKILL'); } catch (_) {}
                console.log("  \x1b[31m!\x1b[0m Forward is up but the VPS does not serve our API — check GatewayPorts/client-specified bind on the VPS sshd and cloud firewall rules.");
                resolve(null);
              }
            });
          }
        });
        proc.on("error", () => { if (!done) { done = true; clearTimeout(timeoutHandle); resolve(null); } });
        proc.on("close", () => { if (!done) { done = true; clearTimeout(timeoutHandle); resolve(null); } });
      });
    });
  });
}

function startTunnelPlayit(port) {
  return new Promise(resolve => {
    findBinaryPath('playit').then(playitPath => {
      if (!playitPath) { resolve({ error: 'NOT_FOUND', provider: 'playit' }); return; }
      ensureExecutable(playitPath);

      console.log("  \x1b[33m~\x1b[0m Starting playit tunnel...");
      const proc = spawn(playitPath, [], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
        "-o", "ServerAliveInterval=30",
        "-R", "80:localhost:" + port,
        "nokey@localhost.run"
      ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let done = false;
      const check = data => {
        const m = data.toString().match(/https:\/\/[a-z0-9\-]+\.(?:lhr\.life|localhost\.run)/);
        if (m && !done) { done = true; process.env.USING_TUNNEL = "true"; resolve({ url: m[0], proc }); console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + m[0] + "\x1b[0m"); }
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
        "-o", "ServerAliveInterval=30",
        "-R", "80:localhost:" + port,
        "serveo.net"
      ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let done = false;
      const check = data => {
        const m = data.toString().match(/https:\/\/[a-z0-9\-]+\.(serveo\.net|serveousercontent\.com)/);
        if (m && !done) { done = true; process.env.USING_TUNNEL = "true"; resolve({ url: m[0], proc }); console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + m[0] + "\x1b[0m"); }
      };
      proc.stdout.on("data", check); proc.stderr.on("data", check);
      proc.on("close", c => { if (!done) { resolve(null); console.log("  \x1b[33m!\x1b[0m serveo closed (code " + c + ")"); } });
      setTimeout(() => { if (!done) { done = true; proc.kill(); resolve(null); console.log("  \x1b[33m!\x1b[0m serveo timeout — port 22 may be blocked"); } }, 25000);
    }).catch(() => resolve(null));
  });
}

function startTunnelZrok(port, retries = 3, token = '') {
  return new Promise(async (resolve) => {
    // Reuse a still-alive zrok share instead of releasing it and being handed
    // a brand-new random token (zrok re-tokens every fresh public share).
    if (currentTunnelProc && currentTunnelProvider === 'zrok' && currentTunnelUrl) {
      const alive = currentTunnelProc.exitCode === null &&
        !currentTunnelProc.killed &&
        (currentTunnelProc.signalCode === null || currentTunnelProc.signalCode === undefined);
      if (alive) {
        console.log(`  \x1b[33m~\x1b[0m Reusing live zrok share (address unchanged).`);
        return resolve({ url: currentTunnelUrl, proc: currentTunnelProc });
      }
    }
    const zrokPath = await findBinaryPath('zrok').then(p => p).catch(() => null)
      || await findBinaryPath('zrok2').then(p => p).catch(() => null)
      || (function () {
        const cfgBin = path.join(os.homedir(), '.config', 'Nearcade', 'bin');
        const candidates = [
          path.join(cfgBin, 'zrok2'), path.join(cfgBin, 'zrok'),
          path.join(cfgBin, 'zrok2.exe'), path.join(cfgBin, 'zrok.exe'),
          '/usr/bin/zrok2', '/usr/bin/zrok', '/usr/local/bin/zrok2', '/usr/local/bin/zrok',
          path.join(os.homedir(), 'bin/zrok2'), path.join(os.homedir(), 'bin/zrok'), './zrok',
          path.join(os.homedir(), 'zrok', 'zrok2.exe'),
          path.join(os.homedir(), 'zrok', 'zrok.exe'),
          path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'zrok', 'zrok2.exe'),
          path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'zrok', 'zrok.exe'),
          path.join(os.homedir(), 'AppData', 'Local', 'zrok', 'zrok2.exe'),
          'C:\\Program Files\\zrok\\zrok2.exe',
          'C:\\Program Files\\zrok\\zrok.exe',
        ];
        for (const c of candidates) if (fs.existsSync(c)) return c;
        return null;
      })();

    if (!zrokPath) { resolve({ error: 'NOT_FOUND', provider: 'zrok' }); return; }
    ensureExecutable(zrokPath);

    if (token && token.toLowerCase() !== 'skip') {
      console.log(`  \x1b[33m~\x1b[0m Enabling Zrok with provided token...`);
      const enableProc = spawn(zrokPath, ['enable', token], { stdio: 'ignore' });
      await new Promise(r => enableProc.on('close', r));
    }

    // Clear reservations from previous runs (tracked token list, 0600).
    // Tokens are never printed: they are capabilities.
    // ASYNC + parallel + capped: the old sequential spawnSync loop froze
    // Electron's main thread (in-process server) up to 8s PER TOKEN.
    try {
      const oldTokens = readShareTokens().slice(0, 5);
      if (oldTokens.length) {
        console.log(`  \x1b[33m~\x1b[0m Cleaning up ${oldTokens.length} previous zrok share(s)...`);
        const results = await Promise.all(oldTokens.map((t) => deleteZrokShareAsync(zrokPath, t)));
        oldTokens.forEach((t, i) => { if (results[i]) { try { forgetZrokToken(t); } catch (_) {} } });
      }
    } catch (e) {}

    // Reap orphans whose tokens we never learned (timeouts/retries/crashes):
    // idle shares pointing at our port that are not live get deleted.
    // Fire-and-forget: cleanup must NEVER block startup (it once stalled
    // the tunnel API behind CLI timeouts and froze the dashboard).
    reapStaleZrokShares(port).catch(() => {});

    console.log(`  \x1b[33m~\x1b[0m Starting zrok public share (${zrokPath})... (Retries left: ${retries})`);
    const args = ["share", "public", "http://localhost:" + port, "--backend-mode", "proxy", "--headless"];
    const proc = spawn(zrokPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let done = false;
    // A printed URL is NOT a working tunnel (the controller can refuse or
    // invalidate the share seconds later while the proc happily idles).
    // Verify end-to-end (public URL -> local server) before resolving.
    // Patient budget: slow controllers need 10-20s for a fresh share to
    // become dialable (CLI calls alone take 4-9s on bad days). 6 probes of
    // 2.5s ≈ ≤25s worst case — still bounded, never hangs startup. The old
    // 3-probe/10s budget murdered healthy shares on slow controllers, which
    // piled up orphans AND reported "not starting".
    const verifyShare = (url, token) => {
      let tries = 0;
      const probe = async () => {
        if (done) return;
        tries++;
        try {
          const ctl = new AbortController();
          const to = setTimeout(() => ctl.abort(), 2500);
          const r = await fetch(url + '/api/info', { signal: ctl.signal });
          clearTimeout(to);
          if (r && r.ok) {
            const j = await r.json().catch(() => null);
            if (j && j.version) {
              if (done) return;
              done = true;
              clearTimeout(timeoutHandle);
              process.env.USING_TUNNEL = "true";
              resolve({ url, proc });
              console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
              console.log("  \x1b[32m✓\x1b[0m Tunnel verified end-to-end.");
              return;
            }
          }
        } catch (_) {}
        if (!done && tries < 6) {
          setTimeout(probe, 1500);
        } else if (!done) {
          console.log("  \x1b[33m!\x1b[0m Tunnel share never became reachable — discarding proc and retrying (share stays tracked for the reaper)...");
          // NOTE: no synchronous delete here. deleteZrokShareSync shells out
          // to a slow controller and once froze the dashboard for 10s+ per
          // retry. The token was already rememberZrokToken()'d at creation,
          // so the background reaper (and the 4s shutdown sweep) clean it up.
          done = true;
          clearTimeout(timeoutHandle);
          try { proc.kill('SIGKILL'); } catch (_) {} // zrok ignores SIGTERM
          if (retries > 0) {
            setTimeout(() => resolve(startTunnelZrok(port, retries - 1)), 3000);
          } else {
            resolve(null);
          }
        }
      };
      probe();
    };
    let verifying = false;
    const check = data => {
      const out = data.toString();
      const m = out.match(/(https:\/\/)?(([a-z0-9\-]+)\.shares?\.zrok\.io)/i);
      if (m && !done && !verifying) {
        verifying = true;
        const url = m[1] ? m[0] : "https://" + m[2];
        const token = m[3];
        currentZrokShareToken = token;
        rememberZrokToken(token);
        // NOTE: intentionally not resolved yet — verifyShare resolves only
        // after the public URL actually answers.
        verifyShare(url, token);
      }
    };
    proc.stdout.on("data", check); proc.stderr.on("data", check);
    // Surface the CLI's own diagnostics: previously non-URL stderr was
    // silently dropped, so a share that died with a printed reason looked
    // identical to a silent hang ("failed or closed (code 1)" with nothing
    // else). Share subdomains are capabilities — redact before logging.
    let _zrokErrBuf = '';
    proc.stderr.on('data', (d) => {
      _zrokErrBuf = (_zrokErrBuf + d.toString()).slice(-3000);
    });
    proc.on("close", c => {
      if (!done) {
        done = true;
        clearTimeout(timeoutHandle);
        console.log("  \x1b[33m!\x1b[0m zrok share failed or closed (code " + c + ")");
        const tail = _zrokErrBuf.split('\n').map((l) => l.trim()).filter(Boolean)
          .map((l) => l.replace(/[a-z0-9-]+\.shares?\.zrok\.io/gi, '[share]')
            .replace(/https?:\/\/\[share\]/gi, '[url]')).slice(-6);
        for (const line of tail) console.log("  \x1b[33m!\x1b[0m [zrok] " + line.slice(0, 300));
        if (retries > 0) {
          console.log("  \x1b[33m~\x1b[0m Retrying Zrok tunnel in 3 seconds...");
          setTimeout(() => resolve(startTunnelZrok(port, retries - 1)), 3000);
        } else {
          resolve(null);
        }
      }
    });
    const timeoutHandle = setTimeout(() => {
      if (!done) {
        done = true;
        try { proc.kill('SIGKILL'); } catch (_) {} // zrok ignores SIGTERM
        if (retries > 0) {
          console.log("  \x1b[33m~\x1b[0m Zrok timeout. Retrying in 3 seconds...");
          setTimeout(() => resolve(startTunnelZrok(port, retries - 1)), 3000);
        } else {
          resolve(null);
          console.log("  \x1b[33m!\x1b[0m zrok share timeout.");
        }
      }
    }, 30000);
  }).catch(() => null);
}

// ── Extra Provider Implementations ────────────────────────────────────────────

function startTunnelBore(port) {
  return new Promise(resolve => {
    findBinaryPath('bore').then(borePath => {
      if (!borePath) { resolve({ error: 'NOT_FOUND', provider: 'bore' }); return; }
      ensureExecutable(borePath);

      console.log("  \x1b[33m~\x1b[0m Starting bore tunnel...");
      const proc = spawn(borePath, ['local', String(port), '--to', 'bore.pub'], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let done = false;
      const check = data => {
        const str = data.toString();
        const url = str.match(/https?:\/\/[a-z0-9\-]+\.bore\.pub/);
        if (url && !done) { done = true; resolve({ url: url[0], proc }); console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url[0] + "\x1b[0m"); }
      };
      proc.stdout.on("data", check); proc.stderr.on("data", check);
      proc.on("close", () => { if (!done) resolve(null); });
      setTimeout(() => { if (!done) { done = true; resolve(null); console.log("  \x1b[33m!\x1b[0m bore timeout"); } }, 45000);
    }).catch(() => resolve(null));
  });
}

function startTunnelNgrok(port) {
  return new Promise(resolve => {
    findBinaryPath('ngrok').then(ngrokPath => {
      if (!ngrokPath) { resolve({ error: 'NOT_FOUND', provider: 'ngrok' }); return; }
      ensureExecutable(ngrokPath);

      const authtoken = process.env.NGROK_AUTHTOKEN || readEnv('NGROK_AUTHTOKEN');
      if (authtoken) {
        spawn(ngrokPath, ['authtoken', authtoken], { stdio: 'ignore' });
      }

      console.log("  \x1b[33m~\x1b[0m Starting ngrok tunnel...");
      const proc = spawn(ngrokPath, ['http', String(port), '--log', 'stdout'], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let done = false;
      const check = data => {
        const str = data.toString();
        const url = str.match(/https?:\/\/[a-z0-9\-]+\.ngrok(-free)?\.app/);
        if (url && !done) { done = true; resolve({ url: url[0], proc }); console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url[0] + "\x1b[0m"); }
      };
      proc.stdout.on("data", check); proc.stderr.on("data", check);
      proc.on("close", () => { if (!done) resolve(null); });
      setTimeout(() => { if (!done) { done = true; resolve(null); console.log("  \x1b[33m!\x1b[0m ngrok timeout"); } }, 60000);
    }).catch(() => resolve(null));
  });
}

function startTunnelFrp(port) {
  return new Promise(resolve => {
    findBinaryPath('frpc').then(frpcPath => {
      if (!frpcPath) { findBinaryPath('frp').then(p => { if (p) frpcPath = p; else { resolve({ error: 'NOT_FOUND', provider: 'frp' }); return; } }); }
      if (!frpcPath) return;

      const frpsAddr = process.env.FRPS_ADDR || readEnv('FRPS_ADDR');
      const frpsPort = process.env.FRPS_PORT || readEnv('FRPS_PORT') || '7000';
      const token = process.env.FRP_TOKEN || readEnv('FRP_TOKEN');
      if (!frpsAddr) { console.log("  \x1b[31m✗\x1b[0m FRPS_ADDR not configured"); resolve({ error: 'NO_CONFIG', provider: 'frp' }); return; }

      console.log("  \x1b[33m~\x1b[0m Starting frp tunnel...");
      const args = ['-c', '-', '-n', 'nearcade'];
      const config = `[common]\nserver_addr = ${frpsAddr}\nserver_port = ${frpsPort}\n${token ? `token = ${token}\n` : ''}[nearcade]\ntype = http\nlocal_ip = 127.0.0.1\nlocal_port = ${port}\n`;
      const proc = spawn(frpcPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      proc.stdin.write(config); proc.stdin.end();

      let done = false;
      const check = data => {
        const str = data.toString();
        if ((str.includes('start proxy success') || str.includes('login to server success')) && !done) {
          done = true;
          const url = `http://${frpsAddr}:${frpsPort}/?v3`;
          resolve({ url, proc });
          console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
        }
      };
      proc.stdout.on("data", check); proc.stderr.on("data", check);
      proc.on("close", () => { if (!done) resolve(null); });
      setTimeout(() => { if (!done) { done = true; resolve(null); console.log("  \x1b[33m!\x1b[0m frp timeout"); } }, 45000);
    }).catch(() => resolve(null));
  });
}

function startTunnelTailscaleFunnel(port) {
  return new Promise(resolve => {
    findBinaryPath('tailscale').then(tailscalePath => {
      if (!tailscalePath) { resolve({ error: 'NOT_FOUND', provider: 'tailscale-funnel' }); return; }
      ensureExecutable(tailscalePath);

      console.log("  \x1b[33m~\x1b[0m Starting Tailscale Funnel...");

      // First check if tailscale is logged in and up
      const statusCheck = spawn(tailscalePath, ['status', '--json'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let statusData = '';
      statusCheck.stdout.on('data', d => statusData += d);
      statusCheck.on('close', () => {
        let statusOk = true;
        try {
          const j = JSON.parse(statusData);
          if (!j.Self || j.Self.Online === false) statusOk = false;
          const hasFunnel = j.Self && (j.Self.CapMap && j.Self.CapMap.NodeFunnelAvailable) === true === true;
          if (!hasFunnel) console.log("  \x1b[33m!\x1b[0m Tailscale Funnel may not be available on your plan");
        } catch (e) {}

        if (!statusOk) {
          console.log("  \x1b[31m✗\x1b[0m Tailscale is not connected or authenticated");
          resolve({ error: 'TAILSCALE_NOT_CONNECTED', provider: 'tailscale-funnel' });
          return;
        }

        // Run funnel with --bg=false so the process stays in foreground
        const proc = spawn(tailscalePath, ['funnel', '--bg=false', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let done = false;
        let output = '';
        let verifying = false;

        // A printed URL is not a working tunnel — verify before reporting.
        const finishFunnel = (url) => {
          verifyTunnelUrl(url, { tries: 3 }).then((ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (ok) {
              resolve({ url, proc });
              console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
              console.log("  \x1b[32m✓\x1b[0m Tunnel verified end-to-end.");
            } else {
              try { proc.kill('SIGKILL'); } catch (_) {}
              resolve({ error: 'VERIFY_FAILED', provider: 'tailscale-funnel', details: 'URL printed but serves no API' });
              console.log("  \x1b[31m!\x1b[0m Funnel URL printed but unreachable — not reporting it.");
            }
          });
        };

        const check = data => {
          output += data.toString();
          const str = output;
          // Match various tailscale URL formats
          const url = str.match(/https?:\/\/[a-z0-9][a-z0-9\-\.]*[a-z0-9]\.ts\.net(?::\d+)?/i)
            || str.match(/https?:\/\/[a-z0-9\-\.]+\.ts\.net(?::\d+)?/i);
          if (url && !done) {
            verifying = true;
            finishFunnel(url[0]);
            return;
          }
          // Check for error messages
          if (str.includes('Funnel is not available') || str.includes('not available')) {
            done = true;
            clearTimeout(timer);
            try { proc.kill('SIGKILL'); } catch (_) {}
            resolve({ error: 'FUNNEL_NOT_AVAILABLE', provider: 'tailscale-funnel', details: str });
            console.log("  \x1b[31m✗\x1b[0m " + str.trim());
            return;
          }
        };

        proc.stdout.on("data", check);
        proc.stderr.on("data", check);

        proc.on("close", code => {
          if (!done) {
            // Dead proc = dead tunnel (--bg=false ties the funnel to process
            // lifetime). Never report a URL for a dead backend.
            done = true;
            clearTimeout(timer);
            resolve({ error: 'EXIT_CODE_' + code, provider: 'tailscale-funnel', details: output });
            console.log("  \x1b[31m!\x1b[0m tailscale funnel closed (code " + code + "): " + output.trim());
          }
        });

        const timeout = 120000;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            proc.kill();
            resolve({ error: 'TIMEOUT', provider: 'tailscale-funnel', details: output });
            console.log("  \x1b[33m!\x1b[0m tailscale funnel timeout (120s)");
          }
        }, timeout);

        // Also try to get URL from serve status as fallback (only while no
        // URL has been seen yet — never race an in-flight verification).
        setTimeout(() => {
          if (!done && !verifying) {
            const serveCheck = spawn(tailscalePath, ['serve', 'status', '--json'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            let serveData = '';
            serveCheck.stdout.on('data', d => serveData += d);
            serveCheck.on('close', () => {
              if (!done && !verifying) {
                try {
                  const j = JSON.parse(serveData);
                  const funnelUrl = j?.Funnel?.find?.(f => f?.URL)?.URL || j?.Serve?.find?.(f => f?.URL)?.URL;
                  if (funnelUrl) {
                    verifying = true;
                    console.log("  \x1b[33m~\x1b[0m Tunnel URL (from status), verifying...");
                    finishFunnel(funnelUrl);
                  }
                } catch (e) {}
              }
            });
          }
        }, 8000);
      });
    }).catch(() => resolve(null));
  });
}

function startTunnelTailscaleServe(port) {
  return new Promise(resolve => {
    const ip = getTailscaleIP();
    if (ip) {
      const url = `http://${ip}:${port}/?v3`;
      console.log("  \x1b[32m✓\x1b[0m Tailscale Serve URL: \x1b[1m" + url + "\x1b[0m");

      // Best-effort: also configure serve for a friendly hostname in the background
      findBinaryPath('tailscale').then(tpath => {
        if (!tpath) return;
        spawn(tpath, ['serve', 'http://127.0.0.1:' + port], { stdio: 'ignore' });
      }).catch(() => {});

      resolve({ url, proc: null });
      return;
    }

    // No tailscale IP — try to diagnose and start daemon
    findBinaryPath('tailscale').then(tpath => {
      if (!tpath) { resolve({ error: 'NOT_FOUND', provider: 'tailscale-serve' }); return; }
      console.log("  \x1b[33m~\x1b[0m Checking Tailscale status...");
      const check = spawn(tpath, ['status', '--json'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      check.stdout.on('data', d => out += d);
      check.stderr.on('data', d => out += d);
      let done = false;
      check.on('error', () => { if (!done) { done = true; resolve({ error: 'SPAWN_ERR', provider: 'tailscale-serve' }); } });
      check.on('close', () => {
        if (done) return;
        done = true;
        const ip2 = getTailscaleIP();
        if (ip2) {
          resolve({ url: `http://${ip2}:${port}/?v3`, proc: null });
          return;
        }
        if (/not running|daemon|not connected/i.test(out)) {
          // Try pkexec to start daemon with GUI auth dialog
          console.log("  \x1b[33m~\x1b[0m tailscaled not running, attempting auto-start...");
          const pe = spawn('pkexec', ['systemctl', 'start', 'tailscaled'], { stdio: 'ignore', detached: true });
          let peDone = false;
          setTimeout(() => { if (!peDone) { peDone = true; pe.kill(); } }, 30000);
          pe.on('error', () => { if (!peDone) { peDone = true; resolve({ error: 'DAEMON_DOWN', provider: 'tailscale-serve', details: 'Run: sudo systemctl enable --now tailscaled' }); } });
          pe.on('close', code => {
            if (peDone) return;
            peDone = true;
            if (code !== 0) {
              resolve({ error: 'DAEMON_DOWN', provider: 'tailscale-serve', details: 'Run: sudo systemctl enable --now tailscaled' });
              return;
            }
            console.log("  \x1b[32m✓\x1b[0m tailscaled started");
            // Wait for daemon to initialize, then re-check IP
            setTimeout(() => {
              const ip3 = getTailscaleIP();
              if (ip3) {
                resolve({ url: `http://${ip3}:${port}/?v3`, proc: null });
              } else {
                resolve({ error: 'NOT_CONNECTED', provider: 'tailscale-serve', details: 'Daemon started but not authenticated. Run: sudo tailscale up' });
              }
            }, 4000);
          });
        } else {
          resolve({ error: 'NOT_CONNECTED', provider: 'tailscale-serve', details: 'Run: tailscale up' });
        }
      });
    }).catch(() => resolve(null));
  });
}

function startTunnelTailscaleMesh(port) {
  return new Promise(async resolve => {
    const ip = getTailscaleIP();
    if (!ip) { resolve({ error: 'NO_TAILSCALE_IP', provider: 'tailscale-mesh' }); return; }
    const url = `http://${ip}:${port}/?v3`;
    console.log("  \x1b[32m✓\x1b[0m Tailscale Mesh URL: \x1b[1m" + url + "\x1b[0m");
    resolve({ url, proc: null });
  });
}

function startTunnelZeroTier(port) {
  return new Promise(resolve => {
    findBinaryPath('zerotier-cli').then(ztPath => {
      if (!ztPath) { resolve({ error: 'NOT_FOUND', provider: 'zerotier' }); return; }

      const networkId = process.env.ZEROTIER_NETWORK_ID || readEnv('ZEROTIER_NETWORK_ID');
      if (!networkId) { console.log("  \x1b[31m✗\x1b[0m ZEROTIER_NETWORK_ID not configured"); resolve({ error: 'NO_CONFIG', provider: 'zerotier' }); return; }

      console.log("  \x1b[33m~\x1b[0m Joining ZeroTier network...");
      const join = spawn(ztPath, ['join', networkId], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      join.on('close', () => {
        const ztIp = getZeroTierIP(networkId);
        if (ztIp) {
          const url = `http://${ztIp}:${port}/?v3`;
          console.log("  \x1b[32m✓\x1b[0m ZeroTier URL: \x1b[1m" + url + "\x1b[0m");
          resolve({ url, proc: null });
        } else {
          resolve({ error: 'NO_ZT_IP', provider: 'zerotier' });
        }
      });
    }).catch(() => resolve(null));
  });
}

function getZeroTierIP(networkId) {
  try {
    const { execSync } = require('child_process');
    // Bounded: an unresponsive zerotier daemon must never freeze the whole
    // server event loop (this runs on the join path).
    const out = execSync('zerotier-cli listnetworks', { encoding: 'utf8', timeout: 4000 });
    const lines = out.trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts[0] === networkId && parts[4] && parts[4] !== '-') {
        return parts[4].split('/')[0];
      }
    }
  } catch (e) {}
  return null;
}

function startTunnelNetmaker(port) {
  return new Promise(resolve => {
    const apiUrl = process.env.NETMAKER_API_URL || readEnv('NETMAKER_API_URL');
    const token = process.env.NETMAKER_TOKEN || readEnv('NETMAKER_TOKEN');
    if (!apiUrl || !token) { console.log("  \x1b[31m✗\x1b[0m NETMAKER_API_URL and NETMAKER_TOKEN required"); resolve({ error: 'NO_CONFIG', provider: 'netmaker' }); return; }
    console.log("  \x1b[33m~\x1b[0m Netmaker requires manual WireGuard config. Set up peer in Netmaker UI and connect locally.");
    resolve({ error: 'MANUAL_SETUP', provider: 'netmaker', url: 'manual' });
  });
}

function startTunnelWireguardDirect(port) {
  return new Promise(resolve => {
    findBinaryPath('wg-quick').then(wgPath => {
      if (!wgPath) { findBinaryPath('wg').then(p => { if (p) wgPath = p; }); }
      if (!wgPath) { resolve({ error: 'NOT_FOUND', provider: 'wireguard-direct' }); return; }

      const configPath = process.env.WIREGUARD_CONFIG || readEnv('WIREGUARD_CONFIG') || '/etc/wireguard/wg0.conf';
      console.log("  \x1b[33m~\x1b[0m Starting WireGuard interface...");
      const proc = spawn(wgPath, ['up', configPath.replace('.conf', '')], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      proc.on('close', code => {
        if (code === 0) {
          const vpsIp = process.env.WIREGUARD_VPS_IP || readEnv('WIREGUARD_VPS_IP');
          const url = vpsIp ? `http://${vpsIp}:${port}/?v3` : 'manual';
          console.log("  \x1b[32m✓\x1b[0m WireGuard up. Connect viewers to: \x1b[1m" + url + "\x1b[0m");
          resolve({ url, proc: null });
        } else {
          resolve({ error: 'START_FAILED', provider: 'wireguard-direct' });
        }
      });
    }).catch(() => resolve(null));
  });
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

async function startTunnel(port, provider, options = {}) {
  if (!provider) provider = getLastProvider();

  // If the SAME provider's tunnel is still alive, reuse it rather than killing
  // the live share and being assigned a brand-new random URL (zrok re-tokens on
  // every new share). This keeps viewers connecting to a stable address.
  if (currentTunnelProc && currentTunnelProvider === provider && currentTunnelUrl) {
    const alive = currentTunnelProc.exitCode === null &&
      !currentTunnelProc.killed &&
      (currentTunnelProc.signalCode === null || currentTunnelProc.signalCode === undefined);
    if (alive) {
      console.log(`  \x1b[33m~\x1b[0m Reusing already-running ${provider} tunnel (address unchanged).`);
      return { url: currentTunnelUrl, proc: currentTunnelProc };
    }
  }

  stopCurrentTunnel();
  currentTunnelProvider = provider; // provisionally claim, set a live URL below
  if (provider) {
    const fn = {
      zrok: (p) => startTunnelZrok(p, 3, options.zrokToken),
      cloudflared: startTunnelCloudflared,
      playit: startTunnelPlayit,
      localhostrun: startTunnelLocalhostRun,
      serveo: startTunnelServeo,
      vps: (p) => startTunnelVps(p, process.env.VPS_HOST || ''),
      bore: startTunnelBore,
      ngrok: startTunnelNgrok,
      frp: startTunnelFrp,
      'tailscale-funnel': startTunnelTailscaleFunnel,
      'tailscale-serve': startTunnelTailscaleServe,
      'tailscale-mesh': startTunnelTailscaleMesh,
      zerotier: startTunnelZeroTier,
      netmaker: startTunnelNetmaker,
      'wireguard-direct': startTunnelWireguardDirect,
    }[provider] || startTunnelAuto;
    if (fn) { const r = await fn(port); if (r && r.url) { saveLastProvider(provider); currentTunnelProc = r.proc; currentTunnelUrl = r.url; currentTunnelProvider = provider; } return r; }
    return null;
  }
  const r = await startTunnelAuto(port);
  if (r && r.url) { currentTunnelProc = r.proc; currentTunnelUrl = r.url; currentTunnelProvider = r.provider || null; }
  return r;
}

async function startTunnelAuto(port) {
  const forced = (process.env.TUNNEL || "").toLowerCase();
  if (forced === "zrok") return startTunnelZrok(port);
  if (forced === "vps") return startTunnelVps(port, process.env.VPS_HOST);
  if (forced === "cloudflared") return startTunnelCloudflared(port);
  if (forced === "playit") return startTunnelPlayit(port);
  if (forced === "localhostrun") return startTunnelLocalhostRun(port);
  if (forced === "serveo") return startTunnelServeo(port);

  const last = getLastProvider();
  if (last && last !== forced) {
    const fn = { zrok: startTunnelZrok, cloudflared: startTunnelCloudflared, playit: startTunnelPlayit, localhostrun: startTunnelLocalhostRun, serveo: startTunnelServeo, bore: startTunnelBore, ngrok: startTunnelNgrok, frp: startTunnelFrp, 'tailscale-funnel': startTunnelTailscaleFunnel, 'tailscale-serve': startTunnelTailscaleServe, 'tailscale-mesh': startTunnelTailscaleMesh, zerotier: startTunnelZeroTier, netmaker: startTunnelNetmaker, 'wireguard-direct': startTunnelWireguardDirect }[last];
    if (fn) { const r = await fn(port); if (r && r.url) return r; }
  }

  const z = await startTunnelZrok(port);
  if (z && z.url) { saveLastProvider('zrok'); return z; }
  const cf = await startTunnelCloudflared(port);
  if (cf && cf.url) { saveLastProvider('cloudflared'); return cf; }
  const pl = await startTunnelPlayit(port);
  if (pl && pl.url) { saveLastProvider('playit'); return pl; }
  const lr = await startTunnelLocalhostRun(port);
  if (lr && lr.url) { saveLastProvider('localhostrun'); return lr; }
  const sv = await startTunnelServeo(port);
  if (sv && sv.url) { saveLastProvider('serveo'); return sv; }
  console.log("  \x1b[31m!\x1b[0m All tunnels failed.");
  return null;
}

// ── Provider definitions ─────────────────────────────────────────────────────

const PROVIDERS = [
  // ── Primary (reverse tunnels with full implementation) ──
  {
    id: 'zrok', name: 'zrok', type: 'reverse', category: 'primary', integrated: true,
    pricing: 'free', difficulty: 'easy',
    description: 'Open-source reverse tunnel. Headless mode, auto-retry, best performance.',
    tags: ['binary', 'open-source'],
    binaryNames: ['zrok', 'zrok2'],
    start: (port) => startTunnelZrok(port),
    detect: async () => {
      const p = await findBinaryPath('zrok') || await findBinaryPath('zrok2');
      let authenticated = false;
      if (p) {
        try {
          // Async interrogation only: execSync here would freeze the entire
          // server (and the Electron UI sharing its event loop) for up to
          // the timeout on every providers-endpoint hit.
          const { execFile } = require('child_process');
          const statusOut = await new Promise((resolve) => {
            execFile(p, ['status'], { timeout: 5000 }, (err, stdout) => {
              resolve(err ? '' : String(stdout || ''));
            });
          });
          // zrok classic (v0.x) prints "Environment:" + "Contact:" rows only
          // when enabled. zrok2 (v2) prints a local "Environment" table with an
          // "Account Token" row only when enabled. Check both so whichever
          // binary is installed reports authentication correctly.
          if (statusOut.includes('Account Token') ||
              (statusOut.includes('Environment') && statusOut.includes('Contact')) ||
              statusOut.includes('enabled') ||
              statusOut.includes('Authenticated')) {
            authenticated = true;
          }
        } catch (e) {
          // If status check fails, binary exists but we can't determine auth state
          // Assume it might be authenticated to avoid unnecessary token prompts
          authenticated = true; // Be lenient - user can skip if needed
        }
      }
      return { found: !!p, path: p, authenticated };
    },
  },
  {
    id: 'cloudflared', name: 'cloudflared', type: 'reverse', category: 'primary', integrated: true,
    pricing: 'free', difficulty: 'easy',
    description: 'Cloudflare Tunnel. Free random URL via trycloudflare, custom domain via CF_TOKEN.',
    tags: ['binary', 'cloudflare'],
    binaryNames: ['cloudflared'],
    start: (port) => startTunnelCloudflared(port),
    detect: async () => {
      const p = await findBinaryPath('cloudflared');
      return { found: !!p, path: p };
    },
  },
  {
    id: 'playit', name: 'playit.gg', type: 'reverse', category: 'primary', integrated: true,
    pricing: 'paid', difficulty: 'easy',
    description: 'Gaming-focused tunnel. Persistent subdomain on paid plan, ephemeral on free.',
    tags: ['binary', 'gaming'],
    binaryNames: ['playit'],
    start: (port) => startTunnelPlayit(port),
    detect: async () => {
      const p = await findBinaryPath('playit');
      return { found: !!p, path: p };
    },
  },
  {
    id: 'localhostrun', name: 'localhost.run', type: 'reverse', category: 'primary', integrated: true,
    pricing: 'free', difficulty: 'easy',
    description: 'SSH-based. Uses system ssh. Random URL. Requires outbound port 22.',
    tags: ['ssh'],
    binaryNames: ['ssh'],
    start: (port) => startTunnelLocalhostRun(port),
    detect: async () => {
      const p = await findBinaryPath('ssh');
      return { found: !!p, path: p };
    },
  },
  {
    id: 'serveo', name: 'serveo.net', type: 'reverse', category: 'primary', integrated: false,
    pricing: 'free', difficulty: 'easy',
    description: 'SSH-based like localhost.run. Custom subdomain on paid plan.',
    tags: ['ssh'],
    binaryNames: ['ssh'],
    start: (port) => startTunnelServeo(port),
    detect: async () => {
      const p = await findBinaryPath('ssh');
      return { found: !!p, path: p };
    },
  },
  {
    id: 'vps', name: 'Custom VPS (SSH)', type: 'reverse', category: 'primary', integrated: true,
    pricing: 'paid', difficulty: 'advanced',
    description: 'Reverse SSH tunnel to your own VPS. Requires VPS credentials.',
    tags: ['ssh', 'vps', 'self-hosted'],
    binaryNames: ['ssh'],
    start: (port) => startTunnelVps(port, process.env.VPS_HOST || ''),
    detect: async () => {
      const p = await findBinaryPath('ssh');
      return { found: !!p, path: p };
    },
  },

  // ── Extra reverse tunnels ──
  {
    id: 'bore', name: 'bore', type: 'reverse', category: 'extra',
    pricing: 'free', difficulty: 'manual',
    description: 'Minimal Rust tunnel. Run your own server or use public bore.pub.',
    tags: ['binary', 'rust', 'self-hosted'],
    binaryNames: ['bore'],
    start: (port) => startTunnelBore(port),
    detect: async () => {
      const p = await findBinaryPath('bore');
      return { found: !!p, path: p };
    },
  },
  {
    id: 'ngrok', name: 'ngrok', type: 'reverse', category: 'extra',
    pricing: 'paid', difficulty: 'easy',
    description: 'Popular tunnel. Heavy rate limiting on free plan. Requires account token.',
    tags: ['binary', 'popular'],
    binaryNames: ['ngrok'],
    start: (port) => startTunnelNgrok(port),
    detect: async () => {
      const p = await findBinaryPath('ngrok');
      return { found: !!p, path: p };
    },
  },
  {
    id: 'frp', name: 'frp', type: 'reverse', category: 'extra',
    pricing: 'free', difficulty: 'manual',
    description: 'Self-hosted reverse proxy. Run frps on a VPS, frpc locally.',
    tags: ['binary', 'go', 'self-hosted'],
    binaryNames: ['frpc', 'frp'],
    start: (port) => startTunnelFrp(port),
    detect: async () => {
      const p = await findBinaryPath('frpc') || await findBinaryPath('frp');
      return { found: !!p, path: p };
    },
  },
  {
    id: 'tailscale-funnel', name: 'Tailscale Funnel', type: 'reverse', category: 'extra',
    pricing: 'paid', difficulty: 'easy',
    description: 'Tailscale public reverse tunnel. Requires Tailscale Funnel feature (paid plan).',
    tags: ['binary', 'tailscale'],
    binaryNames: ['tailscale'],
    start: (port) => startTunnelTailscaleFunnel(port),
    detect: async () => {
      const p = await findBinaryPath('tailscale');
      return { found: !!p, path: p };
    },
  },
  {
    id: 'tailscale-serve', name: 'Tailscale Serve', type: 'reverse', category: 'extra',
    pricing: 'free', difficulty: 'easy',
    description: 'Expose to your tailnet via Tailscale Serve. Free, no account needed beyond Tailscale.',
    tags: ['binary', 'tailscale'],
    binaryNames: ['tailscale'],
    start: (port) => startTunnelTailscaleServe(port),
    detect: async () => {
      const p = await findBinaryPath('tailscale');
      return { found: !!p, path: p };
    },
  },

  // ── Mesh VPN ──
  {
    id: 'tailscale-mesh', name: 'Tailscale (Mesh)', type: 'mesh', category: 'extra',
    pricing: 'free', difficulty: 'easy',
    description: 'WireGuard-based mesh VPN. Both sides install. Connect via 100.x.x.x:port.',
    tags: ['binary', 'mesh', 'wireguard'],
    binaryNames: ['tailscale'],
    start: (port) => startTunnelTailscaleMesh(port),
    detect: async () => {
      const p = await findBinaryPath('tailscale');
      const ip = getTailscaleIP();
      return { found: !!ip, path: p, extra: { tailscaleIP: ip } };
    },
  },
  {
    id: 'zerotier', name: 'ZeroTier', type: 'mesh', category: 'extra',
    pricing: 'free', difficulty: 'setup',
    description: 'SD-WAN mesh. Viewers join same network ID. Direct P2P after handshake.',
    tags: ['binary', 'mesh'],
    binaryNames: ['zerotier-cli', 'zerotier-one'],
    start: (port) => startTunnelZeroTier(port),
    detect: async () => {
      const p = await findBinaryPath('zerotier-cli').catch(() => null);
      return { found: !!p, path: p };
    },
  },
  {
    id: 'netmaker', name: 'Netmaker', type: 'mesh', category: 'extra',
    pricing: 'free', difficulty: 'manual',
    description: 'Self-hosted WireGuard mesh. Requires a VPS as controller.',
    tags: ['mesh', 'wireguard', 'self-hosted'],
    requiresBinary: false,
    binaryNames: [],
    start: (port) => startTunnelNetmaker(port),
    detect: async () => ({ found: false }),
  },

  // ── Other ──
  {
    id: 'portforward', name: 'Port Forwarding', type: 'other', category: 'primary',
    pricing: 'free', difficulty: 'manual',
    description: 'Open port 3000 on your router. Direct connection, no tunnel binary.',
    tags: ['router'],
    requiresBinary: false,
    binaryNames: [],
    start: (port) => Promise.resolve({ error: 'MANUAL_SETUP', provider: 'portforward', url: 'manual' }),
    detect: async () => ({ found: false }),
  },
  {
    id: 'wireguard-direct', name: 'WireGuard Direct', type: 'other', category: 'extra',
    pricing: 'free', difficulty: 'manual',
    description: 'Raw WireGuard tunnel to a VPS. Viewers connect to VPS IP directly.',
    tags: ['wireguard', 'vps', 'self-hosted'],
    binaryNames: ['wg', 'wg-quick'],
    start: (port) => startTunnelWireguardDirect(port),
    detect: async () => {
      const p = await findBinaryPath('wg').catch(() => null);
      return { found: !!p, path: p };
    },
  },
];

module.exports = {
  PROVIDERS,
  findBinaryPath,
  getTailscaleIP,
  readEnv,
  ensureExecutable,
  startTunnel,
  saveLastProvider,
  getLastProvider,
  startTunnelZrok,
  startTunnelCloudflared,
  startTunnelPlayit,
  startTunnelLocalhostRun,
  startTunnelServeo,
  startTunnelVps,
  startTunnelBore,
  startTunnelNgrok,
  startTunnelFrp,
  startTunnelTailscaleFunnel,
  startTunnelTailscaleServe,
  startTunnelTailscaleMesh,
  startTunnelZeroTier,
  startTunnelNetmaker,
  startTunnelWireguardDirect,
  stopCurrentTunnel,
};
