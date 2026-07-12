#!/usr/bin/env node
/**
 * src/sidecar/wivrn-integration.js
 * WiVRn integration layer for Nearcade
 *
 * Manages the WiVRn server lifecycle and communicates with it via
 * D-Bus (session bus, io.github.wivrn.Server). The server publishes
 * properties (headset status, bitrate, PIN) and accepts methods
 * (Disconnect, Quit, EnablePairing, SetClientTab) over D-Bus.
 */

'use strict';

const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class WiVRnIntegration {
    constructor() {
        this._wivrnServerProc = null;
        this._wivrnStatus = 'stopped';
        this._headsetConnected = false;
        this._sessionRunning = false;
        this._streaming = false;
        this._currentGame = null;
        this._pin = '';
    }

    _findServerBinary() {
        const candidates = [
            path.join(__dirname, '..', '..', 'bin', 'wivrn-server'),
            path.join(__dirname, '..', '..', 'src', 'tools', 'wivrn-src', 'build', 'server', 'wivrn-server'),
            '/usr/local/bin/wivrn-server',
            '/usr/bin/wivrn-server',
            path.join(os.homedir(), '.local', 'bin', 'wivrn-server'),
        ];
        for (const p of candidates) {
            try { if (fs.existsSync(p)) return p; } catch (_) {}
        }
        return null;
    }

    _dbusCall(methodArgs) {
        try {
            const result = execSync(`dbus-send --session --print-reply ${methodArgs}`, {
                encoding: 'utf8', timeout: 3000
            });
            return result;
        } catch (_) {
            return null;
        }
    }

    _dbusGetProperty(property) {
        const output = this._dbusCall(
            `--dest=io.github.wivrn.Server /io/github/wivrn/Server org.freedesktop.DBus.Properties.Get string:"io.github.wivrn.Server" string:"${property}"`
        );
        if (!output) return null;
        if (output.includes('boolean true')) return true;
        if (output.includes('boolean false')) return false;
        const strMatch = output.match(/string\s+"([^"]*)"/);
        if (strMatch) return strMatch[1];
        const intMatch = output.match(/uint32\s+(\d+)/);
        if (intMatch) return parseInt(intMatch[1], 10);
        return output.trim();
    }

    _isServerOnBus() {
        const output = this._dbusCall(
            '--dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:"io.github.wivrn.Server"'
        );
        return output && output.includes('boolean true');
    }

    async checkInstalled() {
        try {
            if (this._findServerBinary()) return true;
            try {
                execSync('flatpak list | grep -i wivrn', { stdio: 'pipe' });
                return true;
            } catch (_) {}
            return false;
        } catch (_) {
            return false;
        }
    }

    async startServer(options = {}) {
        if (this._wivrnServerProc) {
            return { ok: false, message: 'WiVRn server already running' };
        }

        if (this._isServerOnBus()) {
            this._wivrnStatus = 'ready';
            this._refreshStatus();
            return { ok: true, message: 'WiVRn server already on D-Bus (reused)', status: this._wivrnStatus };
        }

        try {
            const installed = await this.checkInstalled();
            if (!installed) {
                return { ok: false, message: 'WiVRn not installed. Run bin/build_wivrn.sh to build it.' };
            }

            const binary = this._findServerBinary();
            let command, args;

            if (binary) {
                command = binary;
                args = ['--no-manage-active-runtime'];
                if (options.bitrate) args.push('--bitrate', String(options.bitrate));
                if (options.resolution) args.push('--resolution', options.resolution);
                if (options.framerate) args.push('--framerate', String(options.framerate));
            } else {
                command = 'flatpak';
                args = ['run', 'io.github.wivrn.wivrn', 'wivrn-server'];
            }

            this._wivrnServerProc = spawn(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true,
                env: { ...process.env, WIVRN_SUPPRESS_PIN_POPUP: '1' }
            });

            this._wivrnServerProc.stdout.on('data', (data) => {
                const message = data.toString();
                console.log(`[WiVRn] ${message.trim()}`);
                if (message.includes('PIN code:')) {
                    const pinMatch = message.match(/PIN code:\s*(\d+)/);
                    if (pinMatch) this._pin = pinMatch[1];
                }
            });

            this._wivrnServerProc.stderr.on('data', (data) => {
                console.error(`[WiVRn] ${data.toString().trim()}`);
            });

            this._wivrnServerProc.on('close', (code) => {
                console.log(`[WiVRn] Server process exited with code ${code}`);
                this._wivrnStatus = 'stopped';
                this._wivrnServerProc = null;
            });

            this._wivrnStatus = 'starting';

            let attempts = 0;
            while (attempts < 10) {
                await new Promise(resolve => setTimeout(resolve, 500));
                if (this._isServerOnBus()) {
                    this._wivrnStatus = 'ready';
                    this._refreshStatus();
                    return { ok: true, message: 'WiVRn server started', status: this._wivrnStatus };
                }
                attempts++;
            }

            this._wivrnStatus = 'unknown';
            return { ok: true, message: 'WiVRn server process launched (D-Bus not yet detected)', status: this._wivrnStatus };
        } catch (err) {
            this._wivrnStatus = 'stopped';
            return { ok: false, message: err.message };
        }
    }

    _refreshStatus() {
        const hc = this._dbusGetProperty('HeadsetConnected');
        const sr = this._dbusGetProperty('SessionRunning');
        const pin = this._dbusGetProperty('Pin');
        if (hc !== null) this._headsetConnected = hc;
        if (sr !== null) this._sessionRunning = sr;
        if (pin !== null && typeof pin === 'string') this._pin = pin;
    }

    async stopServer() {
        if (!this._wivrnServerProc && !this._isServerOnBus()) {
            return { ok: true, message: 'WiVRn server not running' };
        }

        try {
            if (this._isServerOnBus()) {
                this._dbusCall('--dest=io.github.wivrn.Server /io/github/wivrn/Server io.github.wivrn.Server.Quit');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (this._wivrnServerProc) {
                try { this._wivrnServerProc.kill('SIGTERM'); } catch (_) {}
                await new Promise(resolve => setTimeout(resolve, 500));
                if (this._wivrnServerProc && !this._wivrnServerProc.killed) {
                    try { this._wivrnServerProc.kill('SIGKILL'); } catch (_) {}
                }
                this._wivrnServerProc = null;
            }

            this._wivrnStatus = 'stopped';
            this._headsetConnected = false;
            this._sessionRunning = false;
            this._pin = '';
            return { ok: true, message: 'WiVRn server stopped' };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    }

    async launchSteamVRGame(appId) {
        try {
            const launchOptions = this._generateLaunchOptions();
            const gameProc = spawn('steam', ['steam://rungameid/' + appId, launchOptions], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            gameProc.stdout.on('data', (d) => console.log(`[SteamVR] ${d.toString().trim()}`));
            gameProc.stderr.on('data', (d) => console.error(`[SteamVR] ${d.toString().trim()}`));
            this._currentGame = appId;
            this._streaming = true;
            return { ok: true, message: `SteamVR game ${appId} launched`, process: gameProc };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    }

    _generateLaunchOptions() {
        const interfaces = os.networkInterfaces();
        let localIp = '127.0.0.1';
        for (const iface of Object.values(interfaces)) {
            for (const obj of iface) {
                if (obj.family === 'IPv4' && !obj.internal) {
                    localIp = obj.address; break;
                }
            }
            if (localIp !== '127.0.0.1') break;
        }
        return `wivrn+udp://${localIp}`;
    }

    getStatus() {
        this._refreshStatus();
        return {
            server: this._wivrnStatus,
            headsetConnected: this._headsetConnected,
            sessionRunning: this._sessionRunning,
            streaming: this._streaming,
            currentGame: this._currentGame,
            pin: this._pin,
        };
    }

    async checkHeadsetConnected() {
        this._refreshStatus();
        return this._headsetConnected;
    }

    async getVersion() {
        try {
            const binary = this._findServerBinary();
            if (binary) {
                const result = execSync(`${binary} --version 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
                return result.trim() || 'unknown';
            }
            if (this._isServerOnBus()) {
                return '26.6.1 (flatpak)';
            }
            return 'unknown';
        } catch (_) {
            return 'unknown';
        }
    }

    async setBitrate(bps) {
        if (!this._isServerOnBus()) return false;
        const result = this._dbusCall(
            `--dest=io.github.wivrn.Server /io/github/wivrn/Server org.freedesktop.DBus.Properties.Set string:"io.github.wivrn.Server" string:"Bitrate" variant:uint32:${bps}`
        );
        return result !== null;
    }

    async enablePairing(durationSecs = 120) {
        if (!this._isServerOnBus()) return null;
        const result = this._dbusCall(
            `--dest=io.github.wivrn.Server /io/github/wivrn/Server io.github.wivrn.Server.EnablePairing int32:${durationSecs}`
        );
        if (result) {
            const match = result.match(/string\s+"(\d+)"/);
            return match ? match[1] : null;
        }
        return null;
    }

    async disconnectHeadset() {
        if (!this._isServerOnBus()) return false;
        this._dbusCall('--dest=io.github.wivrn.Server /io/github/wivrn/Server io.github.wivrn.Server.Disconnect');
        return true;
    }

    async setClientTab(tab) {
        if (!this._isServerOnBus()) return false;
        const valid = ['hidden', 'overlay_only', 'compact', 'stats', 'settings', 'bitrate_settings', 'foveation_settings', 'applications', 'application_launcher'];
        if (!valid.includes(tab)) return false;
        this._dbusCall(`--dest=io.github.wivrn.Server /io/github/wivrn/Server io.github.wivrn.Server.SetClientTab string:"${tab}"`);
        return true;
    }

    async injectVirtualTracking(head, left, right, leftTrigger, leftGrip, rightTrigger, rightGrip, leftButtons, rightButtons) {
        if (!this._isServerOnBus()) return { ok: false, message: 'WiVRn server not on D-Bus' };
        function poseTuple(p) {
            const d = (v, fallback) => ((v ?? fallback) || 0).toFixed(6);
            return `(${d(p.qx,0)},${d(p.qy,0)},${d(p.qz,0)},${d(p.qw,1)},${d(p.px,0)},${d(p.py,0)},${d(p.pz,0)})`;
        }
        const args = [
            'gdbus', 'call', '--session',
            '--dest', 'io.github.wivrn.Server',
            '--object-path', '/io/github/wivrn/Server',
            '--method', 'io.github.wivrn.Server.InjectVirtualTracking',
            poseTuple(head),
            poseTuple(left),
            poseTuple(right),
            String(leftTrigger),
            String(leftGrip),
            String(rightTrigger),
            String(rightGrip),
            String(leftButtons),
            String(rightButtons),
        ];
        try {
            const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 1000 });
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error(result.stderr || `exit code ${result.status}`);
            return { ok: true };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    }

    cleanup() {
        if (this._wivrnServerProc) {
            try { this._wivrnServerProc.kill(); } catch (_) {}
            this._wivrnServerProc = null;
        }
        this._wivrnStatus = 'stopped';
        this._headsetConnected = false;
        this._sessionRunning = false;
        this._streaming = false;
        this._currentGame = null;
        this._pin = '';
    }
}

module.exports = new WiVRnIntegration();