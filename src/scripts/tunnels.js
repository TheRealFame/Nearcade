const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const which = require("which");

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
    path.join(os.homedir(), 'bin', 'zrok'),
    path.join(os.homedir(), 'bin', 'zrok2')
  ],
  zrok2: [
    path.join(os.homedir(), 'zrok', 'zrok2'),
    path.join(os.homedir(), 'bin', 'zrok2')
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

function ensureExecutable(binPath) {
  if (!binPath) return;
  const sysPaths = ['/usr/bin/', '/usr/local/bin/', '/bin/', '/sbin/', '/usr/sbin/'];
  if (sysPaths.some(p => binPath.startsWith(p))) return;
  try { fs.chmodSync(binPath, 0o755); } catch (e) { console.warn('[chmod]', binPath, e.message); }
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

function startTunnelCloudflared(port) {
  return new Promise(resolve => {
    findBinaryPath('cloudflared').then(cloudflaredPath => {
      if (!cloudflaredPath) { resolve({ error: 'NOT_FOUND', provider: 'cloudflared' }); return; }
      ensureExecutable(cloudflaredPath);

      const cfToken = readEnv('CF_TOKEN');
      if (cfToken) {
        console.log("  \x1b[33m~\x1b[0m Starting persistent Cloudflare tunnel (Token)...");
        const proc = spawn(cloudflaredPath, ["tunnel", "--no-autoupdate", "--url", "http://localhost:" + port], { stdio: ["ignore", "pipe", "pipe"] });
        const url = (readEnv('CUSTOM_URL') || "https://your-custom-domain.com").replace(/\/$/, "") + '/?v3';
        console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
        return resolve({ url, proc });
      }

      const cfName = readEnv('CF_TUNNEL_NAME');
      if (cfName) {
        console.log("  \x1b[33m~\x1b[0m Starting persistent Cloudflare tunnel (Locally Managed)...");
        const proc = spawn(cloudflaredPath, ["tunnel", "--no-autoupdate", "--protocol", "http2", "run", cfName], { stdio: ["ignore", "pipe", "pipe"] });
        const url = (readEnv('CUSTOM_URL') || "https://your-custom-domain.com").replace(/\/$/, "") + '/?v3';
        console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
        return resolve({ url, proc });
      }

      console.log("  \x1b[33m~\x1b[0m Starting cloudflared tunnel...");
      console.log("  \x1b[31m!\x1b[0m WARNING: Free Cloudflare tunnels (trycloudflare.com) are currently heavily restricted.");
      console.log("  \x1b[31m!\x1b[0m If this happens, please use Zrok instead.");

      const proc = spawn(cloudflaredPath, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", "http://127.0.0.1:" + port], { stdio: ["ignore", "pipe", "pipe"] });
      let done = false;
      const check = data => {
        const m = data.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m && !done) {
          done = true;
          const url = m[0] + '/?v3';
          console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
          resolve({ url, proc });
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
        ], { stdio: ["ignore", "pipe", "pipe"] });

        const customEnvUrl = readEnv('CUSTOM_URL');
        let url = (customEnvUrl && customEnvUrl.trim() !== '')
          ? customEnvUrl.trim().replace(/\/$/, "")
          : `http://${vpsHost.split('@').pop().trim()}:${port}`;
        url += '/?v3';

        let done = false;
        proc.stderr.on("data", data => {
          const out = data.toString();
          if ((out.includes("remote forward success") || out.includes("Forwarding address")) && !done) {
            done = true;
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
      if (!playitPath) { resolve({ error: 'NOT_FOUND', provider: 'playit' }); return; }
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
        if (m && !done) { done = true; resolve({ url: m[0], proc }); console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + m[0] + "\x1b[0m"); }
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
        const m = data.toString().match(/https:\/\/[a-z0-9\-]+\.(serveo\.net|serveousercontent\.com)/);
        if (m && !done) { done = true; resolve({ url: m[0], proc }); console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + m[0] + "\x1b[0m"); }
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
        const cfgBin = path.join(os.homedir(), '.config', 'Nearcade', 'bin');
        const candidates = [
          path.join(cfgBin, 'zrok2'), path.join(cfgBin, 'zrok'),
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
        resolve({ url, proc });
        console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url + "\x1b[0m");
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

// ── Extra Provider Implementations ────────────────────────────────────────────

function startTunnelBore(port) {
  return new Promise(resolve => {
    findBinaryPath('bore').then(borePath => {
      if (!borePath) { resolve({ error: 'NOT_FOUND', provider: 'bore' }); return; }
      ensureExecutable(borePath);

      console.log("  \x1b[33m~\x1b[0m Starting bore tunnel...");
      const proc = spawn(borePath, ['local', String(port), '--to', 'bore.pub'], { stdio: ["ignore", "pipe", "pipe"] });
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
      const proc = spawn(ngrokPath, ['http', String(port), '--log', 'stdout'], { stdio: ["ignore", "pipe", "pipe"] });
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
      const proc = spawn(frpcPath, args, { stdio: ["pipe", "pipe", "pipe"] });
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
      const statusCheck = spawn(tailscalePath, ['status', '--json'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
        const proc = spawn(tailscalePath, ['funnel', '--bg=false', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let done = false;
        let output = '';

        const check = data => {
          output += data.toString();
          const str = output;
          // Match various tailscale URL formats
          const url = str.match(/https?:\/\/[a-z0-9][a-z0-9\-\.]*[a-z0-9]\.ts\.net(?::\d+)?/i)
            || str.match(/https?:\/\/[a-z0-9\-\.]+\.ts\.net(?::\d+)?/i);
          if (url && !done) {
            done = true;
            resolve({ url: url[0], proc });
            console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + url[0] + "\x1b[0m");
            return;
          }
          // Check for error messages
          if (str.includes('Funnel is not available') || str.includes('not available')) {
            done = true;
            resolve({ error: 'FUNNEL_NOT_AVAILABLE', provider: 'tailscale-funnel', details: str });
            console.log("  \x1b[31m✗\x1b[0m " + str.trim());
            return;
          }
        };

        proc.stdout.on("data", check);
        proc.stderr.on("data", check);

        proc.on("close", code => {
          if (!done) {
            if (output && !output.includes('error')) {
              // Process exited but we have some output - try to extract URL
              const m = output.match(/https?:\/\/[a-z0-9][a-z0-9\-\.]*[a-z0-9]\.ts\.net(?::\d+)?/i);
              if (m) { done = true; resolve({ url: m[0], proc: null }); console.log("  \x1b[32m✓\x1b[0m Tunnel URL: \x1b[1m" + m[0] + "\x1b[0m"); return; }
            }
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

        // Also try to get URL from serve status as fallback
        setTimeout(() => {
          if (!done) {
            const serveCheck = spawn(tailscalePath, ['serve', 'status', '--json'], { stdio: ['pipe', 'pipe', 'pipe'] });
            let serveData = '';
            serveCheck.stdout.on('data', d => serveData += d);
            serveCheck.on('close', () => {
              if (!done) {
                try {
                  const j = JSON.parse(serveData);
                  const funnelUrl = j?.Funnel?.find?.(f => f?.URL)?.URL || j?.Serve?.find?.(f => f?.URL)?.URL;
                  if (funnelUrl) {
                    done = true;
                    clearTimeout(timer);
                    resolve({ url: funnelUrl, proc });
                    console.log("  \x1b[32m✓\x1b[0m Tunnel URL (from status): \x1b[1m" + funnelUrl + "\x1b[0m");
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
      const check = spawn(tpath, ['status', '--json'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
      const join = spawn(ztPath, ['join', networkId], { stdio: ["ignore", "pipe", "pipe"] });
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
    const out = execSync('zerotier-cli listnetworks', { encoding: 'utf8' });
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
      const proc = spawn(wgPath, ['up', configPath.replace('.conf', '')], { stdio: ["ignore", "pipe", "pipe"] });
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

async function startTunnel(port, provider) {
  if (!provider) provider = getLastProvider();
  if (provider) {
    const fn = {
      zrok: startTunnelZrok,
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
    if (fn) { const r = await fn(port); if (r && r.url) saveLastProvider(provider); return r; }
    return null;
  }
  const r = await startTunnelAuto(port);
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

  const cf = await startTunnelCloudflared(port);
  if (cf && cf.url) { saveLastProvider('cloudflared'); return cf; }
  const z = await startTunnelZrok(port);
  if (z && z.url) { saveLastProvider('zrok'); return z; }
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
      return { found: !!p, path: p };
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
    id: 'serveo', name: 'serveo.net', type: 'reverse', category: 'primary', integrated: true,
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
};
