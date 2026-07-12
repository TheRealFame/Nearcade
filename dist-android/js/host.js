function closeAllModals() {
    document.querySelectorAll(".modal-bg").forEach(m => m.classList.add("gone"));
}

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws, currentStream, peerConnections = {}, knownViewers = new Set(), vrActiveViewers = new Set(), viewerCount = 0;
let audioCtx, analyser, animFrame;
let pinEnabled = true, currentPin = '----';
let kbmPanicActive = false;
const viewerAudioStates = {}; // Tracks { volume: 100, state: 0 } per viewer

// ── HOISTED CONFIG — declared here to prevent TDZ ReferenceErrors ─────────────
// These are `const`/`let` — not hoisted like `var`. Any onclick or early function
// that runs before the bottom of the file would throw "Cannot access before init".
const ctrlSettings = {
    forceXboxOne:     localStorage.getItem('ns_ctrl_forceXboxOne')    === 'true',
    enableDualShock:  localStorage.getItem('ns_ctrl_enableDualShock')  === 'true',
    enableMotion:     localStorage.getItem('ns_ctrl_enableMotion')     === 'true',
    defaultInputMode: localStorage.getItem('ns_ctrl_defaultInputMode') || 'gamepad',
    hybridInput:      localStorage.getItem('ns_ctrl_hybridInput')      === 'true',
    ctrlType:         localStorage.getItem('ns_ctrl_ctrlType')         || 'xbox360',
    touchLayout:      localStorage.getItem('ns_ctrl_touchLayout')      || 'default',
};

const appSettings = {
    tray:              localStorage.getItem('ns_app_tray') !== 'false',
    alwaysOnTop:       localStorage.getItem('ns_app_alwaysOnTop') === 'true',
    hidePreviewOnStart:localStorage.getItem('ns_app_hidePreview') === 'true',
    captureMic:        localStorage.getItem('ns_app_captureMic') === 'true',
};
let selectedMicDeviceId    = localStorage.getItem('ns_audio_input')  || 'default';
let selectedOutputDeviceId = localStorage.getItem('ns_audio_output') || 'default';

let previewHidden = false;
let _lastChatFingerprint = '';
let _lastChatTimestamp = 0;
const CHAT_DEDUP_WINDOW_MS = 1200;

function makeChatFingerprint(name, text) {
    return `${String(name).trim()}|${String(text).trim()}`;
}

// ── PPS (Packets-Per-Second) flood protection ─────────────────────────────────
// Tracks input message counts per viewer. If any viewer exceeds 300 msgs/sec
// they are immediately disconnected.
const _ppsCount  = {};          // viewerId → count in current window
const _ppsWindow = {};          // viewerId → window start timestamp (ms)
const PPS_LIMIT  = 300;
const PPS_WINDOW = 1000;        // ms

function _checkPps(viewerId) {
    const now = Date.now();
    if (!_ppsWindow[viewerId] || now - _ppsWindow[viewerId] >= PPS_WINDOW) {
        _ppsWindow[viewerId] = now;
        _ppsCount[viewerId]  = 1;
        return true;
    }
    _ppsCount[viewerId]++;
    if (_ppsCount[viewerId] > PPS_LIMIT) {
        console.warn(`[PPS] Viewer ${viewerId} exceeded ${PPS_LIMIT} inputs/sec — disconnecting`);
        log(`Flood protection: kicked ${viewerId} (>${PPS_LIMIT} pps)`, 'warn');
        // Tell the server to sever this viewer's connection
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'kick-viewer', viewerId, reason: 'pps_flood' }));
        }
        delete _ppsCount[viewerId];
        delete _ppsWindow[viewerId];
        return false;
    }
    return true;
}

// ── VPS SFU connection state ──────────────────────────────────────────────────
let _vpsWs         = null;
let _vpsConfig     = null;   // { vpsEnabled, vpsUrl, vpsMasterKey }
let _vpsAuthOk     = false;
let _smartDb       = {};
let _viewerRegions = {};
let _pendingVpsViewers = new Map();
let hostRegion     = '';
let _tunnelBusy    = false;
let _turnCredentials = null;

// Fetch secure TURN credentials from local server on boot
let _turnFetchPromise = fetch('/api/turn').then(r => r.json()).then(c => {
    if (!c.error && c.urls) _turnCredentials = c;
    return c;
}).catch(() => null);
// ─────────────────────────────────────────────────────────────────────────────

async function loadAppConfig() {
    if (window.electronAPI?.getSettings) return window.electronAPI.getSettings();
    try {
        const r = await fetch('/api/config');
        return await r.json();
    } catch (_) { return {}; }
}

async function saveAppConfig(patch) {
    if (window.electronAPI?.saveSettings) {
        await window.electronAPI.saveSettings(patch);
        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        }).catch(() => {});
        return;
    }
    await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
    });
}

// Helper to save a setting to BOTH localStorage AND config file
async function saveSetting(localStorageKey, value, configKey) {
    if (!configKey) configKey = localStorageKey;
    localStorage.setItem(localStorageKey, value);
    saveAppConfig({ [configKey]: value });
}

let _tunnelModalManual = false; // set when user manually opens tunnel modal

function setTunnelBusy(busy) {
    _tunnelBusy = busy;
    document.querySelectorAll('.provider-card, #tunnelModal .modal-footer button').forEach(el => {
        el.style.pointerEvents = busy ? 'none' : '';
        el.style.opacity = busy ? '0.5' : '';
    });
}

function forceWebCodecsKeyframe() {
    if (_wcEncoder && _wcEncoder.state === 'configured') _wcForceKeyframe = true;
}

function vpsDispatch(viewerId, payload) {
    if (!_vpsWs || _vpsWs.readyState !== 1) return;
    _vpsWs.send(JSON.stringify({
        type: 'viewer-dispatch',
        viewerId,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }));
}

async function sendVpsViewerBootstrap(viewerId) {
    const cfg = await loadAppConfig();
    vpsDispatch(viewerId, {
        type: 'host-connected',
        hostName: cfg.hostName || 'Host',
        hostRegion,
    });
    let expDevices = [];
    try {
        if (typeof appConfig !== 'undefined' && appConfig.expDevices) expDevices = appConfig.expDevices;
        else expDevices = JSON.parse(localStorage.getItem('ns_exp_devices') || '[]');
    } catch(e) {}

    vpsDispatch(viewerId, {
        type: 'ctrl-settings',
        touchLayout: ctrlSettings.touchLayout,
        enableMotion: ctrlSettings.enableMotion,
        expDevices: expDevices,
    });
    if (_smartDb && Object.keys(_smartDb).length) {
        vpsDispatch(viewerId, { type: 'smart-db', payload: _smartDb });
    }
    if (currentStream) {
        vpsDispatch(viewerId, { type: 'host-stream-ready' });
    } else {
        vpsDispatch(viewerId, { type: 'host-not-streaming', viewerId });
    }
}

function handleVpsJoin(viewerId, inner) {
    const name = String(inner.name || 'Viewer').slice(0, 20);
    const pin  = String(inner.pin || '');
    const region = String(inner.viewerRegion || '').toLowerCase().slice(0, 2);
    if (region) _viewerRegions[viewerId] = region;

    if (pinEnabled && pin !== currentPin) {
        vpsDispatch(viewerId, { type: 'pin-rejected' });
        return;
    }

    _pendingVpsViewers.set(viewerId, { name, region, isDesktopApp: !!inner.isDesktopApp });
    if (_vpsWs && _vpsWs.readyState === 1) {
        _vpsWs.send(JSON.stringify({ type: 'viewer-authorized', viewerId }));
    }
}

fetch('https://get.geojs.io/v1/ip/country.json')
    .then(r => r.json())
    .then(d => { hostRegion = String(d.country || '').toLowerCase().slice(0, 2); })
    .catch(() => {});

if (window.electronAPI?.getControllers) {
    window.electronAPI.getControllers().then(db => { _smartDb = db || {}; }).catch(() => {});
}

// ── NULL-SAFE DOM HELPERS ─────────────────────────────────────────────────────
// Prevents TypeError crashes when an element ID is missing after a layout refactor.
function _elDisabled(id, val) { const e = document.getElementById(id); if (e) e.disabled = val; }
function _elText(id, val)     { const e = document.getElementById(id); if (e) e.textContent = val; }
function _elClass(id, cls, add) { const e = document.getElementById(id); if (e) e.classList[add ? 'add' : 'remove'](cls); }

function updatePlaygroundToolbarState(isLive) {
    if (!document.body.dataset.playgroundHost) return;
    const startBtn = document.getElementById('btnStart');
    const stopBtn = document.getElementById('btnStop');
    if (startBtn) {
        startBtn.style.display = isLive ? 'none' : '';
        const title = startBtn.querySelector('.tile-title');
        const subtitle = startBtn.querySelector('.tile-subtitle');
        if (title) title.textContent = isLive ? 'Streaming' : 'Start Stream';
        if (subtitle) subtitle.textContent = isLive ? 'Live broadcast active' : 'Broadcast your gameplay';
    }
    if (stopBtn) {
        stopBtn.style.display = isLive ? '' : 'none';
    }
}
// ─────────────────────────────────────────────────────────────────────────────

let audioSettings = {
    forceAudioEnabled: localStorage.getItem('ns_force_audio_enabled') !== 'false',
        defaultDevice: localStorage.getItem('ns_audio_device') || 'default'
};

Pusher.logToConsole = false;
const pusher = new Pusher('a93f5405058cd9fc7967', {
    cluster: 'us2',
    authEndpoint: 'https://nearcade.cutefame.net/api/pusher-auth'
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
const hostSessionId = 'ns-' + (window.crypto?.randomUUID ? window.crypto.randomUUID().slice(0, 9) : Math.random().toString(36).substr(2, 9));

// ── Version check ────────────────────────────────────────────────────────────
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const na = pa[i] || 0, nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

async function _checkClientVersion() {
    try {
        const res = await fetch('https://nearcade.cutefame.net/api/client-version');
        if (!res.ok) return;
        const data = await res.json();
        const minVer = data.minimum || '0.0.0';
        if (compareVersions(window.NEARSEC_VERSION, minVer) < 0) {
            const overlay = document.createElement('div');
            overlay.id = 'versionCheckOverlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = '<div style="background:#121518;border:1px solid #ff5d3d;border-radius:12px;padding:40px;max-width:420px;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,0.8);font-family:sans-serif;">'
                + '<h2 style="color:#ff5d3d;margin:0 0 12px 0;text-transform:uppercase;letter-spacing:1px;">Client Outdated</h2>'
                + '<p style="color:#949ba4;font-size:14px;line-height:1.6;margin:0 0 16px 0;">'
                + 'You are running <strong style="color:#f0f3f5;">Nearcade v' + window.NEARSEC_VERSION + '</strong>.<br>'
                + 'The arcade directory requires at least <strong style="color:#f0f3f5;">v' + minVer + '</strong>.<br><br>'
                + 'Please update to the latest version to continue hosting arcade sessions.</p>'
                + '<a href="https://github.com/TheRealFame/Nearcade/releases/latest" target="_blank" style="display:inline-block;background:#ff5d3d;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Download Update</a>'
                + '</div>';
            document.body.appendChild(overlay);
        }
    } catch (_) {}
}


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
    if (el) el.textContent = v + (el.id === 'desktopVolVal' ? (document.getElementById('volDesktopVal') ? '' : '') : '');
    const el2 = document.getElementById('volDesktopVal');
    if (el2) el2.textContent = v + '%';
    
    const s1 = document.getElementById('desktopVolSlider');
    if (s1 && s1.value != v) s1.value = v;
    const s2 = document.getElementById('volDesktop');
    if (s2 && s2.value != v) s2.value = v;

    saveSetting('ns_host_desktop_vol', v, 'volumeDesktop');
    if (!window._masterMuteActive && _desktopGainNode)
        _desktopGainNode.gain.value = v / 100;
}

function setHostMicGain(val) {
    const v = parseInt(val, 10);
    const el = document.getElementById('hostMicVal');
    if (el) el.textContent = v;
    const el2 = document.getElementById('volMicVal');
    if (el2) el2.textContent = v + '%';

    const s1 = document.getElementById('hostMicSlider');
    if (s1 && s1.value != v) s1.value = v;
    const s2 = document.getElementById('volMic');
    if (s2 && s2.value != v) s2.value = v;

    saveSetting('ns_host_mic_gain', v, 'volumeMic');
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

        //  Apply the 1.4x Volume Buff here!
        gain.gain.value = window._masterMuteActive ? 0 : (savedVol * 1.4);

        src.connect(gain);
        gain.connect(dst);
        _desktopGainNode = gain;

        // 🛡 Prevent Chrome from aggressively deleting the audio pipeline
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
        try { // <--- OUTER TRY STARTS HERE
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
            const configuredBitrate = parseInt(document.getElementById('bitrateSelect')?.value, 10) || 0;
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

            if (typeof _wcEncoder !== 'undefined' && _wcEncoder && _wcEncoder.state !== 'closed' && _wcEncoder._lastConfig) {
                try {
                    _wcEncoder._lastConfig.bitrate = Math.round(recovered);
                    _wcEncoder.configure(_wcEncoder._lastConfig);
                } catch(e) {}
            }

            congestionControl.lastAdjustment[viewerId] = { bitrate: recovered, time: Date.now(), baselineRtt: lastAdj.baselineRtt };
            log(I18N.t('Congestion: Bitrate recovered to ${Math.round(recovered/1000)}kbps for ${viewerId}').replace('${Math.round(recovered/1000)}', Math.round(recovered/1000)).replace('${viewerId}', viewerId), 'ok');
            return;
                }

                if (shouldReduce && timeSinceLastAdj > 2000) {
                    const isCrisp = (degPref === 'maintain-resolution');
                    const reductionFactor = isCrisp ? 0.95 : 0.80;
                    const minFloor        = isCrisp ? 2500000 : 500000;
                    const newBitrate = Math.round(currentBitrate * reductionFactor);

                    try { // <--- INNER TRY (The INVALID_STATE fix)
                        const freshParams = sender.getParameters();
                        if (freshParams.encodings?.length) {
                            freshParams.encodings[0].maxBitrate = Math.max(minFloor, newBitrate);
                            freshParams.encodings[0].degradationPreference = degPref;
                        }
                        await sender.setParameters(freshParams);

                        if (typeof _wcEncoder !== 'undefined' && _wcEncoder && _wcEncoder.state !== 'closed' && _wcEncoder._lastConfig) {
                            try {
                                _wcEncoder._lastConfig.bitrate = Math.max(minFloor, newBitrate);
                                _wcEncoder.configure(_wcEncoder._lastConfig);
                            } catch(e) {}
                        }

                        congestionControl.lastAdjustment[viewerId] = { bitrate: currentBitrate, time: Date.now(), baselineRtt: lastAdj.baselineRtt };
                        log(I18N.t('Congestion: Bitrate reduced to ${Math.round(newBitrate/1000)}kbps (${reason})').replace('${Math.round(newBitrate/1000)}', Math.round(newBitrate/1000)).replace('${reason}', reason), 'warn');
                    } catch (e) {
                        console.warn('[Congestion] Failed to apply bitrate reduction:', e.message);
                    }
                }
        } catch (outerErr) {}
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
        const res = await fetch(`https://nearcade.cutefame.net/api/game-art?title=${encodeURIComponent(gameTitle)}`);
        const data = await res.json();
        return data.thumbnail || '';
    } catch (e) {
        console.warn('Could not fetch official thumbnail:', e);
        return '';
    }
}

function preferVideoCodec(pc) {
    // setCodecPreferences STRICTLY requires codec objects returned by RTCRtpReceiver.getCapabilities.
    // We cannot use RTCRtpSender.getCapabilities here or the browser will throw "Invalid codec preferences".
    const caps = RTCRtpReceiver.getCapabilities?.('video');
    if (!caps || !caps.codecs) return null;
    const val = document.getElementById('codecSelect').value;

    // Match mimeType exactly as WebRTC defines it (case-insensitive)
    const targetMime = 'video/' + (val === 'H265' ? 'hevc' : val).toLowerCase();
    const fallbackMime = val === 'H265' ? 'video/h265' : targetMime;

    let codecs = [...caps.codecs];
    let targetIdx = -1;

    // H264 profile fix for Windows AMD/MediaFoundation decoder bugs:
    // We MUST force Constrained Baseline (42e01f) to the absolute top of the H264 list.
    if (targetMime === 'video/h264') {
        targetIdx = codecs.findIndex(c => c.mimeType.toLowerCase() === 'video/h264' && c.sdpFmtpLine && c.sdpFmtpLine.includes('42e01f'));
    }
    
    if (targetIdx === -1) {
        targetIdx = codecs.findIndex(c => c.mimeType.toLowerCase() === targetMime || c.mimeType.toLowerCase() === fallbackMime);
    }

    // Fallback to browser default if hardware is missing
    if (targetIdx === -1) return null;

    // WebRTC requires RTX/RED codecs to remain adjacent to their base codecs.
    // We lift the selected codec and its RTX companion to the top of the list.
    let count = 1;
    if (codecs[targetIdx + 1] && codecs[targetIdx + 1].mimeType.toLowerCase() === 'video/rtx') {
        count = 2;
    }

    const preferred = codecs.splice(targetIdx, count);
    const sorted = [...preferred, ...codecs];

    let used = null;
    pc.getTransceivers().forEach(t => {
        if (t.sender?.track?.kind === 'video') {
            try {
                t.setCodecPreferences(sorted);
                used = sorted[0]?.mimeType || null;
            } catch (e) {
                console.warn('[WebRTC] Codec preference rejected:', e.message);
            }
        }
    });
    return used;
}

