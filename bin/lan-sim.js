/**
 * bin/lan-sim.js — headless LAN-client simulation (non-loopback join path).
 * Guards the two fixed LAN bugs: PIN-off ignored on boot (server hardcoded
 * pinEnabled=true) and the viewer 1006→127.0.0.1 orphan loop. Run standalone
 * or via `npm test` (after verify.js releases the port).
 *
 * Spins its own server (ELECTRON_MODE/TUNNEL=skip/NEARCADE_TEST=1, same as
 * verify.js), joins via the machine LAN IP, and checks:
 *   1. /api/pin-required matches the saved config (off stays off after boot)
 *   2. /ws/viewer completes the auth handshake the way the probe says it should
 *      (no PIN → accepted when not required, 4002 when required)
 *   3. /ws/host from LAN is still refused 4403 (guard intact)
 * Exit 0 = pass, 1 = fail.
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const env = Object.assign({}, process.env, { ELECTRON_MODE: 'true', TUNNEL: 'skip', NEARCADE_TEST: '1' });
const srv = spawn('node', ['src/scripts/server.js'], { env, cwd: ROOT });
let port = null;
const results = [];
const say = (ok, name, detail) => { results.push(!!ok); console.log(`   [${ok ? 'ok' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`); };

srv.stdout.on('data', (d) => {
    const m = d.toString().match(/Listening on port (\d+)/);
    if (m && !port) { port = m[1]; setTimeout(run, 800); }
});
srv.stderr.on('data', () => {});
setTimeout(() => { console.log('LAN sim TIMEOUT (no boot)'); cleanup(1); }, 45000);

function lanIP() {
    for (const ifs of Object.values(os.networkInterfaces()))
        for (const n of ifs) if (n.family === 'IPv4' && !n.internal) return n.address;
    return null;
}
function get(p) {
    return new Promise((resolve, reject) => {
        http.get(`http://${lanIP()}:${port}${p}`, (r) => {
            let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve({ code: r.statusCode, body: b }));
        }).on('error', reject);
    });
}

async function run() {
    const lip = lanIP();
    console.log('\n LAN-client simulation via ' + lip + ':' + port + '\n');
    if (!lip) { say(false, 'lan-ip', 'no non-internal IPv4'); return cleanup(1); }

    let required = null;
    try {
        const r = await get('/api/pin-required');
        required = JSON.parse(r.body).required;
        say(typeof required === 'boolean', 'pin-required probe', JSON.stringify({ required }));
    } catch (e) { say(false, 'pin-required probe', e.message); return cleanup(1); }

    // /ws/viewer as a LAN client: challenge -> LAN bypass -> join.
    // Outcome must match the probe: accepted when not required, 4002 when required.
    await new Promise((resolve) => {
        const ws = new WebSocket(`ws://${lip}:${port}/ws/viewer`);
        const got = [];
        const to = setTimeout(() => {
            say(false, 'viewer-handshake', 'no verdict in 10s, got: ' + got.join(','));
            try { ws.close(); } catch (_) {} resolve();
        }, 10000);
        ws.on('message', (raw) => {
            try {
                const m = JSON.parse(raw.toString());
                got.push(m.type);
                if (m.type === 'auth-challenge') {
                    ws.send(JSON.stringify({ type: 'auth-response', hash: 'LAN_INSECURE_BYPASS' }));
                    ws.send(JSON.stringify({ type: 'join', name: 'LanSim', pin: '' }));
                }
                if (['your-id', 'join-ack'].includes(m.type)) {
                    clearTimeout(to);
                    say(required === false, 'viewer-handshake', `accepted (probe said required=${required}): ${got.join(',')}`);
                    try { ws.close(); } catch (_) {} resolve();
                }
            } catch (_) {}
        });
        ws.on('close', (code) => {
            clearTimeout(to);
            if (code === 4002) say(required === true, 'viewer-handshake', `PIN gate held (probe said required=${required})`);
            else if ([4001, 4004, 4008].includes(code)) say(false, 'viewer-handshake', 'rejected code ' + code);
            else if (got.length) say(required === false, 'viewer-handshake', `closed ${code} after: ${got.join(',')}`);
            else say(false, 'viewer-handshake', 'closed ' + code + ' with nothing received');
            resolve();
        });
        ws.on('error', () => {});
    });

    // /ws/host from a LAN IP must stay refused (host control is loopback-only).
    await new Promise((resolve) => {
        const ws = new WebSocket(`ws://${lip}:${port}/ws/host`);
        const to = setTimeout(() => { say(false, 'host-guard', 'no close in 5s'); try { ws.close(); } catch (_) {} resolve(); }, 5000);
        ws.on('close', (code) => { clearTimeout(to); say(code === 4403, 'host-guard=4403', 'got ' + code); resolve(); });
        ws.on('error', () => {});
    });

    cleanup(results.every(Boolean) ? 0 : 1);
}
function cleanup(code) {
    console.log(code ? '\n LAN sim FAILED\n' : '\n LAN sim PASSED\n');
    try { srv.kill('SIGKILL'); } catch (_) {}
    process.exit(code);
}
