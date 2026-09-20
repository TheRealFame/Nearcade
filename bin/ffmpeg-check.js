#!/usr/bin/env node
/**
 * bin/ffmpeg-check.js — headless FFmpeg workflow verification + soak test.
 *
 *   node bin/ffmpeg-check.js                       # quick: probe chain + per-encoder
 *                                                  # capture test (Xvfb x11grab) + mp4 probe
 *   node bin/ffmpeg-check.js --portal              # same via the Wayland bridge
 *                                                  # (bridge --test source, no dialog)
 *   node bin/ffmpeg-check.js --soak-minutes 45     # soak at production settings
 *   node bin/ffmpeg-check.js --soak-minutes 45 --no-chaos --encoder software
 *
 * Fully headless: capture runs against Xvfb (:99), never the real display.
 * Exit 0 = pass, 1 = fail. Soak logs to logs/ffmpeg-soak-<ts>.log (gitignored).
 *
 * Housekeeping: killed test runs can orphan gst/ffmpeg children (SIGKILL
 * can't be caught; the bridge sets PDEATHSIG for new runs). If checks behave
 * oddly under load, clear strays first:
 *   pkill -f "videotestsrc pattern=ball"; pkill -f "rawvideo.*pipe:1"
 *
 * This exercises the REAL CaptureManager workflow (probe → launch gate →
 * watchdog), not a parallel reimplementation.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const cm = require('../src/sidecar/capture/CaptureManager');

// NOTE: /usr/local/bin/ffprobe on dev boxes may be a firejail symlink that
// cannot see real files — always use the system binary directly.
const FFPROBE = '/usr/bin/ffprobe';

const argv = process.argv.slice(2);
const opt = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);
const SOAK_MIN = parseFloat(opt('--soak-minutes', '0')) || 0;
const CHAOS = SOAK_MIN > 0 && !has('--no-chaos');
const FORCE_ENC = (opt('--encoder', '') || '').toLowerCase();
const DISPLAY_NUM = opt('--display', ':99');
// --portal: exercise the Wayland bridge (ffmpeg-portal method). Headless runs
// use the bridge's own --test source (videotestsrc, no portal dialog).
const PORTAL = has('--portal');
const METHOD = PORTAL ? 'ffmpeg-portal' : 'ffmpeg';
if (FORCE_ENC) process.env.NEARCADE_FFMPEG_ENCODER = FORCE_ENC;
if (PORTAL) process.env.NEARCADE_PORTAL_TEST = '1';
let activeXvfb = null;

let failures = [];
const ok = (name) => console.log(`   [ok] ${name}`);
const bad = (name, why) => { failures.push(name); console.log(`   [FAIL] ${name} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFrames(minFrames, timeoutMs) {
    // Flow proof is frames OR output bytes: ffmpeg stats lines (\r-timed)
    // are unreliable through multi-hop pipes, while byte growth is ground
    // truth for end-to-end flow (capture→encode→mux).
    const t0 = Date.now();
    for (;;) {
        const st = cm._ffmpegStats;
        if (st && (st.frames >= minFrames || (st.bytes || 0) > 100000)) return st;
        if (Date.now() - t0 > timeoutMs) return st || null;
        await sleep(500);
    }
}

function startXvfb(display, geom = '960x540x24') {
    try {
        activeXvfb = spawn('Xvfb', [display, '-screen', '0', geom], { stdio: 'ignore' });
        return activeXvfb;
    } catch (_) { return null; }
}

async function fetchBytes(port, ms, outPath) {
    return new Promise((resolve) => {
        const f = fs.createWriteStream(outPath);
        let bytes = 0;
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
            res.on('data', (c) => { bytes += c.length; f.write(c); });
        });
        req.on('error', () => {});
        setTimeout(() => { try { req.destroy(); } catch (_) {} f.end(); resolve(bytes); }, ms);
    });
}

function ffprobeInfo(file) {
    try {
        const r = spawnSync(FFPROBE, ['-hide_banner', '-v', 'error',
            '-show_entries', 'stream=codec_name,width,height,avg_frame_rate',
            '-show_entries', 'format=duration', '-of', 'json', file],
            { encoding: 'utf8', timeout: 20000 });
        if (r.status !== 0) return null;
        return JSON.parse(r.stdout || '{}');
    } catch (_) { return null; }
}

function ffprobeKeyframes(file) {
    try {
        const r = spawnSync(FFPROBE, ['-hide_banner', '-v', 'error',
            '-select_streams', 'v:0', '-skip_frame', 'nokey',
            '-show_entries', 'frame=pkt_pts_time', '-of', 'csv', file],
            { encoding: 'utf8', timeout: 30000 });
        if (r.status !== 0) return -1;
        return (r.stdout.match(/^frame,/gm) || []).length;
    } catch (_) { return -1; }
}

async function quickMode() {
    console.log('\n Starting FFmpeg headless verification...\n');
    const ff = cm._resolveFFmpegBinary();
    console.log(`   Binary:  ${ff}`);
    const chain = cm._probeHwEncoders();
    console.log(`   Chain:   ${chain.join(' → ')}`);
    if (!chain.length) bad('probe-chain', 'empty chain');
    else if (chain[chain.length - 1] !== 'software') bad('probe-chain', 'software fallback missing');
    else ok(`probe-chain (${chain.length} candidates)`);

    // Headless capture display for the x11grab rounds. Portal --test mode
    // uses the bridge's own videotestsrc — no display needed.
    const srcTag = PORTAL ? 'portal-bridge(testsrc)' : 'x11grab→Xvfb';
    if (!PORTAL) {
        const xvfb = startXvfb(DISPLAY_NUM);
        if (!xvfb || xvfb.exitCode !== null) { bad('xvfb', `could not spawn Xvfb ${DISPLAY_NUM}`); return finish(); }
        process.env.DISPLAY = DISPLAY_NUM;
        await sleep(1500);
        if (xvfb.exitCode !== null) { bad('xvfb', `Xvfb ${DISPLAY_NUM} died on start (display in use?)`); return finish(); }
    }

    for (const enc of chain) {
        process.env.NEARCADE_FFMPEG_ENCODER = enc;
        cm._ffmpegProbeCache = null;
        let res;
        try {
            res = await cm.start(METHOD, { width: 640, height: 360, fps: 30, bitrate: 1000000 });
        } catch (e) { bad(`capture-${enc}`, `start threw: ${e.message}`); continue; }
        // Attach the relay window IMMEDIATELY (before waiting): moov arrives
        // once at stream start and drains otherwise — a late attach can never
        // yield a parseable file (see note below).
        const tmpA = `/tmp/ffmpeg-check-${enc}-a-${Date.now()}.mp4`;
        const tmpB = `/tmp/ffmpeg-check-${enc}-b-${Date.now()}.mp4`;
        const fetchAP = fetchBytes(res.port, 3000, tmpA);
        const st = await waitForFrames(60, 25000);
        if (!st || (st.frames < 60 && (st.bytes || 0) <= 100000)) {
            bad(`capture-${enc}`, `only ${st ? st.frames : 0} frames / ${st ? st.bytes || 0 : 0}B in 25s`);
        } else if (!PORTAL && Math.abs(st.fps - 30) > 9 && st.frames >= 60) {
            bad(`capture-${enc}`, `fps ${st.fps} too far from 30`);
        } else {
            ok(`capture-${enc} (${st.frames}f @ ${Math.round(st.fps || 0)}fps, ${Math.round((st.bytes || 0) / 1024)}KB via ${srcTag})`);
        }
        // Pull two consecutive windows of the fragmented-moov relay and probe
        // the container. Content is a static Xvfb screen (ABR → tiny), so the
        // assertion is FLOW (moov + continued growth) + valid h264 + keyframes,
        // not absolute bitrate.
        // NOTE: window A MUST start at stream start: moov arrives exactly once
        // (it drains to the null-drain otherwise), so a late attach can never
        // produce a parseable file. tmpB (mid-stream) only proves continued flow.
        const bytesA = await fetchAP;
        const bytesB = await fetchBytes(res.port, 3000, tmpB);
        if (bytesA < 4000 || bytesB < 2000) {
            bad(`mux-${enc}`, `no flow (windows: ${bytesA}B, ${bytesB}B)`);
        } else {
            // tmpB starts mid-stream (no moov) — concat for a parseable file.
            const tmpFull = `/tmp/ffmpeg-check-${enc}-full-${Date.now()}.mp4`;
            try {
                fs.writeFileSync(tmpFull, Buffer.concat([fs.readFileSync(tmpA), fs.readFileSync(tmpB)]));
            } catch (_) {}
            const info = ffprobeInfo(tmpFull);
            const vs = info && info.streams && info.streams.find((s) => s.codec_name);
            if (!vs || vs.codec_name !== 'h264') bad(`mux-${enc}`, `ffprobe: ${JSON.stringify(info && info.streams)}`);
            else {
                const kf = ffprobeKeyframes(tmpFull);
                ok(`mux-${enc} (h264 ${vs.width}x${vs.height}, ${kf >= 0 ? kf + ' keyframes' : 'keyframes n/a'}, flow ${bytesA}B→${bytesB}B)`);
            }
            try { fs.unlinkSync(tmpFull); } catch (_) {}
        }
        try { fs.unlinkSync(tmpA); fs.unlinkSync(tmpB); } catch (_) {}
        await cm.stop();
        await sleep(500);
    }
    try { if (typeof xvfb !== 'undefined' && xvfb) xvfb.kill('SIGKILL'); } catch (_) {}
    finish();
}

async function soakMode() {
    const totalMs = SOAK_MIN * 60 * 1000;
    const tag = new Date().toISOString().replace(/[:.]/g, '-');
    console.log(`\n Starting FFmpeg soak: ${SOAK_MIN}min @ 960x540/70fps/4Mbps` +
        `${FORCE_ENC ? ` (forced ${FORCE_ENC})` : ' (probed chain)'}` +
        `${CHAOS ? ' + chaos kill @ t+10min' : ''}\n`);
    const xvfb = startXvfb(DISPLAY_NUM, '960x540x24');
    if (!xvfb || xvfb.exitCode !== null) { bad('xvfb', `could not spawn Xvfb ${DISPLAY_NUM}`); return finish(); }
    process.env.DISPLAY = DISPLAY_NUM;
    await sleep(1500);
    if (xvfb.exitCode !== null) { bad('xvfb', `Xvfb ${DISPLAY_NUM} died on start (display in use?)`); return finish(); }

    const isHW = !FORCE_ENC || FORCE_ENC !== 'software';
    const fpsFloor = 70 * (isHW ? 0.9 : 0.7);
    let restarts = 0, chaosDone = false, chaosRecovered = false;
    let lastFrames = 0, lastChangeAt = Date.now(), unrecovered = false;
    let sumFps = 0, fpsSamples = 0;
    // Persistent relay drain: production ALWAYS has the hidden-video reader
    // attached. Without a reader, pipe:1 backpressures ffmpeg into a fake
    // "stall" (full stdout pipe). The drain keeps the soak end-to-end honest.
    let drainReq = null, drainBytes = 0;
    function attachDrain(port) {
        try { if (drainReq) drainReq.destroy(); } catch (_) {}
        drainReq = http.get(`http://127.0.0.1:${port}/`, (res) => {
            res.on('data', (c) => { drainBytes += c.length; });
            res.on('error', () => {});
        });
        drainReq.on('error', () => {});
    }
    const t0 = Date.now();

    async function restart(reason) {
        restarts++;
        console.log(`   [soak] restart #${restarts} (${reason})`);
        try { await cm.stop(); } catch (_) {}
        await sleep(1000);
        cm._ffmpegProbeCache = null; // re-probe: a demoted encoder stays demoted via _ffmpegBadEnc
        const res = await cm.start('ffmpeg', { width: 960, height: 540, fps: 70, bitrate: 4000000 });
        attachDrain(res.port);
        lastChangeAt = Date.now();
    }

    try {
        const res0 = await cm.start('ffmpeg', { width: 960, height: 540, fps: 70, bitrate: 4000000 });
        attachDrain(res0.port);
    } catch (e) { bad('soak-start', e.message); try { xvfb.kill('SIGKILL'); } catch (_) {} return finish(); }
    const encUsed = (cm._ffmpegStats && cm._ffmpegStats.encoder) || '?';
    console.log(`   [soak] live on ${encUsed}, watchdog armed`);

    let lastMinLog = -1;
    for (;;) {
        await sleep(1000);
        const el = Date.now() - t0;
        if (el >= totalMs) break;
        const st = cm._ffmpegStats;
        const frames = st ? st.frames : 0;
        if (frames > lastFrames) {
            lastFrames = frames; lastChangeAt = Date.now();
            if (st && st.fps) { sumFps += st.fps; fpsSamples++; }
            if (chaosDone && !chaosRecovered && restarts > 0) { chaosRecovered = true; console.log('   [soak] chaos recovery confirmed (frames flowing after kill)'); }
        }
        if (CHAOS && !chaosDone && el > 10 * 60 * 1000) {
            chaosDone = true;
            console.log('   [soak] CHAOS: SIGKILL to ffmpeg proc');
            try { if (cm._ffmpegProc) cm._ffmpegProc.kill('SIGKILL'); } catch (_) {}
        }
        const stalledFor = Date.now() - lastChangeAt;
        if ((st && (st.dead || st.stalled)) || stalledFor > 20000) {
            if (chaosDone && !chaosRecovered) { /* expected window, supervisor below still restarts */ }
            try { await restart(st && st.stalled ? 'watchdog stall flag' : st && st.dead ? 'proc dead' : `no frame progress ${Math.round(stalledFor / 1000)}s`); }
            catch (e) { unrecovered = true; bad('soak-restart', e.message); break; }
            lastFrames = 0;
        }
        const min = Math.floor(el / 60000);
        if (min !== lastMinLog) {
            lastMinLog = min;
            console.log(`   [soak] t+${min}min frames=${frames} fps=${st ? Math.round(st.fps || 0) : 0} restarts=${restarts} relay=${Math.round(drainBytes / 1024)}KB`);
        }
    }

    const avgFps = fpsSamples ? sumFps / fpsSamples : 0;
    const nonChaosRestarts = restarts - (chaosRecovered ? 1 : 0);
    console.log(`\n   [soak] done: frames=${lastFrames} avgFps=${avgFps.toFixed(1)} restarts=${restarts} (chaos: ${chaosRecovered}) relay=${Math.round(drainBytes / 1024)}KB`);
    if (unrecovered) bad('soak', 'unrecovered stall (see above)');
    else if (drainBytes < 1024 * 1024) bad('soak-relay', `only ${drainBytes}B through the relay — flow broke`);
    else if (avgFps < fpsFloor) bad('soak-fps', `avg ${avgFps.toFixed(1)}fps below floor ${fpsFloor}`);
    else if (!CHAOS && restarts > 2) bad('soak-stability', `${restarts} restarts with no chaos`);
    else if (CHAOS && !chaosRecovered) bad('soak-chaos', 'no recovery after chaos kill');
    else if (CHAOS && nonChaosRestarts > 2) bad('soak-stability', `${nonChaosRestarts} non-chaos restarts`);
    else ok(`soak ${SOAK_MIN}min (${lastFrames} frames, avg ${avgFps.toFixed(1)}fps, restarts: ${restarts})`);

    try { await cm.stop(); } catch (_) {}
    try { if (drainReq) drainReq.destroy(); } catch (_) {}
    try { xvfb.kill('SIGKILL'); } catch (_) {}
    finish();
}

function finish() {
    try { if (activeXvfb) activeXvfb.kill('SIGKILL'); } catch (_) {}
    if (failures.length) {
        console.log(`\n FFmpeg check FAILED (${failures.length}): ${failures.join(', ')}\n`);
        process.exit(1);
    }
    console.log('\n FFmpeg check PASSED\n');
    process.exit(0);
}

process.on('SIGTERM', async () => {
    try { await cm.stop(); } catch (_) {}
    try { if (activeXvfb) activeXvfb.kill('SIGKILL'); } catch (_) {}
    process.exit(143);
});
(SOAK_MIN > 0 ? soakMode() : quickMode()).catch((e) => { bad('harness', e.message); finish(); });