// ── CODEC AUTO-BENCHMARK ──────────────────────────────────────────────────────
// Tests each WebRTC codec the browser supports by:
// 1. Creating a loopback RTCPeerConnection pair
// 2. Streaming test_video.mp4 via a <video> element
// 3. Measuring received bitrate over 8 seconds per codec
// 4. Picking the winner and saving it to localStorage
async function runBenchmark(mode) {
    const btnSpeed = document.getElementById('codecBenchBtnSpeed');
    const btnQuality = document.getElementById('codecBenchBtnQuality');
    const activeBtn = mode === 'speed' ? btnSpeed : btnQuality;
    const inactiveBtn = mode === 'speed' ? btnQuality : btnSpeed;
    const statusEl = document.getElementById('codecBenchStatus');
    const logEl = document.getElementById('codecBenchLog');
    const fillEl = document.getElementById('codecBenchFill');
    const pctEl  = document.getElementById('codecBenchPct');

    if (btnSpeed.dataset.running || btnQuality.dataset.running) return;
    activeBtn.dataset.running = '1';
    btnSpeed.disabled = true;
    btnQuality.disabled = true;
    
    const originalText = activeBtn.textContent;
    activeBtn.textContent = 'Running benchmark...';
    statusEl.style.display = 'block';
    logEl.innerHTML = '';
    fillEl.style.width = '0%';
    pctEl.textContent = '0%';

    function benchLog(msg, color) {
        const d = document.createElement('div');
        d.textContent = msg;
        if (color) d.style.color = color;
        logEl.appendChild(d);
        logEl.scrollTop = logEl.scrollHeight;
    }

    // Get all codecs the browser actually supports via WebRTC
    const caps = RTCRtpSender.getCapabilities?.('video');
    if (!caps) { 
        benchLog('Browser does not support getCapabilities', 'var(--error)'); 
        btnSpeed.disabled = false; btnQuality.disabled = false;
        delete activeBtn.dataset.running; activeBtn.textContent = originalText; 
        return; 
    }

    // Map codec mime types to the codecSelect option values
    const CODEC_MAP = {
        'video/h264': 'H264',
        'video/hevc': 'H265',
        'video/vp8':  'VP8',
        'video/vp9':  'VP9',
        'video/av1':  'AV1',
    };

    // Deduplicate by family
    const seen = new Set();
    const toTest = [];
    for (const c of caps.codecs) {
        const key = c.mimeType.toLowerCase();
        const mapped = CODEC_MAP[key];
        if (mapped && !seen.has(mapped)) { seen.add(mapped); toTest.push({ mime: key, name: mapped, codec: c }); }
    }

    benchLog(`Testing ${toTest.length} codec(s) — 8s each…`);

    // Set up test canvas to simulate video stream
    const testCanvas = document.createElement('canvas');
    testCanvas.width = 1280;
    testCanvas.height = 720;
    const testCtx = testCanvas.getContext('2d');
    testCtx.fillStyle = '#0f111a';
    testCtx.fillRect(0, 0, 1280, 720);
    // Draw a spinning block to force encoder motion
    let testAngle = 0;
    const testAnim = setInterval(() => {
        testCtx.fillStyle = '#0f111a';
        testCtx.fillRect(0, 0, 1280, 720);
        testCtx.save();
        testCtx.translate(640, 360);
        testCtx.rotate(testAngle);
        testCtx.fillStyle = '#8b5cf6';
        testCtx.fillRect(-200, -200, 400, 400);
        testCtx.restore();
        testAngle += 0.1;
    }, 33);

    const results = [];

    for (let i = 0; i < toTest.length; i++) {
        const { mime, name } = toTest[i];
        const pct = Math.round((i / toTest.length) * 100);
        fillEl.style.width = pct + '%';
        pctEl.textContent = pct + '%';

        benchLog(`Testing ${name}...`);
        let bitrate = 0;

        try {
            // Create a loopback PC pair
            const pc1 = new RTCPeerConnection();
            const pc2 = new RTCPeerConnection();
            pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
            pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});

            // Add video track from the test canvas
            const stream = testCanvas.captureStream(30);
            if (!stream) throw new Error('captureStream not supported');
            const [track] = stream.getVideoTracks();
            if (!track) throw new Error('Video track not available yet');
            pc1.addTrack(track, stream);

            // Prefer the specific codec on pc1's sender
            const allCodecs = caps.codecs;
            const preferred = allCodecs.filter(c => c.mimeType.toLowerCase() === mime);
            const rest = allCodecs.filter(c => c.mimeType.toLowerCase() !== mime);
            if (preferred.length === 0) { benchLog(`  - ${name}: not in capabilities — skip`); pc1.close(); pc2.close(); continue; }
            pc1.getTransceivers().forEach(t => {
                if (t.sender?.track?.kind === 'video') {
                    try { t.setCodecPreferences([...preferred, ...rest]); } catch (_) {}
                }
            });

            const offer = await pc1.createOffer();
            await pc1.setLocalDescription(offer);
            await pc2.setRemoteDescription(offer);
            const answer = await pc2.createAnswer();
            await pc2.setLocalDescription(answer);
            await pc1.setRemoteDescription(answer);

            // Wait for connection
            await new Promise((res, rej) => {
                const t = setTimeout(() => rej(new Error('ICE timeout')), 5000);
                pc2.onconnectionstatechange = () => {
                    if (pc2.connectionState === 'connected') { clearTimeout(t); res(); }
                    if (pc2.connectionState === 'failed') { clearTimeout(t); rej(new Error('ICE failed')); }
                };
            });

            // Wait for the codec to actually be negotiated and used
            await new Promise(r => setTimeout(r, 1000));

            // Check what codec actually got selected (not just requested)
            let actualCodec = null;
            try {
                const stats = await pc2.getStats();
                stats.forEach(r => {
                    if (r.type === 'inbound-rtp' && r.kind === 'video' && r.codecId) {
                        const codecStat = stats.get(r.codecId);
                        if (codecStat) actualCodec = codecStat.mimeType;
                    }
                });
            } catch (_) {}

            if (actualCodec && !actualCodec.toLowerCase().includes(mime.split('/')[1])) {
                benchLog(`  - ${name}: browser used ${actualCodec} instead — skip`);
                pc1.close(); pc2.close(); continue;
            }

            // Measure bitrate over 8 seconds
            let lastBytes = 0, lastTime = 0;
            const samples = [];
            for (let s = 0; s < 8; s++) {
                await new Promise(r => setTimeout(r, 1000));
                try {
                    const stats = await pc2.getStats();
                    stats.forEach(r => {
                        if (r.type === 'inbound-rtp' && r.kind === 'video') {
                            if (lastTime > 0) {
                                const kbps = ((r.bytesReceived - lastBytes) * 8) / (r.timestamp - lastTime);
                                if (kbps > 0) samples.push(kbps);
                            }
                            lastBytes = r.bytesReceived;
                            lastTime = r.timestamp;
                        }
                    });
                } catch (_) {}
            }

            bitrate = samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0;
            pc1.close(); pc2.close();
        } catch (err) {
            benchLog(`  - ${name}: ${err.message}`, 'var(--warn)');
            continue;
        }

        if (bitrate > 0) {
            benchLog(`  + ${name}: ${bitrate} kbps`, 'var(--accent)');
            results.push({ name, bitrate });
        } else {
            benchLog(`  - ${name}: no frames received`);
        }
    }

    clearInterval(testAnim);

    fillEl.style.width = '100%';
    pctEl.textContent = '100%';

    if (results.length === 0) {
        benchLog('No codec produced usable output. Check GPU/driver.', 'var(--error)');
    } else {
        if (mode === 'speed') {
            document.getElementById('resSelect').value = "720";
            document.getElementById('fpsSelect').value = "60";
            // Sort by bitrate descending — highest throughput = fastest codec
            results.sort((a, b) => b.bitrate - a.bitrate);
        } else {
            document.getElementById('resSelect').value = "1080";
            document.getElementById('fpsSelect').value = "60";
            // Best quality is typically AV1 > H265 > VP9 > H264 > VP8
            const qualityOrder = ['AV1', 'H265', 'VP9', 'H264', 'VP8'];
            results.sort((a, b) => {
                const idxA = qualityOrder.indexOf(a.name);
                const idxB = qualityOrder.indexOf(b.name);
                if (idxA === idxB) return b.bitrate - a.bitrate;
                return (idxA !== -1 ? idxA : 99) - (idxB !== -1 ? idxB : 99);
            });
        }
        
        applyBitrateToAll(); // Applies the new resolution and FPS
        
        const winner = results[0];
        benchLog(`Best: ${winner.name} @ ${winner.bitrate} kbps — applied!`, '#22c55e');
        document.getElementById('codecSelect').value = winner.name;
        localStorage.setItem('ns_codec', winner.name);
        // Reapply to live connections if any
        Object.values(peerConnections).forEach(pc => { if (pc) preferVideoCodec(pc); });
    }

    btnSpeed.disabled = false;
    btnQuality.disabled = false;
    activeBtn.textContent = originalText;
    delete activeBtn.dataset.running;
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

            const degPref = document.getElementById('degSelect')?.value || 'maintain-framerate';
            params.encodings[0].degradationPreference = degPref;
        }
        await sender.setParameters(params);
    } catch (e) {
        console.warn('[WebRTC] Failed to apply low latency params:', e.message);
    }
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
    
    const timeSpan = document.createElement('span');
    timeSpan.style.opacity = '0.5';
    timeSpan.style.marginRight = '6px';
    timeSpan.textContent = '[' + new Date().toLocaleTimeString() + ']';
    d.appendChild(timeSpan);
    
    const textNode = document.createTextNode(I18N.t(msg));
    d.appendChild(textNode);
    
    if (el) { el.appendChild(d); el.scrollTop = el.scrollHeight; }
    const mini = document.getElementById('lastLogLine');
    if (mini) { mini.textContent = I18N.t(msg); mini.style.color = cls === 'ok' ? 'var(--accent)' : cls === 'err' ? 'var(--danger)' : cls === 'warn' ? 'var(--warn)' : '#333'; }
}

function appendChat(name, text, isMe) {
    const fingerprint = makeChatFingerprint(name, text);
    const now = Date.now();
    if (fingerprint === _lastChatFingerprint && now - _lastChatTimestamp < CHAT_DEDUP_WINDOW_MS) {
        return;
    }
    _lastChatFingerprint = fingerprint;
    _lastChatTimestamp = now;

    const el = document.getElementById('chatLog');
    const d = document.createElement('div');
    d.className = 'cmsg';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'cname' + (isMe ? ' me' : '');
    nameSpan.textContent = name;
    d.appendChild(nameSpan);
    d.appendChild(document.createTextNode(text));
    if (el) {
        el.appendChild(d);
        el.scrollTop = el.scrollHeight;
    }
}

function sendChat() {
    const inp = document.getElementById('chatMsg');
    const msg = inp.value.trim(); if (!msg || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat', from: 'Host', msg }));
    appendChat('Host', msg, true);
    inp.value = '';
}

function setCapDot(state) {
    const d = document.getElementById('capDot');
    const s = document.getElementById('capStatus');
    if (d) d.className = 'dot' + (state === 'live' ? ' live' : state === 'err' ? ' err' : '');
    if (s) s.textContent = state === 'live' ? 'Live' : state === 'err' ? 'Error' : 'Idle';
}

function setAudDot(state, label) {
    const d = document.getElementById('audDot');
    const s = document.getElementById('audStatus');
    if (d) d.className = 'dot' + (state === 'live' ? ' live' : state === 'warn' ? ' warn' : '');
    if (s) s.textContent = label;
}

// ── V3 UI UPDATE ──
async function renderUrls(d) {
    // 1. Fetch the REAL host name and tunnel provider from your backend config FIRST
    let hostName = 'A player';
    let isPortForward = false;
    try {
        const cfg = await fetch('/api/config').then(r => r.json());
        if (cfg && cfg.hostName) hostName = cfg.hostName;
        if (cfg && cfg.tunnelProvider === 'portforward') isPortForward = true;
    } catch (e) {}

    const encodedName = encodeURIComponent(hostName);

    // 2. Append it to the tunnel URL
    let finalTunnelUrl = null;
    if (d.tunnelUrl) {
        const separator = d.tunnelUrl.includes('?') ? '&' : '?';
        const pSelect = document.getElementById('pipelineSelect');
        const pipeArg = (pSelect && pSelect.value === 'custom_webcodecs') ? '&wc=2' : ((pSelect && pSelect.value === 'webcodecs') ? '&wc=1' : ((pSelect && pSelect.value === 'webtransport') ? '&wt=1' : ''));
        finalTunnelUrl = `${d.tunnelUrl}${separator}host=${encodedName}${pipeArg}`;
    }
    window._globalTunnelUrl = finalTunnelUrl;

    const pSelect = document.getElementById('pipelineSelect');
    const pipeArg = (pSelect && pSelect.value === 'custom_webcodecs') ? '&wc=2' : ((pSelect && pSelect.value === 'webcodecs') ? '&wc=1' : ((pSelect && pSelect.value === 'webtransport') ? '&wt=1' : ''));

    const rows = [];
    const isPlaygroundHost = document.body?.dataset.playgroundHost === '1' || document.body?.dataset.playgroundHost === 'true';
    
    // Check if we are running in P2P mode!
    if (window._isP2P && window._p2pCode) {
        rows.push({ url: window._p2pCode, label: 'P2P ROOM CODE', color: 'var(--accent2)' });
    } else if (finalTunnelUrl) {
        rows.push({ url: finalTunnelUrl, label: 'HTTPS tunnel (v3) ← share this', color: 'var(--accent)' });
    } else if (!isPortForward) {
        rows.push({ url: 'Waiting for tunnel...', label: 'tunnel starting up', color: '#444', noclick: true });
    }

    if (!window._isP2P && !isPlaygroundHost) {
        rows.push({ url: `http://${d.lanIP}:${d.port}/?v3&host=${encodedName}${pipeArg}`, label: 'LAN (v3) — same network only', color: '#555' });
    }

    if (!finalTunnelUrl && d.publicIP && !isPlaygroundHost)
        rows.splice(1, 0, { url: `http://${d.publicIP}:${d.port}/?v3&host=${encodedName}${pipeArg}`, label: 'Public IP (v3) (needs port forward)', color: '#666' });

    // 3. NOW clear the HTML and append (prevents the async duplication bug)
    const el = document.getElementById('urlList');
    if (el) {
        el.innerHTML = '';
        rows.forEach(r => {
            const div = document.createElement('div');
            div.className = 'url-row';
            div.style.color = r.color;
            div.style.display = 'block';
            div.style.width = '100%';
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

    // Always show LAN IP as a secondary row — useful even in VPS mode for local testing
    if (d.lanIP && !isPlaygroundHost) {
        const lanUrl = `http://${d.lanIP}:${d.port}/?v3&host=${encodedName}`;
        const existing = [...(el?.querySelectorAll('.url-row') || [])].find(e => e.textContent.includes(d.lanIP));
        if (!existing && el) {
            const lanDiv = document.createElement('div');
            lanDiv.className = 'url-row';
            lanDiv.style.color = '#555';
            lanDiv.textContent = lanUrl;
            lanDiv.onclick = () => {
                navigator.clipboard.writeText(lanUrl).catch(() => {});
                const tmp = lanDiv.textContent; lanDiv.textContent = 'copied!';
                setTimeout(() => { lanDiv.textContent = tmp; }, 1500);
            };
            const lanSub = document.createElement('div');
            lanSub.className = 'url-label';
            lanSub.textContent = 'LAN (v3) — same network only';
            el.appendChild(lanDiv);
            el.appendChild(lanSub);
        }
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
    const overlayC = document.getElementById('rosterOverlayList');
    const overlayO = document.getElementById('rosterOverlayEmpty');

    if (!c || !o) return;
    
    const controllers = list;

    const listStr = JSON.stringify(controllers);
    if (c.dataset.lastList === listStr) return;
    
    // Prevent wiping the DOM if the user is currently interacting with a dropdown
    if (document.activeElement && document.activeElement.tagName === 'SELECT') {
        return;
    }
    
    c.dataset.lastList = listStr;

    if (controllers.length === 0) {
        c.innerHTML = '';
        o.style.display = 'block';
        if (overlayC) overlayC.innerHTML = '';
        if (overlayO) overlayO.style.display = 'block';
        return;
    }
    o.style.display = 'none';
    c.innerHTML = '';
    if (overlayO) overlayO.style.display = 'none';
    if (overlayC) overlayC.innerHTML = '';

    controllers.forEach((v, index) => {
        const r = document.createElement('div');
        r.className = 'rcard';
        r.draggable = !v.locked;
        r.dataset.id = v.id;
        if (v.locked) r.style.opacity = '0.7';

        let currentMode = v.inputMode || 'gamepad';
        const isGuest = v.name.startsWith('Guest');

        if (!isGuest && v.id !== 'host_0' && savedViewerModes[v.name] && currentMode !== savedViewerModes[v.name]) {
            currentMode = savedViewerModes[v.name];
            changeInputMode(v.id, currentMode, v.name);
        }
        
        let displayName = v.name;
        if (vrActiveViewers.has(v.id.split('_')[0])) {
            displayName += ' <span style="color:var(--accent);font-size:10px;">(VR)</span>';
        }

        let iconSrc = '/assets/icons/gamepad.svg';
        if (currentMode === 'disabled') iconSrc = '/assets/icons/circle-off.svg';
        if (currentMode === 'kbm') iconSrc = '/assets/icons/keyboard.svg';
        if (currentMode === 'kbm_emulated') iconSrc = '/assets/icons/arrow-up-from-line.svg';
        if (currentMode === 'experimental') iconSrc = '/assets/icons/plug.svg';

        if (!viewerAudioStates[v.id]) viewerAudioStates[v.id] = { vol: 100, state: 0 };
        const audState = _globalMicKillActive ? 3 : viewerAudioStates[v.id].state;
        const micSvg   = _micSvg(audState);
        const micTitle = _micTitles[audState];

        r.innerHTML = `
        <div class="rnum">${index + 1}</div>
        <div style="flex:1; overflow:hidden;">
        <div class="rname">${_viewerRegions[v.id] ? `<span class="fi fi-${_viewerRegions[v.id]}"></span> ` : ''}${displayName}</div>
        <div style="display:flex; align-items:center; gap:6px; margin-top:4px;">
        <img src="${iconSrc}" style="width:14px;height:14px;filter:invert(0.8);" id="icon-${v.id}" />
        ${v.id === 'host_0' ? `<span style="font-size:9px;color:var(--muted);">Host</span>` : `
        <select class="form-select" style="padding:2px 4px;font-size:9px;width:auto;"
        onchange="changeInputMode('${v.id}', this.value, '${v.name.replace(/'/g, "\\'")}'); this.blur();">
        <option value="gamepad"       ${currentMode === 'gamepad'       ? 'selected' : ''}>Gamepad</option>
        <option value="kbm"           ${currentMode === 'kbm'           ? 'selected' : ''}>Raw KBM</option>
        <option value="kbm_emulated"  ${currentMode === 'kbm_emulated'  ? 'selected' : ''}>Emulated KBM</option>
        <option value="experimental"  ${currentMode === 'experimental'  ? 'selected' : ''}>Experimental Hardware</option>
        <option value="disabled"      ${currentMode === 'disabled'      ? 'selected' : ''}>Disabled</option>
        </select>
        `}
        ${v.id === 'host_0' ? '' : `
        <div style="width:1px;height:12px;background:var(--border2);margin:0 2px;"></div>
        <button onclick="cycleViewerMic('${v.id}')" title="${micTitle}"
        id="mic-btn-${v.id}"
        style="background:none;border:none;cursor:pointer;display:flex;align-items:center;padding:2px;${_globalMicKillActive ? 'opacity:0.4;pointer-events:none;' : ''}">
        ${micSvg}
        </button>
        <input type="range" min="0" max="100" value="${viewerAudioStates[v.id].vol}"
        oninput="setViewerVolume('${v.id}', this.value)"
        style="width:38px;accent-color:var(--accent);height:3px;" title="Viewer voice volume">
        `}
        </div>
        </div>
        <div class="rstat">${v.slot !== null ? '(Assigned)' : ''}</div>
        <button class="rlock" onclick="toggleSlotLock('${v.id}', ${!v.locked})" title="Lock slot"
        style="background:none;border:none;cursor:pointer;padding:0 4px;width:20px;height:20px;display:flex;align-items:center;">
        <img src="/assets/icons/${v.locked ? 'lock' : 'lock-open'}.svg" style="width:14px;height:14px;${v.locked ? 'filter:invert(0.8) sepia(1) saturate(5) hue-rotate(350deg);' : 'filter:invert(0.5);'}" />
        </button>
        ${v.id === 'host_0' ? '' : `<button class="rkick" onclick="kickViewer('${v.id}')" title="Kick Viewer">×</button>`}
        ${v.id === 'host_0' || typeof isArcade === 'undefined' || !isArcade ? '' : `<button class="rreport" onclick="reportViewer('${v.id}')" title="Report Viewer">!</button>`}
        `;
        c.appendChild(r);

        if (overlayC && index < 4) {
            const r2 = document.createElement('div');
            r2.className = r.className;
            r2.draggable = r.draggable;
            r2.dataset.id = r.dataset.id;
            r2.style.cssText = r.style.cssText;
            r2.innerHTML = r.innerHTML
                .replace(`id="icon-${v.id}"`, `id="overlay-icon-${v.id}"`)
                .replace(`id="mic-btn-${v.id}"`, `id="overlay-mic-btn-${v.id}"`);
            overlayC.appendChild(r2);
        }
    });
    attachDragDrop(c);
    if (overlayC) attachDragDrop(overlayC);
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
    const overlayBtn = document.getElementById('overlay-mic-btn-' + viewerId);
    if (overlayBtn) {
        overlayBtn.innerHTML = _micSvg(s.state);
        overlayBtn.title     = _micTitles[s.state];
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

function kickViewer(id) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'kick-viewer', viewerId: id }));
}

function reportViewer(id) {
    if (!confirm('Report this viewer for violating the arcade rules?')) return;
    if (ws && ws.readyState === 1) {
        const anonHash = typeof _viewerIpHashes !== 'undefined' ? _viewerIpHashes[id] : null;
        ws.send(JSON.stringify({
            type: 'report-viewer',
            viewerId: id,
            anonHash: anonHash,
            sessionId: hostSessionId,
            reason: 'arcade-violation'
        }));
        log(`Reported viewer ${id}`, 'ok');
    }
}

function toggleSlotLock(rosterId, newLockState) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'toggle-slot-lock', viewerId: rosterId, locked: newLockState }));
        log(`Slot lock for ${rosterId} set to ${newLockState ? 'LOCKED' : 'UNLOCKED'}`, 'ok');
    }
}

