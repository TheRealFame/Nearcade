#!/usr/bin/env node
// Import the community SDL2 GameControllerDB (gabomdq/SDL_GameControllerDB) into
// Nearcade's config/controllers.json. Converts per-device lefttrigger / righttrigger /
// rightx / righty mappings into Nearcade's lt/rt/rsx/rsy override schema.
// Usage:
//   node config/import-sdl2-controllers.js [path-to-gamecontrollerdb.txt] [--platform linux|windows|mac|all]
// Default source: https://raw.githubusercontent.com/gabomdq/SDL_GameControllerDB/master/gamecontrollerdb.txt
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_FILE = path.join(__dirname, 'controllers.json');
const SOURCE_URL = 'https://raw.githubusercontent.com/gabomdq/SDL_GameControllerDB/master/gamecontrollerdb.txt';

function fetch(url) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); res.resume(); return; }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => (data += c));
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// SDL2 GUID: data[0]=bus(0x03 USB / 0x05 BT / 0x06 virt), data[4..7]=VID LE, data[8..11]=PID LE
function guidToVidPid(guid) {
    const hex = guid.trim();
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
    const b = (i) => parseInt(hex.substr(i * 2, 2), 16);
    const vid = (b(5) << 8) | b(4);
    const pid = (b(9) << 8) | b(8);
    return { vid, pid };
}

const DEFAULT_MAP = { lt: { type: 'btn', idx: 6 }, rt: { type: 'btn', idx: 7 }, rsx: 2, rsy: 3 };

function fieldToTrigger(field) {
    if (!field) return null;
    const v = field.replace(/^[+-]/, '');
    if (v[0] === 'b' && /^\d+$/.test(v.slice(1))) return { type: 'btn', idx: Number(v.slice(1)) };
    if (v[0] === 'a' && /^\d+$/.test(v.slice(1))) return { type: 'axis', idx: Number(v.slice(1)) };
    return null; // hats (hX.Y) and other weird forms are unsupported
}

function fieldToAxis(field) {
    if (!field) return null;
    const v = field.replace(/^[+-]/, '');
    if (v[0] === 'a' && /^\d+$/.test(v.slice(1))) return Number(v.slice(1));
    return null;
}

function parseLine(line) {
    const parts = line.split(',');
    if (parts.length < 2) return null;
    const guid = parts[0].trim();
    const name = parts[1].trim();
    const fields = {};
    let platform = null;
    for (let i = 2; i < parts.length; i++) {
        const t = parts[i].trim();
        if (!t) continue;
        const eq = t.indexOf(':');
        if (eq === -1) continue;
        const k = t.slice(0, eq);
        const v = t.slice(eq + 1);
        if (k === 'platform') platform = v.toLowerCase();
        else fields[k] = v;
    }
    const vp = guidToVidPid(guid);
    if (!vp || !name) return null;
    return { vid: vp.vid, pid: vp.pid, name, fields, platform };
}

// Browser Gamepad API ALWAYS exposes the STANDARD axis layout:
//   0,1 = left stick, 2,3 = right stick, 4,5 = L2/R2 (where analog)
// with L2/R2 also present as buttons 6/7 (analog .value).
// SDL GameControllerDB entries carry the OS/evdev RAW order instead
// (e.g. Xbox: LT=2, RT=5, RX=3, RY=4  /  DualSense: L2=3, R2=4, RY=5),
// which corrupts the right stick + triggers when applied to browser axes.
// So imports are normalized to browser semantics below:
//   - rightx/righty -> ALWAYS axes 2/3
//   - triggers: buttons 6/7 universally; PS-family axes become 4/5
const PS_FAMILY = /ps[34]|dualshock|dual[ -]?sense|playstation|sony/i;

function toNearcadeMap(entry) {
    const lt = fieldToTrigger(entry.fields.lefttrigger);
    const rt = fieldToTrigger(entry.fields.righttrigger);
    const rsx = fieldToAxis(entry.fields.rightx);
    const rsy = fieldToAxis(entry.fields.righty);
    if (!lt && !rt && rsx == null && rsy == null) return null;
    const m = {};
    if (lt) {
        m.lt = (lt.type === 'btn')
            ? { type: 'btn', idx: 6 }
            : (PS_FAMILY.test(entry.name) ? { type: 'axis', idx: 4 } : { type: 'btn', idx: 6 });
    }
    if (rt) {
        m.rt = (rt.type === 'btn')
            ? { type: 'btn', idx: 7 }
            : (PS_FAMILY.test(entry.name) ? { type: 'axis', idx: 5 } : { type: 'btn', idx: 7 });
    }
    if (rsx != null) m.rsx = 2;
    if (rsy != null) m.rsy = 3;
    const isNoOp = JSON.stringify(m) === JSON.stringify(DEFAULT_MAP);
    if (isNoOp) return null; // identical to browser standard mapping — useless
    return m;
}

function fmtHex(n) { return n.toString(16).padStart(4, '0'); }

async function main() {
    const args = process.argv.slice(2);
    let source = args.find(a => !a.startsWith('--')) || null;
    const platformArg = args.find(a => a.startsWith('--platform=') || a === '--platform');
    const prefer = platformArg ? (platformArg.split('=')[1] || args[args.indexOf(platformArg) + 1] || 'linux') : 'linux';

    let raw;
    if (source && fs.existsSync(source)) {
        raw = fs.readFileSync(source, 'utf8');
    } else {
        console.log('Downloading SDL2 GameControllerDB...');
        raw = await fetch(SOURCE_URL);
    }

    const candidates = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const e = parseLine(line);
        if (e) candidates.push(e);
    }

    // Prefer the requested platform, then fall back to any other platform for the same vid/pid/name
    const order = prefer === 'all' ? ['linux', 'windows', 'mac', null] : [prefer, ...['linux', 'windows', 'mac'].filter(p => p !== prefer), null];
    const best = new Map();
    for (const e of candidates) {
        const key = `${fmtHex(e.vid)}-${fmtHex(e.pid)}-${e.name}`;
        const rank = order.indexOf(e.platform);
        const prev = best.get(key);
        if (!prev || rank < prev.rank) {
            const map = toNearcadeMap(e);
            if (map) best.set(key, { rank, map });
        }
    }

    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (_) { }

    let added = 0;
    for (const [key, { map }] of best) {
        if (key in existing) continue; // hand-tuned / previously imported entries win
        existing[key] = map;
        added++;
    }

    const out = JSON.stringify(existing, null, 2) + '\n';
    fs.writeFileSync(OUT_FILE, out);
    console.log(`Parsed ${candidates.length} SDL2 entries (${candidates.filter(c => c.platform === prefer).length} on ${prefer}).`);
    console.log(`Converted ${best.size} usable device mappings.`);
    console.log(`Added ${added} new entries to ${OUT_FILE}. Total: ${Object.keys(existing).length} entries, ${(out.length / 1024).toFixed(1)} KB.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });