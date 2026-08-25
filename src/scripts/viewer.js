// ── LATENCY TUNING CONSTANTS ─────────────────────────────────────────────────
const CONGESTION_KEYFRAME_THRESHOLD_MS = 20; // was 40

// ── BANDWIDTH / QUALITY PROFILES ─────────────────────────────────────────────
// Auto: unconstrained (let WebRTC CC do its job — best for most users)
// Low:  cap at 720p / 1.5 Mbps  (mobile data, bad Wi-Fi)
// High: cap at 4K  / 8 Mbps     (LAN / fibre, power users)
//
// Applied after setRemoteDescription so the transceiver already exists.
// Uses setParameters() on the video receiver if supported, otherwise falls
// back to SDP bandwidth annotation (b=AS). Silently no-ops if the host is
// running a strict single-encode pipeline that doesn't honour it.

const BW_PROFILES = {
    auto: { label: 'Auto', maxBitrate: null, maxHeight: null, scaleDown: 1 },
    high: { label: 'High', maxBitrate: 8_000_000, maxHeight: 2160, scaleDown: 1 },
    low: { label: 'Low', maxBitrate: 1_500_000, maxHeight: 720, scaleDown: 2 },
    lowest: { label: '480p (Data Saver)', maxBitrate: 800_000, maxHeight: 480, scaleDown: 3 },
};

let _bwProfile = localStorage.getItem('ns_bw_profile') || 'auto';

function setBandwidthProfile(key) {
    if (!BW_PROFILES[key]) return;
    _bwProfile = key;
    localStorage.setItem('ns_bw_profile', key);
    // Update select state in Settings Modal
    const sel = document.getElementById('vBwSelect');
    if (sel) sel.value = key;
    // Apply immediately if a PC exists
    if (pc) _applyBwProfile(pc);
    console.log('[BW] Profile set:', key);
}

async function _applyBwProfile(targetPc) {
    const profile = BW_PROFILES[_bwProfile];
    if (!targetPc) return;

    try {
        // 1. Try RTCRtpReceiver.setParameters() (Chrome 94+)
        const receivers = targetPc.getReceivers();
        for (const recv of receivers) {
            if (recv.track?.kind !== 'video') continue;
            const params = recv.getParameters?.();
            if (!params) continue;
            if (profile.maxBitrate) {
                // encodings on the receiver side control REMB/TMMBR feedback
                if (params.encodings?.length) {
                    params.encodings[0].maxBitrate = profile.maxBitrate;
                    if (profile.scaleDown > 1)
                        params.encodings[0].scaleResolutionDownBy = profile.scaleDown;
                }
            } else {
                // Auto: clear constraints
                if (params.encodings?.length) {
                    delete params.encodings[0].maxBitrate;
                    params.encodings[0].scaleResolutionDownBy = 1;
                }
            }
            try { await recv.setParameters(params); } catch (_) { }
        }

        // 2. Also send a hint to the host via WS so it can optionally adjust its encoder
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'viewer-bw-hint',
                profile: _bwProfile,
                maxBitrate: profile.maxBitrate,
                maxHeight: profile.maxHeight,
            }));
        }
    } catch (e) {
        console.warn('[BW] Could not apply profile:', e);
    }
}
// ──────────────────────────────────────────────────────────────────────────────

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const host = location.host;
let wsHost = location.host;  // reassigned to 127.0.0.1 on first WebSocket failure
let ws, pc, myId = sessionStorage.getItem('ns_viewer_id') || 'ns_' + Math.random().toString(36).slice(2, 10);
if (!sessionStorage.getItem('ns_viewer_id')) sessionStorage.setItem('ns_viewer_id', myId);
let _reconnectTimer = null;
let viewerRegion = '';
let smartDb = {};
window.smartDb = smartDb;

let _turnCredentials = null;
let _turnFetchPromise = (async () => {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const hostParam = urlParams.get('host') ? `?host=${urlParams.get('host')}` : '';
        const scheme = location.protocol === 'file:' ? 'http://localhost:3000' : '';
        const res = await fetch(`${scheme}/api/turn${hostParam}`);
        if (res.ok) _turnCredentials = await res.json();
    } catch (e) { console.warn('Failed to fetch TURN credentials:', e); }
})();

// ── COMMUNITY TURN LADDER (reliable → fallback → additional fallbacks) ──
// Fetched once, filtered to entries that respond on their real TURN port, and
// used only as the *additional* fallback tier (after server + custom TURN) so a
// dead public relay can never again gate the whole ICE handshake.
let _communityTurnLadder = [];
let _communityTurnFetchPromise = null;
const busyTurnUrls = new Set();
async function _loadCommunityTurnLadder() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const hostParam = urlParams.get('host') ? `?host=${urlParams.get('host')}` : '';
        const scheme = location.protocol === 'file:' ? 'http://localhost:3000' : '';
        const res = await fetch(`${scheme}/api/community-turn-servers${hostParam}`);
        if (!res.ok) { _communityTurnLadder = []; return; }
        const servers = await res.json();
        const results = [];
        // Live-ping each registry entry (short timeout) so we only ladder in
        // relays that are actually reachable right now.
        await Promise.all((Array.isArray(servers) ? servers : []).map(async (s) => {
            if (!s || !s.url || busyTurnUrls.has(s.url)) return;
            busyTurnUrls.add(s.url);
            try {
                let alive = false;
                try {
                    const pc = new RTCPeerConnection({
                        iceServers: [{ urls: [s.url], username: s.username || '', credential: s.credential || '' }],
                        bundlePolicy: 'max-bundle'
                    });
                    pc.createDataChannel('ladder-ping');
                    alive = await new Promise((resolve) => {
                        let done = false;
                        const finish = (ok) => { if (!done) { done = true; try { pc.close(); } catch (_) {} resolve(ok); } };
                        pc.onicecandidate = (ev) => {
                            if (ev.candidate) {
                                if (ev.candidate.type === 'relay' || ev.candidate.candidate.includes('typ relay')) finish(true);
                            } else {
                                finish(false);
                            }
                        };
                        pc.oniceconnectionstatechange = () => {
                            if (pc.iceConnectionState === 'failed') finish(false);
                        };
                        setTimeout(() => finish(false), 3000);
                        try { pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => finish(false)); } catch (_) { finish(false); }
                    });
                } catch (_) { alive = false; }
                if (alive) results.push(s);
            } finally {
                busyTurnUrls.delete(s.url);
            }
        }));
        _communityTurnLadder = results;
        if (results.length) console.log('[WebRTC] Community TURN ladder:', results.map(r => r.name || r.url).join(', '));
    } catch (e) {
        console.warn('[WebRTC] Failed to load community TURN ladder:', e);
        _communityTurnLadder = [];
    }
}
_communityTurnFetchPromise = _loadCommunityTurnLadder();

// ── EARLY PIN / CONNECT STATE (must be declared before async standby handler) ──
let pinRequired = true;
let _autoJoinedVps = false;

// ── EARLY STANDBY CONNECTION ────────────────────────────────────────────────
// Always attempt to connect to the VPS standby lane. If we are on a standard
// peer-to-peer local server, this route doesn't exist and will silently fail (404),
// which is perfectly fine. If we are on the VPS, it connects and instantly checks state.
const urlParamsGlobal = new URLSearchParams(window.location.search);
const isP2PGlobal = (urlParamsGlobal.get('host') || '').startsWith('p2p://');
// Only connect to the VPS standby lane if this is not a P2P session. P2P sessions are
// completely disjoint from the VPS and must not inherit its PIN or stream-state rules.
const standbyWs = !isP2PGlobal ? new WebSocket(`${proto}://${host}/vps?standby=true`) : { onmessage: null, onerror: null };

// Hide host-specific UI elements when loading the viewer client
if (document.getElementById('quickHostBtn')) document.getElementById('quickHostBtn').style.display = 'none';
if (document.getElementById('disconnectBtn')) document.getElementById('disconnectBtn').style.display = 'none';

// ?preview=1 opens standalone lobby preview window
if (urlParamsGlobal.has('preview')) {
    import('./lobby.js').then(m => {
        const w = window.open('', 'lobbyPreview', 'width=960,height=540,left=100,top=100,resizable=yes');
        if (w) {
            w.document.title = 'Nearcade Lobby Preview';
            w.document.body.style.margin = '0'; w.document.body.style.background = '#000';
            w.document.body.style.overflow = 'hidden';
            const c = w.document.createElement('canvas');
            c.width = 960; c.height = 540; c.style.cssText = 'width:100%;height:100%;display:block;';
            w.document.body.appendChild(c);
            m.runDesktopPreview(c);
        }
    });
}
standbyWs.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.pinRequired !== undefined) {
        pinRequired = msg.pinRequired;
        const pw = document.getElementById('pinWrap');
        if (pw) pw.style.display = pinRequired ? 'flex' : 'none';
        // If host has disabled PIN, skip the screen entirely and auto-join
        if (!pinRequired && !_autoJoinedVps && !ws) {
            _autoJoinedVps = true;
            document.getElementById('pinScreen')?.classList.add('gone');
            submitPin();
        }
    }
    
    if (msg.type === 'stream-idle') {
        const pinScreen = document.getElementById('pinScreen');
        if (pinScreen && !pinScreen.classList.contains('gone')) return;
        showOverlay(true);
        setStatus('Host is not sharing their screen yet...');
        const sp = document.getElementById('spinner'); if (sp) sp.style.display = 'none';
        
        const sf = document.getElementById('_nsStandbyFrame');
        if (sf) sf.style.display = 'none';
    } else if (msg.type === 'stream-active') {
        const sf = document.getElementById('_nsStandbyFrame');
        if (sf) sf.style.display = 'none';
    }
};
standbyWs.onerror = () => { };

async function safeApiJson(url, fallback) {
    try {
        const r = await fetch(url);
        if (!r.ok) return fallback;
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('application/json')) return fallback;
        return await r.json();
    } catch (_) {
        return fallback;
    }
}
function requestKeyframeFromHost() {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'request-keyframe', viewerId: typeof myId !== 'undefined' ? myId : null }));
}

window.forceReloadStream = function() {
    if (!ws || ws.readyState !== 1) return;
    if (window.wcDecoder) {
        // In VPS SFU / WebCodecs mode, request a fresh IDR keyframe
        window.nsWaitKey = true;
        requestKeyframeFromHost();
        console.log('[Viewer] Forced WebCodecs keyframe request.');
    } else {
        // In WebRTC mode, trigger a full SDP renegotiation
        ws.send(JSON.stringify({ type: 'request-offer' }));
        console.log('[Viewer] Forced WebRTC offer request.');
    }
};

function recoverWebCodecsDecoder() {
    window.nsWaitKey = true;
    requestKeyframeFromHost();
    try { if (wcDecoder?.state !== 'closed') wcDecoder.close(); } catch (_) { }
    wcDecoder = null;
}
let sysAudioCtx = null;
let nextAudioTime = 0;
// Note: stopReconnect and vpsConnected are declared below near connect()
let useVps = false;
let myName = urlParamsGlobal.get('name') || localStorage.getItem('ns_name') || '';
document.getElementById("nameInput").value = myName || "Guest" + Math.floor(Math.random() * 9000 + 1000);
if (urlParamsGlobal.get("name")) localStorage.setItem("ns_name", myName);
// ── PRE-JOIN HOST INFO ──
(function fetchHostInfo() {
  const hostUrl = urlParamsGlobal.get('host');
  if (hostUrl) {
    safeApiJson(hostUrl + '/api/info', null).then(info => {
      if (!info) return;
      const bar = document.getElementById('hostInfoBar');
      const nameEl = document.getElementById('hostInfoName');
      const gameEl = document.getElementById('hostInfoGame');
      const metaEl = document.getElementById('hostInfoMeta');
      if (!bar || !nameEl) return;
      if (info.hostName) nameEl.textContent = info.hostName;
      if (info.game && !info.game.match(/^(Unknown Game|Arcade Game|Game)$/i)) gameEl.textContent = '🎮 ' + info.game;
      const parts = [];
      if (info.hostRegion) parts.push('📍 ' + info.hostRegion.toUpperCase());
      if (info.viewerCount !== undefined) parts.push('👥 ' + info.viewerCount);
      if (info.codec) parts.push('🎬 ' + info.codec);
      if (parts.length) metaEl.textContent = parts.join(' · ');
      bar.style.display = 'block';
    });
  }
})();
let enteredPin = '', enteredPassword = '', audioMuted = false;
let kbEnabled = false;

// ── VOICE CHAT STATE ──────────────────────────────────────────────────────────
let localMicStream = null;
let micSender = null;
let micEnabled = false;
let forceMutedByHost = false;

// Voice Activity Detection
let vadAudioCtx = null;
let vadAnalyser = null;
let vadSource = null;
let vadRafId = null;
const VAD_THRESHOLD = 18;   // RMS energy level (0-255)
const VAD_HOLD_MS = 800;  // ms to hold "talking" indicator after silence
let vadTalkingTimer = null;
let vadIsTalking = false;
// ─────────────────────────────────────────────────────────────────────────────
// ── WebCodecs Globals ──
// USE_WEBCODECS: true when launched with --webcodecs flag (?wc=1 or ?wc=2 in URL).
// In this mode the DataChannel pipeline is the primary renderer; the WebRTC
// video track is still received (for timing / signalling parity) but is
// immediately muted and never shown.
const _wcFlag = new URLSearchParams(location.search).get('wc');
const USE_WEBCODECS = _wcFlag === '1' || _wcFlag === '2';
const CUSTOM_WEBCODECS = _wcFlag === '2';

let wcDecoder = null;
// Pre-wire to the canvas already in index.html so initWebCodecsViewer never
// creates a duplicate element.
let wcCanvas = document.getElementById('webcodecs-canvas') || null;
let wcCtx = null;
let wcGlTexture = null;

// Upscale mode for the WebGL stream surface.
//  0 standard · 1 crisp · 2 pixel-perfect (NEAREST) · 3 ultra
let _upscaleMode = -1; // -1 = auto
let _lastAppliedUpscale = null;

let upscalerCanvas = null;
let upscalerCtx = null;
let _webglSupported = true; // Assume true until wcCtx creation fails

function _showWebGLWarning() {
    let warn = document.getElementById('webglWarnBanner');
    if (!warn) {
        warn = document.createElement('div');
        warn.id = 'webglWarnBanner';
        warn.innerHTML = '<div style="flex:1;"><b>WebGL Not Supported:</b> Hardware-accelerated upscaling is unavailable on your device. Stream will fall back to standard video.</div><button onclick="this.parentElement.style.display=\'none\'" style="background:none;border:none;color:#5c4000;font-size:20px;cursor:pointer;line-height:1;padding:0 8px;">&times;</button>';
        warn.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#ffcc00;color:#5c4000;padding:12px 16px;border-radius:8px;font-size:13px;font-weight:500;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.4);display:flex;align-items:center;gap:16px;max-width:90%;font-family:sans-serif;border:1px solid #d9aa00;';
        document.body.appendChild(warn);
    }
    warn.style.display = 'flex';
}

function _ensureUpscaleCanvas() {
    if (!upscalerCanvas) {
        upscalerCanvas = document.createElement('canvas');
        upscalerCanvas.id = 'upscale-canvas';
        upscalerCanvas.style.cssText = 'width: 100%; height: 100%; max-width: 100vw; max-height: 100vh; object-fit: contain; position: absolute; top: 0; left: 0; z-index: 11; display: block; overflow: hidden; pointer-events: none;';
        document.getElementById('video-container')?.appendChild(upscalerCanvas) ?? document.body.appendChild(upscalerCanvas);
        
        upscalerCtx = upscalerCanvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
        if (!upscalerCtx) upscalerCtx = upscalerCanvas.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
        
        if (upscalerCtx && window.NearcadeUpscaler) {
            window.upscalerInstance = new window.NearcadeUpscaler(upscalerCtx);
        }
    }
}

function _updateUpscaleCanvasSize(sourceW, sourceH) {
    if (!upscalerCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    let targetW = window.innerWidth;
    let targetH = window.innerHeight;
    const aspect = sourceW / sourceH;
    const screenAspect = targetW / targetH;
    if (screenAspect > aspect) { targetW = targetH * aspect; } else { targetH = targetW / aspect; }
    
    const w = Math.max(sourceW, Math.floor(targetW * dpr));
    const h = Math.max(sourceH, Math.floor(targetH * dpr));
    if (upscalerCanvas.width !== w || upscalerCanvas.height !== h) {
        upscalerCanvas.width = w;
        upscalerCanvas.height = h;
        if (upscalerCtx) upscalerCtx.viewport(0, 0, w, h);
    }
}

function _applyUpscaleFilter() {
    let mode = _upscaleMode;
    if (mode === -1 && wcCanvas) {
        const w = wcCanvas.width && wcCanvas.height ? wcCanvas.width : (document.getElementById('video') && document.getElementById('video').videoWidth || 0);
        mode = w > 0 && w < 1280 ? 1 : 0;
    }
    _lastAppliedUpscale = mode;
    
    if (mode > 0 && _webglSupported) {
        _ensureUpscaleCanvas();
        if (window.upscalerInstance) {
            window.upscalerInstance.setMode(mode);
        }
    } else {
        if (upscalerCanvas) upscalerCanvas.style.display = 'none';
        const videoEl = document.getElementById('video');
        if (videoEl) videoEl.style.opacity = '1';
        if (typeof wcCanvas !== 'undefined' && wcCanvas) wcCanvas.style.opacity = '1';
    }

    if (wcCtx && wcGlTexture) {
        const nearest = mode === 2;
        try {
            wcCtx.bindTexture(wcCtx.TEXTURE_2D, wcGlTexture);
            wcCtx.texParameteri(wcCtx.TEXTURE_2D, wcCtx.TEXTURE_MAG_FILTER, nearest ? wcCtx.NEAREST : wcCtx.LINEAR);
            wcCtx.texParameteri(wcCtx.TEXTURE_2D, wcCtx.TEXTURE_MIN_FILTER, nearest ? wcCtx.NEAREST : wcCtx.LINEAR);
        } catch (e) {}
    }
    const sel = document.getElementById('vUpscaleSelect');
    if (sel && sel.value != mode) sel.value = mode;
    document.body.classList.toggle('pixel-mode', mode === 2);
}

window.setUpscaleMode = function(v) {
    v = parseInt(v, 10);
    if (!isNaN(v)) { _upscaleMode = v; }
    
    if (_upscaleMode > 0 && !_webglSupported) {
        _showWebGLWarning();
    }
    
    window.pixelFilterEnabled = (_upscaleMode === 2);
    const mark = document.getElementById('pixelFilterMark');
    if (mark) mark.classList.toggle('on', _upscaleMode === 2);
    const toggle = document.getElementById('partyPixel');
    if (toggle) toggle.classList.toggle('on', window.pixelFilterEnabled);
    _applyUpscaleFilter();
    try { localStorage.setItem('ns_upscale_mode', String(_upscaleMode)); } catch (e) {}
};

function _setupWebGL(gl) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, 'attribute vec2 p; attribute vec2 t; varying vec2 v; void main(){gl_Position=vec4(p,0,1);v=t;}');
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, 'precision mediump float; uniform sampler2D s; varying vec2 v; void main(){gl_FragColor=texture2D(s,v);}');
    gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,0,1, 1,-1,1,1, -1,1,0,0, 1,1,1,0]), gl.STATIC_DRAW);
    const pLoc = gl.getAttribLocation(prog, 'p'), tLoc = gl.getAttribLocation(prog, 't');
    gl.enableVertexAttribArray(pLoc); gl.enableVertexAttribArray(tLoc);
    gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(tLoc, 2, gl.FLOAT, false, 16, 8);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
}
const CONTROLLER_GUIDE_STORAGE_KEY = 'ns_controller_guide_ack';
const CLIENT_VERSION = window.CLIENT_VERSION || window.NEARCADE_VERSION || '3.0.6';
function semverGte(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return true;
}

// Tracks whether an active host stream session exists in this browser tab.
// Used to gate the standby screen so it only appears on the pin screen
// when no host has connected yet.
let _nsHostConnected = false;


document.addEventListener('click', unlockAudio, { once: true, passive: true });
document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });

// Human-interaction flag for the server's auth heuristics check. Set on any
// real pointer/key/touch so the auth-response can prove the page is being
// used by an actual person rather than a headless bot.
['pointerdown', 'keydown', 'touchstart'].forEach(evt =>
    window.addEventListener(evt, () => { window.__nsHumanInteraction = true; }, { once: true, passive: true })
);

function unlockAudio() {
    if (!sysAudioCtx) sysAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (sysAudioCtx.state === 'suspended') sysAudioCtx.resume();
    console.log('[Audio] Engine Unlocked by user gesture');
}