function togglePin() {
    if (arcadePingInterval) { log(I18N.t('Cannot change PIN during active Arcade session'), 'warn'); return; }
    pinEnabled = !pinEnabled;
    const btn = document.getElementById('pinToggle');
    if (btn) { btn.textContent = pinEnabled ? 'ON' : 'OFF'; btn.classList.toggle('on', pinEnabled); }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: pinEnabled }));
    if (_vpsWs && _vpsWs.readyState === 1) _vpsWs.send(JSON.stringify({ type: 'set-pin', enabled: pinEnabled }));
}

function regeneratePin() {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'regen-pin' }));
        log(I18N.t('Requesting new PIN...'), 'ok');
    }
}

function savePersistentPassword(val) {
    const password = (val || '').trim();
    fetch('/api/set-session-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password })
    }).then(r => r.json()).then(cfg => {
        log(password ? 'Persistent password saved! Replaces PIN.' : 'Persistent password cleared. Using random PINs.', 'ok');
    }).catch(err => {
        log('Failed to save password: ' + err.message, 'err');
    });
}

function connectWS() {
    ws = new WebSocket(proto + '://' + location.host + '/ws/host');
    ws.onopen = () => {
        log(I18N.t('Connected to server'), 'ok');

        // Single fetch for both hostName display and info — avoids two hits on connect
        fetch('/api/config').then(r => r.json()).then(cfg => {
            const hostNameEl = document.getElementById('displayHostName');
            if (hostNameEl) hostNameEl.textContent = cfg.hostName || 'Guest';
            
            const passInput = document.getElementById('persistentPasswordInput');
            if (passInput && cfg.persistentPassword) {
                passInput.value = cfg.persistentPassword;
            }
        });

            fetch('/api/info').then(r => r.json()).then(d => {
                if (d.pin) currentPin = d.pin;
                if (!window._isP2P) {
                    const pVal = document.getElementById('pinVal');
                    if (pVal) pVal.textContent = currentPin;
                }
                renderUrls(d);
                ws.send(JSON.stringify({ type: 'sync-pin', pin: currentPin, enabled: pinEnabled }));
                sendCtrlSettings();
            });
            checkTunnelOnConnect();
    };
    ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'request-keyframe') {
            forceWebCodecsKeyframe();
            const vid = msg.viewerId || msg._viewerId;
            if (vid && _lastWcConfig) {
                if (peerConnections[vid] && peerConnections[vid].wcChannel && peerConnections[vid].wcChannel.readyState === 'open') {
                    try { peerConnections[vid].wcChannel.send(_lastWcConfig); } catch (_) {}
                }
            }
            return;
        }
        if (msg.type === 'viewer-joined') {
            const isNew = !knownViewers.has(msg.viewerId);
            knownViewers.add(msg.viewerId);
            if (msg.viewerRegion) _viewerRegions[msg.viewerId] = String(msg.viewerRegion).toLowerCase().slice(0, 2);
            if (isNew) {
                log(I18N.t('Viewer') + ' ' + (msg.name || msg.viewerId) + ' joined', 'ok');
            } else {
                log(I18N.t('Viewer') + ' ' + (msg.name || msg.viewerId) + ' re-offer requested', 'ok');
            }

            // Desktop App users are auto-assigned KBM Emulated so Steam controllers work flawlessly
            if (msg.isDesktopApp && msg.name && !msg.name.startsWith('Guest') && !savedViewerModes[msg.name]) {
                setTimeout(() => changeInputMode(msg.viewerId, 'kbm_emulated', msg.name), 200);
            } else if (msg.isDesktopApp && msg.name && msg.name.startsWith('Guest')) {
                // If they didn't set a name, we can't save it to savedViewerModes, but we still apply it
                setTimeout(() => changeInputMode(msg.viewerId, 'kbm_emulated'), 200);
            }
            if (currentStream) {
                await sendOfferToViewer(msg.viewerId);
            } else {
                ws.send(JSON.stringify({ type: 'host-not-streaming', viewerId: msg.viewerId }));
            }
        }
        if (msg.type === 'viewer-left') {
            knownViewers.delete(msg.viewerId);
            delete _viewerRegions[msg.viewerId];
            if (peerConnections[msg.viewerId]) { peerConnections[msg.viewerId].close(); delete peerConnections[msg.viewerId]; }
            log(I18N.t('Viewer') + ' ' + (msg.name || msg.viewerId) + ' left');
        }
        if (msg.type === 'roster') {
            _lastRosterList = msg.viewers || [];
            renderRoster(_lastRosterList);
            // Keep viewer panel in sync
            window._rosterData = _lastRosterList;
            const panel = document.getElementById('viewerPanel');
            if (panel && !panel.classList.contains('gone') && typeof _refreshViewerPanel === 'function') _refreshViewerPanel();
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
                try { 
                    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)); 
                    // Seamless Renegotiation Hack: When swapping codecs mid-stream, 
                    // the decoder stalls waiting for the next IDR frame (which can take 5-10s).
                    // Triggering a track replacement immediately after applying the answer 
                    // flushes the Chromium encoder and resumes the stream instantly.
                    setTimeout(() => {
                        if (pc.connectionState === 'connected') {
                            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                            if (videoSender && videoSender.track) {
                                videoSender.replaceTrack(videoSender.track).catch(()=>{});
                            }
                        }
                    }, 150);
                } catch (e) { log(I18N.t('answer err:') + ' ' + e.message, 'err'); }
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

        if (msg.type === 'viewer-vr-active') {
            vrActiveViewers.add(msg._viewerId || msg.viewerId);
            if (_lastRosterList) renderRoster(_lastRosterList);
            log(`Viewer ${msg._viewerId || msg.viewerId} entered VR mode`, 'ok');
            return;
        }

        if (msg.type === 'tunnel-url') {
            // In VPS SFU mode the tunnel URL is irrelevant — the custom domain
            // is already displayed. Swallowing this message prevents the Cloudflare
            // URL from overwriting the VPS URL in the Viewer URL dock.
            if (_vpsConfig && _vpsConfig.vpsEnabled) {
                log('Tunnel suppressed — VPS mode active.', 'ok');
                return;
            }
            log(I18N.t('Tunnel ready:') + ' ' + msg.url, 'ok');
            // Set _globalTunnelUrl synchronously so _updateDiscordRPC picks it up
            // even if the async fetch below hasn't resolved yet.
            window._globalTunnelUrl = msg.url;
            fetch('/api/info').then(r => r.json()).then(async function(d) { d.tunnelUrl = msg.url; await renderUrls(d); if (typeof _updateDiscordRPC === 'function') _updateDiscordRPC(); });
            if (!_tunnelModalManual) closeTunnelModal();
        }
        if (msg.type === 'tunnel-error') {
            log(I18N.t('Tunnel failed:') + ' ' + msg.provider, 'err');
            showTunnelError('Failed to start ' + msg.provider + '.\n\nIf using a SSH tunnel (localhost.run / serveo), outbound port 22 is likely blocked by your router/ISP.\n\nTry using cloudflared instead.');
        }
        if (msg.type === 'tunnel-not-found') {
            log(I18N.t('Tunnel executable not found:') + ' ' + msg.provider, 'err');
            showTunnelError('The executable for ' + msg.provider + ' could not be found on your system.\n\nPlease install it or ensure it is in your PATH.');
        }
        if (msg.type === 'vps-broadcast') {
            if (_vpsWs && _vpsWs.readyState === 1) {
                _vpsWs.send(msg.payload);
            }
        }
        if (msg.type === 'offer' || msg.type === 'ice-host' || msg.type === 'host-voice-cmd' || msg.type === 'input-state' || msg.type === 'pin-rejected' || msg.type === 'rumble') {
            // These messages are bounced back from server.js if the target viewer is on the VPS.
            if (_vpsWs && _vpsWs.readyState === 1) {
                const target = msg._viewerId || msg.targetViewerId;
                if (target) {
                    vpsDispatch(target, msg);
                } else {
                    _vpsWs.send(JSON.stringify(msg));
                }
            }
        }
        if (msg.type === 'play-system-sound') {
            // Relative path from src/pages/host.html to assets/
            const soundFile = msg.action === 'join' ? '../../assets/joinsound.wav' : '../../assets/leavesound.wav';
            const audio = new Audio(soundFile);
            audio.volume = 0.5;
            audio.play().catch(err => console.warn('[Audio] Could not play UI sound:', err));
            return;
        }
        if (msg.type === 'chat') {
            const isMe = msg.from === 'Host';
            appendChat(msg.from, msg.msg, isMe);
        }
        if (msg.type === 'viewer-gpid') log(I18N.t('Controller:') + ' ' + msg.id, 'ok');
        if (msg.type === 'arcade-session-active') log(I18N.t('Arcade session is LIVE on Nearsec Arcade!'), 'ok');
        if (msg.type === 'arcade-session-error') log(I18N.t('Arcade error:') + ' ' + (msg.reason || 'unknown'), 'err');
        if (msg.type === 'input-error') {
            // Backend driver failure (e.g. ViGEmBus missing on Windows)
            console.error('[Input Error]', msg.message);
            log('Input Driver Error: ' + msg.message, 'err');
            if (window.showError) {
                // If it's a missing setup, show a warning. If it's a driver crash, show a critical red error.
                const severity = msg.message.toLowerCase().includes('udev') ? 'yellow' : 'red';
                window.showError('Input Driver Error: ' + msg.message, severity);
            }
        }
        if (msg.type === 'input-ready') {
            log('Input driver ready: ' + (msg.message || ''), 'ok');
        }
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

    const stunPool = [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
        'stun:stun.twilio.com:3478',
        'stun:global.stun.twilio.com:3478',
        'stun:stun.miwifi.com:3478'
    ];

    if (!_turnCredentials && _turnFetchPromise) {
        await _turnFetchPromise;
    }

    // Pick 2 random STUN servers to avoid the "Using five or more STUN/TURN servers slows down discovery" warning
    // and naturally rotate STUN/TURN across retries for users with VPNs.
    const shuffledStun = stunPool.sort(() => 0.5 - Math.random()).slice(0, 2).map(url => ({ urls: url }));
    
    const iceServers = [...shuffledStun];
    if (_turnCredentials) iceServers.push(_turnCredentials);

    const pc = new RTCPeerConnection({
        iceServers: iceServers,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        sdpSemantics: 'unified-plan',
    });

    peerConnections[viewerId] = pc;

    const pipelineVal = document.getElementById('pipelineSelect')?.value;
    const forceWc = (new URLSearchParams(window.location.search)).get('wc') === '1' || pipelineVal === 'webcodecs' || pipelineVal === 'custom_webcodecs';

    if (forceWc) {
        // ── THE MISSING UDP TUNNEL ──
        pc.wcChannel = pc.createDataChannel('webcodecs', { ordered: false, maxRetransmits: 0 });

        // When the channel opens for this viewer, send the cached decoder config
        // immediately so they don't wait for the next keyframe (which may be seconds away).
        // Then force a keyframe so they can start decoding right away.
        pc.wcChannel.onopen = () => {
            console.log(`[WebCodecs] wcChannel open for ${viewerId} — sending cached config and forcing a keyframe`);

            // 1. Send the configuration to boot the decoder
            if (_lastWcConfig && pc.wcChannel.readyState === 'open') {
                pc.wcChannel.send(_lastWcConfig);
            }

            // 2. FORCE THE ENCODER TO SEND A NEW KEYFRAME
            if (_wcEncoder && _wcEncoder.state !== 'closed') {
                _wcForceKeyframe = true;
                console.log(`[WebCodecs] Keyframe requested for late-joiner ${viewerId}`);
            }
        };
    }

    // ── UDP FAST-LANE FOR INPUT ──
    pc.inputChannel = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
    pc.inputChannel.onmessage = (e) => {
        if (ws && ws.readyState === 1) {
            if (e.data instanceof ArrayBuffer || e.data instanceof Blob) {
                const isBlob = e.data instanceof Blob;
                if (isBlob) {
                    e.data.arrayBuffer().then(ab => processBinaryInput(ab, viewerId));
                    return;
                } else {
                    processBinaryInput(e.data, viewerId);
                    return;
                }
            }

            try {
                const inner = JSON.parse(e.data);
                // Fast-lane inputs bypass the VPS router, so we must manually stamp the correct session ID
                inner.viewerId = viewerId;
                inner.viewer_id = viewerId;
                if (inner.type === 'gamepad' && !inner.pad_id) inner.pad_id = viewerId + '_0';
                ws.send(JSON.stringify(inner));
            } catch (_) {
                ws.send(e.data);
            }
        }
    };
    
    function processBinaryInput(ab, viewerId) {
        const original = new Uint8Array(ab);
        if (original[0] === 0x01) { // PKT::GAMEPAD
            const vidBytes = new TextEncoder().encode(viewerId);
            const outBuf = new Uint8Array(2 + vidBytes.length + original.length);
            outBuf[0] = 0x80; // Custom magic for Host->Server Binary Input
            outBuf[1] = vidBytes.length;
            outBuf.set(vidBytes, 2);
            outBuf.set(original, 2 + vidBytes.length);
            ws.send(outBuf);
        }
    }

    currentStream.getTracks().forEach(track => {
        if (track.kind === 'video' && forceWc) {
            console.log(`[WebRTC] Skipping video track attachment for ${viewerId} because WebCodecs is active.`);
            return;
        }

        const sender = pc.addTrack(track, currentStream);
        if (track.kind === 'video' && sender.setParameters) {
            const params = sender.getParameters();
            if (params.encodings && params.encodings.length > 0) {
                params.encodings[0].networkPriority = 'high';
            }
            sender.setParameters(params).catch(()=>{});
        }
    });

    let codec = null;
    if (!forceWc) {
        codec = preferVideoCodec(pc);
        const cb = document.getElementById('codecBadge');
        if (codec && cb) cb.textContent = codec.split('/')[1];
    }

    let connectTimeout = setTimeout(() => {
        if (pc.connectionState !== 'connected' && peerConnections[viewerId] === pc) {
            log(I18N.t('Handshake timeout for') + ' ' + viewerId + ', fast retrying...', 'warn');
            sendOfferToViewer(viewerId);
        }
    }, 12000);

    pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate) {
            const msg = { type: 'ice-host', candidate: e.candidate, _viewerId: viewerId };
            if (window.P2PManager && window.P2PManager.isPeer(viewerId)) {
                window.P2PManager.sendToPeer(viewerId, msg);
            } else {
                ws.send(JSON.stringify(msg));
            }
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

            // ── KEYFRAME HACK ──
            // Some hardware encoders (Linux Vaapi) drop or ignore PLI requests from new viewers,
            // resulting in a permanent black screen until the stream is fully restarted.
            // Replacing the sender's track with itself forces Chromium to flush the encoder pipeline
            // and emit a fresh IDR keyframe, instantly fixing the black screen for late-joiners.
            // Guard: only fire if this pc is still the active connection for this viewer.
            // Without this guard, a stale timer from a replaced pc fires on the new connection's
            // DTLS transport while it is being set up, triggering a DcSctpTransport abort cascade.
            setTimeout(() => {
                if (peerConnections[viewerId] !== pc) return;
                try {
                    const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (videoSender && videoSender.track) {
                        videoSender.replaceTrack(videoSender.track).catch(e => console.warn('[WebRTC] Keyframe force failed:', e));
                        log(I18N.t('Forced keyframe for') + ' ' + viewerId, 'ok');
                    }
                } catch (e) { }
            }, 600);
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
        const rawCodecName = codec ? codec.split('/')[1].toLowerCase() : null;
        const msg = { type: 'offer', sdp: pc.localDescription, _viewerId: viewerId, codec: rawCodecName };
        if (window.P2PManager && window.P2PManager.isPeer(viewerId)) {
            window.P2PManager.sendToPeer(viewerId, msg);
        } else {
            ws.send(JSON.stringify(msg));
        }
        log(I18N.t('Offer → viewer') + ' ' + viewerId, 'ok');
    } catch (err) {
        log(I18N.t('Fatal WebRTC Error for') + ' ' + viewerId + ': ' + err.message, 'err');
    }
}

