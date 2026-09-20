/**
 * src/sidecar/CaptureManager.js
 * Unified Orchestrator for all Capture Methods.
 */
'use strict';

const { spawn, execSync, spawnSync } = require('child_process');
const os = require('os');
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { Socket } = require('dgram');
const WiVRnIntegration = require('./wivrn-integration');

class CaptureManager {
    constructor() {
        this._activeMethod = null;

        // FFmpeg specific state
        this._ffmpegProc = null;
        this._ffmpegServer = null;
        this._ffmpegPort = null;
        this._ffmpegStreamRes = null;
        this._ffmpegEncoder = null;

        // GStreamer WebRTC specific state
        this._gstProc = null;
        this._gstSignalingCallback = null;

        // PipeWire specific state
        this._pipewireProc = null;
        this._pipewireServer = null;
        this._pipewirePort = null;
        this._pipewireStreamRes = null;
        this._pipewireNodeName = null;

        // WiVRn specific state
        this._wivrnProc = null;
        this._wivrnServer = null;
        this._wivrnPort = null;
        this._wivrnStreamRes = null;
        this._wivrnIntegration = WiVRnIntegration;
    }

    /**
     * @param {string} method - 'ffmpeg', 'webcodecs', 'webrtc', 'pipewire', or 'wivrn'
     * @param {object} options - Resolution, FPS, Bitrate, etc.
     */
    async start(method, options = {}) {
        if (this._activeMethod) {
            await this.stop();
        }

        console.log(`[CaptureManager] Arming capture pipeline: ${method.toUpperCase()}`);
        this._activeMethod = method;

        switch (method) {
            case 'ffmpeg':
                return await this._startFFmpeg(options);
            case 'sidecapture':
                return await this._startSidecapture(options);
            case 'ffmpeg-portal':
                return await this._startPortalBridge(options);
            case 'pipewire':
                return await this._startPipeWire(options);
            case 'wivrn':
                return await this._startWiVRn(options);
            case 'webcodecs':
                return { ok: true, message: 'WebCodecs armed on backend. Waiting for frontend execution.' };
            case 'windows_dxgi':
                return await this._startWindowsDXGI(options);
            case 'gstreamer_webrtc':
                return await this._startGstWebRTC(options);
            case 'webrtc':
                return { ok: true, message: 'Native WebRTC armed on backend.' };
            default:
                this._activeMethod = null;
                throw new Error(`[CaptureManager] Unknown capture method requested: ${method}`);
        }
    }

    async stop() {
        console.log(`[CaptureManager] Disarming pipeline: ${this._activeMethod || 'None'}`);

        if (this._activeMethod === 'ffmpeg') {
            this._stopFFmpeg();
        } else if (this._activeMethod === 'ffmpeg-portal') {
            this._stopFFmpeg(); // shares all _ffmpeg* state (bridge proc + relay)
        } else if (this._activeMethod === 'pipewire') {
            this._stopPipeWire();
        } else if (this._activeMethod === 'wivrn') {
            this._stopWiVRn();
        } else if (this._activeMethod === 'windows_dxgi') {
            this._stopWindowsDXGI();
        } else if (this._activeMethod === 'gstreamer_webrtc') {
            await this._stopGstWebRTC();
        }

        this._activeMethod = null;
        return { ok: true };
    }

    getStatus() {
        return {
            active: this._activeMethod !== null,
            method: this._activeMethod,
            details: this._activeMethod === 'ffmpeg' ? `FFmpeg via ${this._ffmpegEncoder || '?'}${this._ffmpegStats ? ` · ${this._ffmpegStats.frames}f @ ${Math.round(this._ffmpegStats.fps || 0)}fps · ${this._ffmpegStats.restarts} restarts` : ''}${this._ffmpegWarning ? ' · WAYLAND (x11grab blind to native apps)' : ''}` :
                     this._activeMethod === 'ffmpeg-portal' ? `Portal via ${this._ffmpegEncoder || '?'}${this._ffmpegStats ? ` · ${this._ffmpegStats.frames}f @ ${Math.round(this._ffmpegStats.fps || 0)}fps · ${this._ffmpegStats.restarts} restarts` : ''}` :
                     this._activeMethod === 'pipewire' ? `PipeWire node: ${this._pipewireNodeName || 'auto'}` :
                     this._activeMethod === 'wivrn' ? `WiVRn stream: ${this._wivrnPort || 'not started'}` :
                     this._activeMethod === 'windows_dxgi' ? `Windows DXGI Desktop Duplication (Port: ${this._ffmpegPort || '...'})` :
                     this._activeMethod === 'gstreamer_webrtc' ? 'Native C++ GStreamer WebRTC' :
                     'Frontend Execution'
        };
    }

    // ------ Windows DXGI (Zero-Copy) Implementation ---------------------------------------------------------------------------------------

    async _startWindowsDXGI({ width = 1920, height = 1080, fps = 60, bitrate = 15000000, sourceId = null, sourceName = null } = {}) {
        if (os.platform() !== 'win32') {
            throw new Error('Windows DXGI capture only supports Windows.');
        }

        console.log(`[CaptureManager] Starting DXGI zero-copy capture...`);
        if (sourceId && sourceId.startsWith('window:')) {
            console.warn(`[CaptureManager] WARNING: App window capture requested ("${sourceName || sourceId}") but DXGI (ddagrab) currently only supports full desktop capture. This will capture the whole desktop instead, or fail.`);
        } else if (sourceId) {
            console.log(`[CaptureManager] Capture target: ${sourceName || sourceId}`);
        }

        // Use FFmpeg's ddagrab (Desktop Duplication API) for zero-copy VRAM capture
        const args = [
            '-hide_banner',
            '-loglevel', 'info',    // Verbose logging for testing
            '-f', 'ddagrab',
            '-framerate', String(fps),
            '-video_size', `${width}x${height}`,
            '-hwaccel', 'auto',     // Keep it in VRAM
            '-i', 'desktop',
            '-c:v', 'h264_nvenc',   // Force hardware encoding
            '-preset', 'p1',        // Ultra fast preset
            '-tune', 'll',          // Low latency tuning
            '-b:v', `${Math.round(bitrate / 1000)}k`,
            '-g', String(fps * 2),  // Keyframe interval
            '-cq', '20',
            '-f', 'mp4',
            '-movflags', 'empty_moov+default_base_moof+frag_keyframe+skip_sidx',
            'pipe:1'
        ];

        // We reuse the FFmpeg state variables since it's an FFmpeg process
        console.log(`[CaptureManager] DXGI Command: ffmpeg ${args.join(' ')}`);
        this._ffmpegProc = spawn('ffmpeg', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        // Capture logs reliably for the Windows testers
        this._ffmpegProc.stderr.on('data', (d) => {
            const logLine = d.toString().trim();
            if (logLine) console.log(`[DXGI-FFMPEG] ${logLine}`);
        });

        this._ffmpegServer = http.createServer((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
            });
            this._ffmpegStreamRes = res;
            if (this._ffmpegProc && this._ffmpegProc.stdout) {
                this._ffmpegProc.stdout.pipe(res);
            }
        });

