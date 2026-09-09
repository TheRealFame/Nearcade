/**
 * Nearcade Input Diagnostics — provenance logger
 * Captures: source, timestamp, sequence, press/release pairs, path (WS/VPS/HID),
 * controller ID, raw deltas. Does NOT judge intent.
 *
 * Usage (viewer):
 *   import { InputDiag } from './input-diag.js';
 *   InputDiag.start({ viewerId: myId, maxEvents: 5000 });
 *   // in pollGamepad, before sendInputData:
 *   InputDiag.logGamepad(state, { path: 'ws', redundancy: window.nsRedundancyEnabled });
 *   // on WS send:
 *   InputDiag.logSend({ type: 'gamepad', bytes: data.length, path: 'ws' });
 *   // when done:
 *   const blob = InputDiag.exportJSON(); saveAs(blob, 'viewer-input-diag.json');
 *
 * Usage (host):
 *   import { InputDiag } from './input-diag.js';
 *   InputDiag.start({ role: 'host', maxEvents: 5000 });
 *   // in ws.onmessage for gamepad:
 *   InputDiag.logRecv(inner, { viewerId, path: 'ws' });
 *   // before uinput/Vigem write:
 *   InputDiag.logEmit(viewerId, slot, buttons, axes);
 */

const DIAG_VERSION = 1;

function nowMs() { return performance.now(); }
function nowIso() { return new Date().toISOString(); }

function seqGen() {
    let n = 0;
    return () => ++n;
}

function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

export class InputDiag {
    constructor(opts = {}) {
        this.role = opts.role || 'viewer';
        this.viewerId = opts.viewerId || 'unknown';
        this.maxEvents = opts.maxEvents || 5000;
        this.enabled = false;
        this.events = [];
        this.seq = seqGen();
        this.state = new Map(); // pad_id -> { buttonsPressed: Set, lastAxes: [], lastTs: 0 }
        this.sessionId = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
        this.startTime = nowMs();
    }

    start() {
        this.enabled = true;
        this.events = [];
        this.state.clear();
        this.sessionId = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
        this.startTime = nowMs();
        this._push({ type: 'session_start', role: this.role, viewerId: this.viewerId, ts: nowIso(), sessionId: this.sessionId });
    }

    stop() {
        this._push({ type: 'session_end', durationMs: nowMs() - this.startTime });
        this.enabled = false;
    }

    _push(evt) {
        if (!this.enabled) return;
        evt.seq = this.seq();
        evt.t = nowMs();
        this.events.push(evt);
        if (this.events.length > this.maxEvents) this.events.shift();
    }

    // Called on viewer side: raw gamepad state before send
    logGamepad(state, meta = {}) {
        if (!this.enabled) return;
        const padId = state.pad_id || state.viewerId + '_0';
        const st = this.state.get(padId) || { buttonsPressed: new Set(), lastAxes: [], lastTs: 0, pressCount: 0, releaseCount: 0 };
        const now = nowMs();
        const dt = now - st.lastTs;

        // Track press/release transitions
        const transitions = [];
        (state.buttons || []).forEach((b, i) => {
            const pressed = b?.pressed || false;
            const was = st.buttonsPressed.has(i);
            if (pressed && !was) { transitions.push({ btn: i, edge: 'press', t: now }); st.pressCount++; }
            if (!pressed && was) { transitions.push({ btn: i, edge: 'release', t: now }); st.releaseCount++; }
            if (pressed) st.buttonsPressed.add(i); else st.buttonsPressed.delete(i);
        });

        // Axes delta
        const axes = (state.axes || []).map((v, i) => {
            const prev = st.lastAxes[i] ?? 0;
            return { idx: i, val: v, delta: v - prev };
        });
        st.lastAxes = axes.map(a => a.val);
        st.lastTs = now;

        this._push({
            type: 'gamepad_state',
            padId,
            viewerId: state.viewerId,
            padIndex: state.padIndex,
            transitions,
            axes,
            dt,
            pressTotal: st.pressCount,
            releaseTotal: st.releaseCount,
            meta: { path: meta.path || 'unknown', redundancy: meta.redundancy || false, mode: meta.mode || 'gamepad' }
        });
        this.state.set(padId, st);
    }

    // Called on viewer side: data sent on WS
    logSend(pkt, meta = {}) {
        if (!this.enabled) return;
        this._push({ type: 'send', pktType: pkt.type, bytes: pkt.bytes ?? (typeof pkt === 'string' ? pkt.length : 0), meta });
    }

    // Called on host side: data received from viewer
    logRecv(pkt, meta = {}) {
        if (!this.enabled) return;
        const padId = pkt.pad_id || meta.viewerId + '_0';
        this._push({
            type: 'recv',
            padId,
            viewerId: meta.viewerId || pkt.viewerId,
            pktType: pkt.type,
            buttons: pkt.buttons,
            axes: [pkt.lx, pkt.ly, pkt.rx, pkt.ry].map(v => v / 32767),
            lt: pkt.lt, rt: pkt.rt,
            meta: { path: meta.path || 'ws', latencyMs: meta.latencyMs }
        });
    }

    // Called on host side: emitted to uinput/ViGEm
    logEmit(viewerId, slot, buttons, axes, meta = {}) {
        if (!this.enabled) return;
        this._push({
            type: 'emit',
            viewerId,
            slot,
            buttons,
            axes,
            meta: { backend: meta.backend || 'uinput', ok: meta.ok !== false }
        });
    }

    // Generic event
    logEvent(name, data = {}) {
        if (!this.enabled) return;
        this._push({ type: 'event', name, data });
    }