let selectedSourceId = null;


async function showSourceSelectionModal() {
    closeAllModals();
    // CRITICAL FIX: Bypass custom modal on Linux and macOS.
    // Electron's desktopCapturer.getSources() triggers a video-only xdg-desktop-portal
    // on Wayland, which hides the "Share Audio" checkbox. On macOS, bypassing allows the native SCK picker.
    const ua = navigator.userAgent.toLowerCase();
    const isLinux = ua.includes('linux');
    const isMac = ua.includes('mac os x');

    // Only show modal if electronAPI is available AND we are not on Linux or macOS
    if (!window.electronAPI || !window.electronAPI.getWindowSources || isLinux || isMac) {
        if (isLinux || isMac) log(I18N.t('Platform detected: Delegating to native portal/picker for audio support'), 'ok');
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

            const sourceType = source.isScreen ? '🖥 Screen' : ' Window';
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
    // FREEZE FIX: Re-enable the Start button whenever the user dismisses without
    // confirming. Without this, the button stays disabled after cancellation because
    // startCapture() was never called (or is still awaiting getUserMedia).
    _elDisabled('btnStart', false);
    _elDisabled('btnSwitch', true);
    _elDisabled('btnStop', true);
    if (typeof setCapDot === 'function') setCapDot('');
}

async function confirmSource() {
    closeSourceModal();
    await startCapture();
}

let activeSourceId = null;

// Hydrate select values from localStorage once the DOM is ready.
// host.js now loads at the bottom of <body>, so readyState is almost always
// 'interactive' or 'complete' by execution time — addEventListener('DOMContentLoaded')
// would silently never fire. This pattern handles both cases.
function hydrateSelectsFromStorage() {
    const selectDefs = [
        { key: 'ns_codec',   id: 'codecSelect',    onChange: async () => { if (currentStream) await window.saveCodecUI(document.getElementById('codecSelect').value); } },
        { key: 'ns_bitrate', id: 'bitrateSelect',  onChange: () => { if (currentStream) applyBitrateToAll(); } },
        { key: 'ns_deg',     id: 'degSelect',      onChange: () => { if (currentStream) applyBitrateToAll(); } },
        { key: 'ns_res',     id: 'resSelect',      onChange: async () => { if (currentStream) await hotSwapCapture(); } },
        { key: 'ns_fps',     id: 'fpsSelect',      onChange: async () => { if (currentStream) await hotSwapCapture(); } },
    ];
    selectDefs.forEach(({ key, id, onChange }) => {
        const el = document.getElementById(id);
        if (!el) return;
        const saved = localStorage.getItem(key);
        if (saved) {
            el.value = saved;
            el.dispatchEvent(new Event('input'));
        }
        el.addEventListener('change', async (e) => {
            saveSetting(key, e.target.value, key.replace('ns_', 'quality_'));
            if (onChange) {
                try {
                    await Promise.resolve(onChange());
                } catch (err) {
                    console.error('Quality setting change error:', err);
                }
            }
        });
    });

    // Load VPS config from Electron main process on boot
    if (window.electronAPI && typeof window.electronAPI.getVpsConfig === 'function') {
        window.electronAPI.getVpsConfig().then(cfg => {
            if (cfg && cfg.vpsEnabled) {
                log('VPS SFU mode enabled — connecting to ' + cfg.vpsUrl, 'ok');
                connectVps(cfg);
            }
        }).catch(() => {});
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrateSelectsFromStorage);
} else {
    hydrateSelectsFromStorage();
}

//  THE HOT SWAP ENGINE
async function hotSwapCapture() {
    if (!currentStream) return;
    log(I18N.t('Applying new stream resolution/FPS...'), 'warn');

    // Disable buttons during swap to prevent re-entry
    _elDisabled('codecSelect', true);
    _elDisabled('bitrateSelect', true);
    _elDisabled('resSelect', true);
    _elDisabled('fpsSelect', true);
    _elDisabled('degSelect', true);

    let timeout;
    try {
        // Set a 15-second timeout to prevent indefinite hanging
        timeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Stream swap timeout - dialog might be stuck')), 15000)
        );

        // 1. Tell viewers to freeze their screen on the last frame
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'host-encoder-swap-start' }));
        }

        const _appFpsUnlock = (typeof appConfig !== 'undefined') && appConfig.fpsUnlock;
        const fpsVal = _appFpsUnlock ? Math.max(parseInt(document.getElementById('fpsSelect')?.value) || 60, 120) : (parseInt(document.getElementById('fpsSelect')?.value) || 60);
        const resVal = document.getElementById('resSelect')?.value || '1080p';

        // Strip artificial height constraints so the browser doesn't crop the screen
        let videoConstraints = { frameRate: { ideal: fpsVal } };
        
        if (window._lastSourceId && window.electronAPI && typeof window.electronAPI.setSelectedSource === 'function') {
            window.electronAPI.setSelectedSource(window._lastSourceId);
        }

        // 2. Grab the new video track (with timeout protection)
        let newScreenStream;
        if (window._lastSourceId && window.electronAPI) {
            newScreenStream = await Promise.race([
                navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: window._lastSourceId, maxFrameRate: fpsVal } }
                }),
                timeout
            ]);
        } else {
            newScreenStream = await Promise.race([
                navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: false }),
                timeout
            ]);
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
        // Handle user cancel (NotAllowedError, AbortError) vs real errors
        if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
            log(I18N.t('Stream settings change cancelled by user'), 'warn');
        } else if (err.message === 'Stream swap timeout - dialog might be stuck') {
            log(I18N.t('Stream swap operation timed out — try again'), 'err');
        } else {
            log(I18N.t('Failed to swap video track:') + ' ' + err.message, 'err');
        }
    } finally {
        // ALWAYS re-enable controls, no matter what happened
        _elDisabled('codecSelect', false);
        _elDisabled('bitrateSelect', false);
        _elDisabled('resSelect', false);
        _elDisabled('fpsSelect', false);
        _elDisabled('degSelect', false);
    }
}

async function startCapture() {
    streamActive = true;
    _updateDiscordRPC();
    // ── HANG PROTECTION: Forces hanging OS promises to reject after 20 seconds ──
    const withTimeout = (promise, ms, msg) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
    ]);

    _elDisabled('btnStart', true);
    _elDisabled('btnSwitch', true);

    // Teardown old streams BEFORE we start capturing.
    // _forceKillStream nulls each track individually — required on Windows so
    // Chromium releases the OS capture device handle before we re-acquire it.
    if (currentStream) { _forceKillStream(currentStream); stopAudioMeter(); currentStream = null; }
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};

    const isLinux = navigator.userAgent.includes('Linux') || navigator.platform.toLowerCase().includes('linux');
    const _appFpsUnlock = (typeof appConfig !== 'undefined') && appConfig.fpsUnlock;
    const fpsVal = _appFpsUnlock
    ? Math.max(parseInt(document.getElementById('fpsSelect')?.value) || 60, 120)
    : (parseInt(document.getElementById('fpsSelect')?.value) || 60);
    const resVal = document.getElementById('resSelect')?.value || '1080p';

    // Strip artificial height constraints. Requesting a resolution higher
    // than the native monitor causes the OS to crop/zoom the screen.
    // This forces pure, unscaled native hardware capture.
    let videoConstraints = { frameRate: { ideal: fpsVal } };

    try {
        let screenStream = null;
        videoConstraints.cursor = 'never';
        const displayMediaOptions = { video: videoConstraints };

        if (!isLinux && audioSettings.forceAudioEnabled) {
            displayMediaOptions.audio = true;
            displayMediaOptions.systemAudio = 'include';
        } else {
            displayMediaOptions.audio = false;
        }

        // ── 1. FFMPEG EXPERIMENTAL INTERCEPTOR ──
        // Ask the backend directly if FFmpeg is active, bypassing UI state
        /*
        let backendHasFfmpeg = false;
        try {
            const statusRes = await fetch('/api/capture/status').then(r => r.json());
            if (statusRes.active && statusRes.method === 'ffmpeg') backendHasFfmpeg = true;
        } catch (e) { }

        if (backendHasFfmpeg) {
            log('Routing capture through experimental FFmpeg pipeline...', 'warn');
            try {
                const ffmpegTrack = await startFFmpegCapture();
                screenStream = new MediaStream([ffmpegTrack]);
            } catch (e) {
                console.error('FFmpeg pipeline failed:', e);
                log('FFmpeg failed. Falling back to native Wayland portal.', 'err');
            }
        }
        */

        // ── 2. THE NATIVE WAYLAND BYPASS ──
        // Only trigger if FFmpeg was off or failed
        if (!screenStream && isLinux) {
            screenStream = await navigator.mediaDevices.getUserMedia({
                video: { mandatory: { chromeMediaSource: 'desktop', maxFrameRate: fpsVal } },
                audio: false
            });
        }
        // ── 3. WINDOWS / MAC LOGIC ──
        else if (!screenStream && selectedSourceId && window.electronAPI) {
            try {
                window._lastSourceId = selectedSourceId;

                // Chromium on Windows requires a strictly prefixed source ID.
                // IDs without a prefix default to the primary monitor (entire screen).
                // Rule: if the raw ID contains digits only → window capture → 'window:ID:0'
                //       if it starts with 'screen:' already → leave it
                //       if it starts with 'window:' already → leave it
                //       anything else with no colon → assume window, add prefix
                // Windows Audio Capture fallback bug:
                // Chromium on Windows refuses to start a new getUserMedia capture if the
                // previous MediaStreamTrack was not explicitly stopped AND nulled.
                // Furthermore, if we fall back to getDisplayMedia, the main process needs to know what we selected.
                if (window.electronAPI && typeof window.electronAPI.setSelectedSource === 'function') {
                    window.electronAPI.setSelectedSource(selectedSourceId);
                }

                if (!selectedSourceId.startsWith('window:') && !selectedSourceId.startsWith('screen:')) {
                    // Raw numeric IDs (e.g. '123456789') are window handles on Windows
                    const isNumeric = /^\d+$/.test(selectedSourceId);
                    selectedSourceId = isNumeric
                        ? `window:${selectedSourceId}:0`
                        : `screen:${selectedSourceId}:0`;
                }
                // 1. Grab the Video specifically for the selected Window/Screen
                const vidStream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: selectedSourceId, maxFrameRate: fpsVal } }
                });
                log(I18N.t('Using selected source:') + ' ' + selectedSourceId, 'ok');

                // 2. Safely grab System Audio as a completely separate stream (if enabled)
                let tempAudioTrack = null;
                if (!isLinux && audioSettings.forceAudioEnabled) {
                    try {
                        const audStream = await navigator.mediaDevices.getUserMedia({
                            audio: { mandatory: { chromeMediaSource: 'desktop' } },
                            video: false
                        });
                        tempAudioTrack = audStream.getAudioTracks()[0];
                    } catch (audErr) {
                        log(I18N.t('Could not attach system audio to window capture.') , 'warn');
                    }
                }

                // 3. Stitch them together manually
                screenStream = new MediaStream([vidStream.getVideoTracks()[0]]);
                if (tempAudioTrack) screenStream.addTrack(tempAudioTrack);

            } catch (e) {
                log(I18N.t('Source selection failed, falling back to native picker:') + ' ' + e.message, 'warn');
                selectedSourceId = null;
                screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
            }
        } else if (!screenStream) {
            // Ultimate fallback if no other method caught it
            screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
        }

        if (selectedSourceId) activeSourceId = selectedSourceId;
        selectedSourceId = null;
        if (!screenStream) {
            console.error('[Capture] Aborting: No stream was returned (likely Windows audio restriction).');
            log('Capture failed: No stream returned. Try without system audio.', 'err');
            if (typeof setCapDot === 'function') setCapDot('err');
            _elDisabled('btnStart', false);
            _elDisabled('btnSwitch', true);
            _elDisabled('btnStop', true);
            return;
        }

        const vTrack = screenStream.getVideoTracks()[0];
        if (!vTrack || vTrack.readyState === 'ended') {
            throw new DOMException("Stream ended unexpectedly", "AbortError");
        }

        const settings = vTrack.getSettings();
        const combined = new MediaStream();

        // ── PIPELINE SELECTION ────────────────────────────────────────────────
        // vTrack is ALWAYS added to combined so WebRTC viewers get a video track.
        // WebCodecs is only active when explicitly selected (wc=1 flag) OR
        // when VPS mode is active AND the pipeline select is set to webcodecs.
        // This preserves WebRTC as a functional fallback even in VPS mode.
        vTrack.contentHint = 'motion';
        combined.addTrack(vTrack);

        const urlParams = new URLSearchParams(window.location.search);
        const pipelineEl = document.getElementById('pipelineSelect');
        const pipelineVal = pipelineEl ? pipelineEl.value : 'native';
        const forceWc = urlParams.get('wc') === '1' || pipelineVal === 'webcodecs' || pipelineVal === 'custom_webcodecs';
        if (forceWc) {
            log('WebCodecs pipeline active.', 'ok');
            startWebCodecsNetworkPipeline(vTrack);
        }

        let aTrack = screenStream.getAudioTracks()[0] || null;

        if (isLinux) {
            try {
                try {
                    const unlockStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    unlockStream.getTracks().forEach(t => t.stop());
                } catch(e) { log(I18N.t('Audio permission missing, loopback labels hidden'), 'warn'); }

                const devices = await navigator.mediaDevices.enumerateDevices();
                const audioInputs = devices.filter(d => d.kind === 'audioinput');

                const loopbackDevice = audioInputs.find(d =>
                d.label.includes('NearsecVirtualCapture') ||
                d.label.includes('NearsecVirtual') ||
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
                    if (aTrack) log(I18N.t('System audio captured'), 'ok');
                } else {
                    const labels = audioInputs.map(d => d.label || 'Hidden').join(', ');
                    log(I18N.t('Virtual cable not found. Seen labels:') + ' ' + labels, 'warn');
                }
            } catch (audErr) {
                console.warn('Linux audio loopback initialization failed:', audErr);
            }
        }

        const disableFallback = true;

        if (aTrack) {
            combined.addTrack(aTrack);
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

        const cb = document.getElementById('codecBadge');
        if (cb) cb.textContent = document.getElementById('codecSelect').value;

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
        const ti = document.getElementById('trackInfo');
        if (ti) {
            ti.innerHTML =
            '<strong>' + (vTrack.label?.split('(')[0].trim() || 'Screen') + '</strong><br>' +
            settings.width + '×' + settings.height + ' @ ' + Math.round(settings.frameRate || 0) + 'fps<br>' +
            (finalAudioTracks.length > 0 ? 'Audio: active' : (disableFallback && !aTrack ? 'No audio' : 'Audio: OS fallback'));
        }

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
                const alt = document.getElementById('trackInfoAlt');
                if (alt && !alt.innerHTML.includes('<strong>')) {
                    alt.textContent = label;
                }
            }
            
            // WebRTC HW Encoding Diagnostics
            const pcList = Object.values(peerConnections);
            if (pcList.length > 0 && pcList[0]) {
                pcList[0].getStats().then(stats => {
                    let isHw = false;
                    let hwStr = '';
                    stats.forEach(report => {
                        if (report.type === 'outbound-rtp' && report.kind === 'video') {
                            if (report.encoderImplementation) {
                                const impl = report.encoderImplementation.toLowerCase();
                                isHw = !impl.includes('libvpx') && !impl.includes('openh264') && !impl.includes('fallback');
                                hwStr = report.encoderImplementation;
                            }
                        }
                    });
                    const cb = document.getElementById('codecBadge');
                    if (cb && hwStr) {
                        cb.title = `Encoder: ${hwStr} (${isHw ? 'Hardware' : 'Software'})`;
                        if (isHw) {
                            cb.style.border = '1px solid var(--ok)';
                            cb.style.color = 'var(--ok)';
                        } else {
                            cb.style.border = '';
                            cb.style.color = '';
                        }
                    }
                }).catch(()=>{});
            }
        }
        _updateRes();
        if (window._resInterval) clearInterval(window._resInterval);
        window._resInterval = setInterval(_updateRes, 2000);

        setCapDot('live');
        _startStatsHud();

        // Notify VPS viewers the stream is now active so they dismiss standby
        if (_vpsWs && _vpsAuthOk && _vpsWs.readyState === 1) {
            _vpsWs.send(JSON.stringify({ type: 'stream-active', pinRequired: pinEnabled }));
        }

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
        updatePlaygroundToolbarState(true);

    } catch (err) {
        // UNFREEZE TRIGGER: Now runs cleanly whether by user abort or by our timeout
        const sysName = isLinux ? (window.electronAPI ? "Wayland/PipeWire" : "Linux Native") : "Windows/Mac Desktop API";

        if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
            log(`Screen capture cancelled by user [${sysName}]`, 'warn');
            setCapDot('');
        } else {
            log(`Capture failed [${sysName}]: ${err.message}`, 'err');
            setCapDot('err');
        }

        _elDisabled('btnStart', false);
        _elDisabled('btnSwitch', true);
        _elDisabled('btnStop', true);
        updatePlaygroundToolbarState(false);
    }
}

