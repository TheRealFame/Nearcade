/**
 * audio_worker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker thread for Nearsec virtual-audio lifecycle management.
 *
 * Owns:
 * • _pactlExec()          — shell helper
 * • cleanupStaleSinks()   — orphan-module sweep on boot
 * • initVirtualAudio()    — full sink / remap-source / loopback setup
 * • destroyVirtualAudio() — ordered teardown
 * • routeGameAudio()      — pactl + venmic stream routing
 *
 * IPC contract (parentPort messages):
 *
 * ← main thread sends:
 * { type: 'init'    }                           → run initVirtualAudio
 * { type: 'destroy' }                           → run destroyVirtualAudio
 * { type: 'route',   processName: string|null } → run routeGameAudio
 * { type: 'cleanup-stale' }                     → run cleanupStaleSinks only
 *
 * → worker posts back to main thread:
 * { type: 'ready',   hwSink: string }           → init completed, loopback sink name
 * { type: 'error',   message: string }          → non-fatal error
 * { type: 'log',     message: string }          → informational
 * { type: 'module-ids', ids: object }           → _vAudioModules snapshot for cleanup()
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');
const { exec }  = require('child_process');
const path      = require('path');
const fs        = require('fs');

// ── Paths inherited from main thread ─────────────────────────────────────────
const isPackaged = (workerData && workerData.isPackaged) || false;
const venmicPath = workerData && workerData.venmicPath;

// ── Venmic native addon (optional, PipeWire only) ────────────────────────────
let venmic = null;
let pb     = null;

if (venmicPath && fs.existsSync(venmicPath)) {
  try {
    venmic = require(venmicPath);
    pb     = new venmic.PatchBay();
    log('Native audio router (venmic) loaded in audio worker.');
  } catch (e) {
    err(`Failed to load venmic in worker: ${e.message}`);
  }
}

// ── Module-ID tracking ────────────────────────────────────────────────────────
const _vAudioModules = { sink: null, remap: null, loopback: null, daemonHandle: null };
let _systemOriginalSink = null; // Tracks the true system default to restore on exit

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg)  { parentPort.postMessage({ type: 'log',   message: `[audio_worker] ${msg}` }); }
function err(msg)  { parentPort.postMessage({ type: 'error', message: `[audio_worker] ${msg}` }); }

/**
 * Run a shell command, resolve with trimmed stdout.
 * Never rejects — returns '' on error.
 */
function _pactlExec(cmd) {
  return new Promise(resolve => {
    exec(cmd, (error, stdout) => {
      resolve(error ? '' : (stdout || '').trim());
    });
  });
}

// ── Stale-module cleanup ──────────────────────────────────────────────────────
async function cleanupStaleSinks() {
  if (process.platform !== 'linux') return;
  log('Scanning for stale Nearsec modules…');

  const list = await _pactlExec('pactl list short modules');
  if (!list) return;

  const staleIds = [];
  for (const line of list.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes('NearsecAppAudio') || trimmed.includes('NearsecAppMic') ||
      trimmed.includes('NearsecVirtual')  || trimmed.includes('NearsecVirtualCapture')) {
      const id = trimmed.split(/\s+/)[0];
    if (id && /^\d+$/.test(id)) staleIds.push(id);
      }
  }

  if (staleIds.length === 0) { log('No stale modules found.'); return; }

  log(`Found ${staleIds.length} stale module(s): [${staleIds.join(', ')}] — unloading…`);
  for (const id of staleIds) {
    await _pactlExec(`pactl unload-module ${id}`);
    log(`Unloaded stale module ${id}`);
  }
}

