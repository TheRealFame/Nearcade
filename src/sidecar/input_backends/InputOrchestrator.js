const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const dgram = require('dgram');

// ── Visualizer event bus — host.js listens on inputDriver.events ──────────────
const events = new EventEmitter();

// ── Shared Buffers for Zero-Copy Native C++ Submission ──
// Buffer layout MUST match uinputBridge.cpp exactly.
// GAMEPAD packet (16 bytes):
//   [0]     = 0x01 (PKT::GAMEPAD)
//   [1-2]   = lx  (int16LE)
//   [3-4]   = ly  (int16LE)
//   [5-6]   = rx  (int16LE)
//   [7-8]   = ry  (int16LE)
//   [9]     = lt  (uint8, 0-255)
//   [10]    = rt  (uint8, 0-255)
//   [11-12] = btn (uint16LE, C++ W3C_BTN bit format)
//   [13]    = hx  (int8, dpad X: -1/0/1)
//   [14]    = hy  (int8, dpad Y: -1/0/1)
//   [15]    = slot (uint8)
const _gpBuf = Buffer.alloc(16);
const _alBuf = Buffer.alloc(104);
const _flBuf = Buffer.alloc(2);
const _frBuf = Buffer.alloc(2);
const _vrBuf = Buffer.alloc(203);

_alBuf[0] = 0x10; // PKT::ALLOC_GP
_flBuf[0] = 0x20; // PKT::FLUSH
_frBuf[0] = 0x11; // PKT::FREE_GP
_vrBuf[0] = 0x30; // PKT::VR

// ── Button Bitmask Converter ───────────────────────────────────────────────────
// The viewer.js uses the KBM_BTN_MAP bit layout. The C++ bridge uses a different
// W3C_BTN enum. This function converts between the two AND extracts dpad as hx/hy
// (the C++ bridge uses ABS_HAT0X/Y for dpad, not button bits).
//
// JS viewer bit layout:         C++ W3C_BTN layout:
//   bit 0  = A                    bit 0  = A       (BTN_SOUTH)
//   bit 1  = B                    bit 1  = B       (BTN_EAST)
//   bit 2  = X                    bit 2  = *Y-slot (BTN_WEST = X physical)
//   bit 3  = Y                    bit 3  = *X-slot (BTN_NORTH = Y physical)
//   bit 4  = D-Up   → hx/hy      bit 4  = LB      (BTN_TL)
//   bit 5  = D-Down → hx/hy      bit 5  = RB      (BTN_TR)
//   bit 6  = D-Left → hx/hy      bit 8  = BACK    (BTN_SELECT)
//   bit 7  = D-Right→ hx/hy      bit 9  = START   (BTN_START)
//   bit 8  = LB → C++ bit 4      bit 10 = LS      (BTN_THUMBL)
//   bit 9  = RB → C++ bit 5      bit 11 = RS      (BTN_THUMBR)
//   bit 10 = L3                   (* C++ X/Y naming is swapped but emits correctly)
//   bit 11 = R3
//   bit 12 = START → C++ bit 9
//   bit 13 = SELECT → C++ bit 8
//   bit 14 = GUIDE (C++ reads uint16 so bit16 unreachable — skip)
//   isSwitchProfile: when true, swaps A<->B and X<->Y before conversion.
//   Nintendo's physical face-button layout is rotated relative to Xbox —
//   the button in the Xbox "A" position is physically "B" on a real Switch
//   Pro Controller, and the Xbox "X" position is physically "Y". Swapping
//   here (once, at the JS bit level) makes the emitted uinput device match
//   what a real Switch Pro Controller would report for the same physical
//   button, so touch controls feel correct when a session is emulating one.
function _isSwitchProfile(profileKey) {
    return profileKey === 'switchpro' || profileKey === 'switch' || profileKey === 'nintendo';
}

function _jsBtnsToCpp(jsBtns, profileKey) {
    let cpp = 0;
    let faceBits = jsBtns & 0x000F;
    if (_isSwitchProfile(profileKey)) {
        const a = faceBits & 0x0001, b = faceBits & 0x0002;
        const x = faceBits & 0x0004, y = faceBits & 0x0008;
        faceBits = (b ? 0x0001 : 0) | (a ? 0x0002 : 0) | (y ? 0x0004 : 0) | (x ? 0x0008 : 0);
    }
    // A, B, X, Y — bits 0-3 pass through (C++ X/Y label swap is intentional, emits correctly)
    cpp |= faceBits;
    // LB: JS bit8 → C++ bit4
    if (jsBtns & 0x0100) cpp |= 0x0010;
    // RB: JS bit9 → C++ bit5
    if (jsBtns & 0x0200) cpp |= 0x0020;
    // L3: JS bit10 → C++ bit10 (unchanged)
    if (jsBtns & 0x0400) cpp |= 0x0400;
    // R3: JS bit11 → C++ bit11 (unchanged)
    if (jsBtns & 0x0800) cpp |= 0x0800;
    // START: JS bit12 → C++ bit9
    if (jsBtns & 0x1000) cpp |= 0x0200;
    // SELECT/BACK: JS bit13 → C++ bit8
    if (jsBtns & 0x2000) cpp |= 0x0100;
    // GUIDE: JS bit14 → C++ bit16 — uint16 can't hold bit16, skip

    // Dpad bits 4-7 → ABS_HAT values written to [13][14] in the buffer
    const hx = (jsBtns & 0x0040) ? -1 : (jsBtns & 0x0080) ? 1 : 0;  // LEFT / RIGHT
    const hy = (jsBtns & 0x0010) ? -1 : (jsBtns & 0x0020) ? 1 : 0;  // UP / DOWN
    return { cpp, hx, hy };
}

// ── State ──────────────────────────────────────────────────────────────────────
const viewerSlots = new Map();
const slotViewers = new Map();
const viewerCtrlType = new Map(); // maps padId -> profileKey
const viewerHostSlots = new Map(); // maps padId -> requested slot (0..15)

// KBM Emulation State
const kbmStates = new Map();

// Tracks millisecond activity for Auto-Eviction
const slotLastUsed = new Map();

let _bridge = null;
let _pythonProc = null;
let _udpSocket = null;
let _pythonUdpPort = 0;

// HIDMaestro backend toggle — set before init()
let _hidmaestroEnabled = false;
function setHidMaestroEnabled(enabled) {
    _hidmaestroEnabled = !!enabled;
}

let _windowsExperimentalEnabled = false;
function setWindowsExperimentalEnabled(enabled) {
    _windowsExperimentalEnabled = !!enabled;
}

let GAME_PROFILES = {};
let KBM_BINDINGS = { keys: {}, mouse: { sensitivity: 1.5, deadzone: 0.1 } };

// Global default profile key — updated whenever the host broadcasts ctrl-settings.
// This ensures all newly allocated slots inherit the host's chosen controller type
// rather than always falling back to xbox360.
let _defaultProfileKey = 'xbox360';
let _hybridInputEnabled = false;