// ── Windows-safe aggressive stream teardown ───────────────────────────────────
// Chromium on Windows refuses to start a new getUserMedia capture if the
// previous MediaStreamTrack was not explicitly stopped AND nulled. A simple
// forEach(t.stop()) is not sufficient — we must null each track reference
// and then null currentStream itself so the GC can release the OS handle.
function _forceKillStream(stream) {
    if (!stream) return;
    try {
        const tracks = stream.getTracks();
        for (let i = 0; i < tracks.length; i++) {
            try { tracks[i].stop(); } catch (_) {}
            tracks[i] = null;
        }
    } catch (_) {}
}

function stopCapture() {
    isArcade = false;
    if (currentStream) { _forceKillStream(currentStream); currentStream = null; }
    if (window._resInterval) { clearInterval(window._resInterval); window._resInterval = null; }
    _stopStatsHud();
    stopAudioMeter();

    // Notify VPS viewers the stream has stopped — triggers standby screen
    if (_vpsWs && _vpsAuthOk && _vpsWs.readyState === 1) {
        _vpsWs.send(JSON.stringify({ type: 'stream-idle', pinRequired: pinEnabled }));
    }

    disconnectVps();

    if (window._webcodecsReader) { window._webcodecsReader.cancel(); window._webcodecsReader = null; }
    if (_wcEncoder && _wcEncoder.state !== 'closed') { try { _wcEncoder.close(); } catch(_) {} }
    _wcEncoder = null;
    _wcForceKeyframe = false;
    const wcCanvas = document.getElementById('webcodecs-preview-canvas');
    if (wcCanvas) wcCanvas.remove();

    // Stop FFmpeg experimental pipeline if it was running
    // fetch(`/api/capture/stop`, { method: 'POST' }).catch(() => {});
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
    updatePlaygroundToolbarState(false);
    updateKbmPanicButton();
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};
    streamActive = false;
    _updateDiscordRPC();

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

async function startWebCodecsPipeline(videoTrack, dataChannel) {
    console.log("Initializing WebCodecs VideoEncoder...");

    // 1. Configure the Bare-Metal Hardware Encoder
    const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
            // This callback fires the exact millisecond the GPU finishes encoding a frame.
            // We immediately hurl the raw bytes over the network.
            const buffer = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(buffer);

            // Send chunk data & type (keyframe vs delta frame)
            const payload = JSON.stringify({
                type: chunk.type,
                timestamp: chunk.timestamp,
                data: Array.from(new Uint8Array(buffer)) // Serialize for transport
            });

            if (dataChannel.readyState === 'open') {
                dataChannel.send(payload);
            }
        },
        error: (err) => {
            console.error("WebCodecs Encoding Error:", err);
        }
    });

    // 2. Enforce ultra-low latency hardware parameters
    encoder.configure({
        codec: 'avc1.42002A', // H.264 Baseline Profile (Fastest decode)
    width: 1920,
    height: 1080,
    bitrate: 8000000,     // 8 Mbps
    framerate: 60,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime' // Throws away jitter buffers!
    });

    // 3. Rip the raw frames directly from the PipeWire video track
    const processor = new MediaStreamTrackProcessor({ track: videoTrack });
    const reader = processor.readable.getReader();

    // 4. The Encoding Loop
    async function processFrames() {
        while (true) {
            const { done, value: frame } = await reader.read();
            if (done) break;

            // Feed the raw frame to the GPU, then instantly garbage collect it
            // to prevent memory leaks.
            encoder.encode(frame);
            frame.close();
        }
    }

    // Start the loop
    processFrames();
    console.log("WebCodecs Pipeline is now pushing raw frames.");
}

async function startFFmpegCapture() {
    return new Promise(async (resolve, reject) => {
        try {
            // 1. Tell the backend to spin up the FFmpeg hardware encoder
            const capRes = await fetch('/api/capture/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'ffmpeg' })
            });
            const capData = await capRes.json();
            if (!capData.ok || !capData.port) {
                return reject(new Error('Failed to start FFmpeg capture on backend'));
            }

            // Clean up any old instances
            let oldVideo = document.getElementById('ffmpeg-hidden-video');
            if (oldVideo) oldVideo.remove();

            // 2. Create an invisible video element to decode the stream natively
            // (It MUST be attached to the DOM for captureStream to work in Electron)
            const video = document.createElement('video');
            video.id = 'ffmpeg-hidden-video';
            video.autoplay = true;
            video.muted = true;
            video.style.position = 'fixed';
            video.style.top = '-9999px';
            video.style.opacity = '0';
            document.body.appendChild(video);

            const ms = new MediaSource();
            video.src = URL.createObjectURL(ms);

            ms.addEventListener('sourceopen', async () => {
                const sourceBuffer = ms.addSourceBuffer('video/mp4; codecs="avc1.64002a"');

                // 3. Connect to our new dedicated FFmpeg HTTP stream port
                const response = await fetch(`http://127.0.0.1:${capData.port}/`);
                const reader = response.body.getReader();

                const pushChunk = async () => {
                    if (sourceBuffer.updating) {
                        setTimeout(pushChunk, 10);
                        return;
                    }
                    try {
                        const { value, done } = await reader.read();
                        if (done) return;
                        sourceBuffer.appendBuffer(value);
                    } catch (err) {
                        console.error('Stream read error', err);
                    }
                };

                sourceBuffer.addEventListener('updateend', pushChunk);
                pushChunk(); // Kick off the loop

                video.onplaying = () => {
                    log('FFmpeg Fragmented MP4 stream hooked successfully!', 'ok');
                    // Extract the raw WebRTC track!
                    resolve(video.captureStream(60).getVideoTracks()[0]);
                };
            });

            video.onerror = () => reject(new Error("Video decode error"));

        } catch (err) {
            reject(err);
        }
    });
}

// ── EXPERIMENTAL WEBCODECS NETWORK TUNNEL (HOST) ──
// Last known decoder config — cached so late-joining viewers receive it
// immediately on wcChannel.onopen rather than waiting for a keyframe that
// already fired at pipeline start (when peerConnections was still empty).
let _lastWcConfig    = null;
let _wcEncoder       = null;
let _wcForceKeyframe = false;

async function startWebCodecsNetworkPipeline(videoTrack) {
    console.log('[WebCodecs] Initializing Network Pipeline...');
    if (typeof sysChat === 'function') sysChat('WebCodecs Network Pipeline Armed');

    _lastWcConfig    = null;
    _wcForceKeyframe = false;

    // Grab the exact hardware resolution from the native capture track
    const settings = videoTrack.getSettings();
    const exactWidth = (settings.width || 1920) & ~1;
    const exactHeight = (settings.height || 1080) & ~1;

    const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
            if (metadata.decoderConfig) {
                _lastWcConfig = JSON.stringify({
                    type: 'webcodecs-config',
                    codec: metadata.decoderConfig.codec,
                    codedWidth: metadata.decoderConfig.codedWidth || exactWidth,
                    codedHeight: metadata.decoderConfig.codedHeight || exactHeight,
                    description: metadata.decoderConfig.description
                    ? Array.from(new Uint8Array(metadata.decoderConfig.description))
                    : null
                });
                broadcastToViewers(_lastWcConfig);
            }

            const payload = new Uint8Array(1 + 8 + chunk.byteLength);
            payload[0] = chunk.type === 'key' ? 1 : 0;
            new DataView(payload.buffer).setFloat64(1, chunk.timestamp, true);
            chunk.copyTo(payload.subarray(9));

            broadcastToViewers(payload.buffer);
        },
        error: (e) => console.error('[WebCodecs] Encoder Error:', e)
    });
    _wcEncoder = encoder;

    // Derive codec string from the host's UI selection so AV1/VP9/H264 are honored.
    // WebCodecs codec strings differ from WebRTC mimeTypes — map them explicitly.
    let _wcCodecSel = (document.getElementById('codecSelect')?.value || 'VP8').toUpperCase();
    
    // FIX: Linux VaapiVideoEncoder fails to emit mandatory AVCC extradata (description) for H264.
    // Windows VideoDecoder completely crashes/blacks out if description is missing.
    // Force fallback to VP9 on Linux to bypass the H264 hardware encoder bug in WebCodecs.
    if (_wcCodecSel === 'H264' && navigator.userAgent.toLowerCase().includes('linux')) {
        console.warn('[WebCodecs] Linux H264 hardware encoding is broken (missing AVCC). Forcing VP9 fallback.');
        _wcCodecSel = 'VP9';
    }

    const _wcCodecMap = { 'AV1': 'av01.0.04M.08', 'VP9': 'vp09.00.10.08', 'VP8': 'vp8', 'H264': 'avc1.42002A', 'H265': 'hvc1.1.6.L93.B0' };
    const _wcCodecStr = _wcCodecMap[_wcCodecSel] || 'vp8';
    const wcConfig = {
        codec: _wcCodecStr,
        width: exactWidth,
        height: exactHeight,
        bitrate: 8000000,
        framerate: Math.round(settings.frameRate || 60),
        hardwareAcceleration: 'no-preference',
        latencyMode: 'realtime'
    };
    encoder.configure(wcConfig);
    encoder._lastConfig = wcConfig;
    console.log(`[WebCodecs] Encoder configured with codec: ${_wcCodecStr} (from UI: ${_wcCodecSel})`);

    const processor = new MediaStreamTrackProcessor({ track: videoTrack });
    const reader = processor.readable.getReader();
    window._webcodecsReader = reader;

    async function processFrames() {
        try {
            while (true) {
                const { done, value: frame } = await reader.read();
                if (done) break;

                if (encoder.state === 'closed') {
                    frame.close();
                    continue;
                }

                // FIX: Dynamic Resolution Handling
                // Capture cards and emulators (e.g., Smash Ultimate) frequently resize frames.
                // If the encoder isn't reconfigured, it throws an error and permanently dies, causing a black screen.
                const fW = (frame.displayWidth || frame.codedWidth) & ~1;
                const fH = (frame.displayHeight || frame.codedHeight) & ~1;
                if (fW > 0 && fH > 0 && (fW !== encoder._lastConfig.width || fH !== encoder._lastConfig.height)) {
                    console.log(`[WebCodecs] Resolution changed: ${encoder._lastConfig.width}x${encoder._lastConfig.height} -> ${fW}x${fH}`);
                    encoder._lastConfig.width = fW;
                    encoder._lastConfig.height = fH;
                    try { encoder.configure(encoder._lastConfig); } catch (e) { console.error(e); }
                    _wcForceKeyframe = true;
                }

                if (encoder.encodeQueueSize > 2) {
                    frame.close();
                } else {
                    const keyFrame = _wcForceKeyframe;
                    if (keyFrame) _wcForceKeyframe = false;
                    try {
                        encoder.encode(frame, { keyFrame });
                    } catch (e) {
                        console.error('[WebCodecs] Encode frame error:', e);
                    }
                    frame.close();
                }
            }
        } catch (e) {
            console.log("[WebCodecs] Stream loop terminated.");
        }
    }
    processFrames();

    const _kfInterval = setInterval(() => {
        if (!_wcEncoder || _wcEncoder.state !== 'configured') {
            clearInterval(_kfInterval);
            return;
        }
        _wcForceKeyframe = true;
    }, 2000);
}

function broadcastToViewers(data) {
    if (typeof peerConnections === 'undefined') return;

    // If VPS mode is active and authenticated, send to VPS instead of individual DataChannels
    if (_vpsWs && _vpsAuthOk && _vpsWs.readyState === 1) {
        try { _vpsWs.send(data); } catch (e) {
            console.warn('[VPS] Send failed, falling back to P2P:', e.message);
            _broadcastP2P(data);
        }
        return;
    }

    // Tunnel fallback: Send WebCodecs stream over standard signaling WS to the local Node.js server
    // This allows video to work perfectly over TCP-only tunnels like Zrok or Ngrok where WebRTC UDP fails.
    if (ws && ws.readyState === 1) {
        try { ws.send(data); } catch (_) {}
    }

    _broadcastP2P(data);
}

function _broadcastP2P(data) {
    Object.values(peerConnections).forEach(pc => {
        const channel = pc.wcChannel;
        if (channel && channel.readyState === 'open') {
            try { channel.send(data); } catch (_) {}
        }
    });
}

// ── VPS SFU Connection ────────────────────────────────────────────────────────

/**
 * Establishes a WebSocket connection to the remote VPS/NAS SFU router.
 * Authenticates with vpsMasterKey, then pipes all WebCodecs binary chunks
 * to the server. Incoming JSON messages from the server (viewer inputs) are
 * routed to the local input dispatcher.
 * @param {{ vpsEnabled: boolean, vpsUrl: string, vpsMasterKey: string }} cfg
 */
// ── VPS URL Sanitizer ────────────────────────────────────────────────
// Rules (per spec):
//  1. Strip any http(s):// or ws(s):// prefix the user may have pasted
//  2. Force wss:// for domain names (contain a TLD) or if page is served over HTTPS
//  3. Use ws:// for raw IPs, localhost, or 127.0.0.1
//  4. Preserve any :port suffix exactly as typed
function sanitizeVpsUrl(raw) {
    if (!raw) return '';
    // Strip all known scheme prefixes
    let host = raw.trim().replace(/\/+$/, '')
        .replace(/^wss?:\/\//i, '')
        .replace(/^https?:\/\//i, '');
    // Separate host and port
    const portMatch = host.match(/:([\d]+)$/);
    const port      = portMatch ? portMatch[0] : '';       // e.g. ':9000'
    const base      = portMatch ? host.slice(0, -port.length) : host;
    // Choose scheme
    const isRawIp    = /^(\d{1,3}\.){3}\d{1,3}$/.test(base);
    const isLocal    = base === 'localhost' || base === '127.0.0.1';
    const isSecurePage = typeof location !== 'undefined' && location.protocol === 'https:';
    const scheme = (isRawIp || isLocal) && !isSecurePage ? 'ws' : 'wss';
    return `${scheme}://${base}${port}`;
}

function connectVps(cfg) {
    if (_vpsWs) {
        try { _vpsWs.close(); } catch (_) {}
        _vpsWs = null;
    }
    _vpsConfig = cfg;
    _vpsAuthOk = false;

    if (!cfg.vpsEnabled || !cfg.vpsUrl) return;

    const url = sanitizeVpsUrl(cfg.vpsUrl);
    log('VPS: Connecting to ' + url, 'ok');

    _vpsWs = new WebSocket(url);
    _vpsWs.binaryType = 'arraybuffer';

    _vpsWs.onopen = () => {
        // Tell the VPS router who we are
        _vpsWs.send(JSON.stringify({
            type: 'auth',
            role: 'host',
            key:  cfg.vpsMasterKey,
        }));
        log('VPS: Authenticating...', 'ok');
    };

    _vpsWs.onmessage = (e) => {
        if (typeof e.data === 'string') {
            let msg;
            try { msg = JSON.parse(e.data); } catch (_) { return; }

            if (msg.type === 'auth-ok') {
                _vpsAuthOk = true;
                log('VPS: Authenticated — SFU mode active', 'ok');
                _vpsWs.send(JSON.stringify({ type: 'set-pin', enabled: pinEnabled }));
                _vpsWs.send(JSON.stringify({ type: 'stream-idle', pinRequired: pinEnabled }));

                try {
                    const wsUrl  = new URL(_vpsConfig.vpsUrl);
                    const scheme = wsUrl.protocol === 'wss:' ? 'https' : 'http';
                    const origin = scheme + '://' + wsUrl.host;
                    // Read hostName from config API — displayHostName element may not be populated yet
                    loadAppConfig().then(cfg => {
                        const hostParam = encodeURIComponent(cfg.hostName || 'Host');
                        const pSelect = document.getElementById('pipelineSelect');
                        const pipeArg = (pSelect && pSelect.value === 'custom_webcodecs') ? '&wc=2' : ((pSelect && pSelect.value === 'webcodecs') ? '&wc=1' : ((pSelect && pSelect.value === 'webtransport') ? '&wt=1' : ''));
                        const viewerUrl = origin + '/?v3&host=' + hostParam + pipeArg;
                        window._globalTunnelUrl = viewerUrl;
                        if (typeof _updateDiscordRPC === 'function') _updateDiscordRPC();
                        const el = document.getElementById('urlList');
                        if (el) {
                            el.innerHTML = '';
                            const div = document.createElement('div');
                            div.className = 'url-row';
                            div.style.color = 'var(--accent)';
                            div.textContent = viewerUrl;
                            div.onclick = () => {
                                navigator.clipboard.writeText(viewerUrl).catch(() => {});
                                const tmp = div.textContent;
                                div.textContent = 'copied!';
                                setTimeout(() => { div.textContent = tmp; }, 1500);
                            };
                            const sub = document.createElement('div');
                            sub.className = 'url-label';
                            sub.textContent = 'VPS SFU — share this';
                            el.appendChild(div);
                            el.appendChild(sub);
                        }
                    }).catch(() => {});
                } catch (_) {}
                return;
            }

            if (msg.type === 'auth-fail') {
                log('VPS: Authentication failed — check master key', 'err');
                _vpsWs.close();
                return;
            }

            // Rust router uses kebab-case field names — normalise to camelCase
            // before forwarding to the local server WebSocket dispatcher.
            const viewerId = msg['viewer-id'] || msg.viewer_id || msg.viewerId;

            // viewer-joined: fired only after PIN authorization in the waiting room.
            if (msg.type === 'viewer-joined' && viewerId) {
                const pending = _pendingVpsViewers.get(viewerId) || { name: 'Viewer', region: '' };
                _pendingVpsViewers.delete(viewerId);
                if (pending.region) _viewerRegions[viewerId] = pending.region;
                log('VPS viewer authorized: ' + viewerId, 'ok');
                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        type: 'vps-viewer-join',
                        viewerId,
                        name: pending.name,
                        viewerRegion: pending.region,
                        isDesktopApp: pending.isDesktopApp,
                    }));
                }
                sendVpsViewerBootstrap(viewerId);
                return;
            }

            // viewer-left: viewer disconnected from VPS.
            if (msg.type === 'viewer-left' && viewerId) {
                log('VPS viewer disconnected: ' + viewerId, 'warn');
                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'vps-viewer-leave', viewerId }));
                }
                return;
            }

            // viewer-input: viewer sent text input (gamepad/kbm/join/pin).
            // The Rust router injects viewer_id — parse the inner payload and
            // stamp the viewerId so the local server can route it correctly.
            if (msg.type === 'viewer-input' && viewerId && msg.payload) {
                if (!_checkPps(viewerId)) return;
                let inner;
                try { inner = JSON.parse(msg.payload); } catch (_) { return; }

                if (inner.type === 'join') {
                    handleVpsJoin(viewerId, inner);
                    return;
                }
                if (inner.type === 'request-keyframe') {
                    forceWebCodecsKeyframe();
                    if (_lastWcConfig) vpsDispatch(viewerId, _lastWcConfig);
                    return;
                }

                // Unconditionally stamp the viewer ID so the server can map it to a slot and prevent stale IDs
                inner.viewerId = viewerId;
                inner.viewer_id = viewerId;
                if (inner.type === 'gamepad' && !inner.pad_id) inner.pad_id = viewerId + '_0';

                if (inner.type === 'answer' || inner.type === 'ice-viewer' || inner.type === 'viewer-mic-ready' || inner.type === 'viewer-vr-active') {
                    inner._viewerId = viewerId;
                    // Feed directly to the local host's websocket handler so it processes the WebRTC handshake
                    if (ws && typeof ws.onmessage === 'function') {
                        ws.onmessage({ data: JSON.stringify(inner) });
                    }
                    return;
                }

                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify(inner));
                }
                return;
            }
        }
    };

    _vpsWs.onclose = (e) => {
        _vpsAuthOk = false;
        log('VPS: Disconnected (code ' + e.code + '). Retrying in 5s...', 'warn');
        setTimeout(() => { if (_vpsConfig?.vpsEnabled) connectVps(_vpsConfig); }, 5000);
    };

    _vpsWs.onerror = () => {
        log('VPS: Connection error', 'err');
    };
}

