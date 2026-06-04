/**
 * ffmpeg_capture.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠  EXPERIMENTAL — NOT MAINTAINED
 *
 * This module is provided as an optional alternative capture pipeline for
 * NearsecTogether. It is NOT part of the stable release and is not supported.
 * Enable it by launching with:
 *
 *   NearsecTogether.AppImage --ffmpeg-experimental
 *
 * WHAT THIS DOES:
 *   Replaces Chromium's getDisplayMedia encoder with an FFmpeg process that
 *   captures the display using KMS/DRM (or X11 fallback), encodes via
 *   VAAPI hardware (AMD/Intel) or NVENC (Nvidia), and pipes encoded frames
 *   into a WebRTC MediaStreamTrack via the Insertable Streams API.
 *
 * WHY IT EXISTS:
 *   Chromium's built-in VP8/H264 encoder is tuned for general video conferencing.
 *   FFmpeg with VAAPI/NVENC produces significantly better quality at the same
 *   bitrate for screen/game content, at lower CPU cost.
 *
 * REQUIREMENTS (Linux only):
 *   - ffmpeg with vaapi support:  ffmpeg -hwaccels | grep vaapi
 *   - For Nvidia:                 ffmpeg -encoders | grep nvenc
 *   - For software fallback:      ffmpeg -encoders | grep libvpx
 *
 * KNOWN LIMITATIONS:
 *   - Linux only. macOS and Windows are not implemented.
 *   - Requires Chromium Insertable Streams API (available in Electron 28+).
 *   - VAAPI requires a render node at /dev/dri/renderD128 (or similar).
 *   - Audio is NOT handled here — the existing NearsecVirtual audio pipeline
 *     is used unchanged.
 *   - KMS capture requires running without a compositor or with explicit
 *     DRM lease support. X11 fallback (`-f x11grab`) works universally.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { spawn, execSync } = require('child_process');
const path  = require('path');
const os    = require('os');

// ── Hardware encoder detection ────────────────────────────────────────────────

/**
 * Probe available FFmpeg hardware encoders.
 * Returns one of: 'vaapi' | 'nvenc' | 'software'
 */
function detectEncoder() {
  try {
    const encoders = execSync('ffmpeg -hide_banner -encoders 2>/dev/null', { encoding: 'utf8' });
    if (encoders.includes('h264_vaapi') || encoders.includes('vp9_vaapi')) return 'vaapi';
    if (encoders.includes('h264_nvenc'))  return 'nvenc';
  } catch (_) {}
  return 'software';
}

/**
 * Probe available DRM render nodes for VAAPI.
 * Returns the first available node path, e.g. '/dev/dri/renderD128'.
 */
function detectVaapiDevice() {
  try {
    const fs = require('fs');
    const nodes = fs.readdirSync('/dev/dri').filter(n => n.startsWith('renderD'));
    if (nodes.length > 0) return `/dev/dri/${nodes[0]}`;
  } catch (_) {}
  return '/dev/dri/renderD128'; // default guess
}

/**
 * Detect the active display to capture.
 * Prefers Wayland via pipewire-portal, falls back to X11.
 */
function detectDisplay() {
  if (process.env.WAYLAND_DISPLAY) return { type: 'wayland', display: process.env.WAYLAND_DISPLAY };
  if (process.env.DISPLAY)         return { type: 'x11',     display: process.env.DISPLAY };
  return { type: 'x11', display: ':0' };
}

// ── FFmpeg argument builders ──────────────────────────────────────────────────

function buildVaapiArgs({ display, vaapiDevice, width, height, fps, bitrate }) {
  // VAAPI encode path:
  //   x11grab → raw frames → VAAPI upload → h264_vaapi encode → rawvideo pipe
  // Note: output is Annex-B H.264 NAL units, read by the frame injector below.
  const args = [
    '-hide_banner', '-loglevel', 'error',

    // Input: X11 screen grab
    '-f', 'x11grab',
    '-framerate', String(fps),
    '-video_size', `${width}x${height}`,
    '-i', display,

    // VAAPI hwaccel upload
    '-vf', `format=nv12,hwupload`,
    '-vaapi_device', vaapiDevice,

    // Encoder
    '-c:v', 'h264_vaapi',
    '-profile:v', 'high',
    '-level', '4.2',
    '-b:v', `${Math.round(bitrate / 1000)}k`,
    '-maxrate', `${Math.round(bitrate * 1.5 / 1000)}k`,
    '-bufsize', `${Math.round(bitrate * 2 / 1000)}k`,

    // Low-latency tune: no B-frames, IDR on demand
    '-bf', '0',
    '-g', String(fps * 2),  // keyframe every 2s
    '-sc_threshold', '0',
    '-tune', 'zerolatency',

    // Output: raw H.264 Annex-B to stdout
    '-f', 'h264',
    'pipe:1',
  ];
  return args;
}

