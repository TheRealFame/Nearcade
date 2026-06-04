const proto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws, currentStream, peerConnections = {}, knownViewers = new Set(), viewerCount = 0;
let audioCtx, analyser, animFrame;
let pinEnabled = true, currentPin = '----';
let kbmPanicActive = false;
const viewerAudioStates = {}; // Tracks { volume: 100, state: 0 } per viewer

// ── NULL-SAFE DOM HELPERS ─────────────────────────────────────────────────────
// Prevents TypeError crashes when an element ID is missing after a layout refactor.
function _elDisabled(id, val) { const e = document.getElementById(id); if (e) e.disabled = val; }
function _elText(id, val)     { const e = document.getElementById(id); if (e) e.textContent = val; }
function _elClass(id, cls, add) { const e = document.getElementById(id); if (e) e.classList[add ? 'add' : 'remove'](cls); }
// ─────────────────────────────────────────────────────────────────────────────

let audioSettings = {
    forceAudioEnabled: localStorage.getItem('ns_force_audio_enabled') !== 'false',
        defaultDevice: localStorage.getItem('ns_audio_device') || 'default'
};

Pusher.logToConsole = false;
const pusher = new Pusher('a93f5405058cd9fc7967', {
    cluster: 'us2',
    authEndpoint: 'https://nearsec.cutefame.net/api/pusher-auth'
});
const arcadeChannel = pusher.subscribe('private-arcade-global');

// ── NEW: Catch the Ban 403 error and alert the Host ──
arcadeChannel.bind('pusher:subscription_error', (status) => {
    if (status === 403) {
        log(I18N.t('Arcade Error: Your IP is banned from the network.'), 'err');

        // Change the Arcade Live button to show the ban
        const btnArcade = document.getElementById('btnArcade');
        if (btnArcade) {
            btnArcade.innerHTML = '<span style="color:var(--danger); font-weight:bold; font-size: 11px;">BANNED</span>';
        }

        // Stop the ping interval so it doesn't spam the banned endpoint
        if (arcadePingInterval) {
            clearInterval(arcadePingInterval);
            arcadePingInterval = null;
        }
    }
});
// ─────────────────────────────────────────────────────

let arcadePingInterval = null;
let arcadeOverrodePin = false;
const hostSessionId = 'ns-' + Math.random().toString(36).substr(2, 9);


// ── AUDIO STATE & MASTER MUTE ────────────────────────────────────────────────
// Declared here so host.html inline scripts can reference them without redeclaring.
_desktopGainNode = null;
let _hostMicGainNode  = null;
window._masterMuteActive = false;
window._savedDesktopGain = 1.0;
window._savedMicGain     = 1.0;

function setDesktopVolume(val) {
    const v = parseInt(val, 10);
    const el = document.getElementById('desktopVolVal');
    if (el) el.textContent = v;
    localStorage.setItem('ns_host_desktop_vol', v);
    if (!window._masterMuteActive && _desktopGainNode)
        _desktopGainNode.gain.value = v / 100;
}

function setHostMicGain(val) {
    const v = parseInt(val, 10);
    const el = document.getElementById('hostMicVal');
    if (el) el.textContent = v;
    localStorage.setItem('ns_host_mic_gain', v);
    if (!window._masterMuteActive && _hostMicGainNode)
        _hostMicGainNode.gain.value = v / 100;
}

function attachDesktopGain(stream) {
    const aTrack = stream.getAudioTracks()[0];
    if (!aTrack) return;
    try {
        const ctx  = new (window.AudioContext || window.webkitAudioContext)();
        const src  = ctx.createMediaStreamSource(new MediaStream([aTrack]));
        const gain = ctx.createGain();
        const dst  = ctx.createMediaStreamDestination();
        const savedVol = parseInt(localStorage.getItem('ns_host_desktop_vol') ?? '100', 10) / 100;

        // 🔊 Apply the 1.4x Volume Buff here!
        gain.gain.value = window._masterMuteActive ? 0 : (savedVol * 1.4);

        src.connect(gain);
        gain.connect(dst);
        _desktopGainNode = gain;

        // 🛡️ Prevent Chrome from aggressively deleting the audio pipeline
        window._nsAudioCtx = ctx;
        window._nsAudioSrc = src;
        if (ctx.state === 'suspended') ctx.resume();

        stream.removeTrack(aTrack);
        stream.addTrack(dst.stream.getAudioTracks()[0]);
    } catch(e) { console.warn('[HostAudio] Gain node failed:', e); }
}

function toggleMasterMute() {
    window._masterMuteActive = !window._masterMuteActive;
    const active = window._masterMuteActive;
    const btn  = document.getElementById('btnMasterAudioKill');
    const icon = document.getElementById('speakerIcon');

    if (active) {
        window._savedDesktopGain = _desktopGainNode ? _desktopGainNode.gain.value : 1.0;
        window._savedMicGain     = _hostMicGainNode  ? _hostMicGainNode.gain.value  : 1.0;
        if (_desktopGainNode) _desktopGainNode.gain.value = 0;
        if (_hostMicGainNode)  _hostMicGainNode.gain.value  = 0;
        if (typeof currentStream !== 'undefined' && currentStream)
            currentStream.getAudioTracks().forEach(t => t.enabled = false);
        if (btn)  { btn.classList.add('master-mic-kill'); btn.title = 'Audio MUTED — click to restore'; }
        if (icon) { icon.src = '/assets/icons/speaker-off.svg'; icon.style.filter = 'invert(0.4) sepia(1) saturate(6) hue-rotate(-20deg)'; }
        if (typeof log === 'function') log(I18N.t('Master mute: desktop audio cut'), 'warn');
    } else {
        if (_desktopGainNode) _desktopGainNode.gain.value = window._savedDesktopGain;
        if (_hostMicGainNode)  _hostMicGainNode.gain.value  = window._savedMicGain;
        if (typeof currentStream !== 'undefined' && currentStream)
            currentStream.getAudioTracks().forEach(t => t.enabled = true);
        if (btn)  { btn.classList.remove('master-mic-kill'); btn.title = 'Cut Desktop Audio to Stream'; }
        if (icon) { icon.src = '/assets/icons/speaker.svg'; icon.style.filter = 'invert(0.6)'; }
        if (typeof log === 'function') log(I18N.t('Master mute: audio restored'), 'ok');
    }
}

// ─────────────────────────────────────────────────────────────────────────────

const congestionControl = {
    enabled: true,
    minRttMs: 40,
    maxRttMs: 120,
    packetLossThreshold: 5,
    statsPollInterval: 2000,   // FIX: Prevents the 0ms infinite loop!
    recoveryTimeout: 5000,     // FIX: Prevents NaN math errors during bandwidth recovery
    lastAdjustment: {}         // FIX: Stores individual viewer states
};

async function monitorCongestion(pc, viewerId) {
    if (!congestionControl.enabled) return;

    const poll = async () => {
        try {
            const stats = await pc.getStats();
            let candidatePair = null;

            stats.forEach(report => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    if (!candidatePair || report.currentRoundTripTime > candidatePair.currentRoundTripTime) {
                        candidatePair = report;
                    }
                }
            });

            if (!candidatePair) return;

            const rttMs = Math.round(candidatePair.currentRoundTripTime * 1000);
            const packetLoss = candidatePair.availableOutgoingBitrate ?
            ((candidatePair.packetsLost || 0) / (candidatePair.packetsSent || 1)) * 100 : 0;

            if (!congestionControl.baselineRtt && rttMs > 0) {
                congestionControl.baselineRtt = rttMs;
                log(`Congestion: Baseline RTT ${rttMs}ms`, 'ok');
            }

            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (!sender) return;

            const params = sender.getParameters();
            const configuredBitrate = parseInt(document.getElementById('bitrateSelect').value, 10) || 0;
            const currentBitrate = params.encodings?.[0]?.maxBitrate || configuredBitrate;
            if (!congestionControl.lastAdjustment[viewerId]) {
                congestionControl.lastAdjustment[viewerId] = { bitrate: currentBitrate, time: 0, baselineRtt: 0 };
            }
            const lastAdj = congestionControl.lastAdjustment[viewerId];

            if (!lastAdj.baselineRtt && rttMs > 0) {
                lastAdj.baselineRtt = rttMs;
                log(`Congestion: Baseline RTT ${rttMs}ms`, 'ok');
            }

            const timeSinceLastAdj = Date.now() - lastAdj.time;
            const degPref = document.getElementById('degSelect')?.value || 'maintain-framerate';

            let shouldReduce = false;
            let reason = '';

            if (packetLoss > congestionControl.packetLossThreshold) {
                shouldReduce = true;
                reason = `high packet loss (${packetLoss.toFixed(1)}%)`;
            } else if (rttMs > congestionControl.maxRttMs) {
                shouldReduce = true;
                reason = `high RTT (${rttMs}ms > ${congestionControl.maxRttMs}ms)`;
            } else if (timeSinceLastAdj > congestionControl.recoveryTimeout &&
                currentBitrate < (configuredBitrate || lastAdj.bitrate) * 0.95 &&
                rttMs < congestionControl.minRttMs) {
                const ceiling  = configuredBitrate > 0 ? configuredBitrate : lastAdj.bitrate;
                const recovered = Math.min(ceiling, currentBitrate * 1.1);
                if (params.encodings?.length) {
                    params.encodings[0].maxBitrate = Math.round(recovered);
                    params.encodings[0].degradationPreference = degPref;
                }
                await sender.setParameters(params);
                congestionControl.lastAdjustment[viewerId] = { bitrate: recovered, time: Date.now(), baselineRtt: lastAdj.baselineRtt };
                log(I18N.t('Congestion: Bitrate recovered to ${Math.round(recovered/1000)}kbps for ${viewerId}').replace('${Math.round(recovered/1000)}', Math.round(recovered/1000)).replace('${viewerId}', viewerId), 'ok');
                return;
            }

            if (shouldReduce && timeSinceLastAdj > 2000) {
                const newBitrate = Math.round(currentBitrate * 0.8);
                if (params.encodings?.length) {
                    params.encodings[0].maxBitrate = Math.max(500000, newBitrate);
                    params.encodings[0].degradationPreference = degPref;
                }
                await sender.setParameters(params);
                congestionControl.lastAdjustment[viewerId] = { bitrate: currentBitrate, time: Date.now(), baselineRtt: lastAdj.baselineRtt };
                log(I18N.t('Congestion: Bitrate reduced to ${Math.round(newBitrate/1000)}kbps (${reason})').replace('${Math.round(newBitrate/1000)}', Math.round(newBitrate/1000)).replace('${reason}', reason), 'warn');
            }
        } catch (e) {}
    };

    const interval = setInterval(async () => {
        if (!peerConnections[viewerId]) {
            clearInterval(interval);
            return;
        }
        await poll();
    }, congestionControl.statsPollInterval);
}

