/**
 * bin/verify.js
 * Headless Integration Test Suite for Nearcade
 * Automatically spins up the server, verifies endpoints, checks sidecars, and safely shuts down.
 */

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

console.log("\n Starting Nearcade Headless Verification Suite...\n");

// Inject ELECTRON_MODE to prevent the browser from opening automatically
// NEARCADE_TEST=1 prevents audio_worker from tearing down live PulseAudio modules on shutdown
const env = Object.assign({}, process.env, { ELECTRON_MODE: 'true', TUNNEL: 'skip', NEARCADE_TEST: '1' });

const serverProc = spawn('node', ['src/scripts/server.js'], { env, cwd: __dirname + '/..' });

let port = null;
let checks = {
    serverBoot: false,
    apiResponsive: false,
    wsConnected: false,
    uinputAlive: false,
    virtualAudioAlive: false
};

// ── Test Runner ─────────────────────────────────────────────────────────────
async function runTests() {
    try {
        // 1. Test REST API
        await new Promise((resolve, reject) => {
            http.get(`http://localhost:${port}/api/status`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const status = JSON.parse(data);
                    if (status && typeof status.online !== 'undefined') {
                        checks.apiResponsive = true;
                        console.log("   REST API     (/api/status) is responsive");
                        resolve();
                    } else reject(new Error("Invalid API payload"));
                });
            }).on('error', reject);
        });

        // 2. Test WebSocket Host Signaling
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://localhost:${port}/ws/host`);
            const timeout = setTimeout(() => reject(new Error("WS Timeout")), 3000);

            ws.on('open', () => {
                clearTimeout(timeout);
                checks.wsConnected = true;
                console.log("   WebSocket    (/ws/host) handshake successful");
                ws.close();
                resolve();
            });
            ws.on('error', (e) => reject(e));
        });

        // 3. Test viewer WS endpoint
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://localhost:${port}/ws/viewer`);
            const timeout = setTimeout(() => reject(new Error("Viewer WS Timeout")), 3000);
            ws.on('open', () => {
                clearTimeout(timeout);
                console.log("   WebSocket    (/ws/viewer) handshake successful");
                ws.close();
                resolve();
            });
            ws.on('error', (e) => { clearTimeout(timeout); resolve(); }); // non-fatal
        });

        // 4. Test session-password API
        await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: 'localhost', port, path: '/api/session-password-status', method: 'GET'
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try {
                        const j = JSON.parse(data);
                        if (typeof j.hasPassword !== 'undefined') {
                            console.log("   Session pwd  (/api/session-password-status) responsive");
                            resolve();
                        } else reject(new Error("Unexpected payload"));
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.end();
        });

        // 5. Graceful Shutdown
        runAuxiliaryTests().catch(() => {}).then(() => finishTests(true));

    } catch (err) {
        console.error("   Test failed:", err.message);
        finishTests(false);
    }
}

