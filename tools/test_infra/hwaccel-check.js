#!/usr/bin/env node
/**
 * test_infra/hwaccel-check.js
 * Hardware-acceleration probe for Nearcade streaming codecs.
 *
 * Plain `node`, zero npm dependencies. Re-encodes assets/benchmark.mp4
 * through each real HW encoder (+ HW decode) and prints a summarized
 * OK / NO verdict per codec.
 *
 *   node test_infra/hwaccel-check.js                 # single pass (~1-3 min)
 *   node test_infra/hwaccel-check.js --soak 10       # repeat sessions for 10 min
 *   node test_infra/hwaccel-check.js --soak 10 --clip 5 --with-software
 *
 * Flags:
 *   --soak N          run repeated sessions for N minutes (0 = single pass)
 *   --clip S          seconds of source to re-encode per test (default 10, 5 in soak)
 *   --with-software   also run libx264/libx265/libvpx software baselines
 *   --src PATH        source video (default assets/benchmark.mp4)
 *   --log PATH        report file (default test_infra/hwaccel-report.log)
 */
'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(name);
const SOAK_MIN = parseFloat(opt('--soak', '0')) || 0;
const CLIP = parseInt(opt('--clip', SOAK_MIN > 0 ? '5' : '10'), 10);
const WITH_SW = flag('--with-software');
const SRC = path.resolve(ROOT, opt('--src', 'assets/benchmark.mp4'));
const LOG = path.resolve(ROOT, opt('--log', 'test_infra/hwaccel-report.log'));
const ENCODE_TIMEOUT_MS = 120000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}
function run(cmd, argv, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
function verdict(ok) { return ok ? 'OK' : 'NO'; }

// Codec matrix: streaming codecs x HW encoder candidates (first match tried first)
const CODECS = [
  { id: 'h264', label: 'H.264 / AVC',  hw: ['h264_vaapi', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'], sw: 'libx264' },
  { id: 'hevc', label: 'H.265 / HEVC', hw: ['hevc_vaapi', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_videotoolbox'], sw: 'libx265' },
  { id: 'vp8',  label: 'VP8',          hw: ['vp8_vaapi'], sw: 'libvpx' },
  { id: 'vp9',  label: 'VP9',          hw: ['vp9_vaapi', 'vp9_qsv'], sw: 'libvpx-vp9' },
  { id: 'av1',  label: 'AV1',          hw: ['av1_vaapi', 'av1_nvenc', 'av1_qsv'], sw: 'libaom-av1' },
];
const BACKEND_OF = { _vaapi: 'vaapi', _nvenc: 'cuda', _qsv: 'qsv', _amf: 'd3d11va', _videotoolbox: 'videotoolbox' };

let FFMPEG_ENCS = new Set();
let HWACCELS = [];
let VAAPI_DEV = null;
let HAS_NVIDIA = false;

async function probeHost() {
  const info = {};
  info.os = `${os.platform()} ${os.arch()} ${os.release()}`;
  try { info.cpu = fs.readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.+)/)[1].trim(); }
  catch (_) { info.cpu = os.cpus()[0]?.model || 'unknown'; }
  const dri = [];
  try { for (const n of fs.readdirSync('/dev/dri')) if (n.startsWith('renderD') || n.startsWith('card')) dri.push('/dev/dri/' + n); } catch (_) {}
  info.dri = dri;
  VAAPI_DEV = dri.find((d) => d.includes('renderD')) || null;
  const r = await run('ffmpeg', ['-hide_banner', '-encoders']);
  for (const m of r.stdout.matchAll(/^\s*V[\w.]{5}\s+([A-Za-z0-9_-]+)/gm)) FFMPEG_ENCS.add(m[1]);
  const h = await run('ffmpeg', ['-hide_banner', '-hwaccels']);
  HWACCELS = h.stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== 'Hardware acceleration methods:');
  const nv = await run('nvidia-smi', ['-L'], 8000);
  HAS_NVIDIA = !nv.err && /GPU/i.test(nv.stdout);
  const va = await run('vainfo', [], 10000);
  info.vaapiProfiles = [];
  if (!va.err) {
    const txt = va.stdout + va.stderr;
    const drv = txt.match(/Driver version:\s*(.+)/);
    if (drv) info.vaapiDriver = drv[1].trim();
    for (const m of txt.matchAll(/VAProfile(\S+?)\s*:\s*VAEntrypoint(\S+)/g)) info.vaapiProfiles.push(`${m[1]}/${m[2]}`);
  } else info.vaapiError = (va.stderr || va.err.message).split('\n')[0];
  return info;
}

function backendNeeded(enc) {
  for (const [suf, be] of Object.entries(BACKEND_OF)) if (enc.endsWith(suf)) return be;
  return null;
}
function backendPresent(be) {
  if (!be) return { ok: true, why: 'software frames' };
  if (be === 'vaapi') return VAAPI_DEV ? { ok: true, why: VAAPI_DEV } : { ok: false, why: 'no /dev/dri/renderD*' };
  if (be === 'cuda') return HAS_NVIDIA ? { ok: true, why: 'nvidia-smi' } : { ok: false, why: 'no NVIDIA GPU' };
  if (be === 'qsv') return VAAPI_DEV ? { ok: true, why: VAAPI_DEV } : { ok: false, why: 'no /dev/dri node' };
  if (be === 'd3d11va' || be === 'amf') return os.platform() === 'win32' ? { ok: true, why: 'windows' } : { ok: false, why: 'windows-only' };
  if (be === 'videotoolbox') return os.platform() === 'darwin' ? { ok: true, why: 'macos' } : { ok: false, why: 'macos-only' };
  return { ok: true, why: '' };
}

function encodeArgs(enc, be) {
  // Returns ffmpeg argv (without global -y) to HW-encode CLIP seconds to null.
  if (be === 'vaapi') {
    return ['-y', '-vaapi_device', VAAPI_DEV, '-t', String(CLIP), '-i', SRC,
      '-vf', 'format=nv12,hwupload', '-c:v', enc, '-b:v', '4M', '-maxrate', '6M', '-f', 'null', '-'];
  }
  if (be === 'cuda') {
    return ['-y', '-t', String(CLIP), '-i', SRC, '-vf', 'format=nv12,hwupload_cuda',
      '-c:v', enc, '-b:v', '4M', '-maxrate', '6M', '-f', 'null', '-'];
  }
  if (be === 'qsv') {
    return ['-y', '-init_hw_device', 'qsv=qsv:hw', '-filter_hw_device', 'qsv',
      '-t', String(CLIP), '-i', SRC, '-vf', 'format=nv12,hwupload=extra_hw_frames=64',
      '-c:v', enc, '-b:v', '4M', '-maxrate', '6M', '-f', 'null', '-'];
  }
  // amf / videotoolbox take software frames directly
  return ['-y', '-t', String(CLIP), '-i', SRC, '-c:v', enc, '-b:v', '4M', '-maxrate', '6M', '-f', 'null', '-'];
}
function swArgs(enc) {
  const base = ['-y', '-t', String(CLIP), '-i', SRC, '-c:v', enc, '-b:v', '4M', '-maxrate', '6M'];
  if (enc === 'libaom-av1') base.push('-cpu-used', '8');
  else if (enc.startsWith('libvpx')) base.push('-cpu-used', '4', '-deadline', 'realtime');
  else base.push('-preset', 'veryfast');
  return base.concat(['-f', 'null', '-']);
}
function decodeArgs() {
  let be = null;
  if (os.platform() === 'linux' && VAAPI_DEV) be = 'vaapi';
  else if (HAS_NVIDIA) be = 'cuda';
  else if (os.platform() === 'darwin') be = 'videotoolbox';
  else if (os.platform() === 'win32') be = 'd3d11va';
  const a = ['-y'];
  if (be === 'vaapi') a.push('-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEV, '-hwaccel_output_format', 'vaapi');
  else if (be) a.push('-hwaccel', be);
  return { argv: a.concat(['-t', String(CLIP), '-i', SRC, '-f', 'null', '-']), be: be || 'none(sw decode)' };
}

function runEncode(argv) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('ffmpeg', ['-hide_banner', ...argv]);
    let err = '';
    const kill = setTimeout(() => p.kill('SIGKILL'), ENCODE_TIMEOUT_MS);
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => { clearTimeout(kill); resolve({ ok: false, why: 'spawn: ' + e.message }); });
    p.on('close', (code) => {
      clearTimeout(kill);
      const ms = Date.now() - t0;
      const frames = [...err.matchAll(/frame=\s*(\d+)/g)].map((m) => +m[1]).pop() || 0;
      const effFps = ms > 0 ? Math.round((frames / ms) * 1000) : 0;
      const tail = err.trim().split('\n').slice(-4).join(' | ').slice(0, 300);
      if (code === 0 && frames > 0) resolve({ ok: true, ms, frames, fps: effFps, tail });
      else resolve({ ok: false, ms, frames, fps: effFps, why: tail || `exit=${code}` });
    });
  });
}