function toggleStreamState() {
    const btn = document.getElementById('btnStartStop');
    const iconPath = document.getElementById('iconPath');

    if (!currentStream) {
        // We are currently stopped, so we want to START
        showSourceSelectionModal();
        // Note: startCapture() is called after modal confirms
    } else {
        // We are currently live, so we want to STOP
        stopCapture();

        // Update UI to "Start" state
        btn.classList.remove('danger-btn');
        iconPath.setAttribute('d', 'M5 3l14 9-14 9V3z'); // Play Icon
        log(I18N.t('Session stopped by user'), 'ok');
    }
}

(function detectIGPU() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (!ext) return;
        const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL).toLowerCase();
        const isIGPU = /intel|iris|uhd|vega|radeon.*graphics|rdna.*u|apu|780m|680m|graphics \d+/.test(renderer)
        && !/rtx|gtx|rx \d{3,4}|arc a\d/.test(renderer);
        if (isIGPU && !localStorage.getItem('ns_codec')) {
            document.getElementById('codecSelect').value = 'H264';
            localStorage.setItem('ns_codec', 'H264');
            console.log('[codec] iGPU detected (' + renderer + ') — defaulting to H264');
        }
    } catch (e) {}
})();

async function fetchGameThumbnail(gameTitle) {
    try {
        const res = await fetch(`https://nearsec.cutefame.net/api/game-art?title=${encodeURIComponent(gameTitle)}`);
        const data = await res.json();
        return data.thumbnail || '';
    } catch (e) {
        console.warn('Could not fetch official thumbnail:', e);
        return '';
    }
}

function preferVideoCodec(pc) {
    const caps = RTCRtpSender.getCapabilities?.('video');
    if (!caps) return null;
    const val = document.getElementById('codecSelect').value;
    // H.265 is listed as 'video/H265' in Chromium/Electron but some builds use 'video/hevc'
    const candidates = val === 'H265'
        ? [c => c.mimeType === 'video/H265', c => c.mimeType.toLowerCase() === 'video/hevc']
        : [c => c.mimeType === 'video/' + val];
    const preferred = candidates.flatMap(fn => caps.codecs.filter(fn));
    const rest      = caps.codecs.filter(c => !preferred.includes(c));
    const sorted    = [...preferred, ...rest];
    let used = null;
    pc.getTransceivers().forEach(t => {
        if (t.sender?.track?.kind === 'video') {
            try { t.setCodecPreferences(sorted); used = sorted[0]?.mimeType || null; } catch { }
        }
    });
    return used;
}

async function setLowLatencyParams(pc) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return;
    try {
        const params = sender.getParameters();
        const bitVal = parseInt(document.getElementById('bitrateSelect').value, 10);
        const _appFpsUnlock = (typeof appConfig !== 'undefined') && appConfig.fpsUnlock;
    const fpsVal = _appFpsUnlock
      ? Math.max(parseInt(document.getElementById('fpsSelect')?.value) || 60, 120)
      : (parseInt(document.getElementById('fpsSelect')?.value) || 60);
        if (params.encodings?.length) {
            if (bitVal > 0) {
                params.encodings[0].maxBitrate = bitVal;
            } else {
                delete params.encodings[0].maxBitrate;
            }
            params.encodings[0].maxFramerate = fpsVal;
            params.encodings[0].networkPriority = 'high';
            params.encodings[0].priority = 'high';

            // FIX: Actually read the UI dropdown so you can choose Crisp vs Smooth
            const degPref = document.getElementById('degSelect')?.value || 'maintain-framerate';
            params.encodings[0].degradationPreference = degPref;
        }
        await sender.setParameters(params);
    } catch { }
}

async function applyBitrateToAll() {
    for (const pc of Object.values(peerConnections)) {
        await setLowLatencyParams(pc);
    }
    const bitVal = parseInt(document.getElementById('bitrateSelect').value, 10);
    log(I18N.t('Stream bitrate changed to') + ' ' + (bitVal > 0 ? (bitVal / 1000000) + ' Mbps' : 'Auto'), 'ok');
}

function log(msg, cls) {
    const el = document.getElementById('log');
    const d = document.createElement('div');
    d.className = 'll' + (cls ? ' ' + cls : '');
    d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    if (el) { el.appendChild(d); el.scrollTop = el.scrollHeight; }
    const mini = document.getElementById('lastLogLine');
    if (mini) { mini.textContent = msg; mini.style.color = cls === 'ok' ? 'var(--accent)' : cls === 'err' ? 'var(--danger)' : cls === 'warn' ? 'var(--warn)' : '#333'; }
}

function appendChat(name, text, isMe) {
    const el = document.getElementById('chatLog');
    const d = document.createElement('div');
    d.className = 'cmsg';
    d.innerHTML = '<span class="cname' + (isMe ? ' me' : '') + '">' + name + '</span>' + text;
    el.appendChild(d); el.scrollTop = el.scrollHeight;
}

function sendChat() {
    const inp = document.getElementById('chatMsg');
    const msg = inp.value.trim(); if (!msg || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat', from: 'Host', msg }));
    appendChat('Host', msg, true);
    inp.value = '';
}

function setCapDot(state) {
    document.getElementById('capDot').className = 'dot' + (state === 'live' ? ' live' : state === 'err' ? ' err' : '');
    document.getElementById('capStatus').textContent = state === 'live' ? 'Live' : state === 'err' ? 'Error' : 'Idle';
}

function setAudDot(state, label) {
    document.getElementById('audDot').className = 'dot' + (state === 'live' ? ' live' : state === 'warn' ? ' warn' : '');
    document.getElementById('audStatus').textContent = label;
}

// ── V3 UI UPDATE ──
async function renderUrls(d) {
    // 1. Fetch the REAL host name from your backend config FIRST
    let hostName = 'A player';
    try {
        const cfg = await fetch('/api/config').then(r => r.json());
        if (cfg && cfg.hostName) hostName = cfg.hostName;
    } catch (e) {}

    const encodedName = encodeURIComponent(hostName);

    // 2. Append it to the tunnel URL
    let finalTunnelUrl = null;
    if (d.tunnelUrl) {
        const separator = d.tunnelUrl.includes('?') ? '&' : '?';
        finalTunnelUrl = `${d.tunnelUrl}${separator}host=${encodedName}`;
    }

    const rows = [
        finalTunnelUrl
        ? { url: finalTunnelUrl, label: 'HTTPS tunnel (v3) ← share this', color: 'var(--accent)' }
        : { url: 'Waiting for tunnel...', label: 'tunnel starting up', color: '#444', noclick: true },

        { url: `http://${d.lanIP}:${d.port}/?v3&host=${encodedName}`, label: 'LAN (v3) — same network only', color: '#555' },
    ];

    if (!finalTunnelUrl && d.publicIP)
        rows.splice(1, 0, { url: `http://${d.publicIP}:${d.port}/?v3&host=${encodedName}`, label: 'Public IP (v3) (needs port forward)', color: '#666' });

    // 3. NOW clear the HTML and append (prevents the async duplication bug)
    const el = document.getElementById('urlList');
    if (el) {
        el.innerHTML = '';
        rows.forEach(r => {
            const div = document.createElement('div');
            div.className = 'url-row';
            div.style.color = r.color;
            div.textContent = r.url;
            if (!r.noclick) div.onclick = () => {
                navigator.clipboard.writeText(r.url).catch(() => { });
                const tmp = div.textContent; div.textContent = '✓ copied!';
                setTimeout(() => div.textContent = tmp, 1500);
            };
            const sub = document.createElement('div');
            sub.className = 'url-label'; sub.textContent = '↑ ' + r.label;
            el.appendChild(div); el.appendChild(sub);
        });
    }
}

const savedViewerModes = JSON.parse(localStorage.getItem('ns_saved_modes') || '{}');

// ── VIEWER AUDIO STATES ───────────────────────────────────────────────────────
// State 0: Normal 100%   — volume 1.0, muted false
// State 1: Quiet  50%    — volume 0.5, muted false
// State 2: Local  mute   — muted true locally, viewer still transmits
// State 3: Global mute   — muted locally + WS command stops viewer transmission

let _globalMicKillActive = false;

// Inline SVG builders — no external mic icon file needed
function _micSvg(state) {
    const icon  = state >= 2 ? 'mic-off' : 'mic';
    const style = state === 1 ? 'filter:sepia(1) saturate(4) hue-rotate(10deg);'
                : state >= 2  ? 'filter:invert(0.4) sepia(1) saturate(6) hue-rotate(-20deg);'
                : 'filter:invert(0.75);';
    return `<img src="/assets/icons/${icon}.svg" style="width:14px;height:14px;flex-shrink:0;display:block;${style}" alt="">`;
}

const _micTitles = [
    'Mic Normal (100%)',
    'Mic Quiet (50%)',
    'Locally Muted',
    'Globally Muted',
];

function renderRoster(list) {
    const c = document.getElementById('roster');
    const o = document.getElementById('rosterEmpty');
    const controllers = list;

    if (controllers.length === 0) {
        c.innerHTML = '';
        o.style.display = 'block';
        return;
    }
    o.style.display = 'none';
    c.innerHTML = '';

    controllers.forEach((v, index) => {
        const r = document.createElement('div');
        r.className = 'rcard';
        r.draggable = !v.locked;
        r.dataset.id = v.id;
        if (v.locked) r.style.opacity = '0.7';

        let currentMode = v.inputMode || 'gamepad';
        const isGuest = v.name.startsWith('Guest');

        if (!isGuest && savedViewerModes[v.name] && currentMode !== savedViewerModes[v.name]) {
            currentMode = savedViewerModes[v.name];
            changeInputMode(v.id, currentMode, v.name);
        }

        let iconSrc = '/assets/icons/gamepad.svg';
        if (currentMode === 'disabled') iconSrc = '/assets/icons/circle-off.svg';
        if (currentMode === 'kbm') iconSrc = '/assets/icons/keyboard.svg';
        if (currentMode === 'kbm_emulated') iconSrc = '/assets/icons/arrow-up-from-line.svg';

        if (!viewerAudioStates[v.id]) viewerAudioStates[v.id] = { vol: 100, state: 0 };
        const audState = _globalMicKillActive ? 3 : viewerAudioStates[v.id].state;
        const micSvg   = _micSvg(audState);
        const micTitle = _micTitles[audState];

        r.innerHTML = `
        <div class="rnum">${index + 1}</div>
        <div style="flex:1; overflow:hidden;">
          <div class="rname">${v.name}</div>
          <div style="display:flex; align-items:center; gap:6px; margin-top:4px;">
            <img src="${iconSrc}" style="width:14px;height:14px;filter:invert(0.8);" id="icon-${v.id}" />
            <select class="form-select" style="padding:2px 4px;font-size:9px;width:auto;"
              onchange="changeInputMode('${v.id}', this.value, '${v.name.replace(/'/g, "\\'")}')">
              <option value="gamepad"       ${currentMode === 'gamepad'       ? 'selected' : ''}>Gamepad</option>
              <option value="kbm"           ${currentMode === 'kbm'           ? 'selected' : ''}>Raw KBM</option>
              <option value="kbm_emulated"  ${currentMode === 'kbm_emulated'  ? 'selected' : ''}>Emulated KBM</option>
              <option value="disabled"      ${currentMode === 'disabled'      ? 'selected' : ''}>Disabled</option>
            </select>
            <div style="width:1px;height:12px;background:var(--border2);margin:0 2px;"></div>
            <button onclick="cycleViewerMic('${v.id}')" title="${micTitle}"
              id="mic-btn-${v.id}"
              style="background:none;border:none;cursor:pointer;display:flex;align-items:center;padding:2px;${_globalMicKillActive ? 'opacity:0.4;pointer-events:none;' : ''}">
              ${micSvg}
            </button>
            <input type="range" min="0" max="100" value="${viewerAudioStates[v.id].vol}"
              oninput="setViewerVolume('${v.id}', this.value)"
              style="width:38px;accent-color:var(--accent);height:3px;" title="Viewer voice volume">
          </div>
        </div>
        <div class="rstat">${v.slot !== null ? '(Assigned)' : ''}</div>
        <button class="rlock" onclick="toggleSlotLock('${v.id}')" title="Lock slot"
          style="background:none;border:none;cursor:pointer;padding:0 4px;width:20px;height:20px;display:flex;align-items:center;">
          <img src="/assets/icons/${v.locked ? 'lock' : 'lock-open'}.svg" style="width:14px;height:14px;filter:invert(0.5);" />
        </button>
        <button class="rkick" onclick="killGp('${v.id}')" title="Revoke input">×</button>
        `;
        c.appendChild(r);
    });
    attachDragDrop(c);
}

// ── 4-STATE MIC CYCLE ─────────────────────────────────────────────────────────
function cycleViewerMic(viewerId) {
    if (_globalMicKillActive) return; // master kill overrides individual buttons

    const s = viewerAudioStates[viewerId] || (viewerAudioStates[viewerId] = { vol: 100, state: 0 });
    const prev = s.state;
    s.state = (s.state + 1) % 4;

    const audioEl = document.getElementById('remote-audio-' + viewerId);

    switch (s.state) {
        case 0: // Normal — restore everything
            if (audioEl) { audioEl.volume = s.vol / 100; audioEl.muted = false; }
            // If coming from state 3 (global mute), tell viewer to resume transmitting
            if (prev === 3 && ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'host-voice-cmd', targetViewerId: viewerId, action: 'unmute' }));
            }
            break;
        case 1: // Quiet 50%
            if (audioEl) { audioEl.volume = 0.5; audioEl.muted = false; }
            break;
        case 2: // Local mute — host can't hear, viewer still transmits
            if (audioEl) audioEl.muted = true;
            break;
        case 3: // Global mute — stop viewer transmitting entirely
            if (audioEl) audioEl.muted = true;
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'host-voice-cmd', targetViewerId: viewerId, action: 'mute' }));
            }
            break;
    }

    // Update just the mic button in-place without re-rendering the whole roster
    const btn = document.getElementById('mic-btn-' + viewerId);
    if (btn) {
        btn.innerHTML = _micSvg(s.state);
        btn.title     = _micTitles[s.state];
    }
}