// ── Virtual audio initialisation ──────────────────────────────────────────────
async function initVirtualAudio() {
  if (process.platform !== 'linux') {
    parentPort.postMessage({ type: 'ready', hwSink: null });
    return;
  }

  log('Initialising Native Global Mirroring…');
  const _prevDefault = (await _pactlExec('pactl get-default-sink')).trim();

  // Cache the true system default so we can restore it safely on exit
  if (_prevDefault && !_prevDefault.includes('Nearsec')) {
    _systemOriginalSink = _prevDefault;
  }

  await cleanupStaleSinks();

  // 1. Virtual null-sink
  _vAudioModules.sink = await _pactlExec(
    'pactl load-module module-null-sink ' +
    'sink_name=NearsecVirtual ' +
    'sink_properties=device.description="NearsecVirtual"'
  );

  // 2. WebRTC monitor remap
  _vAudioModules.remap = await _pactlExec(
    'pactl load-module module-remap-source ' +
    'master=NearsecVirtual.monitor ' +
    'source_name=NearsecVirtualCapture ' +
    'source_properties=device.description="NearsecVirtualCapture"'
  );

  // 3. Resolve hardware sink (needed for blacklist daemon filtering)
  let hwSink = _prevDefault;
  if (!hwSink || hwSink.includes('Nearsec')) {
    const sinksRaw = await _pactlExec('pactl list short sinks');
    const fallback = (sinksRaw || '').split('\n').find(l => !l.includes('Nearsec') && l.trim() !== '');
    if (fallback) hwSink = fallback.trim().split(/\s+/)[1];
  }

  // 4. Loopback mirror → Dynamic System Default Alias
  // Using @DEFAULT_SINK@ lets the OS gracefully handle live device changes (like Bluetooth)
  // under the hood without breaking our virtual mirror link.
  _vAudioModules.loopback = await _pactlExec(
    'pactl load-module module-loopback source=NearsecVirtual.monitor sink=@DEFAULT_SINK@ latency_msec=30'
  );

  // 5. Lock system default to the virtual sink
  // await new Promise(r => setTimeout(r, 400));
  // await _pactlExec('pactl set-default-sink NearsecVirtual');

  // 6. Optionally start blacklist daemon (sidecar — require path forwarded from main)
  if (workerData && workerData.daemonPath && fs.existsSync(workerData.daemonPath)) {
    try {
      const blacklistDaemon = require(workerData.daemonPath);
      _vAudioModules.daemonHandle = blacklistDaemon.startDaemon(blacklistDaemon.DEFAULT_BLACKLIST, hwSink);
    } catch (e) {
      err(`Failed to start blacklist daemon: ${e.message}`);
    }
  }

  log(`Ready. Default locked to NearsecVirtual. Mirroring to active system sink.`);

  // Report ONLY the string IDs to main thread so cleanup() can unload them synchronously
  parentPort.postMessage({ type: 'module-ids', ids: {
    sink: _vAudioModules.sink,
    remap: _vAudioModules.remap,
    loopback: _vAudioModules.loopback
  }});
  parentPort.postMessage({ type: 'ready', hwSink: hwSink || null });
}

