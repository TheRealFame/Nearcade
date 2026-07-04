/**
 * audio_worker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker thread for Nearsec virtual-audio lifecycle management.
 * NUCLEAR OPTION: Pure pactl move-and-loopback architecture.
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');
const { exec }  = require('child_process');
const fs        = require('fs');

// ── Module-ID tracking ────────────────────────────────────────────────────────
const _vAudioModules = { sink: null, remap: null, loopback: null, daemonHandle: null };

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg)  { parentPort.postMessage({ type: 'log',   message: `[audio_worker] ${msg}` }); }
function err(msg)  { parentPort.postMessage({ type: 'error', message: `[audio_worker] ${msg}` }); }

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

  if (staleIds.length > 0) {
    log(`Cleaning up ${staleIds.length} stale audio modules...`);
    for (const id of staleIds) await _pactlExec(`pactl unload-module ${id}`);
  }
}

// ── Virtual audio initialisation ──────────────────────────────────────────────
async function initVirtualAudio() {
  if (process.platform !== 'linux') {
    parentPort.postMessage({ type: 'ready', hwSink: null });
    return;
  }

  await cleanupStaleSinks();

  log('Initializing Legacy Virtual Cable & Loopback...');

  // 1. Create Virtual Sink
  _vAudioModules.sink = await _pactlExec(
    'pactl load-module module-null-sink sink_name=NearsecVirtual sink_properties=device.description="NearsecVirtual"'
  );

  // 2. Create WebRTC Monitor Remap
  _vAudioModules.remap = await _pactlExec(
    'pactl load-module module-remap-source master=NearsecVirtual.monitor source_name=NearsecVirtualCapture source_properties=device.description="NearsecVirtualCapture"'
  );

  // 3. THE GHOST MUTE FIX (Ensure OS doesn't auto-mute the new sink)
  await _pactlExec('pactl set-sink-mute NearsecVirtual 0');
  await _pactlExec('pactl set-sink-volume NearsecVirtual 100%');
  await _pactlExec('pactl set-source-mute NearsecVirtual.monitor 0');
  await _pactlExec('pactl set-source-volume NearsecVirtual.monitor 100%');
  await _pactlExec('pactl set-source-mute NearsecVirtualCapture 0');
  await _pactlExec('pactl set-source-volume NearsecVirtualCapture 100%');

  // 4. Resolve Hardware Sink (Your headphones/speakers)
  let hwSink = (await _pactlExec('pactl get-default-sink')).trim();
  if (!hwSink || hwSink.includes('Nearsec')) {
    const sinksRaw = await _pactlExec('pactl list short sinks');
    const fallback = (sinksRaw || '').split('\n').find(l => !l.includes('Nearsec') && l.trim() !== '');
    if (fallback) hwSink = fallback.trim().split(/\s+/)[1];
  }

  // 5. Establish the Loopback Mirror (Sends game audio from virtual cable BACK to your ears)
  if (hwSink) {
    _vAudioModules.loopback = await _pactlExec(
      `pactl load-module module-loopback source=NearsecVirtual.monitor sink=${hwSink} latency_msec=30`
    );
    startLoopbackWatcher();
    log(`Loopback mirror successfully attached to: ${hwSink}`);
  } else {
    err('Could not find hardware sink for loopback. You may not hear game audio.');
  }

  log(`Ready. Stream virtual cable active.`);
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

  stopRoutingDaemon();
  stopLoopbackWatcher();

  // Move the apps back to the hardware sink before destroying the virtual cable
  const defaultSink = (await _pactlExec('pactl get-default-sink')).trim();
  const sinks = await _pactlExec('pactl list short sinks');
  const nearsecLine = (sinks || '').split('\n').find(l => l.includes('NearsecVirtual') && !l.includes('NearsecVirtualCapture'));
  if (nearsecLine && defaultSink && defaultSink !== 'NearsecVirtual') {
    const nearsecId = nearsecLine.trim().split(/\s+/)[0];
    const inputs = await _pactlExec('pactl list short sink-inputs');
    for (const line of (inputs || '').split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      if (parts[1] === nearsecId && /^\d+$/.test(parts[0])) {
        await _pactlExec(`pactl move-sink-input ${parts[0]} ${defaultSink}`);
      }
    }
  }

  // ── THE SCREECH FIX ──
  await _pactlExec('pactl set-sink-mute NearsecVirtual 1');
  await new Promise(r => setTimeout(r, 60));

  for (const key of ['loopback', 'remap', 'sink']) {
    if (_vAudioModules[key]) {
      await _pactlExec(`pactl unload-module ${_vAudioModules[key]}`);
    }
  }

  await cleanupStaleSinks();
  parentPort.postMessage({ type: 'destroyed' });
  process.exit(0);
}

// ── Loopback Watcher (Handles swapping headphones to speakers mid-stream) ─────
let _loopbackWatchInterval = null;
let _lastLoopbackSink = null;

function startLoopbackWatcher() {
  if (_loopbackWatchInterval) return;
  _loopbackWatchInterval = setInterval(async () => {
    try {
      const current = (await _pactlExec('pactl get-default-sink')).trim();
      if (!current || current.includes('Nearsec') || current === _lastLoopbackSink) return;

      // Device changed! Move loopback silently.
      await _pactlExec('pactl set-sink-mute NearsecVirtual 1');
      await new Promise(r => setTimeout(r, 40));
      if (_vAudioModules.loopback) {
        await _pactlExec(`pactl unload-module ${_vAudioModules.loopback}`);
      }
      _vAudioModules.loopback = await _pactlExec(`pactl load-module module-loopback source=NearsecVirtual.monitor sink=${current} latency_msec=30`);
      await _pactlExec('pactl set-sink-mute NearsecVirtual 0');
      _lastLoopbackSink = current;
      log(`Loopback automatically moved to new default device: ${current}`);
    } catch (e) {}
  }, 3000);
}
function stopLoopbackWatcher() {
  if (_loopbackWatchInterval) clearInterval(_loopbackWatchInterval);
  _loopbackWatchInterval = null;
}

// ── Game audio routing ────────────────────────────────────────────────────────
const AUDIO_BLACKLIST = [
  'webrtc', 'teamspeak', 'discord', 'vesktop', 'firefox', 'chrome', 'brave', 'vivaldi', 'sd_dummy',
  'spotify', 'zoom', 'teams', 'telegram-desktop', 'mumble', 'slack'
];

let _targetProcess = null;
let _routingInterval = null;

function routeGameAudio(gameProcessName) {
  _targetProcess = (gameProcessName && gameProcessName !== 'ALL_DESKTOP') ? gameProcessName.toLowerCase() : null;

  if (_routingInterval) clearInterval(_routingInterval);

  log(`Continuous pactl routing active. Target: ${_targetProcess || 'ALL_DESKTOP'}`);

  _routingInterval = setInterval(() => {
    _routeViaPatctl();
  }, 2000);
}

function stopRoutingDaemon() {
  if (_routingInterval) {
    clearInterval(_routingInterval);
    _routingInterval = null;
  }
}

// THE BRUTEFORCE PACTL MOVER
function _routeViaPatctl() {
  if (process.platform !== 'linux') return;
  exec('pactl list short sinks', (e0, sinksOut) => {
    const nearsecLine = (sinksOut || '').split('\n').find(l => l.includes('NearsecVirtual'));
    if (!nearsecLine) return;
    const nearsecSinkId = nearsecLine.trim().split(/\s+/)[0];

    exec('pactl list sink-inputs', (e1, verbose) => {
      const blocks = (verbose || '').split(/(?=Sink Input #\d+)/g);
      for (const block of blocks) {
        const inputId = (block.match(/^Sink Input #(\d+)/) || [])[1];
        if (!inputId) continue;
        const currentSink = (block.match(/^\s*Sink:\s*(\d+)/m) || [])[1];
        if (currentSink === nearsecSinkId) continue;

        const identifier = ((block.match(/application\.process\.binary\s*=\s*"([^"]+)"/) || [])[1] || (block.match(/application\.name\s*=\s*"([^"]+)"/) || [])[1] || '').toLowerCase();

        // Skip hidden/system streams
        if (!identifier || identifier.includes('nearsec')) continue;

        // Apply blacklist
        if (AUDIO_BLACKLIST.some(b => identifier.includes(b.toLowerCase()))) continue;

        // Apply target filter if specific game requested
        if (_targetProcess && !identifier.includes(_targetProcess)) continue;

        // The move command
        exec(`pactl move-sink-input ${inputId} ${nearsecSinkId}`, e2 => {
          if (!e2) log(`Moved audio [${identifier}] → NearsecVirtual`);
        });
      }
    });
  });
}

// ── Message dispatcher ────────────────────────────────────────────────────────
parentPort.on('message', async (msg) => {
  try {
    switch (msg.type) {
      case 'init': await initVirtualAudio(); break;
      case 'destroy': await destroyVirtualAudio(); break;
      case 'route': routeGameAudio(msg.processName || null); break;
      case 'route-stop':
        stopRoutingDaemon();
        log('Routing session stopped.');
        break;
      case 'cleanup-stale': await cleanupStaleSinks(); break;
    }
  } catch (e) { err(`Unhandled error: ${e.message}`); }
});

log('Worker thread started (Legacy Pactl Mode).');