function openControllerGuide() { document.getElementById('controllerGuideModal').classList.remove('hidden'); }
function closeControllerGuide() { document.getElementById('controllerGuideModal').classList.add('hidden'); }
function acknowledgeControllerGuide() {
    closeControllerGuide();
}
function maybeShowControllerGuide() {
    if (!_nsHostConnected) return;
    if (sessionStorage.getItem(CONTROLLER_GUIDE_STORAGE_KEY)) return;
    if (knownNativePads.length > 0) return; // Native controllers are auto-mapped and bypass browser Gamepad API

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let needsCalib = false;

    for (const gp of pads) {
        if (!gp) continue;
        if (lookupCalibMap(gp)) continue; // We already have a map

        const idLower = gp.id.toLowerCase();
        // Standard brands that are natively mapped by the browser/smartDb don't need calibration
        if (idLower.includes('xbox') || idLower.includes('playstation') || 
            idLower.includes('dualshock') || idLower.includes('dualsense') || idLower.includes('x-box')) {
            continue;
        }

        needsCalib = true;
        break;
    }

    if (needsCalib) {
        sessionStorage.setItem(CONTROLLER_GUIDE_STORAGE_KEY, '1');
        setTimeout(() => openControllerGuide(), 700);
    }
}
// ── PEER CONNECTION ───────────────────────────────────────────────────────────
async function createPC() {
    if (pc) { try { pc.close(); } catch (e) { } }
    console.log('[WebRTC] Initializing new PeerConnection...');

    if (!_turnCredentials && _turnFetchPromise) {
        await _turnFetchPromise;
    }

    // ── ICE SERVER LADDER ───────────────────────────────────────────────────
    // Ordered tiers: reliable → fallback → additional fallbacks. WebRTC gathers
    // from every entry in parallel, so a healthy list shortens recursion by
    // giving ICE multiple live paths immediately. Dead entries no longer gate
    // the whole connection (they used to burn the full ~10s ICE timeout).
    const iceServers = [];

    // TIER 1 — reliable: the user's explicit custom STUN (if any) goes first,
    // otherwise the canonical Google resolver.
    const customStun = localStorage.getItem('ns_custom_stun');
    if (customStun) {
        console.log('[WebRTC] Using Custom Community STUN (reliable tier):', customStun);
        iceServers.push({ urls: customStun });
    }
    iceServers.push({ urls: 'stun:stun.l.google.com:19302' });

    // TIER 2 — fallback: Google's alternate resolvers (no single point of choice).
    iceServers.push({ urls: 'stun:stun1.l.google.com:19302' });
    iceServers.push({ urls: 'stun:stun2.l.google.com:19302' });
    iceServers.push({ urls: 'stun:stun3.l.google.com:19302' });
    iceServers.push({ urls: 'stun:stun4.l.google.com:19302' });

    // TIER 3 — additional fallback STUNs (kept to trusted infrastructure only).
    iceServers.push({ urls: 'stun:stun.cloudflare.com:3478' });

    // ── TURN LADDER ──────────────────────────────────────────────────────────
    // Reliable TURN: server-configured credentials (host-provided /api/turn).
    if (_turnCredentials) {
        if (Array.isArray(_turnCredentials)) {
            iceServers.push(..._turnCredentials);
        } else {
            iceServers.push(_turnCredentials);
        }
    }

    // Fallback TURN: the user's explicit community pick (dashboard selection).
    const customTurnUrl = localStorage.getItem('ns_custom_turn_url');
    if (customTurnUrl) {
        console.log('[WebRTC] Using Custom Community TURN (fallback tier):', customTurnUrl);
        iceServers.push({
            urls: customTurnUrl,
            username: localStorage.getItem('ns_custom_turn_username') || '',
            credential: localStorage.getItem('ns_custom_turn_credential') || ''
        });
    }

    // Additional TURN fallbacks: live-pinged community registry entries that
    // are reachable right now. Kept strictly after the verified entries.
    if (_communityTurnLadder && _communityTurnLadder.length) {
        for (const entry of _communityTurnLadder) {
            if (entry && entry.url) {
                if (busyTurnUrls.has(entry.url)) continue;
                busyTurnUrls.add(entry.url);
                iceServers.push({ urls: entry.url, username: entry.username || '', credential: entry.credential || '' });
            }
        }
    }

    pc = new RTCPeerConnection({
        iceServers: iceServers,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        sdpSemantics: 'unified-plan'
    });

    let _iceFailCount = 0;
    pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] Connection State: ${pc.connectionState}`);
        if (pc.connectionState === 'failed') {
            _iceFailCount++;
            const delay = _iceFailCount === 1 ? 500 : _iceFailCount === 2 ? 1500 : 3000;
            console.warn(`[WebRTC] Connection failed (attempt ${_iceFailCount}) — retrying in ${delay}ms...`);
            setStatus('Connection failed. Retrying...');
            clearTimeout(_reconnectTimer);
            _reconnectTimer = setTimeout(() => {
                if (ws?.readyState === 1 && (!pc || pc.connectionState !== 'connected')) {
                    ws.send(JSON.stringify({ type: 'request-offer' }));
                }
            }, delay);
        }
        if (pc.connectionState === 'connected') {
            _iceFailCount = 0;
        }
        if (pc.connectionState === 'disconnected') console.warn('[WebRTC] Disconnected.');
    };
    pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC] ICE State: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
            console.warn('[WebRTC] ICE failed. Requesting fresh offer to recover...');
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'request-offer' }));
        }
    };
    pc.onsignalingstatechange = () => console.log(`[WebRTC] Signaling State: ${pc.signalingState}`);
    pc.onicecandidateerror = (e) => console.error('[WebRTC] ICE Error:', e);

    pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ice-viewer', candidate: e.candidate, viewerId: myId }));
        }
    };

    pc.ontrack = (e) => {
        console.log(`[WebRTC] Received Track: ${e.track.kind}`);
        if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0;
        if (e.track.kind === 'video') {
            if (USE_WEBCODECS) {
                // WebCodecs mode: DataChannel is the real renderer.
                // Attach the track to a silent video element just to keep
                // the WebRTC engine happy (RTCP feedback, etc.) — never shown.
                const sink = document.getElementById('video');
                if (sink) {
                    sink.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
                    sink.style.display = 'none';
                }
                // Show the WebCodecs canvas layer; decoder will be configured
                // when the host sends the 'webcodecs-config' DataChannel message.
                if (wcCanvas) {
                    wcCanvas.style.display = 'block';
                }
                console.log('[WebCodecs] Video track suppressed — DataChannel renderer active');
                return;
            }
            // Normal WebRTC mode: attach to the primary #video element.
            const videoEl = document.getElementById('video');
            if (videoEl) {
                videoEl.muted = true; // Required by Chrome/Safari to allow dynamic autoplay
                videoEl.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
                videoEl.play().catch(err => console.warn('[WebRTC] video.play() exception:', err));
                let vfcLoop = () => {
                    let handledByUpscaler = false;
                    if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
                        // GPU path (WebGPU) — highest priority
                        if (_gpuUpscalerInstance && window._gpuCanvas) {
                            const gpuC = window._gpuCanvas;
                            if (gpuC.width !== videoEl.videoWidth || gpuC.height !== videoEl.videoHeight) {
                                _updateUpscaleCanvasSize(videoEl.videoWidth, videoEl.videoHeight);
                                gpuC.width  = upscalerCanvas ? upscalerCanvas.width  : videoEl.videoWidth;
                                gpuC.height = upscalerCanvas ? upscalerCanvas.height : videoEl.videoHeight;
                            }
                            gpuC.style.display = 'block';
                            videoEl.style.opacity = '0.01';
                            _gpuUpscalerInstance.setMode(_upscaleMode > 0 ? _upscaleMode : 1);
                            handledByUpscaler = _gpuUpscalerInstance.uploadAndDraw(videoEl) !== false;
                        }
                        // WebGL fallback path
                        if (!handledByUpscaler && typeof _upscaleMode !== 'undefined' && _upscaleMode > 0 && typeof _webglSupported !== 'undefined' && _webglSupported && window.upscalerInstance && typeof upscalerCanvas !== 'undefined' && upscalerCanvas) {
                            if (typeof _updateUpscaleCanvasSize === 'function') _updateUpscaleCanvasSize(videoEl.videoWidth, videoEl.videoHeight);
                            upscalerCanvas.style.display = 'block';
                            videoEl.style.opacity = '0.01';
                            handledByUpscaler = window.upscalerInstance.uploadAndDraw(videoEl) !== false;
                        }
                    }
                    if (!handledByUpscaler) {
                        if (typeof upscalerCanvas !== 'undefined' && upscalerCanvas) upscalerCanvas.style.display = 'none';
                        videoEl.style.opacity = '1';
                    }
                    if (window._trackViewerFrame) window._trackViewerFrame();
                };

                if ('requestVideoFrameCallback' in videoEl) {
                    function vfc() { vfcLoop(); videoEl.requestVideoFrameCallback(vfc); }
                    videoEl.requestVideoFrameCallback(vfc);
                } else {
                    // Firefox Fallback
                    function rafLoop() { vfcLoop(); requestAnimationFrame(rafLoop); }
                    requestAnimationFrame(rafLoop);
                }
                videoEl.onplaying = () => {
                    if (typeof showOverlay === 'function') showOverlay(false);
                    setStatus('');
                    const spinner = document.getElementById('spinner');
                    if (spinner) spinner.style.display = 'none';
                    if (typeof _swapOverlayEl !== 'undefined' && _swapOverlayEl) {
                        _swapOverlayEl.style.display = 'none';
                    }
                    const overlay = document.getElementById('overlay');
                    if (overlay) overlay.style.backgroundColor = '';
                };
                console.log('[WebRTC] Video stream attached to #video');
            }
        } else if (e.track.kind === 'audio') {
            let audioEl = document.getElementById('remote-audio');
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.id = 'remote-audio';
                audioEl.autoplay = true;
                document.body.appendChild(audioEl);
            }
            const aStream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
            audioEl.srcObject = aStream;
            
            // CRITICAL FIX: Chrome aggressive garbage collection bug
            // If the MediaStream is only referenced by srcObject, Chrome will GC it ~15-20 mins in and kill the audio.
            window._activeAudioStreams = window._activeAudioStreams || [];
            window._activeAudioStreams.push(aStream);

            audioEl.play().catch(e => console.warn('[WebRTC] Audio blocked:', e));
            audioEl.muted = (typeof audioMuted !== 'undefined' ? audioMuted : false);
            audioEl.volume = (typeof _audioPrefs !== 'undefined' && _audioPrefs.streamVol !== undefined) ? _audioPrefs.streamVol : 1.0;
            console.log('[WebRTC] Audio stream attached to dedicated #remote-audio element');
        }
    };
    // ── EXPERIMENTAL WEBCODECS DATA CHANNEL RECEIVER ──
    let waitingForKeyframe = true;

    pc.ondatachannel = (event) => {
        const channel = event.channel;

        // --- WEBCODECS VIDEO PIPELINE ---
        if (channel.label === 'webcodecs') {
            console.log('[WebRTC] DataChannel opened for WebCodecs payload: webcodecs');

            const askForSync = () => {
                console.log('[WebCodecs] Channel ready. Requesting initial keyframe and config sync.');
                requestKeyframeFromHost();
            };

            if (channel.readyState === 'open') {
                askForSync();
            } else {
                channel.onopen = askForSync;
            }

            channel.onmessage = async (e) => {
                // 1. Process String Configuration Messages
                if (typeof e.data === 'string') {
                    try {
                        const msg = JSON.parse(e.data);
                        if (msg.type === 'webcodecs-config') {
                            initWebCodecsViewer(msg);
                        }
                    } catch (err) {
                        console.warn('[WebCodecs] Failed to parse string message:', err);
                    }
                    return;
                }

                // 2. Process Binary Video Frames
                if (e.data instanceof ArrayBuffer) {
                    // Prevent double-decoding if we are receiving frames from the VPS SFU
                    if (ws && ws.url.includes('/vps')) return;

                    if (!wcDecoder || wcDecoder.state !== 'configured') return;

                    const view = new DataView(e.data);
                    if (e.data.byteLength <= 9) return;

                    const isKey = view.getUint8(0) === 1;
                    const timestamp = view.getFloat64(1, true);
                    const chunkData = new Uint8Array(e.data, 9);

                    // --- RESILIENCY LAYER ---
                    if (waitingForKeyframe) {
                        if (!isKey) return;
                        waitingForKeyframe = false;
                        window.nsWaitKey = false;
                        console.log('[WebCodecs] Locked onto keyframe stream.');
                    }

                    try {
                        const chunk = new EncodedVideoChunk({
                            type: isKey ? 'key' : 'delta',
                            timestamp: timestamp,
                            data: chunkData
                        });
                        
                        // Prevent viewer hardware decode latency from building up
                        if (wcDecoder.decodeQueueSize > 5) {
                            console.warn(`[WebCodecs] Decoder queue overwhelmed (${wcDecoder.decodeQueueSize}). Dropping to kill latency...`);
                            recoverWebCodecsDecoder();
                            return;
                        }
                        
                        wcDecoder.decode(chunk);
                    } catch (err) {
                        console.error('[WebCodecs] Decode error, dropping frame...', err);
                        recoverWebCodecsDecoder();
                    }
                }
            };
            return; // Stop here so it doesn't fall through to the input block
        }

        // --- STANDARD FAST-LANE INPUT PIPELINE ---
        if (channel.label === 'input') {
            console.log('[Input] Dedicated 250Hz Fast Lane connected.');

            // This ensures your mouse/keyboard coordinates are actually processed
            channel.onmessage = (e) => {
                if (typeof e.data === 'string') {
                    try { const m = JSON.parse(e.data); if (m.type === 'pong') onPong(); } catch {}
                }
            };

            // Bind the fast-lane channel to your input dispatcher
            window._fastLaneChannel = channel;
        }
    };
    // Re-attach mic on reconnect
    if (localMicStream) {
        console.log('[WebRTC] Re-attaching local microphone...');
        const audioTrack = localMicStream.getAudioTracks()[0];
        if (audioTrack) micSender = pc.addTrack(audioTrack, localMicStream);
    }

    // Renegotiation — signal the host to create a new offer on the existing PC
    pc.onnegotiationneeded = async () => {
        if (!ws || ws.readyState !== 1) return;
        try {
            console.log('[WebRTC] Renegotiation needed — signaling host...');
            ws.send(JSON.stringify({ type: 'viewer-mic-ready' }));
        } catch (err) {
            console.error('[WebRTC] Renegotiation error:', err);
        }
    };
}

// ── MIC TOGGLE ────────────────────────────────────────────────────────────────
async function toggleMic() {
    if (forceMutedByHost) return;
    if (!micEnabled) await enableMic(); else disableMic();
}

async function enableMic() {
    if (forceMutedByHost) return;
    try {
        localMicStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false
        });

        const audioTrack = localMicStream.getAudioTracks()[0];
        if (!audioTrack) throw new Error('No audio track returned');

        if (pc && pc.signalingState !== 'closed') {
            micSender = pc.addTrack(audioTrack, localMicStream);
        }

        micEnabled = true;
        updateMicButton();
        startVAD(localMicStream);
        console.log('[Mic] Enabled:', audioTrack.label);
    } catch (err) {
        console.error('[Mic] Failed:', err);
        localMicStream = null;
        micEnabled = false;
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            showMicToast('Microphone permission denied. Please allow access in your browser.');
        } else {
            showMicToast('Microphone error: ' + err.message);
        }
        updateMicButton();
    }
}

function disableMic() {
    stopVAD();
    teardownSelfMonitor();

    if (micSender && pc && pc.signalingState !== 'closed') {
        try { pc.removeTrack(micSender); } catch (e) { console.warn('[Mic] removeTrack error:', e); }
        micSender = null;
    }
    if (localMicStream) {
        localMicStream.getTracks().forEach(t => t.stop());
        localMicStream = null;
    }

    micEnabled = false;
    updateMicButton();
    setLocalTalking(false);
    console.log('[Mic] Disabled');
}

function updateMicButton() {
    const btn = document.getElementById('micBtn');
    if (!btn) return;
    if (forceMutedByHost) {
        btn.textContent = 'Muted by Host';
        btn.className = 'ns-bar-btn ns-btn-danger';
        return;
    }
    if (micEnabled) {
        btn.textContent = 'Microphone: ON';
        btn.className = 'ns-bar-btn ns-btn-active';
    } else {
        btn.textContent = 'Microphone: OFF';
        btn.className = 'ns-bar-btn';
    }
    // Mic gain slider lives in the floating audio panel — always accessible, no show/hide needed
}

function showMicToast(msg) {
    const t = document.getElementById('micToast');
    if (!t) return;
    t.querySelector('.toast-msg').textContent = msg;
    t.classList.add('toast-show');
    setTimeout(() => t.classList.remove('toast-show'), 5000);
}

// ── AUDIO VOLUME CONTROLS ─────────────────────────────────────────────────────
// Persist prefs so they survive refresh
const _audioPrefs = {
    streamVol: parseFloat(localStorage.getItem('ns_vol_stream') ?? '1.0'),
    micGain: parseFloat(localStorage.getItem('ns_vol_micgain') ?? '1.0'),
    selfMonitor: parseFloat(localStorage.getItem('ns_vol_selfmon') ?? '0.0'),
    othersVol: parseFloat(localStorage.getItem('ns_vol_others') ?? '1.0'),
};

document.addEventListener('DOMContentLoaded', () => {
    const sv = document.getElementById('streamVolSlider');
    const sg = document.getElementById('micGainSlider');
    const sm = document.getElementById('selfMonitorSlider');
    const ov = document.getElementById('othersVolSlider');
    if (sv) { sv.value = Math.round(_audioPrefs.streamVol * 100); const d = document.getElementById('streamVolVal'); if (d) d.textContent = sv.value; }
    if (sg) { sg.value = Math.round(_audioPrefs.micGain * 100); const d = document.getElementById('micGainVal'); if (d) d.textContent = sg.value; }
    if (sm) { sm.value = Math.round(_audioPrefs.selfMonitor * 100); const d = document.getElementById('selfMonitorVal'); if (d) d.textContent = sm.value; }
    if (ov) { ov.value = Math.round(_audioPrefs.othersVol * 100); const d = document.getElementById('othersVolVal'); if (d) d.textContent = ov.value; }
    // Apply stream volume to video immediately
    const videoEl = document.getElementById('video');
    if (videoEl) videoEl.volume = _audioPrefs.streamVol;
    const remoteAudioEl = document.getElementById('remote-audio');
    if (remoteAudioEl) remoteAudioEl.volume = _audioPrefs.streamVol;
});

// Stream volume
function setStreamVolume(val) {
    const v = parseInt(val, 10);
    _audioPrefs.streamVol = v / 100;
    localStorage.setItem('ns_vol_stream', _audioPrefs.streamVol);
    const videoEl = document.getElementById('video');
    if (videoEl) videoEl.volume = _audioPrefs.streamVol;
    const remoteAudioEl = document.getElementById('remote-audio');
    if (remoteAudioEl) remoteAudioEl.volume = _audioPrefs.streamVol;
    const display = document.getElementById('streamVolVal');
    if (display) display.textContent = v;
    if (v > 0 && audioMuted) {
        audioMuted = false;
        if (videoEl?.srcObject) videoEl.srcObject.getAudioTracks().forEach(t => { t.enabled = true; });
        const remoteAudioEl = document.getElementById('remote-audio');
        if (remoteAudioEl?.srcObject) remoteAudioEl.srcObject.getAudioTracks().forEach(t => { t.enabled = true; });
        const btn = document.getElementById('audBtn');
        if (btn) { btn.textContent = 'Stream Audio'; btn.className = 'ns-bar-btn ns-btn-active'; }
    }
}

// Mic gain
let micGainNode = null;
let micGainValue = 1.0;
function setMicGain(val) {
    micGainValue = parseInt(val, 10) / 100;
    _audioPrefs.micGain = micGainValue;
    localStorage.setItem('ns_vol_micgain', micGainValue);
    if (micGainNode) micGainNode.gain.value = micGainValue;
    const display = document.getElementById('micGainVal');
    if (display) display.textContent = val;
}

// Self-monitor
let selfMonitorGain = null;
let selfMonitorSrc = null;
function setSelfMonitor(val) {
    const level = parseInt(val, 10) / 100;
    _audioPrefs.selfMonitor = level;
    localStorage.setItem('ns_vol_selfmon', level);
    const display = document.getElementById('selfMonitorVal');
    if (display) display.textContent = val;
    if (!localMicStream) return;
    if (!selfMonitorGain) {
        if (!sysAudioCtx) sysAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (sysAudioCtx.state === 'suspended') sysAudioCtx.resume();
        selfMonitorSrc = sysAudioCtx.createMediaStreamSource(localMicStream);
        selfMonitorGain = sysAudioCtx.createGain();
        selfMonitorGain.gain.value = level;
        selfMonitorSrc.connect(selfMonitorGain);
        selfMonitorGain.connect(sysAudioCtx.destination);
    } else {
        selfMonitorGain.gain.value = level;
    }
}

// Others — volume for incoming remote voice tracks (stub; wire when peer audio tracks arrive)
let _othersGainNode = null;
function setOthersVolume(val) {
    const level = parseInt(val, 10) / 100;
    _audioPrefs.othersVol = level;
    localStorage.setItem('ns_vol_others', level);
    if (_othersGainNode) _othersGainNode.gain.value = level;
    const display = document.getElementById('othersVolVal');
    if (display) display.textContent = val;
}

// Tear down self-monitor on mic disable
function teardownSelfMonitor() {
    if (selfMonitorSrc) { try { selfMonitorSrc.disconnect(); } catch { } selfMonitorSrc = null; }
    if (selfMonitorGain) { try { selfMonitorGain.disconnect(); } catch { } selfMonitorGain = null; }
    const slider = document.getElementById('selfMonitorSlider');
    const valEl = document.getElementById('selfMonitorVal');
    if (slider) slider.value = 0;
    if (valEl) valEl.textContent = '0';
    _audioPrefs.selfMonitor = 0;
    localStorage.setItem('ns_vol_selfmon', '0');
}

// Audio panel toggle (floating bottom-right button)
function toggleAudioPanel() {
    const panel = document.getElementById('audioPanel');
    const btn = document.getElementById('audioBtn');
    if (!panel) return;
    const isOpen = panel.classList.contains('open');
    panel.classList.toggle('open', !isOpen);
    if (btn) btn.classList.toggle('open', !isOpen);
    if (!isOpen) document.getElementById('nsBar')?.classList.remove('open');
}
// ── VIEWER SETTINGS MODAL ───────────────────────────────────────────────────
function openViewerSettings() {
    const modal = document.getElementById('viewerSettingsModal');
    if (modal) modal.classList.add('open');
    document.getElementById('nsBar')?.classList.remove('open');
    // Reflect current GPU backend toggle state
    _syncGpuBackendToggleUI();
}

function closeViewerSettings() {
    const modal = document.getElementById('viewerSettingsModal');
    if (modal) modal.classList.remove('open');
}

// ── WebGPU BACKEND TOGGLE ────────────────────────────────────────────────────
let _gpuBackendEnabled = localStorage.getItem('ns_gpu_backend') === '1';
let _gpuUpscalerInstance = null;

function _syncGpuBackendToggleUI() {
    const toggle = document.getElementById('vGpuBackendToggle');
    const row    = document.getElementById('vGpuBackendRow');
    if (!toggle) return;
    // Hide the row entirely on browsers that have no WebGPU at all
    if (!navigator.gpu) {
        if (row) row.style.display = 'none';
        return;
    }
    toggle.classList.toggle('on', _gpuBackendEnabled);
}

function toggleGpuBackend() {
    if (!navigator.gpu) {
        console.warn('[UpscalerGPU] WebGPU not available in this browser.');
        return;
    }
    _gpuBackendEnabled = !_gpuBackendEnabled;
    try { localStorage.setItem('ns_gpu_backend', _gpuBackendEnabled ? '1' : '0'); } catch (e) {}
    _syncGpuBackendToggleUI();
    // A reload is required to cleanly swap GPU contexts
    if (_gpuBackendEnabled) {
        if (confirm('Switching to WebGPU requires a page reload. Reload now?')) {
            location.reload();
        } else {
            // User cancelled — roll back
            _gpuBackendEnabled = false;
            try { localStorage.setItem('ns_gpu_backend', '0'); } catch (e) {}
            _syncGpuBackendToggleUI();
        }
    } else {
        if (confirm('Switching back to WebGL requires a page reload. Reload now?')) {
            location.reload();
        } else {
            _gpuBackendEnabled = true;
            try { localStorage.setItem('ns_gpu_backend', '1'); } catch (e) {}
            _syncGpuBackendToggleUI();
        }
    }
}

/** Attempts to spin up the WebGPU upscaler on the existing upscaler canvas.
 *  If creation fails (no GPU, context lost, etc.) it silently falls back to
 *  the WebGL upscaler that is already initialised. */
async function _initGpuUpscalerIfEnabled() {
    if (!_gpuBackendEnabled) return;
    if (!navigator.gpu) {
        console.warn('[UpscalerGPU] WebGPU not supported — falling back to WebGL.');
        _gpuBackendEnabled = false;
        try { localStorage.setItem('ns_gpu_backend', '0'); } catch (e) {}
        return;
    }
    if (!window.NearcadeUpscalerGPU) {
        console.warn('[UpscalerGPU] NearcadeUpscalerGPU class not loaded — falling back to WebGL.');
        return;
    }
    _ensureUpscaleCanvas();
    if (!upscalerCanvas) return;

    // Create a SECOND canvas for WebGPU (WebGL already owns upscalerCanvas context)
    let gpuCanvas = document.getElementById('upscale-canvas-gpu');
    if (!gpuCanvas) {
        gpuCanvas = document.createElement('canvas');
        gpuCanvas.id = 'upscale-canvas-gpu';
        gpuCanvas.style.cssText = upscalerCanvas.style.cssText;
        gpuCanvas.style.zIndex = '12'; // above WebGL canvas
        upscalerCanvas.parentElement?.appendChild(gpuCanvas) ?? document.body.appendChild(gpuCanvas);
    }

    const inst = await window.NearcadeUpscalerGPU.create(gpuCanvas);
    if (!inst) {
        console.warn('[UpscalerGPU] Failed to acquire WebGPU device — falling back to WebGL.');
        gpuCanvas.remove();
        _gpuBackendEnabled = false;
        try { localStorage.setItem('ns_gpu_backend', '0'); } catch (e) {}
        return;
    }

    _gpuUpscalerInstance = inst;
    inst.setMode(_upscaleMode > 0 ? _upscaleMode : 1);

    // Hide the WebGL canvas so the GPU canvas is the only visible layer
    upscalerCanvas.style.display = 'none';
    gpuCanvas.style.display = 'block';

    // Monkey-patch the upload path so the rest of viewer.js is unaware
    window._gpuCanvas = gpuCanvas;
    console.log('[UpscalerGPU] WebGPU upscaler active.');
}

// Also expose for external calling from the two render loops in viewer.js
window._gpuUpscalerInstance = () => _gpuUpscalerInstance;
window._gpuCanvas            = null;

let storedDz = localStorage.getItem('ns_deadzone');
// FIX: Raised default from 0.01 (1%) to 0.05 (5%) — 1% is below the physical
// resting noise of most worn analogue sticks, causing constant left-stick drift
// at rest. Existing users who have already saved a lower value are unaffected.
if (!storedDz) { localStorage.setItem('ns_deadzone', '0.05'); storedDz = '0.05'; }
window._globalDeadzone = parseFloat(storedDz);
window.electronAPI?.saveGlobalSetting('ns_deadzone', storedDz);

let storedSens = localStorage.getItem('ns_analog_sens');
if (!storedSens) { localStorage.setItem('ns_analog_sens', '1.00'); storedSens = '1.00'; }
window._globalSens = parseFloat(storedSens);
window.electronAPI?.saveGlobalSetting('ns_analog_sens', storedSens);



document.addEventListener('DOMContentLoaded', () => {
    const savedBw = localStorage.getItem('ns_bw_profile') || 'auto';
    const bwSel = document.getElementById('vBwSelect');
    if (bwSel) bwSel.value = savedBw;
    
    // Wire click-outside for modal
    const settingsModal = document.getElementById('viewerSettingsModal');
    if (settingsModal) {
        settingsModal.addEventListener('mousedown', (e) => {
            if (e.target === settingsModal) closeViewerSettings();
        });
    }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── VOICE ACTIVITY DETECTION ──────────────────────────────────────────────────
function startVAD(stream) {
    stopVAD();
    try {
        vadAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        vadAnalyser = vadAudioCtx.createAnalyser();
        vadAnalyser.fftSize = 512;
        vadAnalyser.smoothingTimeConstant = 0.3;
        vadSource = vadAudioCtx.createMediaStreamSource(stream);
        vadSource.connect(vadAnalyser);

        const dataArray = new Uint8Array(vadAnalyser.frequencyBinCount);
        function vadTick() {
            vadRafId = requestAnimationFrame(vadTick);
            vadAnalyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
            const rms = Math.sqrt(sum / dataArray.length);

            if (rms > VAD_THRESHOLD) {
                clearTimeout(vadTalkingTimer);
                vadTalkingTimer = null;
                if (!vadIsTalking) { vadIsTalking = true; setLocalTalking(true); }
            } else if (vadIsTalking && !vadTalkingTimer) {
                vadTalkingTimer = setTimeout(() => {
                    vadIsTalking = false;
                    vadTalkingTimer = null;
                    setLocalTalking(false);
                }, VAD_HOLD_MS);
            }
        }
        vadTick();
        console.log('[VAD] Started');
    } catch (e) { // <--- ADDED THE MISSING } RIGHT HERE
        console.error('[VAD] Error:', e);
    }
}

function stopVAD() {
    if (vadRafId) { cancelAnimationFrame(vadRafId); vadRafId = null; }
    clearTimeout(vadTalkingTimer); vadTalkingTimer = null;
    vadIsTalking = false;
    try { if (vadSource) { vadSource.disconnect(); vadSource = null; } } catch { }
    try { if (vadAudioCtx) { vadAudioCtx.close(); vadAudioCtx = null; } } catch { }
    vadAnalyser = null;
}

function setLocalTalking(active) {
    if (typeof window.vcSetTalking === 'function') window.vcSetTalking('self', active);
}
// ─────────────────────────────────────────────────────────────────────────────

const CODEC_PRIORITY = ['video/H264', 'video/VP8'];
function preferReceiverCodec(transceiver, preferredMime) {
    const caps = RTCRtpReceiver.getCapabilities?.('video');
    if (!caps || !transceiver) return null;
    let priority = CODEC_PRIORITY;
    if (preferredMime) {
        priority = [preferredMime, ...CODEC_PRIORITY.filter(c => c.toLowerCase() !== preferredMime.toLowerCase())];
    }
    
    let codecs = [...caps.codecs];
    let reordered = [];
    
    // We iterate through our priority list and splice out the matching codec (and its RTX payload if present)
    // to build our strictly compliant preferred list, keeping the remaining codecs in their exact original order.
    for (const mime of priority) {
        let targetIdx = -1;
        if (mime.toLowerCase() === 'video/h264') {
            targetIdx = codecs.findIndex(c => c.mimeType.toLowerCase() === 'video/h264' && c.sdpFmtpLine && c.sdpFmtpLine.includes('42e01f'));
        }
        if (targetIdx === -1) {
            targetIdx = codecs.findIndex(c => c.mimeType.toLowerCase() === mime.toLowerCase());
        }
        
        if (targetIdx !== -1) {
            let count = 1;
            if (codecs[targetIdx + 1] && codecs[targetIdx + 1].mimeType.toLowerCase() === 'video/rtx') count = 2;
            reordered.push(...codecs.splice(targetIdx, count));
        }
    }

    const sorted = [...reordered, ...codecs];
    try { transceiver.setCodecPreferences(sorted); return sorted[0]?.mimeType || null; } catch { return null; }
}

function sysChat(text) { console.log("[Nearcade System]:", text); }

const video = document.getElementById('video');
const frameCanvas = document.getElementById('frameCanvas');
const frameCtx = frameCanvas.getContext('2d', { alpha: false });

function startFrameProcessor(track) {
    let processorRunning = false;
    if (!window.MediaStreamTrackProcessor) {
        if (!video.srcObject) video.srcObject = new MediaStream();
        video.srcObject.addTrack(track);
        video.onplaying = () => {
            showOverlay(false); setStatus('Live', true);
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('gpPrompt').classList.add('gone');
            if (window.kbmHintEnabled) document.getElementById('kbmHint').style.display = 'inline';
            const overlay = document.getElementById('overlay');
            if (overlay) overlay.style.backgroundColor = '';
            if (typeof _swapOverlayEl !== 'undefined' && _swapOverlayEl) _swapOverlayEl.style.display = 'none';
        };
        return;
    }
    processorRunning = true;
    frameCanvas.style.display = 'block';
    video.style.opacity = '0'; video.style.position = 'absolute'; video.style.pointerEvents = 'none';
    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    let pending = null, firstFrame = true;
    (async () => {
        while (processorRunning) {
            let result;
            try { result = await reader.read(); } catch { break; }
            if (result.done) break;
            if (pending) pending.close();
            pending = result.value;
        }
    })();
    (function renderLoop() {
        if (!processorRunning) return;
        requestAnimationFrame(renderLoop);
        if (!pending) return;
        if (frameCanvas.width !== pending.displayWidth || frameCanvas.height !== pending.displayHeight) {
            frameCanvas.width = pending.displayWidth; frameCanvas.height = pending.displayHeight;
        }
        frameCtx.drawImage(pending, 0, 0);
        pending.close(); pending = null;
        if (firstFrame) {
            firstFrame = false;
            showOverlay(false); setStatus('Live', true);
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('gpPrompt').classList.add('gone');
            if (window.kbmHintEnabled) document.getElementById('kbmHint').style.display = 'inline';
            const overlay = document.getElementById('overlay');
            if (overlay) overlay.style.backgroundColor = '';
            if (typeof _swapOverlayEl !== 'undefined' && _swapOverlayEl) _swapOverlayEl.style.display = 'none';
        }
    })();
    track.addEventListener('ended', () => {
        processorRunning = false;
        frameCanvas.style.display = 'none';
        video.style.opacity = '1'; video.style.position = 'static'; video.style.pointerEvents = 'auto';
    });
}

// ── INPUT ─────────────────────────────────────────────────────────────────────
let keyMap = {
    'KeyW': 'KEY_W', 'KeyA': 'KEY_A', 'KeyS': 'KEY_S', 'KeyD': 'KEY_D',
    'ArrowUp': 'KEY_UP', 'ArrowDown': 'KEY_DOWN', 'ArrowLeft': 'KEY_LEFT', 'ArrowRight': 'KEY_RIGHT',
    'Space': 'KEY_SPACE', 'Enter': 'KEY_ENTER', 'Escape': 'KEY_ESC',
    'ShiftLeft': 'KEY_LEFTSHIFT', 'ControlLeft': 'KEY_LEFTCTRL', 'Tab': 'KEY_TAB',
    'KeyQ': 'KEY_Q', 'KeyE': 'KEY_E', 'KeyR': 'KEY_R', 'KeyF': 'KEY_F', 'KeyC': 'KEY_C',
    'KeyZ': 'KEY_Z', 'KeyX': 'KEY_X', 'KeyV': 'KEY_V', 'KeyB': 'KEY_B', 'Digit1': 'KEY_1', 'Digit2': 'KEY_2',
    'KeyT': 'KEY_T', 'KeyY': 'KEY_Y', 'KeyU': 'KEY_U', 'KeyI': 'KEY_I', 'KeyO': 'KEY_O', 'KeyP': 'KEY_P',
    'KeyG': 'KEY_G', 'KeyH': 'KEY_H', 'KeyJ': 'KEY_J', 'KeyK': 'KEY_K', 'KeyL': 'KEY_L',
    'KeyM': 'KEY_M', 'KeyN': 'KEY_N',
    'Digit3': 'KEY_3', 'Digit4': 'KEY_4', 'Digit5': 'KEY_5', 'Digit6': 'KEY_6',
    'Digit7': 'KEY_7', 'Digit8': 'KEY_8', 'Digit9': 'KEY_9', 'Digit0': 'KEY_0',
    'Minus': 'KEY_MINUS', 'Equal': 'KEY_EQUAL', 'Backspace': 'KEY_BACKSPACE',
    'BracketLeft': 'KEY_LEFTBRACE', 'BracketRight': 'KEY_RIGHTBRACE', 'Backslash': 'KEY_BACKSLASH',
    'Semicolon': 'KEY_SEMICOLON', 'Quote': 'KEY_APOSTROPHE', 'Comma': 'KEY_COMMA',
    'Period': 'KEY_DOT', 'Slash': 'KEY_SLASH', 'AltLeft': 'KEY_LEFTALT', 'Capslock': 'KEY_CAPSLOCK'
};

const defaultKeyMap = Object.assign({}, keyMap);

try {
    const saved = localStorage.getItem('ns_keybinds');
    if (saved) Object.assign(keyMap, JSON.parse(saved));
} catch (e) {}

window.keyMap = keyMap;

window.updateSingleKeybind = function(oldKey, newKey, action) {
    if (oldKey) delete keyMap[oldKey];
    if (newKey && action) keyMap[newKey] = action;
    localStorage.setItem('ns_keybinds', JSON.stringify(keyMap));
};

window.resetKeybinds = function() {
    localStorage.removeItem('ns_keybinds');
    for (const k in keyMap) delete keyMap[k];
    Object.assign(keyMap, defaultKeyMap);
};

window.setKeyPreset = function(preset) {
    const ALL_ACTIONS = ["KEY_SPACE", "KEY_L", "KEY_J", "KEY_K", "KEY_U", "KEY_I", "KEY_O", "KEY_P", "KEY_UP", "KEY_DOWN", "KEY_LEFT", "KEY_RIGHT", "KEY_W", "KEY_S", "KEY_A", "KEY_D", "KEY_ENTER", "KEY_TAB", "KEY_ESC", "KEY_M", "KEY_N"];
    for (const key in keyMap) {
        if (ALL_ACTIONS.includes(keyMap[key])) {
            delete keyMap[key];
        }
    }
    
    if (preset === 'fps') {
        // Movement & D-Pad
        keyMap['KeyW'] = 'KEY_W'; keyMap['KeyA'] = 'KEY_A'; keyMap['KeyS'] = 'KEY_S'; keyMap['KeyD'] = 'KEY_D';
        keyMap['ArrowUp'] = 'KEY_UP'; keyMap['ArrowDown'] = 'KEY_DOWN'; keyMap['ArrowLeft'] = 'KEY_LEFT'; keyMap['ArrowRight'] = 'KEY_RIGHT';
        // Face Buttons
        keyMap['Space'] = 'KEY_SPACE';   // A (Jump)
        keyMap['KeyC'] = 'KEY_L';        // B (Crouch)
        keyMap['KeyR'] = 'KEY_J';        // X (Reload)
        keyMap['KeyQ'] = 'KEY_K';        // Y (Swap)
        // Bumpers & Triggers
        keyMap['KeyG'] = 'KEY_U';        // L1 (Grenade)
        keyMap['KeyF'] = 'KEY_I';        // R1 (Melee)
        keyMap['ShiftRight'] = 'KEY_O';  // L2 (Aim - backup to mouse)
        keyMap['Enter'] = 'KEY_P';       // R2 (Shoot - backup to mouse)
        // Center
        keyMap['Escape'] = 'KEY_ENTER';  // Start
        keyMap['Tab'] = 'KEY_TAB';       // Select
        keyMap['Backquote'] = 'KEY_ESC'; // Home
        // Sticks
        keyMap['ShiftLeft'] = 'KEY_M';   // L3 (Sprint)
        keyMap['KeyV'] = 'KEY_N';        // R3 (Alt)
    } else if (preset === 'platformer') {
        // Movement (Arrow Keys) & D-Pad (IJKL)
        keyMap['KeyI'] = 'KEY_W'; keyMap['KeyJ'] = 'KEY_A'; keyMap['KeyK'] = 'KEY_S'; keyMap['KeyL'] = 'KEY_D';
        keyMap['ArrowUp'] = 'KEY_UP'; keyMap['ArrowDown'] = 'KEY_DOWN'; keyMap['ArrowLeft'] = 'KEY_LEFT'; keyMap['ArrowRight'] = 'KEY_RIGHT';
        // Face Buttons (Z X C V)
        keyMap['KeyZ'] = 'KEY_SPACE';    // A (Jump)
        keyMap['KeyX'] = 'KEY_J';        // X (Attack)
        keyMap['KeyC'] = 'KEY_L';        // B (Cancel)
        keyMap['KeyV'] = 'KEY_K';        // Y (Special)
        // Bumpers & Triggers (A S D F)
        keyMap['KeyA'] = 'KEY_U';        // L1
        keyMap['KeyS'] = 'KEY_I';        // R1
        keyMap['KeyD'] = 'KEY_O';        // L2
        keyMap['KeyF'] = 'KEY_P';        // R2
        // Center
        keyMap['Enter'] = 'KEY_ENTER';   // Start
        keyMap['ShiftRight'] = 'KEY_TAB';// Select
        keyMap['Escape'] = 'KEY_ESC';    // Home
        // Sticks
        keyMap['KeyQ'] = 'KEY_M';        // L3
        keyMap['KeyW'] = 'KEY_N';        // R3
    } else if (preset === 'fighting') {
        // Arcade Stick Layout (Movement on WASD, Attacks on UIO JKL)
        keyMap['ArrowUp'] = 'KEY_W'; keyMap['ArrowLeft'] = 'KEY_A'; keyMap['ArrowDown'] = 'KEY_S'; keyMap['ArrowRight'] = 'KEY_D';
        keyMap['KeyW'] = 'KEY_UP'; keyMap['KeyS'] = 'KEY_DOWN'; keyMap['KeyA'] = 'KEY_LEFT'; keyMap['KeyD'] = 'KEY_RIGHT';
        // Top Row (Punches)
        keyMap['KeyU'] = 'KEY_J';        // X (LP)
        keyMap['KeyI'] = 'KEY_K';        // Y (MP)
        keyMap['KeyO'] = 'KEY_I';        // R1 (HP)
        // Bottom Row (Kicks)
        keyMap['KeyJ'] = 'KEY_SPACE';    // A (LK)
        keyMap['KeyK'] = 'KEY_L';        // B (MK)
        keyMap['KeyL'] = 'KEY_P';        // R2 (HK)
        // Macros
        keyMap['KeyY'] = 'KEY_U';        // L1
        keyMap['KeyH'] = 'KEY_O';        // L2
        // Center
        keyMap['Enter'] = 'KEY_ENTER';   // Start
        keyMap['Space'] = 'KEY_TAB';     // Select
        keyMap['Escape'] = 'KEY_ESC';    // Home
        // Sticks
        keyMap['KeyN'] = 'KEY_M';        // L3
        keyMap['KeyM'] = 'KEY_N';        // R3
    }
    
    localStorage.setItem('ns_keybinds', JSON.stringify(keyMap));
};
const mouseMap = { 0: 'BTN_LEFT', 1: 'BTN_MIDDLE', 2: 'BTN_RIGHT' };

// ── Input Sequence Tracking (rollback prediction support) ──────────────────────
// Each sent input gets a sequence number so the host can acknowledge receipt.
// Lost inputs are detected by gaps in the ack sequence.
let _inputSeq = 0;
let _lastAckedSeq = 0;
let _inputBuffer = [];

function _stampInput(data) {
    const seq = ++_inputSeq;
    if (typeof data === 'object' && data !== null && !(data instanceof ArrayBuffer)) {
        data._seq = seq;
        _inputBuffer.push({ seq, data: JSON.parse(JSON.stringify(data)), time: performance.now() });
        if (_inputBuffer.length > 120) _inputBuffer.shift();
    }
    return seq;
}

function _onInputAck(ackSeq) {
    _lastAckedSeq = ackSeq;
    _inputBuffer = _inputBuffer.filter(e => e.seq > ackSeq);
    const gap = _inputSeq - ackSeq;
    if (gap > 30) {
        console.warn(`[input-pred] Large unacked gap: ${gap} inputs behind`);
    }
}

// ── Fast-Lane Input Dispatcher ────────────────────────────────────────────────
// Tries WebTransport datagrams first, then WebRTC DataChannel, then WebSocket.
function sendInputData(data) {
    const isBin = data instanceof Uint8Array || data instanceof ArrayBuffer;
    let str = isBin ? null : (typeof data === 'string' ? data : JSON.stringify(data));

    if (!isBin && typeof data === 'object' && data !== null) {
        _stampInput(data);
        str = JSON.stringify(data);
    }
    
    // 1. WebTransport Unreliable Datagrams (lowest latency)
    if (window.wtInputWriter) {
        try {
            window.wtInputWriter.write(isBin ? data : new TextEncoder().encode(str));
            return;
        } catch (_) { }
    }

    // 2. WebRTC DataChannel (P2P Fast Lane)
    if (window._fastLaneChannel && window._fastLaneChannel.readyState === 'open') {
        try { 
            let sendStr = str;
            if (!isBin && typeof sendStr === 'string' && sendStr.length < 1200) {
                sendStr = sendStr.padEnd(1200, ' ');
            }
            window._fastLaneChannel.send(isBin ? data : sendStr); 
            return; 
        } catch (_) { }
    }
    // 3. Direct input WebSocket (if available)
    if (inputWs && inputWs.readyState === 1) {
        inputWs.send(isBin ? data : str); return;
    }
    // 4. Main signaling WebSocket (fallback)
    if (ws && ws.readyState === 1) {
        ws.send(isBin ? data : str);
    }
}

function sendKbm(data) {
    if (document.pointerLockElement) {
        data.type = 'keyboard';
        data.viewerId = myId;
        data.pad_id = myId + '_0';
        sendInputData(data);
    }
}
function requestPointerLock() {
    if (!kbEnabled) return;
    if (!document.pointerLockElement) {
        const c = document.getElementById('video-container') || document.body;
        // FIX: Make it safe for Firefox (which doesn't return a Promise)
        const promise = c.requestPointerLock();
        if (promise && typeof promise.catch === 'function') {
            promise.catch(() => { });
        }
    }
}
frameCanvas.addEventListener('click', requestPointerLock);
video.addEventListener('click', requestPointerLock);

document.addEventListener('click', e => {
    if (e.target === frameCanvas ||
        e.target === video ||
        e.target.id === 'webcodecs-canvas' || // Add this check!
        e.target.closest('#video-container')) {
        requestPointerLock();
    }
});
document.addEventListener('click', e => { if (e.target === frameCanvas || e.target === video || (typeof wcCanvas !== 'undefined' && e.target === wcCanvas)) requestPointerLock(); });
document.addEventListener('keydown', e => { if (!document.pointerLockElement) return; if (keyMap[e.code]) { e.preventDefault(); sendKbm({ event: 'keydown', key: keyMap[e.code] }); } });
document.addEventListener('keyup', e => { if (!document.pointerLockElement) return; if (keyMap[e.code]) { e.preventDefault(); sendKbm({ event: 'keyup', key: keyMap[e.code] }); } });
document.addEventListener('mousemove', e => { if (!document.pointerLockElement) return; sendKbm({ event: 'mousemove', dx: e.movementX, dy: e.movementY }); });
document.addEventListener('mousedown', e => { if (!document.pointerLockElement) return; if (mouseMap[e.button]) sendKbm({ event: 'keydown', key: mouseMap[e.button] }); });
document.addEventListener('mouseup', e => { if (!document.pointerLockElement) return; if (mouseMap[e.button]) sendKbm({ event: 'keyup', key: mouseMap[e.button] }); });

// ── EXPERIMENTAL TABLET SUPPORT ───────────────────────────────────────────────
function handleTabletEvent(e) {
    if (e.pointerType !== 'pen') return;
    
    let targetEl = (typeof wcCanvas !== 'undefined' && wcCanvas.style.display !== 'none') ? wcCanvas : 
                   (typeof video !== 'undefined' && video.style.display !== 'none') ? video : 
                   (typeof frameCanvas !== 'undefined' ? frameCanvas : null);
                   
    if (!targetEl) return;
    const bounds = targetEl.getBoundingClientRect();
    
    // Normalize coordinates (0.0 to 1.0) relative to the video frame
    const nx = (e.clientX - bounds.left) / bounds.width;
    const ny = (e.clientY - bounds.top) / bounds.height;
    
    // Clamp so the pen doesn't draw way off screen
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    
    e.preventDefault(); // Stop standard mouse click emulation
    sendInputData(JSON.stringify({
        type: 'tablet',
        x: nx,
        y: ny,
        pressure: e.pressure,
        tiltX: e.tiltX || 0,
        tiltY: e.tiltY || 0
    }));
}
// Use passive: false so we can e.preventDefault() to stop normal mouse panning
document.addEventListener('pointerdown', handleTabletEvent, { passive: false });
document.addEventListener('pointermove', handleTabletEvent, { passive: false });
document.addEventListener('pointerup', handleTabletEvent, { passive: false });



// ── TOUCH ─────────────────────────────────────────────────────────────────────
let touchMode = false, useGyro = false;
const touchState = {
    axes: [0, 0, 0, 0],
    buttons: new Array(17).fill(0).map(() => ({ pressed: false, value: 0 }))
};

function toggleTouch() {
    touchMode = !touchMode;
    document.getElementById('touchUI').classList.toggle('gone', !touchMode);
    const btn = document.getElementById('vTouchToggle');
    if (btn) { if (touchMode) btn.classList.add('on'); else btn.classList.remove('on'); }
    document.getElementById('nsBar').classList.remove('open');
}

const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
if (isMobileDevice) {
    touchMode = true;
    document.addEventListener('DOMContentLoaded', () => {
        const tUI = document.getElementById('touchUI');
        const tBtn = document.getElementById('touchToggleBtn');
        if (tUI) tUI.classList.remove('gone');
        if (tBtn) { tBtn.classList.add('ns-btn-active'); tBtn.textContent = 'Touch UI: ON'; }
    });
    // NOTE: Do NOT call activateGamepad() here — it would set gpStateObj.lastActiveId
    // before ws is open, causing the gpid announcement to never be sent to the host.
    // The existing touchstart listener on the document (line ~2170) handles first-touch
    // activation at the correct time after the WebSocket is connected.
}

async function toggleGyro() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try { const s = await DeviceOrientationEvent.requestPermission(); if (s === 'granted') useGyro = !useGyro; } catch (e) { }
    } else { useGyro = !useGyro; }
    const btn = document.getElementById('gyroToggleBtn');
    if (btn) { btn.textContent = 'Aim Gyro: ' + (useGyro ? 'ON' : 'OFF'); btn.classList.toggle('ns-btn-active', useGyro); }
    if (!useGyro) { touchState.axes[2] = 0; touchState.axes[3] = 0; }
}

window.addEventListener('deviceorientation', (e) => {
    if (!useGyro || !touchMode) return;
    touchState.axes[2] = Math.max(-1, Math.min(1, e.gamma / 45.0));
    touchState.axes[3] = Math.max(-1, Math.min(1, (e.beta - 45) / 45.0));
});

document.querySelectorAll('[data-btn]').forEach(el => {
    el.addEventListener('touchstart', e => { 
        e.preventDefault(); 
        if (clientRumbleEnabled && navigator.vibrate) navigator.vibrate(20);
        touchState.buttons[el.dataset.btn].pressed = true; 
        touchState.buttons[el.dataset.btn].value = 1;
        // Use a CSS class instead of inline styles — inline style mutations
        // are silently dropped by mobile Chrome when preventDefault() is called,
        // causing the "forgot to show pressed" visual glitch.
        el.classList.add('touch-pressed');
    }, { passive: false });
    
    const release = e => {
        e.preventDefault();
        touchState.buttons[el.dataset.btn].pressed = false;
        touchState.buttons[el.dataset.btn].value = 0;
        el.classList.remove('touch-pressed');
    };
    
    el.addEventListener('touchend', release, { passive: false });
    el.addEventListener('touchcancel', release, { passive: false });
});

const jBase = document.getElementById('jBase');
const jStick = document.getElementById('jStick');
let jBaseRect = null;
// Track the specific finger (touch identifier) driving this stick, not just
// touches[0]. Without this, adding a second finger anywhere on screen (e.g.
// tapping an action button while holding the stick) can make touches[0]
// resolve to the WRONG finger on the next event, snapping the stick toward
// that finger's position — and when that second finger lifts, the stick's
// own touchend can fire from stale/reordered touch data and zero the axis
// even though the original stick finger never left the screen.
let jBaseTouchId = null;
function _touchById(touchList, id) {
    for (let i = 0; i < touchList.length; i++) { if (touchList[i].identifier === id) return touchList[i]; }
    return null;
}
function updateStick(touch) {
    if (!jBaseRect) return;
    const cx = jBaseRect.left + jBaseRect.width / 2, cy = jBaseRect.top + jBaseRect.height / 2, max = jBaseRect.width / 2;
    let dx = touch.clientX - cx, dy = touch.clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > max) { dx = (dx / dist) * max; dy = (dy / dist) * max; }
    jStick.style.transform = `translate(${dx}px,${dy}px)`;
    touchState.axes[0] = dx / max; touchState.axes[1] = dy / max;
}
if (jBase) {
    jBase.addEventListener('touchstart', e => {
        e.preventDefault();
        if (jBaseTouchId !== null) return; // already tracking a finger, ignore extras
        const t = e.changedTouches[0];
        jBaseTouchId = t.identifier;
        jBaseRect = jBase.getBoundingClientRect();
        updateStick(t);
    }, { passive: false });
    jBase.addEventListener('touchmove', e => {
        e.preventDefault();
        if (jBaseTouchId === null) return;
        const t = _touchById(e.touches, jBaseTouchId);
        if (t) updateStick(t);
    }, { passive: false });
    const jBaseRelease = e => {
        e.preventDefault();
        if (jBaseTouchId === null) return;
        const stillDown = _touchById(e.touches, jBaseTouchId);
        if (stillDown) return; // our finger is still on screen, some other finger changed
        jBaseTouchId = null;
        jStick.style.transform = 'translate(0px,0px)';
        touchState.axes[0] = 0; touchState.axes[1] = 0;
    };
    jBase.addEventListener('touchend', jBaseRelease, { passive: false });
    jBase.addEventListener('touchcancel', jBaseRelease, { passive: false });
}

const jBaseRight = document.getElementById('jBaseRight');
const jStickRight = document.getElementById('jStickRight');
let jBaseRightRect = null;
let jBaseRightTouchId = null;
function updateStickRight(touch) {
    if (!jBaseRightRect) return;
    const cx = jBaseRightRect.left + jBaseRightRect.width / 2, cy = jBaseRightRect.top + jBaseRightRect.height / 2, max = jBaseRightRect.width / 2;
    let dx = touch.clientX - cx, dy = touch.clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > max) { dx = (dx / dist) * max; dy = (dy / dist) * max; }
    jStickRight.style.transform = `translate(${dx}px,${dy}px)`;
    touchState.axes[2] = dx / max; touchState.axes[3] = dy / max;
}
if (jBaseRight) {
    jBaseRight.addEventListener('touchstart', e => {
        e.preventDefault();
        if (jBaseRightTouchId !== null) return;
        const t = e.changedTouches[0];
        jBaseRightTouchId = t.identifier;
        jBaseRightRect = jBaseRight.getBoundingClientRect();
        updateStickRight(t);
    }, { passive: false });
    jBaseRight.addEventListener('touchmove', e => {
        e.preventDefault();
        if (jBaseRightTouchId === null) return;
        const t = _touchById(e.touches, jBaseRightTouchId);
        if (t) updateStickRight(t);
    }, { passive: false });
    const jBaseRightRelease = e => {
        e.preventDefault();
        if (jBaseRightTouchId === null) return;
        const stillDown = _touchById(e.touches, jBaseRightTouchId);
        if (stillDown) return;
        jBaseRightTouchId = null;
        jStickRight.style.transform = 'translate(0px,0px)';
        touchState.axes[2] = 0; touchState.axes[3] = 0;
    };
    jBaseRight.addEventListener('touchend', jBaseRightRelease, { passive: false });
    jBaseRight.addEventListener('touchcancel', jBaseRightRelease, { passive: false });
}

// Removed redundant dpad-btn listener block since it's handled by data-btn above

// ── HID GYRO ──────────────────────────────────────────────────────────────────
let hidDevice = null, hostMotionEnabled = false, hidGyroX = 0, hidGyroY = 0;
async function requestHID() {
    if (!('hid' in navigator)) { 
        if (window.pushToast) window.pushToast('WebHID is not supported. Falling back to standard Gamepad API.', { type: 'error' });
        window.updateInputMode('gamepad');
        const sel = document.getElementById('vInputSelect');
        if (sel) sel.value = 'gamepad';
        return; 
    }
    try {
        const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x054c }, { vendorId: 0x057e }] });
        if (devices.length > 0) {
            hidDevice = devices[0]; await hidDevice.open();
            hidDevice.addEventListener('inputreport', handleHIDReport);
            const btn = document.getElementById('hidBtn');
            if (btn) { btn.classList.add('ns-btn-active'); btn.textContent = 'Gyro HID: ON'; }
        }
    } catch (err) { console.error('HID failed:', err); }
}

async function autoConnectHID() {
    if (!('hid' in navigator)) return false;
    try {
        const devices = await navigator.hid.getDevices();
        const validDevices = devices.filter(d => d.vendorId === 0x054c || d.vendorId === 0x057e);
        if (validDevices.length > 0) {
            hidDevice = validDevices[0];
            await hidDevice.open();
            hidDevice.addEventListener('inputreport', handleHIDReport);
            const btn = document.getElementById('hidBtn');
            if (btn) { btn.classList.add('ns-btn-active'); btn.textContent = 'Gyro HID: ON'; }
            return true;
        }
    } catch(err) { console.error('Auto HID failed:', err); }
    return false;
}
// Attempt automatic reconnection for previously granted WebHID devices
autoConnectHID();
function handleHIDReport(event) {
    const { data, reportId } = event;
    const vid = hidDevice.vendorId;
    if (vid === 0x054c) {
        const isDualSense = hidDevice.productName.toLowerCase().includes('dualsense') || hidDevice.productId === 0x0ce6;
        let off = 0;
        if (reportId === 0x01) off = isDualSense ? 16 : 13;
        else if (reportId === 0x11 || reportId === 0x31) off = isDualSense ? 15 : 14;
        else return;
        if (data.byteLength < off + 4) return;
        hidGyroX = data.getInt16(off + 2, true) / 15000.0;
        hidGyroY = data.getInt16(off, true) / 15000.0;
    } else if (vid === 0x057e) {
        if (reportId !== 0x30 || data.byteLength < 25) return;
        hidGyroX = data.getInt16(21, true) / 30000.0;
        hidGyroY = data.getInt16(19, true) / 30000.0;
    }

    if (window.currentInputMode === 'webhid') {
        const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const b64 = btoa(String.fromCharCode.apply(null, u8));
        const pkt = JSON.stringify({
            type: 'webhid',
            vid: vid,
            pid: hidDevice.productId,
            buffer: b64
        });
        sendInputData(pkt);
    }
}

// ── CALIBRATION ───────────────────────────────────────────────────────────────
const calibMaps = {};
(function loadSavedCalibMaps() {
    const PREFIX = 'nearsec_map_';
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) { try { calibMaps[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k)); } catch { } }
    }
})();
window.addEventListener('message', e => {
        if (e.data?.type === 'NEARCADE_CONFIG_UPDATE' && e.data.hardwareId) calibMaps[e.data.hardwareId] = e.data.map;
        if (e.data?.type === 'NEARCADE_SMART_DB' && e.data.db) {
            smartDb = e.data.db;
            window.smartDb = smartDb;
        }
        if (e.data?.type === 'NEARCADE_DEADZONE') {
            gpDeadzones[e.data.index] = e.data.value;
        }
        if (e.data?.type === 'NEARCADE_STICK_CFG' && e.data.index !== undefined) {
            const idx = e.data.index;
            if (e.data.ldz !== undefined) gpDeadzones[idx] = e.data.ldz;
            if (e.data.rdz !== undefined) gpDeadzones[idx + 0.5] = e.data.rdz;
            if (e.data.lsens !== undefined) gpSens[idx] = e.data.lsens;
            if (e.data.rsens !== undefined) gpSens[idx + 0.5] = e.data.rsens;
        }
    });

// ── NEARCADE PROBE SIM CORE: START ──────────────────────────────────────────
// Everything between the START/END markers is extracted VERBATIM at build time
// into tools/gamepad-probe/www/viewer-sim.js so the standalone Gamepad Probe
// simulates the viewer with the real production code. Keep this region free of
// DOM / WebSocket dependencies. (tools/gamepad-probe/extract-sim.js)
function getSafeGamepadId(gp) {
    return gp.id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);
}

function lookupCalibMap(gp) {
    const safeId = getSafeGamepadId(gp);
    if (calibMaps[safeId]) return calibMaps[safeId];
    if (smartDb[gp.id]) return smartDb[gp.id];
    if (smartDb[safeId]) return smartDb[safeId];
    
    for (const [key, map] of Object.entries(smartDb)) {
        const keyPrefix = key.split('(')[0].trim().toLowerCase();
        const idPrefix = gp.id.split('(')[0].trim().toLowerCase();
        if (keyPrefix && idPrefix && (gp.id.includes(key) || key.includes(gp.id) || keyPrefix === idPrefix)) return map;
    }
    
    // Fallback: If Steam masks the pad as an Xbox One S controller (045e-02ea) but it has 17+ buttons, it might be a DualSense.
    if (gp.id.includes('045e-02ea') && gp.buttons.length >= 17) {
        for (const key of Object.keys(smartDb)) {
            if (key.includes('DualSense')) return smartDb[key];
        }
    }
    
    return null;
}

function applyCalibration(gp, state) {
    const safeId = getSafeGamepadId(gp);
    const m = lookupCalibMap(gp);
    if (!m) return;
    calibMaps[safeId] = m;
    const readStick = (mp) => {
        if (mp == null) return null;
        if (typeof mp === 'number') return gp.axes[mp] || 0;
        if (mp.type === 'btn') {
            const v = gp.buttons[mp.idx]?.value || 0;
            return (v - 0.5) * 2; // Remap 0.0-1.0 to -1.0-1.0 (center is 0.5)
        }
        return gp.axes[mp.idx] || 0;
    };
    // FIX: state.axes stores -1..1 floats — NOT pre-scaled int16s.
    // Previous code did Math.round(rx * 32767) here, then _packGamepadJson
    // multiplied by 32767 AGAIN, producing ~1 billion (right stick garbage/overflow).
    // Also apply the active deadzone so calibrated axes get the same filtering
    // as the polling loop already applies to the left stick.
    const dzX = window._globalDeadzoneX ?? 0.05;
    const dzY = window._globalDeadzoneY ?? 0.05;
    const _rsens = m.rsens !== undefined ? m.rsens : (window._globalSens !== undefined ? window._globalSens : 1.0);
    const _applyDz = (v, dz) => {
        if (Math.abs(v) < dz) return 0;
        return Math.sign(v) * ((Math.abs(v) - dz) / (1.0 - dz));
    };
    const rx = readStick(m.rsx);
    const ry = readStick(m.rsy);
    if (rx !== null) state.axes[2] = _applyDz(Math.max(-1.0, Math.min(1.0, rx * _rsens)), dzX);
    if (ry !== null) state.axes[3] = _applyDz(Math.max(-1.0, Math.min(1.0, ry * _rsens)), dzY);
    function readTrigger(mp) {
        if (!mp) return 0;
        if (mp.type === 'btn') return Math.round((gp.buttons[mp.idx]?.value || 0) * 255);
        const raw = gp.axes[mp.idx] ?? -1;
        const norm = Math.max(0, (raw + 1) / 2);
        return norm < 0.05 ? 0 : Math.round(norm * 255);
    }
    const lt = readTrigger(m.lt), rt = readTrigger(m.rt);
    if (lt > 0 || m.lt) state.buttons[6] = { pressed: lt > 10, value: lt / 255.0 };
    if (rt > 0 || m.rt) state.buttons[7] = { pressed: rt > 10, value: rt / 255.0 };
}

// Extracted from pollGamepad's inline loop so the Gamepad Probe can run the
// exact same axis/button transform (deadzone + sensitivity + micro-jitter
// filter) against its own cache/state objects. Returns true when any value
// changed, mirroring the original inline logic.
function applyGamepadDzSens(gp, cache, state, gpDeadzones, gpSens) {
    const idx = gp.index;
    const lsens = gpSens[idx] !== undefined ? gpSens[idx] : window._globalSens ?? 1.0;
    const rsens = gpSens[idx + 0.5] !== undefined ? gpSens[idx + 0.5] : window._globalSens ?? 1.0;
    
    const dzX = window._globalDeadzoneX ?? 0.05;
    const dzY = window._globalDeadzoneY ?? 0.05;

    let changed = false;
    for (let i = 0; i < 4; i++) {
        let val = gp.axes[i] || 0;
        const isRightStick = i >= 2;
        const dz = (i % 2 === 0) ? dzX : dzY;
        const sens = isRightStick ? rsens : lsens;
        if (Math.abs(val) < dz) val = 0;
        else val = Math.sign(val) * ((Math.abs(val) - dz) / (1 - dz));

        val = Math.max(-1.0, Math.min(1.0, val * sens));

        let finalVal = Math.round(val * 32767);
        // Micro-jitter filter: ignore axis changes smaller than 32/32767 (~0.09%)
        // This is sub-pixel level, preserving exact angles for Smash Bros while stopping resting tremor spam.
        if (Math.abs(cache.axes[i] - finalVal) > 32) {
            changed = true;
            cache.axes[i] = finalVal;
        }
        state.axes[i] = cache.axes[i] / 32767.0;
    }
    for (let i = 0; i < 16; i++) {
        const b = gp.buttons[i];
        const vRaw = b?.value || 0;
        const vInt = Math.round(vRaw * 255);
        if (cache.btns[i] !== vInt) { changed = true; cache.btns[i] = vInt; }
        state.buttons[i].value = cache.btns[i] / 255.0;
        state.buttons[i].pressed = b?.pressed || false;
    }
    return changed;
}
// ── NEARCADE PROBE SIM CORE: END ────────────────────────────────────────────

// ── GAMEPAD POLLING ───────────────────────────────────────────────────────────
let gpPolling = false, lastGpSend = {}, lastGpStr = {};
let gpCache = {}, gpStateObj = {};
window.nsRedundancyEnabled = localStorage.getItem('ns_redundancy') !== 'false';
window.tournamentMode = false;
let gpDeadzones = {};
let gpSens = {};
let sentGpid = new Set();

function activateGamepad() {
    if (gpPolling) return;
    gpPolling = true;
    const pmt = document.getElementById('gpPrompt');
    if (pmt) { pmt.classList.add('active'); pmt.textContent = 'Grab A Gamepad!'; }
    // 1ms interval (1000 Hz) for maximum competitive precision / lowest input latency
    setInterval(pollGamepad, 4); // 250Hz polling (improves upscaler performance)
}

let knownNativePads = [];
if (window.electronAPI && window.electronAPI.onNativeGamepadEvent) {
    window.electronAPI.onNativeGamepadEvent(msg => {
        if (!gpPolling) activateGamepad();
        if (msg.type === 'gamepad_connected') {
            document.getElementById('gpPrompt')?.classList.add('gone');
            const pInfo = { padIndex: msg.index + 100, id: msg.id || 'Native Controller', name: msg.name || 'Native Controller' };
            knownNativePads.push(pInfo);
            if (ws?.readyState === 1) {
                ws.send(JSON.stringify(Object.assign({ type: 'gpid' }, pInfo)));
            }
            maybeShowControllerGuide();
        } else if (msg.type === 'gamepad_state') {
            const vIndex = msg.index + 100;
            const state = { type: 'gamepad', viewerId: myId, pad_id: myId + '_' + vIndex, padIndex: vIndex, axes: msg.state.axes, buttons: msg.state.buttons };
            const str = JSON.stringify(state);
            const now = Date.now();
            const forceHb = now - (lastGpSend[vIndex] || 0) > 100;
            if (str !== lastGpStr[vIndex] || forceHb) {
                lastGpStr[vIndex] = str; lastGpSend[vIndex] = now; sendInputData(str);
            }
        } else if (msg.type === 'gamepad_disconnected') {
            const vIndex = msg.index + 100;
            knownNativePads = knownNativePads.filter(p => p.padIndex !== vIndex);
            // Send one last explicitly zeroed state so the host releases all buttons/axes
            const zeroState = { type: 'gamepad', viewerId: myId, pad_id: myId + '_' + vIndex, padIndex: vIndex, axes: [0,0,0,0], buttons: Array.from({length: 16}, () => ({pressed: false, value: 0})) };
            const str = JSON.stringify(zeroState);
            lastGpStr[vIndex] = str; lastGpSend[vIndex] = Date.now(); sendInputData(str);
        }
    });
    window.electronAPI.startNativeGamepadCapture();
}

// Experimental modes stored in localStorage are provisional — the host may have
// disabled the module since the last visit. Treat them as pending confirmation;
// the ctrl-settings broadcast below will either keep or reset the mode.
const _experimentalModes = ['guitar', 'hotas', 'tablet', 'eyetracking', 'lightgun', 'balanceboard', 'adaptive'];
window.currentInputMode = localStorage.getItem('ns_input_mode') || 'gamepad';
if (window.currentInputMode === 'webhid') window.currentInputMode = 'gamepad'; // Auto-migrate legacy clients
// Provisionally clear non-gamepad experimental modes to avoid sending the wrong
// type before the server confirms the module is still enabled.
if (_experimentalModes.includes(window.currentInputMode)) {
    // Will be restored by ctrl-settings if the host still has it enabled
    window._provisionalInputMode = window.currentInputMode;
    window.currentInputMode = 'gamepad';
}
let eyeTrackerCam = null;
let eyeTrackerFaceMesh = null;

window.updateInputMode = function(val) { 
    window.currentInputMode = val; 
    localStorage.setItem('ns_input_mode', val);
    console.log('[InputMode] Switched to:', val);
    

    
    if (val === 'eyetracking') {
        startEyeTracking();
    } else {
        stopEyeTracking();
    }
};

function startEyeTracking() {
    if (eyeTrackerCam) return;
    console.log('[EyeTrack] Starting MediaPipe FaceMesh...');
    
    const videoElement = document.createElement('video');
    videoElement.style.display = 'none';
    videoElement.setAttribute('autoplay', '');
    videoElement.setAttribute('playsinline', '');
    document.body.appendChild(videoElement);

    if (typeof FaceMesh === 'undefined') {
        alert("FaceMesh library is not loaded. Ensure you have an internet connection.");
        return;
    }

    eyeTrackerFaceMesh = new FaceMesh({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });
    
    eyeTrackerFaceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
    
    eyeTrackerFaceMesh.onResults(onFaceMeshResults);

    eyeTrackerCam = new Camera(videoElement, {
        onFrame: async () => {
            if (eyeTrackerFaceMesh) {
                await eyeTrackerFaceMesh.send({image: videoElement});
            }
        },
        width: 640,
        height: 480
    });
    eyeTrackerCam.start();
    eyeTrackerCam.videoElement = videoElement;
}

function stopEyeTracking() {
    if (eyeTrackerCam) {
        console.log('[EyeTrack] Stopping MediaPipe FaceMesh...');
        eyeTrackerCam.stop();
        if (eyeTrackerCam.videoElement) {
            eyeTrackerCam.videoElement.srcObject?.getTracks().forEach(t => t.stop());
            eyeTrackerCam.videoElement.remove();
        }
        eyeTrackerCam = null;
    }
    if (eyeTrackerFaceMesh) {
        eyeTrackerFaceMesh.close();
        eyeTrackerFaceMesh = null;
    }
}

function onFaceMeshResults(results) {
    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) return;
    
    const landmarks = results.multiFaceLandmarks[0];
    const nose = landmarks[1];
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const chin = landmarks[152];
    
    const px = (nose.x - 0.5) * 200;
    const py = (nose.y - 0.5) * 200;
    const pz = nose.z * -1000;
    
    const yaw = Math.atan2(rightEye.z - leftEye.z, rightEye.x - leftEye.x) * (180/Math.PI);
    const pitch = Math.atan2(chin.z - nose.z, chin.y - nose.y) * (180/Math.PI) - 15;
    const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * (180/Math.PI);

    const eyeState = {
        type: 'eyetracking',
        viewerId: myId,
        x: px, y: py, z: pz,
        yaw: yaw, pitch: pitch, roll: roll
    };
    
    sendInputData(JSON.stringify(eyeState));
}

function pollGamepad() {
    if (!gpPolling) return;
    let pads = navigator.getGamepads ? navigator.getGamepads() : [];
    
    // If native Python backends are supplying inputs, ignore browser Gamepad API to prevent ghost inputs
    if (knownNativePads.length > 0) pads = [];

    const now = Date.now();
    
    // 1. Find the best device (Standard+Profile > Standard > Any > Touch)
    // Prefer standard pads that HAVE a calibration profile: picking a
    // duplicate without one (e.g. a generic "PS5 Controller" copy next to
    // the proper "DualSense Wireless Controller") ships raw uncalibrated
    // input to the host — no deadzone/sensitivity/curve ever applies.
    let bestGp = null;
    let bestStd = null;
    let bestStdProfiled = null;
    let isTouch = false;
    for (const gp of pads) {
        if (!gp || !gp.connected) continue;
        if (!bestGp) bestGp = gp;
        if (gp.mapping === 'standard') {
            if (!bestStd) bestStd = gp;
            if (!bestStdProfiled && lookupCalibMap(gp)) bestStdProfiled = gp;
        }
    }
    bestGp = bestStdProfiled || bestStd || bestGp;
    if (!bestGp && touchMode) isTouch = true;
    
    if (!bestGp && !isTouch) {
        // If the standard gamepad was just disconnected, zero its state so the host doesn't stick
        if (gpStateObj[0] && !gpStateObj[0]._disconnectedSent) {
            const zeroState = { type: 'gamepad', viewerId: myId, pad_id: myId + '_0', padIndex: 0, axes: [0,0,0,0], buttons: Array.from({length: 16}, () => ({pressed: false, value: 0})) };
            gpStateObj[0] = zeroState;
            gpStateObj[0]._disconnectedSent = true;
            gpCache[0] = { axes: new Int32Array(4), btns: new Int32Array(16) }; // clear cache
            sendInputData(JSON.stringify(zeroState));
        }
        return; 
    }



    const vIndex = 0; // Force ALL inputs from this viewer to slot 0

    // 2. Announce GPID if changed
    let activeId = isTouch ? 'virtual-touch' : bestGp.id;
    let activeName = isTouch ? 'Mobile Touch Controls' : (bestGp.id.replace(/^[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-/, '').replace(/\(.*?\)/g, '').replace(/[^a-zA-Z0-9 -]/g, '').trim() || 'Standard Controller');
    
    if (gpStateObj.lastActiveId !== activeId) {
        gpStateObj.lastActiveId = activeId;
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'gpid', padIndex: vIndex, id: activeId, name: activeName }));
    }

    let cache = gpCache[vIndex];
    let state = gpStateObj[vIndex];
    if (!cache) {
        cache = { axes: new Int32Array(4), btns: new Int32Array(16) };
        gpCache[vIndex] = cache;
        state = { type: 'gamepad', viewerId: myId, pad_id: myId + '_' + vIndex, padIndex: vIndex, axes: [0,0,0,0], buttons: Array.from({length: 16}, () => ({pressed: false, value: 0})) };
        gpStateObj[vIndex] = state;
    }
    state.viewerId = myId;
    state.pad_id = myId + '_' + vIndex;
    state._disconnectedSent = false;

    let changed = false;

    if (!isTouch && bestGp) {
        changed = applyGamepadDzSens(bestGp, cache, state, gpDeadzones, gpSens) || changed;
        applyCalibration(bestGp, state);
    } else if (isTouch) {
        for (let i = 0; i < 4; i++) {
            let finalVal = Math.round((touchState.axes[i] || 0) * 32767);
            if (cache.axes[i] !== finalVal) { changed = true; cache.axes[i] = finalVal; }
            state.axes[i] = cache.axes[i] / 32767.0;
        }
        for (let i = 0; i < 16; i++) {
            const b = touchState.buttons[i];
            const vRaw = b?.value || 0;
            const vInt = Math.round(vRaw * 255);
            if (cache.btns[i] !== vInt) { changed = true; cache.btns[i] = vInt; }
            state.buttons[i].value = cache.btns[i] / 255.0;
            state.buttons[i].pressed = b?.pressed || false;
        }
    }

    if (hidDevice && hostMotionEnabled) {
        state.axes[2] = Math.max(-1.0, Math.min(1.0, state.axes[2] + hidGyroX));
        state.axes[3] = Math.max(-1.0, Math.min(1.0, state.axes[3] + hidGyroY));
        changed = true; // Gyro is continuously sending
    }

    if (window.currentInputMode === 'guitar') {
        const guitarState = {
            type: 'guitar',
            viewerId: myId,
            pad_id: myId + '_' + vIndex,
            frets: [
                state.buttons[0].pressed ? 1 : 0,
                state.buttons[1].pressed ? 1 : 0,
                state.buttons[3].pressed ? 1 : 0,
                state.buttons[2].pressed ? 1 : 0,
                state.buttons[4].pressed ? 1 : 0
            ],
            strum: (state.buttons[12].pressed || state.axes[1] < -16000) ? 1 : ((state.buttons[13].pressed || state.axes[1] > 16000) ? -1 : 0),
            whammy: 0,
            star: state.buttons[5].pressed ? 1 : 0,
            start: state.buttons[9].pressed ? 1 : 0,
            select: state.buttons[8].pressed ? 1 : 0
        };
        
        if (state.buttons[6].value > 0) {
            guitarState.whammy = state.buttons[6].value / 255.0;
        } else if (state.buttons[7].value > 0) {
            guitarState.whammy = state.buttons[7].value / 255.0;
        } else if (Math.abs(state.axes[2]) > 4000) {
            guitarState.whammy = (state.axes[2] + 32767) / 65534.0;
        } else if (Math.abs(state.axes[3]) > 4000) {
            guitarState.whammy = (state.axes[3] + 32767) / 65534.0;
        }

        const forceHb = now - (lastGpSend[vIndex] || 0) > 100;
        if (changed || forceHb) {
            lastGpSend[vIndex] = now;
            sendInputData(JSON.stringify(guitarState));
        }
        return;
    }

    if (window.currentInputMode === 'hotas') {
        const hotasState = {
            type: 'hotas',
            viewerId: myId,
            pad_id: myId + '_' + vIndex,
            axes: state.axes.map(a => Math.max(-1.0, Math.min(1.0, a / 32767.0))),
            buttons: state.buttons.map(b => (b.pressed || b.value > 127) ? 1 : 0),
            hatX: (state.buttons[15]?.pressed ? 1 : (state.buttons[14]?.pressed ? -1 : 0)),
            hatY: (state.buttons[13]?.pressed ? 1 : (state.buttons[12]?.pressed ? -1 : 0))
        };
        const forceHb = now - (lastGpSend[vIndex] || 0) > 100;
        if (changed || forceHb) {
            lastGpSend[vIndex] = now;
            sendInputData(JSON.stringify(hotasState));
        }
        return;
    }

    // Send immediately — no rAF batching, so fast PvP inputs arrive
    // at native polling rate instead of being throttled to display refresh.
    const forceHb = now - (lastGpSend[vIndex] || 0) > 100;
    if (changed || forceHb) {
        lastGpSend[vIndex] = now;
        
        let forceJson = window.nsRedundancyEnabled && !window.tournamentMode;
        if (forceJson || useVps || (inputWs && inputWs.readyState === 1 && !window._fastLaneChannel)) {
            sendInputData(_packGamepadJson(vIndex, state));
        } else {
            sendInputData(_packGamepadBinary(vIndex, state));
        }
    }
}

// ── NEARCADE PROBE SIM CORE: START ──────────────────────────────────────────
function _packGamepadJson(vIndex, state) {
    let btnMask = 0;
    if (state.buttons[0]?.pressed) btnMask |= 0x0001;
    if (state.buttons[1]?.pressed) btnMask |= 0x0002;
    if (state.buttons[2]?.pressed) btnMask |= 0x0004;
    if (state.buttons[3]?.pressed) btnMask |= 0x0008;
    if (state.buttons[4]?.pressed) btnMask |= 0x0100;
    if (state.buttons[5]?.pressed) btnMask |= 0x0200;
    if (state.buttons[8]?.pressed) btnMask |= 0x2000;
    if (state.buttons[9]?.pressed) btnMask |= 0x1000;
    if (state.buttons[10]?.pressed) btnMask |= 0x0400;
    if (state.buttons[11]?.pressed) btnMask |= 0x0800;
    if (state.buttons[12]?.pressed) btnMask |= 0x0010;
    if (state.buttons[13]?.pressed) btnMask |= 0x0020;
    if (state.buttons[14]?.pressed) btnMask |= 0x0040;
    if (state.buttons[15]?.pressed) btnMask |= 0x0080;
    if (state.buttons[16]?.pressed) btnMask |= 0x4000;

    let obj = {
        type: 'gamepad',
        viewerId: myId,
        pad_id: myId + '_' + vIndex,
        padIndex: vIndex,
        buttons: btnMask,
        lx: Math.round((state.axes[0] || 0) * 32767),
        ly: Math.round((state.axes[1] || 0) * 32767),
        rx: Math.round((state.axes[2] || 0) * 32767),
        ry: Math.round((state.axes[3] || 0) * 32767),
        lt: state.buttons[6]?.value || 0,
        rt: state.buttons[7]?.value || 0
    };

    if (window.nsRedundancyEnabled && !window.tournamentMode) {
        if (!window._gpH) window._gpH = {};
        if (!window._gpH[vIndex]) window._gpH[vIndex] = [];
        window._gpH[vIndex].push(Object.assign({}, obj, { _ts: performance.now() }));
        if (window._gpH[vIndex].length > 4) window._gpH[vIndex].shift();
        obj.history = window._gpH[vIndex].slice(0, -1);
    }

    return JSON.stringify(obj);
}
// ── NEARCADE PROBE SIM CORE: END ────────────────────────────────────────────

function _packGamepadBinary(vIndex, state) {
    const buf = new Uint8Array(14);
    const view = new DataView(buf.buffer);
    buf[0] = 0x01; // PKT::GAMEPAD
    buf[1] = vIndex;
    
    let btnMask = 0;
    if (state.buttons[0]?.pressed) btnMask |= 0x0001;
    if (state.buttons[1]?.pressed) btnMask |= 0x0002;
    if (state.buttons[2]?.pressed) btnMask |= 0x0004;
    if (state.buttons[3]?.pressed) btnMask |= 0x0008;
    if (state.buttons[4]?.pressed) btnMask |= 0x0100;
    if (state.buttons[5]?.pressed) btnMask |= 0x0200;
    if (state.buttons[8]?.pressed) btnMask |= 0x2000;
    if (state.buttons[9]?.pressed) btnMask |= 0x1000;
    if (state.buttons[10]?.pressed) btnMask |= 0x0400;
    if (state.buttons[11]?.pressed) btnMask |= 0x0800;
    if (state.buttons[12]?.pressed) btnMask |= 0x0010;
    if (state.buttons[13]?.pressed) btnMask |= 0x0020;
    if (state.buttons[14]?.pressed) btnMask |= 0x0040;
    if (state.buttons[15]?.pressed) btnMask |= 0x0080;
    if (state.buttons[16]?.pressed) btnMask |= 0x4000;

    view.setUint16(2, btnMask, true);
    view.setInt16(4, Math.round((state.axes[0] || 0) * 32767), true);
    view.setInt16(6, Math.round((state.axes[1] || 0) * 32767), true);
    view.setInt16(8, Math.round((state.axes[2] || 0) * 32767), true);
    view.setInt16(10, Math.round((state.axes[3] || 0) * 32767), true);
    
    buf[12] = Math.round((state.buttons[6]?.value || 0) * 255);
    buf[13] = Math.round((state.buttons[7]?.value || 0) * 255);
    
    return buf;
}

['click', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (!gpPolling) activateGamepad(); }, { once: true, passive: true }));
window.addEventListener('gamepadconnected', e => {
    if (!gpPolling) activateGamepad();
    document.getElementById('gpPrompt')?.classList.add('gone');
    maybeShowControllerGuide();
});

// ── STATUS / OVERLAY ──────────────────────────────────────────────────────────
function log(msg) { console.log(msg); }
function setStatus(msg, live) {
    const st = document.getElementById('overlayStatus');
    const ts = document.getElementById('topStatus');
    if (st) st.textContent = msg;
    if (ts) ts.textContent = msg;
    if (live) { const ld = document.getElementById('liveDot'); if (ld) ld.style.display = 'inline-block'; }
}
function showOverlay(v) { 
    const el = document.getElementById('overlay'); 
    if (el) el.classList.toggle('gone', !v); 
    
    // Hide HUD and nsBar when overlay is active (host disconnected / waiting)
    if (v) {
        const hud = document.getElementById('hudWidget');
        if (hud) hud.classList.add('hide');
        const nsBar = document.getElementById('nsBar');
        if (nsBar) nsBar.classList.remove('open');
    }
    
    if (!v && typeof window.playNsBarAnimation === 'function') {
        window.playNsBarAnimation();
    }
}

// Captures the current rendered frame into _swapOverlayEl so the viewer sees
// a freeze-frame (rather than black) during host disconnects / codec swaps.
// Works in both WebCodecs canvas mode and legacy frameCanvas mode.
let _swapOverlayEl = null;
function _freezeFrameForSwap() {
    let src = (wcCanvas && wcCanvas.style.display !== 'none') ? wcCanvas : document.getElementById('video');
    if (!src) return;

    // Support both Canvas (.width) and Video (.videoWidth)
    let w = src.width || src.videoWidth;
    let h = src.height || src.videoHeight;

    // Fallback to screen resolution if no valid frame exists so we can at least draw crisp text
    if (!w || !h) {
        w = window.innerWidth * (window.devicePixelRatio || 1);
        h = window.innerHeight * (window.devicePixelRatio || 1);
        src = null; // Don't try to drawImage a broken source
    }

    if (!_swapOverlayEl) {
        _swapOverlayEl = document.createElement('canvas');
        _swapOverlayEl.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:5;pointer-events:none;';
        const container = document.getElementById('video-container') || document.body;
        container.appendChild(_swapOverlayEl);
    }

    _swapOverlayEl.style.display = 'block';
    _swapOverlayEl.width = w;
    _swapOverlayEl.height = h;

    const ctx = _swapOverlayEl.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (src) {
        try { ctx.drawImage(src, 0, 0, w, h); } catch(e) {}
    }
}

// ── DEDICATED INPUT FAST LANE ─────────────────────────────────────────────────
let inputWs = null;

function connectInputWS() {
    if (inputWs && inputWs.readyState <= 1) return;

    const urlParams = new URLSearchParams(window.location.search);
    // VPS mode (v3/vps param) was designed for the Rust SFU router's /vps endpoint.
    // The Node.js server has no /vps handler, so we always use /ws/input here.
    // The main WebSocket handles inputs as well.

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    inputWs = new WebSocket(proto + '://' + location.host + '/ws/input');

    inputWs.onopen = () => {
        console.log('[Input] Dedicated 250Hz Fast Lane connected.');
        // The server needs us to identify ourselves on this separate pipe!
        if (myId) inputWs.send(JSON.stringify({ type: 'identify', viewerId: myId }));
    };

    inputWs.onclose = () => {
        console.warn('[Input] Fast Lane disconnected. Retrying in 2s...');
        setTimeout(connectInputWS, 2000);
    };

    inputWs.onerror = () => console.error('[Input] Fast Lane error.');
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
// State vars (vpsConnected, stopReconnect, _autoJoinedVps, pinRequired) declared early at top of file.
let vpsConnected = false;
let stopReconnect = false;
async function connect() {
    const urlParams = new URLSearchParams(window.location.search);
    const hostParam = urlParams.get('host');
    
    // Check if we are connecting to a P2P room
    if (hostParam && hostParam.startsWith('p2p://')) {
        const roomCode = hostParam.replace('p2p://', '');
        console.log('[P2P] Initializing serverless connection to room:', roomCode);
        
        if (typeof setStatus === 'function') setStatus('Discovering host via P2P network...');
        if (document.getElementById('spinner')) document.getElementById('spinner').style.display = 'block';
        if (typeof showOverlay === 'function') showOverlay(true);
        
        // Provide progressive feedback for long P2P discovery times
        window._p2pProgression1 = setTimeout(() => {
            const current = document.getElementById('overlayStatus')?.innerText || '';
            if (current.includes('Discovering') && typeof setStatus === 'function') {
                setStatus('Scanning trackers for host session...');
            }
        }, 4000);
        window._p2pProgression2 = setTimeout(() => {
            const current = document.getElementById('overlayStatus')?.innerText || '';
            if (current.includes('Scanning') && typeof setStatus === 'function') {
                setStatus('Connecting to signaling swarm...');
            }
        }, 8000);
        window._p2pProgression3 = setTimeout(() => {
            const current = document.getElementById('overlayStatus')?.innerText || '';
            if (current.includes('Connecting to signaling') && typeof setStatus === 'function') {
                setStatus('Still searching, please wait...');
            }
        }, 12000);
        window._p2pProgression4 = setTimeout(() => {
            const current = document.getElementById('overlayStatus')?.innerText || '';
            if (current.includes('Still searching') && typeof setStatus === 'function') {
                setStatus('Bypassing firewalls (ICE negotiation)...');
            }
        }, 16000);
        window._p2pProgression5 = setTimeout(() => {
            const current = document.getElementById('overlayStatus')?.innerText || '';
            if (current.includes('Bypassing firewalls') && typeof setStatus === 'function') {
                setStatus('Almost there, establishing P2P route...');
            }
        }, 22000);
        
        // Emulate WebSocket interface for P2PManager
        ws = {
            readyState: 1,
            send: (data) => {
                const msgStr = typeof data === 'string' ? data : new TextDecoder().decode(data);
                let msg;
                try { msg = JSON.parse(msgStr); } catch { return; }
                
                // Route join, candidate, answer, etc via Trystero
                if (window.P2PManager) {
                    window.P2PManager.sendToHost(msg);
                }
            },
            close: function(code = 1000, reason = '') {
                console.log(`[P2P] Disconnecting from room (${code})`);
                if (window.P2PManager && window.P2PManager.room) {
                    try { window.P2PManager.room.leave(); } catch (e) { }
                }
                if (typeof this.onclose === 'function') {
                    this.onclose({ code, reason });
                }
            }
        };

        if (window.P2PManager) {
            window.P2PManager.initViewer(roomCode, (msg) => {
                if (typeof ws.onmessage === 'function') {
                    ws.onmessage({ data: JSON.stringify(msg) });
                }
            }, () => {
                clearTimeout(window._p2pProgression1);
                clearTimeout(window._p2pProgression2);
                clearTimeout(window._p2pProgression3);
                clearTimeout(window._p2pProgression4);
                clearTimeout(window._p2pProgression5);
                if (typeof setStatus === 'function') setStatus('Host found, negotiating P2P connection...');
                if (typeof ws.onopen === 'function') ws.onopen();
            });
        }
        stopReconnect = false;
    } else {
        // Always use /ws/viewer — the Node.js server has no /vps handler.
        // The ?v3 param is kept for backward compat (doesn't affect routing).
        useVps = location.hostname === 'publicnearcade.cutefame.net' || urlParams.has('v3') || urlParams.has('vps');
        let wsUrl;
        if (hostParam && !hostParam.startsWith('p2p://') && hostParam.includes('://')) {
            let base = hostParam.replace(/\/$/, '');
            base = base.replace(/^http(s?):/, 'ws$1:');
            wsUrl = base.includes('/ws/viewer') ? base : base + '/ws/viewer';
        } else {
            wsUrl = `${proto}://${wsHost}/ws/viewer`;
        }

        if (enteredPin) wsUrl += (wsUrl.includes('?') ? '&' : '?') + `pin=${encodeURIComponent(enteredPin)}`;
        if (enteredPassword) wsUrl += (wsUrl.includes('?') ? '&' : '?') + `password=${encodeURIComponent(enteredPassword)}`;
        const sig = new Signaling();
        let _sigOnOpen, _sigOnMessage, _sigOnClose, _sigOnError;
        ws = {
            get readyState() { return sig.readyState; },
            url: wsUrl,
            set onopen(fn) { _sigOnOpen = fn; },
            get onopen() { return _sigOnOpen; },
            set onmessage(fn) { _sigOnMessage = fn; },
            get onmessage() { return _sigOnMessage; },
            set onclose(fn) { _sigOnClose = fn; },
            get onclose() { return _sigOnClose; },
            set onerror(fn) { _sigOnError = fn; },
            get onerror() { return _sigOnError; },
            set binaryType(_) {},
            get binaryType() { return 'arraybuffer'; },
            send: (data) => {
                if (data instanceof ArrayBuffer || data instanceof Blob)
                    return sig.sendBinary(data);
                return sig.send(data);
            },
            close: (c, r) => sig.disconnect(c, r),
            addEventListener: () => {},
            removeEventListener: () => {},
            _sig: sig,
        };
        sig.on('connected', () => { if (_sigOnOpen) _sigOnOpen({}); });
        sig.on('disconnected', (d) => {
            if (_sigOnClose) _sigOnClose({ code: d.code || 1000, reason: d.reason || '' });
        });
        sig.on('error', (d) => { if (_sigOnError) _sigOnError(d || {}); });

        sig.on('binary', (data) => { if (_sigOnMessage) _sigOnMessage({ data }); });
        sig.on('*', (type, msg) => {
            if (_sigOnMessage && !{connected:1,disconnected:1,error:1,binary:1}[type])
                _sigOnMessage({ data: JSON.stringify(msg) });
        });
        sig.connect(wsUrl);
        // Start the dedicated input WebSocket early — parallel with the
        // join handshake — so gamepad input has a path before WebRTC connects.
        connectInputWS();
        stopReconnect = false;

        // ── WEBTRANSPORT DATAGRAM TRANSPORT (local/VPS only, not through tunnels) ──
        const _isLocalHost = host === 'localhost' || host.startsWith('localhost:') || host === '127.0.0.1' || host.startsWith('127.0.0.1:');
        if ('WebTransport' in window && (_isLocalHost || useVps)) {
            const wtUrl = useVps
                ? `https://${host}:4433/wt`
                : `${proto}://${host}/wt`;
            try {
                const wt = new WebTransport(wtUrl);
                wt.ready.then(() => {
                    console.log('[WebTransport] Connected, using datagrams for input.');
                    window.wtInputWriter = wt.datagrams.writable.getWriter();
                    wt.datagrams.readable.getReader().then(reader => {
                        (async () => {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                try {
                                    const msg = JSON.parse(new TextDecoder().decode(value));
                                    if (msg.type === 'input-ack' && msg.seq != null) _onInputAck(msg.seq);
                                } catch (_) {}
                            }
                        })();
                    }).catch(() => {});
                }).catch(e => console.warn('[WebTransport] Handshake failed, falling back to WS:', e));
                wt.closed.then(() => { window.wtInputWriter = null; }).catch(()=>{});
            } catch (e) {
                console.warn('[WebTransport] Setup error:', e);
            }
        }
    }

    // Restore saved chat color on pin screen
    const _savedClr = localStorage.getItem('ns_chat_color') || '';
    if (_savedClr) {
        const existing = document.querySelector(`.clr-opt[data-clr="${_savedClr}"]`);
        if (existing) existing.style.borderColor = '#fff';
    }
    function sendJoinToWS() {
        const liveName = (document.getElementById('nameInput')?.value || myName || '').trim();
        ws.send(JSON.stringify({
            type: 'join', viewerId: myId, name: liveName, pin: enteredPin,
            viewerRegion, clientVersion: CLIENT_VERSION, platform: viewerPlatform,
            color: localStorage.getItem('ns_chat_color') || '',
            avatar: localStorage.getItem('ns_avatar') || '',
            isDesktopApp: urlParamsGlobal.has('compat')
        }));
        knownNativePads.forEach(pInfo => ws.send(JSON.stringify(Object.assign({ type: 'gpid' }, pInfo))));
    }
    ws.onopen = () => {
        // Reset the controller ID guard so gpid is always announced after (re)connect.
        // If the poll loop ran before ws was ready (mobile first-touch timing), the
        // host never received the gpid and never registered the controller slot.
        gpStateObj.lastActiveId = null;
        sendJoinToWS();
    };

    ws.onmessage = async (e) => {
        // ── BINARY ROUTING ────────────────────────────────────────────────────
        // VPS SFU mode routes both video chunks and PCM audio as ArrayBuffers
        // over the same WebSocket. Distinguish by the 9-byte video header.
        if (e.data instanceof ArrayBuffer) {
            const byteLen = e.data.byteLength;
            if (byteLen > 9) {
                const firstByte = new Uint8Array(e.data, 0, 1)[0];
                if (firstByte === 0 || firstByte === 1) {
                    // WebCodecs video chunk: [isKey(1)] [timestamp(8)] [payload...]
                    if (!wcDecoder || wcDecoder.state !== 'configured') return;
                    const isKey = firstByte === 1;
                    if (window.nsWaitKey) {
                        if (!isKey) return;
                        window.nsWaitKey = false;
                        console.log('[WebCodecs/VPS] Locked onto keyframe.');
                    }
                    const view = new DataView(e.data);
                    const timestamp = view.getFloat64(1, true);
                    const chunkData = new Uint8Array(e.data, 9);
                    try {
                        // Prevent viewer hardware decode latency from building up
                        if (wcDecoder.decodeQueueSize > 5) {
                            console.warn(`[WebCodecs/VPS] Decoder queue overwhelmed (${wcDecoder.decodeQueueSize}). Dropping to kill latency...`);
                            recoverWebCodecsDecoder();
                            return;
                        }
                        wcDecoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp, data: chunkData }));
                    } catch (err) {
                        console.error('[WebCodecs/VPS] Decode error:', err);
                        recoverWebCodecsDecoder();
                    }
                    return;
                }
            }
            // PCM audio — only feed after user gesture has unlocked AudioContext
            if (!sysAudioCtx || sysAudioCtx.state !== 'running') return;
            try {
                let safeLen = byteLen - (byteLen % 2);
                if (!safeLen) return;
                const int16 = new Int16Array(e.data.slice(0, safeLen));
                const float32 = new Float32Array(int16.length);
                for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;
                const buf = sysAudioCtx.createBuffer(1, float32.length, 48000);
                buf.getChannelData(0).set(float32);
                const src = sysAudioCtx.createBufferSource();
                src.buffer = buf; src.connect(sysAudioCtx.destination);
                if (nextAudioTime < sysAudioCtx.currentTime) nextAudioTime = sysAudioCtx.currentTime + 0.1;
                src.start(nextAudioTime);
                nextAudioTime += buf.duration;
            } catch (err) { console.error('[Audio] Playback error:', err); }
            return;
        }
        if (e.data instanceof Blob) return;

        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        // ── AUTH HANDSHAKE ────────────────────────────────────────────────────
        // The server challenges every new viewer with a nonce; we must reply with
        // sha256(nonce + "nearcade_client_v3") before it accepts any other message.
        if (msg.type === 'auth-challenge' && msg.nonce) {
            try {
                if (!window.crypto || !window.crypto.subtle) {
                    ws.send(JSON.stringify({ type: 'auth-response', hash: "LAN_INSECURE_BYPASS", human: !!window.__nsHumanInteraction }));
                    return;
                }
                const data = new TextEncoder().encode(msg.nonce + "nearcade_client_v3");
                const digest = await crypto.subtle.digest('SHA-256', data);
                const hash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
                ws.send(JSON.stringify({ type: 'auth-response', hash, human: !!window.__nsHumanInteraction }));
            } catch (err) {
                console.error('[auth] Failed to solve challenge:', err);
                ws.send(JSON.stringify({ type: 'auth-response', hash: "LAN_INSECURE_BYPASS", human: !!window.__nsHumanInteraction }));
            }
            return;
        }

        if (msg.type === 'pong') { if (typeof onPong === 'function') onPong(); return; }

        if (msg.type === 'force-reload') {
            console.warn('[WebCodecs] Host requested fallback from WebCodecs — reloading without WebCodecs');
            _stopWcHealthMonitor();
            try { if (wcDecoder?.state !== 'closed') wcDecoder.close(); } catch (_) {}
            wcDecoder = null;
            const url = new URL(window.location.href);
            url.searchParams.delete('wc');
            url.searchParams.delete('wc2');
            setTimeout(() => { window.location.href = url.href; }, 500);
            return;
        }

        // webcodecs-config arrives on the main WS in VPS mode (replayed by the
        // Rust router on join). In WebRTC-only mode it arrives on the DataChannel.
        if (msg.type === 'smart-db') {
            smartDb = msg.payload || {};
            window.smartDb = smartDb;
            const frame = document.getElementById('controllerGuideFrame');
            if (frame?.contentWindow) frame.contentWindow.postMessage({ type: 'NEARCADE_SMART_DB', db: smartDb }, '*');
            return;
        }

        if (msg.type === 'webcodecs-config') {
            window.nsWaitKey = true;
            initWebCodecsViewer(msg);
            return;
        }

        // stream-idle: host connected to the VPS relay but not yet capturing.
        // The standby screen only activates when both conditions are true:
        //   1. The viewer is currently on the pin screen (not yet past auth).
        //   2. No host stream is active in this session.
        // If the viewer is already watching, this message is silently ignored.
        if (msg.type === 'stream-idle') {
            const pinScreen = document.getElementById('pinScreen');
            if (pinScreen && !pinScreen.classList.contains('gone')) return;
            
            showOverlay(true);
            setStatus('Host is not sharing their screen yet...');
            const sp = document.getElementById('spinner'); if (sp) sp.style.display = 'none';

            const sf = document.getElementById('_nsStandbyFrame');
            if (sf) sf.style.display = 'none';
            return;
        }

        // stream-active: host started capturing — always dismiss the standby iframe
        if (msg.type === 'stream-active') {
            const sf = document.getElementById('_nsStandbyFrame');
            if (sf) sf.style.display = 'none';
            window.nsWaitKey = true;
            setStatus('Host found, connecting...');
            return;
        }


        if (msg.type === 'host-connected') {
            if (window.sessionEndedByHost) {
                window.location.reload();
                return;
            }
            _nsHostConnected = true;
            window.sessionEndedByHost = false; // Reset session ended state
            if (pc) { try { pc.close(); } catch { } pc = null; }
            const videoEl = document.getElementById('video');
            if (videoEl?.srcObject) { videoEl.srcObject.getTracks().forEach(t => t.stop()); videoEl.srcObject = null; }
            document.getElementById('frameCanvas').style.display = 'none';
            
            // Rebuild the standard translucent overlay structure
            const overlay = document.getElementById('overlay');
            if (overlay) {
                overlay.style.backgroundColor = 'var(--surface)';
                overlay.innerHTML = `
    <div class="brand-wrap">
      <img src="/assets/NearcadeLogo.png" alt="" class="brand-img" style="height:52px;">
      <div class="brand-name" style="font-size:11px;">Nearcade</div>
    </div>
    <div id="sessionHostName" style="display:${window._hostName ? 'block' : 'none'};font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted2);font-family:var(--mono);">
      HOST SESSION — ${window._hostName || ''}
    </div>
    <div class="spin" id="spinner" style="display:block;"></div>
    <div id="overlayStatus">Waiting for host...</div>
    <div id="gpPrompt" onclick="activateGamepad()">
      Tap to activate gamepad<br>
      <span style="font-size:9px;color:var(--muted2);">(Required once by browser)</span>
    </div>`;
            }
            showOverlay(true);
            
            const sfOld = document.getElementById('_nsStandbyFrame');
            if (sfOld) sfOld.style.display = 'none';
            
            const nsBar = document.getElementById('nsBar');
            if (nsBar) nsBar.style.display = 'flex';
            
            const vcp2 = document.getElementById('vcPanel');
            if (vcp2) vcp2.style.display = '';

            // Re-announce ourselves to the host so we get pulled back in the game!
            // We directly dispatch the packet rather than calling connect() to avoid infinite event loops.
            if (_autoJoinedVps && ws && ws.readyState === 1) {
                const liveName = (document.getElementById('nameInput')?.value || myName || '').trim();
                ws.send(JSON.stringify({
                    type: 'join', 
                    viewerId: typeof myId !== 'undefined' ? myId : null, 
                    name: liveName, 
                    pin: enteredPin || '',
                    password: enteredPassword || '',
                    viewerRegion: window._myRegion || '',
                    clientVersion: typeof CLIENT_VERSION !== 'undefined' ? CLIENT_VERSION : '3.0.4',
                    platform: typeof viewerPlatform !== 'undefined' ? viewerPlatform : 'web',
                    color: localStorage.getItem('ns_chat_color') || '',
                    avatar: localStorage.getItem('ns_avatar') || '',
                    isDesktopApp: window.location.search.includes('compat')
                }));
            }

            // Display the host's saved name in both the overlay and the topbar pill
            if (msg.hostName) {
                window._hostName = msg.hostName;
                const overlayEl = document.getElementById('sessionHostName');
                if (overlayEl) { overlayEl.textContent = 'HOST SESSION — ' + msg.hostName; overlayEl.style.display = 'block'; }
                const topEl = document.getElementById('topHostName');
                const safeHostName = String(msg.hostName).replace(/[<>"'&]/g, '');
                if (topEl) topEl.innerHTML = (msg.hostRegion ? `<span class="fi fi-${msg.hostRegion.replace(/[^a-z]/gi,'')}"></span> ` : '') + safeHostName;
                const pillEl = document.getElementById('hostNamePill');
                if (pillEl) pillEl.style.display = '';
                document.title = 'Nearcade — ' + msg.hostName.replace(/[<>"'&]/g, '');
            }
            // CRITICAL FIX: Do NOT send request-offer unconditionally here.
            // The Host already automatically sends an offer when 'viewer-joined' is received.
            // Sending request-offer causes a duplicate 'viewer-joined' trigger on the Host,
            // which forces the Host to destroy the active RTCPeerConnection and start over,
            // resulting in 'User-Initiated Abort' / DataChannel disconnect loops!
            return;
        }
        if (msg.type === 'tournament-mode') {
            window.tournamentMode = !!msg.enabled;
            if (typeof window.vcSetTournament === 'function') window.vcSetTournament(msg.enabled);
            return;
        }
        if (msg.type === 'tunnel-url') return;

        if (msg.type === 'offer') {
            // If PC exists and is in stable state AND is fully connected, this is a renegotiation — update existing PC.
            // If the connection is failed/disconnected, we MUST tear it down and accept the fresh PC offer from the host.
            if (pc && pc.signalingState === 'stable' && pc.connectionState === 'connected') {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
                } catch (err) {
                    console.error('[webrtc] renegotiation error:', err.message);
                }
                return;
            }
            clearTimeout(_reconnectTimer);
            if (pc) { try { pc.close(); } catch { } pc = null; }
            await createPC();
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                pc._remoteSet = true;

                // Apply receiver codec preferences AFTER remote description is set
                // so transceivers already exist. We prioritize the host's requested codec.
                pc.getTransceivers().forEach(t => {
                    if (t.receiver?.track?.kind === 'video') {
                        let preferredMime = null;
                        if (msg.codec === 'av1') preferredMime = 'video/AV1';
                        else if (msg.codec === 'hevc' || msg.codec === 'h265') preferredMime = 'video/H265';
                        else if (msg.codec === 'vp8') preferredMime = 'video/VP8';
                        else if (msg.codec === 'vp9') preferredMime = 'video/VP9';
                        else if (msg.codec === 'h264') preferredMime = 'video/H264';
                        preferReceiverCodec(t, preferredMime);
                    }
                });

                for (const c of (pc._iceBuf || [])) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { } }
                pc._iceBuf = [];
                const answer = await pc.createAnswer();
                // ── LOW-LATENCY SDP MUNGING (answer side) ──
                let ansSdp = answer.sdp;
                ansSdp = ansSdp.replace(/(a=rtpmap:\d+ opus\/48000\/2)/g, '$1\na=ptime:1\na=maxptime:1');
                await pc.setLocalDescription({ type: answer.type, sdp: ansSdp });
                ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
                // Apply bandwidth profile now that transceivers are negotiated
                _applyBwProfile(pc);
            } catch (err) {
                console.error('[webrtc] offer error:', err.message, '— SDP snippet:', msg.sdp?.sdp?.slice(0, 300));
                try { pc.close(); } catch { } pc = null;
                // Retry with a fresh request-offer in case it was a transient failure
                setTimeout(() => {
                    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'request-offer' }));
                }, 2000);
            }
            return;
        }
        if (msg.type === 'ice-host' && msg.candidate) {
            if (!pc) return;
            if (pc._remoteSet) { try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch { } }
            else { pc._iceBuf = pc._iceBuf || []; pc._iceBuf.push(msg.candidate); }
            return;
        }
        // pin-required is checked via /api/pin-required on load; ignore WebSocket commands.
        if (msg.type === 'pin-rejected' || msg.type === 'kick') {
            stopReconnect = true;
            if (pc) { try { pc.close(); } catch {} pc = null; }
            ws.close(msg.type === 'kick' ? 4003 : 4001, msg.type.toUpperCase());
            
            if (msg.reason === 'kicked' || msg.type === 'kick') {
                alert('You have been kicked by the Host.');
                try { window.close(); } catch {}
                document.body.innerHTML = '<div style="color:white;text-align:center;margin-top:20vh;font-family:sans-serif;"><h2>Disconnected</h2><p>You have been kicked by the host.</p></div>';
            } else {
                document.getElementById('pinScreen').classList.remove('gone');
                document.getElementById('pinErr').textContent = enteredPin ? 'Incorrect PIN.' : 'PIN Required.';
                document.getElementById('pinInput').value = '';
            }
            return;
        }
        if (msg.type === 'auth-ok') {
            vpsConnected = true;
            if (msg.viewer_id) {
                myId = msg.viewer_id;
                sessionStorage.setItem('ns_viewer_id', myId);
            }
            if (typeof window.showVoiceOverlay === 'function') window.showVoiceOverlay();
            if (msg.pin_required === false && !_autoJoinedVps) {
                _autoJoinedVps = true;
                pinRequired = false;
                document.getElementById('pinScreen')?.classList.add('gone');
                document.getElementById('pinWrap').style.display = 'none';
                // If we get auth-ok, we are already connected; DO NOT call submitPin() again!
            }
            return;
        }
        if (msg.type === 'your-id') {
            document.getElementById('pinScreen').classList.add('gone');
            if (typeof window.showVoiceOverlay === 'function') window.showVoiceOverlay();
            myId = msg.viewerId;
            sessionStorage.setItem('ns_viewer_id', myId);
            const nameEl = document.querySelector('#talkingMe .talking-name');
            if (nameEl) nameEl.textContent = myName + ' (You)';

            // Re-send the name handshake now that we're authenticated. The
            // server drops the onopen 'join' while the auth handshake is still
            // pending, and expects it again after your-id (see server.js).
            if (typeof sendJoinToWS === 'function') sendJoinToWS();

            // If the input WS already connected (early start above),
            // send identify now that we know our ID.
            if (inputWs && inputWs.readyState === 1) {
                inputWs.send(JSON.stringify({ type: 'identify', viewerId: myId }));
            }
            // Otherwise start the fast lane now that we know our ID.
            connectInputWS();
            return;
        }
        if (msg.type === 'host-stream-ready') {
            _nsHostConnected = true;
            const sf = document.getElementById('_nsStandbyFrame');
            if (sf) sf.style.display = 'none';
            window.nsWaitKey = true;
            setStatus('Host found, connecting...');
            maybeShowControllerGuide();
            return;
        }

        // ── RUMBLE ────────────────────────────────────────────────────────────
        if (msg.type === 'rumble') {
            if (!clientRumbleEnabled) return;

            const duration = msg.duration || 200;
            const strong   = msg.strong   ?? 0.5;
            const weak     = msg.weak     ?? 0.25;

            // 1. Try physical gamepad's vibrationActuator first
            let physicalHandled = false;
            const pads = navigator.getGamepads ? navigator.getGamepads() : [];
            for (const gp of pads) {
                if (!gp || !gp.vibrationActuator) continue;
                try {
                    gp.vibrationActuator.playEffect('dual-rumble', {
                        startDelay: 0,
                        duration,
                        weakMagnitude: weak,
                        strongMagnitude: strong,
                    });
                    physicalHandled = true;
                } catch (e) {
                    console.warn('[Rumble] playEffect failed:', e.message);
                }
                break; // Only vibrate the first connected pad
            }

            // 2. Mobile fallback / Browser Gamepad API fallback
            if (!physicalHandled && navigator.vibrate && (strong > 0 || weak > 0)) {
                if (strong >= 0.4) {
                    navigator.vibrate(Math.min(duration, 500));
                } else {
                    navigator.vibrate(30);
                }
            }

            // 3. Desktop App Native Bypass (bypasses browser whitelists)
            if (window.electronAPI && window.electronAPI.sendNativeRumble) {
                // Send to native Python backend to buzz the controller directly via evdev/XInput
                window.electronAPI.sendNativeRumble(0, strong, weak, duration);
            }

            return;
        }
        if (msg.type === 'new-tunnel-url') {
            // Host changed tunnel — redirect viewer to the new URL
            const newUrl = msg.url;
            if (newUrl && newUrl !== location.origin) {
                const currentParams = new URLSearchParams(location.search);
                const pin = currentParams.get('pin') || '';
                const lang = currentParams.get('lang') || 'en';
                let redirectUrl = newUrl + '?client=1' + (pin ? '&pin=' + encodeURIComponent(pin) : '') + '&lang=' + lang;
                if (currentParams.get('electron') === '1') redirectUrl += '&electron=1';
                // Store room so server can reassign
                fetch(newUrl + '/api/info').catch(() => {});
                setTimeout(() => { location.href = redirectUrl; }, 500);
            }
            return;
        }
        if (msg.type === 'host-disconnected') {
            _nsHostConnected = false;
            window.sessionEndedByHost = true;
            _freezeFrameForSwap();

            const overlay = document.getElementById('overlay');
            if (overlay) {
                overlay.style.backgroundColor = 'rgba(10, 10, 12, 0.85)';
                overlay.innerHTML = '<div class="brand-wrap"><img src="/assets/NearcadeLogo.png" alt="" class="brand-img" style="height:52px;"><div class="brand-name" style="font-size:11px;">Nearcade</div></div><div style="font-size:22px;font-weight:700;color:var(--accent);margin:16px 0 4px;">Session Ended</div><div style="font-size:13px;color:var(--muted);margin-bottom:20px;">The host has stopped the session. You may now close this tab.</div><button class="pin-submit-btn" onclick="if(window.electronAPI){window.electronAPI.backToDashboard(\'arcade\')}else{window.dispatchEvent(new Event(\'ns-close-tab\')); setTimeout(() => { window.close(); location.href=\'about:blank\'; }, 50);}" style="margin-top:8px;">Leave Session</button>';
            }
            
            showOverlay(true);
            const sp = document.getElementById('spinner');
            if (sp) sp.style.display = 'none';

            // Hide the entire sidebar and voice chat 
            const nsBar = document.getElementById('nsBar');
            if (nsBar) nsBar.style.display = 'none';

            if (typeof window.teardownVoiceChat === 'function') window.teardownVoiceChat();
            const vcBtn = document.getElementById('btnVcToggle');
            if (vcBtn) { vcBtn.style.display = 'none'; vcBtn.classList.remove('active'); }
            const vcp = document.getElementById('vcPanel');
            if (vcp) {
                vcp.classList.remove('open');
                vcp.style.display = 'none';
            }

            if (pc) { pc.close(); pc = null; }
            if (video) video.srcObject = null;
            return;
        }

        if (msg.type === 'host-stream-stopped') {
            _nsHostConnected = false;
            _freezeFrameForSwap();

            if (typeof _swapOverlayEl !== 'undefined' && _swapOverlayEl) {
                const ctx2d = _swapOverlayEl.getContext('2d');
                const cx = _swapOverlayEl.width / 2, cy = _swapOverlayEl.height / 2;
                ctx2d.fillStyle = 'rgba(0,0,0,0.55)';
                ctx2d.fillRect(0, 0, _swapOverlayEl.width, _swapOverlayEl.height);
                ctx2d.font = `bold ${Math.round(_swapOverlayEl.height * 0.04)}px sans-serif`;
                ctx2d.fillStyle = '#ffffff';
                ctx2d.textAlign = 'center';
                ctx2d.textBaseline = 'middle';
                ctx2d.fillText("Stream Stopped", cx, cy);
            }
            
            showOverlay(true);
            const sp = document.getElementById('spinner');
            if (sp) sp.style.display = 'none';

            if (pc) { pc.close(); pc = null; }
            if (video) video.srcObject = null;
            return;
        }

        if (msg.type === 'session-full') {
            showOverlay(true);
            setStatus(`Session full — ${msg.reason || 'maximum players reached'}`);
            const sp2 = document.getElementById('spinner'); if (sp2) sp2.style.display = 'none';
            if (pc) { pc.close(); pc = null; }
            return;
        }
        if (msg.type === 'session-password-required') {
            // Show the styled pin screen with the session password field
            // instead of the browser's native prompt() dialog.
            const pinScreen = document.getElementById('pinScreen');
            const pinWrap = document.getElementById('pinWrap');
            const pwWrap = document.getElementById('sessionPasswordWrap');
            const pwInput = document.getElementById('sessionPasswordInput');
            const submitBtn = document.querySelector('.pin-submit-btn');
            const errEl = document.getElementById('pinErr');

            if (pinScreen && pwWrap && pwInput) {
                if (pinWrap) pinWrap.style.display = 'none';
                pwWrap.style.display = 'block';
                pinScreen.classList.remove('gone');
                if (errEl) errEl.textContent = 'This session requires a password.';
                if (submitBtn) {
                    submitBtn.textContent = 'Enter Session →';
                    submitBtn.onclick = () => submitSessionPassword();
                }
                setTimeout(() => pwInput.focus(), 80);
            }

            if (pc) { pc.close(); pc = null; }
            return;
        }
        if (msg.type === 'host-not-streaming') {
            showOverlay(true); setStatus('Host is not sharing their screen yet...');
            const sp3 = document.getElementById('spinner'); if (sp3) sp3.style.display = 'none';
            if (pc) { pc.close(); pc = null; }
            video.srcObject = null; return;
        }
        


        if (msg.type === 'ctrl-settings') {
            hostMotionEnabled = msg.enableMotion;
            window.hostAllowVR = msg.expDevices && msg.expDevices.some(d => d.enabled && d.val === 'vr');
            if (typeof maybeShowVRButton === 'function') maybeShowVRButton();
            
            if (msg.expDevices) {
                const select = document.getElementById('vInputApiSelect');
                const enabledExp = msg.expDevices.filter(d => d.enabled).map(d => d.val);

                // Restore a provisionally-cleared experimental mode if the host still allows it
                if (window._provisionalInputMode && enabledExp.includes(window._provisionalInputMode)) {
                    window.currentInputMode = window._provisionalInputMode;
                    localStorage.setItem('ns_input_mode', window.currentInputMode);
                }
                window._provisionalInputMode = null;

                // If the viewer's active mode is no longer permitted, forcibly revert to gamepad
                if (!enabledExp.includes(window.currentInputMode) && window.currentInputMode !== 'gamepad') {
                    console.log(`[InputMode] Host disabled '${window.currentInputMode}' — reverting to gamepad.`);
                    if (window.updateInputMode) window.updateInputMode('gamepad');
                    else { window.currentInputMode = 'gamepad'; localStorage.setItem('ns_input_mode', 'gamepad'); }
                }

                if (select) {
                    const currentVal = window.currentInputMode;
                    let html = '<option value="gamepad">Standard Gamepad</option>';
                    if (enabledExp.includes('guitar')) html += '<option value="guitar">Guitar Hero Controller</option>';
                    if (enabledExp.includes('hotas')) html += '<option value="hotas">Flight Stick / HOTAS / Wheel</option>';
                    if (enabledExp.includes('eye')) html += '<option value="eyetracking">Webcam Eye / Head Tracking</option>';
                    if (enabledExp.includes('tablet')) html += '<option value="tablet">Drawing Tablet (Stylus)</option>';

                    select.innerHTML = html;

                    if (Array.from(select.options).some(o => o.value === currentVal)) {
                        select.value = currentVal;
                    } else {
                        select.value = 'gamepad';
                        // Mode was already corrected above; just sync the dropdown
                    }
                }
            }
            
            const hBtn = document.getElementById('hidBtn');
            if (hBtn) hBtn.style.display = hostMotionEnabled ? 'block' : 'none';
            if (msg.touchLayout) {
                const layout = msg.touchLayout;
                const jBase = document.getElementById('jBase');
                const actionBtns = document.getElementById('actionBtns');
                const jBaseRight = document.getElementById('jBaseRight');
                const dpad = document.getElementById('dpad');
                if (jBase && actionBtns && jBaseRight && dpad) {
                    if (layout === 'rightstick') {
                        jBase.style.display = 'flex'; actionBtns.style.display = 'none'; jBaseRight.style.display = 'flex'; dpad.style.display = 'none';
                    } else if (layout === 'dpad') {
                        jBase.style.display = 'none'; actionBtns.style.display = 'flex'; jBaseRight.style.display = 'none'; dpad.style.display = 'flex';
                    } else if (layout === 'full') {
                        jBase.style.display = 'flex'; actionBtns.style.display = 'flex'; jBaseRight.style.display = 'flex'; dpad.style.display = 'flex';
                        jBase.style.transform = 'scale(0.7)'; actionBtns.style.transform = 'scale(0.7)';
                        jBaseRight.style.transform = 'scale(0.7)'; dpad.style.transform = 'scale(0.7)';
                    } else {
                        jBase.style.display = 'flex'; actionBtns.style.display = 'flex'; jBaseRight.style.display = 'none'; dpad.style.display = 'none';
                        jBase.style.transform = ''; actionBtns.style.transform = ''; jBaseRight.style.transform = ''; dpad.style.transform = '';
                    }
                }
            }
            return;
        }
        if (msg.type === 'input-state') {
            // hybrid mode = gamepad + kbm both active
            kbEnabled = !!msg.kb || msg.mode === 'hybrid';
            if (!kbEnabled && document.pointerLockElement) document.exitPointerLock();
            const hint = document.getElementById('kbmHint');
            if (hint) hint.style.display = kbEnabled ? 'inline' : 'none';
            return;
        }
        if (msg.type === 'slot-assigned') { return; } // Slot info not displayed to viewer
        if (msg.type === 'chat') { appendChat(msg.from || msg.name, msg.msg, msg.viewerId === myId, msg.platform, msg.color, msg.isHost); return; }
        if (msg.type === 'input-ack') { _onInputAck(msg.seq); return; }
        if (msg.type === 'host-voice-cmd' && msg.targetViewerId === myId) {
            if (msg.action === 'mute') {
                forceMutedByHost = true; disableMic(); updateMicButton();
                appendChat('Nearcade', 'The host has muted your microphone.', false);
            } else {
                forceMutedByHost = false; updateMicButton();
                appendChat('Nearcade', 'The host unmuted you.', false);
            }
            return;
        }
        // Stub: handle server-sent VAD feed
        if (msg.type === 'voice-activity') {
            if (typeof window.vcUpdateTalking === 'function') window.vcUpdateTalking(msg.activeSpeakers || []);
            return;
        }
        if (msg.type === 'roster') {
            if (typeof window.vcSyncRoster === 'function') window.vcSyncRoster(msg.viewers || [], myId);
            const listEl = document.getElementById('lobbyList');
            // Store roster for @mention
            window._rosterList = msg.viewers || [];
            // Phase 4: toast on newly joined viewers (skip own join / first sync)
            if (window._rosterSeen && window.pushToast && msg.viewers) {
                const fresh = msg.viewers.filter(v => !window._rosterSeen.has(v.id));
                if (fresh.length) {
                    const isSelf = fresh.length === 1 && fresh[0].id === myId;
                    if (!isSelf) {
                        const names = fresh.map(v => (v.name || 'Player').replace(/ \d+$/, '')).join(', ');
                        window.pushToast(names + (fresh.length > 1 ? ' joined the party' : ' joined the party'), { type: 'info' });
                    }
                }
            }
            window._rosterSeen = new Set((msg.viewers || []).map(v => v.id));
            if (listEl) {
                listEl.innerHTML = '';
                const seen = new Set(); let hostAdded = false;
                msg.viewers.forEach(v => {
                    const baseId = v.id.split('_')[0];
                    if (!seen.has(baseId)) {
                        seen.add(baseId);
                        if (!hostAdded) {
                            const hostItem = document.createElement('div');
                            hostItem.className = 'roster-item';
                            hostItem.innerHTML = '<span> Host</span><span class="roster-badge">Streaming</span>';
                            listEl.appendChild(hostItem);
                            hostAdded = true;
                        }
                        const isMe = baseId === myId;
                        const viewerItem = document.createElement('div');
                        viewerItem.className = 'roster-item' + (isMe ? ' roster-me' : '');
                        viewerItem.textContent = (v.name || '').replace(/ \d+$/, '') + (isMe ? ' (You)' : '');
                        listEl.appendChild(viewerItem);
                    }
                });
            }
            return;
        }
    };

    ws.onclose = (function(thisWs) {
        return function(event) {
            // If this socket is no longer the active one (connect() already replaced it),
            // do NOT schedule another reconnect — that's what causes the cascade loop.
            if (ws !== thisWs) return;

            const AUTH_CODES = new Set([4001, 4002, 4003, 4004]);
            if (AUTH_CODES.has(event.code) || stopReconnect) {
                if (event.code === 4004) {
                    // Wrong session password — show the password input, not the PIN screen
                    const pwScreen = document.getElementById('passwordScreen');
                    const pwErr = document.getElementById('passwordErr');
                    if (pwScreen) pwScreen.classList.remove('gone');
                    if (pwErr) pwErr.textContent = 'Incorrect session password.';
                } else {
                    document.getElementById('pinScreen').classList.remove('gone');
                    const errEl = document.getElementById('pinErr');
                    if (errEl) errEl.textContent = event.code === 4003 ? 'You were kicked by the host.' : event.code === 4001 ? 'Too many attempts. Wait 2 minutes.' : 'Incorrect PIN.';
                    document.getElementById('pinInput').value = '';
                }
                enteredPin = ''; enteredPassword = ''; stopReconnect = false; return;
            }
            if (window.sessionEndedByHost) {
                // Do not attempt to reconnect or show generic "Host disconnected" message
                return;
            }
            if (event.code === 1006) {
                const newHost = '127.0.0.1:' + (location.port || (location.protocol === 'https:' ? 443 : 80));
                if (wsHost !== newHost) {
                    wsHost = newHost;
                    console.warn(`[WebSocket] Falling back to ${wsHost}`);
                }
            }
            setTimeout(connect, 2000);
        };
    })(ws);
}

