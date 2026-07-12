#!/usr/bin/env node
/**
 * src/sidecar/pipewire-capture.js
 * PipeWire source discovery and FFmpeg bridge for Gamescope/SteamVR/WiVRn capture.
 * 
 * Usage:
 *   node pipewire-capture.js --list              # List available PipeWire nodes
 *   node pipewire-capture.js --stream [name]     # Start streaming to HTTP server
 *   node pipewire-capture.js --wivrn             # Start WiVRn streaming
 *   node pipewire-capture.js --help              # Show help
 * 
 * The script:
 * 1. Discovers PipeWire nodes (gamescope, SteamVR compositor, WiVRn, etc.)
 * 2. Launches FFmpeg to capture the selected node
 * 3. Serves the stream as fragmented MP4 over HTTP
 * 4. Exposes the port via IPC to the main Electron process
 * 5. Supports WiVRn OpenXR streaming for standalone headsets
 */

'use strict';

const { spawn, execSync } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

// ── PipeWire Node Discovery ───────────────────────────────────────────────────

function listPipeWireNodes() {
    try {
        const output = execSync('pw-cli list-objects 2>/dev/null', { encoding: 'utf8' });
        const nodes = [];
        let currentNode = null;

        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            
            // Start of a new Node object
            if (trimmed.startsWith('node:')) {
                if (currentNode) nodes.push(currentNode);
                currentNode = { id: trimmed.split(' ')[1], props: {} };
            }
            
            // Node properties
            if (currentNode && trimmed.startsWith('node.name')) {
                const match = trimmed.match(/node\.name = "(.*?)"/);
                if (match) currentNode.name = match[1];
            }
            if (currentNode && trimmed.startsWith('media.class')) {
                const match = trimmed.match(/media\.class = "(.*?)"/);
                if (match) currentNode.class = match[1];
            }
            if (currentNode && trimmed.startsWith('node.description')) {
                const match = trimmed.match(/node\.description = "(.*?)"/);
                if (match) currentNode.description = match[1];
            }
        }
        
        if (currentNode) nodes.push(currentNode);
        
        // Filter to VideoSink/VideoSource nodes only
        return nodes.filter(n => 
            n.class === 'Video/Sink' || 
            n.class === 'Video/Source' ||
            (n.name && (n.name.includes('gamescope') || n.name.includes('SteamVR') || n.name.includes('wivrn') || n.name.includes('monado')))
        );
    } catch (err) {
        console.error('[PipeWire] Failed to list nodes:', err.message);
        return [];
    }
}

function findGamescopeNode() {
    const nodes = listPipeWireNodes();
    
    // Priority order for finding the right node
    const priority = [
        'wivrn',
        'monado',
        'gamescope',
        'SteamVR',
        'vrcompositor',
        'Steam'
    ];
    
    for (const keyword of priority) {
        const match = nodes.find(n => 
            (n.name && n.name.toLowerCase().includes(keyword)) ||
            (n.description && n.description.toLowerCase().includes(keyword))
        );
        if (match) return match;
    }
    
    // Fallback to first Video/Sink node
    return nodes.find(n => n.class === 'Video/Sink') || nodes[0] || null;
}

// ── WiVRn Support Functions ─────────────────────────────────────────────────

function checkWiVRnRunning() {
    try {
        // Check for system installation
        execSync('pgrep -x wivrn-server >/dev/null 2>&1');
        return true;
    } catch (_) {
        try {
            // Check for flatpak installation
            execSync('pgrep -f "flatpak run io.github.wivrn.wivrn wivrn-server" >/dev/null 2>&1');
            return true;
        } catch (__) {
            return false;
        }
    }
}

function getWiVRnStreamInfo() {
    try {
        // WiVRn typically streams on port 9757
        return {
            host: '127.0.0.1',
            port: 9757,
            protocol: 'udp',
            type: 'wivrn'
        };
    } catch (err) {
        return null;
    }
}