// ── VIEWER VOICE VOLUME ───────────────────────────────────────────────────────
function setViewerVolume(viewerId, vol) {
    if (!viewerAudioStates[viewerId]) viewerAudioStates[viewerId] = { vol: 100, state: 0 };
    viewerAudioStates[viewerId].vol = parseInt(vol, 10);
    const audioEl = document.getElementById('remote-audio-' + viewerId);
    // Only apply volume if not muted (states 2 & 3)
    if (audioEl && viewerAudioStates[viewerId].state < 2) {
        audioEl.volume = vol / 100;
    }
}

// ── GLOBAL MIC KILL-SWITCH ────────────────────────────────────────────────────
function toggleGlobalMicKill() {
    _globalMicKillActive = !_globalMicKillActive;

    // Mute/unmute every remote audio element
    document.querySelectorAll('[id^="remote-audio-"]').forEach(el => {
        el.muted = _globalMicKillActive;
    });

    // Broadcast to all viewers
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
            type:   'host-voice-broadcast',
            action: _globalMicKillActive ? 'mute' : 'unmute',
        }));
    }

    log(
        _globalMicKillActive
            ? 'Global mic kill: all viewer mics disabled'
            : 'Global mic kill lifted: viewer mics restored',
        _globalMicKillActive ? 'warn' : 'ok'
    );

    // Visual update
    const btn = document.getElementById('btnMasterMic');
    if (btn) {
        btn.classList.toggle('master-mic-kill', _globalMicKillActive);
        btn.title = _globalMicKillActive ? 'All Viewer Mics Killed (click to restore)' : 'Mute All Viewer Mics';
    }

    // Re-render roster so per-viewer buttons show disabled state
    if (typeof _lastRosterList !== 'undefined') renderRoster(_lastRosterList);
}

// Cache last roster so toggleGlobalMicKill can re-render without a server round-trip
let _lastRosterList = [];

function changeInputMode(viewerId, newMode, viewerName) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'set-input-mode', viewerId: viewerId, mode: newMode }));
        log(I18N.t('Input mode for viewer ${viewerId} set to ${newMode}').replace('${viewerId}', viewerId).replace('${newMode}', newMode), 'ok');
        if (viewerName && !viewerName.startsWith('Guest')) {
            savedViewerModes[viewerName] = newMode;
            localStorage.setItem('ns_saved_modes', JSON.stringify(savedViewerModes));
        }
    }
}

let draggedItem = null;
function attachDragDrop(container) {
    const items = container.querySelectorAll('.rcard');
    items.forEach(item => {
        item.addEventListener('dragstart', (e) => {
            draggedItem = item;
            setTimeout(() => item.classList.add('dragging'), 0);
        });
        item.addEventListener('dragend', () => {
            if (draggedItem) draggedItem.classList.remove('dragging');
            draggedItem = null;
            items.forEach(i => i.classList.remove('drag-over'));
        });
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (item !== draggedItem) item.classList.add('drag-over');
        });
            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over');
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                if (item !== draggedItem && draggedItem) {
                    const all = Array.from(container.querySelectorAll('.rcard'));
                    if (all.indexOf(draggedItem) < all.indexOf(item)) item.after(draggedItem);
                    else item.before(draggedItem);
                    updateSlotsAfterDrop(container);
                }
            });
    });
}

function updateSlotsAfterDrop(container) {
    Array.from(container.querySelectorAll('.rcard')).forEach((item, index) => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'assign-slot', viewerId: item.dataset.id, slot: index }));
    });
}

function killGp(id) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-input', viewerId: id, gp: false, kb: false }));
}

function toggleSlotLock(rosterId) {
    if (ws && ws.readyState === 1) {
        const lockBtn = event.target;
        const lockImg = lockBtn.querySelector('img');
        const isCurrentlyLocked = lockImg && lockImg.src.includes('lock.svg') && !lockImg.src.includes('lock-open');
        ws.send(JSON.stringify({ type: 'toggle-slot-lock', viewerId: rosterId, locked: !isCurrentlyLocked }));
        log(`Slot lock for ${rosterId} set to ${!isCurrentlyLocked ? 'LOCKED' : 'UNLOCKED'}`, 'ok');
    }
}

function togglePin() {
    if (arcadePingInterval) { log(I18N.t('Cannot change PIN during active Arcade session'), 'warn'); return; }
    pinEnabled = !pinEnabled;
    const btn = document.getElementById('pinToggle');
    if (btn) { btn.textContent = pinEnabled ? 'ON' : 'OFF'; btn.classList.toggle('on', pinEnabled); }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: pinEnabled }));
}

function regeneratePin() {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'regen-pin' }));
        log(I18N.t('Requesting new PIN...'), 'ok');
    }
}