// pinRequired is declared early at the top of the file.
// For local (non-VPS) servers, check the HTTP API on load.
(function checkLocalPinRequirement() {
    const urlParams = new URLSearchParams(window.location.search);
    const hostParam = urlParams.get('host') || '';
    const isP2P = hostParam.startsWith('p2p://');
    
    useVps = location.hostname === 'publicnearcade.cutefame.net' || urlParams.has('v3') || urlParams.has('vps');
    
    if (isP2P) {
        // P2P rooms authenticate via the signaling room code itself. We cannot probe the
        // host beforehand, so we make the PIN field optional and defer auth to the host.
        pinRequired = false;
        const wrap = document.getElementById('pinWrap');
        if (wrap) wrap.style.display = 'none';
    } else if (!useVps) {
        // If an explicit HTTP host is provided, query its API instead of the local one
        let apiUrl = '/api/pin-required' + window.location.search;
        if (hostParam && hostParam.includes('://')) {
            apiUrl = hostParam.replace(/\/$/, '') + '/api/pin-required' + window.location.search;
        }
        
        safeApiJson(apiUrl, { required: true }).then(d => {
            pinRequired = d.required !== false;
            if (!pinRequired) {
                const wrap = document.getElementById('pinWrap');
                if (wrap) wrap.style.display = 'none';
            } else {
                // Poll every 2s in case host disables PIN while viewer is on this screen
                const pollInterval = setInterval(() => {
                    if (document.getElementById('pinScreen').classList.contains('gone')) {
                        clearInterval(pollInterval);
                        return;
                    }
                    safeApiJson(apiUrl, { required: true }).then(pollData => {
                        if (pollData.required === false) {
                            clearInterval(pollInterval);
                            pinRequired = false;
                            const wrap = document.getElementById('pinWrap');
                            if (wrap) wrap.style.display = 'none';
                            // Clear input and auto-submit
                            document.getElementById('pinInput').value = '';
                            submitPin();
                        }
                    }).catch(() => {});
                }, 2000);
            }
        });
    }
    // VPS pin state is handled by the early standby WebSocket at the top of this file.
})();