async function testEncodeHw(codec) {
  const tried = [];
  for (const enc of codec.hw) {
    if (!FFMPEG_ENCS.has(enc)) { tried.push(`${enc}(not compiled)`); continue; }
    const be = backendNeeded(enc);
    const present = backendPresent(be);
    if (!present.ok) { tried.push(`${enc}(${present.why})`); continue; }
    const r = await runEncode(encodeArgs(enc, be));
    if (r.ok) return { ok: true, detail: `${enc} via ${present.why} — ${r.frames}f in ${(r.ms / 1000).toFixed(1)}s (${r.fps}fps)` };
    tried.push(`${enc}(encode failed: ${r.why.slice(0, 120)})`);
  }
  return { ok: false, detail: tried.join('; ') || 'no candidate encoder' };
}
async function testDecodeHw(codec) {
  const { argv, be } = decodeArgs();
  const r = await runEncode(argv);
  if (r.ok) return { ok: true, detail: `hwaccel=${be} — ${r.frames}f in ${(r.ms / 1000).toFixed(1)}s (${r.fps}fps)` };
  return { ok: false, detail: `hwaccel=${be} failed: ${r.why.slice(0, 140)}` };
}
async function testEncodeSw(codec) {
  if (!FFMPEG_ENCS.has(codec.sw)) return { ok: false, detail: `${codec.sw}(not compiled)` };
  const r = await runEncode(swArgs(codec.sw));
  if (r.ok) return { ok: true, detail: `${codec.sw} — ${r.frames}f in ${(r.ms / 1000).toFixed(1)}s (${r.fps}fps)` };
  return { ok: false, detail: `${codec.sw} failed: ${r.why.slice(0, 140)}` };
}