function connectWS() {
    ws = new WebSocket(proto + '://' + location.host + '/ws/host');
    ws.onopen = () => {
        log(I18N.t('Connected to server'), 'ok');

        // Single fetch for both hostName display and info — avoids two hits on connect
        fetch('/api/config').then(r => r.json()).then(cfg => {
            const hostNameEl = document.getElementById('displayHostName');
            if (hostNameEl) hostNameEl.textContent = cfg.hostName || 'Guest';
        });

        fetch('/api/info').then(r => r.json()).then(d => {
            currentPin = d.pin;
            document.getElementById('pinVal').textContent = d.pin;
            renderUrls(d);
            ws.send(JSON.stringify({ type: 'sync-pin', pin: currentPin, enabled: pinEnabled }));
            sendCtrlSettings();
        });
        checkTunnelOnConnect();
    };
    ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'viewer-joined') {
            const isNew = !knownViewers.has(msg.viewerId);
            knownViewers.add(msg.viewerId);
            if (isNew) {
                log(I18N.t('Viewer') + ' ' + (msg.name || msg.viewerId) + ' joined', 'ok');
            } else {
                log(I18N.t('Viewer') + ' ' + (msg.name || msg.viewerId) + ' re-offer requested', 'ok');
            }
            if (currentStream) {
                await sendOfferToViewer(msg.viewerId);
            } else {
                ws.send(JSON.stringify({ type: 'host-not-streaming', viewerId: msg.viewerId }));
            }
        }
        if (msg.type === 'viewer-left') {
            knownViewers.delete(msg.viewerId);
            if (peerConnections[msg.viewerId]) { peerConnections[msg.viewerId].close(); delete peerConnections[msg.viewerId]; }
            log(I18N.t('Viewer') + ' ' + msg.viewerId + ' left');
        }
        if (msg.type === 'roster') {
            _lastRosterList = msg.viewers || [];
            renderRoster(_lastRosterList);
            const vc = document.getElementById('viewerCount');
            if (vc) vc.textContent = msg.controllerCount ?? msg.viewers.length;
        }
        if (msg.type === 'answer') {
            const pc = peerConnections[msg._viewerId];
            if (pc) {
                if (pc.signalingState !== 'have-local-offer') {
                    console.log(`[webrtc] Stale answer dropped. State is: ${pc.signalingState}`);
                    return;
                }
                try { await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)); } catch (e) { log(I18N.t('answer err:') + ' ' + e.message, 'err'); }
            }
        }
        if (msg.type === 'ice-viewer') {
            const pc = peerConnections[msg._viewerId];
            if (pc && msg.candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch { } }
        }

        // NEW: Intercept viewer mic trigger
        if (msg.type === 'viewer-mic-ready') {
            log(I18N.t('Viewer') + ' ' + msg._viewerId + ' enabled microphone. Re-syncing tracks...', 'ok');
            sendOfferToViewer(msg._viewerId);
        }

        if (msg.type === 'tunnel-url') {
            log(I18N.t('Tunnel ready:') + ' ' + msg.url, 'ok');
            fetch('/api/info').then(r => r.json()).then(d => { d.tunnelUrl = msg.url; renderUrls(d); });
            closeTunnelModal();
        }
        if (msg.type === 'tunnel-error') {
            log(I18N.t('Tunnel failed:') + ' ' + msg.provider, 'err');
            showTunnelError('Failed to start ' + msg.provider + '.\n\nIf using a SSH tunnel (localhost.run / serveo), outbound port 22 is likely blocked by your router/ISP.\n\nTry using cloudflared instead.');
        }
        if (msg.type === 'chat') appendChat(msg.from, msg.msg, false);
        if (msg.type === 'viewer-gpid') log(I18N.t('Controller:') + ' ' + msg.id, 'ok');
        if (msg.type === 'arcade-session-active') log(I18N.t('Arcade session is LIVE on Nearsec Arcade!'), 'ok');
        if (msg.type === 'arcade-session-error') log(I18N.t('Arcade error:') + ' ' + (msg.reason || 'unknown'), 'err');
        if (msg.type === 'regen-pin') {
            currentPin = msg.pin;
            document.getElementById('pinVal').textContent = msg.pin;
            log(I18N.t('PIN regenerated:') + ' ' + msg.pin, 'ok');
        }
    };
    ws.onclose = () => { log(I18N.t('Disconnected — retrying'), 'warn'); setTimeout(connectWS, 2000); };
    ws.onerror = () => log(I18N.t('WS error'), 'err');
}

async function sendOfferToViewer(viewerId) {
    if (!currentStream) return;
    if (peerConnections[viewerId]) {
        try {
            peerConnections[viewerId].onicecandidate = null;
            peerConnections[viewerId].onconnectionstatechange = null;
            peerConnections[viewerId].close();
        } catch { }
        delete peerConnections[viewerId];
    }

    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        sdpSemantics: 'unified-plan',
    });

    // monitorCongestion runs on 'connected' below — not here.
    // Calling it here spawned a dead getStats interval before ICE even completes.

    peerConnections[viewerId] = pc;

    currentStream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, currentStream);
        if (track.kind === 'video' && sender.setParameters) {
            const params = sender.getParameters();
            if (params.encodings && params.encodings.length > 0) {
                params.encodings[0].networkPriority = 'high';
            }
            sender.setParameters(params).catch(()=>{});
        }
    });

    const codec = preferVideoCodec(pc);
    const cb = document.getElementById('codecBadge');
    if (codec && cb) cb.textContent = codec.split('/')[1];

    let connectTimeout = setTimeout(() => {
        if (pc.connectionState !== 'connected' && peerConnections[viewerId] === pc) {
            log(I18N.t('Handshake timeout for') + ' ' + viewerId + ', fast retrying...', 'warn');
            sendOfferToViewer(viewerId);
        }
    }, 3000);

    pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate) {
            ws.send(JSON.stringify({ type: 'ice-host', candidate: e.candidate, _viewerId: viewerId }));
        }
    };

    pc.ontrack = (e) => {
        if (e.track.kind === 'audio') {
            let audioEl = document.getElementById('remote-audio-' + viewerId);
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.id = 'remote-audio-' + viewerId;
                audioEl.autoplay = true;

                // Apply the saved volume/mute state immediately
                const state = viewerAudioStates[viewerId] || { vol: 100, state: 0 };
                audioEl.volume = state.vol / 100;
                audioEl.muted = state.state >= 2 || _globalMicKillActive;

                // ── THE FIX: Apply hardware route to new viewers ──
                if (typeof audioEl.setSinkId === 'function' && selectedOutputDeviceId && selectedOutputDeviceId !== 'default') {
                    audioEl.setSinkId(selectedOutputDeviceId).catch(err => console.warn('[Audio] setSinkId error on join:', err));
                }

                document.body.appendChild(audioEl);
            }
            audioEl.srcObject = e.streams[0];
            log(`Incoming voice stream attached for ${viewerId}`, 'ok');
        }
    };
    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        log(I18N.t('Viewer') + ' ' + viewerId + ': ' + s, s === 'connected' ? 'ok' : s === 'failed' ? 'err' : '');

        if (s === 'connected') {
            clearTimeout(connectTimeout);
            setLowLatencyParams(pc);
            monitorCongestion(pc, viewerId);
        }

        if (s === 'failed' || s === 'disconnected') {
            clearTimeout(connectTimeout);
            if (peerConnections[viewerId] === pc) {
                log(I18N.t('Retrying offer to') + ' ' + viewerId, 'warn');
                delete peerConnections[viewerId];
                setTimeout(() => sendOfferToViewer(viewerId), 500);
            }
        }
    };

    try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
        await pc.setLocalDescription({ type: offer.type, sdp: offer.sdp });
        ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription, _viewerId: viewerId }));
        log(I18N.t('Offer → viewer') + ' ' + viewerId, 'ok');
    } catch (err) {
        log(I18N.t('Fatal WebRTC Error for') + ' ' + viewerId + ': ' + err.message, 'err');
    }
}

let selectedSourceId = null;

async function showSourceSelectionModal() {
    // CRITICAL FIX: Bypass custom modal on Linux.
    // Electron's desktopCapturer.getSources() triggers a video-only xdg-desktop-portal
    // on Wayland, which hides the "Share Audio" checkbox.
    const isLinux = navigator.userAgent.toLowerCase().includes('linux');

    // Only show modal if electronAPI is available AND we are not on Linux
    if (!window.electronAPI || !window.electronAPI.getWindowSources || isLinux) {
        if (isLinux) log(I18N.t('Linux Wayland detected: Delegating to native portal for audio support'), 'ok');
        else log(I18N.t('Source selection not available on this platform'), 'warn');

        startCapture();
        return;
    }

    // Show modal immediately while sources load
    document.getElementById('sourceModal').classList.remove('gone');
    await _populateSourceGrid();
}

async function refreshSourceModal() {
    await _populateSourceGrid();
}

async function _populateSourceGrid() {
    const sourceGrid   = document.getElementById('sourceGrid');
    const noSources    = document.getElementById('sourceNoSources');
    const confirmBtn   = document.getElementById('confirmSourceBtn');

    sourceGrid.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:11px;">Scanning sources…</div>';
    if (noSources) noSources.style.display = 'none';
    if (confirmBtn) confirmBtn.disabled = true;
    selectedSourceId = null;

    try {
        // Request both windows AND screens from Electron
        const sources = await window.electronAPI.getWindowSources({
            types: ['window', 'screen'],
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: true
        });

        sourceGrid.innerHTML = '';

        if (!sources || sources.length === 0) {
            if (noSources) noSources.style.display = 'flex';
            log(I18N.t('No capture sources found — try clicking Refresh or opening a window'), 'warn');
            return;
        }

        sources.forEach((source, idx) => {
            const card = document.createElement('div');
            card.className = 'source-card';
            card.id = 'source-' + idx;
            card.onclick = () => selectSource(idx, source.id);

            const thumbnail = source.thumbnail || '';
            const imgHtml = thumbnail
                ? `<img src="${thumbnail}" class="source-thumbnail" alt="${source.name}">`
                : '<div class="source-thumbnail" style="background:#2a2a2a;display:flex;align-items:center;justify-content:center;color:#666;font-size:10px;">No Preview</div>';

            const sourceType = source.isScreen ? '🖥️ Screen' : '🪟 Window';
            card.innerHTML = `${imgHtml}
            <div class="source-name">${source.name}</div>
            <div class="source-type">${sourceType}</div>`;

            sourceGrid.appendChild(card);
        });

        log(I18N.t('Found ${sources.length} capture source(s)').replace('${sources.length}', sources.length), 'ok');
    } catch (e) {
        log(I18N.t('Error loading sources:') + ' ' + e.message, 'err');
        sourceGrid.innerHTML = '';
        if (noSources) {
            noSources.style.display = 'flex';
            const detail = noSources.querySelector('div:last-child');
            if (detail) detail.textContent = 'Error: ' + e.message + ' — try Refresh.';
        }
    }
}

function selectSource(idx, sourceId) {
    document.querySelectorAll('.source-card').forEach(card => {
        card.style.borderColor = '';
        card.style.background = '';
    });

    const selectedCard = document.getElementById('source-' + idx);
    selectedCard.style.borderColor = 'var(--ok)';
    selectedCard.style.background = 'rgba(100, 200, 100, 0.1)';

    selectedSourceId = sourceId;
    document.getElementById('confirmSourceBtn').disabled = false;
}

function closeSourceModal() {
    document.getElementById('sourceModal').classList.add('gone');
    selectedSourceId = null;
}

async function confirmSource() {
    closeSourceModal();
    await startCapture();
}

let activeSourceId = null;

const savedCodec = localStorage.getItem('ns_codec');
if (savedCodec) document.getElementById('codecSelect').value = savedCodec;
document.getElementById('codecSelect').addEventListener('change', (e) => localStorage.setItem('ns_codec', e.target.value));

const savedBitrate = localStorage.getItem('ns_bitrate');
if (savedBitrate) document.getElementById('bitrateSelect').value = savedBitrate;
document.getElementById('bitrateSelect').addEventListener('change', (e) => {
    localStorage.setItem('ns_bitrate', e.target.value);
    if (currentStream) applyBitrateToAll();
});

