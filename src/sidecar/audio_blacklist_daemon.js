'use strict';
/**
 * Nearcade — Audio Blacklist Ejection Daemon
 *
 * TOPOLOGY:
 *   NearsecAppAudio (virtual null-sink)
 *       │
 *       ├─ module-remap-source  →  NearsecAppMic  →  WebRTC capture (viewers hear this)
 *       └─ module-loopback      →  Hardware sink  →  Host's headphones (host hears this)
 *
 * The daemon watches every sink-input currently landing on NearsecAppAudio.
 * When a blacklisted app is found there it immediately issues:
 *
 *   pactl move-sink-input <id> <hardware-sink>
 *
 * This pins Discord/Spotify/etc. directly to the host's real audio hardware so
 * they are heard locally but are NOT captured by the WebRTC stream monitor.
 *
 * BLACKLIST FORMAT: fuzzy, case-insensitive substrings matched against:
 *   application.process.binary, application.name, node.name, media.name
 *
 * HARDWARE SINK RESOLUTION:
 *   Calls `pactl get-default-sink` at every tick, falling back to the first
 *   non-Nearsec sink in `pactl list short sinks`. This survives Bluetooth
 *   device disconnections / reconnections without any restart.
 *
 * EJECTION PERSISTENCE:
 *   Tracks ejected streams by PulseAudio client-id (stable for the lifetime
 *   of an app process) so we do not issue redundant pactl commands. If a
 *   blacklisted app opens a new stream after being ejected it is caught and
 *   moved on the next tick.
 */

const { execFile, exec } = require('child_process');

// ── Default blacklist ─────────────────────────────────────────────────────────
// These substrings are matched against every audio stream's identity fields.
// Lower-case, fuzzy — "discord" catches "Discord", "Vesktop (Discord)", etc.
// ── Default blacklist ─────────────────────────────────────────────────────────
const DEFAULT_BLACKLIST = [
  'chrome', 'firefox', 'discord', 'vesktop', 'armcord', 'webcord', 'legcord',
'teamspeak', 'ts3client', 'mumble',
'slack', 'zoom', 'teams', 'telegram-desktop',
'spotify',
];

// Target the new virtual sink architecture
const VIRTUAL_SINK  = 'NearsecVirtual';
const POLL_MS       = 1500;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Run a command and return its stdout as a string (empty string on error). */
function run(cmd, args, timeout = 6000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout }, (err, stdout) =>
      resolve(err ? '' : (stdout || ''))
    );
  });
}

/**
 * Parse the verbose output of `pactl list sink-inputs` into an array of
 * objects.  We extract every field that could carry an app's identity.
 *
 * Returns: [{ id, sinkId, appBinary, appName, nodeName, mediaName, clientKey }]
 *
 * clientKey is the most stable per-process identifier: `client.id` if present,
 * else `application.process.id` (the OS PID), else the sink-input ID.
 */
function parseSinkInputs(raw) {
  if (!raw) return [];
  const results = [];

  // Split on every "Sink Input #N" boundary, keeping the header
  const blocks = raw.split(/(?=Sink Input #\d+)/g);

  for (const block of blocks) {
    const idMatch = block.match(/^Sink Input #(\d+)/);
    if (!idMatch) continue;

    const g = (re) => (block.match(re) || [])[1] || '';

    const id        = idMatch[1];
    const appBinary = g(/application\.process\.binary\s*=\s*"([^"]+)"/);
    const appName   = g(/application\.name\s*=\s*"([^"]+)"/);
    const clientId  = g(/client\.id\s*=\s*"([^"]+)"/);
    const processId = g(/application\.process\.id\s*=\s*"([^"]+)"/);

    results.push({
      id,
      // Sink number on which this stream currently lives (numeric string)
      sinkId:    g(/^\s*Sink:\s*(\d+)/m),
      appBinary,
      appName,
      nodeName:  g(/node\.name\s*=\s*"([^"]+)"/),
      mediaName: g(/media\.name\s*=\s*"([^"]+)"/),
      // Stable client reference for ejection cache
      clientKey: clientId || processId || id,
      rawBlock: block,
    });
  }
  return results;
}

/**
 * Parse `pactl list short sinks` into two lookup maps.
 * Returns { byName: { sinkName → id }, byId: { id → sinkName } }
 */
function parseSinks(raw) {
  const byName = {}, byId = {};
  for (const line of (raw || '').split('\n').filter(Boolean)) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 2) { byId[p[0]] = p[1]; byName[p[1]] = p[0]; }
  }
  return { byName, byId };
}

/**
 * Return true if any identity field of this sink-input contains a blacklist
 * entry as a case-insensitive substring.
 */
function isBlacklisted(input, blacklist) {
  const rawLower = (input.rawBlock || '').toLowerCase();
  return blacklist.some(entry => rawLower.includes(entry.toLowerCase()));
}

// ── Ejection cache ────────────────────────────────────────────────────────────
// clientKey → { lastSinkInputId, hardwareSink }
// We re-eject if the stream reappears on the capture sink OR if the hardware
// sink has changed (e.g. after a Bluetooth reconnection).
// ── Ejection cache ────────────────────────────────────────────────────────────
// clientKey → { lastSinkInputId, hardwareSink }
const _ejected = new Map();
let _fallbackSink = null; // Stores the known-good hardware sink from the server