// ── Virtual audio teardown ────────────────────────────────────────────────────
async function destroyVirtualAudio() {
  if (process.platform !== 'linux') return;

  // Kill the JavaScript timer for the blacklist daemon
  if (_vAudioModules.daemonHandle) {
    clearInterval(_vAudioModules.daemonHandle);
    _vAudioModules.daemonHandle = null;
    log('Blacklist daemon stopped.');
  }

  // Hand control back to the original hardware device BEFORE killing the sink
  if (_systemOriginalSink) {
    log(`Restoring system default sink back to: ${_systemOriginalSink}`);
    await _pactlExec(`pactl set-default-sink ${_systemOriginalSink}`);
  } else {
    // Ultimate fallback sweep: find the first non-Nearsec hardware device available
    const sinksRaw = await _pactlExec('pactl list short sinks');
    const nativeSink = (sinksRaw || '').split('\n').find(l => !l.includes('Nearsec') && l.trim() !== '');
    if (nativeSink) {
      const nativeName = nativeSink.trim().split(/\s+/)[1];
      log(`Restoring system default sink back to fallback: ${nativeName}`);
      await _pactlExec(`pactl set-default-sink ${nativeName}`);
    }
  }

  // Move sink-inputs off Nearsec sink before we unload
  const sinks = await _pactlExec('pactl list short sinks');
  const nearsecLine = (sinks || '').split('\n').find(l => l.includes('NearsecAppAudio'));
  if (nearsecLine) {
    const nearsecId  = nearsecLine.trim().split(/\s+/)[0];
    const defaultSink = (await _pactlExec('pactl get-default-sink')).trim();
    if (nearsecId && defaultSink && defaultSink !== 'NearsecVirtual') {
      const inputs = await _pactlExec('pactl list short sink-inputs');
      for (const line of (inputs || '').split('\n').filter(Boolean)) {
        const parts   = line.trim().split(/\s+/);
        const inputId = parts[0];
        const sinkId  = parts[1];
        if (sinkId === nearsecId && /^\d+$/.test(inputId)) {
          await _pactlExec(`pactl move-sink-input ${inputId} ${defaultSink}`);
          log(`Restored sink-input ${inputId} → ${defaultSink}`);
        }
      }
    }
  }

  // Unload in reverse order
  for (const key of ['loopback', 'remap', 'sink']) {
    const id = _vAudioModules[key];
    if (!id) continue;
    await _pactlExec(`pactl unload-module ${id}`);
    log(`Unloaded ${key} module ${id}`);
    _vAudioModules[key] = null;
  }

  // Belt-and-braces sweep
  const list = await _pactlExec('pactl list short modules');
  if (list) {
    const leftover = [];
    for (const line of list.split('\n')) {
      if (line.includes('NearsecAppAudio') || line.includes('NearsecAppMic') ||
        line.includes('NearsecVirtual')  || line.includes('NearsecVirtualCapture')) {
        const id = line.trim().split(/\s+/)[0];
      if (id && /^\d+$/.test(id)) leftover.push(id);
        }
    }
    if (leftover.length > 0) {
      log(`Belt-and-braces: unloading ${leftover.length} residual module(s) [${leftover.join(', ')}]`);
      await Promise.all(leftover.map(id => _pactlExec(`pactl unload-module ${id}`)));
    }
  }

  parentPort.postMessage({ type: 'destroyed' });
  process.exit(0); // <--- ADD THIS EXACT LINE
}

// ── Game audio routing ────────────────────────────────────────────────────────
const AUDIO_BLACKLIST = [
  'WEBRTC VoiceEngine', 'teamspeak', 'ts3client', 'mumble', 'slack',
'Discord', 'telegram-desktop', 'discord_voice', 'vesktop',
'firefox', 'firefox-bin', 'firefox-esr',
'chromium', 'chromium-browser', 'google-chrome', 'chrome',
'brave', 'brave-browser', 'vivaldi', 'opera', 'epiphany',
'waterfox', 'librewolf', 'ungoogled-chromium',
];

let linkedStreams = new Set();