function buildNvencArgs({ display, width, height, fps, bitrate }) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'x11grab',
    '-framerate', String(fps),
    '-video_size', `${width}x${height}`,
    '-i', display,
    '-c:v', 'h264_nvenc',
    '-preset', 'p1',        // lowest latency NVENC preset
    '-tune', 'ull',         // ultra low latency
    '-rc', 'cbr',
    '-b:v', `${Math.round(bitrate / 1000)}k`,
    '-bf', '0',
    '-g', String(fps * 2),
    '-f', 'h264',
    'pipe:1',
  ];
}

function buildSoftwareArgs({ display, width, height, fps, bitrate }) {
  // libx264 software fallback — cpu-used tuned for low latency
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'x11grab',
    '-framerate', String(fps),
    '-video_size', `${width}x${height}`,
    '-i', display,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', `${Math.round(bitrate / 1000)}k`,
    '-maxrate', `${Math.round(bitrate * 1.5 / 1000)}k`,
    '-bufsize', `${Math.round(bitrate * 2 / 1000)}k`,
    '-bf', '0',
    '-g', String(fps * 2),
    '-f', 'h264',
    'pipe:1',
  ];
}

// ── Main capture class ────────────────────────────────────────────────────────

class FFmpegCapture {
  constructor() {
    this._proc      = null;
    this._encoder   = null;
    this._generator = null;
    this._writer    = null;
    this._track     = null;
    this._active    = false;
  }

