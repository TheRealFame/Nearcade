const express = require('express');
const { spawn, exec } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);

const REPO_ROOT = path.resolve(__dirname, '../..');
const WIVRN_SERVER_BIN = process.env.WIVRN_SERVER_BIN || path.join(REPO_ROOT, 'bin/wivrn-server');
const WIVRNCTL_BIN = process.env.WIVRNCTL_BIN || path.join(REPO_ROOT, 'bin/wivrnctl');
const BRIDGE_BIN = process.env.BRIDGE_BIN || path.join(REPO_ROOT, 'bin/wivrn_bridge');

app.use(express.static(path.join(__dirname, 'public')));

let currentPin = null;
let shuttingDown = false;
let bridgeProcess = null;
let wivrnProcess = null;
let startInFlight = false;
let respawnTimer = null;
const bridgeClients = new Set();

function stopBridge() {
    if (bridgeProcess) {
        bridgeProcess.kill('SIGTERM');
        bridgeProcess = null;
    }
    for (const client of bridgeClients) client.end();
    bridgeClients.clear();
    console.log('[Node] Bridge stopped.');
}

function ensureBridge() {
    if (bridgeProcess) return;
    console.log(`[Node] Launching WiVRn Bridge with PIN ${currentPin}...`);
    bridgeProcess = spawn(BRIDGE_BIN, [currentPin], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'inherit']
    });
    bridgeProcess.stdout.on('data', (chunk) => {
        // Multicast the single headset stream to every /stream client.
        for (const client of bridgeClients) {
            try { client.write(chunk); } catch (e) {}
        }
    });
    bridgeProcess.on('exit', () => {
        console.log('[Node] Bridge exited.');
        bridgeProcess = null;
        for (const client of bridgeClients) client.end();
        bridgeClients.clear();
    });
}

function startWivrnServer() {
    if (startInFlight) return;
    startInFlight = true;
    if (wivrnProcess) {
        wivrnProcess.kill('SIGKILL');
        wivrnProcess = null;
    }
    exec('killall wivrn-server 2>/dev/null; true', () => {
        currentPin = null;
        console.log('Spawning WiVRn server with --early-active-runtime...');
        wivrnProcess = spawn(WIVRN_SERVER_BIN, ['--early-active-runtime'], {
            env: { ...process.env, PRESSURE_VESSEL_IMPORT_OPENXR_1_RUNTIMES: '1', LIBVA_DRIVER_NAME: 'dummy' }
        });

    setTimeout(() => {
        exec(`${WIVRNCTL_BIN} pair`, (err, stdout) => {
            if (stdout) console.log(`[wivrnctl] ${stdout.trim()}`);
        });
    }, 1500);

    let pinBuffer = '';

    wivrnProcess.stdout.on('data', d => process.stdout.write(`[WiVRn] ${d}`));
    wivrnProcess.stderr.on('data', d => {
        const text = d.toString();
        process.stderr.write(`[WiVRn ERR] ${text}`);
        pinBuffer += text;
        const pinMatch = pinBuffer.match(/PIN code: (\d+)/);
        if (pinMatch && !currentPin) {
            currentPin = pinMatch[1];
            console.log(`\n[Node] Intercepted PIN code: ${currentPin}. Ready for browser connections!`);
            ensureBridge();
        }
    });

    // Fallback if no PIN is emitted
    setTimeout(() => {
        if (!currentPin) {
            currentPin = "000000";
            console.log(`\n[Node] No PIN intercepted. Assuming 000000...`);
        }
    }, 5000);

    // Auto-respawn: keeps the pipeline alive across bridge disconnects.
    // wivrn-server exits via quit_if_no_client() whenever the bridge drops and
    // no OpenXR client is attached; without a server the game gets
    // XR_ERROR_RUNTIME_UNAVAILABLE at xrCreateInstance and freezes forever.
    wivrnProcess.on('exit', (code, signal) => {
        startInFlight = false;
        wivrnProcess = null;
        console.log(`[Node] WiVRn server exited (code=${code}, signal=${signal}). ${shuttingDown ? '' : 'Respawning in 2s...'}`);
        if (shuttingDown) return;
        stopBridge();
        if (respawnTimer) clearTimeout(respawnTimer);
        respawnTimer = setTimeout(startWivrnServer, 2000);
    });
    }); // end exec('killall ...', cb)
}

// Start WiVRn server and intercept PIN
startWivrnServer();

// Endpoint to stream the bridged VR video
app.get('/stream', (req, res) => {
    if (!currentPin) {
        return res.status(503).send("WiVRn PIN not ready yet. Please try again in a moment.");
    }

    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Transfer-Encoding': 'chunked'
    });

    console.log(`[Node] Browser connected (${bridgeClients.size + 1} viewers).`);

    // One persistent bridge is shared (multicast) by all /stream clients.
    // Killing a bridge mid-session makes the WiVRn server pause the session
    // ("Socket shutdown, Session paused") and it never resumes.
    ensureBridge();

    bridgeClients.add(res);
    res.on('close', () => {
        bridgeClients.delete(res);
        console.log(`[Node] Browser disconnected (${bridgeClients.size} viewers left).`);
    });
});

const PORT = process.env.PORT || 8080;

// Close any previously running relay instance so `npm run vr:stream`
// always wins the port instead of failing with EADDRINUSE.
const previousRelay = exec(
    `for pid in $(lsof -ti tcp:${PORT} 2>/dev/null); do [ "$pid" != "$$" ] && kill "$pid" 2>/dev/null; done; true`
);
previousRelay.on('exit', () => {
    setTimeout(() => {
        server.listen(PORT, () => {
            console.log(`WiVRn relay running on http://localhost:${PORT}`);
        });
    }, 500);
});