(function checkUrlPin() {
    const urlParams = new URLSearchParams(window.location.search);
    const urlPin = urlParams.get('pin');
    if (urlPin) {
        const pinInput = document.getElementById('pinInput');
        if (pinInput) pinInput.value = urlPin;
        // Small delay to ensure any async pin requirement checks have settled
        setTimeout(() => {
            if (!document.getElementById('pinScreen').classList.contains('gone')) {
                submitPin();
            }
        }, 500);
    }
})();

function submitPin() {
    const nameVal = document.getElementById('nameInput').value.trim();
    if (nameVal) { myName = nameVal; localStorage.setItem('ns_name', myName); }
    const val = document.getElementById('pinInput').value.trim();
    if (pinRequired && val.length === 0) {
        document.getElementById('pinErr').textContent = 'PIN / Password required';
        return;
    }
    enteredPin = val;
    document.getElementById('pinErr').textContent = '';
    document.getElementById('pinScreen').classList.add('gone');
    safeApiJson('/api/info', {}).then(d => {
        if (d.version) {
          const vA = String(CLIENT_VERSION).split('.')[0];
          const vB = String(d.version).split('.')[0];
          if (vA !== vB) {
            alert(`Version mismatch: Host v${d.version}, You v${CLIENT_VERSION}. Please update to match.`);
          }
        }
    }).finally(() => {
        connect();
        if (!gpPolling) activateGamepad();
        
        // Auto-fullscreen on Steam Deck after user gesture
        const isSteamDeck = navigator.userAgent.toLowerCase().includes('valve steam gamepad') || 
            (navigator.platform === 'Linux x86_64' && navigator.maxTouchPoints > 0 && screen.width === 1280 && screen.height === 800);
        if (isSteamDeck && !document.fullscreenElement) {
            document.documentElement.requestFullscreen().then(landscape).catch(() => { });
        }
    });
}

