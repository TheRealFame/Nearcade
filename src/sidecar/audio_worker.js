/**
 * audio_worker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker thread for Nearcade virtual-audio lifecycle management.
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

  // Mute the virtual sink BEFORE touching any module. If a stale loopback is
  // still attached, killing the sink first produces a deafening buzz.
  await _pactlExec('pactl set-sink-mute NearcadeVirtual 1');

  const list = await _pactlExec('pactl list short modules');
  if (!list) return;

  const staleIds = [];
  for (const line of list.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes('NearcadeVirtual')  || trimmed.includes('NearcadeVirtualCapture') ||
      trimmed.includes('NearcadeMic_')) {
      const id = trimmed.split(/\s+/)[0];
    if (id && /^\d+$/.test(id)) staleIds.push(id);
      }
  }

  if (staleIds.length > 0) {
    log(`Cleaning up ${staleIds.length} stale audio modules...`);
    // THE FIX: unload loopbacks FIRST, then sinks. PulseAudio produces a
    // permanent deafening buzz when a null-sink dies while its loopback is
    // still attached; never unload in pactl-list order.
    const loopbacks = [];
    const others = [];
    for (const line of list.split('\n')) {
      if (!line.includes('module-loopback')) continue;
      const id = line.trim().split(/\s+/)[0];
      if (staleIds.includes(id)) loopbacks.push(id);
    }
    for (const id of staleIds) if (!loopbacks.includes(id)) others.push(id);

    const ordered = loopbacks.concat(others);
    for (const id of ordered) await _pactlExec(`pactl unload-module ${id}`);
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
    'pactl load-module module-null-sink sink_name=NearcadeVirtual sink_properties=device.description="NearcadeVirtual"'
  );

  // 2. Create WebRTC Monitor Remap
  _vAudioModules.remap = await _pactlExec(
    'pactl load-module module-remap-source master=NearcadeVirtual.monitor source_name=NearcadeVirtualCapture source_properties=device.description="NearcadeVirtualCapture"'
  );

  // 3. THE GHOST MUTE FIX (Ensure OS doesn't auto-mute the new sink)
  await _pactlExec('pactl set-sink-mute NearcadeVirtual 0');
  await _pactlExec('pactl set-sink-volume NearcadeVirtual 100%');
  await _pactlExec('pactl set-source-mute NearcadeVirtual.monitor 0');
  await _pactlExec('pactl set-source-volume NearcadeVirtual.monitor 100%');
  await _pactlExec('pactl set-source-mute NearcadeVirtualCapture 0');
  await _pactlExec('pactl set-source-volume NearcadeVirtualCapture 100%');

  // 4. Resolve Hardware Sink (Your headphones/speakers)
  let hwSink = (await _pactlExec('pactl get-default-sink')).trim();
  if (!hwSink || hwSink.includes('Nearcade')) {
    const sinksRaw = await _pactlExec('pactl list short sinks');
    const fallback = (sinksRaw || '').split('\n').find(l => !l.includes('Nearcade') && l.trim() !== '');
    if (fallback) hwSink = fallback.trim().split(/\s+/)[1];
  }

  // 5. Establish the Loopback Mirror (Sends game audio from virtual cable BACK to your ears)
  if (hwSink) {
    _vAudioModules.loopback = await _pactlExec(
      `pactl load-module module-loopback source=NearcadeVirtual.monitor sink=${hwSink} latency_msec=30`
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
  const nearcadeLine = (sinks || '').split('\n').find(l => l.includes('NearcadeVirtual') && !l.includes('NearcadeVirtualCapture'));
  if (nearcadeLine && defaultSink && defaultSink !== 'NearcadeVirtual') {
    const nearcadeId = nearcadeLine.trim().split(/\s+/)[0];
    const inputs = await _pactlExec('pactl list short sink-inputs');
    for (const line of (inputs || '').split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      if (parts[1] === nearcadeId && /^\d+$/.test(parts[0])) {
        await _pactlExec(`pactl move-sink-input ${parts[0]} ${defaultSink}`);
      }
    }
  }

  // ── THE SCREECH FIX ──
  await _pactlExec('pactl set-sink-mute NearcadeVirtual 1');
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
      if (!current || current.includes('Nearcade') || current === _lastLoopbackSink) return;

      // Device changed! Move loopback silently.
      await _pactlExec('pactl set-sink-mute NearcadeVirtual 1');
      await new Promise(r => setTimeout(r, 40));
      if (_vAudioModules.loopback) {
        await _pactlExec(`pactl unload-module ${_vAudioModules.loopback}`);
      }
      _vAudioModules.loopback = await _pactlExec(`pactl load-module module-loopback source=NearcadeVirtual.monitor sink=${current} latency_msec=30`);
      parentPort.postMessage({ type: 'module-ids', ids: { loopback: _vAudioModules.loopback }});
      await _pactlExec('pactl set-sink-mute NearcadeVirtual 0');
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
    const nearcadeLine = (sinksOut || '').split('\n').find(l => l.includes('NearcadeVirtual'));
    if (!nearcadeLine) return;
    const nearcadeSinkId = nearcadeLine.trim().split(/\s+/)[0];

    exec('pactl list sink-inputs', (e1, verbose) => {
      const blocks = (verbose || '').split(/(?=Sink Input #\d+)/g);
      for (const block of blocks) {
        const inputId = (block.match(/^Sink Input #(\d+)/) || [])[1];
        if (!inputId) continue;
        const currentSink = (block.match(/^\s*Sink:\s*(\d+)/m) || [])[1];
        if (currentSink === nearcadeSinkId) continue;

        const identifier = ((block.match(/application\.process\.binary\s*=\s*"([^"]+)"/) || [])[1] || (block.match(/application\.name\s*=\s*"([^"]+)"/) || [])[1] || '').toLowerCase();

        // Skip hidden/system streams
        if (!identifier || identifier.includes('nearcade')) continue;

        // Apply blacklist
        if (AUDIO_BLACKLIST.some(b => identifier.includes(b.toLowerCase()))) continue;

        // Apply target filter if specific game requested
        if (_targetProcess && !identifier.includes(_targetProcess)) continue;

        // The move command
        exec(`pactl move-sink-input ${inputId} ${nearcadeSinkId}`, e2 => {
          if (!e2) log(`Moved audio [${identifier}] → NearcadeVirtual`);
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