// ── Window-title CSV detection (cross-platform) ────────────────────────────────
let _csvKbmEntries = [];        // [{frag, binds}] — loaded from game_profiles.csv 17-col format
let _activeWindowBinds = null;  // current CSV binds (or null)
let _lastWindowTitle = '';

const _EMULATOR_FRAGS = new Set([
    'ryujinx', 'yuzu', 'eden', 'ryubang', 'ryujinx-avalonia',
    'dolphin', 'pcsx2', 'rpcs3', 'ppsspp', 'duckstation',
    'retroarch', 'mame', 'mame64', 'final burn', 'fbneo',
    'steam', 'citra', 'cemu', 'vita3k', 'xenia', 'melonds', 'mgba',
    'project64', 'mupen64plus', 'simple64',
]);

const _GAME_FRAGS_REQUIRE_EMU = new Set([
    'super smash',
    'super smash bros melee',
    'super smash bros brawl',
    'for nintendo 3ds',
    'for wii u',
]);

const CSV_KEYS = [
    'KEY_W', 'KEY_A', 'KEY_S', 'KEY_D',
    'KEY_SPACE', 'KEY_J', 'KEY_K', 'KEY_L',
    'KEY_U', 'KEY_I', 'KEY_O', 'KEY_P',
    'KEY_M', 'KEY_N', 'KEY_ENTER', 'KEY_TAB', 'KEY_ESCAPE',
];

function _loadKbmCSV() {
    try {
        const pth = path.join(__dirname, '..', '..', '..', 'config', 'game_profiles.csv');
        if (!fs.existsSync(pth)) return;
        const data = fs.readFileSync(pth, 'utf8');
        const entries = [];
        for (const line of data.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const cols = trimmed.split(',');
            const frag = cols[0]?.trim().toLowerCase();
            if (!frag) continue;
            const binds = {};
            for (let i = 0; i < CSV_KEYS.length; i++) {
                const col = i + 1;
                if (col < cols.length) {
                    const val = cols[col]?.trim();
                    if (val && (val.startsWith('BTN_') || val.startsWith('ABS_') || val.startsWith('KEY_'))) {
                        binds[CSV_KEYS[i]] = val;
                    }
                }
            }
            if (Object.keys(binds).length) entries.push({ frag, binds });
        }
        _csvKbmEntries = entries;
        console.log(`[input] CSV KBM bindings loaded: ${entries.length} profiles`);
    } catch (e) {
        console.warn('[input] Failed to load CSV KBM bindings:', e.message);
    }
}

function _resolveWindowTitle(title) {
    if (!title) return null;
    const tl = title.toLowerCase();
    let emuMatch = null;
    let gameMatch = null;

    for (const entry of _csvKbmEntries) {
        if (!tl.includes(entry.frag)) continue;
        if (_EMULATOR_FRAGS.has(entry.frag)) {
            emuMatch = entry.binds;
        } else if (_GAME_FRAGS_REQUIRE_EMU.has(entry.frag)) {
            gameMatch = entry.binds;
        } else {
            return entry.binds;
        }
    }

    if (gameMatch && emuMatch) return gameMatch;
    if (emuMatch) return emuMatch;
    return null;
}

function _handleWindowFocus(title) {
    if (isWin && !_windowsExperimentalEnabled) return;
    
    if (title === _lastWindowTitle) return;
    _lastWindowTitle = title;
    const binds = _resolveWindowTitle(title);
    if (binds) {
        _activeWindowBinds = binds;
        // Switch all viewers to kbm_emulated mode
        for (const [vid, mode] of viewerModes) {
            if (mode !== 'kbm_emulated' && mode !== 'kbm') {
                viewerModes.set(vid, 'kbm_emulated');
            }
        }
        console.log(`[input] CSV match '${title}' → kbm_emulated (${Object.keys(binds).length} binds)`);
    } else if (_activeWindowBinds) {
        _activeWindowBinds = null;
        console.log(`[input] No CSV match for '${title}' — clearing window binds`);
    }
}


const KBM_BTN_MAP = {
    'A': 0x0001, 'B': 0x0002, 'X': 0x0004, 'Y': 0x0008,
    'UP': 0x0010, 'DOWN': 0x0020, 'LEFT': 0x0040, 'RIGHT': 0x0080,
    'LB': 0x0100, 'RB': 0x0200, 'L3': 0x0400, 'R3': 0x0800,
    'START': 0x1000, 'SELECT': 0x2000, 'GUIDE': 0x4000
};

const BUTTON_ALIASES = {
    BTN_SOUTH: 'A', BTN_EAST: 'B', BTN_WEST: 'X', BTN_NORTH: 'Y',
    BTN_TL: 'LB', BTN_TR: 'RB', BTN_TL2: 'LT', BTN_TR2: 'RT',
    BTN_SELECT: 'SELECT', BTN_START: 'START',
    BTN_THUMBL: 'L3', BTN_THUMBR: 'R3',
    BTN_DPAD_UP: 'UP', BTN_DPAD_DOWN: 'DOWN', BTN_DPAD_LEFT: 'LEFT', BTN_DPAD_RIGHT: 'RIGHT'
};

const PROFILES = {
    xbox360: { vendor: 0x045E, product: 0x028E, version: 0x0114, name: "Microsoft X-Box 360 pad" },
    xbox: { vendor: 0x045E, product: 0x028E, version: 0x0114, name: "Microsoft X-Box 360 pad" },
    xboxone: { vendor: 0x045E, product: 0x02EA, version: 0x0301, name: "Microsoft X-Box One S pad" },
    ds4: { vendor: 0x054C, product: 0x05C4, version: 0x8111, name: "Sony Computer Entertainment Wireless Controller" },
    ps4: { vendor: 0x054C, product: 0x05C4, version: 0x8111, name: "Sony Computer Entertainment Wireless Controller" },
    playstation: { vendor: 0x054C, product: 0x05C4, version: 0x8111, name: "Sony Computer Entertainment Wireless Controller" },
    dualshock4: { vendor: 0x054C, product: 0x05C4, version: 0x8111, name: "Sony Computer Entertainment Wireless Controller" },
    dualsense: { vendor: 0x054C, product: 0x0CE6, version: 0x8111, name: "Sony Interactive Entertainment Wireless Controller" },
    switchpro: { vendor: 0x0500, product: 0x2009, version: 0x8111, name: "Nintendo Switch Pro Controller" },
    switch: { vendor: 0x0500, product: 0x2009, version: 0x8111, name: "Nintendo Switch Pro Controller" },
    nintendo: { vendor: 0x0500, product: 0x2009, version: 0x8111, name: "Nintendo Switch Pro Controller" }
};

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Resiliency feature toggles
let decayEnabled = true;
let tournamentMode = false;
let lastPacketTime = new Map();
let lastPacketSequence = new Map();
let lastGamepadVars = new Map();