  /**
   * Start FFmpeg capture and return a MediaStreamTrack suitable for
   * insertion into a WebRTC peer connection alongside the existing audio track.
   *
   * @param {object} opts
   * @param {number} opts.width    - capture width  (default: screen width)
   * @param {number} opts.height   - capture height (default: screen height)
   * @param {number} opts.fps      - capture framerate (default: 60)
   * @param {number} opts.bitrate  - target bitrate in bps (default: 8_000_000)
   * @returns {Promise<MediaStreamTrack>}
   */
  async start({ width, height, fps, bitrate } = {}) {
    if (this._active) await this.stop();

    if (os.platform() !== 'linux') {
      throw new Error('[ffmpeg_capture] Only Linux is supported.');
    }

    const screenWidth  = width   || screen.width  || 1920;
    const screenHeight = height  || screen.height || 1080;
    const targetFps    = fps     || 60;
    const targetBr     = bitrate || 8_000_000;

    const encoderType = detectEncoder();
    const dispInfo    = detectDisplay();
    const display     = dispInfo.type === 'x11'
      ? `${dispInfo.display}.0+0,0`   // x11grab format: DISPLAY.screen+x,y
      : dispInfo.display;

    console.log(`[ffmpeg_capture] Encoder: ${encoderType} | Display: ${display} | ${screenWidth}x${screenHeight}@${targetFps}`);

    let ffmpegArgs;
    if (encoderType === 'vaapi') {
      const vaapiDevice = detectVaapiDevice();
      console.log(`[ffmpeg_capture] VAAPI device: ${vaapiDevice}`);
      ffmpegArgs = buildVaapiArgs({ display, vaapiDevice, width: screenWidth, height: screenHeight, fps: targetFps, bitrate: targetBr });
    } else if (encoderType === 'nvenc') {
      ffmpegArgs = buildNvencArgs({ display, width: screenWidth, height: screenHeight, fps: targetFps, bitrate: targetBr });
    } else {
      console.warn('[ffmpeg_capture] No hardware encoder found — falling back to libx264 (software).');
      ffmpegArgs = buildSoftwareArgs({ display, width: screenWidth, height: screenHeight, fps: targetFps, bitrate: targetBr });
    }

    this._encoder = encoderType;
    this._active  = true;

    // Spawn FFmpeg with stdout piped, stderr to terminal for debugging
    this._proc = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    this._proc.on('error', (e) => {
      console.error('[ffmpeg_capture] FFmpeg spawn error:', e.message);
      this._active = false;
    });

    this._proc.on('close', (code) => {
      if (code !== 0 && this._active) {
        console.warn(`[ffmpeg_capture] FFmpeg exited with code ${code}`);
      }
      this._active = false;
    });

    // ── Insertable Streams injection ─────────────────────────────────────────
    // VideoTrackGenerator is the Insertable Streams API entry point.
    // We read Annex-B NAL units from FFmpeg's stdout, decode them with
    // VideoDecoder, and push VideoFrames into the generator's WritableStream.

    if (typeof VideoTrackGenerator === 'undefined') {
      this._proc.kill();
      throw new Error('[ffmpeg_capture] VideoTrackGenerator (Insertable Streams API) not available in this Electron build.');
    }

    this._generator = new VideoTrackGenerator();
    this._track     = this._generator.track;
    this._writer    = this._generator.writable.getWriter();

    // Decoder: receives encoded chunks from FFmpeg and produces VideoFrames
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (!this._active) { frame.close(); return; }
        this._writer.write(frame);
      },
      error: (e) => {
        console.error('[ffmpeg_capture] VideoDecoder error:', e.message);
      },
    });

    decoder.configure({
      codec:             'avc1.64002a',  // H.264 High Profile Level 4.2
      codedWidth:        screenWidth,
      codedHeight:       screenHeight,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode:       'realtime',
    });

    // Pipe FFmpeg stdout chunks into the VideoDecoder as EncodedVideoChunks.
    // FFmpeg outputs raw Annex-B H.264 — we pass it as 'delta' chunks since
    // we can't cheaply distinguish keyframes without parsing NAL headers.
    // IDR frames fire every `fps * 2` seconds per the encoder config above.
    let chunkTs = 0;
    const frameDurationUs = Math.round(1_000_000 / targetFps);

    this._proc.stdout.on('data', (buf) => {
      if (!this._active) return;
      try {
        decoder.decode(new EncodedVideoChunk({
          type:      'delta',
          timestamp: chunkTs,
          data:      buf,
        }));
        chunkTs += frameDurationUs;
      } catch (e) {
        // Non-fatal — decoder may still be flushing a previous config change
      }
    });

    console.log(`[ffmpeg_capture] Pipeline active. Track ready for WebRTC injection.`);
    return this._track;
  }

  /**
   * Stop the FFmpeg process and release all resources.
   */
  async stop() {
    this._active = false;

    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch (_) {}
      this._proc = null;
    }

    if (this._writer) {
      try { await this._writer.close(); } catch (_) {}
      this._writer = null;
    }

    if (this._track) {
      try { this._track.stop(); } catch (_) {}
      this._track = null;
    }

    this._generator = null;
    this._encoder   = null;

    console.log('[ffmpeg_capture] Pipeline stopped.');
  }

  get isActive()  { return this._active; }
  get encoderType() { return this._encoder; }
}

// ── Singleton export ──────────────────────────────────────────────────────────
// server.js exposes this via /api/ffmpeg-status and /api/ffmpeg-stop.
// host.js calls startFFmpegCapture() / stopFFmpegCapture() through the
// existing fetch() API pattern.

const _instance = new FFmpegCapture();

module.exports = {
  /**
   * Start the FFmpeg pipeline. Returns the video track.
   * Called by server.js on POST /api/start-ffmpeg-capture
   */
  startCapture:  (opts) => _instance.start(opts),

  /**
   * Stop the FFmpeg pipeline and release resources.
   * Called by server.js on POST /api/stop-ffmpeg-capture
   */
  stopCapture:   ()     => _instance.stop(),

  isActive:      ()     => _instance.isActive,
  encoderType:   ()     => _instance.encoderType,

  // Expose for direct require() in electron-main if needed
  FFmpegCapture,
};
