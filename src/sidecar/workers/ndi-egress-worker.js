'use strict';
// NDI egress worker — runs in an Electron utilityProcess (pure Node, no DOM).
// Loads the N-API `grandi` (NDI SDK 6) sender and pumps RGBA frames from the
// host renderer to the LAN. OBS / any NDI receiver discovers it as a source.
let grandi = null;
let sender = null;
let timer = null;
let sendQ = { width: 0, height: 0, buffer: null };

function status(kind, extra) {
  const s = { ev: 'status', kind: kind || 'update', running: !!sender };
  if (sender) {
    try { s.connections = sender.connections(); } catch (_) { s.connections = 0; }
  }
  Object.assign(s, extra || {});
  if (process.parentPort) process.parentPort.postMessage(s);
  else if (process.send) process.send(s);
}

function init() {
  try {
    grandi = require('grandi');
  } catch (e) {
    const m = { ev: 'error', msg: 'grandi failed to load: ' + (e && e.message) };
    if (process.parentPort) process.parentPort.postMessage(m); else if (process.send) process.send(m);
    return;
  }
  if (!grandi.initialize()) {
    const m = { ev: 'error', msg: 'NDI SDK failed to initialize (unsupported CPU?)' };
    if (process.parentPort) process.parentPort.postMessage(m); else if (process.send) process.send(m);
    return;
  }
  status('ready');
}

async function start(cfg) {
  try {
    if (sender) { sender.destroy(); sender = null; }
    grandi = grandi || require('grandi');
    if (!grandi.initialize()) throw new Error('NDI init failed');
    sender = await grandi.send({ name: cfg.name || 'Nearcade Host' });
    status('started');
    if (timer) clearInterval(timer);
    timer = setInterval(() => status(), 2000);
  } catch (e) {
    const m = { ev: 'error', msg: 'NDI sender error: ' + (e && e.message) };
    if (process.parentPort) process.parentPort.postMessage(m); else if (process.send) process.send(m);
  }
}

function frame(meta, buf) {
  if (!sender || !buf) return;
  if (meta.width < 16 || meta.height < 16) return;
  try {
    const data = Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength || buf.length);
    if (data.length !== meta.width * meta.height * 4) return;
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    sender.video({
      xres: meta.width,
      yres: meta.height,
      frameRateN: (meta.fps || 30) * 1000,
      frameRateD: 1000,
      pictureAspectRatio: meta.width / meta.height,
      fourCC: grandi.FourCC.RGBA,
      frameFormatType: grandi.FrameType.Progressive,
      lineStrideBytes: meta.width * 4,
      data,
      timecode: grandi.TIMECODE_SYNTHESIZE,
    }).catch((e) => {
      const m = { ev: 'error', msg: 'NDI Send Error: ' + e.message };
      if (process.parentPort) process.parentPort.postMessage(m); else if (process.send) process.send(m);
    });
  } catch (_) { }
}

function stop() {
  try {
    if (timer) { clearInterval(timer); timer = null; }
    if (sender) { sender.destroy(); sender = null; }
    if (grandi) { try { grandi.destroy(); } catch (_) { } }
    status('stopped');
  } catch (_) { }
}

const handleMsg = (msg) => {
  if (!msg || typeof msg !== 'object' || !msg.op) return;
  if (msg.op === 'init') init();
  else if (msg.op === 'start') start(msg.cfg || {});
  else if (msg.op === 'frame') frame(msg.meta || {}, msg.buffer);
  else if (msg.op === 'stop') stop();
};

if (process.parentPort) process.parentPort.on('message', handleMsg);
else process.on('message', handleMsg);

init();