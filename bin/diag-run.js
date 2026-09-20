/**
 * bin/diag-run.js — Nearcade timed diagnostic run.
 *
 * Launches the real server (same as `npm start`) with diagnostics enabled,
 * captures everything for a fixed window, then shuts down cleanly.
 *
 * Usage: node bin/diag-run.js [seconds]   (default 300 = 5 minutes)
 *
 * What you get:
 *  - console: live server output with secrets redacted (share subdomains,
 *    tunnel URLs, IPv4 addresses are masked; nothing identifying leaves
 *    the box in a paste-safe form)
 *  - logs/diag-<timestamp>.log: the same redacted stream, saved for review
 *  - sys stats every 30 s, a closing summary, graceful SIGINT shutdown
 *    (which also runs tunnel cleanup)
 *
 * During the window, use the app normally (host page, stream, viewers).
 * Server-side extra logging is gated by NEARCADE_DIAG=1 (set here); normal
 * `npm start` runs stay quiet.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DURATION_S = Math.max(10, parseInt(process.argv[2], 10) || 300);
const ROOT = path.join(__dirname, '..');
const LOGDIR = path.join(ROOT, 'logs');
try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch (_) {}
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const LOGFILE = path.join(LOGDIR, `diag-${STAMP}.log`);

// ── Redaction (paste-safe logs; share URLs/tokens/IPs/secrets never leave
// the box in a form anyone else can use)
function redact(line) {
  return line
    // tunnel share subdomains (zrok + common providers), keep provider domain
    .replace(/https:\/\/[a-z0-9-]+(\.shares?\.zrok\.io)/gi, 'https://[share]$1')
    .replace(/https:\/\/[a-z0-9-]+(\.trycloudflare\.com)/gi, 'https://[host]$1')
    .replace(/https:\/\/[a-z0-9-]+(\.at\.playit\.gg|\.playit\.gg)/gi, 'https://[host]$1')
    .replace(/https:\/\/[a-z0-9-]+(\.(localhost\.run|lhr\.life|serveo\.net|serveousercontent\.com|bore\.pub|ngrok(-free)?\.app))/gi, 'https://[host]$2')
    .replace(/https:\/\/[a-z0-9-]+(\.ts\.net)/gi, 'https://[host]$1')
    // IPv4 addresses (viewer IPs, srflx, etc.)
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[ip]')
    // secrets in config dumps / env echoes (keys, PINs, passwords, tokens)
    .replace(/("(?:modSecret|vpsMasterKey|persistentPassword|password|passwd|pwd|lastPin|pin|token|apiKey|secret|credential|authToken)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/\b((?:TURN_SECRET|MOD_SECRET|CUSTOM_URL|VPS_HOST|NGROK_AUTHTOKEN|FRP_TOKEN|NETMAKER_TOKEN)\s*=\s*)(\S+)/gi, '$1[redacted]');
}

const logStream = fs.createWriteStream(LOGFILE, { flags: 'w' });
const t0 = Date.now();
const stamp = () => `[diag T+${Math.round((Date.now() - t0) / 1000)}s]`;
function emit(raw) {
  const line = redact(String(raw).replace(/\n$/, ''));
  process.stdout.write(line + '\n');
  logStream.write(line + '\n');
}

emit(`Nearcade diagnostic run: ${DURATION_S}s. Log: ${LOGFILE}`);
emit('Diagnostics enabled on server (NEARCADE_DIAG=1). Use the app normally.');

const env = Object.assign({}, process.env, { NEARCADE_DIAG: '1' });
const srv = spawn('node', ['src/scripts/server.js'], { env, cwd: ROOT });

srv.stdout.on('data', (d) => String(d).split('\n').forEach((l) => { if (l.trim()) emit(l); }));
srv.stderr.on('data', (d) => String(d).split('\n').forEach((l) => { if (l.trim() && !l.includes('ExperimentalWarning')) emit('[stderr] ' + l); }));
srv.on('error', (e) => emit(`[diag] server spawn failed: ${e.message}`));

function sysStats() {
  const load = os.loadavg().map((v) => v.toFixed(2)).join(' ');
  const memFree = Math.round(os.freemem() / 1048576);
  const memTot = Math.round(os.totalmem() / 1048576);
  emit(`[diag] sys load=${load} mem=${memFree}/${memTot}MB uptime=${Math.round((Date.now() - t0) / 1000)}s`);
}
const sysTimer = setInterval(sysStats, 30000);

let finished = false;
function finish(reason) {
  if (finished) return;
  finished = true;
  clearInterval(sysTimer);
  emit(`[diag] ${reason} — shutting down server (tunnels delete on cleanup)...`);
  try { srv.kill('SIGINT'); } catch (_) {}
  const force = setTimeout(() => { try { srv.kill('SIGKILL'); } catch (_) {} }, 10000);
  srv.on('close', (code) => {
    clearTimeout(force);
    emit(`[diag] server exited (code ${code}). Full log saved: ${LOGFILE}`);
    try { logStream.end(); } catch (_) {}
    process.exit(0);
  });
}

setTimeout(() => finish(`window complete (${DURATION_S}s)`), DURATION_S * 1000);
process.on('SIGINT', () => finish('interrupted by user'));
process.on('SIGTERM', () => finish('terminated'));