function submitSessionPassword() {
    const pwInput = document.getElementById('sessionPasswordInput');
    const errEl = document.getElementById('pinErr');
    const pw = (pwInput?.value || '').trim();
    if (!pw) { if (errEl) errEl.textContent = 'Password cannot be empty.'; return; }

    // Restore pin screen state for next time
    const pinWrap = document.getElementById('pinWrap');
    const pwWrap = document.getElementById('sessionPasswordWrap');
    const submitBtn = document.querySelector('.pin-submit-btn');
    if (pinWrap) pinWrap.style.display = '';
    if (pwWrap) pwWrap.style.display = 'none';
    if (submitBtn) { submitBtn.textContent = 'Join Stream →'; submitBtn.onclick = () => submitPin(); }
    if (errEl) errEl.textContent = '';
    document.getElementById('pinScreen')?.classList.add('gone');

    // Reconnect with password
    enteredPassword = pw;
    setTimeout(connect, 200);
}

// ── CHAT ──────────────────────────────────────────────────────────────────────
let lastChatMsg = '', lastChatTime = 0;

function platIcon(name) {
    const map = {
        'Mobile':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>',
        'Steam Deck':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152L2 17a1 1 0 0 0 1 1h2.128a1 1 0 0 0 .958-.71l.635-2.115C7.14 14.155 8.13 13.5 9.25 13.5h5.5c1.12 0 2.11.655 2.529 1.675l.635 2.115a1 1 0 0 0 .958.71H21a1 1 0 0 0 1-1l-.685-8.258A4 4 0 0 0 17.32 5z"/></svg>',
        'Windows':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
        'macOS':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
        'Linux':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
        'PC':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    };
    return map[name] || '';
}