function init(screenWidth, screenHeight) {
    _loadProfiles();
    _loadKbmCSV();

    // On Windows and macOS the uinputBridge C++ addon is Linux-only.
    // Skip it entirely and go straight to the Python sidecar.
    if (!isWin && !isMac) {
        // 1. Try Native C++ Fast Lane (Linux only)
        // .node binaries cannot be require()'d from inside app.asar — must use the unpacked path.
        try {
            const nodePathRaw = path.join(__dirname, 'build', 'Release', 'uinputBridge.node');
            const nodePath = nodePathRaw.replace('app.asar', 'app.asar.unpacked');
            _bridge = require(nodePath);
            _bridge.initializeDevice(screenWidth || 1920, screenHeight || 1080);
            console.log(`[input] Native uinputBridge loaded: ${nodePath}`);
            return true;
        } catch (e) {
            console.warn(`[input] Native bridge failed to load (${e.message}). Falling back to Python.`);
            _bridge = null;
        }
    } else if (isWin) {
        console.log('[input] Windows detected — skipping uinputBridge, using Python/' + (_hidmaestroEnabled ? 'HIDMaestro' : 'ViGEmBus') + ' sidecar.');
    } else {
        console.log('[input] macOS detected — skipping uinputBridge, using Python/pynput sidecar.');
    }
    
    _udpSocket = dgram.createSocket('udp4');
    _udpSocket.on('error', (err) => {
        console.error('[input] UDP socket error:\n' + err.stack);
        _udpSocket.close();
    });

    // 2. Python/Native Sidecar — platform-aware script selection
    let scriptBase;
    if (isWin) scriptBase = _hidmaestroEnabled ? 'windows_hidmaestro' : 'windows_vigem';
    else if (isMac) scriptBase = 'mac_gamepad_bridge';
    else scriptBase = 'linux_uinput';

    const binExt = isWin ? '.exe' : (isMac ? '.bin' : '.bin');
    const binaryPathRaw = path.join(__dirname, 'bin', scriptBase + binExt);
    const binaryPath = binaryPathRaw.replace('app.asar', 'app.asar.unpacked');

    const pythonScriptRaw = path.join(__dirname, scriptBase + '.py');
    const pythonScript = pythonScriptRaw.replace('app.asar', 'app.asar.unpacked');

    if (fs.existsSync(binaryPath)) {
        console.log(`[input] Native binary detected! Spawning: ${binaryPath}`);
        _pythonProc = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
        if (!fs.existsSync(pythonScript)) {
            console.error(`[input] FATAL: Sidecar not found at ${pythonScript}`);
            return false;
        }
        let pythonCmd = isWin ? 'python' : 'python3';
        let extraArgs = [];
        if (isWin) {
            const { execSync } = require('child_process');
            const candidates = [ {c: 'py', a: ['-3']}, {c: 'python', a: []}, {c: 'python3', a: []} ];
            for (const cand of candidates) {
                try {
                    execSync(`${cand.c} ${cand.a.join(' ')} --version`, { stdio: 'ignore', windowsHide: true });
                    pythonCmd = cand.c;
                    extraArgs = cand.a;
                    break;
                } catch (e) { }
            }
        }
        const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
        if (isWin) spawnOpts.windowsHide = true;
        _pythonProc = spawn(pythonCmd, [...extraArgs, pythonScript], spawnOpts);
    }

    _pythonProc.stderr.on('data', (chunk) => {
        const s = chunk.toString('utf8').trim();
        if (s) console.error('[input][python stderr]', s);
    });

    // Parse stdout from the Python sidecar as JSON lines.
    // The sidecar emits structured { "type": "...", "message": "..." } payloads
    // so we can detect ViGEmBus driver failures and surface them to the Electron UI.
    let _stdoutBuf = '';
    _pythonProc.stdout.on('data', (chunk) => {
        _stdoutBuf += chunk.toString('utf8');
        const lines = _stdoutBuf.split('\n');
        _stdoutBuf = lines.pop(); // keep incomplete last line in buffer
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Try JSON first
            try {
                const msg = JSON.parse(trimmed);
                if (msg.type === 'error') {
                    console.error(`[input][python] ${msg.message}`);
                    events.emit('input-error', { message: msg.message, code: msg.code || 'PYTHON_ERROR' });
                } else if (msg.type === 'ready') {
                    console.log('[input][python] Sidecar ready:', msg.message || '');
                    events.emit('input-ready', { message: msg.message });
                } else if (msg.type === 'udp_ready') {
                    _pythonUdpPort = msg.udp_port;
                    console.log(`[input][python] UDP listening on port ${_pythonUdpPort}`);
                } else if (msg.type === 'log') {
                    console.log('[input][python]', msg.message);
                } else if (msg.type === 'rumble') {
                    // Python sidecar detected an EV_FF event on the uinput device.
                    // Forward it through events so server.js can route it to the viewer.
                    events.emit('rumble', {
                        viewerId: msg.viewerId || '',
                        strong:   msg.strong   || 0,
                        weak:     msg.weak     || 0,
                        duration: msg.duration || 200,
                    });
                }
            } catch (_) {
                // Plain string log — pass through
                console.log('[input][python]', trimmed);
                // Still try to detect ViGEmBus errors in plain text output
                if (trimmed.toLowerCase().includes('vigembus') || trimmed.toLowerCase().includes('vigem')) {
                    events.emit('input-error', { message: trimmed, code: 'VIGEMBUS_MISSING' });
                }
            }
        }
    });

    _pythonProc.on('error', e => {
        console.error('[uinput] Python spawn error:', e.message);
        events.emit('input-error', { message: `Python sidecar failed to start: ${e.message}`, code: 'SPAWN_ERROR' });
    });
    _pythonProc.on('close', (code) => {
        _pythonProc = null;
        console.log(`[uinput] Python sidecar exited (code ${code})`);
        if (code !== 0 && code !== null) {
            events.emit('input-error', { message: `Python sidecar exited with code ${code}`, code: 'SIDECAR_EXIT' });
        }
    });

    console.log(`[input] Python sidecar started: ${pythonScript}`);
    return true;
}

function _loadProfiles() {
    try {
        const pth = path.join(__dirname, '..', '..', '..', 'config', 'game_profiles.csv');
        if (fs.existsSync(pth)) {
            const lines = fs.readFileSync(pth, 'utf8').split('\n');
            lines.forEach(line => {
                const [title, ctrl, kbm, hybrid] = line.split(',').map(s => s?.trim());
                if (title && ctrl) GAME_PROFILES[title.toLowerCase()] = { ctrl, kbm, hybrid: hybrid === 'true' };
            });
            console.log(`[input] CSV database loaded ${Object.keys(GAME_PROFILES).length} profiles.`);
        }
    } catch (e) { console.warn('[input] Failed to load CSV:', e.message); }

    try {
        const pth = path.join(__dirname, '..', '..', '..', 'config', 'kbm_bindings.json');
        if (fs.existsSync(pth)) {
            KBM_BINDINGS = JSON.parse(fs.readFileSync(pth, 'utf8'));
            console.log('[input] JSON KBM fallback loaded.');
        }
    } catch (e) { console.warn('[input] Failed to load KBM JSON:', e.message); }
}

