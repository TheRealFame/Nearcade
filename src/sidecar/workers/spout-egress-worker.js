'use strict';
// Spout2 egress worker — runs in an Electron utilityProcess (pure Node, no DOM).
// Windows only: drives SpoutLibrary.dll (Spout2 C-API bridge) through the `koffi`
// FFI addon. Receives RGBA frames from the host renderer and publishes them as a
// Spout sender that OBS / any Spout2-aware app can pick natively.
// Fails open: if SpoutLibrary.dll or koffi are unavailable (non-Windows, missing
// DLL), every op degrades to a status error without ever crashing the app.
const os = require('os');
const path = require('path');
const fs = require('fs');

let koffi = null;
let SpoutLib = null; // SPOUTLIBRARY vtable struct type
let handle = null;   // loaded SpoutLibrary instance
let senderName = '';
let active = false;
let timer = null;

function libPath() {
  const cands = [];
  try {
    let probe = __dirname;
    for (let i = 0; i < 6 && path.dirname(probe) !== probe; i++) {
      cands.push(path.join(probe, 'bin', 'SpoutLibrary', 'SpoutLibrary.dll'));
      probe = path.dirname(probe);
    }
  } catch (_) { }
  try {
    if (process.resourcesPath) {
      cands.push(path.join(process.resourcesPath, 'bin', 'SpoutLibrary', 'SpoutLibrary.dll'));
      cands.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', 'SpoutLibrary', 'SpoutLibrary.dll'));
    }
  } catch (_) { }
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  return cands[0] || '';
}

function status(kind, extra) {
  const s = { ev: 'status', kind: kind || 'update', running: !!senderName && active };
  Object.assign(s, extra || {});
  process.parentPort.postMessage(s);
}

function fail(msg) {
  process.parentPort.postMessage({ ev: 'error', msg });
}

function init() {
  if (os.platform() !== 'win32') {
    fail('Spout2 is only supported on Windows');
    return;
  }
  try {
    koffi = require('koffi');
  } catch (e) {
    fail('koffi failed to load: ' + (e && e.message));
    return;
  }
  const dll = libPath();
  if (!dll || !fs.existsSync(dll)) {
    fail('SpoutLibrary.dll not found (expected at ' + (dll || 'bin/SpoutLibrary/') + ')');
    return;
  }
  try {
    // SpoutLibrary.h — struct SPOUTLIBRARY is a COM-style abstract class whose
    // vtable starts with the Sender section, in exactly this order:
    //   0 SetSenderName(const char*)
    //   1 SetSenderFormat(DWORD)
    //   2 ReleaseSender(DWORD dwMsec)
    //   3 SendFbo(GLuint, uint, uint, bool)
    //   4 SendTexture(GLuint, GLuint, uint, uint, bool, GLuint)
    //   5 SendImage(const unsigned char*, uint, uint, GLenum, bool)
    //   6 IsInitialized()
    //   7 GetName()
    //   8 GetWidth()
    //   9 GetHeight()
    const ProtoVoidStr = koffi.proto('void', ['str']);
    const ProtoVoidU32 = koffi.proto('void', ['uint32']);
    const ProtoBoolPix = koffi.proto('bool', ['void *', 'uint32', 'uint32', 'uint32', 'bool']);
    const ProtoStr = koffi.proto('str', []);
    const ProtoU32 = koffi.proto('uint32', []);
    const VTable = koffi.struct('SpoutVTable', {
      SetSenderName: koffi.pointer(ProtoVoidStr),
      SetSenderFormat: koffi.pointer(ProtoVoidU32),
      ReleaseSender: koffi.pointer(ProtoVoidU32),
      SendFbo: koffi.pointer(koffi.proto('bool', ['uint32', 'uint32', 'uint32', 'bool'])),
      SendTexture: koffi.pointer(koffi.proto('bool', ['uint32', 'uint32', 'uint32', 'uint32', 'bool', 'uint32'])),
      SendImage: koffi.pointer(ProtoBoolPix),
      IsInitialized: koffi.pointer(koffi.proto('bool', [])),
      GetName: koffi.pointer(ProtoStr),
      GetWidth: koffi.pointer(ProtoU32),
      GetHeight: koffi.pointer(ProtoU32),
    });
    SpoutLib = koffi.struct('SpoutHandle', { vtbl: koffi.pointer(VTable) });
    const libObj = koffi.load(dll);
    const factory = libObj.func('void *LoadSpoutLibrary()');
    const raw = factory();
    if (!raw) { fail('LoadSpoutLibrary() returned null'); return; }
    handle = raw;
    status('ready');
  } catch (e) {
    fail('Spout init error: ' + (e && e.message));
  }
}

function obj() {
  if (!handle) return null;
  try { return koffi.decode(SpoutLib, handle); } catch (_) { return null; }
}

function start(cfg) {
  if (!handle) { init(); if (!handle) return; }
  try {
    if (active) stop();
    active = true;
    senderName = cfg.name || 'Nearcade Host';
    const o = obj();
    if (!o) throw new Error('Spout handle unavailable');
    o.vtbl.SetSenderName(senderName);
    status('started', { sender: senderName });
    if (timer) clearInterval(timer);
    timer = setInterval(() => status(), 2000);
  } catch (e) {
    active = false;
    fail('Spout sender error: ' + (e && e.message));
  }
}

function frame(meta, buf) {
  if (!active || !handle || !buf) return;
  if (meta.width < 16 || meta.height < 16) return;
  try {
    const o = obj();
    if (!o) return;
    // GL_RGBA (0x1908) — SpoutLibrary converts to BGRA internally for DX11
    o.vtbl.SendImage(koffi.as(buf, 'void *'), meta.width, meta.height, 0x1908, false);
  } catch (_) { }
}

function stop() {
  try {
    if (timer) { clearInterval(timer); timer = null; }
    if (handle) {
      const o = obj();
      if (o) o.vtbl.ReleaseSender(0);
    }
    active = false;
    senderName = '';
    status('stopped');
  } catch (_) { }
}

process.parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object' || !msg.op) return;
  if (msg.op === 'init') init();
  else if (msg.op === 'start') start(msg.cfg || {});
  else if (msg.op === 'frame') frame(msg.meta || {}, msg.buffer);
  else if (msg.op === 'stop') stop();
});

init();