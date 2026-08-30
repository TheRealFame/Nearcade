const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const isWin = process.platform === 'win32';
const _procs = new Map();

// Maps type → whether it was enabled in the last ctrl-settings broadcast.
// Used to detect transitions from enabled → disabled.
const _lastEnabled = new Map();

function send(msg) {
    // If the device isn't known, just drop it.
    if (!msg || !msg.type) return;

    // Build the script name, e.g. "tablet" -> "backend_tablets.py"
    // We map the incoming WebSocket message type to the Python script name.
    const typeMap = {
        'tablet': 'backend_tablets.py',
        'hotas': 'backend_hotas.py',
        'guitar': 'backend_guitars.py',
        'balanceboard': 'backend_balanceboard.py',
        'eyetracking': 'backend_eyetracking.py',
        'lightgun': 'backend_lightguns.py',
        'adaptive': 'backend_adaptive.py',
        'android': 'backend_android.py',
        'webhid': 'backend_webhid.py',
        'virtualmic': 'backend_virtualmic.py',
        'host_delay': isWin ? 'backend_hostdelay_win.py' : 'backend_hostdelay.py'
    };

    const scriptName = typeMap[msg.type];
    if (!scriptName) {
        return; // Not an experimental device we care about
    }

    // Explicitly block hardware emulation processes if the host has not enabled them
    const gatedTypes = ['tablet', 'hotas', 'guitar', 'balanceboard', 'eyetracking', 'lightgun', 'adaptive', 'virtualmic', 'webhid'];
    if (gatedTypes.includes(msg.type)) {
        let isEnabled = false;
        if (global.expDevices && Array.isArray(global.expDevices)) {
            isEnabled = global.expDevices.some(d => {
                if (msg.type === 'eyetracking' && d.val === 'eye') return d.enabled;
                return d.val === msg.type && d.enabled;
            });
        }
        if (!isEnabled) {
            return;
        }
    }

    let proc = _procs.get(msg.type);

    if (!proc) {
        const basename = scriptName.replace('.py', '');
        const binExt = isWin ? '.exe' : '.bin';
        const binaryPathRaw = path.join(__dirname, '..', 'bin', basename + binExt);
        const binaryPath = binaryPathRaw.replace('app.asar', 'app.asar.unpacked');

        const pythonScriptRaw = path.join(__dirname, scriptName);
        const pythonScript = pythonScriptRaw.replace('app.asar', 'app.asar.unpacked');
        
        let args = [];
        if (scriptName === 'backend_eyetracking.py') args.push('--joystick');

        if (fs.existsSync(binaryPath)) {
            console.log(`[ExperimentalOrchestrator] Native binary detected! Spawning: ${binaryPath}`);
            proc = spawn(binaryPath, args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
        } else {
            if (!fs.existsSync(pythonScript)) {
                console.error(`[ExperimentalOrchestrator] FATAL: Python backend not found at ${pythonScript}`);
                return;
            }

            const pythonCmd = isWin ? 'python' : 'python3';
            proc = spawn(pythonCmd, ['-u', pythonScript, ...args], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
            console.log(`[ExperimentalOrchestrator] sidecar started for type: ${msg.type} via Python`);
        }
        
        proc.on('close', () => { _procs.delete(msg.type); });
        proc.on('error', () => { _procs.delete(msg.type); });
        
        _procs.set(msg.type, proc);
    }
    
    if (proc && proc.stdin.writable) {
        try { proc.stdin.write(JSON.stringify(msg) + '\n'); } catch (e) {}
    }
}

function destroy() {
    for (const [type, proc] of _procs.entries()) {
        if (proc) {
            try { proc.stdin.end(); } catch (e) {}
            setTimeout(() => {
                try { proc.kill(); } catch (e) {}
            }, 500);
        }
    }
    _procs.clear();
    console.log("[ExperimentalOrchestrator] All experimental backends destroyed.");
}

/**
 * Called whenever the host broadcasts a ctrl-settings change.
 * Kills any running sidecar whose module is no longer enabled, so its
 * virtual uinput devices are released and don't ghost the host roster.
 * @param {Array<{val: string, enabled: boolean}>} expDevices
 */
function syncEnabled(expDevices) {
    if (!Array.isArray(expDevices)) return;

    const nowEnabled = new Set(
        expDevices.filter(d => d.enabled).map(d => d.val)
    );

    // The expDevices list only manages specific hardware emulators
    const gatedTypes = ['tablet', 'hotas', 'guitar', 'balanceboard', 'eyetracking', 'lightgun', 'adaptive', 'virtualmic', 'webhid'];

    // Kill processes for gated types that just became disabled
    for (const [type] of _procs.entries()) {
        if (!gatedTypes.includes(type)) continue;

        const wasEnabled = _lastEnabled.get(type) !== false; // treat unknown as enabled
        const isEnabled  = nowEnabled.has(type);
        if (wasEnabled && !isEnabled) {
            const proc = _procs.get(type);
            if (proc) {
                console.log(`[ExperimentalOrchestrator] '${type}' disabled — terminating sidecar.`);
                try { proc.stdin.end(); } catch (e) {}
                setTimeout(() => { try { proc.kill(); } catch (e) {} }, 500);
            }
            // _procs entry cleared by the 'close' handler
        }
    }

    // Record current state for the next diff
    for (const d of expDevices) {
        _lastEnabled.set(d.val, d.enabled);
    }
}

module.exports = { send, destroy, syncEnabled };