// ── Slot Allocator & LRU Garbage Collection ────────────────────────────────────
function _allocateSlot(viewerId, profileKey) {
    if (viewerSlots.has(viewerId)) {
        const s = viewerSlots.get(viewerId);
        slotLastUsed.set(s, Date.now());
        return s;
    }

    if (viewerHostSlots.has(viewerId)) {
        const requestedSlot = viewerHostSlots.get(viewerId);
        _claimSlot(requestedSlot, viewerId, profileKey);
        return requestedSlot;
    }

    for (let i = 0; i < 16; i++) {
        if (!slotViewers.has(i)) {
            _claimSlot(i, viewerId, profileKey);
            return i;
        }
    }

    // SLOTS FULL: Evict oldest inactive controller
    let oldestSlot = -1;
    let oldestTime = Infinity;
    for (let i = 0; i < 16; i++) {
        const t = slotLastUsed.get(i) || 0;
        if (t < oldestTime) {
            oldestTime = t;
            oldestSlot = i;
        }
    }

    if (oldestSlot >= 0) {
        console.warn(`[input] Slot limit reached. Auto-evicting inactive slot ${oldestSlot}`);
        const owner = slotViewers.get(oldestSlot);
        _freeSlot(owner);
        _claimSlot(oldestSlot, viewerId, profileKey);
        return oldestSlot;
    }

    console.error('[input] FATAL: No free gamepad slots available');
    return -1;
}

function _claimSlot(slotIndex, viewerId, profileKey) {
    viewerSlots.set(viewerId, slotIndex);
    slotViewers.set(slotIndex, viewerId);
    slotLastUsed.set(slotIndex, Date.now());

    // Resolve the best profile: per-viewer override → host global default → xbox360
    const resolvedKey = profileKey || viewerCtrlType.get(viewerId) || _defaultProfileKey || 'xbox360';

    if (_pythonProc) {
        try {
            _pythonProc.stdin.write(JSON.stringify({ type: 'allocate_slot', pad_id: viewerId, slot: slotIndex, profile: resolvedKey }) + '\n');
        } catch (_) {}
    }

    if (!_bridge) return; // Python handles its own slots

    const profile = PROFILES[resolvedKey] || PROFILES.xbox360;
    _alBuf[1] = slotIndex;
    _alBuf.writeUInt16LE(profile.vendor, 2);
    _alBuf.writeUInt16LE(profile.product, 4);
    _alBuf.writeUInt16LE(profile.version, 6);
    _alBuf.fill(0, 8, 104);
    Buffer.from(profile.name).copy(_alBuf, 8, 0, Math.min(31, profile.name.length));
    Buffer.from(viewerId).copy(_alBuf, 40, 0, Math.min(63, viewerId.length));

    _bridge.submitInputPacket(_alBuf);
    console.log(`[input] ALLOC slot ${slotIndex} for ${viewerId} as ${resolvedKey} (${profile.name})`);
}

function _freeSlot(viewerId) {
    const slot = viewerSlots.get(viewerId);
    if (slot === undefined) return;

    if (_pythonProc) {
        try {
            _pythonProc.stdin.write(JSON.stringify({ type: 'free_slot', pad_id: viewerId, slot: slot }) + '\n');
        } catch (_) {}
    }

    if (_bridge) {
        _flBuf[1] = slot;
        _bridge.submitInputPacket(_flBuf);
        _frBuf[1] = slot;
        _bridge.submitInputPacket(_frBuf);
    }

    viewerSlots.delete(viewerId);
    slotViewers.delete(slot);
    slotLastUsed.delete(slot);
    kbmStates.delete(viewerId);
}

// ── Emulation Handlers ─────────────────────────────────────────────────────────
function _handleGamepad(msg) {
    const viewerId = msg.pad_id;
    if (!viewerId) return;

    if (!_bridge && !_pythonProc) return;

    lastGamepadVars.set(viewerId, {
        buttons: msg.buttons || 0,
        lt: msg.lt || 0,
        rt: msg.rt || 0
    });

    const profileKey = viewerCtrlType.get(viewerId) || _defaultProfileKey || 'xbox360';
    const slotIndex = _allocateSlot(viewerId, profileKey);
    console.log(`[DEBUG GAMEPAD] Viewer ${viewerId} allocated slot ${slotIndex}`);
    if (slotIndex < 0) return;

    if (!_bridge) return;

    // Convert JS viewer bitmask to C++ W3C_BTN format and extract dpad as hx/hy
    // (profileKey enables the Switch Pro A/B, X/Y swap for this viewer's session)
    const { cpp: cppBtns, hx, hy } = _jsBtnsToCpp(msg.buttons || 0, profileKey);

    // Write packet in the EXACT layout uinputBridge.cpp expects.
    // axes arrive as int16 (-32767..+32767) from the normalizer — write directly.
    // lt/rt arrive as 0..1 floats from the normalizer — scale to 0..255.
    _gpBuf[0] = 0x01;
    _gpBuf.writeInt16LE(Math.max(-32767, Math.min(32767, msg.lx || 0)), 1);
    _gpBuf.writeInt16LE(Math.max(-32767, Math.min(32767, msg.ly || 0)), 3);
    _gpBuf.writeInt16LE(Math.max(-32767, Math.min(32767, msg.rx || 0)), 5);
    _gpBuf.writeInt16LE(Math.max(-32767, Math.min(32767, msg.ry || 0)), 7);
    _gpBuf[9] = Math.round(Math.max(0, Math.min(1, msg.lt || 0)) * 255);
    _gpBuf[10] = Math.round(Math.max(0, Math.min(1, msg.rt || 0)) * 255);
    _gpBuf.writeUInt16LE(cppBtns, 11);
    _gpBuf.writeInt8(hx, 13);
    _gpBuf.writeInt8(hy, 14);
    _gpBuf[15] = slotIndex;

    _bridge.submitInputPacket(_gpBuf);
    events.emit('input-packet', {
        source: 'gamepad', viewerId, slotIndex,
        buttons: msg.buttons || 0,
        lt: msg.lt || 0, rt: msg.rt || 0,
        lx: msg.lx || 0, ly: msg.ly || 0,
        rx: msg.rx || 0, ry: msg.ry || 0,
    });
}