function detectViewerPlatform() {
    const ua = navigator.userAgent;
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return 'Mobile';
    if (navigator.platform === 'Linux x86_64' && navigator.maxTouchPoints > 0 && screen.width === 1280 && screen.height === 800) return 'Steam Deck';
    if (ua.includes('Win')) return 'Windows';
    if (ua.includes('Mac')) return 'macOS';
    if (ua.includes('Linux')) return 'Linux';
    return '';
}
const viewerPlatform = detectViewerPlatform();

function appendChat(name, text, isMe, platform, color, isHost) {
    const el = document.getElementById('chatLog');
    if (isMe) {
        const now = Date.now();
        if (text === lastChatMsg && now - lastChatTime < 1000) return;
        lastChatMsg = text; lastChatTime = now;
    }
    const d = document.createElement('div');
    d.className = 'cmsg';
    if (!isMe && typeof myName !== 'undefined' && new RegExp('@' + myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) {
        d.classList.add('cmsg-mentioned');
    }
    const nameSpan = document.createElement('span');
    nameSpan.className = 'cname' + (isMe ? ' me' : '');
    
    let isMeCmd = false;
    if (text.startsWith('/me ')) {
        isMeCmd = true;
        text = text.substring(4);
    }
    
    nameSpan.textContent = name;
    if (color) nameSpan.style.color = color;
    if (platform) {
        const platBadge = document.createElement('span');
        platBadge.className = 'plat-badge';
        platBadge.innerHTML = platIcon(platform) || platform;
        nameSpan.appendChild(platBadge);
    }
    if (!isMe && isHost) {
        const hostBadge = document.createElement('span');
        hostBadge.className = 'plat-badge';
        hostBadge.textContent = 'HOST';
        hostBadge.style.cssText = 'font-size:8px;font-weight:700;letter-spacing:0.1em;color:var(--accent);opacity:0.7;margin-left:4px;vertical-align:middle;';
        nameSpan.appendChild(hostBadge);
    }
    nameSpan.appendChild(document.createTextNode(isMeCmd ? ' ' : ': '));
    d.appendChild(nameSpan);
    
    const msgSpan = document.createElement('span');
    msgSpan.textContent = text;
    if (isMeCmd) msgSpan.style.fontStyle = 'italic';
    d.appendChild(msgSpan);
    
    el.appendChild(d); el.scrollTop = el.scrollHeight;
}

const VIEWER_EMOJI_CATS = (window.EMOJI_DATA || []).length ? window.EMOJI_DATA : [];
function injectViewerEmojiPicker() {
    const chatRow = document.querySelector('#chatInput');
    if (!chatRow || document.getElementById('emojiPicker')) return;
    const style = document.createElement('style');
    style.textContent = '#emojiPicker{display:none}#emojiPicker.show{display:flex;flex-direction:column}#emojiPicker .picker-body{flex:1;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;-ms-overflow-style:none}#emojiPicker .picker-body::-webkit-scrollbar{display:none}#emojiPicker .cat-tabs{display:flex;gap:2px;padding:4px 2px 2px;flex-shrink:0;border-top:1px solid #333;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none}#emojiPicker .cat-tabs::-webkit-scrollbar{display:none}#emojiPicker .cat-tab{background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px;border-radius:4px;color:#888;line-height:1;flex-shrink:0;opacity:0.4;transition:opacity 0.15s;display:flex;align-items:center}#emojiPicker .cat-tab.active{opacity:1;color:#fff;background:#333}#emojiPicker .cat-tab:hover{opacity:0.8}#emojiPicker .cat-page{display:none;flex-wrap:wrap;gap:2px;padding:4px 2px}#emojiPicker .cat-page.active{display:flex}#emojiPicker button:not(.cat-tab){background:none;border:none;cursor:pointer;font-size:20px;padding:2px 4px;border-radius:4px;color:#fff;line-height:1}#emojiPicker button:not(.cat-tab):hover{background:#333;transform:scale(1.15)}';
    document.head.appendChild(style);
    const pickerBtn = document.createElement('button');
    pickerBtn.id = 'emojiPickerBtn';
    const faceEmojis = ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😒','🙃','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥴','😵','🤯','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😤','😡','😠','🤬'];
    pickerBtn.textContent = faceEmojis[Math.floor(Math.random() * faceEmojis.length)];
    pickerBtn.type = 'button';
    pickerBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:18px;padding:4px 6px;line-height:1;opacity:0.5;transition:opacity 0.15s';
    pickerBtn.title = 'Insert emoji';
    pickerBtn.onmouseenter = () => pickerBtn.style.opacity = '1';
    pickerBtn.onmouseleave = () => { if (!picker.classList.contains('show')) pickerBtn.style.opacity = '0.5'; };
    const picker = document.createElement('div');
    picker.id = 'emojiPicker';
    picker.className = 'show';
    picker.style.cssText = 'position:absolute;bottom:100%;left:0;background:#1a1d23;border:1px solid #333;border-radius:8px;width:300px;max-height:260px;z-index:9999';
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'picker-body';
    picker.appendChild(bodyDiv);
    const tabsDiv = document.createElement('div');
    tabsDiv.className = 'cat-tabs';
    picker.appendChild(tabsDiv);
    VIEWER_EMOJI_CATS.forEach((cat, ci) => {
        const tab = document.createElement('button');
        tab.className = 'cat-tab' + (ci === 0 ? ' active' : '');
        tab.textContent = cat.label;
        tab.type = 'button';
        tab.title = cat.name;
        const page = document.createElement('div');
        page.className = 'cat-page' + (ci === 0 ? ' active' : '');
        cat.items.forEach(e => {
            const btn = document.createElement('button');
            btn.textContent = e; btn.type = 'button';
            btn.onclick = () => {
                const inp = document.getElementById('chatMsg');
                if (inp) { inp.value += e; inp.focus(); }
                picker.className = 'show';
            };
            page.appendChild(btn);
        });
        tab.onclick = () => {
            tabsDiv.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            bodyDiv.querySelectorAll('.cat-page').forEach(p => p.classList.remove('active'));
            page.classList.add('active');
        };
        tabsDiv.appendChild(tab);
        bodyDiv.appendChild(page);
    });
    pickerBtn.onclick = () => {
        const isOpen = picker.classList.contains('show');
        picker.className = isOpen ? '' : 'show';
    };
    document.addEventListener('click', (ev) => {
        if (!picker.contains(ev.target) && ev.target !== pickerBtn) picker.className = '';
    });
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;display:inline-flex';
    wrapper.appendChild(pickerBtn);
    wrapper.appendChild(picker);
    chatRow.insertBefore(wrapper, chatRow.firstChild);
    picker.className = ''; // start hidden
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectViewerEmojiPicker);
} else {
    injectViewerEmojiPicker();
}
const chatHistory = [];
let chatHistoryIndex = -1;
// ── @MENTION AUTOCOMPLETE ──
let _mentionData = { items: [], idx: -1, type: '' };
function _showAutocompleteDropdown(inp) {
    const val = inp.value;
    const cursor = inp.selectionStart;
    const before = val.slice(0, cursor);

    if (val.startsWith('/') && before.lastIndexOf('/') === 0) {
        const partial = before.slice(1).toLowerCase();
        const commands = [
            { id: '/me', name: '/me [action]', desc: 'Act out an action' },
            { id: '/shrug', name: '/shrug', desc: '¯\\_(ツ)_/¯' },
            { id: '/tableflip', name: '/tableflip', desc: '(╯°□°)╯︵ ┻━┻' },
            { id: '/unflip', name: '/unflip', desc: '┬─┬ノ( º _ ºノ)' },
            { id: '/dance', name: '/dance', desc: 'Starts dancing' },
            { id: '/roll', name: '/roll [max]', desc: 'Roll a random number' }
        ];
        const known = commands.filter(c => c.name.toLowerCase().startsWith('/' + partial) || partial === '');
        if (known.length === 0) { _hideAutocompleteDropdown(); return; }
        _mentionData.items = known;
        _mentionData.idx = 0;
        _mentionData.type = 'cmd';
        _renderAutocomplete(inp, known, 'cmd');
        return;
    }

    const atIdx = before.lastIndexOf('@');
    if (atIdx === -1 || (atIdx > 0 && val[atIdx - 1] !== ' ' && val[atIdx - 1] !== '\n')) { _hideAutocompleteDropdown(); return; }
    const partial = before.slice(atIdx + 1).toLowerCase();
    const roster = typeof window._rosterList !== 'undefined' ? window._rosterList : [];
    let known = roster.map(v => ({ id: v.id, name: (v.name || '').replace(/ \d+$/, '') })).filter(v => v.name.toLowerCase().includes(partial));
    if (partial === '' || (known.length === 0 && 'host'.includes(partial))) known = [{ id: 'HOST', name: 'Host' }, ...known];
    if (known.length === 0) { _hideAutocompleteDropdown(); return; }
    _mentionData.items = known;
    _mentionData.idx = 0;
    _mentionData.type = 'mention';
    _renderAutocomplete(inp, known, 'mention');
}

function _renderAutocomplete(inp, known, type) {
    let dd = document.getElementById('mentionDD');
    if (!dd) {
        dd = document.createElement('div');
        dd.id = 'mentionDD';
        dd.style.cssText = 'position:absolute;bottom:100%;left:0;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:4px;z-index:99999;max-height:140px;overflow-y:auto;min-width:180px';
        const wrapper = document.querySelector('.chat-input-row') || inp.parentElement;
        wrapper?.appendChild(dd);
    }
    dd.innerHTML = known.map((v, i) => {
        let text = v.name;
        if (type === 'cmd') text = `<span style="color:var(--accent);font-weight:bold;">${v.name}</span><br><span style="color:var(--muted);font-size:10px;">${v.desc}</span>`;
        return `<div class="m-item" data-idx="${i}" style="padding:4px 8px;cursor:pointer;border-radius:4px;font-size:13px;color:var(--text);${i === 0 ? 'background:var(--accent-dim);color:var(--accent);' : ''}" onmouseover="document.querySelectorAll('.m-item').forEach(e=>e.style.cssText='padding:4px 8px;cursor:pointer;border-radius:4px;font-size:13px;color:var(--text);');this.style.cssText='padding:4px 8px;cursor:pointer;border-radius:4px;font-size:13px;background:var(--accent-dim);color:var(--accent);';_mentionData.idx=${i}" onclick="const inp=document.getElementById('chatMsg');const v=inp.value;const cs=inp.selectionStart; if ('${type}'==='cmd'){ inp.value='${v.id} '; inp.focus(); } else { const bf=v.slice(0,v.lastIndexOf('@',cs));const af=v.slice(cs);const mention='@${v.name} ';const nv=bf+mention+af;inp.value=nv;inp.selectionStart=inp.selectionEnd=bf.length+mention.length;inp.focus(); } document.getElementById('mentionDD')?.remove();">${text}</div>`;
    }).join('');
    dd.style.display = 'block';
}

function _hideAutocompleteDropdown() { const dd = document.getElementById('mentionDD'); if (dd) dd.style.display = 'none'; _mentionData.idx = -1; }
document.addEventListener('keydown', e => {
    const dd = document.getElementById('mentionDD');
    if (dd && dd.style.display !== 'none') {
        if (e.key === 'ArrowDown') { e.preventDefault(); _mentionData.idx = Math.min(_mentionData.idx + 1, _mentionData.items.length - 1); const items = dd.querySelectorAll('.m-item'); items.forEach((el,i)=>el.style.cssText=i===_mentionData.idx?'padding:4px 8px;cursor:pointer;border-radius:4px;font-size:13px;background:var(--accent-dim);color:var(--accent);':'padding:4px 8px;cursor:pointer;border-radius:4px;font-size:13px;color:var(--text);'); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); _mentionData.idx = Math.max(_mentionData.idx - 1, 0); const items = dd.querySelectorAll('.m-item'); items.forEach((el,i)=>el.style.cssText=i===_mentionData.idx?'padding:4px 8px;cursor:pointer;border-radius:4px;font-size:13px;background:var(--accent-dim);color:var(--accent);':'padding:4px 8px;cursor:pointer;border-radius:4px;font-size:13px;color:var(--text);'); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const sel = dd.querySelector('.m-item[data-idx="'+_mentionData.idx+'"]'); if (sel) sel.click(); return; }
        if (e.key === 'Escape') { _hideAutocompleteDropdown(); return; }
    }
    if (e.target.id !== 'chatMsg') return;
    const inp = e.target;
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (chatHistory.length === 0) return;
        chatHistoryIndex = Math.max(0, chatHistoryIndex - 1);
        inp.value = chatHistory[chatHistoryIndex];
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        chatHistoryIndex = Math.min(chatHistory.length, chatHistoryIndex + 1);
        inp.value = chatHistoryIndex < chatHistory.length ? chatHistory[chatHistoryIndex] : '';
    }
});
document.addEventListener('keyup', e => {
    if (e.target.id === 'chatMsg') _showAutocompleteDropdown(e.target);
});
document.addEventListener('input', e => {
    if (e.target.id === 'chatMsg') _showAutocompleteDropdown(e.target);
});
function sendChat() {
    const inp = document.getElementById('chatMsg');
    let msg = inp.value.trim();
    if (!msg || !ws || ws.readyState !== 1) return;
    
    if (msg === '/shrug') msg = '¯\\_(ツ)_/¯';
    else if (msg === '/tableflip') msg = '(╯°□°)╯︵ ┻━┻';
    else if (msg === '/unflip') msg = '┬─┬ノ( º _ ºノ)';
    else if (msg === '/dance') msg = '/me starts dancing! 💃🕺';
    else if (msg.startsWith('/roll')) {
        let max = parseInt(msg.split(' ')[1]) || 100;
        let num = Math.floor(Math.random() * max) + 1;
        msg = `/me rolls a ${num} (out of ${max})`;
    }
        const _chatClr = localStorage.getItem('ns_chat_color') || '';
    ws.send(JSON.stringify({ type: 'chat', from: myName, msg, platform: viewerPlatform, color: _chatClr }));
    appendChat(myName, msg, true, viewerPlatform, _chatClr);
    chatHistory.push(msg);
    chatHistoryIndex = chatHistory.length;
    inp.value = '';
    _hideAutocompleteDropdown();
}
function toggleChat() {
    const panel = document.getElementById('chatPanel');
    const bar = document.getElementById('nsBar');
    const container = document.getElementById('video-container');
    let open = false;
    if (panel) {
        panel.classList.toggle('open');
        open = panel.classList.contains('open');
    }
    if (bar) bar.classList.remove('open');
    
    const pushStream = !window.wcDecoder;
    if (container) container.classList.toggle('party-chat', open && pushStream);
    
    window.pushPartyState && window.pushPartyState();
}
function toggleAudio() {
    audioMuted = !audioMuted;
    if (video.srcObject) video.srcObject.getAudioTracks().forEach(t => t.enabled = !audioMuted);
    const audioEl = document.getElementById('remote-audio');
    if (audioEl && audioEl.srcObject) audioEl.srcObject.getAudioTracks().forEach(t => t.enabled = !audioMuted);
    const btn = document.getElementById('audBtn');
    if (btn) {
        btn.textContent = audioMuted ? 'Stream Audio: OFF' : 'Stream Audio';
        btn.classList.toggle('ns-btn-danger', audioMuted);
        btn.classList.toggle('ns-btn-active', !audioMuted);
    }
}

// ── WAKE LOCK ─────────────────────────────────────────────────────────────────
let wakeLock = null;
async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { if (document.visibilityState === 'visible') acquireWakeLock(); });
    } catch { }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acquireWakeLock(); });
acquireWakeLock();

