const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const isWin = process.platform === 'win32';
const _procs = new Map();

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
        'android': 'backend_android.py'
    };

    const scriptName = typeMap[msg.type];
    if (!scriptName) {
        return; // Not an experimental device we care about
    }

    let proc = _procs.get(msg.type);

    if (!proc) {
        const pythonScriptRaw = path.join(__dirname, scriptName);
        const pythonScript = pythonScriptRaw.replace('app.asar', 'app.asar.unpacked');
        
        if (!fs.existsSync(pythonScript)) {
            console.error(`[ExperimentalOrchestrator] FATAL: Python backend not found at ${pythonScript}`);
            return;
        }

        const pythonCmd = isWin ? 'python' : 'python3';
        const args = ['-u', pythonScript];
        if (scriptName === 'backend_eyetracking.py') args.push('--joystick');
        
        proc = spawn(pythonCmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
        console.log(`[ExperimentalOrchestrator] sidecar started for type: ${msg.type}`);
        
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
            proc.kill();
        }
    }
    _procs.clear();
    console.log("[ExperimentalOrchestrator] All experimental backends destroyed.");
}

module.exports = { send, destroy };