/** Tear down VPS connection cleanly (called from stopCapture). */
function disconnectVps() {
    if (_vpsWs) {
        try { _vpsWs.close(1000, 'host-stopped'); } catch (_) {}
        _vpsWs = null;
    }
    _vpsAuthOk = false;
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

function showTunnelModal(isManual) {
    closeAllModals();
    resetTunnelModal();
    document.getElementById('tunnelModal').classList.remove('gone');
    if (isManual) _tunnelModalManual = true;

    loadAppConfig().then(cfg => {
        if (!cfg) return;
        const rememberBox = document.getElementById('rememberCheck');
        if (rememberBox) rememberBox.checked = !!cfg.neverAsk;

        if (cfg.tunnelProvider) {
            const radio = document.querySelector('input[name="provider"][value="' + cfg.tunnelProvider + '"]');
            if (radio) {
                radio.checked = true;
                document.querySelectorAll('.provider-card').forEach(c => {
                    c.classList.toggle('selected', c.querySelector('input').checked);
                });
            }
        }
        if (cfg.tunnelProvider === 'vps' && cfg.vpsHost) {
            const vpsInput = document.getElementById('vpsHostInput');
            if (vpsInput) vpsInput.value = cfg.vpsHost;
        }
        // Always restore VPS SFU fields — they should persist regardless of
        // which provider is currently selected, so switching away and back
        // never clears the URL and key the user already entered.
        if (window.electronAPI && typeof window.electronAPI.getVpsConfig === 'function') {
            window.electronAPI.getVpsConfig().then(vpsCfg => {
                if (!vpsCfg) return;
                const urlEl = document.getElementById('vpsUrlInput');
                const keyEl = document.getElementById('vpsKeyInput');
                if (urlEl && vpsCfg.vpsUrl)      urlEl.value = vpsCfg.vpsUrl;
                if (keyEl && vpsCfg.vpsMasterKey) keyEl.value = vpsCfg.vpsMasterKey;
            }).catch(() => {});
        }
    }).catch(() => {});

    document.querySelectorAll('.provider-card').forEach(c => {
        c.classList.toggle('selected', c.querySelector('input').checked);
    });
}

// ── SAVING THE CAPTURE METHOD (PIPELINE) ──
window.saveCodecUI = async function(val) {
    localStorage.setItem('ns_codec', val);
    const pipelineVal = document.getElementById('pipelineSelect')?.value;
    const forceWc = (new URLSearchParams(window.location.search)).get('wc') === '1' || pipelineVal === 'webcodecs' || pipelineVal === 'custom_webcodecs';
    
    if (forceWc) {
        if (currentStream && window._webcodecsReader) {
            log(I18N.t('Applying new WebCodecs encoder...'), 'warn');
            await startWebCodecsCapture(currentStream);
            log(I18N.t('Encoder restarted successfully!'), 'ok');
        }
    } else {
        if (Object.keys(peerConnections).length > 0) {
            log(I18N.t('Applying new codec to active viewers (seamless renegotiation)...'), 'warn');
            
            // Broadcast the codec change to all viewers in chat
            const selectEl = document.getElementById('codecSelect');
            if (selectEl && ws && ws.readyState === 1) {
                const codecName = selectEl.options[selectEl.selectedIndex].text;
                const chatMsg = `Host dynamically swapped the stream codec to ${codecName}.`;
                ws.send(JSON.stringify({ type: 'chat', from: 'Nearsec', msg: chatMsg }));
                if (typeof appendChat === 'function') appendChat('Nearsec', chatMsg, false);
            }

            for (const vid in peerConnections) {
                const pc = peerConnections[vid];
                if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') {
                    const codec = preferVideoCodec(pc);
                    const rawCodecName = codec ? codec.split('/')[1].toLowerCase() : null;
                    const cb = document.getElementById('codecBadge');
                    if (codec && cb) cb.textContent = codec.split('/')[1];

                    pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false })
                        .then(offer => pc.setLocalDescription(offer))
                        .then(() => {
                            const msg = { type: 'offer', sdp: pc.localDescription, _viewerId: vid, codec: rawCodecName };
                            if (window.P2PManager && window.P2PManager.isPeer(vid)) {
                                window.P2PManager.sendToPeer(vid, msg);
                            } else {
                                ws.send(JSON.stringify(msg));
                            }
                            log(I18N.t('Codec renegotiated for viewer') + ' ' + vid, 'ok');
                        })
                        .catch(err => console.error('[WebRTC] Renegotiation failed:', err));
                }
            }
        }
    }
};

function saveCaptureMethod(method) {
    const pSelect = document.getElementById('pipelineSelect');
    
    // Determine what the CURRENT active pipeline is based on URL params
    const urlParams = new URLSearchParams(window.location.search);
    let activeMethod = 'native';
    if (urlParams.get('wc') === '1') activeMethod = 'webcodecs';
    if (urlParams.get('wc') === '2') activeMethod = 'custom_webcodecs';
    else if (urlParams.get('ff') === '1' || (typeof process !== 'undefined' && process.argv?.includes('--ffmpeg'))) activeMethod = 'ffmpeg';
    
    if (window.electronAPI && window.electronAPI.saveSettings) {
        // Let the user know they need to restart
        const confirmMsg = "Capture pipeline changed to " + method.toUpperCase() + ". You must restart Nearcade for this to take effect. Close the app now?";
        if (confirm(confirmMsg)) {
            window.electronAPI.saveSettings({ captureMethod: method });
            console.log(`[Host] Capture pipeline saved as: ${method}. Closing app...`);
            window.electronAPI.closeApp();
        } else {
            // Revert the dropdown
            if (pSelect) pSelect.value = activeMethod;
            console.log(`[Host] Pipeline change cancelled. Reverted to ${activeMethod}.`);
        }
    }
}

// Ensure the UI matches the loaded URL parameter on boot
function hydratePipelineSelect() {
    const pSelect = document.getElementById('pipelineSelect');
    if (!pSelect) return;

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('wc') === '1') {
        pSelect.value = 'webcodecs';
    } else if (urlParams.get('ff') === '1' || (typeof process !== 'undefined' && process.argv?.includes('--ffmpeg'))) {
        pSelect.value = 'ffmpeg';
    } else {
        pSelect.value = 'native';
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydratePipelineSelect);
} else {
    hydratePipelineSelect();
}

function startAudioMeter(stream) {
    const fill = document.getElementById('meter');
    if (!fill) return; // Safely exit if UI doesn't have a meter
    
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    (function draw() { animFrame = requestAnimationFrame(draw); analyser.getByteFrequencyData(data); fill.style.width = Math.min(100, data.reduce((a, b) => a + b, 0) / data.length * 2) + '%'; })();
}
function stopAudioMeter() {
    if (animFrame) cancelAnimationFrame(animFrame);
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    const fill = document.getElementById('meter');
    if (fill) fill.style.width = '0%';
}



function resetTunnelModal() {
    document.getElementById('tunnelLoading').classList.add('gone');
    document.getElementById('tunnelSpinner').classList.remove('gone');
    document.getElementById('tunnelErrorText').classList.add('gone');
    document.getElementById('tunnelRetryBtn').classList.add('gone');
}
function closeTunnelModal() {
    _tunnelModalManual = false;
    document.getElementById('tunnelModal').classList.add('gone');
    setTunnelBusy(false);
    resetTunnelModal();
}
function showTunnelError(msg) {
    setTunnelBusy(false);
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
    if (_tunnelBusy) return;
    const radio = document.querySelector('input[name="provider"]:checked');
    if (!radio) return;
    const provider = radio.value;
    const remember = document.getElementById('rememberCheck').checked;
    setTunnelBusy(true);

    if (provider === 'portforward') {
        if (remember) {
            saveAppConfig({ tunnelProvider: 'portforward', neverAsk: true });
        }
        setTunnelBusy(false);
        closeTunnelModal();
        log(I18N.t('Using direct Port Forwarding. Share your Public IP URL.'), 'ok');
        return;
    }

    // ── Dedicated VPS SFU ─────────────────────────────────────────────────────
    if (provider === 'vps-sfu') {
        const vpsUrl       = (document.getElementById('vpsUrlInput')?.value  || '').trim();
        const vpsMasterKey = (document.getElementById('vpsKeyInput')?.value  || '').trim();

        if (!vpsUrl) {
            setTunnelBusy(false);
            showTunnelError('Please enter a WebSocket URL for your VPS (e.g. ws://your-vps-ip:9000)');
            return;
        }
        if (!vpsMasterKey) {
            setTunnelBusy(false);
            showTunnelError('Please enter the Master Key configured on your VPS.');
            return;
        }

        const vpsCfg = { vpsEnabled: true, vpsUrl, vpsMasterKey };

        if (window.electronAPI && typeof window.electronAPI.saveVpsConfig === 'function') {
            window.electronAPI.saveVpsConfig(vpsCfg);
        }
        if (remember) {
            saveAppConfig({ tunnelProvider: 'vps-sfu', neverAsk: true });
        }
        
        // Clear P2P UI locks
        window._isP2P = false;
        window._p2pCode = null;
        const pinRow = document.querySelector('.pin-row');
        if (pinRow) {
            pinRow.style.opacity = '1';
            pinRow.style.pointerEvents = 'auto';
            document.getElementById('pinVal').textContent = currentPin || '----';
        }

        connectVps(vpsCfg);
        setTunnelBusy(false);
        closeTunnelModal();
        log('VPS SFU enabled — connecting to ' + vpsUrl, 'ok');
        return;
    }
    // ── End VPS SFU path ──────────────────────────────────────────────────────

    // Switching away from VPS SFU to any standard tunnel provider — tear down VPS
    if (typeof disconnectVps === 'function') {
        disconnectVps();
        if (window.electronAPI && typeof window.electronAPI.saveVpsConfig === 'function') {
            window.electronAPI.saveVpsConfig({ vpsEnabled: false });
        }
    }

    // Close the modal immediately — the tunnel URL will render via WS when ready.
    // Also schedule a guaranteed close after 5s in case of slow tunnel startup.
    setTunnelBusy(false);
    closeTunnelModal();
    let _autoCloseTimer = setTimeout(() => { closeTunnelModal(); }, 5000);

    log(I18N.t('Starting') + ' ' + provider + ' tunnel' + (remember ? ' (saved)' : '') + '...', 'ok');
    
    // Clear any active P2P flags so renderUrls displays the HTTPS link again
    window._isP2P = false;
    window._p2pCode = null;
    const pinRow2 = document.querySelector('.pin-row');
    if (pinRow2) {
        pinRow2.style.opacity = '1';
        pinRow2.style.pointerEvents = 'auto';
        document.getElementById('pinVal').textContent = currentPin || '----';
    }

    fetch('/api/start-tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, remember, vpsHost: document.getElementById('vpsHostInput')?.value?.trim() })
    }).then(() => { clearTimeout(_autoCloseTimer); }).catch(() => { clearTimeout(_autoCloseTimer); showTunnelError(I18N.t('Network request failed')); });
}

function startP2POnly() {
    if (_tunnelBusy) return;
    
    if (localStorage.getItem('p2pWarned')) {
        proceedP2POnly();
        return;
    }
    closeTunnelModal();
    document.getElementById('p2pWarningModal').classList.remove('gone');
}

function proceedP2POnly() {
    localStorage.setItem('p2pWarned', 'true');

    const remember = document.getElementById('rememberCheck').checked;
    
    // Switch away from VPS SFU if it was active
    if (typeof disconnectVps === 'function') {
        disconnectVps();
        if (window.electronAPI && typeof window.electronAPI.saveVpsConfig === 'function') {
            window.electronAPI.saveVpsConfig({ vpsEnabled: false });
        }
    }

    if (remember) {
        saveAppConfig({ tunnelProvider: 'p2p', neverAsk: true });
    }

    // Generate a random 12-char room code
    const array = new Uint32Array(2);
    crypto.getRandomValues(array);
    const code = array[0].toString(36).padStart(6, '0') + '-' + array[1].toString(36).padStart(6, '0');
    
    // Set the global P2P flags for renderUrls to consume
    window._isP2P = true;
    window._p2pCode = code;

    // Force PIN off for P2P mode (the 12-char room code acts as the security)
    pinEnabled = false;
    const pinRow = document.querySelector('.pin-row');
    if (pinRow) {
        pinRow.style.opacity = '0.3';
        pinRow.style.pointerEvents = 'none';
        const pVal = document.getElementById('pinVal');
        if (pVal) pVal.textContent = 'P2P';
        const pTog = document.getElementById('pinToggle');
        if (pTog) { pTog.textContent = 'OFF'; pTog.classList.remove('on'); }
    }

    // Immediately trigger a UI refresh so the Room Code is displayed
    fetch('/api/info').then(r => r.json()).then(d => { renderUrls(d); if (typeof _updateDiscordRPC === 'function') _updateDiscordRPC(); }).catch(() => {
        // Fallback if local Express server is unreachable
        renderUrls({ lanIP: '127.0.0.1', port: '4266' });
        if (typeof _updateDiscordRPC === 'function') _updateDiscordRPC();
    });

    log(I18N.t('Starting P2P tunnel') + (remember ? ' (saved)' : '') + '...', 'ok');
    
    // Initialize Trystero
    if (window.P2PManager) {
        window.P2PManager.initHost(code, (msg) => {
            // Check PIN locally since there's no server.js
            if (msg.type === 'join') {
                if (pinEnabled && msg.pin !== currentPin) {
                    window.P2PManager.sendToPeer(msg.viewer_id || msg.viewerId, { type: 'pin-rejected' });
                    return;
                }
                // Translate join to viewer-joined for host.js
                msg.type = 'viewer-joined';
                
                // Emulate server initialization packets so the Viewer hides the PIN screen
                window.P2PManager.sendToPeer(msg.viewer_id || msg.viewerId, {
                    type: 'your-id',
                    viewerId: msg.viewer_id || msg.viewerId
                });
                window.P2PManager.sendToPeer(msg.viewer_id || msg.viewerId, {
                    type: 'host-connected',
                    hostName: 'P2P Host'
                });

                // Emulate server sending host-stream-ready if streaming
                if (currentStream) {
                    window.P2PManager.sendToPeer(msg.viewerId || msg.viewer_id, {
                        type: 'host-stream-ready',
                        needsOffer: false // Host sends offer
                    });
                }
                
                // Forward join to server.js so the P2P viewer shows up in the Host UI roster
                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        type: 'vps-viewer-join',
                        viewerId: msg.viewer_id || msg.viewerId,
                        name: msg.name,
                        viewerRegion: msg.viewerRegion,
                        isDesktopApp: msg.isDesktopApp,
                    }));
                }
            }

            if (msg.type === 'viewer-left') {
                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        type: 'vps-viewer-leave',
                        viewerId: msg.viewer_id || msg.viewerId,
                    }));
                }
            }

            // Let the existing websocket logic handle it
            if (ws && typeof ws.onmessage === 'function') {
                // Ensure _viewerId exists for existing routing logic
                if (msg.viewer_id && !msg._viewerId) msg._viewerId = msg.viewer_id;
                if (msg.viewerId && !msg._viewerId) msg._viewerId = msg.viewerId;
                // We must unconditionally map the P2P peerId into viewerId so the Host routes the offer correctly!
                // If we don't, the Host will try to send the offer to the viewer's local session ID, which Trystero doesn't know about.
                if (msg.viewer_id) {
                    msg._viewerId = msg.viewer_id;
                    msg.viewerId = msg.viewer_id;
                }
                
                ws.onmessage({ data: JSON.stringify(msg) });
            }
        });
        
        log(I18N.t('P2P tunnel ready! Waiting for viewers...'), 'ok');
    }

    closeTunnelModal();
}