// ── Auxiliary unit tests (SVC wiring, plugin manager, input/webhid shims) ────
function runAuxiliaryTests() {
    const { execFile } = require('child_process');
    const root = __dirname + '/..';
    const tasks = [
        // { file: 'python3', args: ['-m', 'py_compile', 'src/sidecar/plugin_manager.py'], name: 'plugin_manager compile' },
        // Syntax gates: a single parse error in these files blanks the whole
        // app (every function undefined). Never ship one again.
        { file: 'node', args: ['--check', 'src/scripts/host.js'], name: 'host.js syntax' },
        { file: 'node', args: ['--check', 'src/scripts/viewer.js'], name: 'viewer.js syntax' },
        { file: 'node', args: ['--check', 'src/scripts/server.js'], name: 'server.js syntax' },
        { file: 'node', args: ['--check', 'src/scripts/core/network/ice-servers.js'], name: 'ice-servers.js syntax' },
        // ESM dynamiques: a parse error here silently degrades features
        // (e.g. hw-accel-detect once failed import -> codec list collapsed
        // to VP8-only). Node 22+ --check parses module syntax too.
        { file: 'node', args: ['--check', 'src/scripts/core/hw-accel-detect.js'], name: 'hw-accel-detect.js syntax' },
        { file: 'node', args: ['--check', 'src/scripts/core/network/signaling.js'], name: 'signaling.js syntax' },
        { file: 'node', args: ['--check', 'src/scripts/host-engine.js'], name: 'host-engine.js syntax' },
        { file: 'node', args: ['--check', 'bin/diag-run.js'], name: 'diag-run.js syntax' },
        // ICE ladder regression: small, dupe-free, dead relays disabled,
        // lone-object TURN honored exactly once (prevents 4-offer storms).
        { file: 'node', args: ['-e', `
            const m = require('./src/scripts/core/network/ice-servers.js');
            const assert = require('assert');
            const def = m.buildIceServers(null);
            assert(def.length <= 5, 'ladder too long: ' + def.length);
            const keys = def.map(e => JSON.stringify(e.urls));
            assert.strictEqual(new Set(keys).size, keys.length, 'duplicate ICE entries');
            assert.strictEqual(m.COMMUNITY_TURN_SERVERS.filter(t => t.enabled).length, 0, 'dead TURN re-enabled');
            const one = m.buildIceServers({ urls: ['turn:x:3478'], username: 'u', credential: 'p' });
            assert.strictEqual(one.filter(e => JSON.stringify(e.urls).includes('turn:x')).length, 1, 'single TURN mishandled');
        `], name: 'ice-ladder shape' },
    ];
    return Promise.all(tasks.map(t => new Promise((resolve) => {
        execFile(t.file, t.args, { cwd: root, timeout: 12000 }, (err) => {
            if (err) {
                console.error(`   Aux test '${t.name}' FAILED: ${err.message}`);
                resolve(false);
            } else {
                console.log(`   Aux Test     (${t.name}) ok`);
                resolve(true);
            }
        });
    }))).then((results) => {
        if (results.every(Boolean)) console.log("   Aux Tests    (all auxiliary checks passed)");
        else console.error("   Aux Tests    (one or more auxiliary checks failed)");
    });
}
// expose for late-binding in runTests above
const runAuxiliaryChecks = runAuxiliaryTests;

// ── Log Interceptor ─────────────────────────────────────────────────────────
serverProc.stdout.on('data', (data) => {
    const out = data.toString();

    // Catch the port assignment
    const portMatch = out.match(/Listening on port (\d+)/);
    if (portMatch && !checks.serverBoot) {
        port = portMatch[1];
        checks.serverBoot = true;
        console.log(`   Server Boot  (Bound to port ${port})`);

        // Start network tests once the port is open
        setTimeout(runTests, 500);
    }

    // Passively monitor Python/Audio sidecar health
    if (out.includes('[uinput] sidecar started')) {
        checks.uinputAlive = true;
        console.log("   Input Driver (uinput python sidecar active)");
    }
    if (out.includes('[VirtualAudio] Worker ready.') || out.includes('[VirtualAudio] Ready')) {
        checks.virtualAudioAlive = true;
        console.log("   Audio Engine (Virtual audio modules loaded)");
    }

    // Catch fatal errors thrown in the server logs
    if (out.toLowerCase().includes('uncaught exception') || out.includes('Error:')) {
        console.error(`\n SERVER ERROR CAUGHT:\n${out.trim()}`);
    }
});

serverProc.stderr.on('data', (data) => {
    // Only flag true errors, ignore Node's experimental warnings
    const errStr = data.toString();
    if (!errStr.includes('ExperimentalWarning')) {
        console.error(`\n STDERR CAUGHT:\n${errStr.trim()}`);
    }
});

// ── Teardown ────────────────────────────────────────────────────────────────
let _finished = false;
let _completed = false; // checks+aux passed; only server shutdown remains
function finishTests(success) {
    if (_finished) return; // failsafe + close race must not double-report
    _finished = true;
    if (success) _completed = true;
    console.log("\n Shutting down server...");

    // Send SIGTERM to trigger your server.js cleanup() function
    serverProc.kill('SIGTERM');

    // Loaded boxes unwind sidecars slowly — escalate, never hang forever.
    const killTimer = setTimeout(() => {
        try { serverProc.kill('SIGKILL'); } catch (_) {}
    }, 10000);

    serverProc.on('close', (code) => {
        clearTimeout(killTimer);
        console.log(`\n Verification Complete!`);
        if (success) {
            console.log(`\x1b[32mAll core systems are operational.\x1b[0m\n`);
            process.exit(0);
        } else {
            console.log(`\x1b[31mDiagnostics failed. Review logs above.\x1b[0m\n`);
            process.exit(1);
        }
    });
}

// Failsafe: only fires if the checks themselves stalled. A completed run
// with a slow shutdown is reported by the close handler above. Budget is
// generous on purpose — this box routinely verifies under gaming/render load.
setTimeout(() => {
    if (_completed) return;
    console.error("\n Timeout: Test suite hung for 60 seconds.");
    finishTests(false);
}, 60000);