const savedDeg = localStorage.getItem('ns_deg');
if (savedDeg) document.getElementById('degSelect').value = savedDeg;
document.getElementById('degSelect').addEventListener('change', (e) => {
    localStorage.setItem('ns_deg', e.target.value);
    if (currentStream) applyBitrateToAll();
});

const savedRes = localStorage.getItem('ns_res');
if (savedRes) document.getElementById('resSelect').value = savedRes;
document.getElementById('resSelect').addEventListener('change', (e) => {
    localStorage.setItem('ns_res', e.target.value);
    if (currentStream) hotSwapCapture();
});

const savedFps = localStorage.getItem('ns_fps');
if (savedFps) document.getElementById('fpsSelect').value = savedFps;
document.getElementById('fpsSelect').addEventListener('change', (e) => {
    localStorage.setItem('ns_fps', e.target.value);
    if (currentStream) hotSwapCapture();
});

// 🔥 THE HOT SWAP ENGINE
async function hotSwapCapture() {
    if (!currentStream) return;
    log(I18N.t('Applying new stream resolution/FPS...'), 'warn');

    // 1. Tell viewers to freeze their screen on the last frame
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'host-encoder-swap-start' }));
    }

    const _appFpsUnlock = (typeof appConfig !== 'undefined') && appConfig.fpsUnlock;
    const fpsVal = _appFpsUnlock ? Math.max(parseInt(document.getElementById('fpsSelect')?.value) || 60, 120) : (parseInt(document.getElementById('fpsSelect')?.value) || 60);
    const resVal = document.getElementById('resSelect')?.value || '1080p';

    let videoConstraints = { frameRate: { ideal: fpsVal }, cursor: 'never' };
    if (resVal === '720p') videoConstraints.height = { ideal: 720 };
    if (resVal === '1080p') videoConstraints.height = { ideal: 1080 };
    if (resVal === '1440p') videoConstraints.height = { ideal: 1440 };
    if (resVal === '4k') videoConstraints.height = { ideal: 2160 };

    try {
        // 2. Grab the new video track
        let newScreenStream;
        if (window._lastSourceId && window.electronAPI) {
            newScreenStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: window._lastSourceId, maxFrameRate: fpsVal } }
            });
        } else {
            newScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: false });
        }

        const newVideoTrack = newScreenStream.getVideoTracks()[0];
        newVideoTrack.contentHint = 'motion';

        // 3. Swap the track inside all active WebRTC peer connections (NO disconnects!)
        for (const viewerId in peerConnections) {
            const pc = peerConnections[viewerId];
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) {
                await sender.replaceTrack(newVideoTrack);
                setLowLatencyParams(pc);
            }
        }

        // 4. Swap it out locally
        const oldVideoTrack = currentStream.getVideoTracks()[0];
        currentStream.removeTrack(oldVideoTrack);
        oldVideoTrack.stop();
        currentStream.addTrack(newVideoTrack);

        const prev = document.getElementById('preview');
        if (prev && !previewHidden) prev.srcObject = currentStream;

        log(I18N.t('Stream settings applied seamlessly!'), 'ok');
    } catch (err) {
        log(I18N.t('Failed to swap video track:') + ' ' + err.message, 'err');
    }
}

async function startCapture() {
    _elDisabled('btnStart', true);
    _elDisabled('btnSwitch', true);

    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); stopAudioMeter(); currentStream = null; }
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};

    const isLinux = navigator.userAgent.includes('Linux') || navigator.platform.toLowerCase().includes('linux');
    const _appFpsUnlock = (typeof appConfig !== 'undefined') && appConfig.fpsUnlock;
    const fpsVal = _appFpsUnlock
      ? Math.max(parseInt(document.getElementById('fpsSelect')?.value) || 60, 120)
      : (parseInt(document.getElementById('fpsSelect')?.value) || 60);
    const resVal = document.getElementById('resSelect')?.value || '1080p';

    let videoConstraints = { frameRate: { ideal: fpsVal } };
    if (resVal === '720p') videoConstraints.height = { ideal: 720 };
    if (resVal === '1080p') videoConstraints.height = { ideal: 1080 };
    if (resVal === '1440p') videoConstraints.height = { ideal: 1440 };
    if (resVal === '4k') videoConstraints.height = { ideal: 2160 };

    try {
        let screenStream;
        videoConstraints.cursor = 'never';
        const displayMediaOptions = { video: videoConstraints };

        if (!isLinux && audioSettings.forceAudioEnabled) {
            displayMediaOptions.audio = true;
            displayMediaOptions.systemAudio = 'include';
        } else {
            displayMediaOptions.audio = false;
        }

        if (selectedSourceId && window.electronAPI) {
            try {
                window._lastSourceId = selectedSourceId;
                screenStream = await navigator.mediaDevices.getUserMedia({
                    audio: isLinux ? false : (audioSettings.forceAudioEnabled ? { mandatory: { chromeMediaSource: 'desktop' } } : false),
                                                                         video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: selectedSourceId, maxFrameRate: fpsVal } }
                });
                log(I18N.t('Using selected source:') + ' ' + selectedSourceId, 'ok');
            } catch (e) {
                log(I18N.t('Source selection failed, falling back:') + ' ' + e.message, 'warn');
                selectedSourceId = null;
                screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
            }
        } else {
            screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
        }

        if (selectedSourceId) activeSourceId = selectedSourceId;
        selectedSourceId = null;
        const vTrack = screenStream.getVideoTracks()[0];
        if (!vTrack || vTrack.readyState === 'ended') {
            log(I18N.t('Screen capture cancelled'), 'warn'); setCapDot('');
            document.getElementById('btnStart').disabled = false; return;
        }

        vTrack.contentHint = 'motion';
        const settings = vTrack.getSettings();
        const combined = new MediaStream();
        combined.addTrack(vTrack);

        let aTrack = screenStream.getAudioTracks()[0] || null;

        if (isLinux) {
            try {
                // Force permission prompt to un-hide device labels
                try {
                    const unlockStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    unlockStream.getTracks().forEach(t => t.stop());
                } catch(e) { log(I18N.t('Audio permission missing, loopback labels hidden'), 'warn'); }

                const devices = await navigator.mediaDevices.enumerateDevices();
                const audioInputs = devices.filter(d => d.kind === 'audioinput');

                // Print all seen devices to console for debugging
                console.log("Available Audio Inputs:", audioInputs.map(d => d.label || 'Hidden/Unknown'));

                // Look for the system audio capture source
                const loopbackDevice = audioInputs.find(d =>
                d.label.includes('NearsecVirtualCapture') || // NEW ARCHITECTURE
                d.label.includes('NearsecVirtual') ||        // NEW ARCHITECTURE
                d.label.includes('Nearsec_App_Mic') ||
                d.label.includes('Nearsec_Virtual_Mic') ||
                d.label.includes('NearsecAppMic') ||
                d.label.includes('Nearsec_App_Audio') ||
                d.label.includes('NearsecAppAudio')
                );

                if (loopbackDevice) {
                    const audioStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            deviceId: { exact: loopbackDevice.deviceId },
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false,
                            channelCount: 2
                        }
                    });
                    aTrack = audioStream.getAudioTracks()[0];
                    if (aTrack) {
                        log(I18N.t('System audio captured'), 'ok');
                    }
                } else {
                    const labels = audioInputs.map(d => d.label || 'Hidden').join(', ');
                    log(I18N.t('Virtual cable not found. Seen labels:') + ' ' + labels, 'warn');
                }
            } catch (audErr) {
                console.warn('Linux audio loopback initialization failed:', audErr);
            }
        }

        // FORCE DISABLE PYTHON FALLBACK - We rely strictly on PipeWire now
        const disableFallback = true;

        if (aTrack) {
            combined.addTrack(aTrack);
            // Link the slider node to the track so the Host can change the volume!
            if (typeof attachDesktopGain === 'function') attachDesktopGain(combined);
            log(I18N.t('System Audio Track Found:') + ' ' + (aTrack.label || 'default'), 'ok');
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop-audio-fallback' }));
        } else {
            if (!disableFallback) {
                log(I18N.t('Browser capture failed. Engaging Python OS-level audio fallback...'), 'warn');
                if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'start-audio-fallback' }));
            } else {
                log(I18N.t('Browser capture failed. (Python Fallback disabled)'), 'err');
            }
        }

        if (appSettings.captureMic) {
            try {
                const micConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
                if (selectedMicDeviceId && selectedMicDeviceId !== 'default') {
                    micConstraints.deviceId = { exact: selectedMicDeviceId };
                }
                const micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints, video: false });
                const micTrack = micStream.getAudioTracks()[0];
                if (micTrack) {
                    combined.addTrack(micTrack);
                    log(I18N.t('Microphone added:') + ' ' + (micTrack.label || 'default'), 'ok');
                }
            } catch (e) { log(I18N.t('Mic capture failed:') + ' ' + e.message, 'warn'); }
        }

        currentStream = combined;

        // Instantly display the selected codec instead of waiting for a viewer
        const cb = document.getElementById('codecBadge');
        if (cb) {
            cb.textContent = document.getElementById('codecSelect').value;
        }

        const prev = document.getElementById('preview');
        if (appSettings.hidePreviewOnStart) {
            previewHidden = true;
            prev.style.display = 'none';
            const btn = document.getElementById('btnPreviewToggle');
            if (btn) { btn.innerHTML = SVG_EYE_CLOSED; btn.style.color = 'var(--warn)'; }
        } else {
            prev.srcObject = screenStream;
        }

        if (settings.width && settings.height) prev.style.aspectRatio = settings.width + '/' + settings.height;
        document.getElementById('prevOverlay').classList.add('hidden');

        const finalAudioTracks = currentStream.getAudioTracks();
        document.getElementById('trackInfo').innerHTML =
        '<strong>' + (vTrack.label?.split('(')[0].trim() || 'Screen') + '</strong><br>' +
        settings.width + '×' + settings.height + ' @ ' + Math.round(settings.frameRate || 0) + 'fps<br>' +
        (finalAudioTracks.length > 0 ? 'Audio: active' : (disableFallback && !aTrack ? 'No audio' : 'Audio: OS fallback'));

        // ── Dynamic resolution tracking (updates if resolution changes) ──
        const liveResEl   = document.getElementById('liveResDisplay');
        const liveResText = document.getElementById('liveResText');
        function _updateRes() {
            if (!currentStream) { clearInterval(_resInterval); return; }
            const vt = currentStream.getVideoTracks()[0];
            if (!vt) return;
            const s = vt.getSettings();
            const label = (s.width && s.height)
                ? s.width + '×' + s.height + ' @ ' + Math.round(s.frameRate || 0) + ' fps'
                : '';
            if (label) {
                if (liveResText) liveResText.textContent = label;
                if (liveResEl) liveResEl.style.display = 'block';
                // Also update trackInfoAlt directly so the hyphen is never shown while live
                const alt = document.getElementById('trackInfoAlt');
                if (alt && !alt.innerHTML.includes('<strong>')) {
                    alt.textContent = label;
                }
            }
        }
        _updateRes();
        if (window._resInterval) clearInterval(window._resInterval);
        window._resInterval = setInterval(_updateRes, 2000);

        setCapDot('live');

        setTimeout(() => {
            const checkTrack = currentStream ? currentStream.getAudioTracks()[0] : null;
            if (checkTrack || (!aTrack && !disableFallback)) {
                setAudDot('live', 'Audio active');
                if (checkTrack) startAudioMeter(currentStream);
            } else {
                setAudDot('warn', 'No audio — Check source');
            }
        }, 500);

        ws.send(JSON.stringify({ type: 'host-stream-ready' }));
        sysChat(I18N.t('Stream started.'));
        [...knownViewers].forEach(id => sendOfferToViewer(id));

        vTrack.onended = () => { log(I18N.t('Capture ended by OS'), 'warn'); stopCapture(); };
        _elDisabled('btnSwitch', false);
        _elDisabled('btnStop', false);
        _elDisabled('btnKbmPanic', false);
    } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'AbortError') log(I18N.t('Capture cancelled'), 'warn');
        else { log(I18N.t('Capture failed:') + ' ' + err.message, 'err'); setCapDot('err'); }
        _elDisabled('btnStart', false);
    }
}

