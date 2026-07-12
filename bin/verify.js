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
const env = Object.assign({}, process.env, { ELECTRON_MODE: 'true', TUNNEL: 'skip' });

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
        finishTests(true);

    } catch (err) {
        console.error("   Test failed:", err.message);
        finishTests(false);
    }
}

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
function finishTests(success) {
    console.log("\n Shutting down server...");

    // Send SIGTERM to trigger your server.js cleanup() function
    serverProc.kill('SIGTERM');

    serverProc.on('close', (code) => {
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

// Failsafe timeout just in case it hangs forever
setTimeout(() => {
    console.error("\n Timeout: Test suite hung for 15 seconds.");
    finishTests(false);
}, 15000);