function _emitKbmBinding(padId, key, isDown, binds) {
    const isFlat = typeof Object.values(binds)[0] === 'string';
    const slotIdx = viewerSlots.get(padId);
    if (slotIdx === undefined) return;

    // Grab or initialize the persistent state for this KBM user
    let state = kbmStates.get(padId);
    if (!state) {
        state = { buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0, hx: 0, hy: 0, lt: 0, rt: 0 };
        kbmStates.set(padId, state);
    }

    if (isFlat) {
        const target = binds[key];
        if (!target) return;

        const aliasMap = { BTN_SOUTH: 'BTN_A', BTN_EAST: 'BTN_B', BTN_NORTH: 'BTN_X', BTN_WEST: 'BTN_Y' };
        const resolved = aliasMap[target] || target;

        if (resolved.startsWith('BTN_')) {
            // Map Linux BTN_ names to the JS KBM_BTN_MAP bit positions
            const btnBit = {
                BTN_A: 0x0001, BTN_B: 0x0002, BTN_X: 0x0004, BTN_Y: 0x0008,
                BTN_TL: 0x0100, BTN_TR: 0x0200,
                BTN_SELECT: 0x2000, BTN_START: 0x1000,
                BTN_THUMBL: 0x0400, BTN_THUMBR: 0x0800,
                BTN_MODE: 0x4000,
            }[resolved];

            if (btnBit !== undefined) {
                if (isDown) state.buttons |= btnBit;
                else state.buttons &= ~btnBit;
            } else if (resolved === 'BTN_TL2') {
                state.lt = isDown ? 1.0 : 0.0;
            } else if (resolved === 'BTN_TR2') {
                state.rt = isDown ? 1.0 : 0.0;
            }
        } else if (resolved.startsWith('ABS_')) {
            // Apply axis values
            if (resolved === 'ABS_Y_UP') state.ly = isDown ? -32767 : 0;
            if (resolved === 'ABS_Y_DOWN') state.ly = isDown ? 32767 : 0;
            if (resolved === 'ABS_X_LEFT') state.lx = isDown ? -32767 : 0;
            if (resolved === 'ABS_X_RIGHT') state.lx = isDown ? 32767 : 0;
        }
    } else {
        // Nested JSON logic
        const btnTarget = binds.buttons?.[key];
        if (btnTarget) {
            const btnBit = { BTN_A: 0x0001, BTN_B: 0x0002, BTN_X: 0x0004, BTN_Y: 0x0008 }[btnTarget];
            if (btnBit !== undefined) {
                if (isDown) state.buttons |= btnBit;
                else state.buttons &= ~btnBit;
            }
        }
        for (const section of ['left_stick', 'dpad']) {
            const m = binds[section]?.[key];
            if (m) {
                if (m.axis === 'ABS_X') state.lx = isDown ? m.val : 0;
                if (m.axis === 'ABS_Y') state.ly = isDown ? m.val : 0;
            }
        }
    }

    // Now send the FULL PERSISTENT STATE to the C++ module using correct buffer layout
    _gpBuf.fill(0, 0, 16);
    _gpBuf[0] = 0x01; // PKT::GAMEPAD
    // state.buttons uses the JS KBM_BTN_MAP format — convert before writing
    const { cpp: cppBtns, hx: kbmHx, hy: kbmHy } = _jsBtnsToCpp(state.buttons);
    // Axes in _emitKbmBinding are already in -32767..+32767 integer range
    _gpBuf.writeInt16LE(state.lx || 0, 1);
    _gpBuf.writeInt16LE(state.ly || 0, 3);
    _gpBuf.writeInt16LE(state.rx || 0, 5);
    _gpBuf.writeInt16LE(state.ry || 0, 7);
    _gpBuf[9] = Math.round((state.lt || 0) * 255);
    _gpBuf[10] = Math.round((state.rt || 0) * 255);
    _gpBuf.writeUInt16LE(cppBtns, 11);
    _gpBuf.writeInt8(kbmHx, 13);
    _gpBuf.writeInt8(kbmHy, 14);
    _gpBuf[15] = slotIdx;

    if (_bridge && !_hybridInputEnabled) {
        _bridge.submitInputPacket(_gpBuf);
    } else if (_pythonUdpPort > 0 && _udpSocket) {
        _udpSocket.send(_gpBuf, 0, 16, _pythonUdpPort, '127.0.0.1');
    }
}