async function oneSession(n) {
  log(`--- session #${n}: re-encoding ${CLIP}s of ${path.basename(SRC)} ---`);
  const rows = [];
  for (const c of CODECS) {
    const enc = await testEncodeHw(c);
    const dec = await testDecodeHw(c);
    let sw = null;
    if (WITH_SW) sw = await testEncodeSw(c);
    rows.push({ codec: c.id, enc, dec, sw });
    log(`  [${c.id.padEnd(4)}] ENC(HW)=${verdict(enc.ok)}  DEC(HW)=${verdict(dec.ok)}` +
      (sw ? `  ENC(SW)=${verdict(sw.ok)}` : '') +
      `  :: enc: ${enc.detail} :: dec: ${dec.detail}` +
      (sw ? ` :: sw: ${sw.detail}` : ''));
  }
  return rows;
}

(async () => {
  log(`hwaccel-check start (node ${process.version}, soak=${SOAK_MIN}min, clip=${CLIP}s, src=${SRC})`);
  if (!fs.existsSync(SRC)) { log(`FATAL: source missing: ${SRC}`); process.exit(2); }
  const host = await probeHost();
  log(`host: ${host.os} | cpu: ${host.cpu}`);
  log(`gpu/dri: ${host.dri.length ? host.dri.join(',') : 'none'}` +
    (host.vaapiDriver ? ` | vaapi: ${host.vaapiDriver}` : host.vaapiError ? ` | vainfo ERR: ${host.vaapiError}` : ''));
  const encProfiles = (host.vaapiProfiles || []).filter((p) => /EncSlice/.test(p));
  log(`ffmpeg hwaccels: ${HWACCELS.join(',') || 'none'} | vaapi ENC profiles: ${encProfiles.join(',') || 'none'}`);
  log(`report: ${LOG}`);

  const tally = {};
  for (const c of CODECS) tally[c.id] = { encOk: 0, decOk: 0, n: 0 };
  const deadline = SOAK_MIN > 0 ? Date.now() + SOAK_MIN * 60 * 1000 : 0;
  let n = 0;
  do {
    n += 1;
    const rows = await oneSession(n);
    for (const r of rows) { tally[r.codec].n += 1; if (r.enc.ok) tally[r.codec].encOk += 1; if (r.dec.ok) tally[r.codec].decOk += 1; }
    log(`session #${n} summary: ${CODECS.map((c) => `${c.id}:enc=${tally[c.id].encOk}/${tally[c.id].n}`).join(' ')}`);
    if (SOAK_MIN > 0 && Date.now() >= deadline) break;
  } while (SOAK_MIN > 0);

  log('=== FINAL ===');
  let allHwOk = true;
  for (const c of CODECS) {
    const t = tally[c.id];
    const encVerdict = t.encOk === t.n && t.n > 0;
    const decVerdict = t.decOk === t.n && t.n > 0;
    if (!encVerdict) allHwOk = false;
    log(`  [${c.id.padEnd(4)}] HW-ENC ${verdict(encVerdict)} (${t.encOk}/${t.n} sessions)   HW-DEC ${verdict(decVerdict)} (${t.decOk}/${t.n} sessions)`);
  }
  log(`overall hardware acceleration: ${allHwOk ? 'OK — every codec encoded on hardware in all sessions' : 'MIXED — see NO rows above (expected e.g. VP8/VP9 on VAAPI decode-only silicon)'}`);
  log('hwaccel-check done');
  process.exit(0);
})().catch((e) => { log('FATAL: ' + (e.stack || e.message)); process.exit(1); });