    // Export as JSON
    exportJSON() {
        const summary = this._summarize();
        return new Blob([JSON.stringify({ version: DIAG_VERSION, session: this.sessionId, role: this.role, viewerId: this.viewerId, start: nowIso(), summary, events: this.events }, null, 2)], { type: 'application/json' });
    }

    // Export as NDJSON (one JSON per line, streaming-friendly)
    exportNDJSON() {
        const lines = this.events.map(e => JSON.stringify(e)).join('\n');
        return new Blob([lines + '\n'], { type: 'application/x-ndjson' });
    }

    // Export as human-readable text (≈500 lines max)
    exportText(maxLines = 500) {
        const lines = [];
        lines.push(`Nearcade Input Diagnostics v${DIAG_VERSION}`);
        lines.push(`Role: ${this.role} | Viewer: ${this.viewerId} | Session: ${this.sessionId}`);
        lines.push(`Events: ${this.events.length} | Duration: ${((nowMs() - this.startTime) / 1000).toFixed(1)}s`);
        lines.push('');

        const summary = this._summarize();
        lines.push('=== SUMMARY ===');
        lines.push(`  Gamepad states: ${summary.gamepadStates}`);
        lines.push(`  Sends: ${summary.sends} | Receives: ${summary.receives} | Emits: ${summary.emits}`);
        lines.push(`  Total presses: ${summary.totalPresses} | Total releases: ${summary.totalReleases}`);
        lines.push(`  Unbalanced (press>release): ${summary.unbalancedPads.join(', ') || 'none'}`);
        lines.push(`  Paths seen: ${summary.paths.join(', ') || 'none'}`);
        lines.push(`  Backends seen: ${summary.backends.join(', ') || 'none'}`);
        lines.push('');

        lines.push('=== EVENTS (newest first) ===');
        const evs = [...this.events].reverse();
        for (let i = 0; i < Math.min(evs.length, maxLines - lines.length); i++) {
            const e = evs[i];
            const t = (e.t - this.startTime).toFixed(1).padStart(8);
            if (e.type === 'gamepad_state') {
                const tr = e.transitions.map(x => `${x.edge}[${x.btn}]`).join(' ');
                const ax = e.axes.map(a => `a${a.idx}=${a.val.toFixed(3)}(${a.delta>=0?'+':''}${a.delta.toFixed(3)})`).join(' ');
                lines.push(`[${t}ms] GPAD ${e.padId} dt=${e.dt}ms ${tr || '(no edges)'} | ${ax} | P${e.pressTotal}/R${e.releaseTotal} | ${JSON.stringify(e.meta)}`);
            } else if (e.type === 'send') {
                lines.push(`[${t}ms] SEND ${e.pktType} ${e.bytes}B ${JSON.stringify(e.meta)}`);
            } else if (e.type === 'recv') {
                const ax = (e.axes || []).map((v,i)=> `a${i}=${v.toFixed(3)}`).join(' ');
                lines.push(`[${t}ms] RECV ${e.pktType} ${e.viewerId} btns=0x${(e.buttons||0).toString(16).padStart(4,'0')} ${ax} lt=${e.lt} rt=${e.rt} | ${JSON.stringify(e.meta)}`);
            } else if (e.type === 'emit') {
                lines.push(`[${t}ms] EMIT ${e.viewerId} slot=${e.slot} btns=0x${(e.buttons||0).toString(16).padStart(4,'0')} axes=${(e.axes||[]).map(v=>v.toFixed(3)).join(',')} | ${JSON.stringify(e.meta)}`);
            } else if (e.type === 'session_start' || e.type === 'session_end') {
                lines.push(`[${t}ms] ${e.type.toUpperCase()} ${JSON.stringify(e)}`);
            } else {
                lines.push(`[${t}ms] ${e.type}:${e.name} ${JSON.stringify(e.data)}`);
            }
        }
        if (evs.length > maxLines - 20) lines.push(`... ${evs.length - maxLines + 20} more events truncated`);
        return new Blob([lines.join('\n')], { type: 'text/plain' });
    }

    _summarize() {
        const pads = new Set();
        let sends = 0, receives = 0, emits = 0, states = 0;
        let totalP = 0, totalR = 0;
        const paths = new Set(), backends = new Set();
        const padPress = new Map(), padRelease = new Map();

        for (const e of this.events) {
            if (e.type === 'gamepad_state') { states++; pads.add(e.padId); totalP += e.pressTotal; totalR += e.releaseTotal; if (e.meta?.path) paths.add(e.meta.path); }
            if (e.type === 'send') { sends++; if (e.meta?.path) paths.add(e.meta.path); }
            if (e.type === 'recv') { receives++; if (e.meta?.path) paths.add(e.meta.path); }
            if (e.type === 'emit') { emits++; if (e.meta?.backend) backends.add(e.meta.backend); }
        }

        const unbalanced = [];
        for (const [pad, st] of this.state) {
            if (st.pressCount > st.releaseCount) unbalanced.push(`${pad}(+${st.pressCount - st.releaseCount})`);
        }

        return { gamepadStates: states, sends, receives, emits, totalPresses: totalP, totalReleases: totalR, unbalancedPads: unbalanced, paths: [...paths], backends: [...backends] };
    }

    // Quick in-UI status string
    status() {
        const s = this._summarize();
        return `Diag: ${this.events.length} events | P${s.totalPresses}/R${s.totalReleases} | ${s.unbalancedPads.length} unbalanced | paths:${s.paths.join(',')}`;
    }
}

// Global singleton for easy console access
let _global = null;
export function getGlobalDiag(opts) {
    if (!_global) _global = new InputDiag(opts);
    return _global;
}
export function resetGlobalDiag(opts) { _global = new InputDiag(opts); return _global; }

// Helper for browser download
export function downloadDiag(diag, filename) {
    const url = URL.createObjectURL(diag);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}