function _handleKbm(msg) {
    const viewerId = msg.pad_id || (msg.viewerId + '_0');
    if (!viewerId) return;

    const profileKey = viewerCtrlType.get(viewerId) || _defaultProfileKey || 'xbox360';
    const slotIndex = _allocateSlot(viewerId, profileKey);
    if (slotIndex < 0) {
        console.log(`[DEBUG KBM] _handleKbm dropped due to slotIndex < 0`);
        return;
    }

    // ── CSV window-title bindings take priority ────────────────────────────────
    if (_activeWindowBinds && (msg.event === 'keydown' || msg.event === 'keyup')) {
        _emitKbmBinding(viewerId, msg.key, msg.event === 'keydown', _activeWindowBinds);
        return;
    }

    let state = kbmStates.get(viewerId);
    if (!state) {
        state = { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0, keys: {} };
        kbmStates.set(viewerId, state);
    }

    // --- THE FIX: Built-in default layout matching viewer.js 'KEY_' prefix ---
    const defaultKeys = {
        'KEY_W': 'LS_UP', 'KEY_A': 'LS_LEFT', 'KEY_S': 'LS_DOWN', 'KEY_D': 'LS_RIGHT',
        'KEY_SPACE': 'A', 'KEY_L': 'B', 'KEY_J': 'X', 'KEY_K': 'Y',
        'KEY_U': 'LB', 'KEY_I': 'RB', 'KEY_O': 'LT', 'KEY_P': 'RT',
        'KEY_ENTER': 'START', 'KEY_TAB': 'SELECT', 'KEY_ESC': 'HOME',
        'KEY_M': 'L3', 'KEY_N': 'R3',
        'KEY_UP': 'UP', 'KEY_DOWN': 'DOWN', 'KEY_LEFT': 'LEFT', 'KEY_RIGHT': 'RIGHT'
    };

    let flatKeys = { ...defaultKeys };
    if (typeof KBM_BINDINGS !== 'undefined' && KBM_BINDINGS) {
        if (KBM_BINDINGS.buttons) {
            for (const [k, v] of Object.entries(KBM_BINDINGS.buttons)) {
                if (!v) continue;
                const normalized = String(v).trim().toUpperCase();
                flatKeys[k] = BUTTON_ALIASES[normalized] || normalized.replace(/^BTN_/, '');
            }
        }
        if (KBM_BINDINGS.left_stick) {
            for (const [k, v] of Object.entries(KBM_BINDINGS.left_stick)) {
                if (v.axis === 'ABS_Y') flatKeys[k] = v.val < 0 ? 'LS_UP' : 'LS_DOWN';
                if (v.axis === 'ABS_X') flatKeys[k] = v.val < 0 ? 'LS_LEFT' : 'LS_RIGHT';
            }
        }
        if (KBM_BINDINGS.right_stick) {
            for (const [k, v] of Object.entries(KBM_BINDINGS.right_stick)) {
                if (v.axis === 'ABS_RY') flatKeys[k] = v.val < 0 ? 'RS_UP' : 'RS_DOWN';
                if (v.axis === 'ABS_RX') flatKeys[k] = v.val < 0 ? 'RS_LEFT' : 'RS_RIGHT';
            }
        }
        if (KBM_BINDINGS.dpad) {
            for (const [k, v] of Object.entries(KBM_BINDINGS.dpad)) {
                if (v.axis === 'ABS_HAT0Y') flatKeys[k] = v.val < 0 ? 'UP' : 'DOWN';
                if (v.axis === 'ABS_HAT0X') flatKeys[k] = v.val < 0 ? 'LEFT' : 'RIGHT';
            }
        }
        if (KBM_BINDINGS.triggers) {
            for (const [k, v] of Object.entries(KBM_BINDINGS.triggers)) {
                flatKeys[k] = String(v).toUpperCase();
            }
        }
    }
    const layout = { keys: flatKeys, mouse: { sensitivity: KBM_BINDINGS?.right_stick_multiplier ? KBM_BINDINGS.right_stick_multiplier / 1000 : 1.5, deadzone: 0.1 } };

    if (msg.event === 'keydown' || msg.event === 'keyup') {
        // Try the loaded layout first, fallback to the hardcoded default
        const action = layout.keys[msg.key] || defaultKeys[msg.key];

        if (!action) {
            console.log(`[DEBUG KBM] _handleKbm dropped because ${msg.key} has no mapping action!`);
            return;
        }

        const isDown = (msg.event === 'keydown');

        // FIX: Ignore OS key-repeats. If it's already held down,
        // do not force a release or spam the bridge. Just let the game read the continuous hold.
        if (state.keys[action] === isDown) {
            return;
        }

        state.keys[action] = isDown;

        if (KBM_BTN_MAP[action]) {
            if (isDown) state.buttons |= KBM_BTN_MAP[action];
            else state.buttons &= ~KBM_BTN_MAP[action];
        } else if (action === 'LT') {
            state.lt = isDown ? 1.0 : 0.0;
        } else if (action === 'RT') {
            state.rt = isDown ? 1.0 : 0.0;
        } else if (action.startsWith('LS_')) {
            // Revert back to -1.0 to 1.0 float range, because _sendKbmStateToBuffer multiplies by 32767
            state.lx = (state.keys['LS_RIGHT'] ? 1.0 : 0) - (state.keys['LS_LEFT'] ? 1.0 : 0);
            state.ly = (state.keys['LS_DOWN'] ? 1.0 : 0) - (state.keys['LS_UP'] ? 1.0 : 0);
        } else if (action.startsWith('RS_')) {
            state.rx = (state.keys['RS_RIGHT'] ? 1.0 : 0) - (state.keys['RS_LEFT'] ? 1.0 : 0);
            state.ry = (state.keys['RS_DOWN'] ? 1.0 : 0) - (state.keys['RS_UP'] ? 1.0 : 0);
        }
    }
    else if (msg.event === 'mousemove') {
        const mult = KBM_BINDINGS?.right_stick_multiplier || 1500;
        const deadzone = 0.1; // 10% deadzone

        // Python matched formula: (dx * mult) / 32767.0 to fit into the -1.0 to 1.0 float range expected by _sendKbmStateToBuffer
        let dx = (msg.dx * mult) / 32767.0;
        let dy = (msg.dy * mult) / 32767.0;

        dx = Math.max(-1.0, Math.min(1.0, dx));
        dy = Math.max(-1.0, Math.min(1.0, dy));

        if (Math.abs(dx) < deadzone) dx = 0;
        if (Math.abs(dy) < deadzone) dy = 0;

        state.rx = dx;
        state.ry = dy;

        if (state.resetTimer) clearTimeout(state.resetTimer);
        state.resetTimer = setTimeout(() => {
            state.rx = 0;
            state.ry = 0;
            if (typeof _sendKbmStateToBuffer === 'function') _sendKbmStateToBuffer(slotIndex, state);
        }, 32); // 32ms matches the old Python timeout
    }

    if (typeof _sendKbmStateToBuffer === 'function') {
        console.log(`[DEBUG KBM] calling _sendKbmStateToBuffer: lx=${state.lx}, ly=${state.ly}, buttons=${state.buttons}`);
        _sendKbmStateToBuffer(slotIndex, state);
    }
}

// Ensure this helper function exists right below _handleKbm
function _sendKbmStateToBuffer(slotIndex, state) {
    if (!_bridge && !(_pythonUdpPort > 0)) return;

    // state.buttons uses JS KBM_BTN_MAP format — convert to C++ W3C_BTN and extract dpad
    const { cpp: cppBtns, hx, hy } = _jsBtnsToCpp(state.buttons);

    _gpBuf[0] = 0x01;
    // KBM lx/ly/rx/ry are -1..1 floats; scale to int16 range for C++
    _gpBuf.writeInt16LE(Math.round((state.lx || 0) * 32767), 1);
    _gpBuf.writeInt16LE(Math.round((state.ly || 0) * 32767), 3);
    _gpBuf.writeInt16LE(Math.round((state.rx || 0) * 32767), 5);
    _gpBuf.writeInt16LE(Math.round((state.ry || 0) * 32767), 7);
    _gpBuf[9] = Math.round((state.lt || 0) * 255);
    _gpBuf[10] = Math.round((state.rt || 0) * 255);
    _gpBuf.writeUInt16LE(cppBtns, 11);
    _gpBuf.writeInt8(hx, 13);
    _gpBuf.writeInt8(hy, 14);
    _gpBuf[15] = slotIndex;

    if (_bridge && !_hybridInputEnabled) {
        _bridge.submitInputPacket(_gpBuf);
    } else if (_pythonUdpPort > 0 && _udpSocket) {
        _udpSocket.send(_gpBuf, 0, 16, _pythonUdpPort, '127.0.0.1');
    }
    events.emit('input-packet', {
        source: 'kbm', slotIndex,
        buttons: state.buttons,
        lt: state.lt, rt: state.rt,
        lx: state.lx, ly: state.ly,
        rx: state.rx, ry: state.ry,
    });
}

function _handleVr(msg) {
    if (!_udpSocket) return;
    const h = msg.head || {};
    const l = msg.left || {};
    const r = msg.right || {};

    _vrBuf[0] = 0x30;
    
    // Head pose
    _vrBuf.writeDoubleLE(h.qx || 0, 1);
    _vrBuf.writeDoubleLE(h.qy || 0, 9);
    _vrBuf.writeDoubleLE(h.qz || 0, 17);
    _vrBuf.writeDoubleLE(h.qw || 1, 25);
    _vrBuf.writeDoubleLE(h.px || 0, 33);
    _vrBuf.writeDoubleLE(h.py || 0, 41);
    _vrBuf.writeDoubleLE(h.pz || 0, 49);
    
    // Left pose
    _vrBuf.writeDoubleLE(l.qx || 0, 57);
    _vrBuf.writeDoubleLE(l.qy || 0, 65);
    _vrBuf.writeDoubleLE(l.qz || 0, 73);
    _vrBuf.writeDoubleLE(l.qw || 1, 81);
    _vrBuf.writeDoubleLE(l.px || 0, 89);
    _vrBuf.writeDoubleLE(l.py || 0, 97);
    _vrBuf.writeDoubleLE(l.pz || 0, 105);
    
    // Right pose
    _vrBuf.writeDoubleLE(r.qx || 0, 113);
    _vrBuf.writeDoubleLE(r.qy || 0, 121);
    _vrBuf.writeDoubleLE(r.qz || 0, 129);
    _vrBuf.writeDoubleLE(r.qw || 1, 137);
    _vrBuf.writeDoubleLE(r.px || 0, 145);
    _vrBuf.writeDoubleLE(r.py || 0, 153);
    _vrBuf.writeDoubleLE(r.pz || 0, 161);
    
    _vrBuf.writeDoubleLE(Number(l.trigger) || 0, 169);
    _vrBuf.writeDoubleLE(Number(l.grip) || 0, 177);
    _vrBuf.writeDoubleLE(Number(r.trigger) || 0, 185);
    _vrBuf.writeDoubleLE(Number(r.grip) || 0, 193);
    
    _vrBuf.writeUInt8(Number(l.buttons) || 0, 201);
    _vrBuf.writeUInt8(Number(r.buttons) || 0, 202);
    
    _udpSocket.send(_vrBuf, 0, 203, 9758, '127.0.0.1');
}

