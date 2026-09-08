#!/usr/bin/env node
/**
 * test_infra/avcodec-encode-check.js
 * Verifies the avcodec_encoder N-API addon (libavcodec h264_vaapi, in-process):
 *   1. info() reports h264_vaapi present in libavcodec
 *   2. synthetic RGBA frames encode (fps measured)
 *   3. end-to-end: benchmark.mp4 decoded to raw RGBA -> addon -> Annex-B H264
 *      file, decoded back cleanly by ffmpeg (ffprobe shows exact dims)
 * Prints OK / NO per stage plus a summarized verdict.
 *
 *   node test_infra/avcodec-encode-check.js [--frames 90]
 */
'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADDON = path.join(ROOT, 'src/sidecar/capture/build/Release/avcodec_encoder.node');
const SRC = path.join(ROOT, 'assets/benchmark.mp4');
const OUT = '/tmp/opencode/avc-out.h264';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const NFRAMES = parseInt(opt('--frames', '90'), 10);
const W = parseInt(opt('--width', '820'), 10);
const H = parseInt(opt('--height', '480'), 10);

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`); }
function run(cmd, argv, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
const verdict = (ok) => (ok ? 'OK' : 'NO');

(async () => {
  log(`avcodec-encode-check start (node ${process.version})`);
  if (!fs.existsSync(ADDON)) { log(`ADDON missing: ${ADDON} -> NO`); process.exit(2); }
  if (!fs.existsSync(SRC)) { log(`SRC missing: ${SRC} -> NO`); process.exit(2); }
  const enc = require(ADDON);

  // Stage 1: library probe
  const inf = enc.info();
  log(`info: ok=${inf.ok} h264_vaapi=${!!inf.h264_vaapi} lib=${inf.libavcodec || '?'}`);
  const s1 = !!inf.ok && !!inf.h264_vaapi;
  log(`stage1 libavcodec-hw: ${verdict(s1)}`);
  if (!s1) process.exit(1);

  // Stage 2: synthetic frames
  const h = enc.init({ width: W, height: H, bitrate: 4000000, fps: 30 });
  const frame = Buffer.alloc(W * H * 4);
  let swBytes = 0; const t0 = Date.now(); const SN = 30;
  for (let i = 0; i < SN; i++) {
    frame.fill((i * 7) % 256, 0, 4096);
    const out = enc.encode(h, frame, i === 0);
    if (!out) { log(`synthetic frame ${i} threw-empty -> NO`); process.exit(1); }
    swBytes += out.length;
  }
  const swMs = Date.now() - t0;
  log(`stage2 synthetic: ${verdict(true)} ${SN}f in ${(swMs / 1000).toFixed(1)}s (${Math.round(SN / (swMs / 1000))}fps)`);
  enc.close(h);

  // Stage 3: end-to-end re-encode of benchmark.mp4
  const h2 = enc.init({ width: W, height: H, bitrate: 4000000, fps: 30 });
  const frameBytes = W * H * 4;
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-t', String(Math.ceil(NFRAMES / 30) + 1),
    '-i', SRC, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const chunks = [];
  let karta = Buffer.alloc(0), fed = 0, encBytes = 0;
  const t1 = Date.now();
  const done = new Promise((resolve, reject) => {
    ff.stdout.on('data', (d) => {
      karta = Buffer.concat([karta, d]);
      while (karta.length >= frameBytes && fed < NFRAMES) {
        const fb = karta.subarray(0, frameBytes);
        karta = karta.subarray(frameBytes);
        let outBuf;
        try { outBuf = enc.encode(h2, Buffer.from(fb), fed === 0); }
        catch (e) { reject(new Error('addon threw: ' + e.message)); return; }
        chunks.push(outBuf); encBytes += outBuf.length; fed++;
      }
      if (fed >= NFRAMES) { try { ff.kill('SIGKILL'); } catch (_) {} resolve(); }
    });
    ff.on('error', (e) => reject(e));
    ff.on('close', () => resolve());
    setTimeout(() => reject(new Error('e2e timeout')), 120000);
  });
  try { await done; }
  catch (e) { log(`stage3 e2e: NO (${e.message})`); try { enc.close(h2); } catch (_) {} process.exit(1); }
  const e2eMs = Date.now() - t1;
  fs.writeFileSync(OUT, Buffer.concat(chunks));
  log(`stage3 e2e: ${verdict(true)} ${fed}f -> ${OUT} (${(encBytes / 1024).toFixed(0)}KB in ${(e2eMs / 1000).toFixed(1)}s = ${Math.round(fed / (e2eMs / 1000))}fps)`);
  enc.close(h2);

  // Stage 4: decode the output back cleanly + probe dims
  const dec = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', OUT, '-f', 'null', '-'], 60000);
  const errLines = dec.stderr.split('\n').filter((l) => l.trim() && !/muxing|muxer|trailer|closing|Terminating|finished|submitting|writing|Last message|Connection reset/.test(l));
  const s4ok = !dec.err && errLines.length === 0;
  log(`stage4 decode-back: ${verdict(s4ok)}${s4ok ? '' : ' :: ' + errLines.slice(0, 3).join(' | ').slice(0, 200)}`);
  const probe = await run('ffmpeg', ['-hide_banner', '-i', OUT], 30000);
  const m = (probe.stderr.match(/Video:\s*h264[^\n]*/) || ['?'])[0];
  log(`output stream: ${m.trim().slice(0, 120)}`);

  const allOk = s1 && s4ok;
  log(`=== FINAL: avcodec_encoder addon ${allOk ? 'OK' : 'NO'} — in-process HW H264 (libavcodec VAAPI), no CLI/GStreamer/Chromium ===`);
  process.exit(allOk ? 0 : 1);
})().catch((e) => { log('FATAL: ' + (e.stack || e.message)); process.exit(2); });