// ── Tick ──────────────────────────────────────────────────────────────────────
async function tick(blacklist) {
  // ── Step 1: resolve all sinks ────────────────────────────────────────────
  const sinksRaw = await run('pactl', ['list', 'short', 'sinks']);
  const { byName, byId } = parseSinks(sinksRaw);

  const virtualSinkId = byName[VIRTUAL_SINK];
  if (!virtualSinkId) return; // Virtual audio not initialised yet — wait

  // ── Step 2: determine the current hardware sink ──────────────────────────
  let hwSink = null;
  const defaultSink = (await run('pactl', ['get-default-sink'])).trim();

  if (defaultSink && !defaultSink.includes('Nearsec')) {
    hwSink = defaultSink;
  } else {
    // Track the Loopback Destination (Broadened for WirePlumber compatibility)
    const inputsRaw = await run('pactl', ['list', 'sink-inputs']);
    const inputs = parseSinkInputs(inputsRaw);

    const loopbackInput = inputs.find(i =>
    (i.appName && i.appName.toLowerCase().includes('loopback')) ||
    (i.mediaName && i.mediaName.toLowerCase().includes('loopback')) ||
    (i.nodeName && i.nodeName.toLowerCase().includes('loopback'))
    );

    if (loopbackInput && loopbackInput.sinkId) {
      hwSink = byId[loopbackInput.sinkId];
    }

    // Rely on the exact sink provided by server.js if loopback tracking fails
    if (!hwSink && _fallbackSink && byName[_fallbackSink]) {
      hwSink = _fallbackSink;
    }
  }

  // ── THE FIX: No more random guessing ──
  if (!hwSink) {
    process.stderr.write('[blacklist] Cannot confidently resolve hardware sink — skipping tick to prevent ghost routing.\n');
    return;
  }

  _fallbackSink = hwSink; // Update known-good sink for the next tick

  // ── Step 3: get verbose sink-input data ──────────────────────────────────
  const inputsRaw = await run('pactl', ['list', 'sink-inputs']);
  const inputs = parseSinkInputs(inputsRaw);
  const liveClientKeys = new Set(inputs.map(i => i.clientKey));

  // ── Step 4: scan and eject ────────────────────────────────────────────────
  for (const input of inputs) {
    if (input.sinkId !== virtualSinkId) {
      _ejected.delete(input.clientKey);
      continue;
    }

    if (!isBlacklisted(input, blacklist)) continue;

    const prev = _ejected.get(input.clientKey);
    if (prev && prev.hwSink === hwSink) {
      if (prev.lastSinkInputId !== input.id) {
        _ejected.set(input.clientKey, { lastSinkInputId: input.id, hwSink });
        exec(`pactl move-sink-input ${input.id} ${hwSink}`, (err) => {
          if (!err) {
            const label = input.appBinary || input.appName || `input-${input.id}`;
            process.stdout.write(`[blacklist] ↺ Re-ejected new stream from "${label}" (${input.id}) → ${hwSink}\n`);
          }
        });
      }
      continue;
    }

    const label = input.appBinary || input.appName || `input-${input.id}`;
    exec(`pactl move-sink-input ${input.id} ${hwSink}`, (err) => {
      if (err) {
        process.stderr.write(`[blacklist] WARN: move of "${label}" (${input.id}) failed: ${err.message}\n`);
        return;
      }
      _ejected.set(input.clientKey, { lastSinkInputId: input.id, hwSink });
      process.stdout.write(`[blacklist] ✓ Ejected "${label}" (sink-input ${input.id}) → ${hwSink}\n`);
    });
  }

  // ── Step 5: prune stale ejection-cache entries ────────────────────────────
  for (const key of _ejected.keys()) {
    if (!liveClientKeys.has(key)) _ejected.delete(key);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function startDaemon(blacklist = DEFAULT_BLACKLIST, targetSink = null) {
  if (process.platform !== 'linux') {
    process.stdout.write('[blacklist] Non-Linux platform — daemon not started.\n');
    return null;
  }

  _fallbackSink = targetSink;
  const list = [...new Set(blacklist.map(s => s.toLowerCase()))];

  process.stdout.write(`[blacklist] Daemon started  |  sink: ${VIRTUAL_SINK}  |  poll: ${POLL_MS}ms\n`);
  process.stdout.write(`[blacklist] Target hardware: ${targetSink || 'Dynamic'}\n`);

  const interval = setInterval(() =>
  tick(list).catch(e => {
    if (!e.message?.includes('ENOENT')) process.stderr.write(`[blacklist] Tick error: ${e.message}\n`);
  }),
  POLL_MS
  );

  tick(list).catch(() => {});
  return interval;
}

function stopDaemon(handle) {
  if (handle) clearInterval(handle);
}

module.exports = { startDaemon, stopDaemon, DEFAULT_BLACKLIST };

// ── Standalone mode ───────────────────────────────────────────────────────────
// node audio_blacklist_daemon.js [extra-term ...]
if (require.main === module) {
  const extra = process.argv.slice(2);
  const list  = extra.length ? [...DEFAULT_BLACKLIST, ...extra] : DEFAULT_BLACKLIST;
  startDaemon(list);
  process.on('SIGINT',  () => { process.stdout.write('\n[blacklist] Stopped.\n'); process.exit(0); });
  process.on('SIGTERM', () => process.exit(0));
}