// ── Dispatcher & Exports ──────────────────────────────────────────────────────
// ── Payload Schema Validation ─────────────────────────────────────────────────
// Malicious or corrupted viewer payloads can crash the C++ bridge or overflow
// integer buffers. Validate and clamp every field before it reaches the backend.
const MAX_PAYLOAD_BYTES = 4096;

function _clampAxis(val) {
    // Axes: -32767..+32767 as integers.
    let v = Number(val) || 0;
    // Fix viewers sending unscaled -1.0..1.0 floats
    if (v > -2.0 && v < 2.0 && !Number.isInteger(v)) v = v * 32767;
    return Math.max(-32767, Math.min(32767, Math.round(v)));
}
function _clampTrigger(val) {
    // Triggers: 0..1 float range
    let v = Number(val) || 0;
    // Fix viewers that mistakenly divided the 0..1 float by 255
    if (v > 0 && v < 0.004) v = v * 255.0;
    return Math.max(0, Math.min(1, v));
}
function _clampButtons(val) {
    // 16-bit bitmask. Strip 0x4000 (GUIDE/HOME button) so viewers cannot open system menus.
    const n = Number(val) || 0;
    return (n & 0xBFFF) >>> 0;
}
function _clampDelta(val) {
    // Mouse delta: sane screen range
    return Math.max(-4096, Math.min(4096, Number(val) || 0));
}

function _validateGamepadMsg(msg) {
    // Size guard: reject absurdly large objects
    try {
        if (JSON.stringify(msg).length > MAX_PAYLOAD_BYTES) return null;
    } catch (_) { return null; }

    return {
        type: 'gamepad',
        pad_id: String(msg.pad_id || msg.viewerId || '').slice(0, 64),
        viewer_id: String(msg.viewer_id || msg.viewerId || '').slice(0, 64),
        viewerId: String(msg.viewerId || '').slice(0, 64),
        buttons: _clampButtons(msg.buttons),
        lt: _clampTrigger(msg.lt),
        rt: _clampTrigger(msg.rt),
        lx: _clampAxis(msg.lx),
        ly: _clampAxis(msg.ly),
        rx: _clampAxis(msg.rx),
        ry: _clampAxis(msg.ry),
        history: Array.isArray(msg.history) ? msg.history : [],
        _ts: Number(msg._ts) || 0,
        axes: Array.isArray(msg.axes) ? msg.axes.map(_clampAxis) : [],
        btns: Array.isArray(msg.btns) ? msg.btns.map(b => ({ pressed: !!b.pressed, value: Math.max(0, Math.min(255, Number(b.value) || 0)) })) : []
    };
}

function _validateKbmMsg(msg) {
    try {
        if (JSON.stringify(msg).length > MAX_PAYLOAD_BYTES) return null;
    } catch (_) { return null; }

    const event = String(msg.event || '').slice(0, 32);
    if (!['keydown', 'keyup', 'mousemove', 'mousedown', 'mouseup'].includes(event)) return null;

    return {
        type: msg.type,
        pad_id: String(msg.pad_id || msg.viewerId || '').slice(0, 64),
        viewerId: String(msg.viewerId || '').slice(0, 64),
        event,
        key: String(msg.key || '').slice(0, 32),
        button: typeof msg.button === 'number' ? msg.button : undefined,
        dx: _clampDelta(msg.dx),
        dy: _clampDelta(msg.dy),
    };
}

function send(msg) {

    // ── Schema validation — drop malformed or oversized payloads silently ──────
    let validated = msg;
    if (msg.type === 'gamepad') {
        validated = _validateGamepadMsg(msg);
        if (!validated) {
            console.warn(`[DEBUG GP] DROPPED by validator — pad_id="${msg.pad_id}" lx=${msg.lx} btns=${msg.buttons}`);
            return; // drop
        }
    } else if (msg.type === 'kbm' || msg.type === 'keyboard') {
        validated = _validateKbmMsg(msg);
        if (!validated) return; // drop
    } else if (msg.type === 'vr') {
        validated = msg;
    }

    // Handle window-focus / game detection BEFORE routing to any backend
    if (msg.type === 'window-focus') {
        if (!_hybridInputEnabled) {
            _handleWindowFocus(msg.title);
        }
        return;
    }

    // Drop immediately if both backends are dead
    if (!_bridge && !_pythonProc) return;

    // Fallback passthrough to Python if Native module failed, OR if Hybrid Mode is explicitly enabled
    if ((!_bridge || _hybridInputEnabled) && _pythonProc && _pythonProc.stdin.writable) {
        try { _pythonProc.stdin.write(JSON.stringify(validated) + '\n'); } catch (e) { }

        // Ensure the input visualizer still works when using Python sidecar
        if (validated.type === 'gamepad') {
            events.emit('input-packet', {
                source: 'python_gamepad', viewerId: validated.viewer_id || validated.viewerId, slotIndex: 'PY',
                buttons: validated.buttons || 0,
                lt: validated.lt || 0, rt: validated.rt || 0,
                lx: validated.lx || 0, ly: validated.ly || 0,
                rx: validated.rx || 0, ry: validated.ry || 0,
            });
        }
        return;
    }

    if (validated.type === 'gamepad') {
        const pId = validated.pad_id;
        const lastSeq = lastPacketSequence.get(pId) || 0;
        
        if (validated.history && validated.history.length > 0) {
            validated.history.forEach(histMsg => {
                if (histMsg._ts && histMsg._ts > lastSeq) {
                    let v = _validateGamepadMsg(histMsg);
                    if (v) _handleGamepad(v);
                    lastPacketSequence.set(pId, histMsg._ts);
                }
            });
        }
        
        if (validated._ts && validated._ts > (lastPacketSequence.get(pId) || 0)) {
            _handleGamepad(validated);
            lastPacketSequence.set(pId, validated._ts);
            lastPacketTime.set(pId, Date.now()); 
        } else if (!validated._ts) {
            _handleGamepad(validated);
            lastPacketTime.set(pId, Date.now()); 
        }
    } else if (validated.type === 'kbm' || validated.type === 'keyboard') {
        console.log(`[DEBUG KBM] Orchestrator send() routing to _handleKbm`);
        _handleKbm(validated);
    } else if (validated.type === 'vr') {
        _handleVr(validated);
    } else if (msg.type === 'set-ctrl-type') {
        // Update per-viewer map AND the global default so new connections inherit the type
        if (msg.viewerId) viewerCtrlType.set(msg.viewerId, msg.ctrlType || 'xbox360');
        _defaultProfileKey = msg.ctrlType || 'xbox360';
    } else if (msg.type === 'ctrl-settings-hybrid') {
        _hybridInputEnabled = !!msg.enabled;
        console.log(`[input] Hybrid mode ${msg.enabled ? 'ENABLED: Routing via Python' : 'DISABLED: Restoring C++ bridge'}`);
    } else if (msg.type === 'force-slot') {
        const padId = msg.pad_id || (msg.viewerId + '_0');
        if (msg.slot == null || msg.slot === -1) {
            viewerHostSlots.delete(padId);
        } else {
            viewerHostSlots.set(padId, msg.slot);
        }
        if (viewerSlots.has(padId)) _freeSlot(padId);
    } else if (msg.type === 'set-input-mode') {
        viewerModes.set(msg.viewerId, msg.mode);
    } else if (msg.type === 'disconnect_viewer') {
        _freeSlot(msg.viewer_id);
    } else if (msg.type === 'tournament-mode') {
        tournamentMode = !!msg.enabled;
        console.log(`[input] Tournament mode set to ${tournamentMode}. Resiliency disabled if true.`);
    } else if (msg.type === 'flush_neutral') {
        const slot = viewerSlots.get(msg.viewer_id);
        if (slot !== undefined && _bridge) {
            _flBuf[1] = slot;
            _bridge.submitInputPacket(_flBuf);
        }
    } else if (msg.type === 'destroy_all') {
        destroy();
    }
}