document.querySelectorAll('input[name="provider"]').forEach(radio => {
    radio.addEventListener('change', () => {
        if (_tunnelBusy) return;
        document.querySelectorAll('.provider-card').forEach(c => {
            c.classList.toggle('selected', c.querySelector('input').checked);
        });
    });
});
document.querySelectorAll('.provider-card').forEach(card => {
    card.addEventListener('click', () => {
        if (_tunnelBusy) return;
        const input = card.querySelector('input');
        input.checked = true;
        input.dispatchEvent(new Event('change'));
        document.querySelectorAll('.provider-card').forEach(c =>
        c.classList.toggle('selected', c.querySelector('input').checked));
    });
});

async function checkTunnelOnConnect() {
    if (_vpsConfig && _vpsConfig.vpsEnabled) {
        const el = document.getElementById('urlList');
        if (el && !el.querySelector('.url-row')) {
            el.innerHTML = '<div style="color:var(--muted);font-size:10px;padding:4px 0;">VPS SFU mode — connecting...</div>';
        }
        return;
    }
    try {
        const info = await fetch('/api/info').then(r => r.json());
        // ALWAYS render whatever URL the server already has, regardless of neverAsk.
        // Previously this bailed when neverAsk:true, leaving the UI stuck on boot.
        if (info.tunnelUrl) {
            renderUrls(info);
            return;
        }
        // No tunnel yet — only prompt for one if the user hasn't chosen "never ask"
        const cfg = await loadAppConfig();
        if (cfg.tunnelProvider === 'p2p') {
            startP2POnly(true);
        } else if (!cfg.neverAsk) {
            showTunnelModal();
        }
    } catch { }
}

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

    const touchSelect = document.getElementById('touchLayoutSelect');
    if (touchSelect) touchSelect.value = ctrlSettings.touchLayout;

    const isNonDefault = ctrlSettings.forceXboxOne || ctrlSettings.enableDualShock || ctrlSettings.enableMotion || ctrlSettings.defaultInputMode !== 'gamepad' || ctrlSettings.touchLayout !== 'default';
    if (btn) btn.style.color = isNonDefault ? 'var(--warn)' : '';
}

function toggleCtrlSetting(key) {
    ctrlSettings[key] = !ctrlSettings[key];
    saveSetting('ns_ctrl_' + key, ctrlSettings[key], 'ctrlSetting_' + key);
    applyCtrlSettingsUI();
    sendCtrlSettings();
    log(I18N.t('ctrl-settings:') + ' ' + key + ' = ' + ctrlSettings[key], 'ok');
}


function toggleHybridInput() {
    ctrlSettings.hybridInput = !ctrlSettings.hybridInput;
    saveSetting('ns_ctrl_hybridInput', ctrlSettings.hybridInput, 'ctrlSetting_hybridInput');
    
    if (ctrlSettings.hybridInput) {
        ctrlSettings.defaultInputMode = 'kbm_emulated';
        saveSetting('ns_ctrl_defaultInputMode', 'kbm_emulated', 'ctrlSetting_defaultInputMode');
    } else {
        ctrlSettings.defaultInputMode = 'gamepad';
        saveSetting('ns_ctrl_defaultInputMode', 'gamepad', 'ctrlSetting_defaultInputMode');
    }
    
    applyCtrlSettingsUI();
    sendCtrlSettings();
    if (ws && ws.readyState === 1 && ctrlSettings.hybridInput) {
        (_lastRosterList || []).forEach(v => {
            changeInputMode(v.id, 'kbm_emulated', v.name);
        });
        log(I18N.t('Hybrid Input ON — Gamepad + KBM active for all viewers'), 'ok');
    } else if (ws && ws.readyState === 1) {
        (_lastRosterList || []).forEach(v => {
            changeInputMode(v.id, 'gamepad', v.name);
        });
        log(I18N.t('Hybrid Input OFF'), 'warn');
    }
}

function changeCtrlType(type) {
    ctrlSettings.ctrlType = type;
    saveSetting('ns_ctrl_ctrlType', type, 'ctrlSetting_ctrlType');
    applyCtrlSettingsUI();
    sendCtrlSettings();
    if (ws && ws.readyState === 1) {
        (_lastRosterList || []).forEach(v => {
            ws.send(JSON.stringify({ type: 'set-ctrl-type', viewerId: v.id.split('_')[0], ctrlType: type }));
        });
    }
    log(I18N.t('Controller type:') + ' ' + type, 'ok');
    log(I18N.t('Controller type:') + ' ' + type, 'ok');
}

function changeTouchLayout(layout) {
    ctrlSettings.touchLayout = layout;
    saveSetting('ns_ctrl_touchLayout', layout, 'ctrlSetting_touchLayout');
    applyCtrlSettingsUI();
    sendCtrlSettings(); // This updates server.js state and broadcasts to local + VPS viewers automatically
    log('Mobile touch layout set to: ' + layout, 'ok');
}

function changeDefaultInputMode(mode) {
    ctrlSettings.defaultInputMode = mode;
    saveSetting('ns_ctrl_defaultInputMode', mode, 'ctrlSetting_defaultInputMode');
    applyCtrlSettingsUI();
    sendCtrlSettings();
    log(I18N.t('Default input mode set to:') + ' ' + mode, 'ok');
}

function sendCtrlSettings() {
    let expDevices = [];
    try {
        if (typeof appConfig !== 'undefined' && appConfig.expDevices) expDevices = appConfig.expDevices;
        else expDevices = JSON.parse(localStorage.getItem('ns_exp_devices') || '[]');
    } catch(e) {}

    const payload = JSON.stringify({
        type: 'ctrl-settings',
        forceXboxOne:     ctrlSettings.forceXboxOne,
        enableDualShock:  ctrlSettings.enableDualShock,
        enableMotion:     ctrlSettings.enableMotion,
        defaultInputMode: ctrlSettings.defaultInputMode,
        hybridInput:      ctrlSettings.hybridInput,
        ctrlType:         ctrlSettings.ctrlType,
        touchLayout:      ctrlSettings.touchLayout,
        expDevices:       expDevices,
    });

    if (ws && ws.readyState === 1) {
        ws.send(payload);
    }
    
    if (typeof _vpsWs !== 'undefined' && _vpsWs && _vpsWs.readyState === 1) {
        _vpsWs.send(payload);
    }
}

function showCtrlModal() {
    // Legacy shim — opens the unified settings modal on the Input tab
    showSettingsModal('input');
}

function closeCtrlModal() {
    closeSettingsModal();
}

// ── Unified Settings Modal ─────────────────────────────────────────────────────
function showSettingsModal(tab) {
    closeAllModals();
    applyCtrlSettingsUI();
    _syncSmMicRow();
    enumerateAudioDevicesSM();
    const abSel = document.getElementById('audioBackendSelect');
    if (abSel) abSel.value = localStorage.getItem('ns_audio_backend') || 'auto';
    switchSettingsTab(tab || 'video');
    document.getElementById('settingsModal').classList.remove('gone');
}

function closeSettingsModal() {
    document.getElementById('settingsModal').classList.add('gone');
}

function switchSettingsTab(tab) {
    ['video', 'audio', 'input', 'viewers'].forEach(t => {
        const btn  = document.getElementById('stab-' + t);
        const body = document.getElementById('stabContent-' + t);
        if (btn)  btn.classList.toggle('active', t === tab);
        if (body) body.style.display = t === tab ? '' : 'none';
    });
    if (tab === 'viewers') _refreshViewerPanel();
}

// ── Stats HUD (inline in dock) ────────────────────────────────────────────────
// Timer is started automatically by startCapture() and stopped by stopCapture(),
// but ONLY if the user has enabled the Stats HUD toggle first.
let _statsHudTimer   = null;
let _statsHudEnabled = false;  // toggled by the user in Settings → Video tab

// Shim so the HTML onclick="toggleStatsHud()" still works.
function toggleStatsHud() {
    _statsHudEnabled = !_statsHudEnabled;
    const track = document.getElementById('smTrackStatsHud');
    const row   = document.getElementById('smRowStatsHud');
    if (track) track.classList.toggle('on',     _statsHudEnabled);
    if (row)   row.classList.toggle('active',   _statsHudEnabled);

    if (_statsHudEnabled && currentStream) {
        _startStatsHud();
    } else {
        _stopStatsHud();
    }
}

function _startStatsHud() {
    // Respect the user toggle — never auto-show if they haven't turned it on
    if (!_statsHudEnabled) return;
    if (_statsHudTimer) return;
    const hud = document.getElementById('statsHud');
    if (hud) hud.style.display = 'flex';
    _statsHudTimer = setInterval(_updateStatsHud, 1500);
    _updateStatsHud();
}

function _stopStatsHud() {
    if (_statsHudTimer) { clearInterval(_statsHudTimer); _statsHudTimer = null; }
    const hud = document.getElementById('statsHud');
    if (hud) hud.style.display = 'none';
    ['hudPipeline','hudCodec','hudRtt','hudBitrate'].forEach(id => _elText(id, '—'));
}

function _updateStatsHud() {
    const pipe  = document.getElementById('pipelineSelect');
    const codec = document.getElementById('codecSelect');

    _elText('hudPipeline', pipe  ? (pipe.value === 'custom_webcodecs' ? 'WC (GL)' : pipe.value === 'webcodecs' ? 'WC' : 'WebRTC') : '—');
    _elText('hudCodec',    codec ? (codec.options[codec.selectedIndex]?.text?.split(' ')[0] || '—') : '—');

    // Pull RTT and outgoing bitrate from the first active peer connection.
    // peerConnections is a plain object keyed by viewerId.
    const pcList = Object.values(peerConnections);
    if (!pcList.length) { _elText('hudRtt', '—'); _elText('hudBitrate', '—'); return; }

    pcList[0].getStats().then(stats => {
        let bestPair      = null;
        let outboundVideo = null;

        stats.forEach(r => {
            // RTT: pick the succeeded candidate-pair with lowest RTT
            if (r.type === 'candidate-pair' && r.state === 'succeeded') {
                if (!bestPair || r.currentRoundTripTime < (bestPair.currentRoundTripTime || 1)) {
                    bestPair = r;
                }
            }
            // Bitrate: WebCodecs pipeline sends video over the DataChannel named 'webcodecs'.
            // Use data-channel bytesSent for KBPS; fall back to outbound-rtp for standard WebRTC.
            if (r.type === 'data-channel' && r.label === 'webcodecs') {
                outboundVideo = r;
            }
            if (!outboundVideo && r.type === 'outbound-rtp' && r.kind === 'video') {
                outboundVideo = r;
            }
        });

        if (bestPair?.currentRoundTripTime != null) {
            _elText('hudRtt', Math.round(bestPair.currentRoundTripTime * 1000) + 'ms');
        }

        if (outboundVideo) {
            if (outboundVideo.frameWidth && outboundVideo.frameHeight) {
                _elText('hudRes', `${outboundVideo.frameWidth}x${outboundVideo.frameHeight}`);
            } else {
                _elText('hudRes', '—');
            }
            
            if (outboundVideo.framesPerSecond != null) {
                _elText('hudFps', outboundVideo.framesPerSecond.toFixed(0));
            } else {
                _elText('hudFps', '—');
            }
            
            const prev = pcList[0].__statsSnapshot;
            if (outboundVideo.totalEncodeTime != null && outboundVideo.framesEncoded != null && prev) {
                if (outboundVideo.framesEncoded > prev.frames) {
                    const encodeDelta = outboundVideo.totalEncodeTime - prev.encodeTime;
                    const framesDelta = outboundVideo.framesEncoded - prev.frames;
                    const encodeLatencyMs = (encodeDelta / framesDelta) * 1000;
                    _elText('hudEncodeLat', encodeLatencyMs.toFixed(1) + 'ms');
                }
            } else {
                _elText('hudEncodeLat', '—');
            }
            
            if (outboundVideo.bytesSent != null) {
                const now  = Date.now();
                if (prev) {
                    const dtSec   = (now - prev.ts) / 1000;
                    const byteDiff = outboundVideo.bytesSent - prev.bytes;
                    const kbps    = Math.round((byteDiff * 8) / dtSec / 1000);
                    _elText('hudBitrate', kbps > 0 ? kbps + 'k' : '—');
                }
                pcList[0].__statsSnapshot = { 
                    ts: now, 
                    bytes: outboundVideo.bytesSent, 
                    encodeTime: outboundVideo.totalEncodeTime || 0,
                    frames: outboundVideo.framesEncoded || 0
                };
            }
        }
    }).catch(() => {});
}

// ── Input Visualizer ──────────────────────────────────────────────────────────
let _inputVizVisible = false;
let _inputVizSse     = null;
let _vizPktCount     = 0;
let _vizPpsTimer     = null;

function toggleInputVisualizer() {
    _inputVizVisible = !_inputVizVisible;
    const overlay = document.getElementById('inputVizOverlay');
    const track   = document.getElementById('smTrackInputViz');
    const row     = document.getElementById('smRowInputViz');
    if (overlay) overlay.style.display = _inputVizVisible ? 'block' : 'none';
    if (track)   track.classList.toggle('on', _inputVizVisible);
    if (row)     row.classList.toggle('active', _inputVizVisible);

    if (_inputVizVisible) {
        _startInputVizSse();
    } else {
        _stopInputVizSse();
    }
}

function _startInputVizSse() {
    if (_inputVizSse) return;
    const port = new URLSearchParams(location.search).get('port') || location.port || 3000;
    _inputVizSse = new EventSource(`http://localhost:${port}/api/input-visualizer`);
    _inputVizSse.onmessage = (e) => {
        try {
            const d = JSON.parse(e.data);
            _vizPktCount++;
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            set('inputVizSource',  d.source || '');
            set('vizButtons',  '0x' + ((d.buttons || 0).toString(16).padStart(4, '0').toUpperCase()));
            set('vizTriggers', (+(d.lt||0)).toFixed(2) + ' / ' + (+(d.rt||0)).toFixed(2));
            set('vizLStick',   (+(d.lx||0)).toFixed(2) + ', ' + (+(d.ly||0)).toFixed(2));
            set('vizRStick',   (+(d.rx||0)).toFixed(2) + ', ' + (+(d.ry||0)).toFixed(2));
            set('vizSlot',     d.slotIndex !== undefined ? String(d.slotIndex) : '—');

            // Flash active class on non-zero buttons
            const bEl = document.getElementById('vizButtons');
            if (bEl) bEl.classList.toggle('active', (d.buttons || 0) !== 0);
        } catch (_) {}
    };
    _inputVizSse.onerror = () => {};

    _vizPpsTimer = setInterval(() => {
        const el = document.getElementById('vizPps');
        if (el) el.textContent = String(_vizPktCount);
        _vizPktCount = 0;
    }, 1000);
}

function _stopInputVizSse() {
    if (_inputVizSse) { _inputVizSse.close(); _inputVizSse = null; }
    if (_vizPpsTimer) { clearInterval(_vizPpsTimer); _vizPpsTimer = null; }
}

// ── Viewer Panel ──────────────────────────────────────────────────────────────
const _viewerInputRevoked = new Set();

// Viewer panel is now the "Viewers" tab inside settingsModal — no floating sidebar.
function toggleViewerPanel() {
    showSettingsModal('viewers');
}

function _refreshViewerPanel() {
    _updateDiscordRPC();
    const list = document.getElementById('viewerPanelList');
    if (!list) return;
    // Rebuild from roster data exposed by host.js
    list.innerHTML = '';
    const viewers = typeof window._rosterData !== 'undefined' ? window._rosterData : [];
    if (!viewers.length) {
        list.innerHTML = '<div style="font-size:10px;color:var(--muted2);padding:12px;text-align:center;">No viewers connected</div>';
        return;
    }
    viewers.forEach(v => {
        if (v.id === 'host_0') return;
        const revoked = _viewerInputRevoked.has(v.id);
        const card = document.createElement('div');
        card.className = 'viewer-panel-card' + (revoked ? ' revoked' : '');
        card.dataset.viewerId = v.id;
        card.innerHTML = `
            <div class="vpc-name">${v.name || v.id}</div>
            <div class="vpc-profile">${v.inputMode || 'gamepad'} · slot ${v.slot !== undefined ? v.slot : '?'}</div>
            <div class="vpc-row">
                <span style="font-size:9px;color:${revoked ? 'var(--danger)' : 'var(--green)'};">${revoked ? 'INPUT REVOKED' : 'Input Active'}</span>
                <button class="vpc-revoke-btn${revoked ? ' revoked' : ''}" onclick="toggleViewerInputPerm('${v.id}', this)">${revoked ? 'Restore' : 'Revoke'}</button>
            </div>`;
        list.appendChild(card);
    });
}