function stopCapture() {
    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
    if (window._resInterval) { clearInterval(window._resInterval); window._resInterval = null; }
    stopAudioMeter();

    // Stop FFmpeg experimental pipeline if it was running
    fetch(`/api/stop-ffmpeg-capture`, { method: 'POST' }).catch(() => {});
    if (window._ffmpegHealthInterval) { clearInterval(window._ffmpegHealthInterval); window._ffmpegHealthInterval = null; }
    const prevEl = document.getElementById('preview');
    if (prevEl) prevEl.srcObject = null;
    _elClass('prevOverlay', 'hidden', false);
    setCapDot(''); setAudDot('', 'No audio');
    _elText('trackInfo', '');
    // Reset Live Status
    const alt = document.getElementById('trackInfoAlt');
    if (alt) alt.textContent = 'No stream active';
    const liveResEl = document.getElementById('liveResDisplay');
    if (liveResEl) liveResEl.style.display = 'none';
    // Reset preview button to eye-open SVG
    previewHidden = false;
    const prevBtn = document.getElementById('btnPreviewToggle');
    if (prevBtn) { prevBtn.innerHTML = SVG_EYE_OPEN; prevBtn.style.color = ''; }
    // Restore "Click Start" overlay text
    const overlaySpan = document.querySelector('#prevOverlay span');
    if (overlaySpan) overlaySpan.textContent = 'Click Start to begin sharing';
    _elDisabled('btnStart', false);
    _elDisabled('btnSwitch', true);
    _elDisabled('btnStop', true);
    _elDisabled('btnKbmPanic', true);
    kbmPanicActive = false;
    updateKbmPanicButton();
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};

    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'host-stream-stopped' }));
    }

    if (arcadePingInterval) {
        clearInterval(arcadePingInterval);
        arcadePingInterval = null;
        arcadeChannel.trigger('client-session-stop', { id: hostSessionId });
        log(I18N.t('Arcade Mode: Session ended on Arcade'), 'warn');

        // Restore the Arcade button SVG icon
        const btnArcade = document.getElementById('btnArcade');
        if (btnArcade) {
            btnArcade.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
        }
    }

    if (arcadeOverrodePin) {
        arcadeOverrodePin = false;
        pinEnabled = true;
        const btn = document.getElementById('pinToggle');
        if (btn) { btn.textContent = 'ON'; btn.className = 'pin-toggle-btn on'; }
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: true }));
        log(I18N.t('PIN re-enabled after Arcade session'), 'ok');
    }

    // NEW: Unlock PIN UI when session ends (MOVED HERE SO IT ALWAYS RUNS)
    const pinSwitch = document.getElementById('arcadeRequirePin');
    const pinDisplay = document.getElementById('pinVal');

    if (pinSwitch) {
        pinSwitch.disabled = false;
        pinSwitch.title = '';
    }
    if (pinDisplay && pinDisplay.dataset.originalPin) {
        pinDisplay.textContent = pinDisplay.dataset.originalPin;
    }

    log(I18N.t('Capture stopped'));
    sysChat(I18N.t('Host stopped sharing.'));

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('auto') === '1') {
        console.log('[Headless] Stream terminated. Executing suicide protocol to restart worker.');
        if (window.electronAPI && window.electronAPI.close) {
            window.electronAPI.close();
        }
    }
}

function updateKbmPanicButton() {
    const btn = document.getElementById('btnKbmPanic');
    if (!btn) return;
    const SPAN_STYLE = 'font-size:10px;font-weight:bold;color:inherit;letter-spacing:0.5px;line-height:1.1;text-align:center;';
    if (kbmPanicActive) {
        btn.innerHTML = `<span style="${SPAN_STYLE}">RESUME<br>KBM</span>`;
        btn.style.background = 'rgba(220,50,50,0.2)';
        btn.style.border = '1px solid var(--danger)';
        btn.style.color = 'var(--danger)';
    } else {
        btn.innerHTML = `<span style="${SPAN_STYLE}">KBM<br>PANIC</span>`;
        btn.style.background = 'transparent';
        btn.style.border = 'none';
        btn.style.color = '';
    }
}

function toggleKbmPanic() {
    kbmPanicActive = !kbmPanicActive;
    updateKbmPanicButton();

    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'panic_toggle', enabled: kbmPanicActive }));
    }

    if (kbmPanicActive) {
        log('⚠ KBM PANIC ACTIVATED - All viewer keyboard/mouse input frozen', 'warn');
    } else {
        log('✓ KBM panic released', 'ok');
    }
}

function startAudioMeter(stream) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const fill = document.getElementById('meter');
    (function draw() { animFrame = requestAnimationFrame(draw); analyser.getByteFrequencyData(data); fill.style.width = Math.min(100, data.reduce((a, b) => a + b, 0) / data.length * 2) + '%'; })();
}
function stopAudioMeter() {
    if (animFrame) cancelAnimationFrame(animFrame);
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    document.getElementById('meter').style.width = '0%';
}

function showTunnelModal() {
    resetTunnelModal();
    document.getElementById('tunnelModal').classList.remove('gone');

    fetch('/api/config').then(r => r.json()).then(cfg => {
        if (!cfg || !cfg.tunnelProvider) return;
        const rememberBox = document.getElementById('rememberCheck');
        if (rememberBox) rememberBox.checked = !!cfg.neverAsk;

        const radio = document.querySelector('input[name="provider"][value="' + cfg.tunnelProvider + '"]');
        if (radio) {
            radio.checked = true;
            document.querySelectorAll('.provider-card').forEach(c => {
                c.classList.toggle('selected', c.querySelector('input').checked);
            });
        }
        if (cfg.tunnelProvider === 'vps' && cfg.vpsHost) {
            const vpsInput = document.getElementById('vpsHostInput');
            if (vpsInput) vpsInput.value = cfg.vpsHost;
        }
    }).catch(() => {});

    document.querySelectorAll('.provider-card').forEach(c => {
        c.classList.toggle('selected', c.querySelector('input').checked);
    });
}
function resetTunnelModal() {
    document.getElementById('tunnelLoading').classList.add('gone');
    document.getElementById('tunnelSpinner').classList.remove('gone');
    document.getElementById('tunnelErrorText').classList.add('gone');
    document.getElementById('tunnelRetryBtn').classList.add('gone');
}
function closeTunnelModal() {
    document.getElementById('tunnelModal').classList.add('gone');
    resetTunnelModal();
}
function showTunnelError(msg) {
    document.getElementById('tunnelSpinner').classList.add('gone');
    document.getElementById('tunnelLoadText').textContent = 'Connection Failed';
    document.getElementById('tunnelErrorText').textContent = msg;
    document.getElementById('tunnelErrorText').classList.remove('gone');
    document.getElementById('tunnelRetryBtn').classList.remove('gone');
}

function copyCmd(e, cmd) {
    e.stopPropagation();
    let finalCmd = cmd;
    if (cmd.includes('VPS')) {
        const host = document.getElementById("vpsHostInput")?.value?.trim() || "VPS";
        finalCmd = cmd.replace('VPS', host);
    }
    navigator.clipboard.writeText(finalCmd).then(() => {
        const btn = e.target;
        const orig = btn.textContent;
        btn.textContent = '✓';
        btn.style.borderColor = 'var(--accent)';
        setTimeout(() => { btn.textContent = orig; btn.style.borderColor = '#4e5058'; }, 1000);
    });
}

function confirmTunnel() {
    const radio = document.querySelector('input[name="provider"]:checked');
    if (!radio) return;
    const provider = radio.value;
    const remember = document.getElementById('rememberCheck').checked;

    if (provider === 'portforward') {
        if (remember) {
            fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tunnelProvider: 'portforward', neverAsk: true }) });
        }
        closeTunnelModal();
        log(I18N.t('Using direct Port Forwarding. Share your Public IP URL.'), 'ok');
        return;
    }

    document.getElementById('tunnelLoading').classList.remove('gone');
    document.getElementById('tunnelLoadText').textContent = I18N.t('Starting') + ' ' + provider + '...';

    log(I18N.t('Starting') + ' ' + provider + ' tunnel' + (remember ? ' (saved)' : '') + '…', 'ok');
    fetch('/api/start-tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, remember, vpsHost: document.getElementById("vpsHostInput")?.value?.trim() })
    }).catch(() => showTunnelError(I18N.t('Network request failed')));
}