const viewerSeq = new Map();

function _processBinaryFrame(viewerId, padId, slotIndex, buf, offset) {
    const jsBtns = buf.readUInt16LE(offset + 2);
    const profileKey = viewerCtrlType.get(padId) || viewerCtrlType.get(viewerId) || _defaultProfileKey || 'xbox360';
    const { cpp: cppBtns, hx, hy } = _jsBtnsToCpp(jsBtns, profileKey);
    
    // Confidence Decay tracking
    lastPacketTime.set(padId, Date.now());
    lastGamepadVars.set(padId, {
        buttons: jsBtns,
        lt: buf[offset + 12] / 255.0,
        rt: buf[offset + 13] / 255.0
    });

    _gpBuf[0] = 0x01;
    buf.copy(_gpBuf, 1, offset + 4, offset + 12);
    _gpBuf[9] = buf[offset + 12];
    _gpBuf[10] = buf[offset + 13];
    _gpBuf.writeUInt16LE(cppBtns, 11);
    _gpBuf.writeInt8(hx, 13);
    _gpBuf.writeInt8(hy, 14);
    _gpBuf[15] = slotIndex;
    
    if (_bridge && !_hybridInputEnabled) {
        _bridge.submitInputPacket(_gpBuf);
    } else if (_pythonUdpPort > 0 && _udpSocket) {
        _udpSocket.send(_gpBuf, 0, 16, _pythonUdpPort, '127.0.0.1');
    }
}

function sendBinary(viewerId, buf) {
    if (buf[0] !== 0x01) return; // Only GAMEPAD for now
    
    const padIndex = buf[1];
    const padId = viewerId + '_' + padIndex;
    const profileKey = viewerCtrlType.get(padId) || viewerCtrlType.get(viewerId) || _defaultProfileKey || 'xbox360';
    const slotIndex = _allocateSlot(padId, profileKey);
    if (slotIndex < 0) return;

    if (tournamentMode) {
        _processBinaryFrame(viewerId, padId, slotIndex, buf, 0);
        return;
    }

    const baseLen = 16;
    if (buf.byteLength >= baseLen) {
        const currentSeq = buf.readUInt16LE(14);
        const lastSeq = viewerSeq.get(padId) ?? (currentSeq - 1);
        const diff = (currentSeq - lastSeq) % 65535;

        if (diff > 0 && diff < 10) {
            // We missed packets! Reconstruct from history
            const numHistory = Math.floor((buf.byteLength - baseLen) / baseLen);
            const framesToProcess = [{ offset: 0, seq: currentSeq }];

            // History is ordered newest-first starting after baseLen
            for (let i = 0; i < numHistory; i++) {
                const offset = baseLen + (i * baseLen);
                const hSeq = buf.readUInt16LE(offset + 14);
                const hDiff = (hSeq - lastSeq) % 65535;
                if (hDiff > 0 && hDiff < diff) {
                    framesToProcess.unshift({ offset, seq: hSeq });
                }
            }

            for (const f of framesToProcess) {
                _processBinaryFrame(viewerId, padId, slotIndex, buf, f.offset);
            }
        } else if (diff !== 0) {
            // Out of order or massive jump, just process current
            _processBinaryFrame(viewerId, padId, slotIndex, buf, 0);
        }
        
        viewerSeq.set(padId, currentSeq);
    } else {
        // Legacy 14-byte frame
        _processBinaryFrame(viewerId, padId, slotIndex, buf, 0);
    }
}

function destroy() {
    for (const vid of viewerSlots.keys()) {
        _freeSlot(vid);
    }
    if (_bridge && _bridge.destroyDevice) {
        _bridge.destroyDevice();
    }
    if (_pythonProc) {
        if (_pythonProc.stdin?.writable) {
            _pythonProc.stdin.write(JSON.stringify({ type: 'destroy_all' }) + '\n');
        }
        _pythonProc.kill();
        _pythonProc = null;
    }
    console.log("[input] Orchestrator destroyed.");
}

function getViewerForSlot(slot) {
    return slotViewers.get(Number(slot)) || null;
}

// ── CONFIDENCE DECAY LOOP ────────────────────────────────────────────────────
setInterval(() => {
    if (!decayEnabled || tournamentMode) return;
    const now = Date.now();
    for (const padId of viewerSlots.keys()) {
        const lastT = lastPacketTime.get(padId) || 0;
        if (now - lastT > 60 && lastT !== 0) {
            const lastVars = lastGamepadVars.get(padId) || { buttons: 0, lt: 0, rt: 0 };
            const lastMask = typeof lastVars === 'number' ? lastVars : (lastVars.buttons || 0); 
            _handleGamepad({
                pad_id: padId, 
                buttons: lastMask, 
                lx: 0, ly: 0, rx: 0, ry: 0, 
                lt: lastVars.lt || 0, 
                rt: lastVars.rt || 0
            });
            // Prevent spamming the buffer
            lastPacketTime.set(padId, 0); 
        }
    }
}, 16);

module.exports = { init, send, sendBinary, destroy, events, getViewerForSlot, setHidMaestroEnabled, setWindowsExperimentalEnabled, get _bridge() { return _bridge; } };