// ── STATS HUD ─────────────────────────────────────────────────────────────────
const statsHud = document.getElementById('statsHud');
let prevBytesReceived = 0, prevStatsTime = 0, prevJitterDelay = 0, prevEmitted = 0;
let _prevPacketsLost = 0;
let _keyframeCooldown = false;
async function updateStats() {
    if (!pc) return;
    try {
        const stats = await pc.getStats();
            let rtt = null, jitter = null, kbps = null, packetsLost = 0, packetsReceived = 0;
        for (const r of stats.values()) {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null)
                rtt = (r.currentRoundTripTime * 1000).toFixed(0);
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
                if (r.frameWidth && r.frameHeight) window._hudResolution = r.frameWidth + 'x' + r.frameHeight;
                if (r.codecId) {
                    const codecStat = stats.get(r.codecId);
                    if (codecStat && codecStat.mimeType) window._hudCodec = codecStat.mimeType.split('/')[1];
                }
                
                packetsLost = r.packetsLost || 0;
                packetsReceived = r.packetsReceived || 1;
                // #4: request keyframe on any new packet loss (with 500ms cooldown)
                const deltaLoss = packetsLost - _prevPacketsLost;
                if (deltaLoss > 0 && !_keyframeCooldown) {
                    _keyframeCooldown = true;
                    requestKeyframeFromHost();
                    setTimeout(() => { _keyframeCooldown = false; }, 500);
                }
                _prevPacketsLost = packetsLost;
                if (prevStatsTime) {
                    const eDelta = (r.jitterBufferEmittedCount || 1) - prevEmitted;
                    if (eDelta > 0) jitter = (((r.jitterBufferDelay || 0) - prevJitterDelay) / eDelta * 1000).toFixed(0);
                    kbps = (((r.bytesReceived - prevBytesReceived) * 8) / ((r.timestamp - prevStatsTime) / 1000) / 1000).toFixed(0);
                    prevBytesReceived = r.bytesReceived; prevStatsTime = r.timestamp;
                    prevJitterDelay = r.jitterBufferDelay || 0; prevEmitted = r.jitterBufferEmittedCount || 1;
                } else {
                    prevBytesReceived = r.bytesReceived; prevStatsTime = r.timestamp;
                    prevJitterDelay = r.jitterBufferDelay || 0; prevEmitted = r.jitterBufferEmittedCount || 1;
                }
            }
        }
        if (rtt !== null) {

            // ── Quality tier from RTT + packet loss ──────────────────────────
            const rttN = parseInt(rtt);
            const lossRatio = packetsReceived > 0 ? (packetsLost / (packetsLost + packetsReceived)) * 100 : 0;

            // Phase 8: traffic-light network dot
            if (window.updateNetworkDot) {
                if (rttN < 80 && lossRatio < 4) window.updateNetworkDot('good');
                else if (rttN < 220 && lossRatio < 14) window.updateNetworkDot('mid');
                else window.updateNetworkDot('bad');
            }

            let bars, colour;
            if (rttN < 40 && lossRatio < 1) { bars = '▪▪▪▪'; colour = '#4ade80'; } // excellent — green
            else if (rttN < 80 && lossRatio < 3) { bars = '▪▪▪○'; colour = '#a3e635'; } // good — lime
            else if (rttN < 140 && lossRatio < 6) { bars = '▪▪○○'; colour = '#facc15'; } // fair — yellow
            else if (rttN < 220 && lossRatio < 12) { bars = '▪○○○'; colour = '#fb923c'; } // poor — orange
            else { bars = '○○○○'; colour = '#f87171'; } // bad  — red

            const parts = [
                `<span style="color:${colour};letter-spacing:1px">${bars}</span>`,
                `<span style="color:${colour}">${rtt}ms</span>`,
            ];
            if (jitter) parts.push(`${jitter}ms buf`);
            if (kbps) parts.push(`${kbps}kbps`);

            statsHud.innerHTML = parts.join(' <span style="opacity:0.4">·</span> ');
        }
    } catch { }
}
setInterval(updateStats, 500);

// ── LOW-LATENCY ENFORCEMENT: Proactive buffer drain ──
// Runs every 500ms. Uses jitterBufferTarget + playoutDelayHint to force the
// browser's WebRTC stack to minimize the jitter buffer. playbackRate acts as
// a secondary mechanism when the browser ignores the hints.
let _prevJitterBufMs = 0;
setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') return;
    // Force minimum jitter buffer on all video receivers
    pc.getReceivers().forEach(r => {
        if (r.track?.kind !== 'video') return;
        try {
            if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
            if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0;
        } catch (_) {}
    });
    // Measure buffer and adjust playback rate as secondary drain mechanism
    try {
        const stats = await pc.getStats();
        for (const r of stats.values()) {
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
                const emitted = r.jitterBufferEmittedCount || 1;
                const delay = r.jitterBufferDelay || 0;
                const bufMs = (delay / emitted) * 1000;
                const videoEl = document.getElementById('video');
                if (videoEl && !videoEl.paused) {
                    if (bufMs < 5) videoEl.playbackRate = 1.0;
                    else if (bufMs < 15) videoEl.playbackRate = 1.02;
                    else if (bufMs < 30) videoEl.playbackRate = 1.08;
                    else if (bufMs < 50) videoEl.playbackRate = 1.15;
                    else videoEl.playbackRate = 1.5;
                }
                // #4: request keyframe on any jitter buffer growth, not just >40ms
                if (bufMs > CONGESTION_KEYFRAME_THRESHOLD_MS && bufMs > _prevJitterBufMs + 5) {
                    requestKeyframeFromHost();
                }
                _prevJitterBufMs = bufMs;
            }
        }
    } catch (_) {}
}, 500);

// ── #2: VIEWER-SIDE CURSOR PREDICTION ─────────────────────────────────────────
// Applies mouse delta to a local overlay instantly, snap-corrects on server echo.
let _cursorPredict = { x: 0, y: 0, active: false };
function initCursorPrediction() {
    const overlay = document.createElement('div');
    overlay.id = 'cursor-predict';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;pointer-events:none;display:none;';
    document.body.appendChild(overlay);
    const dot = document.createElement('div');
    dot.style.cssText = 'position:absolute;width:20px;height:20px;border:2px solid rgba(255,255,255,0.8);border-radius:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,0.15);';
    overlay.appendChild(dot);
    
    // Patch mousemove to predict locally + send
    const origSend = sendInputData;
    document.addEventListener('mousemove', (e) => {
        if (!_cursorPredict.active) return;
        const dx = e.movementX || 0;
        const dy = e.movementY || 0;
        // Apply to overlay immediately
        _cursorPredict.x += dx;
        _cursorPredict.y += dy;
        dot.style.left = _cursorPredict.x + 'px';
        dot.style.top = _cursorPredict.y + 'px';
        overlay.style.display = 'block';
    });
    
    // Listen for server position echo to snap-correct
    const origOnMsg = window.onmessage;
    window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'cursor-sync') {
            _cursorPredict.x = e.data.x;
            _cursorPredict.y = e.data.y;
            dot.style.left = _cursorPredict.x + 'px';
            dot.style.top = _cursorPredict.y + 'px';
        }
    });
    
    // Toggle on/off based on input mode
    const observer = new MutationObserver(() => {
        const isKbm = document.querySelector('.kbm-mode') !== null;
        _cursorPredict.active = isKbm;
        overlay.style.display = isKbm ? 'block' : 'none';
    });
    observer.observe(document.body, { childList: true, subtree: true });
}
document.addEventListener('DOMContentLoaded', initCursorPrediction);

// ── GAMEPAD PREDICTION ─────────────────────────────────────────────────────────
// Shows button presses on a local overlay instantly (no wait for server echo).
let _gpPredictEl = null;
let _gpPredictBtns = [];

function initGamepadPrediction() {
    _gpPredictEl = document.createElement('div');
    _gpPredictEl.id = 'gp-predict';
    _gpPredictEl.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:9998;display:none;gap:6px;align-items:center;padding:8px 14px;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.08);border-radius:10px;';
    _gpPredictEl.style.display = 'none';

    const labels = ['◀','▶','▲','▼','LB','RB','LT','RT','A','B','X','Y','Back','Start'];
    const ids    = [14,  15,  12,  13,  4,   5,   6,   7,   0,  1,  2,  3,  8,    9    ];
    for (let i = 0; i < ids.length; i++) {
        const btn = document.createElement('span');
        btn.textContent = labels[i];
        btn.style.cssText = 'padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;font-family:sans-serif;color:rgba(255,255,255,0.3);background:rgba(255,255,255,0.04);transition:color 0.05s,background 0.05s,box-shadow 0.05s;';
        _gpPredictEl.appendChild(btn);
        _gpPredictBtns[ids[i]] = btn;
    }

    document.body.appendChild(_gpPredictEl);
    const obs = new MutationObserver(() => {
        const gpConnected = navigator.getGamepads ? Array.from(navigator.getGamepads()).some(g => g && g.connected) : false;
        _gpPredictEl.style.display = (gpConnected && window.kbmHintEnabled) ? 'flex' : 'none';
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Show on first gamepad connect
    window.addEventListener('gamepadconnected', () => { if (window.kbmHintEnabled) _gpPredictEl.style.display = 'flex'; });
    window.addEventListener('gamepaddisconnected', () => {
        const still = navigator.getGamepads ? Array.from(navigator.getGamepads()).some(g => g && g.connected) : false;
        if (!still) _gpPredictEl.style.display = 'none';
    });
}

// Patch pollGamepad to update overlay immediately
const _origPoll = pollGamepad;
pollGamepad = function() {
    _origPoll();
    if (!_gpPredictEl || _gpPredictEl.style.display === 'none') return;
    for (const gp of navigator.getGamepads()) {
        if (!gp || !gp.connected) continue;
        for (let i = 0; i < 16; i++) {
            const el = _gpPredictBtns[i];
            if (!el) continue;
            const pressed = gp.buttons[i]?.pressed || false;
            const val = gp.buttons[i]?.value || 0;
            if (pressed || val > 0.1) {
                el.style.color = '#fff';
                el.style.background = 'rgba(192,132,252,0.5)';
                el.style.boxShadow = '0 0 10px rgba(192,132,252,0.4)';
            } else {
                el.style.color = 'rgba(255,255,255,0.25)';
                el.style.background = 'rgba(255,255,255,0.04)';
                el.style.boxShadow = 'none';
            }
        }
        break; // Only show first gamepad
    }
};

document.addEventListener('DOMContentLoaded', initGamepadPrediction);

// ── LATENCY OVERLAY ───────────────────────────────────────────────────────────
// Shows ping, frame rate, and packet loss in the viewer info panel.
let _latencyOverlayEl = null;

function initLatencyOverlay() {
    _latencyOverlayEl = document.createElement('div');
    _latencyOverlayEl.id = 'latency-overlay';
    _latencyOverlayEl.style.cssText = 'position:fixed;top:12px;right:12px;z-index:9997;display:none;padding:8px 12px;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.08);border-radius:8px;font-family:sans-serif;font-size:10px;color:rgba(255,255,255,0.7);line-height:1.6;pointer-events:none;';
    _latencyOverlayEl.innerHTML = 'Ping: —<br>FPS: —<br>Jitter: —<br>Path: —';
    document.body.appendChild(_latencyOverlayEl);

    let pingSent = 0;
    let pingPath = '';
    let lastRtt = 0;
    let frames = 0;
    let lastFpsCheck = performance.now();
    let frameTimes = [];
    let prevFrameTime = 0;

    // Ping over DataChannel first (true game path), fallback to WebSocket
    function sendPing() {
        const dc = window._fastLaneChannel;
        if (dc && dc.readyState === 'open') {
            pingPath = 'P2P';
            pingSent = performance.now();
            try { dc.send(JSON.stringify({ type: 'ping' })); return; } catch {}
        }
        if (ws && ws.readyState === 1) {
            pingPath = 'Relay';
            pingSent = performance.now();
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }

    setInterval(sendPing, 3000);

    function trackFrame() {
        frames++;
        const now = performance.now();
        if (prevFrameTime > 0) {
            frameTimes.push(now - prevFrameTime);
            if (frameTimes.length > 60) frameTimes.shift();
        }
        prevFrameTime = now;
    }

    window._trackViewerFrame = trackFrame;

    function onPong() {
        if (pingSent) {
            lastRtt = performance.now() - pingSent;
            pingSent = 0;
        }
    }

    function updateLatencyDisplay() {
        const now = performance.now();
        const dt = now - lastFpsCheck;
        if (dt < 1000) return;
        const fps = Math.round(frames / (dt / 1000));
        frames = 0;
        lastFpsCheck = now;

        const jitter = frameTimes.length > 2
            ? Math.round(Math.sqrt(frameTimes.reduce((s, t) => s + (t - frameTimes.reduce((a,b) => a+b, 0)/frameTimes.length) ** 2, 0) / frameTimes.length))
            : 0;
        frameTimes = [];

        const pingColor = lastRtt < 50 ? '#4ade80' : lastRtt < 100 ? '#facc15' : '#f87171';
        _latencyOverlayEl.innerHTML = 'Ping: <span style="color:' + pingColor + ';font-weight:600;">' + (lastRtt ? Math.round(lastRtt) + 'ms' : '—') + '</span>'
            + '<br>FPS: <span style="font-weight:600;">' + fps + '</span>'
            + '<br>Jitter: <span style="font-weight:600;">' + jitter + 'ms</span>'
            + '<br>Path: <span style="font-weight:600;">' + pingPath + '</span>';
    }

    // Update display continuously
    function _latencyLoop() { updateLatencyDisplay(); requestAnimationFrame(_latencyLoop); }
    requestAnimationFrame(_latencyLoop);
}

document.addEventListener('DOMContentLoaded', initLatencyOverlay);

// ── FULLSCREEN ────────────────────────────────────────────────────────────────
function landscape() { if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => { }); }
function toggleFS() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().then(landscape).catch(() => { });
    } else { document.exitFullscreen(); }
}
document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) landscape();
    const btn = document.getElementById('fsBtn');
    if (btn) {
        btn.textContent = document.fullscreenElement ? 'Exit Full Screen' : 'Full Screen';
        btn.classList.toggle('ns-btn-active', !!document.fullscreenElement);
    }
});

// ── RUMBLE ────────────────────────────────────────────────────────────────────
let clientRumbleEnabled = localStorage.getItem('ns_rumble') !== 'false';
function toggleClientRumble() {
    clientRumbleEnabled = !clientRumbleEnabled;
    localStorage.setItem('ns_rumble', clientRumbleEnabled);
    const toggle = document.getElementById('vRumbleToggle');
    if (toggle) toggle.classList.toggle('on', clientRumbleEnabled);
}
document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('vRumbleToggle');
    if (toggle) toggle.classList.toggle('on', clientRumbleEnabled);
});

// ── WEBCODECS FRAME HEALTH MONITOR ──
// Detects black screen, frozen stream, and decoder stalls.
// Reports issues to host; auto-fallbacks to standard WebRTC after repeated failures.
let _wcHealth = {
    lastFrameTime: 0,
    frameCount: 0,
    consecutiveBlackFrames: 0,
    criticalFailures: 0,
    maxCriticalFailures: 2,
    intervals: [],
};

function _startWcHealthMonitor() {
    _stopWcHealthMonitor();
    if (!_wcHealth._origTrackFrame) _wcHealth._origTrackFrame = window._trackViewerFrame;
    window._trackViewerFrame = function () {
        if (_wcHealth._origTrackFrame) _wcHealth._origTrackFrame();
        _wcHealth.lastFrameTime = performance.now();
        _wcHealth.frameCount++;
    };

    _wcHealth.intervals.push(setInterval(() => {
        if (!wcDecoder || wcDecoder.state !== 'configured') return;
        const elapsed = performance.now() - _wcHealth.lastFrameTime;
        if (elapsed > 5000 && _wcHealth.lastFrameTime > 0) {
            console.warn(`[WcHealth] Frozen — ${Math.round(elapsed)}ms no frames`);
            _reportWcHealth('frozen', { elapsed });
        }
    }, 3000));

    _wcHealth.intervals.push(setInterval(() => {
        if (!wcCanvas || !wcCtx || _wcHealth.frameCount < 10) return;
        try {
            let r = 0, g = 0, b = 0, a = 255;
            const cx = wcCanvas.width >> 1, cy = wcCanvas.height >> 1;
            if (typeof wcCtx.getImageData === 'function') {
                const px = wcCtx.getImageData(cx, cy, 1, 1);
                r = px.data[0]; g = px.data[1]; b = px.data[2]; a = px.data[3];
            } else if (typeof wcCtx.readPixels === 'function') {
                const px = new Uint8Array(4);
                wcCtx.readPixels(cx, cy, 1, 1, wcCtx.RGBA, wcCtx.UNSIGNED_BYTE, px);
                r = px[0]; g = px[1]; b = px[2]; a = px[3];
            } else return;
            if (r < 5 && g < 5 && b < 5 && a > 0) {
                _wcHealth.consecutiveBlackFrames++;
                if (_wcHealth.consecutiveBlackFrames >= 3) {
                    console.warn('[WcHealth] Black screen detected');
                    _reportWcHealth('black-screen', { consecutive: _wcHealth.consecutiveBlackFrames });
                }
            } else {
                _wcHealth.consecutiveBlackFrames = 0;
            }
        } catch (_) {}
    }, 3000));

    _wcHealth.intervals.push(setInterval(() => {
        _reportWcHealth('telemetry', {
            fps: _wcHealth.frameCount > 0 ? Math.round(_wcHealth.frameCount / 6) : 0,
            decoderState: wcDecoder?.state || 'none',
        });
        _wcHealth.frameCount = 0;
    }, 6000));
}

function _stopWcHealthMonitor() {
    _wcHealth.intervals.forEach(id => clearInterval(id));
    _wcHealth.intervals = [];
    _wcHealth.criticalFailures = 0;
    if (_wcHealth._origTrackFrame) {
        window._trackViewerFrame = _wcHealth._origTrackFrame;
        _wcHealth._origTrackFrame = null;
    }
}

function _reportWcHealth(type, data) {
    const payload = { type: 'webcodecs-health', wcHealthType: type, wcHealthData: data };
    if (typeof myId !== 'undefined') payload.viewerId = myId;
    try { if (window.wcChannel?.readyState === 'open') wcChannel.send(JSON.stringify(payload)); } catch (_) {}
    try { if (ws?.readyState === 1) ws.send(JSON.stringify(payload)); } catch (_) {}
    if (type === 'frozen') {
        _wcHealth.criticalFailures++;
        if (_wcHealth.criticalFailures >= _wcHealth.maxCriticalFailures) {
            console.warn('[WcHealth] Critical — falling back to standard WebRTC');
            _stopWcHealthMonitor();
            try { if (wcDecoder?.state !== 'closed') wcDecoder.close(); } catch (_) {}
            wcDecoder = null;
            _reportWcHealth('fallback-request', { reason: type });
            const url = new URL(window.location.href);
            url.searchParams.delete('wc');
            url.searchParams.delete('wc2');
            setTimeout(() => { window.location.href = url.href; }, 1000);
        }
    }
}

// ── WEBCODECS VIEWER INITIALIZER ──
let _pendingWcFrame = null;
let _wcRenderLoopId = null;

function _wcRenderLoop() {
    if (!wcDecoder) {
        _wcRenderLoopId = null;
        if (_pendingWcFrame) { _pendingWcFrame.close(); _pendingWcFrame = null; }
        return;
    }
    
    _wcRenderLoopId = requestAnimationFrame(_wcRenderLoop);
    
    if (_pendingWcFrame) {
        const frame = _pendingWcFrame;
        _pendingWcFrame = null;
        
        // BUG 2/5 FIX: Use hardware codedWidth, and re-acquire the context after resize!
        if (wcCanvas.width !== frame.codedWidth || wcCanvas.height !== frame.codedHeight) {
            wcCanvas.width = frame.codedWidth;
            wcCanvas.height = frame.codedHeight;
            if (wcCtx && wcGlTexture) wcCtx.viewport(0, 0, wcCanvas.width, wcCanvas.height);
        }
        
        let handledByUpscaler = false;
        // GPU path (WebGPU) — highest priority
        if (_gpuUpscalerInstance && window._gpuCanvas) {
            const gpuC = window._gpuCanvas;
            if (gpuC.width !== frame.codedWidth || gpuC.height !== frame.codedHeight) {
                _updateUpscaleCanvasSize(frame.codedWidth, frame.codedHeight);
                gpuC.width  = upscalerCanvas ? upscalerCanvas.width  : frame.codedWidth;
                gpuC.height = upscalerCanvas ? upscalerCanvas.height : frame.codedHeight;
            }
            gpuC.style.display = 'block';
            wcCanvas.style.opacity = '0';
            _gpuUpscalerInstance.setMode(_upscaleMode > 0 ? _upscaleMode : 1);
            _gpuUpscalerInstance.uploadAndDraw(frame);
            handledByUpscaler = true;
        // WebGL fallback path
        } else if (_upscaleMode > 0 && _webglSupported && window.upscalerInstance && upscalerCanvas) {
            _updateUpscaleCanvasSize(frame.codedWidth, frame.codedHeight);
            upscalerCanvas.style.display = 'block';
            wcCanvas.style.opacity = '0';
            window.upscalerInstance.uploadAndDraw(frame);
            handledByUpscaler = true;
        } else {
            if (upscalerCanvas) upscalerCanvas.style.display = 'none';
            wcCanvas.style.opacity = '1';
        }
        
        if (!handledByUpscaler) {
            if (wcCtx && wcGlTexture) {
                if (_applyUpscaleFilter && (_lastAppliedUpscale === null || document.body.classList.contains('pixel-mode') !== (_upscaleMode === 2))) {
                    _applyUpscaleFilter();
                }
                wcCtx.activeTexture(wcCtx.TEXTURE0);
                wcCtx.bindTexture(wcCtx.TEXTURE_2D, wcGlTexture);
                wcCtx.texImage2D(wcCtx.TEXTURE_2D, 0, wcCtx.RGBA, wcCtx.RGBA, wcCtx.UNSIGNED_BYTE, frame);
                wcCtx.drawArrays(wcCtx.TRIANGLE_STRIP, 0, 4);
            } else if (wcCtx) {
                wcCtx.drawImage(frame, 0, 0, wcCanvas.width, wcCanvas.height);
            }
        }
        frame.close();
        if (window._trackViewerFrame) window._trackViewerFrame();
    }
}

function initWebCodecsViewer(config) {
    if (typeof VideoDecoder === 'undefined') {
        console.warn('[WebCodecs] VideoDecoder API is not available (likely an insecure HTTP context). Falling back to standard WebRTC.');
        return;
    }

    console.log('[WebCodecs] Received Host Configuration:', config);

    const videoEl = document.getElementById('video');
    if (videoEl) videoEl.style.display = 'none';
    const frameCanvas = document.getElementById('frameCanvas');
    if (frameCanvas) frameCanvas.style.display = 'none';

    if (typeof showOverlay === 'function') showOverlay(false);
    const spinner = document.getElementById('spinner');
    if (spinner) spinner.style.display = 'none';

    if (!wcCanvas) {
        wcCanvas = document.createElement('canvas');
        wcCanvas.id = 'webcodecs-canvas';
        // Add CSS so the stream scales to fit the viewport instead of overflowing
        wcCanvas.style.cssText = 'width: 100%; height: 100%; max-width: 100vw; max-height: 100vh; object-fit: contain; position: absolute; top: 0; left: 0; z-index: 10; display: block; overflow: hidden;';
        document.getElementById('video-container')?.appendChild(wcCanvas) ?? document.body.appendChild(wcCanvas);
        
        // Ensure KBM pointer lock works on the experimental WebCodecs canvas
        if (typeof requestPointerLock === 'function') {
            wcCanvas.addEventListener('click', requestPointerLock);
        }
    }
    
    wcCanvas.style.display = 'block';

    if (!wcCtx) {
        if (CUSTOM_WEBCODECS) {
            wcCtx = wcCanvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
            if (!wcCtx) wcCtx = wcCanvas.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
        } else {
            wcCtx = null;
        }

        if (wcCtx) {
            _webglSupported = true;
            wcGlTexture = _setupWebGL(wcCtx);
            _lastAppliedUpscale = null;
        } else {
            _webglSupported = false;
            wcCtx = wcCanvas.getContext('2d', { alpha: false });
            wcGlTexture = null;
        }
    }

    if (window._wcResizeHandler) {
        window.removeEventListener('resize', window._wcResizeHandler);
    }
    
    // JS Containment rule to forcefully prevent 4K frame overflows
    window._wcResizeHandler = () => {
        if (wcCanvas) {
            wcCanvas.style.maxWidth = window.innerWidth + 'px';
            wcCanvas.style.maxHeight = window.innerHeight + 'px';
        }
    };
    window.addEventListener('resize', window._wcResizeHandler);
    window._wcResizeHandler();


    // Clean up any existing decoder before creating a new one.
    // Leaving the old instance open causes "Decoder already closed" exceptions
    // and zombie contexts when the host restarts their stream.
    if (wcDecoder) {
        try {
            if (wcDecoder.state !== 'closed') wcDecoder.close();
        } catch (_) { }
        wcDecoder = null;
    }

    // Reset the global keyframe gate so the new decoder waits for a clean
    // keyframe before attempting to decode any delta frames.
    window.nsWaitKey = true;

    let _wcFirstFrame = true;

    wcDecoder = new VideoDecoder({
        output: (frame) => {
            if (_pendingWcFrame) _pendingWcFrame.close();
            _pendingWcFrame = frame;
            if (!_wcRenderLoopId) _wcRenderLoopId = requestAnimationFrame(_wcRenderLoop);

            if (_wcFirstFrame) {
                _wcFirstFrame = false;
                if (typeof showOverlay === 'function') showOverlay(false);
                if (typeof setStatus === 'function') setStatus('Live', true);
                if (spinner) spinner.style.display = 'none';
                if (typeof _swapOverlayEl !== 'undefined' && _swapOverlayEl) {
                    _swapOverlayEl.style.display = 'none';
                }
                const overlay = document.getElementById('overlay');
                if (overlay) overlay.style.backgroundColor = '';
            }
            window._wcFramesDecoded = (window._wcFramesDecoded || 0) + 1;
        },
        error: (e) => {
            console.error('[WebCodecs] Decoder Error:', e);
            recoverWebCodecsDecoder();
        }
    });

    const decoderConfig = {
        codec: config.codec,
        codedWidth: config.codedWidth,
        codedHeight: config.codedHeight,
        optimizeForLatency: true
    };

    if (config.description) decoderConfig.description = new Uint8Array(config.description);
    try {
        wcDecoder.configure(decoderConfig);
    } catch (_) {
        delete decoderConfig.optimizeForLatency;
        wcDecoder.configure(decoderConfig);
    }
    console.log('[WebCodecs] Hardware Decoder Ready!');
    _startWcHealthMonitor();
}

// ── STEAM DECK / IMMERSIVE AUTO-DETECT ───────────────────────────────────────
(function detectSteamDeck() {
    const ua = navigator.userAgent;
    const params = new URLSearchParams(location.search);
    const isSteamDeck =
        ua.includes('SteamGamepadUI') ||
        ua.includes('Steam') ||
        params.get('deck') === '1' ||
        (navigator.platform === 'Linux x86_64' &&
            navigator.maxTouchPoints > 0 &&
            screen.width === 1280 &&
            screen.height === 800);

    if (isSteamDeck) {
        console.log('[Nearcade] Steam Deck detected — auto-entering immersive mode');
        document.documentElement.requestFullscreen().then(landscape).catch(() => { });
        const immBtn = document.getElementById('immersiveBtn');
        if (immBtn) immBtn.style.display = 'none';
    }
})();

// ── SIDE BAR FADE ─────────────────────────────────────────────────────────────
(function () {
    const fsBtn = document.getElementById('fsOverlayBtn');
    if (!fsBtn) return;
    let hideTimer = null, lastX = 0, lastY = 0;
    function showBtn() {
        fsBtn.style.opacity = '1'; fsBtn.style.pointerEvents = 'auto';
        document.body.style.cursor = '';
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { fsBtn.style.opacity = '0'; fsBtn.style.pointerEvents = 'none'; document.body.style.cursor = 'none'; }, 2700);
    }
    document.addEventListener('mousemove', e => {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        if (Math.sqrt(dx * dx + dy * dy) < 14) return;
        lastX = e.clientX; lastY = e.clientY;
        showBtn();
    }, { passive: true });
    showBtn();
})();

// ── GAMEPAD CALIBRATION SAVER ──
window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'SAVE_CONTROLLER_CALIB') {
        const { hardwareId, map } = e.data;
        localStorage.setItem('nearsec_map_' + hardwareId, JSON.stringify(map));
        if (window.electronAPI && window.electronAPI.saveSettings) {
            window.electronAPI.saveSettings({ [`calib_${hardwareId}`]: map });
            console.log('[Input] Saved calibration to disk for:', hardwareId);
        }
    }
});