document.querySelectorAll('input[name="provider"]').forEach(radio => {
    radio.addEventListener('change', () => {
        document.querySelectorAll('.provider-card').forEach(c => {
            c.classList.toggle('selected', c.querySelector('input').checked);
        });
    });
});
document.querySelectorAll('.provider-card').forEach(card => {
    card.addEventListener('click', () => {
        card.querySelector('input').checked = true;
        document.querySelectorAll('.provider-card').forEach(c =>
        c.classList.toggle('selected', c.querySelector('input').checked));
    });
});

async function checkTunnelOnConnect() {
    try {
        const cfg = await fetch('/api/config').then(r => r.json());
        if (cfg.neverAsk) return;
        const info = await fetch('/api/info').then(r => r.json());
        if (!info.tunnelUrl) showTunnelModal();
    } catch { }
}

const ctrlSettings = {
    forceXboxOne:     localStorage.getItem('ns_ctrl_forceXboxOne')    === 'true',
    enableDualShock:  localStorage.getItem('ns_ctrl_enableDualShock')  === 'true',
    enableMotion:     localStorage.getItem('ns_ctrl_enableMotion')     === 'true',
    defaultInputMode: localStorage.getItem('ns_ctrl_defaultInputMode') || 'gamepad',
    hybridInput:      localStorage.getItem('ns_ctrl_hybridInput')      === 'true',
    ctrlType:         localStorage.getItem('ns_ctrl_ctrlType')         || 'xbox360',
};

function applyCtrlSettingsUI() {
    const trackXbox = document.getElementById('ctrlTrackForceXboxOne');
    const rowXbox   = document.getElementById('ctrlRowForceXboxOne');
    const warnXbox  = document.getElementById('ctrlWarnForceXboxOne');

    const trackDS = document.getElementById('ctrlTrackDualShock');
    const rowDS   = document.getElementById('ctrlRowDualShock');

    const trackMotion = document.getElementById('ctrlTrackMotion');
    const rowMotion   = document.getElementById('ctrlRowMotion');

    const modeSelect = document.getElementById('defaultInputModeSelect');
    if (modeSelect) modeSelect.value = ctrlSettings.defaultInputMode;
    const trackHybrid = document.getElementById('ctrlTrackHybrid');
    if (trackHybrid) trackHybrid.classList.toggle('on', !!ctrlSettings.hybridInput);
    const ctrlTypeSelect = document.getElementById('ctrlTypeSelect');
    if (ctrlTypeSelect) ctrlTypeSelect.value = ctrlSettings.ctrlType || 'xbox360';

    const btn = document.getElementById('ctrlSettingsBtn');

    if (trackXbox) trackXbox.classList.toggle('on', ctrlSettings.forceXboxOne);
    if (rowXbox) rowXbox.classList.toggle('active', ctrlSettings.forceXboxOne);
    if (warnXbox) warnXbox.style.display = ctrlSettings.forceXboxOne ? 'block' : 'none';

    if (trackDS) trackDS.classList.toggle('on', ctrlSettings.enableDualShock);
    if (rowDS) rowDS.classList.toggle('active', ctrlSettings.enableDualShock);

    if (trackMotion) trackMotion.classList.toggle('on', ctrlSettings.enableMotion);
    if (rowMotion) rowMotion.classList.toggle('active', ctrlSettings.enableMotion);

    const isNonDefault = ctrlSettings.forceXboxOne || ctrlSettings.enableDualShock || ctrlSettings.enableMotion || ctrlSettings.defaultInputMode !== 'gamepad';
    btn.style.color = isNonDefault ? 'var(--warn)' : '';
}

function toggleCtrlSetting(key) {
    ctrlSettings[key] = !ctrlSettings[key];
    localStorage.setItem('ns_ctrl_' + key, ctrlSettings[key]);
    applyCtrlSettingsUI();
    sendCtrlSettings();
    log(I18N.t('ctrl-settings:') + ' ' + key + ' = ' + ctrlSettings[key], 'ok');
}


function toggleHybridInput() {
    ctrlSettings.hybridInput = !ctrlSettings.hybridInput;
    localStorage.setItem('ns_ctrl_hybridInput', ctrlSettings.hybridInput);
    applyCtrlSettingsUI();
    sendCtrlSettings();
    if (ws && ws.readyState === 1 && ctrlSettings.hybridInput) {
        (_lastRosterList || []).forEach(v => {
            ws.send(JSON.stringify({ type: 'set-input', viewerId: v.id, gp: true, kb: true }));
        });
        log(I18N.t('Hybrid Input ON — Gamepad + KBM active for all viewers'), 'ok');
    } else {
        log(I18N.t('Hybrid Input OFF'), 'warn');
    }
}

function changeCtrlType(type) {
    ctrlSettings.ctrlType = type;
    localStorage.setItem('ns_ctrl_ctrlType', type);
    applyCtrlSettingsUI();
    sendCtrlSettings();
    if (ws && ws.readyState === 1) {
        (_lastRosterList || []).forEach(v => {
            ws.send(JSON.stringify({ type: 'set-ctrl-type', viewerId: v.id.split('_')[0], ctrlType: type }));
        });
    }
    log(I18N.t('Controller type:') + ' ' + type, 'ok');
}

function changeDefaultInputMode(mode) {
    ctrlSettings.defaultInputMode = mode;
    localStorage.setItem('ns_ctrl_defaultInputMode', mode);
    applyCtrlSettingsUI();
    sendCtrlSettings();
    log(I18N.t('Default input mode set to:') + ' ' + mode, 'ok');
}

function sendCtrlSettings() {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
            type: 'ctrl-settings',
            forceXboxOne:     ctrlSettings.forceXboxOne,
            enableDualShock:  ctrlSettings.enableDualShock,
            enableMotion:     ctrlSettings.enableMotion,
            defaultInputMode: ctrlSettings.defaultInputMode,
            hybridInput:      ctrlSettings.hybridInput,
            ctrlType:         ctrlSettings.ctrlType,
        }));
    }
}

function showCtrlModal() {
    applyCtrlSettingsUI();
    document.getElementById('ctrlModal').classList.remove('gone');
}

function closeCtrlModal() {
    document.getElementById('ctrlModal').classList.add('gone');
}

const arcadeConfig = {
    title: localStorage.getItem('ns_arcade_title') || 'Unknown Game',
    desc: localStorage.getItem('ns_arcade_desc') || '',
    thumbnail: localStorage.getItem('ns_arcade_thumb') || '',
    maxPlayers: localStorage.getItem('ns_arcade_maxPlayers') || '4',
    requirePin: localStorage.getItem('ns_arcade_requirePin') === 'true'
};

function showArcadeModal() {
    document.getElementById('arcadeGameTitle').value = arcadeConfig.title;
    document.getElementById('arcadeGameDesc').value = arcadeConfig.desc;
    document.getElementById('arcadeMaxPlayers').value = arcadeConfig.maxPlayers;
    document.getElementById('arcadeRequirePin').checked = arcadeConfig.requirePin;
    document.getElementById('arcadeModal').classList.remove('gone');
}

function closeArcadeModal() {
    document.getElementById('arcadeModal').classList.add('gone');
}

async function startArcadeSession() {
    arcadeConfig.title = document.getElementById('arcadeGameTitle').value.trim() || 'Arcade Game';
    arcadeConfig.desc = document.getElementById('arcadeGameDesc').value.trim();
    arcadeConfig.maxPlayers = document.getElementById('arcadeMaxPlayers').value;
    arcadeConfig.requirePin = document.getElementById('arcadeRequirePin').checked;

    arcadeConfig.thumbnail = await fetchGameThumbnail(arcadeConfig.title);

    localStorage.setItem('ns_arcade_title', arcadeConfig.title);
    localStorage.setItem('ns_arcade_desc', arcadeConfig.desc);
    localStorage.setItem('ns_arcade_thumb', arcadeConfig.thumbnail);
    localStorage.setItem('ns_arcade_maxPlayers', arcadeConfig.maxPlayers);
    localStorage.setItem('ns_arcade_requirePin', arcadeConfig.requirePin);

    closeArcadeModal();

    const needsCapture = !currentStream;
    if (needsCapture) {
        startCapture().then(() => _doArcadeRegister());
    } else {
        _doArcadeRegister();
    }

    // Lock PIN controls while arcade session is live
    const pinSwitch = document.getElementById('arcadeRequirePin');
    const pinDisplay = document.getElementById('pinVal');
    if (pinSwitch) {
        pinSwitch.disabled = true;
        pinSwitch.title = 'Cannot change PIN while session is live';
    }
    if (pinDisplay) {
        pinDisplay.dataset.originalPin = pinDisplay.textContent;
        // Inject a smaller, green badge style instead of plain text
        pinDisplay.innerHTML = '<span style="color:var(--green); font-size:14px; font-weight:800; letter-spacing:0.05em;">Arcade Session</span>';
    }
}

const getHostOS = () => {
    const ua = navigator.userAgent;
    if (ua.includes("Win")) return "Windows";
    if (ua.includes("Mac")) return "macOS";
    if (ua.includes("Linux")) return "Linux";
    return "Unknown OS";
};

function _doArcadeRegister() {
    fetch('/api/info').then(r => r.json()).then(info => {
        if (!info.tunnelUrl) {
            log(I18N.t('⚠ Arcade: No tunnel URL yet. Start a tunnel first, then launch Arcade.'), 'warn');
            return;
        }
        log(I18N.t('Arcade Mode: ${arcadeConfig.title} (${arcadeConfig.maxPlayers} players) → ${info.tunnelUrl}').replace('${arcadeConfig.title}', arcadeConfig.title).replace('${arcadeConfig.maxPlayers}', arcadeConfig.maxPlayers).replace('${info.tunnelUrl}', info.tunnelUrl), 'ok');

        if (info.tunnelUrl && !info.tunnelUrl.includes('voiceMode')) {
            const _sep = info.tunnelUrl.includes('?') ? '&' : '?';
            info.tunnelUrl += _sep + 'voiceMode=' + (arcadeConfig.captureMic ? 'push-to-talk' : 'off');
        }
        if (!arcadeConfig.requirePin && pinEnabled) {
            pinEnabled = false;
            arcadeOverrodePin = true;
            const btn = document.getElementById('pinToggle');
            if (btn) { btn.textContent = 'OFF'; btn.className = 'pin-toggle-btn'; }
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: false }));
            log(I18N.t('PIN disabled for Arcade session'), 'ok');
        }

        const getPingData = () => ({
            id: hostSessionId,
            game: arcadeConfig.title,
            thumbnail: arcadeConfig.thumbnail,
            hasPin: arcadeConfig.requirePin,
            url: info.tunnelUrl,
            region: `${knownViewers.size + 1}/${arcadeConfig.maxPlayers} Players • ${getHostOS()}`
        });

        arcadeChannel.trigger('client-session-ping', getPingData());
        sysChat(I18N.t('Arcade Mode started:') + ' ' + arcadeConfig.title);
        document.getElementById('btnArcade').innerHTML = '<span style="color:var(--green); font-weight:bold; font-size: 10px;">ARCADE<br>LIVE</span>';

        if (arcadePingInterval) clearInterval(arcadePingInterval);
        arcadePingInterval = setInterval(() => {
            arcadeChannel.trigger('client-session-ping', getPingData());
        }, 10000);

    }).catch(() => log(I18N.t('Arcade: Could not read server info'), 'err'));
}