function toggleViewerInputPerm(viewerId, btn) {
    const revoked = !_viewerInputRevoked.has(viewerId);
    if (revoked) _viewerInputRevoked.add(viewerId);
    else _viewerInputRevoked.delete(viewerId);

    const port = new URLSearchParams(location.search).get('port') || location.port || 3000;
    fetch(`http://localhost:${port}/api/viewer-input-perm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewerId: viewerId.replace(/_0$/, ''), revoked })
    }).catch(() => {});

    _refreshViewerPanel();
}

// Audio backend setting (saved for the worker init path)
function saveAudioBackend(val) {
    saveSetting('ns_audio_backend', val, 'audioBackend');
    const port = new URLSearchParams(location.search).get('port') || location.port || 3000;
    fetch(`http://localhost:${port}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBackend: val })
    }).catch(() => {});
}

// Populates the sm-prefixed selects in settingsModal Audio tab by mirroring
// the canonical audioInputSelect / audioOutputSelect from appSettingsModal.
function enumerateAudioDevicesSM() {
    enumerateAudioDevices().then(() => {
        // Mirror populated options into the sm selects
        const srcOut = document.getElementById('audioOutputSelect');
        const dstOut = document.getElementById('smAudioOutputSelect');
        const srcIn  = document.getElementById('audioInputSelect');
        const dstIn  = document.getElementById('smAudioInputSelect');
        if (srcOut && dstOut) { dstOut.innerHTML = srcOut.innerHTML; dstOut.value = srcOut.value; }
        if (srcIn  && dstIn)  { dstIn.innerHTML  = srcIn.innerHTML;  dstIn.value  = srcIn.value; }
    }).catch(() => {});
}

// Keeps the smRowCaptureMic / smMicDeviceRow in sync with appSettings.captureMic
function _syncSmMicRow() {
    const smTrack  = document.getElementById('smTrackCaptureMic');
    const smRow    = document.getElementById('smRowCaptureMic');
    const smMicRow = document.getElementById('smMicDeviceRow');
    if (smTrack)  smTrack.classList.toggle('on', !!appSettings.captureMic);
    if (smRow)    smRow.classList.toggle('active', !!appSettings.captureMic);
    if (smMicRow) smMicRow.style.display = appSettings.captureMic ? 'block' : 'none';
}

let isArcade = false;
const arcadeConfig = {
    title: localStorage.getItem('ns_arcade_title') || 'Unknown Game',
    desc: localStorage.getItem('ns_arcade_desc') || '',
    thumbnail: localStorage.getItem('ns_arcade_thumb') || '',
    maxPlayers: localStorage.getItem('ns_arcade_maxPlayers') || '4',
    requirePin: localStorage.getItem('ns_arcade_requirePin') === 'true'
};

function showArcadeModal(skipRules = false) {
    closeAllModals();
    if (!skipRules && localStorage.getItem('ns_arcade_rules_accepted') !== 'true') {
        document.getElementById('arcadeRulesModal').classList.remove('gone');
        return;
    }
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
    if (typeof appConfig !== 'undefined' && appConfig.hidmaestro) {
        log(I18N.t('Arcade mode is not compatible with the HIDMaestro backend. Disable HIDMaestro in Settings to host Arcade sessions.'), 'err');
        const overlay = document.createElement('div');
        overlay.id = 'arcadeHmConflict';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `<div style="background:#121518;border:1px solid var(--warn);border-radius:12px;padding:32px;max-width:440px;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,0.8);font-family:sans-serif;">
            <h2 style="color:var(--warn);margin:0 0 12px 0;font-size:15px;">HIDMaestro Conflicts With Arcade</h2>
            <p style="color:#949ba4;font-size:13px;line-height:1.6;margin:0 0 6px 0;">
                The HIDMaestro virtual controller backend is not compatible with Arcade mode.
            </p>
            <p style="color:#949ba4;font-size:13px;line-height:1.6;margin:0 0 20px 0;">
                Disable it in <strong>Settings → HIDMaestro Virtual Controller</strong> to host Arcade sessions.
            </p>
            <button onclick="this.closest('[id=arcadeHmConflict]').remove()" style="padding:10px 28px;border-radius:6px;border:none;background:var(--accent);color:#000;font-weight:600;cursor:pointer;">OK</button>
        </div>`;
        document.body.appendChild(overlay);
        closeArcadeModal();
        return;
    }
    const provider = document.querySelector('input[name="provider"]:checked');
    if (provider && provider.value === 'p2p') {
        log(I18N.t('Arcade mode is not supported over P2P tunnels.'), 'err');
        closeArcadeModal();
        return;
    }
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
            if (typeof _vpsWs !== 'undefined' && _vpsWs && _vpsWs.readyState === 1) _vpsWs.send(JSON.stringify({ type: 'set-pin', enabled: false }));
            log(I18N.t('PIN disabled for Arcade session'), 'ok');
        }

        const getPingData = () => ({
            id: hostSessionId,
            game: arcadeConfig.title,
            thumbnail: arcadeConfig.thumbnail,
            hasPin: arcadeConfig.requirePin,
            url: info.tunnelUrl,
            version: window.NEARSEC_VERSION || '0.0.0',
            hostRegion,
            region: `${knownViewers.size + 1}/${arcadeConfig.maxPlayers} Players • ${getHostOS()}`
        });

        arcadeChannel.trigger('client-session-ping', getPingData());
        sysChat(I18N.t('Arcade Mode started:') + ' ' + arcadeConfig.title);
        document.getElementById('btnArcade').innerHTML = '<span style="color:var(--green); font-weight:bold; font-size: 10px;">ARCADE<br>LIVE</span>';

        if (arcadePingInterval) clearInterval(arcadePingInterval);
        arcadePingInterval = setInterval(() => {
            arcadeChannel.trigger('client-session-ping', getPingData());
        }, 10000);

        isArcade = true;
        _updateDiscordRPC();

    }).catch(() => log(I18N.t('Arcade: Could not read server info'), 'err'));
}

const SVG_EYE_OPEN   = '<img src="/assets/icons/eye.svg"     style="width:20px;height:20px;filter:invert(0.6);pointer-events:none;" alt="">';
const SVG_EYE_CLOSED = '<img src="/assets/icons/eye-off.svg" style="width:20px;height:20px;filter:invert(0.6);pointer-events:none;" alt="">';

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

function showAppSettings() {
    closeAllModals();
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
    if (window.electronAPI?.saveSettings) {
        if (key === 'tray') window.electronAPI.saveSettings({ tray: appSettings[key] });
        if (key === 'discordRPC') window.electronAPI.saveSettings({ discordRPC: appSettings[key] });
        if (key === 'rumble') window.electronAPI.saveSettings({ rumble: appSettings[key] });
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
    if (valDisplay) valDisplay.textContent = val + '%';
    
    const s1 = document.getElementById('globalViewerVol');
    if (s1 && s1.value != val) s1.value = val;
    const s2 = document.getElementById('globalViewerVolSlider');
    if (s2 && s2.value != val) s2.value = val;
    
    saveSetting('ns_vol_others', val, 'volumeViewers');

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

// ── HYDRATE CONFIG FROM localStorage ──────────────────────────────────────────
// localStorage is a UI-layer cache only. On boot we push all settings that live
// there into the authoritative Electron config file so they survive config deletion
// and are always in sync. hydrateSettings does a shallow merge — it never removes
// keys the renderer doesn't know about.
if (window.electronAPI?.hydrateSettings) {
    const lsMap = {
        // ctrlSettings
        ctrlSetting_forceXboxOne:  localStorage.getItem('ns_ctrl_forceXboxOne')    === 'true',
        ctrlSetting_enableDualShock: localStorage.getItem('ns_ctrl_enableDualShock') === 'true',
        ctrlSetting_enableMotion:  localStorage.getItem('ns_ctrl_enableMotion')     === 'true',
        ctrlSetting_defaultInputMode: localStorage.getItem('ns_ctrl_defaultInputMode') || 'gamepad',
        ctrlSetting_hybridInput:   localStorage.getItem('ns_ctrl_hybridInput')      === 'true',
        ctrlSetting_ctrlType:      localStorage.getItem('ns_ctrl_ctrlType')         || 'xbox360',
        // quality / capture
        captureMethod: localStorage.getItem('ns_captureMethod') || undefined,
        quality_codec:     localStorage.getItem('ns_quality_codec')    || undefined,
        quality_res:       localStorage.getItem('ns_quality_res')      || undefined,
        quality_fps:       localStorage.getItem('ns_quality_fps')      || undefined,
        quality_bitrate:   localStorage.getItem('ns_quality_bitrate')  || undefined,
        quality_deg:       localStorage.getItem('ns_quality_deg')      || undefined,
        volumeDesktop:     localStorage.getItem('ns_volume_desktop') != null ? Number(localStorage.getItem('ns_volume_desktop')) : undefined,
        volumeMic:         localStorage.getItem('ns_volume_mic')     != null ? Number(localStorage.getItem('ns_volume_mic'))     : undefined,
    };
    // Strip out undefined entries so we don't overwrite real values with null
    const hydratePatch = Object.fromEntries(Object.entries(lsMap).filter(([, v]) => v !== undefined && v !== null));
    if (Object.keys(hydratePatch).length) window.electronAPI.hydrateSettings(hydratePatch).catch(() => {});
}
// ─────────────────────────────────────────────────────────────────────────────

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
        // Do not start any local tunnel when VPS SFU is configured —
        // the VPS connection is managed by connectVps() on WS open.
        if (_vpsConfig && _vpsConfig.vpsEnabled) {
            console.log('[Headless] VPS SFU active — skipping local tunnel boot.');
        } else if (autoTunnel === 'p2p') {
            console.log('[Headless] Starting P2P tunnel via auto boot...');
            proceedP2POnly();
        } else {
            fetch('/api/start-tunnel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: autoTunnel, remember: true })
            }).catch(()=>{});
        }

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
// ── GAMEPAD CALIBRATION SAVER ──
window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'SAVE_CONTROLLER_CALIB') {
        const { hardwareId, map } = e.data;

        // Save to local storage for the browser viewer
        localStorage.setItem('nearsec_map_' + hardwareId, JSON.stringify(map));

        // If we are in Electron (Host), save it to the persistent config file
        if (window.electronAPI && window.electronAPI.saveSettings) {
            window.electronAPI.saveSettings({ [`calib_${hardwareId}`]: map });
            console.log('[Input] Saved calibration to disk for:', hardwareId);
        }
    }
});

// ── SYSTEM INFO POLL ─────────────────────────────────────────────────────────
async function fetchSysInfo() {
    try {
        const res = await fetch('/api/sysinfo');
        if (!res.ok) return;
        const data = await res.json();
        if (data.error) return;

        const cpuEl = document.getElementById('sysCpu');
        const ramEl = document.getElementById('sysRam');
        const netEl = document.getElementById('sysNet');

        if (cpuEl) cpuEl.textContent = `CPU: ${data.cpu}`;
        if (ramEl) ramEl.textContent = `RAM: ${data.ram}`;
        if (netEl) netEl.textContent = `NET: ${data.netTx} ↑ ${data.netRx} ↓`;
    } catch (e) {}
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { 
        setInterval(fetchSysInfo, 3000); 
        fetchSysInfo(); 
        setTimeout(loadExpDevices, 500);
        setTimeout(_checkClientVersion, 1000);
    });
} else {
    setInterval(fetchSysInfo, 3000);
    fetchSysInfo();
    setTimeout(loadExpDevices, 500);
    setTimeout(_checkClientVersion, 1000);
}

let _discordStartTime = null;

function _updateDiscordRPC() {
    console.log('[DEBUG] _updateDiscordRPC called. streamActive:', typeof streamActive !== 'undefined' ? streamActive : 'undef', 'isArcade:', typeof isArcade !== 'undefined' ? isArcade : 'undef');
    if (!window.electronAPI || typeof window.electronAPI.discordSetActivity !== 'function') {
        console.log('[DEBUG] window.electronAPI.discordSetActivity is missing!');
        return;
    }

    if (!_discordStartTime) {
        _discordStartTime = Date.now();
    }

    const lang = (window.I18N && I18N.targetLang) ? I18N.targetLang : 'en';
    const supportedLogos = ['de', 'es', 'fr', 'ja', 'pt'];
    const imageKey = supportedLogos.includes(lang) ? `nearcade_logo_${lang}` : 'nearcade_logo';

    if (typeof isArcade !== 'undefined' && isArcade && typeof arcadeConfig !== 'undefined' && arcadeConfig.title) {
        const payload = {
            details: `Playing ${arcadeConfig.title}`,
            state: `Arcade Mode (${arcadeConfig.requirePin ? 'Private' : 'Public'})`,
            startTimestamp: _discordStartTime,
            largeImageKey: imageKey,
            largeImageText: 'Nearcade'
        };
        
        if (hostSessionId) payload.partyId = hostSessionId;
        if (typeof knownViewers !== 'undefined') {
            payload.partySize = knownViewers.size + 1;
            payload.partyMax = parseInt(arcadeConfig.maxPlayers || 4);
        }
        const secret = window._isP2P ? window._p2pCode : window._globalTunnelUrl;
        if (secret && secret !== 'none') payload.joinSecret = secret;
        
        console.log('[DEBUG] Sending Discord Arcade Activity:', payload);
        window.electronAPI.discordSetActivity(payload);
        return;
    }

    const secret = window._isP2P ? window._p2pCode : window._globalTunnelUrl;

    if (typeof streamActive !== 'undefined' && streamActive) {
        const payload = {
            details: 'Hosting a session',
            state: `${knownViewers.size} viewer(s) connected`,
            startTimestamp: _discordStartTime,
            largeImageKey: imageKey,
            largeImageText: 'Nearcade'
        };

        if (hostSessionId) payload.partyId = hostSessionId;
        if (typeof knownViewers !== 'undefined') {
            payload.partySize = knownViewers.size + 1;
            payload.partyMax = 10;
        }
        if (secret && secret !== 'none') payload.joinSecret = secret;

        console.log('[DEBUG] Sending Discord Private Activity:', payload);
        window.electronAPI.discordSetActivity(payload);
        return;
    }

    // Tunnel/P2P ready but not yet streaming — set a basic activity so
    // Discord "Invite to Play" works before the host starts capturing.
    if (secret && secret !== 'none') {
        const payload = {
            details: 'Session ready',
            state: 'Waiting to start stream',
            startTimestamp: _discordStartTime,
            largeImageKey: imageKey,
            largeImageText: 'Nearcade'
        };
        if (hostSessionId) payload.partyId = hostSessionId;
        payload.partySize = 1;
        payload.partyMax = 10;
        payload.joinSecret = secret;

        console.log('[DEBUG] Sending Discord Ready Activity:', payload);
        window.electronAPI.discordSetActivity(payload);
        return;
    }

    console.log('[DEBUG] Clearing Discord Activity');
    _discordStartTime = null;
    window.electronAPI.discordClear();
}

// ── Experimental Devices UI ──────────────────────────────────────────────────
function saveExpDevices() {
    const list = document.getElementById('expDeviceList');
    if (!list) return;
    const devices = [];
    list.querySelectorAll('[data-exp-val]').forEach(el => {
        const toggle = el.querySelector('.ctrl-toggle-track');
        devices.push({
            val: el.dataset.expVal,
            text: el.dataset.expText,
            enabled: toggle ? toggle.classList.contains('on') : false
        });
    });
    localStorage.setItem('ns_exp_devices', JSON.stringify(devices));
    saveAppConfig({ expDevices: devices });
    
    // Update the global expDevices array so sendCtrlSettings picks it up
    expDevices = devices;
    
    // Broadcast the updated experimental devices list to connected viewers
    if (typeof sendCtrlSettings === 'function') {
        sendCtrlSettings();
    }
}

function loadExpDevices() {
    let devices = [];
    try {
        if (typeof appConfig !== 'undefined' && appConfig.expDevices) devices = appConfig.expDevices;
        else devices = JSON.parse(localStorage.getItem('ns_exp_devices') || '[]');
    } catch(e) {}
    
    if (devices.length > 0) {
        const list = document.getElementById('expDeviceList');
        if (list) list.innerHTML = '';
        devices.forEach(d => addExpDevice(d.val, d.text, d.enabled));
    }
}

function addExpDevice(inVal, inText, inEnabled = true) {
    let val, text, enabled = inEnabled;
    const sel = document.getElementById('expDeviceSelect');
    
    if (inVal && inText) {
        val = inVal;
        text = inText;
    } else {
        if (!sel) return;
        val = sel.value;
        text = sel.options[sel.selectedIndex].text;
    }

    const list = document.getElementById('expDeviceList');
    if (!list) return;
    if (list.innerText.includes('No experimental devices enabled')) {
        list.innerHTML = '';
    }

    // Check if already added
    if (list.querySelector(`[data-exp-val="${val}"]`)) return;

    // Determine status text based on device type
    const isImplemented = val === 'tablet' || val === 'guitar' || val === 'eye' || val === 'hotas';
    const statusText = isImplemented ? '<span style="color:var(--green);">Status: Active</span>' : '<span style="color:var(--muted2);">0 Users (Coming Soon)</span>';

    const el = document.createElement('div');
    el.dataset.expVal = val;
    el.dataset.expText = text;
    el.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:10px; background:rgba(0,0,0,0.3); border:1px solid var(--border); border-radius:6px;";
    
    const toggleClass = enabled ? 'ctrl-toggle-track on' : 'ctrl-toggle-track';
    
    el.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px;">
            <div class="${toggleClass}" onclick="this.classList.toggle('on'); saveExpDevices();" style="cursor:pointer;">
                <div class="ctrl-toggle-thumb"></div>
            </div>
            <div>
                <div style="font-size:11px; font-weight:600; color:var(--text);">${text}</div>
                <div style="font-size:9px;">${statusText}</div>
            </div>
        </div>
        <button onclick="this.parentElement.remove(); saveExpDevices(); if(document.getElementById('expDeviceList').children.length === 0) document.getElementById('expDeviceList').innerHTML='<div style=\\'text-align:center; color:var(--muted); font-size:11px; padding:20px;\\'>No experimental devices enabled.</div>';" class="close-modal" style="width:24px; height:24px; border:none; background:transparent;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px; height:14px;">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        </button>
    `;
    list.appendChild(el);
    saveExpDevices();
}