let netStatsInterval = null;
window.toggleNetStats = function() {
    const el = document.getElementById('netStatsOverlay');
    const toggle = document.getElementById('vNetStatsToggle');
    const pt = document.getElementById('partyTab');
    if (!el) return;
    if (el.classList.contains('gone')) {
        el.classList.remove('gone');
        el.classList.add('drop-down');
        window.netStatsDropdownOpen = true;
        if (toggle) toggle.classList.add('on');
        if (pt) pt.style.display = 'none';
        
        // Force close HUD
        const hud = document.getElementById('hudWidget');
        if (hud && !hud.classList.contains('hide')) window.toggleHud();
        
        // Force close party panel if open
        const partyPanel = document.getElementById('partySettingsPanel');
        if (partyPanel && partyPanel.classList.contains('open') && window.closePartySettings) window.closePartySettings();
        
        window.startNetStats();
    } else {
        el.classList.add('gone');
        el.classList.remove('drop-down');
        window.netStatsDropdownOpen = false;
        if (toggle) toggle.classList.remove('on');
        if (pt) pt.style.display = 'flex';
        clearInterval(netStatsInterval);
    }
};

// ── PHASE 2: PARTY MODE PANEL ─────────────────────────────────────────────────
window.togglePartySettings = function() {
    const hud = document.getElementById('hudWidget');
    if (hud && !hud.classList.contains('hide')) return; // Block sidebar if HUD is open

    const panel = document.getElementById('partySettingsPanel');
    const backdrop = document.getElementById('partyBackdrop');
    const tab = document.getElementById('partyTab');
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    if (backdrop) backdrop.classList.toggle('open', isOpen);
    if (tab) tab.style.display = isOpen ? 'none' : 'flex';
    syncPartyToggles();
};

window.closePartySettings = function() {
    const panel = document.getElementById('partySettingsPanel');
    const backdrop = document.getElementById('partyBackdrop');
    const tab = document.getElementById('partyTab');
    const hud = document.getElementById('hudWidget');
    const isHudOpen = hud && !hud.classList.contains('hide');
    
    if (panel) panel.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    if (tab && !isHudOpen) tab.style.display = 'flex';
};

window.togglePartyNetStats = function() {
    window.toggleNetStats();
    const el = document.getElementById('netStatsOverlay');
    if (el && !el.classList.contains('gone')) {
        el.classList.add('drop-down');
    }
};



// ── PHASE 4: TOAST NOTIFICATIONS ─────────────────────────────────────────────
window.pushToast = function(msg, opts={}) {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const item = document.createElement('div');
    item.className = 'toast-item ' + (opts.type === 'error' ? 'toast-err' : '');
    const ic = document.createElement('span');
    ic.className = 'toast-ic';
    ic.textContent = opts.type === 'error' ? '⚠' : (opts.icon || '✦');
    const txt = document.createElement('span');
    txt.className = 'toast-txt';
    txt.textContent = msg;
    item.appendChild(ic);
    item.appendChild(txt);
    stack.appendChild(item);
    while (stack.children.length > 4) stack.removeChild(stack.firstChild);
    setTimeout(() => {
        item.classList.add('out');
        setTimeout(() => item.remove(), 380);
    }, opts.duration || 3500);
};



// ── PHASE 7: IDLE MODE / IMMERSION ───────────────────────────────────────────
window.immersionEnabled = false;
let _idleTimer = null;
let _idleCueVisible = false;
document.addEventListener('pointerdown', () => { window._lastActivityTime = Date.now(); }, { passive: true });
document.addEventListener('keydown', () => { window._lastActivityTime = Date.now(); }, { passive: true });
document.addEventListener('mousemove', () => { window._lastActivityTime = Date.now(); }, { passive: true });
document.addEventListener('gamepadconnected', () => { window._lastActivityTime = Date.now(); });
document.addEventListener('gamepaddisconnected', () => { window._lastActivityTime = Date.now(); });

window.toggleImmersion = function() {
    window.immersionEnabled = !window.immersionEnabled;
    const toggle = document.getElementById('vImmersionToggle');
    if (toggle) toggle.classList.toggle('on', window.immersionEnabled);
    if (window.immersionEnabled) {
        window._lastActivityTime = Date.now();
        startIdleWatch();
    } else {
        const hint = document.getElementById('idleHint');
        if (hint) hint.style.display = 'none';
        if (_idleTimer) { clearInterval(_idleTimer); _idleTimer = null; }
        _idleCueVisible = false;
    }
};

function startIdleWatch() {
    if (!window.immersionEnabled) return;
    if (_idleTimer) clearInterval(_idleTimer);
    _idleTimer = setInterval(() => {
        const hint = document.getElementById('idleHint');
        const videoEl = document.getElementById('video');
        const isStreaming = !!window.pc;
        const last = window._lastActivityTime || Date.now();
        const ago = Date.now() - last;
        // Idle → pause the stream
        if (isStreaming && !_idleCueVisible && ago > 9000) {
            _idleCueVisible = true;
            if (hint) hint.style.display = 'inline';
            try {
                if (videoEl && !videoEl.paused && !videoEl.ended) {
                    videoEl.dataset._idlePaused = '1';
                    videoEl.pause();
                }
            } catch (e) {}
        }
        // Active again → resume + hide cue
        if (_idleCueVisible && (ago < 5000 || !isStreaming)) {
            _idleCueVisible = false;
            if (hint) hint.style.display = 'none';
            if (isStreaming && videoEl && videoEl.dataset._idlePaused === '1') {
                videoEl.dataset._idlePaused = '';
                videoEl.play().catch(() => {});
            }
        }
    }, 2000);
}



// ── Phase 5: SHIFT+TAB FLOATING HUD (draggable + resizable) ───────────────────
let _hudDrag = null;
let _hudResize = null;
let _hudLastFrames = 0;

function hudRect(el) {
    if (!el) return null;
    return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

function saveHudState(el) {
    try {
        const r = hudRect(el);
        if (r) localStorage.setItem('ns_hud_state_' + el.id, JSON.stringify({ x: r.x, y: r.y, w: r.w, h: r.h }));
    } catch (e) {}
}

function applyHudState(el) {
    if (!el) return;
    try {
        const s = JSON.parse(localStorage.getItem('ns_hud_state_' + el.id) || 'null');
        if (s && typeof s.x === 'number') {
            el.style.left = s.x + 'px';
            el.style.top = s.y + 'px';
            el.style.width = s.w + 'px';
            el.style.height = s.h + 'px';
        }
    } catch (e) {}
}

window.toggleHud = function() {
    const el = document.getElementById('hudWidget');
    if (!el) return;
    const isHidden = el.classList.toggle('hide');
    const pt = document.getElementById('partyTab');
    if (pt) {
        if (!isHidden) pt.style.display = 'none';
        else pt.style.display = 'flex';
    }
    
    let tint = document.getElementById('hudTintOverlay');
    if (!isHidden) {
        if (!tint) {
            tint = document.createElement('div');
            tint.id = 'hudTintOverlay';
            tint.innerHTML = '<div style="position:absolute;bottom:40px;width:100%;text-align:center;color:rgba(255,255,255,0.4);font-family:sans-serif;font-weight:700;letter-spacing:6px;font-size:24px;text-shadow:0 2px 10px rgba(0,0,0,0.8);pointer-events:none;">OVERLAY ACTIVE</div>';
            tint.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1399;pointer-events:none;transition:opacity 0.2s;';
            document.body.appendChild(tint);
        }
        tint.style.opacity = '1';
        
        // Force close net stats and party panel if open
        if (window.netStatsDropdownOpen && window.toggleNetStats) window.toggleNetStats();
        const partyPanel = document.getElementById('partySettingsPanel');
        if (partyPanel && partyPanel.classList.contains('open') && window.closePartySettings) window.closePartySettings();
        
        const hasGamepads = navigator.getGamepads && Array.from(navigator.getGamepads()).some(p => p !== null);
        document.querySelectorAll('.floating-hud').forEach(w => {
            if (w.id === 'inputWidget' && !hasGamepads) return;
            w.classList.remove('hide');
            applyHudState(w);
        });
    } else {
        if (tint) tint.style.opacity = '0';
        document.querySelectorAll('.floating-hud').forEach(w => w.classList.add('hide'));
    }
};

function wireHudInteractions() {
    document.querySelectorAll('.floating-hud').forEach(el => {
        if (el.dataset.hud) return;
        el.dataset.hud = '1';
        const titleBar = el.querySelector('.hud-w-titlebar');
        const resizeHandle = el.querySelector('.hud-resize');

        if (titleBar) titleBar.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.hud-close')) return;
            // Bring to front
            document.querySelectorAll('.floating-hud').forEach(w => w.style.zIndex = '1400');
            el.style.zIndex = '1401';
            el._hudDrag = { active: true, ox: e.clientX - el.offsetLeft, oy: e.clientY - el.offsetTop };
            el.classList.add('dragging');
            titleBar.setPointerCapture(e.pointerId);
        });
        if (titleBar) titleBar.addEventListener('pointermove', (e) => {
            if (!el._hudDrag?.active) return;
            const x = Math.min(window.innerWidth - el.offsetWidth, Math.max(0, e.clientX - el._hudDrag.ox));
            const y = Math.min(window.innerHeight - el.offsetHeight, Math.max(0, e.clientY - el._hudDrag.oy));
            el.style.left = x + 'px';
            el.style.top = y + 'px';
        });
        if (titleBar) titleBar.addEventListener('pointerup', () => {
            if (!el._hudDrag?.active) return;
            el._hudDrag.active = false;
            el.classList.remove('dragging');
            saveHudState(el);
        });

        if (resizeHandle) resizeHandle.addEventListener('pointerdown', (e) => {
            el._hudResize = { active: true, x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
            el.classList.add('resizing');
            resizeHandle.setPointerCapture(e.pointerId);
            e.stopPropagation();
        });
        if (resizeHandle) resizeHandle.addEventListener('pointermove', (e) => {
            if (!el._hudResize?.active) return;
            el.style.width = Math.max(160, el._hudResize.w + (e.clientX - el._hudResize.x)) + 'px';
            el.style.height = Math.max(120, el._hudResize.h + (e.clientY - el._hudResize.y)) + 'px';
        });
        if (resizeHandle) resizeHandle.addEventListener('pointerup', () => {
            if (!el._hudResize?.active) return;
            el._hudResize.active = false;
            el.classList.remove('resizing');
            saveHudState(el);
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.shiftKey && e.key === 'Tab') {
            e.preventDefault();
            window.toggleHud();
        }
    }, { capture: true });
    
    // Auto-update chat width for responsive video scaling
    const chatPanel = document.getElementById('chatPanel');
    if (chatPanel && window.ResizeObserver) {
        new ResizeObserver(entries => {
            for (let entry of entries) {
                const w = entry.borderBoxSize ? entry.borderBoxSize[0].inlineSize : entry.contentRect.width;
                document.documentElement.style.setProperty('--chat-width', (w + 20) + 'px');
            }
        }).observe(chatPanel);
    }
}

// Feed live stats into the HUD when it's visible
let _hudGraphDataFps = [];
let _hudGraphDataRtt = [];
let _hudLastBytes = 0;
let _hudLastTime = 0;
let _hudLastDecodeTime = 0;
let _hudLastFramesDecoded = 0;

setInterval(async () => {
    const el = document.getElementById('hudWidget');
    if (!el || el.classList.contains('hide')) return;
    const g = (id) => document.getElementById(id);
    const net = g('netStatusDot');
    if (net) g('hudNet').textContent = net.className.replace('ns-dot-', '').toUpperCase();
    
    if (window._hudCodec) g('hudCodec').textContent = window._hudCodec;
    if (window._hudResolution) g('hudRes').textContent = window._hudResolution;
    
        if (pc) {
        let currentFps = 0, currentRtt = 0, currentBitrateKbps = 0, currentDecodeLat = 0;
        const stats = await pc.getStats();
        stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
                if (report.framesPerSecond != null) currentFps = report.framesPerSecond;
                if (_hudLastTime && report.bytesReceived > _hudLastBytes) {
                    currentBitrateKbps = ((report.bytesReceived - _hudLastBytes) * 8 / (report.timestamp - _hudLastTime)).toFixed(0);
                }
                if (report.totalDecodeTime != null && report.framesDecoded != null) {
                    if (_hudLastFramesDecoded && report.framesDecoded > _hudLastFramesDecoded) {
                        const decodeDelta = report.totalDecodeTime - _hudLastDecodeTime;
                        const framesDelta = report.framesDecoded - _hudLastFramesDecoded;
                        currentDecodeLat = (decodeDelta / framesDelta) * 1000;
                    }
                    _hudLastDecodeTime = report.totalDecodeTime;
                    _hudLastFramesDecoded = report.framesDecoded;
                }
                _hudLastBytes = report.bytesReceived;
                _hudLastTime = report.timestamp;
            }
            if (USE_WEBCODECS && report.type === 'data-channel' && report.label === 'webcodecs') {
                if (_hudLastTime && report.bytesReceived > _hudLastBytes) {
                    currentBitrateKbps = ((report.bytesReceived - _hudLastBytes) * 8 / (report.timestamp - _hudLastTime)).toFixed(0);
                }
                _hudLastBytes = report.bytesReceived;
                _hudLastTime = report.timestamp;
            }
            if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
                currentRtt = report.currentRoundTripTime * 1000;
            }
        });

        // WebCodecs fallback for FPS
        if (USE_WEBCODECS && window._wcFramesDecoded !== undefined) {
            if (window._lastWcFpsTime) {
                const delta = performance.now() - window._lastWcFpsTime;
                const frames = window._wcFramesDecoded - window._lastWcFrames;
                if (delta > 0) currentFps = (frames / (delta / 1000));
            }
            window._lastWcFpsTime = performance.now();
            window._lastWcFrames = window._wcFramesDecoded;
        }

        g('hudFps').textContent = currentFps.toFixed(0) + ' fps';
        g('hudRtt').textContent = currentRtt.toFixed(0) + ' ms';
        if (g('hudBitrate')) g('hudBitrate').textContent = currentBitrateKbps > 0 ? currentBitrateKbps + ' kbps' : '—';
        if (g('hudDecodeLat')) g('hudDecodeLat').textContent = currentDecodeLat > 0 ? currentDecodeLat.toFixed(1) + ' ms' : '—';
        
        _hudGraphDataFps.push(currentFps);
        if (_hudGraphDataFps.length > 30) _hudGraphDataFps.shift();
        
        _hudGraphDataRtt.push(currentRtt);
        if (_hudGraphDataRtt.length > 30) _hudGraphDataRtt.shift();
        
        const canvas = g('hudGraph');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            const w = canvas.width, h = canvas.height;
            ctx.clearRect(0,0,w,h);
            
            // Draw RTT (orange, scaled to 200ms)
            ctx.beginPath();
            ctx.strokeStyle = '#ff9f0a';
            ctx.lineWidth = 1.5;
            for(let i=0; i<_hudGraphDataRtt.length; i++) {
                const x = (i / 29) * w;
                const val = _hudGraphDataRtt[i];
                const y = h - (Math.min(val, 200) / 200) * h;
                if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
            }
            ctx.stroke();

            // Draw FPS (green, scaled to 60fps)
            ctx.beginPath();
            ctx.strokeStyle = '#34c759';
            ctx.lineWidth = 1.5;
            for(let i=0; i<_hudGraphDataFps.length; i++) {
                const x = (i / 29) * w;
                const val = _hudGraphDataFps[i];
                const y = h - (Math.min(val, 60) / 60) * h;
                if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
            }
            ctx.stroke();
        }
    }
}, 1000);

setTimeout(() => { applyHudState(); wireHudInteractions(); }, 300);

// Restore upscale mode + GPU backend from persisted settings
setTimeout(async () => {
    const saved = localStorage.getItem('ns_upscale_mode');
    if (saved !== null && !isNaN(parseInt(saved, 10))) {
        _upscaleMode = parseInt(saved, 10);
        window.setUpscaleMode(_upscaleMode);
    }

    // GPU backend — attempt WebGPU init if the preference is set
    _gpuBackendEnabled = localStorage.getItem('ns_gpu_backend') === '1';
    _syncGpuBackendToggleUI();
    if (_gpuBackendEnabled) {
        await _initGpuUpscalerIfEnabled();
        // If init failed, _gpuBackendEnabled was reset to false inside the function
        _syncGpuBackendToggleUI();
    }
}, 500);

// ── Phase 10: SHARE / INVITE ─────────────────────────────────────────────────
const _shareInvno = 0;
let _shareQrPending = null;

window.openShareModal = function() {
    const m = document.getElementById('shareModal');
    const url = window._shareUrl || (location.href.split('#')[0]);
    m.classList.remove('gone');
    const linkEl = document.getElementById('shareLink');
    linkEl.value = url;
    const qr = document.getElementById('shareQr');
    if (window.QRCode) {
        qr.innerHTML = '';
        new QRCode(qr, { text: url, width: 130, height: 130, correctLevel: QRCode.CorrectLevel.M });
    } else {
        qr.innerHTML = '<span style="color:#333;font-size:11px">QR: ' + url + '</span>';
    }
};

window.closeShareModal = function() {
    const m = document.getElementById('shareModal');
    if (m) m.classList.add('gone');
};

window.copyShareLink = function() {
    const linkEl = document.getElementById('shareLink');
    if (!linkEl) return;
    navigator.clipboard.writeText(linkEl.value).then(() => {
        const btn = document.querySelector('.share-copy');
        if (btn) btn.textContent = 'Copied!';
        window.pushToast('Invite link copied to clipboard');
        setTimeout(() => { if (btn && btn.textContent === 'Copied!') btn.textContent = 'Copy Link'; }, 1500);
    }).catch(() => {
        window.pushToast('Could not copy link', { type: 'error' });
    });
};
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { window.closePartySettings && window.closePartySettings(); window.closeShareModal && window.closeShareModal(); }
});

// ── PARTY STATE PERSISTENCE (localStorage) ───────────────────────────────────
window.pushPartyState = function() {
    try {
        localStorage.setItem('ns_party_state', JSON.stringify({
            pixel: !!window.pixelFilterEnabled,
            crt: !!window.crtFilterEnabled,
            fgc: !!window.fgcEnabled,
            chat: !!(document.getElementById('chatPanel') && document.getElementById('chatPanel').classList.contains('open'))
        }));
    } catch (e) {}
};

window.recallPartyState = function() {
    try {
        const s = JSON.parse(localStorage.getItem('ns_party_state') || '{}');
        if (s.pixel) window.togglePixelFilter();
        if (s.crt) window.toggleCrtFilter();
        if (s.fgc) window.toggleFgcVisualizer();
    } catch (e) {}
};

// Restore party toggles from DOM state (called when panel opens)
function syncPartyToggles() {
    const states = {
        partyChatToggle: !!(document.getElementById('chatPanel') && document.getElementById('chatPanel').classList.contains('open'))
    };
    for (const [id, on] of Object.entries(states)) {
        const t = document.getElementById(id);
        if (t) t.classList.toggle('on', on);
    }
}

window.startNetStats = function() {
    clearInterval(netStatsInterval);
    let lastBytes = 0;
    let lastTime = 0;
    let lastDecodeTime = 0;
    let lastFramesDecoded = 0;
    netStatsInterval = setInterval(async () => {
        if (!pc) return;
        const stats = await pc.getStats();
        let codecName = '--';
        stats.forEach(report => {
            if (report.type === 'codec' && report.mimeType && report.mimeType.startsWith('video/')) {
                codecName = report.mimeType.split('/')[1];
            }
        });
        
        stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
                if (lastTime && report.bytesReceived > lastBytes) {
                    const kbps = ((report.bytesReceived - lastBytes) * 8 / (report.timestamp - lastTime)).toFixed(0);
                    const el = document.getElementById('nsBitrate');
                    if(el) el.textContent = kbps + ' kbps';
                }
                lastBytes = report.bytesReceived;
                
                const elCodec = document.getElementById('nsCodec');
                if(elCodec) elCodec.textContent = codecName;
                
                if (report.frameWidth && report.frameHeight) {
                    const elRes = document.getElementById('nsRes');
                    if(elRes) elRes.textContent = `${report.frameWidth}x${report.frameHeight}`;
                }
                
                if (report.framesPerSecond != null) {
                    const elFps = document.getElementById('nsFps');
                    if(elFps) elFps.textContent = report.framesPerSecond.toFixed(0);
                }
                
                if (report.totalDecodeTime != null && report.framesDecoded != null) {
                    if (lastFramesDecoded && report.framesDecoded > lastFramesDecoded) {
                        const decodeDelta = report.totalDecodeTime - lastDecodeTime;
                        const framesDelta = report.framesDecoded - lastFramesDecoded;
                        const decodeLatencyMs = (decodeDelta / framesDelta) * 1000;
                        const elDecode = document.getElementById('nsDecode');
                        if (elDecode) elDecode.textContent = decodeLatencyMs.toFixed(1) + ' ms';
                    }
                    lastDecodeTime = report.totalDecodeTime;
                    lastFramesDecoded = report.framesDecoded;
                }
                
                lastTime = report.timestamp;
                if (report.packetsLost != null && report.packetsReceived != null) {
                    const total = report.packetsLost + report.packetsReceived;
                    const el = document.getElementById('nsLoss');
                    if(el) el.textContent = total > 0 ? ((report.packetsLost / total) * 100).toFixed(1) + ' %' : '0 %';
                }
                if (report.jitter != null) {
                    const el = document.getElementById('nsJitter');
                    if(el) el.textContent = (report.jitter * 1000).toFixed(0) + ' ms';
                }
            }
            if (USE_WEBCODECS && report.type === 'data-channel' && report.label === 'webcodecs') {
                if (lastTime && report.bytesReceived > lastBytes) {
                    const kbps = ((report.bytesReceived - lastBytes) * 8 / (report.timestamp - lastTime)).toFixed(0);
                    const el = document.getElementById('nsBitrate');
                    if(el) el.textContent = kbps + ' kbps';
                }
                lastBytes = report.bytesReceived;
                lastTime = report.timestamp;
            }
            if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
                const el = document.getElementById('nsPing');
                if(el) el.textContent = (report.currentRoundTripTime * 1000).toFixed(0) + ' ms';
            }
        });
        
        if (USE_WEBCODECS) {
            const elCodec = document.getElementById('nsCodec');
            if(elCodec && window._hudCodec) elCodec.textContent = window._hudCodec;
            const elRes = document.getElementById('nsRes');
            if(elRes && window._hudResolution) elRes.textContent = window._hudResolution;
            const elFps = document.getElementById('nsFps');
            if(elFps) {
                const delta = performance.now() - (window._lastWcFpsTime2 || performance.now());
                const frames = window._wcFramesDecoded - (window._lastWcFrames2 || window._wcFramesDecoded || 0);
                if (delta > 0) elFps.textContent = (frames / (delta / 1000)).toFixed(0);
                window._lastWcFpsTime2 = performance.now();
                window._lastWcFrames2 = window._wcFramesDecoded;
            }
            const elLoss = document.getElementById('nsLoss');
            if (elLoss) elLoss.textContent = 'N/A';
        }
    }, 1000);
};

// ── WEBXR (VR) INPUT POLLING ──────────────────────────────────────────────────
let xrSession = null;
let xrRefSpace = null;
let xrVideoTex = null;
let xrVideoPanelVAO = null;
let xrVideoProgram = null;
let xrVideoUniforms = {};
let lobbyGL = null;
let lobbyLayer = null;
let lobbyActive = false;
let lastVrSend = 0;

function maybeShowVRButton() {
    if (!window.hostAllowVR || !navigator.xr) {
        const btn = document.getElementById('btnEnterVR');
        if (btn) btn.style.display = 'none';
        return;
    }

    navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
        if (!supported) return;

        let btn = document.getElementById('btnEnterVR');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'btnEnterVR';
            btn.title = 'Enter VR Mode';
            btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;"><path d="M4 14V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6m-16 0a2 2 0 0 0 2 2h3.5l1.5-2h2l1.5 2H18a2 2 0 0 0 2-2m-16 0h16"/></svg>`;
            btn.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:9999; background:rgba(9,10,14,0.7); backdrop-filter:blur(8px); border:1px solid rgba(139,92,246,0.3); border-radius:50%; width:48px; height:48px; display:flex; align-items:center; justify-content:center; color:var(--accent2); cursor:pointer; box-shadow:0 4px 15px rgba(0,0,0,0.5); transition:all 0.2s;';
            btn.onmouseover = () => { btn.style.background = 'var(--accent)'; btn.style.color = '#fff'; btn.style.transform = 'scale(1.1)'; };
            btn.onmouseout = () => { btn.style.background = 'rgba(9,10,14,0.7)'; btn.style.color = 'var(--accent2)'; btn.style.transform = 'scale(1)'; };
            btn.onclick = startVRSession;
            document.body.appendChild(btn);
        }
        btn.style.display = 'block';
    });
}

function startVRSession() {
    if (!navigator.xr) return;
    navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] }).then(session => {
        xrSession = session;
        const btn = document.getElementById('btnEnterVR');
        if (btn) btn.style.display = 'none';

        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'viewer-vr-active', viewerId: myId }));

        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2', { xrCompatible: true });
        const layer = new XRWebGLLayer(session, gl);
        session.updateRenderState({ baseLayer: layer });

        // Initialize lobby renderer
        if (lobbyInit(gl)) {
            lobbyActive = true;
            lobbyGL = gl;
            lobbyLayer = layer;
        }

        session.requestReferenceSpace('local-floor').then(refSpace => {
            xrRefSpace = refSpace;
            session.requestAnimationFrame(onXRFrame);
        });

        session.addEventListener('end', () => {
            xrSession = null;
            lobbyDestroy();
            if (window.hostAllowVR) maybeShowVRButton();
        });
    }).catch(err => {
        console.error('[WebXR] Failed to start session:', err);
        alert('Failed to enter VR: ' + err.message);
    });
}

function onXRFrame(time, frame) {
    if (!xrSession) return;
    xrSession.requestAnimationFrame(onXRFrame);

    const pose = frame.getViewerPose(xrRefSpace);
    if (!pose) return;

    const gl = lobbyGL;
    if (gl && lobbyLayer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, lobbyLayer.framebuffer);

        const videoEl = document.getElementById('video');
        const videoReady = videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0;
        const hostStreaming = typeof window.hostStreamingActive !== 'undefined' && window.hostStreamingActive;

        if ((hostStreaming || videoReady) && xrVideoTex) {
            gl.clearColor(0.01, 0.01, 0.04, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            xrRenderVideoPanel(gl, videoEl);
        } else if (lobbyActive) {
            lobbyRender(gl, frame, xrRefSpace);
        }
    }

    const now = Date.now();
    if (now - lastVrSend < 16) return;

    let changed = false;
    const vrState = {
        type: 'vr',
        viewerId: myId,
        head: null,
    };

    const hmdPos = pose.transform.position;
    const hmdOri = pose.transform.orientation;
    vrState.head = {
        px: hmdPos.x, py: hmdPos.y, pz: hmdPos.z,
        qw: hmdOri.w, qx: hmdOri.x, qy: hmdOri.y, qz: hmdOri.z
    };
    changed = true;

    for (const source of xrSession.inputSources) {
        if (!source.gripSpace || (source.handedness !== 'left' && source.handedness !== 'right')) continue;
        const cp = frame.getPose(source.gripSpace, xrRefSpace);
        if (cp) {
            let trigger = 0, grip = 0, buttons = 0, ax = 0, ay = 0;
            const gp = source.gamepad;
            if (gp) {
                if (gp.buttons.length > 0) trigger = gp.buttons[0].value;
                if (gp.buttons.length > 1) grip = gp.buttons[1].value;

                if (gp.buttons.length > 4 && gp.buttons[4].pressed) buttons |= 1;
                if (gp.buttons.length > 5 && gp.buttons[5].pressed) buttons |= 2;
                if (gp.buttons.length > 3 && gp.buttons[3].pressed) buttons |= 8;
                if (gp.buttons.length > 6 && gp.buttons[6].pressed) buttons |= 4;

                if (gp.axes.length >= 4) { ax = gp.axes[2]; ay = gp.axes[3]; }
                else if (gp.axes.length >= 2) { ax = gp.axes[0]; ay = gp.axes[1]; }
            }

            vrState[source.handedness] = {
                px: cp.transform.position.x, py: cp.transform.position.y, pz: cp.transform.position.z,
                qw: cp.transform.orientation.w, qx: cp.transform.orientation.x, qy: cp.transform.orientation.y, qz: cp.transform.orientation.z,
                trigger, grip, buttons, ax, ay
            };
        }
    }

    if (changed) {
        lastVrSend = now;
        sendInputData(JSON.stringify(vrState));
    }
}

// ── Voice: set user volume / mute — called from voice overlay ──
window.setUserVolume = function (targetId, volume) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({
        type: 'set-viewer-volume',
        targetId: targetId,
        volume: volume
    }));
};