function routeGameAudio(gameProcessName) {
  _routeViaPatctl(gameProcessName);

  if (!pb) return;

  let devices;
  try { devices = pb.list(); } catch (e) { return; }

  const sinkNode = devices.find(d => {
    const cls  = (d['media.class'] || '').toLowerCase();
    const name = (d['node.name'] || d['audio.name'] || '').toLowerCase();
    const desc = (d['node.description'] || d['device.description'] || d['media.description'] || '').toLowerCase();
    return (cls.includes('sink') || cls.includes('audio/sink')) &&
    (name.includes('nearsec') || desc.includes('nearsec') || name.includes('nearsecappaudio'));
  });
  if (!sinkNode) return;

  const sinkId = sinkNode.id !== undefined ? sinkNode.id : sinkNode['object.id'];
  if (sinkId === undefined) return;

  const activeStreams = devices.filter(d => {
    const cls = (d['media.class'] || '').toLowerCase();
    return cls.includes('stream') || cls.includes('output/audio');
  });

  let streamsToRoute = [];
  if (gameProcessName && gameProcessName !== 'ALL_DESKTOP') {
    streamsToRoute = activeStreams.filter(d => {
      const bin = (d['application.process.binary'] || '').toLowerCase();
      return bin === gameProcessName.toLowerCase();
    });
  } else {
    streamsToRoute = activeStreams.filter(d => {
      const binary = (d['application.process.binary'] || d['application.name'] || d['node.name'] || '').toLowerCase();
      if (AUDIO_BLACKLIST.some(b => binary.includes(b))) return false;
      if (binary.includes('sd_dummy') || binary.includes('speech-dispatcher')) return false;
      if (binary.includes('nearsec')) return false;
      return true;
    });
  }

  streamsToRoute.forEach(node => {
    const outId = node.id !== undefined ? node.id : node['object.id'];
    if (outId !== undefined && !linkedStreams.has(outId)) {
      const name = node['application.process.binary'] || node['application.name'] || 'Unknown';
      log(`Routing ${name} (${outId}) → NearsecAppAudio via venmic`);
      try {
        pb.link(outId, sinkId);
        linkedStreams.add(outId);
      } catch (e) {
        err(`venmic link failed for ${name}: ${e.message}`);
      }
    }
  });
}

function _routeViaPatctl(gameProcessName) {
  if (process.platform !== 'linux') return;

  exec('pactl list short sink-inputs', (error, stdout) => {
    if (error || !stdout) return;

    const lines = stdout.trim().split('\n').filter(Boolean);
    lines.forEach(line => {
      const inputId = line.split(/\s+/)[0];
      if (!inputId || !/^\d+$/.test(inputId)) return;

      exec(`pactl list sink-inputs | grep -A 20 "Sink Input #${inputId}"`, (e2, props) => {
        if (e2 || !props) return;

        const appBinary = (props.match(/application\.process\.binary\s*=\s*"([^"]+)"/) || [])[1] || '';
        const appName   = (props.match(/application\.name\s*=\s*"([^"]+)"/) || [])[1] || '';
        const identifier = (appBinary || appName).toLowerCase();

        if (!identifier) return;
        if (AUDIO_BLACKLIST.some(b => identifier.includes(b.toLowerCase()))) return;
        if (identifier.includes('nearsec')) return;
        if (identifier.includes('speech-dispatcher') || identifier.includes('sd_dummy')) return;

        if (gameProcessName && gameProcessName !== 'ALL_DESKTOP') {
          if (!identifier.includes(gameProcessName.toLowerCase())) return;
        }

        const currentSinkMatch = props.match(/Sink:\s*(\d+)/);
        const currentSink = currentSinkMatch ? currentSinkMatch[1] : null;

        exec('pactl list short sinks', (e3, sinks) => {
          if (e3 || !sinks) return;
          const nearsecLine = sinks.split('\n').find(l => l.includes('NearsecVirtual'));
          if (!nearsecLine) return;
          const nearsecSinkId = nearsecLine.split(/\s+/)[0];
          if (!nearsecSinkId || currentSink === nearsecSinkId) return;

          exec(`pactl move-sink-input ${inputId} ${nearsecSinkId}`, e4 => {
            if (!e4) log(`pactl routed sink-input ${inputId} (${identifier}) → NearsecVirtual`);
          });
        });
      });
    });
  });
}

// ── Message dispatcher ────────────────────────────────────────────────────────
parentPort.on('message', async (msg) => {
  try {
    switch (msg.type) {
      case 'init':
        await initVirtualAudio();
        break;

      case 'destroy':
        await destroyVirtualAudio();
        break;

      case 'route':
        routeGameAudio(msg.processName || null);
        break;

      case 'cleanup-stale':
        await cleanupStaleSinks();
        break;

      default:
        err(`Unknown message type: ${msg.type}`);
    }
  } catch (e) {
    err(`Unhandled error processing '${msg.type}': ${e.message}`);
  }
});

// Signal readiness immediately so main knows the worker is alive
log('Worker thread started.');