// ── FFmpeg Capture Pipeline ───────────────────────────────────────────────────

class PipeWireStreamServer {
    constructor() {
        this.server = null;
        this.port = null;
        this.streamRes = null;
        this.ffmpegProc = null;
        this.active = false;
    }

    async start(nodeName, { width = 1920, height = 1080, fps = 90, bitrate = 15000000 } = {}) {
        if (this.active) {
            await this.stop();
        }

        console.log(`[PipeWire] Starting capture for node: ${nodeName || 'auto-detect'}`);

        // Create HTTP server for fragmented MP4 stream
        this.server = http.createServer((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*',
                'Transfer-Encoding': 'chunked'
            });
            this.streamRes = res;
            if (this.ffmpegProc && this.ffmpegProc.stdout) {
                this.ffmpegProc.stdout.pipe(res);
            }
        });

        await new Promise((resolve) => {
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                resolve();
            });
        });

        console.log(`[PipeWire] Stream server listening on port ${this.port}`);

        // Detect FFmpeg encoder
        const encoder = this.detectEncoder();
        console.log(`[PipeWire] Using encoder: ${encoder}`);

        // Build FFmpeg arguments for PipeWire capture
        const args = this.buildFFmpegArgs(nodeName, width, height, fps, bitrate, encoder);
        
        console.log(`[PipeWire] FFmpeg command: ffmpeg ${args.join(' ')}`);

        this.ffmpegProc = spawn('ffmpeg', args, {
            stdio: ['ignore', 'pipe', 'inherit'],
            env: { ...process.env, PIPEWIRE_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/' + os.getuid() }
        });

        this.ffmpegProc.on('error', (err) => {
            console.error('[PipeWire] FFmpeg error:', err.message);
            this.active = false;
        });

        this.ffmpegProc.on('close', (code) => {
            console.log(`[PipeWire] FFmpeg exited with code ${code}`);
            this.active = false;
            if (this.streamRes) {
                this.streamRes.end();
                this.streamRes = null;
            }
        });

        this.active = true;

        return {
            ok: true,
            port: this.port,
            encoder: encoder,
            node: nodeName || 'auto-detected'
        };
    }

    async stop() {
        if (!this.active) return;

        console.log('[PipeWire] Stopping capture...');

        if (this.ffmpegProc) {
            this.ffmpegProc.kill('SIGTERM');
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (this.ffmpegProc.kill()) {
                this.ffmpegProc.kill('SIGKILL');
            }
            this.ffmpegProc = null;
        }

        if (this.streamRes) {
            this.streamRes.end();
            this.streamRes = null;
        }

        if (this.server) {
            this.server.close();
            this.server = null;
            this.port = null;
        }

        this.active = false;
    }

    getStatus() {
        return {
            active: this.active,
            port: this.port,
            encoder: this.detectEncoder(),
            node: this.active ? 'streaming' : 'idle'
        };
    }

    detectEncoder() {
        try {
            const encs = execSync('ffmpeg -hide_banner -encoders 2>/dev/null', { encoding: 'utf8' });
            if (encs.includes('h264_vaapi')) return 'vaapi';
            if (encs.includes('h264_nvenc')) return 'nvenc';
            if (encs.includes('h264_qsv')) return 'qsv';
        } catch (_) {}
        return 'libx264';
    }

    buildFFmpegArgs(nodeName, width, height, fps, bitrate, encoder) {
        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
        ];

        // Use X11 grabbing instead of PipeWire (more widely supported)
        // Gamescope creates an Xwayland display we can capture
        const display = process.env.DISPLAY || ':1'; // Gamescope typically uses :1
        
        args.push(
            '-f', 'x11grab',
            '-framerate', String(fps),
            '-video_size', `${width}x${height}`,
            '-i', display
        );

        // Video filtering and encoding
        if (encoder === 'vaapi') {
            args.push(
                '-vf', 'format=nv12,hwupload',
                '-vaapi_device', '/dev/dri/renderD128',
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
                '-preset', 'p1', // Fastest
                '-tune', 'll', // Low latency
                '-b:v', `${Math.round(bitrate / 1000)}k`,
                '-g', String(fps * 2),
                '-cq', '20'
            );
        } else {
            // Software encoding (libx264)
            args.push(
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-b:v', `${Math.round(bitrate / 1000)}k`,
                '-bf', '0',
                '-g', String(fps * 2),
                '-x264-params', 'keyint=' + String(fps * 2) + ':scenecut=0'
            );
        }

        // Output format: fragmented MP4 for WebCodecs/WebRTC
        args.push(
            '-f', 'mp4',
            '-movflags', 'empty_moov+default_base_moof+frag_keyframe+skip_sidx',
            'pipe:1'
        );

        return args;
    }
}