const SVG_EYE_OPEN   = '<img src="/assets/icons/eye.svg"     style="width:20px;height:20px;filter:invert(0.6);pointer-events:none;" alt="">';
const SVG_EYE_CLOSED = '<img src="/assets/icons/eye-off.svg" style="width:20px;height:20px;filter:invert(0.6);pointer-events:none;" alt="">';

let previewHidden = false;
function togglePreview() {
    previewHidden = !previewHidden;
    const prev = document.getElementById('preview');
    const btn  = document.getElementById('btnPreviewToggle');
    const overlay = document.getElementById('prevOverlay');

    if (previewHidden) {
        prev.srcObject = null;
        prev.style.display = 'none';
        // Only say "stream still active" if there actually IS a stream
        if (overlay) {
            overlay.classList.remove('hidden');
            const sp = overlay.querySelector('span');
            if (sp) sp.textContent = currentStream
                ? 'Preview hidden — stream still active'
                : 'Click Start to begin sharing';
        }
        if (btn) { btn.innerHTML = SVG_EYE_CLOSED; btn.style.color = 'var(--warn)'; }
        log(I18N.t('Preview hidden — stream unaffected'), 'ok');
    } else {
        prev.style.display = 'block';
        if (currentStream) {
            prev.srcObject = currentStream;
            if (overlay) overlay.classList.add('hidden');
        }
        if (btn) { btn.innerHTML = SVG_EYE_OPEN; btn.style.color = ''; }
        log(I18N.t('Preview restored'), 'ok');
    }
}

const appSettings = {
    tray:              localStorage.getItem('ns_app_tray') !== 'false',
    alwaysOnTop:       localStorage.getItem('ns_app_alwaysOnTop') === 'true',
    hidePreviewOnStart:localStorage.getItem('ns_app_hidePreview') === 'true',
    captureMic:        localStorage.getItem('ns_app_captureMic') === 'true',
};
let selectedMicDeviceId   = localStorage.getItem('ns_audio_input')  || 'default';
let selectedOutputDeviceId= localStorage.getItem('ns_audio_output') || 'default';

function showAppSettings() {
    applyAppSettingsUI();
    enumerateAudioDevices();
    document.getElementById('appSettingsModal').classList.remove('gone');
}
function closeAppSettings() {
    document.getElementById('appSettingsModal').classList.add('gone');
}

function applyAppSettingsUI() {
    const pairs = [
        ['tray',              'settingTrackTray',        'settingRowTray'],
        ['alwaysOnTop',       'settingTrackAlwaysOnTop', 'settingRowAlwaysOnTop'],
        ['hidePreviewOnStart','settingTrackHidePreview', 'settingRowHidePreview'],
        ['captureMic',        'settingTrackMic',         'settingRowMic'],
    ];
    pairs.forEach(([key, trackId, rowId]) => {
        const track = document.getElementById(trackId);
        const row   = document.getElementById(rowId);
        if (track) track.classList.toggle('on', !!appSettings[key]);
        if (row)   row.classList.toggle('active', !!appSettings[key]);
    });
        const micRow = document.getElementById('micDeviceRow');
        if (micRow) micRow.style.display = appSettings.captureMic ? 'block' : 'none';
}

function toggleAppSetting(key) {
    appSettings[key] = !appSettings[key];
    localStorage.setItem('ns_app_' + key, appSettings[key]);
    applyAppSettingsUI();

    if (key === 'alwaysOnTop' && window.electronAPI?.toggleAlwaysOnTop) {
        window.electronAPI.toggleAlwaysOnTop();
    }
    log(I18N.t('Setting') + ' ' + key + ' = ' + appSettings[key], 'ok');
}

function saveAudioDevice(type, deviceId) {
    if (type === 'input') {
        selectedMicDeviceId = deviceId;
        localStorage.setItem('ns_audio_input', deviceId);
    } else {
        selectedOutputDeviceId = deviceId;
        localStorage.setItem('ns_audio_output', deviceId);

        // ── THE FIX: Route viewer voices explicitly to hardware ──
        // This forces the voice chat to bypass NearsecVirtual, preventing stream echo
        document.querySelectorAll('audio[id^="remote-audio-"]').forEach(el => {
            if (typeof el.setSinkId === 'function') {
                const targetId = deviceId === 'default' ? '' : deviceId;
                el.setSinkId(targetId).catch(e => console.warn('[Audio] setSinkId error:', e));
            }
        });

        if (typeof log === 'function') {
            log(deviceId === 'default' ? 'Viewer output set to Default (Warning: May cause echo)' : 'Viewer output securely routed to hardware', 'ok');
        }
    }
}

async function enumerateAudioDevices() {
    try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        tempStream.getTracks().forEach(t => t.stop());
    } catch (e) { }

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();

        const inputSel  = document.getElementById('audioInputSelect');
        const outputSel = document.getElementById('audioOutputSelect');
        if (!inputSel || !outputSel) return;

        const inputs  = devices.filter(d => d.kind === 'audioinput');
        const outputs = devices.filter(d => d.kind === 'audiooutput');

        inputSel.innerHTML  = '<option value="default">Default Microphone</option>';
        outputSel.innerHTML = '<option value="default">Default (all system audio)</option>';

        inputs.forEach(d => {
            const o = document.createElement('option');
            o.value = d.deviceId;
            o.text  = d.label || ('Microphone ' + (inputs.indexOf(d) + 1));
            if (d.deviceId === selectedMicDeviceId) o.selected = true;
            inputSel.appendChild(o);
        });
        outputs.forEach(d => {
            const o = document.createElement('option');
            o.value = d.deviceId;
            o.text  = d.label || ('Audio Device ' + (outputs.indexOf(d) + 1));
            if (d.deviceId === selectedOutputDeviceId) o.selected = true;
            outputSel.appendChild(o);
        });
    } catch (e) {
        log(I18N.t('Audio device enumeration failed:') + ' ' + e.message, 'warn');
    }
}

function sysChat(text) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat', from: 'Nearsec', msg: text }));
    appendChat('Nearsec', text, false);
}

let globalViewerVolume = 1.0;
window.setGlobalViewerVolume = function(val) {
    globalViewerVolume = val / 100;
    const valDisplay = document.getElementById('globalViewerVolVal');
    if (valDisplay) valDisplay.textContent = val;

    Object.keys(viewerAudioStates).forEach(vid => {
        const audioEl = document.getElementById('remote-audio-' + vid);
        // Only apply if the individual viewer isn't locally or globally muted (states 0 and 1)
        if (audioEl && viewerAudioStates[vid].state < 2) {
            audioEl.volume = (viewerAudioStates[vid].vol / 100) * globalViewerVolume;
        }
    });
};

function createVirtualAudioCable() {
    log(I18N.t('Creating virtual audio cable...'), 'ok');
    fetch('/api/create-virtual-audio', { method: 'POST' })
    .then(r => r.json())
    .then(res => {
        if (res.success) {
            log(I18N.t('Virtual cable created! Updating devices...'), 'ok');
            setTimeout(() => {
                enumerateAudioDevices();
                document.getElementById('virtualAudioHelp').style.color = 'var(--accent)';
            }, 1000);
        } else {
            log(I18N.t('Failed to create cable:') + ' ' + res.error, 'err');
        }
    }).catch(e => log(I18N.t('Network error creating cable'), 'err'));
}

applyCtrlSettingsUI();
connectWS();

// ── AUTOMATED HEADLESS BOOT (Arcade Worker) ───────────────────────────
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('auto') === '1') {
    let autoTitle = urlParams.get('title') || 'Arcade Game';
    const autoTunnel = urlParams.get('tunnel') || 'cloudflared';

    console.log(`[Headless] Initializing automated boot for: ${autoTitle}`);

    const isLinux = navigator.userAgent.includes('Linux') || navigator.platform.toLowerCase().includes('linux');
    if (isLinux) {
        console.log('[Headless] Auto-generating virtual audio sink...');
        fetch('/api/create-virtual-audio', { method: 'POST' }).catch(()=>{});
    }

    setTimeout(() => {
        fetch('/api/start-tunnel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: autoTunnel, remember: true })
        }).catch(()=>{});

        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tunnelProvider: autoTunnel, neverAsk: true })
        }).then(() => {
            fetch('/api/config').then(r => r.json()).then(cfg => {
                let target = (cfg.autoHosts || []).find(h => h.name === autoTitle);
                if (!target && cfg.autoHosts && cfg.autoHosts.length > 0) {
                    target = cfg.autoHosts[0];
                    autoTitle = target.name;
                    console.log(`[Headless] Target title not found, defaulting to: ${target.name}`);
                }

                document.getElementById('arcadeGameTitle').value = autoTitle;
                document.getElementById('arcadeMaxPlayers').value = target?.maxPlayers || "4";
                document.getElementById('arcadeRequirePin').checked = false;

                if (target && target.cmd) {
                    console.log(`[Headless] Launching game process: ${target.cmd}`);
                    fetch('/api/restart-game', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ command: target.cmd })
                    });
                }

                setTimeout(async () => {
                    if (window.electronAPI) {
                        try {
                            const sources = await window.electronAPI.getWindowSources();
                            let virtualScreen = sources.find(s => s.isScreen);
                            if (virtualScreen) {
                                console.log(`[Headless] Locked onto isolated virtual display: ${virtualScreen.id}`);
                                selectedSourceId = virtualScreen.id;
                            } else {
                                console.log('[Headless] No virtual display found, attempting fallback.');
                            }
                        } catch (e) {
                            console.log('[Headless] Failed to scan displays:', e);
                        }
                    }
                    startArcadeSession();
                }, 4000);
            });
        });
    }, 1500);
}
