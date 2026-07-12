/**
 * src/sidecar/CaptureManager.js
 * Unified Orchestrator for all Capture Methods.
 */
'use strict';

const { spawn, execSync } = require('child_process');
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
            case 'pipewire':
                return await this._startPipeWire(options);
            case 'wivrn':
                return await this._startWiVRn(options);
            case 'webcodecs':
                return { ok: true, message: 'WebCodecs armed on backend. Waiting for frontend execution.' };
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
        } else if (this._activeMethod === 'pipewire') {
            this._stopPipeWire();
        } else if (this._activeMethod === 'wivrn') {
            this._stopWiVRn();
        }

        this._activeMethod = null;
        return { ok: true };
    }

    getStatus() {
        return {
            active: this._activeMethod !== null,
            method: this._activeMethod,
            details: this._activeMethod === 'ffmpeg' ? `FFmpeg via ${this._ffmpegEncoder}` :
                     this._activeMethod === 'pipewire' ? `PipeWire node: ${this._pipewireNodeName || 'auto'}` :
                     this._activeMethod === 'wivrn' ? `WiVRn stream: ${this._wivrnPort || 'not started'}` :
                     'Frontend Execution'
        };
    }

    // ── PipeWire Implementation (Gamescope/SteamVR) ───────────────────────────

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
        this._pipewirePort = null;
        this._pipewireNodeName = null;
    }

    // ── FFmpeg Implementation (Isolated) ──

    async _startFFmpeg({ width = 1920, height = 1080, fps = 60, bitrate = 8000000 }) {
        if (os.platform() !== 'linux') throw new Error('FFmpeg experimental capture only supports Linux.');

        this._ffmpegEncoder = this._detectFFmpegEncoder();
        const display = process.env.DISPLAY || ':0';

        // Spin up the fragmented MP4 local server
        if (!this._ffmpegServer) {
            this._ffmpegServer = http.createServer((req, res) => {
                res.writeHead(200, {
                    'Content-Type': 'video/mp4',
                    'Cache-Control': 'no-cache',
                    'Access-Control-Allow-Origin': '*'
                });
                this._ffmpegStreamRes = res;
                if (this._ffmpegProc && this._ffmpegProc.stdout) this._ffmpegProc.stdout.pipe(res);
            });
            await new Promise((resolve) => {
                this._ffmpegServer.listen(0, '127.0.0.1', () => {
                    this._ffmpegPort = this._ffmpegServer.address().port;
                    resolve();
                });
            });
        }

        let args;
        if (this._ffmpegEncoder === 'vaapi') {
            args = ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-framerate', String(fps), '-video_size', `${width}x${height}`, '-i', display, '-vf', 'format=nv12,hwupload', '-vaapi_device', this._detectVaapiDevice(), '-c:v', 'h264_vaapi', '-profile:v', 'high', '-level', '4.2', '-b:v', `${Math.round(bitrate / 1000)}k`, '-bf', '0', '-g', String(fps * 2), '-tune', 'zerolatency', '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_keyframe', 'pipe:1'];
        } else {
            args = ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-framerate', String(fps), '-video_size', `${width}x${height}`, '-i', display, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', `${Math.round(bitrate / 1000)}k`, '-bf', '0', '-g', String(fps * 2), '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_keyframe', 'pipe:1'];
        }

        this._ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });
        if (this._ffmpegStreamRes) this._ffmpegProc.stdout.pipe(this._ffmpegStreamRes);

        this._ffmpegProc.on('error', (e) => console.error('[CaptureManager] FFmpeg Error:', e.message));
        this._ffmpegProc.on('close', () => { this._activeMethod = null; });

        return { ok: true, message: `FFmpeg running on ${this._ffmpegEncoder}`, port: this._ffmpegPort };
    }

    _stopFFmpeg() {
        if (this._ffmpegProc) {
            try { this._ffmpegProc.kill('SIGTERM'); } catch (_) {}
            this._ffmpegProc = null;
        }
        if (this._ffmpegStreamRes) {
            this._ffmpegStreamRes.end();
            this._ffmpegStreamRes = null;
        }
        if (this._ffmpegServer) {
            this._ffmpegServer.close();
            this._ffmpegServer = null;
            this._ffmpegPort = null;
        }
    }

    _detectFFmpegEncoder() {
        try {
            const encs = execSync('ffmpeg -hide_banner -encoders 2>/dev/null', { encoding: 'utf8' });
            if (encs.includes('h264_vaapi') || encs.includes('vp9_vaapi')) return 'vaapi';
        } catch (_) {}
        return 'software';
    }

    _detectVaapiDevice() {
        try {
            const nodes = fs.readdirSync('/dev/dri').filter(n => n.startsWith('renderD'));
            if (nodes.length > 0) return `/dev/dri/${nodes[0]}`;
        } catch (_) {}
        return '/dev/dri/renderD128';
    }

    // ── WiVRn Implementation (OpenXR Streaming + PipeWire Capture) ──────────

    async _startWiVRn({ width = 1920, height = 1080, fps = 90, bitrate = 20000000 } = {}) {
        if (os.platform() !== 'linux') {
            throw new Error('WiVRn capture only supports Linux.');
        }

        // 1. Start WiVRn server
        const wivrnStart = await this._wivrnIntegration.startServer({
            bitrate,
            resolution: `${width}x${height}`,
            framerate: fps
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
}

module.exports = new CaptureManager();