        await new Promise((resolve) => {
            this._ffmpegServer.listen(0, '127.0.0.1', () => {
                this._ffmpegPort = this._ffmpegServer.address().port;
                resolve();
            });
        });

        this._ffmpegProc.on('error', (err) => {
            console.error('[CaptureManager] DXGI FFmpeg error:', err.message);
            this._stopWindowsDXGI();
        });

        this._ffmpegProc.on('close', (code) => {
            console.log(`[CaptureManager] DXGI FFmpeg exited with code ${code}`);
            this._stopWindowsDXGI();
        });

        console.log(`[CaptureManager] DXGI Capture active. Stream available on local port ${this._ffmpegPort}`);
        return { ok: true, streamPort: this._ffmpegPort, method: 'windows_dxgi' };
    }

    _stopWindowsDXGI() {
        if (this._ffmpegStreamRes) {
            this._ffmpegStreamRes.end();
            this._ffmpegStreamRes = null;
        }
                if (this._sidecaptureProc) {
            try { this._sidecaptureProc.kill('SIGKILL'); } catch (_) {}
            this._sidecaptureProc = null;
        }
        if (this._ffmpegProc) {
            this._ffmpegProc.kill('SIGKILL');
            this._ffmpegProc = null;
        }
        if (this._ffmpegServer) {
            this._ffmpegServer.close();
            this._ffmpegServer = null;
        }
        this._ffmpegPort = null;
    }

    // ------ PipeWire Implementation (Gamescope/SteamVR) ---------------------------------------------------------------------------------

    async _startPipeWire({ width = 1920, height = 1080, fps = 90, bitrate = 15000000, display = null } = {}) {
        if (os.platform() !== 'linux') {
            throw new Error('PipeWire capture only supports Linux.');
        }

        const captureDisplay = display || process.env.DISPLAY || ':1'; // Default to Gamescope's display
        
        console.log(`[CaptureManager] Starting X11 capture on display ${captureDisplay}`);

        const encoder = this._detectFFmpegEncoder();
        console.log(`[CaptureManager] Using encoder: ${encoder}`);

        // Build FFmpeg arguments for X11 grabbing
        let args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-f', 'x11grab',
            '-framerate', String(fps),
            '-video_size', `${width}x${height}`,
            '-i', captureDisplay
        ];

        // Add encoding options
        if (encoder === 'vaapi') {
            args.push(
                '-vf', 'format=nv12,hwupload',
                '-vaapi_device', this._detectVaapiDevice(),
                '-c:v', 'h264_vaapi',
                '-profile:v', 'high',
                '-level', '4.2',
                '-b:v', `${Math.round(bitrate / 1000)}k`,
                '-bf', '0',
                '-g', String(fps * 2),
                '-tune', 'zerolatency'
            );
        } else if (encoder === 'nvenc') {
            args.push(
                '-c:v', 'h264_nvenc',
                '-preset', 'p1',
                '-tune', 'll',
                '-b:v', `${Math.round(bitrate / 1000)}k`,
                '-g', String(fps * 2),
                '-cq', '20'
            );
        } else {
            args.push(
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-b:v', `${Math.round(bitrate / 1000)}k`,
                '-bf', '0',
                '-g', String(fps * 2)
            );
        }

        // Output format
        args.push(
            '-f', 'mp4',
            '-movflags', 'empty_moov+default_base_moof+frag_keyframe+skip_sidx',
            'pipe:1'
        );

        // Start FFmpeg
        this._pipewireProc = spawn('ffmpeg', args, {
            stdio: ['ignore', 'pipe', 'inherit']
        });

        // Create HTTP server for the stream
        this._pipewireServer = http.createServer((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
            });
            this._pipewireStreamRes = res;
            if (this._pipewireProc && this._pipewireProc.stdout) {
                this._pipewireProc.stdout.pipe(res);
            }
        });

        await new Promise((resolve) => {
            this._pipewireServer.listen(0, '127.0.0.1', () => {
                this._pipewirePort = this._pipewireServer.address().port;
                resolve();
            });
        });

        this._pipewireProc.on('error', (err) => {
            console.error('[CaptureManager] FFmpeg error:', err.message);
            this._stopPipeWire();
        });

        this._pipewireProc.on('close', (code) => {
            console.log(`[CaptureManager] FFmpeg exited with code ${code}`);
            this._activeMethod = null;
        });

        this._pipewireNodeName = `X11:${captureDisplay}`;

        return {
            ok: true,
            message: `X11 capture active on ${captureDisplay}`,
            port: this._pipewirePort,
            url: `http://127.0.0.1:${this._pipewirePort}/stream`,
            encoder: encoder
        };
    }

    _stopPipeWire() {
        if (this._pipewireProc) {
            try {
                this._pipewireProc.kill('SIGTERM');
                setTimeout(() => {
                    if (this._pipewireProc && !this._pipewireProc.killed) {
                        this._pipewireProc.kill('SIGKILL');
                    }
                }, 2000);
            } catch (_) {}
            this._pipewireProc = null;
        }
        if (this._pipewireStreamRes) {
            try { this._pipewireStreamRes.end(); } catch (_) {}
            this._pipewireStreamRes = null;
        }
        if (this._pipewireServer) {
            try { this._pipewireServer.close(); } catch (_) {}
            this._pipewireServer = null;
        }
        this._pipewirePort = null;
        this._pipewireNodeName = null;
    }

    // ------ FFmpeg Implementation (deterministic HW encode) ------
    // Design notes (Sep 2026 — the "encode everywhere" decision):
    //  - The encoder chain is PROBED, not assumed. `ffmpeg -encoders`
    //    listing h264_vaapi means nothing if /dev/dri is missing or the
    //    driver rejects us — every candidate must survive a real test encode.
    //  - Order: nvenc (NVIDIA device present) → vaapi (render node works)
    //    → software (libx264, always available). Override the whole chain
    //    with NEARCADE_FFMPEG_ENCODER=nvenc|vaapi|software (testers, CI).
    //  - Binary resolution: bundled static sidecar first
    //    (resources/ffmpeg — the Tauri packaging target), then
    //    NEARCADE_FFMPEG_BIN, then PATH.
    //  - Launch-health gate + frame-progress watchdog: a spawned ffmpeg
    //    that never emits frames fails the start (pre-launch) or gets
    //    killed and flagged (post-launch) — never "Running" while wedged.
    //    Post-launch supervision (restart after start() returned) belongs
    //    to the caller: see bin/ffmpeg-check.js --soak for the pattern
    //    host.js health polling should adopt.

    _resolveFFmpegBinary() {
        try {
            let base = __dirname;
            if (base.includes('app.asar')) base = base.replace('app.asar', 'app.asar.unpacked');
            const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
            const cands = [
                path.join(base, '..', '..', 'resources', name),
                path.join(base, 'bin', name),
            ];
            for (const c of cands) {
                try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
            }
        } catch (_) {}
        return process.env.NEARCADE_FFMPEG_BIN || 'ffmpeg';
    }

    _probeHwEncoders() {
        if (this._ffmpegProbeCache) return this._ffmpegProbeCache;
        const forced = (process.env.NEARCADE_FFMPEG_ENCODER || '').trim().toLowerCase();
        if (forced) {
            this._ffmpegProbeCache = [forced];
            return this._ffmpegProbeCache;
        }
        const ff = this._resolveFFmpegBinary();
        const chain = [];
        let hasNvidia = false;
        try { hasNvidia = fs.existsSync('/dev/nvidia0'); } catch (_) {}
        if (!hasNvidia) {
            try { hasNvidia = /nvidia/i.test(execSync('lspci 2>/dev/null', { encoding: 'utf8' })); } catch (_) {}
        }
        const cands = [];
        if (hasNvidia) cands.push('nvenc');
        cands.push('vaapi');
        for (const c of cands) {
            if (this._testEncode(ff, c)) chain.push(c);
            else console.warn(`[CaptureManager] FFmpeg probe: ${c} advertised but test encode failed — skipped`);
        }
        chain.push('software'); // libx264 is the unconditional fallback
        this._ffmpegProbeCache = chain;
        console.log(`[CaptureManager] FFmpeg encoder chain: ${chain.join(' → ')} (binary: ${ff})`);
        return chain;
    }

    _testEncode(ff, enc) {
        const args = this._buildFFmpegArgs(enc, {
            width: 640, height: 360, fps: 30, bitrate: 1000000, test: true, loglevel: 'error',
        });
        try {
            const r = spawnSync(ff, args, { timeout: 25000, stdio: ['ignore', 'ignore', 'pipe'] });
            return r.status === 0;
        } catch (_) { return false; }
    }

    _buildFFmpegArgs(enc, { width, height, fps, bitrate, display, test, loglevel } = {}) {
        const kb = Math.round((bitrate || 4000000) / 1000);
        // 1s GOP: MSE live-edge + join latency track the keyframe interval,
        // and 2s was the dominant term in glass-to-glass delay. One extra
        // IDR/sec costs ~10-15% of the budget — worth it.
        const g = Math.max(1, (fps || 60));
        const args = ['-hide_banner', '-loglevel', loglevel || 'info'];
        if (test) {
            args.push('-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`);
        } else {
            args.push('-f', 'x11grab', '-framerate', String(fps),
                '-video_size', `${width}x${height}`,
                '-i', display || process.env.DISPLAY || ':0');
        }
        if (enc === 'vaapi') {
            args.push('-vf', 'format=nv12,hwupload',
                '-vaapi_device', this._detectVaapiDevice(),
                '-c:v', 'h264_vaapi', '-profile:v', 'high', '-level', '4.2',
                '-b:v', `${kb}k`, '-bf', '0', '-g', String(g));
            // NOTE: profile/level are pinned to match the frontend MSE codec
            // string 'video/mp4; codecs="avc1.64002a"' in startSidecarCapture
            // (host.js). A mismatch risks black-screen (init segment rejected).
            // 4.2 covers up to 1080p60; beyond that the MSE string must change too.
        } else if (enc === 'nvenc') {
            args.push('-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll',
                '-b:v', `${kb}k`, '-bf', '0', '-g', String(g), '-cq', '20');
        } else {
            args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
                '-b:v', `${kb}k`, '-bf', '0', '-g', String(g));
        }
        if (test) args.push('-frames:v', '90', '-f', 'null', '-');
        else args.push('-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_keyframe+skip_sidx', 'pipe:1');
        return args;
    }

    // Permanent null-drain: ffmpeg blocks on a full stdout pipe, so an
    // unread relay wedges the encoder BEFORE the first progress line (high-
    // motion content fills 64KB pre-first-flush). The drain keeps the pipe
    // empty; the HTTP relay (attached below) receives a full copy in parallel.
    // Without this, any gap in relay readership silently stalls encoding.
    // The drain ALSO counts bytes: ffmpeg stats lines (\r-terminated, timing-
    // dependent) proved unreliable as the sole progress signal, while output
    // byte growth is ground truth for end-to-end flow (capture→encode→mux).
    // AND it retains the init segment (up to first moof/mdat, 256KB cap):
    // moov arrives exactly once at stream start, so a reader attaching late
    // (after launch) would otherwise get fragments it can never parse.
    _armNullDrain(proc) {
        this._ffmpegBytes = 0;
        this._ffmpegInitBuf = Buffer.alloc(0);
        this._ffmpegInitDone = false;
        this._ffmpegNullDrainFn = this._ffmpegNullDrainFn || ((c) => {
            if (!c || !c.length) return;
            this._ffmpegBytes = (this._ffmpegBytes || 0) + c.length;
            if (!this._ffmpegInitDone) {
                const kept = Buffer.concat([this._ffmpegInitBuf, c]).slice(0, 262144);
                this._ffmpegInitBuf = kept;
                // Walk boxes: [u32 size][4cc type]...; init ends at first moof/mdat.
                let pos = 0, end = -1;
                while (pos + 8 <= kept.length) {
                    const size = kept.readUInt32BE(pos);
                    const type = kept.toString('ascii', pos + 4, pos + 8);
                    if (type === 'moof' || type === 'mdat') { end = pos; break; }
                    if (!Number.isFinite(size) || size < 8) break;
                    if (pos + size > kept.length) break; // need more data
                    pos += size;
                }
                if (end > 0) {
                    this._ffmpegInitBuf = kept.slice(0, end);
                    this._ffmpegInitDone = true;
                } else if (kept.length >= 262144) {
                    this._ffmpegInitDone = true; // give up: atypical init, don't grow forever
                    this._ffmpegInitBuf = Buffer.alloc(0);
                }
            }
        });
        proc.stdout.on('data', this._ffmpegNullDrainFn);
    }

    _pipeRelay(proc) {
        if (!proc || !proc.stdout || !this._ffmpegStreamRes) return;
        // NOTE: the counting null-drain stays attached (it also feeds the
        // byte watchdog). Each relay reader gets its OWN data listener —
        // NEVER proc.stdout.pipe(res): pipe() pauses the SHARED source when
        // any single reader is slow, stalling encoding for everyone. A slow
        // reader is dropped instead (correct live-edge semantics: it freezes,
        // the stream doesn't).
        const res = this._ffmpegStreamRes;
        const onData = (chunk) => {
            let ok = true;
            try { ok = res.write(chunk); } catch (_) { ok = false; }
            if (!ok) {
                try { proc.stdout.removeListener('data', onData); } catch (_) {}
                try { res.end(); } catch (_) {}
            }
        };
        try {
            if (this._ffmpegInitBuf && this._ffmpegInitBuf.length) res.write(this._ffmpegInitBuf);
            proc.stdout.on('data', onData);
        } catch (_) {}
        // Dead sockets must not accumulate.
        res.on('close', () => {
            try { proc.stdout.removeListener('data', onData); } catch (_) {}
        });
    }

    async _ensureFFmpegServer() {
        if (this._ffmpegServer) return;
        this._ffmpegServer = http.createServer((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
            });
            this._ffmpegStreamRes = res;
            if (this._ffmpegProc && this._ffmpegProc.stdout) this._pipeRelay(this._ffmpegProc);
        });
        await new Promise((resolve) => {
            this._ffmpegServer.listen(0, '127.0.0.1', () => {
                this._ffmpegPort = this._ffmpegServer.address().port;
                resolve();
            });
        });
    }

    _detectDisplayServer() {
        const sess = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
        if (sess === 'wayland') return 'wayland';
        if (sess === 'x11') return 'x11';
        if (process.env.WAYLAND_DISPLAY) return 'wayland';
        if (process.env.DISPLAY) return 'x11';
        return 'unknown';
    }

    // Production defaults mirror the user config (540p, 70fps, 4Mbps H264).
    async _startFFmpeg({ width = 960, height = 540, fps = 70, bitrate = 4000000 } = {}) {
        if (os.platform() !== 'linux') throw new Error('FFmpeg capture only supports Linux (Windows uses windows_dxgi).');
        const displayServer = this._detectDisplayServer();
        let waylandWarning = null;
        if (displayServer === 'wayland') {
            // x11grab only sees XWayland (black root + cursor for native
            // Wayland apps) — kmsgrab needs DRM master (compositor holds it),
            // so there is no silent-correct ffmpeg capture on Wayland. LOUD
            // warning instead of a black stream nobody can diagnose. Wayland
            // users want the portal pipeline (gstreamer_webrtc) or an X11
            // session for x11grab.
            waylandWarning = 'Wayland session: x11grab captures only XWayland windows (native apps show BLACK). ' +
                'For full-desktop Wayland capture use the portal pipeline (gstreamer_webrtc) or log into an X11 session.';
            console.error(`[CaptureManager] FFmpeg WARNING: ${waylandWarning}`);
        }
        await this._ensureFFmpegServer();
        const display = process.env.DISPLAY || ':0';
        const chain = this._probeHwEncoders();
        let lastErr = null;
        for (const enc of chain) {
            this._ffmpegEncoder = enc;
            try {
                await this._attemptFFmpegEncoder(enc, { width, height, fps, bitrate, display });
                console.log(`[CaptureManager] FFmpeg live on ${enc} (${width}x${height}@${fps}, ${Math.round(bitrate / 1000)}k)`);
                const msg = `FFmpeg running on ${enc}` + (waylandWarning ? ` — ${waylandWarning}` : '');
                this._ffmpegWarning = waylandWarning;
                return { ok: true, message: msg, port: this._ffmpegPort, encoder: enc, displayServer, warning: waylandWarning };
            } catch (e) {
                lastErr = e;
                console.warn(`[CaptureManager] FFmpeg ${enc} unusable: ${e.message}`);
            }
        }
        this._ffmpegEncoder = null;
        throw lastErr || new Error('[CaptureManager] No working FFmpeg encoder found');
    }

    _attemptFFmpegEncoder(enc, { width, height, fps, bitrate, display }) {
        return new Promise((resolve, reject) => {
            const ff = this._resolveFFmpegBinary();
            const args = this._buildFFmpegArgs(enc, { width, height, fps, bitrate, display });
            console.log(`[CaptureManager] FFmpeg trying ${enc}: ${ff} ${args.join(' ')}`);
            const proc = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            this._ffmpegProc = proc;
            if (proc.stdout) this._armNullDrain(proc);
            this._pipeRelay(proc);
            const LAUNCH_MS = 15000, STALL_MS = 10000;
            const LAUNCH_BYTES = 8192; // moov + first fragments: end-to-end proof
            let errTail = '';
            let firstFrameAt = 0, lastProgressAt = Date.now(), lastBytes = 0;
            this._ffmpegBytes = 0;
            let settled = false;
            const stats = {
                encoder: enc, frames: 0, fps: 0,
                restarts: (this._ffmpegStats && this._ffmpegStats.restarts) || 0,
                startedAt: Date.now(), stalled: false, dead: false,
            };
            this._ffmpegStats = stats;
            const kill = () => { try { proc.kill('SIGKILL'); } catch (_) {} this._ffmpegProc = null; };
            const wd = setInterval(() => {
                const now = Date.now();
                const bytesNow = this._ffmpegBytes || 0;
                if (bytesNow > lastBytes) { lastBytes = bytesNow; lastProgressAt = now; }
                stats.bytes = bytesNow;
                if (!settled) {
                    if (proc.exitCode !== null && proc.exitCode !== undefined) {
                        clearInterval(wd);
                        settled = true; kill();
                        reject(new Error(`exited code ${proc.exitCode}: ${errTail.split('\n').filter(Boolean).pop() || 'no output'}`));
                    } else if (!firstFrameAt && bytesNow > LAUNCH_BYTES) {
                        // Byte gate: output flowing end-to-end even when stats
                        // lines are absent (loglevel/\r quirks). Frames gate below.
                        firstFrameAt = now;
                        settled = true;
                        resolve(stats);
                    } else if (!firstFrameAt && now - lastProgressAt > LAUNCH_MS) {
                        clearInterval(wd);
                        settled = true; kill();
                        reject(new Error(`no frames in ${LAUNCH_MS}ms`));
                    }
                } else if (!stats.stalled && !stats.dead && now - lastProgressAt > STALL_MS) {
                    // Post-launch stall: kill, flag for the supervisor, and
                    // demote the encoder after 2 consecutive stalls so the
                    // next start() walks the chain down (HW → SW).
                    stats.stalled = true;
                    kill();
                    const n = (this._ffmpegBadEnc[enc] = (this._ffmpegBadEnc[enc] || 0) + 1);
                    if (n >= 2 && this._ffmpegProbeCache) {
                        this._ffmpegProbeCache = this._ffmpegProbeCache.filter((e) => e !== enc);
                        console.error(`[CaptureManager] FFmpeg ${enc} stalled ${n}x — demoted, chain now: ${this._ffmpegProbeCache.join(' → ')}`);
                    } else {
                        console.error(`[CaptureManager] FFmpeg ${enc} STALLED (no frames for ${STALL_MS}ms) — killed, supervisor should restart`);
                    }
                }
            }, 2000);
            this._ffmpegBadEnc = this._ffmpegBadEnc || {};
            proc.stderr.on('data', (d) => {
                const s = d.toString();
                errTail = (errTail + s).slice(-2000);
                const m = s.match(/frame=\s*(\d+)\s+fps=\s*([\d.]+)/);
                if (m) {
                    stats.frames = parseInt(m[1], 10);
                    stats.fps = parseFloat(m[2]);
                    const now = Date.now();
                    lastProgressAt = now;
                    if (!firstFrameAt) {
                        firstFrameAt = now;
                        settled = true; // launch gate passed — proc keeps running, watchdog keeps watching
                        resolve(stats);
                    }
                    // A clean minute of output forgives earlier transient stalls.
                    if (now - stats.startedAt > 60000) this._ffmpegBadEnc[enc] = 0;
                } else {
                    const line = s.trim().split('\n').filter(Boolean).pop();
                    if (line && /error|failed|invalid|cannot|no such|denied|not found/i.test(line)) {
                        console.warn(`[FFmpeg:${enc}] ${line.slice(0, 220)}`);
                    }
                }
            });
            proc.on('error', (e) => {
                if (!settled) { clearInterval(wd); settled = true; kill(); reject(e); }
                else stats.dead = true;
            });
            proc.on('close', (code) => {
                if (!settled) {
                    clearInterval(wd);
                    settled = true; this._ffmpegProc = null;
                    reject(new Error(`exited code ${code}: ${errTail.split('\n').filter(Boolean).pop() || 'no output'}`));
                } else if (!stats.stalled) {
                    stats.dead = true;
                    console.warn(`[CaptureManager] FFmpeg ${enc} proc closed (code ${code}) after launch — supervisor should restart`);
                }
            });
        });
    }

    _stopFFmpeg() {
                if (this._sidecaptureProc) {
            try { this._sidecaptureProc.kill('SIGKILL'); } catch (_) {}
            this._sidecaptureProc = null;
        }
        if (this._ffmpegProc) {
            const p = this._ffmpegProc;
            this._ffmpegProc = null;
            try {
                p.kill('SIGTERM');
                setTimeout(() => { try { if (p.exitCode === null) p.kill('SIGKILL'); } catch (_) {} }, 2000);
            } catch (_) {}
        }
        if (this._ffmpegStats) this._ffmpegStats.dead = true;
        if (this._ffmpegStreamRes) {
            try { this._ffmpegStreamRes.end(); } catch (_) {}
            this._ffmpegStreamRes = null;
        }
        if (this._ffmpegServer) {
            try { this._ffmpegServer.close(); } catch (_) {}
            this._ffmpegServer = null;
            this._ffmpegPort = null;
        }
    }

    // ------ Portal bridge (Wayland capture -> FFmpeg encode) ------
    // x11grab is blind on Wayland; the portal dialog (via portal_bridge.py)
    // yields a PipeWire node that GStreamer reads as dumb rawvideo straight
    // into FFmpeg's stdin. Same probed encoder chain, same relay, same
    // watchdog as _startFFmpeg — only the frame source differs.
    // NEARCADE_PORTAL_TEST=1 swaps the portal for videotestsrc (headless CI).

    async _startSidecapture({ sourceId, width = 960, height = 540, fps = 60, bitrate = 4000000 } = {}) {
        await this._ensureFFmpegServer();
        const chain = this._probeHwEncoders();
        let lastErr = null;
        for (const enc of chain) {
            this._ffmpegEncoder = 'sidecapture:' + enc;
            try {
                await this._attemptSidecapture(enc, { sourceId, width, height, fps, bitrate });
                console.log(`[CaptureManager] Sidecapture live (${enc}, ${width}x${height}@${fps}, ${Math.round(bitrate / 1000)}k)`);
                return { ok: true, message: `Sidecapture running on ${enc}`, port: this._ffmpegPort, encoder: 'sidecapture:' + enc };
            } catch (e) {
                lastErr = e;
                console.warn(`[CaptureManager] Sidecapture ${enc} unusable: ${e.message}`);
            }
        }
        this._ffmpegEncoder = null;
        throw lastErr || new Error('[CaptureManager] No working sidecapture encoder found');
    }

    _attemptSidecapture(enc, { sourceId, width, height, fps, bitrate }) {
        return new Promise((resolve, reject) => {
            const ff = this._resolveFFmpegBinary();
            const cliPath = path.join(__dirname, '..', '..', '..', 'tools', 'nearcade-sidecapture', 'target', 'debug', 'nearcade-sidecapture');
            
            const kb = Math.round((bitrate || 4000000) / 1000);
            const g = Math.max(1, (fps || 60));
            const args = ['-hide_banner', '-loglevel', 'info',
                          '-f', 'image2pipe', '-vcodec', 'mjpeg', '-r', String(fps || 60), '-i', 'pipe:0'];
            
            if (enc === 'vaapi') {
                args.push('-vf', 'format=nv12,hwupload',
                    '-vaapi_device', this._detectVaapiDevice(),
                    '-c:v', 'h264_vaapi', '-profile:v', 'high', '-level', '4.2',
                    '-b:v', `${kb}k`, '-bf', '0', '-g', String(g));
            } else if (enc === 'nvenc') {
                args.push('-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll',
                    '-b:v', `${kb}k`, '-bf', '0', '-g', String(g), '-cq', '20');
            } else {
                args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
                    '-b:v', `${kb}k`, '-bf', '0', '-g', String(g));
            }
            args.push('-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_keyframe+skip_sidx', 'pipe:1');
            
            const procFFmpeg = spawn(ff, args, { stdio: ['pipe', 'pipe', 'pipe'] });
            
            const cliArgs = ['start', '--device', sourceId, '--width', String(width), '--height', String(height), '--fps', String(fps), '--stdout'];
            const procCli = spawn(cliPath, cliArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
            
            procCli.stdout.pipe(procFFmpeg.stdin);
            
            this._ffmpegProc = procFFmpeg;
            this._sidecaptureProc = procCli;
            
            if (procFFmpeg.stdout) this._armNullDrain(procFFmpeg);
            this._pipeRelay(procFFmpeg);
            
            const LAUNCH_MS = 25000, STALL_MS = 10000;
            const LAUNCH_BYTES = 8192;
            let errTail = '';
            let firstFrameAt = 0, lastProgressAt = Date.now(), lastBytes = 0;
            this._ffmpegBytes = 0;
            let settled = false;
            const stats = {
                encoder: 'sidecapture:' + enc, frames: 0, fps: 0,
                restarts: 0, startedAt: Date.now(), stalled: false, dead: false,
            };
            this._ffmpegStats = stats;
            const kill = () => { try { procFFmpeg.kill('SIGKILL'); procCli.kill('SIGKILL'); } catch (_) {} this._ffmpegProc = null; this._sidecaptureProc = null; };
            
            const wd = setInterval(() => {
                const now = Date.now();
                const bytesNow = this._ffmpegBytes || 0;
                if (bytesNow > lastBytes) { lastBytes = bytesNow; lastProgressAt = now; }
                stats.bytes = bytesNow;
                if (!settled) {
                    if (procFFmpeg.exitCode !== null && procFFmpeg.exitCode !== undefined) {
                        clearInterval(wd); settled = true; kill();
                        reject(new Error(`ffmpeg exited code ${procFFmpeg.exitCode}`));
                    } else if (procCli.exitCode !== null && procCli.exitCode !== undefined) {
                        clearInterval(wd); settled = true; kill();
                        reject(new Error(`sidecapture exited code ${procCli.exitCode}`));
                    } else if (!firstFrameAt && bytesNow > LAUNCH_BYTES) {
                        firstFrameAt = now; settled = true; resolve(stats);
                    } else if (!firstFrameAt && now - lastProgressAt > LAUNCH_MS) {
                        clearInterval(wd); settled = true; kill();
                        reject(new Error(`no frames in ${LAUNCH_MS}ms`));
                    }
                } else if (!stats.stalled && !stats.dead && now - lastProgressAt > STALL_MS) {
                    stats.stalled = true;
                    console.warn(`[CaptureManager] Sidecapture pipeline stalled! No bytes for ${STALL_MS}ms.`);
                }
            }, 500);
            
            procFFmpeg.stderr.on('data', d => {
                const s = d.toString(); errTail = (errTail + s).slice(-1024);
                const m = s.match(/frame=\s*(\d+).*fps=\s*([\d.]+)/);
                if (m) {
                    stats.frames = parseInt(m[1], 10);
                    stats.fps = parseFloat(m[2]);
                    const now = Date.now();
                    lastProgressAt = now;
                    if (!firstFrameAt) { firstFrameAt = now; settled = true; resolve(stats); }
                }
            });
            
            procFFmpeg.on('error', e => { if (!settled) { clearInterval(wd); settled = true; kill(); reject(e); } else stats.dead = true; });
            procCli.on('error', e => { if (!settled) { clearInterval(wd); settled = true; kill(); reject(e); } else stats.dead = true; });
            
            procFFmpeg.on('close', code => {
                if (!settled) { clearInterval(wd); settled = true; kill(); reject(new Error(`exited code ${code}`)); }
                else if (!stats.stalled) stats.dead = true;
            });
        });
    }

    async _startPortalBridge({ width = 960, height = 540, fps = 70, bitrate = 4000000 } = {}) {
        if (os.platform() !== 'linux') throw new Error('Portal capture only supports Linux.');
        await this._ensureFFmpegServer();
        const chain = this._probeHwEncoders();
        let lastErr = null;
        for (const enc of chain) {
            this._ffmpegEncoder = 'portal:' + enc;
            try {
                await this._attemptPortalBridge(enc, { width, height, fps, bitrate });
                console.log(`[CaptureManager] Portal bridge live (${enc}, ${width}x${height}@${fps}, ${Math.round(bitrate / 1000)}k)`);
                return { ok: true, message: `Portal bridge running on ${enc}`, port: this._ffmpegPort, encoder: 'portal:' + enc };
            } catch (e) {
                lastErr = e;
                console.warn(`[CaptureManager] Portal bridge ${enc} unusable: ${e.message}`);
            }
        }
        this._ffmpegEncoder = null;
        throw lastErr || new Error('[CaptureManager] No working portal encoder found');
    }

    _attemptPortalBridge(enc, { width, height, fps, bitrate }) {
        return new Promise((resolve, reject) => {
            const ff = this._resolveFFmpegBinary();
            const script = path.join(__dirname, 'portal_bridge.py');
            const args = ['-u', script,
                '--width', String(width), '--height', String(height),
                '--fps', String(fps), '--bitrate', String(bitrate),
                '--encoder', enc, '--vaapi-device', this._detectVaapiDevice(),
                '--ffmpeg-bin', ff];
            if (process.env.NEARCADE_PORTAL_TEST === '1') args.push('--test');
            console.log(`[CaptureManager] Portal bridge trying ${enc}: python3 ${args.join(' ')}`);
            const proc = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            this._ffmpegProc = proc;
            if (proc.stdout) this._armNullDrain(proc);
            this._pipeRelay(proc);
            // Portal picking is interactive (system dialog, 60 s budget), so
            // the launch gate is generous; the stall gate stays tight.
            const LAUNCH_MS = 75000, STALL_MS = 10000;
            const LAUNCH_BYTES = 8192;
            let errTail = '';
            let readyReceived = false, firstFrameAt = 0, lastProgressAt = Date.now(), lastBytes = 0;
            this._ffmpegBytes = 0;
            let settled = false;
            const stats = {
                encoder: 'portal:' + enc, frames: 0, fps: 0,
                restarts: (this._ffmpegStats && this._ffmpegStats.restarts) || 0,
                startedAt: Date.now(), stalled: false, dead: false,
            };
            this._ffmpegStats = stats;
            this._ffmpegBadEnc = this._ffmpegBadEnc || {};
            const kill = () => { try { proc.kill('SIGKILL'); } catch (_) {} this._ffmpegProc = null; };
            const wd = setInterval(() => {
                const now = Date.now();
                const bytesNow = this._ffmpegBytes || 0;
                if (bytesNow > lastBytes) { lastBytes = bytesNow; lastProgressAt = now; }
                stats.bytes = bytesNow;
                if (!settled) {
                    if (proc.exitCode !== null && proc.exitCode !== undefined) {
                        clearInterval(wd);
                        settled = true; kill();
                        reject(new Error(`bridge exited code ${proc.exitCode}: ${errTail.split('\n').filter(Boolean).pop() || 'no output'}`));
                    } else if (!firstFrameAt && readyReceived && bytesNow > LAUNCH_BYTES) {
                        // Byte gate: output flowing end-to-end (stats lines are
                        // \r-timed and unreliable as the sole signal).
                        firstFrameAt = now;
                        settled = true;
                        resolve(stats);
                    } else if (!firstFrameAt && now - lastProgressAt > LAUNCH_MS) {
                        clearInterval(wd);
                        settled = true; kill();
                        reject(new Error(`no frames in ${LAUNCH_MS}ms (portal dialog unanswered?)`));
                    }
                } else if (!stats.stalled && !stats.dead && now - lastProgressAt > STALL_MS) {
                    stats.stalled = true;
                    kill();
                    const n = (this._ffmpegBadEnc[enc] = (this._ffmpegBadEnc[enc] || 0) + 1);
                    if (n >= 2 && this._ffmpegProbeCache) {
                        this._ffmpegProbeCache = this._ffmpegProbeCache.filter((e) => e !== enc);
                        console.error(`[CaptureManager] Portal ${enc} stalled ${n}x — demoted, chain now: ${this._ffmpegProbeCache.join(' → ')}`);
                    } else {
                        console.error(`[CaptureManager] Portal ${enc} STALLED (no frames for ${STALL_MS}ms) — killed, supervisor should restart`);
                    }
                }
            }, 2000);
            proc.stderr.on('data', (d) => {
                const s = d.toString();
                errTail = (errTail + s).slice(-2000);
                for (const line of s.split('\n')) {
                    const t = line.trim();
                    if (!t) continue;
                    if (t.startsWith('{')) {
                        try {
                            const m = JSON.parse(t);
                            if (m.type === 'portal-ready' || m.type === 'test-ready') {
                                readyReceived = true;
                                lastProgressAt = Date.now();
                                const rz = m.width && m.height ? ` ${m.width}x${m.height}` : '';
                                console.log(`[CaptureManager] Portal source ready${rz} (node ${m.node})`);
                            } else if (m.type === 'error') {
                                console.warn(`[Portal:${enc}] ${String(m.message || '').slice(0, 220)}`);
                            }
                            continue;
                        } catch (_) {}
                    }
                    const m = t.match(/frame=\s*(\d+)\s+fps=\s*([\d.]+)/);
                    if (m) {
                        stats.frames = parseInt(m[1], 10);
                        stats.fps = parseFloat(m[2]);
                        const now = Date.now();
                        lastProgressAt = now;
                        if (!firstFrameAt && readyReceived) {
                            firstFrameAt = now;
                            settled = true;
                            resolve(stats);
                        }
                        if (now - stats.startedAt > 60000) this._ffmpegBadEnc[enc] = 0;
                    } else if (/error|failed|invalid|cannot|no such|denied|not found/i.test(t)) {
                        console.warn(`[Portal:${enc}] ${t.slice(0, 220)}`);
                    }
                }
            });
            proc.on('error', (e) => {
                if (!settled) { clearInterval(wd); settled = true; kill(); reject(e); }
                else stats.dead = true;
            });
            proc.on('close', (code) => {
                if (!settled) {
                    clearInterval(wd);
                    settled = true; this._ffmpegProc = null;
                    reject(new Error(`bridge exited code ${code}: ${errTail.split('\n').filter(Boolean).pop() || 'no output'}`));
                } else if (!stats.stalled) {
                    stats.dead = true;
                    console.warn(`[CaptureManager] Portal ${enc} proc closed (code ${code}) after launch — supervisor should restart`);
                }
            });
        });
    }

    // Kept for backward compat — now returns the head of the probed chain.
    _detectFFmpegEncoder() {
        try {
            const chain = this._probeHwEncoders();
            return chain[0] || 'software';
        } catch (_) { return 'software'; }
    }

    _detectVaapiDevice() {
        try {
            const nodes = fs.readdirSync('/dev/dri').filter(n => n.startsWith('renderD'));
            if (nodes.length > 0) return `/dev/dri/${nodes[0]}`;
        } catch (_) {}
        return '/dev/dri/renderD128';
    }

    // ------ WiVRn Implementation (OpenXR Streaming + PipeWire Capture) ------------------------------

    async _startWiVRn({ width = 1920, height = 1080, fps = 90, bitrate = 20000000 } = {}) {
        if (os.platform() !== 'linux') {
            throw new Error('WiVRn capture only supports Linux.');
        }

        // 1. Start WiVRn server
        const wivrnStart = await this._wivrnIntegration.startServer({
            bitrate,
            resolution: `${width}x${height}`,
            framerate: fps,
            headless: true
        });

        if (!wivrnStart.ok) {
            throw new Error(`[CaptureManager] Failed to start WiVRn: ${wivrnStart.message}`);
        }

        // 2. Capture compositor output via PipeWire/X11 (WiVRn renders via Gamescope/Monado)
        //    The encoded PipeWire stream is served over HTTP for WebRTC viewers.
        const encoder = this._detectFFmpegEncoder();
        const captureDisplay = process.env.DISPLAY || ':1';

        let ffArgs = [
            '-hide_banner', '-loglevel', 'warning',
            '-f', 'x11grab',
            '-framerate', String(fps),
            '-video_size', `${width}x${height}`,
            '-i', captureDisplay
        ];

        if (encoder === 'vaapi') {
            ffArgs.push(
                '-vf', 'format=nv12,hwupload',
                '-vaapi_device', this._detectVaapiDevice(),
                '-c:v', 'h264_vaapi',
                '-profile:v', 'high', '-level', '4.2',
                '-b:v', `${Math.round(bitrate / 1000)}k`,
                '-bf', '0', '-g', String(fps * 2), '-tune', 'zerolatency'
            );
        } else {
            ffArgs.push(
                '-c:v', 'libx264',
                '-preset', 'ultrafast', '-tune', 'zerolatency',
                '-b:v', `${Math.round(bitrate / 1000)}k`,
                '-bf', '0', '-g', String(fps * 2)
            );
        }

        ffArgs.push('-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_keyframe+skip_sidx', 'pipe:1');

        this._wivrnProc = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'inherit'] });

        // 3. HTTP server relaying WiVRn compositor output to viewers
        this._wivrnServer = http.createServer((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
            });
            this._wivrnStreamRes = res;
            if (this._wivrnProc && this._wivrnProc.stdout) {
                this._wivrnProc.stdout.pipe(res);
            }
        });

        await new Promise((resolve) => {
            this._wivrnServer.listen(0, '127.0.0.1', () => {
                this._wivrnPort = this._wivrnServer.address().port;
                resolve();
            });
        });

        this._wivrnProc.on('error', (err) => {
            console.error('[CaptureManager] WiVRn FFmpeg error:', err.message);
            this._stopWiVRn();
        });
        this._wivrnProc.on('close', (code) => {
            console.log(`[CaptureManager] WiVRn FFmpeg exited with code ${code}`);
            this._activeMethod = null;
        });

        console.log(`[CaptureManager] WiVRn capture active on ${captureDisplay}, HTTP port ${this._wivrnPort}`);

        return {
            ok: true,
            message: 'WiVRn streaming active',
            port: this._wivrnPort,
            url: `http://127.0.0.1:${this._wivrnPort}/stream`,
            encoder,
            wivrnStatus: this._wivrnIntegration.getStatus()
        };
    }

    _stopWiVRn() {
        if (this._wivrnProc) {
            try {
                this._wivrnProc.kill('SIGTERM');
                setTimeout(() => {
                    if (this._wivrnProc && !this._wivrnProc.killed) {
                        this._wivrnProc.kill('SIGKILL');
                    }
                }, 2000);
            } catch (_) {}
            this._wivrnProc = null;
        }

        if (this._wivrnServer) {
            this._wivrnServer.close();
            this._wivrnServer = null;
            this._wivrnPort = null;
        }

        if (this._wivrnStreamRes) {
            this._wivrnStreamRes.end();
            this._wivrnStreamRes = null;
        }

        this._wivrnIntegration.stopServer();
    }

    // ------ GStreamer WebRTC Implementation ------------------------------------------------------------------------------------------

    async _startGstWebRTC(options) {
        if (os.platform() !== 'linux') throw new Error('GStreamer WebRTC currently only supports Linux.');

        // Prefer the native Rust backend when built; fall back to Python.
        // Both speak the identical JSON-over-stdio protocol.
        let sidecarBase = __dirname;
        if (sidecarBase.includes('app.asar')) sidecarBase = sidecarBase.replace('app.asar', 'app.asar.unpacked');
        const rustBin = path.join(sidecarBase, 'gst-nearcade', 'target', 'release', 'gst-nearcade');
        let useRust = false;
        try { fs.accessSync(rustBin, fs.constants.X_OK); useRust = true; } catch (_) {}
        const pyScript = path.join(__dirname, 'gstreamer_webrtc.py');

        // Resolve the capture node once — shared by both backends.
        let nodeStr = null;
        
        // Attempt headless PipeWire node discovery (Gamescope/SteamVR/WiVRn)
        if (options && options.sourceId) {
            console.log(`[CaptureManager] Using explicitly requested source node ID: ${options.sourceId}`);
            nodeStr = String(options.sourceId);
        } else {
            try {
                const { findGamescopeNode } = require('./pipewire-capture.js');
                const targetNode = findGamescopeNode();
                if (targetNode) {
                    nodeStr = targetNode.serial || targetNode.name || targetNode.id;
                    console.log(`[CaptureManager] Auto-discovered PipeWire target node: ${targetNode.name} -> Passing ${nodeStr}`);
                } else {
                    console.warn('[CaptureManager] No headless PipeWire node found. GStreamer will fallback to default video source.');
                }
            } catch (err) {
                console.error('[CaptureManager] Error resolving PipeWire node:', err.message);
            }
        }

        let cmd, args;
        // Rust backend has no portal fallback: without a headless node it
        // would exit immediately, so prefer Python up front in that case.
        // Also: if nodeStr is a portal token (window:X:Y or screen:X:Y), it's not a
        // raw PipeWire serial — Rust can't use it. Python handles the fd+node flow.
        const isPortalToken = nodeStr && (nodeStr.startsWith('window:') || nodeStr.startsWith('screen:'));
        if (useRust && (!nodeStr || isPortalToken)) {
            const reason = !nodeStr
                ? 'No headless PipeWire node'
                : 'Portal token (window:/screen:) — Rust lacks fd-based portal support';
            console.log('[CaptureManager] ' + reason + ' — using Python.');
            useRust = false;
        }
        if (useRust) {
            cmd = rustBin;
            args = ['--mode', 'webrtc'];
            if (nodeStr) args.push('--node', nodeStr);
            // Pass through capture geometry when provided (Rust defaults: 1920x1080@30).
            const w = parseInt(options && (options.width || options.w), 10);
            const h = parseInt(options && (options.height || options.h), 10);
            const fps = parseInt(options && options.fps, 10);
            const br = parseInt(options && (options.bitrate || options.bitRate), 10);
            if (Number.isFinite(w) && w > 0) args.push('--width', String(w));
            if (Number.isFinite(h) && h > 0) args.push('--height', String(h));
            if (Number.isFinite(fps) && fps > 0) args.push('--fps', String(fps));
            if (Number.isFinite(br) && br > 0) args.push('--bitrate', String(br));
            if (options && options.encoder) args.push('--encoder', String(options.encoder));
            console.log('[CaptureManager] Spawning GStreamer Rust backend:', cmd, args.join(' '));
        } else {
            if (!fs.existsSync(pyScript)) {
                throw new Error(`[CaptureManager] gstreamer_webrtc.py not found at ${pyScript}`);
            }
            cmd = 'python3';
            args = ['-u', pyScript];
            // Only pass --node for headless PipeWire nodes (numeric serials).
            // Portal tokens (window:/screen:) trigger Python's internal portal flow.
            if (nodeStr && !isPortalToken) args.push('--node', nodeStr);
            console.log('[CaptureManager] Spawning GStreamer WebRTC Python Daemon with args:', args);
        }
        const proc = spawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'inherit']
        });
        this._gstProc = proc;

        // Listen for raw SDP / ICE candidates and thumbnails from Python
        this._gstStdoutBuf = '';
        this._gstEncoderName = null;
        // Launch-health gate: resolve ok:true only once the backend proves
        // itself alive (ready marker) and shows no early error/exit.
        // Previously ok:true was returned at spawn, so a backend that died
        // in the portal flow still showed "Running" in the UI.
        let _gstReadyResolve = null;
        const _gstReady = new Promise((resolve) => { _gstReadyResolve = resolve; });
        let _gstReadyDone = false;
        const _gstReadyOk = (ok, message) => {
            if (_gstReadyDone) return;
            _gstReadyDone = true;
            _gstReadyResolve({ ok, message });
        };
        setTimeout(() => _gstReadyOk(true, 'launched'), 4000);
        proc.stdout.on('data', (data) => {
            if (this._gstProc !== proc) return; // stale pre-respawn output
            this._gstStdoutBuf += data.toString();
            const lines = this._gstStdoutBuf.split('\n');
            this._gstStdoutBuf = lines.pop(); // Keep the last incomplete line in the buffer
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    // Capture encoder name from Python backend
                    if (msg.type === 'info' && msg.message && msg.message.startsWith('Using encoder: ')) {
                        this._gstEncoderName = msg.message.substring('Using encoder: '.length);
                    }
                    // Ready markers: pipeline actually alive (not just spawned).
                    if (msg.type === 'info' && msg.message && (
                        msg.message.includes('Thumbnail branch wired') ||
                        msg.message.includes('playing with new portal session') ||
                        msg.message.includes('Pipeline state:') ||
                        msg.message.includes('SDP offer sent')
                    )) {
                        _gstReadyOk(true, 'ready');
                    }
                    // Fatal markers: fail the start instead of lying "Running".
                    if (msg.type === 'error' && msg.message && (
                        msg.message.includes('Portal denied or timed out') ||
                        msg.message.includes('no H.264 hardware encoder found') ||
                        msg.message.includes('Pipeline parse error') ||
                        msg.message.includes('Pipeline failed to start') ||
                        msg.message.includes('GstWebRTC not installed') ||
                        msg.message.includes('GstSdp not installed')
                    )) {
                        _gstReadyOk(false, msg.message);
                    }
                    if (this._gstSignalingCallback) {
                        this._gstSignalingCallback(msg);
                    }
                } catch (err) {
                    // Ignore non-JSON output from GStreamer
                }
            }
        });

        proc.on('error', (err) => {
            console.error('[CaptureManager] GStreamer error:', err.message);
            _gstReadyOk(false, err.message);
            if (this._gstProc === proc) this._stopGstWebRTC();
        });

        proc.on('close', (code) => {
            console.log(`[CaptureManager] GStreamer WebRTC exited with code ${code}`);
            if (code !== 0 && code !== null && code !== undefined) {
                _gstReadyOk(false, 'backend exited (code ' + code + ')');
            }
            if (this._gstProc === proc && this._activeMethod === 'gstreamer_webrtc') {
                this._activeMethod = null;
            }
        });

        const ready = await _gstReady;
        if (!ready.ok) {
            try { if (this._gstProc === proc) await this._stopGstWebRTC(); } catch (_) {}
            throw new Error(`[CaptureManager] GStreamer backend failed to launch: ${ready.message || 'unknown'}`);
        }

        return { ok: true, message: 'Native C++ GStreamer WebRTC daemon running', encoder: this._gstEncoderName };
    }

    _stopGstWebRTC() {
        const proc = this._gstProc;
        this._gstProc = null;
        this._gstSignalingCallback = null;
        if (!proc) return Promise.resolve();
        // Capture the proc reference: the old delayed-SIGKILL closure read
        // `this._gstProc`, so a respawn within 1s got murdered by its own
        // predecessor's killer. Resolves on exit (SIGTERM is orderly).
        return new Promise((resolve) => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            try {
                proc.once('close', finish);
                proc.kill('SIGTERM');
                setTimeout(() => {
                    try {
                        if (!proc.killed) proc.kill('SIGKILL');
                    } catch (_) {}
                    setTimeout(finish, 500);
                }, 1000);
            } catch (_) { finish(); }
        });
    }

    // Pass the routing function so CaptureManager can emit WebRTC offers to Server.js
    setGstSignalingCallback(cb) {
        this._gstSignalingCallback = cb;
    }

    // Send Answers / ICE candidates from Server.js into the Python daemon
    sendGstSignaling(msg) {
        if (this._gstProc && this._gstProc.stdin.writable) {
            try {
                this._gstProc.stdin.write(JSON.stringify(msg) + '\n');
            } catch (err) {
                console.error('[CaptureManager] Error writing to GStreamer stdin', err);
            }
        }
    }
}

module.exports = new CaptureManager();