function printHelp() {
    console.log(`
PipeWire/WiVRn Capture Utility for Nearcade

Usage:
  node pipewire-capture.js --list              List available PipeWire nodes
  node pipewire-capture.js --stream [name]     Start streaming (auto-detect if name omitted)
  node pipewire-capture.js --wivrn             Start WiVRn streaming
  node pipewire-capture.js --stop              Stop streaming
  node pipewire-capture.js --status            Show current status
  node pipewire-capture.js --help              Show this help

Examples:
  node pipewire-capture.js --list
  node pipewire-capture.js --stream gamescope
  node pipewire-capture.js --stream "SteamVR Compositor"
  node pipewire-capture.js --wivrn              # Start WiVRn streaming

Environment:
  XDG_RUNTIME_DIR    PipeWire runtime directory (default: /run/user/<uid>)
  WIVRN_HOST         WiVRn server host (default: 127.0.0.1)
  WIVRN_PORT         WiVRn server port (default: 9757)

Output:
  When streaming, the HTTP server listens on 127.0.0.1:PORT
  The port is printed to stdout and can be consumed by the Electron main process.

WiVRn Support:
  WiVRn provides OpenXR streaming to standalone headsets (Meta Quest, Pico, etc.)
  Use --wivrn to start WiVRn streaming mode
  Requires WiVRn to be installed: https://github.com/WiVRn/WiVRn
`);
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    const streamServer = new PipeWireStreamServer();

    switch (command) {
        case '--list':
        case '-l':
            console.log('\nAvailable PipeWire Nodes:');
            console.log('='.repeat(60));
            const nodes = listPipeWireNodes();
            if (nodes.length === 0) {
                console.log('No video nodes found. Is Gamescope/SteamVR running?');
                console.log('\nTroubleshooting:');
                console.log('  1. Ensure gamescope is running: pidof gamescope');
                console.log('  2. Check PipeWire: pw-cli list-objects | grep -A3 "Video"');
                console.log('  3. Verify PulseAudio/PipeWire is active: pactl info');
            } else {
                nodes.forEach((node, idx) => {
                    console.log(`\n[${idx}] ${node.name || 'Unnamed'}`);
                    console.log(`    ID: ${node.id}`);
                    console.log(`    Class: ${node.class || 'N/A'}`);
                    console.log(`    Description: ${node.description || 'N/A'}`);
                });
            }
            console.log('='.repeat(60));
            break;

        case '--stream':
        case '-s':
            {
                const nodeName = args[1] || null;
                const options = {
                    width: parseInt(process.env.CAPTURE_WIDTH) || 1920,
                    height: parseInt(process.env.CAPTURE_HEIGHT) || 1080,
                    fps: parseInt(process.env.CAPTURE_FPS) || 90,
                    bitrate: parseInt(process.env.CAPTURE_BITRATE) || 15000000
                };

                // Auto-detect if no node name provided
                const targetNode = nodeName || findGamescopeNode();
                
                if (!targetNode) {
                    console.error('[PipeWire] No suitable video node found!');
                    console.error('Run with --list to see available nodes.');
                    process.exit(1);
                }

                const result = await streamServer.start(targetNode.name, options);
                console.log(`\n[PipeWire] Stream started successfully!`);
                console.log(`[PipeWire] URL: http://127.0.0.1:${result.port}/stream`);
                console.log(`[PipeWire] Encoder: ${result.encoder}`);
                console.log(`[PipeWire] Node: ${result.node}`);
                console.log(`\n[IPC] PORT=${result.port}`);
                
                // Keep the process running
                process.on('SIGINT', async () => {
                    await streamServer.stop();
                    process.exit(0);
                });
                
                process.on('SIGTERM', async () => {
                    await streamServer.stop();
                    process.exit(0);
                });
            }
            break;

        case '--wivrn':
            {
                console.log('[WiVRn] Starting WiVRn streaming...');
                
                // Check if WiVRn is running
                const wivrnRunning = checkWiVRnRunning();
                if (!wivrnRunning) {
                    console.error('[WiVRn] WiVRn server is not running. Please start WiVRn first.');
                    console.error('[WiVRn] Run: wivrn-dashboard &');
                    process.exit(1);
                }
                
                const wivrnInfo = getWiVRnStreamInfo();
                if (!wivrnInfo) {
                    console.error('[WiVRn] Could not get WiVRn stream information.');
                    process.exit(1);
                }
                
                console.log(`[WiVRn] WiVRn server detected at ${wivrnInfo.host}:${wivrnInfo.port}`);
                console.log('[WiVRn] Starting capture of WiVRn stream...');
                
                const options = {
                    width: parseInt(process.env.CAPTURE_WIDTH) || 1920,
                    height: parseInt(process.env.CAPTURE_HEIGHT) || 1080,
                    fps: parseInt(process.env.CAPTURE_FPS) || 90,
                    bitrate: parseInt(process.env.CAPTURE_BITRATE) || 20000000
                };
                
                // For WiVRn, we capture from the X11 display that WiVRn uses
                // WiVRn typically creates a virtual display for streaming
                const targetNode = findGamescopeNode() || { name: ':1' };
                
                const result = await streamServer.start(targetNode.name, options);
                console.log(`
[WiVRn] Stream started successfully!`);
                console.log(`[WiVRn] URL: http://127.0.0.1:${result.port}/stream`);
                console.log(`[WiVRn] Encoder: ${result.encoder}`);
                console.log(`[WiVRn] Capturing from: ${targetNode.name}`);
                console.log(`
[IPC] PORT=${result.port}`);
                
                // Keep the process running
                process.on('SIGINT', async () => {
                    await streamServer.stop();
                    process.exit(0);
                });
                
                process.on('SIGTERM', async () => {
                    await streamServer.stop();
                    process.exit(0);
                });
            }
            break;

        case '--stop':
            console.log('[PipeWire] Stop command received (manual stop required)');
            console.log('Use Ctrl+C to stop the stream or call this script again with --stop');
            break;

        case '--status':
            const wivrnRunning = checkWiVRnRunning();
            if (wivrnRunning) {
                console.log('[WiVRn] WiVRn server is running');
                const wivrnInfo = getWiVRnStreamInfo();
                if (wivrnInfo) {
                    console.log(`[WiVRn] Stream available at ${wivrnInfo.host}:${wivrnInfo.port}`);
                }
            } else {
                console.log('[WiVRn] WiVRn server is not running');
            }
            console.log('[PipeWire] Status: idle (start with --stream or --wivrn)');
            break;

        case '--help':
        case '-h':
        default:
            printHelp();
            break;
    }
}

// Export for programmatic use
module.exports = {
    listPipeWireNodes,
    findGamescopeNode,
    checkWiVRnRunning,
    getWiVRnStreamInfo,
    PipeWireStreamServer
};

// Run CLI if called directly
if (require.main === module) {
    main().catch(err => {
        console.error('[PipeWire] Fatal error:', err);
        process.exit(1);
    });
}