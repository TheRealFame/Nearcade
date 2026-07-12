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
    low: { label: 'Low', maxBitrate: 1_500_000, maxHeight: 720, scaleDown: 2 },
    high: { label: 'High', maxBitrate: 8_000_000, maxHeight: 2160, scaleDown: 1 },
};

let _bwProfile = localStorage.getItem('ns_bw_profile') || 'auto';

function setBandwidthProfile(key) {
    if (!BW_PROFILES[key]) return;
    _bwProfile = key;
    localStorage.setItem('ns_bw_profile', key);
    // Update button states in nsBar
    document.querySelectorAll('[data-bw]').forEach(btn => {
        btn.classList.toggle('ns-btn-active', btn.dataset.bw === key);
    });
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
let ws, pc, myId = sessionStorage.getItem('ns_viewer_id');
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

// ── EARLY PIN / CONNECT STATE (must be declared before async standby handler) ──
let pinRequired = true;
let _autoJoinedVps = false;

// ── EARLY STANDBY CONNECTION ────────────────────────────────────────────────
// Always attempt to connect to the VPS standby lane. If we are on a standard
// peer-to-peer local server, this route doesn't exist and will silently fail (404),
// which is perfectly fine. If we are on the VPS, it connects and instantly checks state.
const urlParamsGlobal = new URLSearchParams(window.location.search);
const standbyWs = new WebSocket(`${proto}://${host}/vps?standby=true`);

// ?preview=1 opens standalone lobby preview window
if (urlParamsGlobal.has('preview')) {
    import('./lobby.js').then(m => {
        const w = window.open('', 'lobbyPreview', 'width=960,height=540,left=100,top=100,resizable=yes');
        if (w) {
            w.document.title = 'Nearsec Lobby Preview';
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
    if (msg.type === 'stream-idle') {
        const pinScreen = document.getElementById('pinScreen');
        const onPinScreen = pinScreen && !pinScreen.classList.contains('gone');
        if (!onPinScreen || _nsHostConnected) return;
        let sf = document.getElementById('_nsStandbyFrame');
        if (!sf) {
            sf = document.createElement('iframe');
            sf.id = '_nsStandbyFrame';
            sf.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:none;z-index:9000;background:#080808;';
            sf.src = '/standby.html';
            document.body.appendChild(sf);
        } else {
            sf.style.display = 'block';
        }
    } else if (msg.type === 'stream-active') {
        const sf = document.getElementById('_nsStandbyFrame');
        if (sf) sf.style.display = 'none';
    }
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
let myName = urlParamsGlobal.get('name') || localStorage.getItem('ns_name') || 'Guest' + Math.floor(Math.random() * 9000 + 1000);
document.getElementById('nameInput').value = myName;
if (urlParamsGlobal.get('name')) localStorage.setItem('ns_name', myName);
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
const CLIENT_VERSION = window.NEARSEC_VERSION || '1.0.0';

// Tracks whether an active host stream session exists in this browser tab.
// Used to gate the standby screen so it only appears on the pin screen
// when no host has connected yet.
let _nsHostConnected = false;


document.addEventListener('click', unlockAudio, { once: true, passive: true });
document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });

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

    // Pick 2 random STUN servers to avoid the "Using five or more STUN/TURN servers slows down discovery" warning
    // and naturally rotate STUN/TURN across retries for users with VPNs.
    const shuffledStun = stunPool.sort(() => 0.5 - Math.random()).slice(0, 2).map(url => ({ urls: url }));
    
    const iceServers = [...shuffledStun];
    if (_turnCredentials) iceServers.push(_turnCredentials);

    pc = new RTCPeerConnection({
        iceServers: iceServers,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        sdpSemantics: 'unified-plan'
    });

    pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] Connection State: ${pc.connectionState}`);
        if (pc.connectionState === 'failed') {
            console.warn('[WebRTC] Connection failed — requesting fresh offer in 1s...');
            setStatus('Connection failed. Retrying...');
            clearTimeout(_reconnectTimer);
            _reconnectTimer = setTimeout(() => {
                if (ws?.readyState === 1 && (!pc || pc.connectionState !== 'connected')) {
                    ws.send(JSON.stringify({ type: 'request-offer' }));
                }
            }, 1000);
        }
        if (pc.connectionState === 'disconnected') console.warn('[WebRTC] Disconnected.');
    };
    pc.oniceconnectionstatechange = () => console.log(`[WebRTC] ICE State: ${pc.iceConnectionState}`);
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
            audioEl.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
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
                // (If your viewer was receiving data from the host here, you'd parse it.
                // Usually this channel is purely for sending FROM the viewer TO the host,
                // but we must acknowledge the channel open state regardless).
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

    // Renegotiation — sends a new offer when tracks are added/removed
    pc.onnegotiationneeded = async () => {
        if (!ws || ws.readyState !== 1) return;
        try {
            console.log('[WebRTC] Renegotiation needed — sending new offer...');
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
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
            // NEW: Command the Host to send a fresh offer picking up this new audio track
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'viewer-mic-ready' }));
            }
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

// ── WHO'S TALKING OVERLAY ─────────────────────────────────────────────────────
function setLocalTalking(active) {
    const myEntry = document.getElementById('talkingMe');
    if (myEntry) myEntry.classList.toggle('talking-active', active);
    refreshTalkingOverlayVisibility();
}

/**
 * Stub: update overlay with remote speaker list from server.
 * Wire this up to a 'voice-activity' WebSocket message later.
 * @param {string[]} activeSpeakerIds
 */
function updateTalkingOverlay(activeSpeakerIds) {
    const overlay = document.getElementById('talkingOverlay');
    if (!overlay) return;
    overlay.querySelectorAll('.talking-remote').forEach(el => el.remove());
    activeSpeakerIds.forEach(id => {
        const el = document.createElement('div');
        el.className = 'talking-entry talking-remote talking-active';
        el.dataset.viewerId = id;
        el.innerHTML = `<span class="talking-dot"></span><span class="talking-name">${id}</span>`;
        overlay.appendChild(el);
    });
    refreshTalkingOverlayVisibility();
}

function refreshTalkingOverlayVisibility() {
    const overlay = document.getElementById('talkingOverlay');
    if (!overlay) return;
    const anyActive = !!overlay.querySelector('.talking-active');
    overlay.classList.toggle('talking-overlay-visible', anyActive);
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

function sysChat(text) { console.log("[Nearsec System]:", text); }

const video = document.getElementById('video');
const frameCanvas = document.getElementById('frameCanvas');
const frameCtx = frameCanvas.getContext('2d', { alpha: false });
let processorRunning = false;

function startFrameProcessor(track) {
    if (!window.MediaStreamTrackProcessor) {
        if (!video.srcObject) video.srcObject = new MediaStream();
        video.srcObject.addTrack(track);
        video.onplaying = () => {
            showOverlay(false); setStatus('Live', true);
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('gpPrompt').classList.add('gone');
            document.getElementById('kbmHint').style.display = 'inline';
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
            document.getElementById('kbmHint').style.display = 'inline';
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
const keyMap = {
    'KeyW': 'KEY_W', 'KeyA': 'KEY_A', 'KeyS': 'KEY_S', 'KeyD': 'KEY_D',
    'ArrowUp': 'KEY_UP', 'ArrowDown': 'KEY_DOWN', 'ArrowLeft': 'KEY_LEFT', 'ArrowRight': 'KEY_RIGHT',
    'Space': 'KEY_SPACE', 'Enter': 'KEY_ENTER', 'Escape': 'KEY_ESC',
    'ShiftLeft': 'KEY_LEFTSHIFT', 'ControlLeft': 'KEY_LEFTCTRL', 'Tab': 'KEY_TAB',
    'KeyQ': 'KEY_Q', 'KeyE': 'KEY_E', 'KeyR': 'KEY_R', 'KeyF': 'KEY_F', 'KeyC': 'KEY_C',
    'KeyZ': 'KEY_Z', 'KeyX': 'KEY_X', 'KeyV': 'KEY_V', 'KeyB': 'KEY_B', 'Digit1': 'KEY_1', 'Digit2': 'KEY_2',
    // ── NEW FULL ALPHABET & NUMBERS ──
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
const mouseMap = { 0: 'BTN_LEFT', 1: 'BTN_MIDDLE', 2: 'BTN_RIGHT' };

// ── Fast-Lane Input Dispatcher ────────────────────────────────────────────────
// Tries WebRTC DataChannel first (zero-latency), falls back to inputWs, then ws.
function sendInputData(data) {
    const isBin = data instanceof Uint8Array || data instanceof ArrayBuffer;
    const str = isBin ? null : (typeof data === 'string' ? data : JSON.stringify(data));
    
    // 1. WebTransport Unreliable Datagrams (VPS Fast Lane)
    if (window.wtInputWriter) {
        try {
            window.wtInputWriter.write(isBin ? data : new TextEncoder().encode(str));
            return;
        } catch (_) { }
    }

    // 2. WebRTC DataChannel (P2P Fast Lane)
    if (window._fastLaneChannel && window._fastLaneChannel.readyState === 'open') {
        try { window._fastLaneChannel.send(isBin ? data : str); return; } catch (_) { }
    }
    if (inputWs && inputWs.readyState === 1) {
        inputWs.send(isBin ? data : str); return;
    }
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
    const btn = document.getElementById('touchToggleBtn');
    if (btn) { btn.classList.toggle('ns-btn-active', touchMode); btn.textContent = touchMode ? 'Touch UI: ON' : 'Touch UI: OFF'; }
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
        touchState.buttons[el.dataset.btn].pressed = true; 
        touchState.buttons[el.dataset.btn].value = 1; 
        el.style.transform = 'scale(0.92)';
        el.style.backgroundColor = 'rgba(139, 92, 246, 0.4)';
    }, { passive: false });
    
    const release = e => {
        e.preventDefault();
        touchState.buttons[el.dataset.btn].pressed = false;
        touchState.buttons[el.dataset.btn].value = 0;
        el.style.transform = '';
        el.style.backgroundColor = '';
    };
    
    el.addEventListener('touchend', release, { passive: false });
    el.addEventListener('touchcancel', release, { passive: false });
});

const jBase = document.getElementById('jBase');
const jStick = document.getElementById('jStick');
let jBaseRect = null;
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
    jBase.addEventListener('touchstart', e => { e.preventDefault(); jBaseRect = jBase.getBoundingClientRect(); updateStick(e.touches[0]); }, { passive: false });
    jBase.addEventListener('touchmove', e => { e.preventDefault(); updateStick(e.touches[0]); }, { passive: false });
    jBase.addEventListener('touchend', e => { e.preventDefault(); jStick.style.transform = 'translate(0px,0px)'; touchState.axes[0] = 0; touchState.axes[1] = 0; }, { passive: false });
}

const jBaseRight = document.getElementById('jBaseRight');
const jStickRight = document.getElementById('jStickRight');
let jBaseRightRect = null;
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
    jBaseRight.addEventListener('touchstart', e => { e.preventDefault(); jBaseRightRect = jBaseRight.getBoundingClientRect(); updateStickRight(e.touches[0]); }, { passive: false });
    jBaseRight.addEventListener('touchmove', e => { e.preventDefault(); updateStickRight(e.touches[0]); }, { passive: false });
    jBaseRight.addEventListener('touchend', e => { e.preventDefault(); jStickRight.style.transform = 'translate(0px,0px)'; touchState.axes[2] = 0; touchState.axes[3] = 0; }, { passive: false });
}

// Removed redundant dpad-btn listener block since it's handled by data-btn above

// ── HID GYRO ──────────────────────────────────────────────────────────────────
let hidDevice = null, hostMotionEnabled = false, hidGyroX = 0, hidGyroY = 0;
async function requestHID() {
    if (!('hid' in navigator)) { alert('WebHID not supported. Use Chrome/Edge.'); return; }
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
    if (e.data?.type === 'NEARSEC_CONFIG_UPDATE' && e.data.hardwareId) calibMaps[e.data.hardwareId] = e.data.map;
    if (e.data?.type === 'NEARSEC_SMART_DB' && e.data.db) {
        smartDb = e.data.db;
        window.smartDb = smartDb;
    }
    if (e.data?.type === 'NEARSEC_DEADZONE') {
        gpDeadzones[e.data.index] = e.data.value;
    }
});

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
    const rx = readStick(m.rsx);
    const ry = readStick(m.rsy);
    if (rx !== null) state.axes[2] = Math.round(rx * 32767);
    if (ry !== null) state.axes[3] = Math.round(ry * 32767);
    function readTrigger(mp) {
        if (!mp) return 0;
        if (mp.type === 'btn') return Math.round((gp.buttons[mp.idx]?.value || 0) * 255);
        const raw = gp.axes[mp.idx] ?? -1;
        const norm = Math.max(0, (raw + 1) / 2);
        return norm < 0.05 ? 0 : Math.round(norm * 255);
    }
    const lt = readTrigger(m.lt), rt = readTrigger(m.rt);
    if (lt > 0 || m.lt) state.buttons[6] = { pressed: lt > 10, value: lt };
    if (rt > 0 || m.rt) state.buttons[7] = { pressed: rt > 10, value: rt };
}

// ── GAMEPAD POLLING ───────────────────────────────────────────────────────────
let gpPolling = false, lastGpSend = {}, lastGpStr = {};
let gpCache = {}, gpStateObj = {};
let gpDeadzones = {};
let sentGpid = new Set();

function activateGamepad() {
    if (gpPolling) return;
    gpPolling = true;
    const pmt = document.getElementById('gpPrompt');
    if (pmt) { pmt.classList.add('active'); pmt.textContent = 'Grab A Gamepad!'; }
    // 1ms interval (1000 Hz) for maximum competitive precision / lowest input latency
    setInterval(pollGamepad, 1);
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
        }
    });
    window.electronAPI.startNativeGamepadCapture();
}

window.currentInputMode = 'gamepad';
let eyeTrackerCam = null;
let eyeTrackerFaceMesh = null;

window.updateInputMode = function(val) { 
    window.currentInputMode = val; 
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
    
    // 1. Find the best device (Standard Gamepad > Any Gamepad > Touch)
    let bestGp = null;
    let isTouch = false;
    for (const gp of pads) {
        if (!gp || !gp.connected) continue;
        if (gp.mapping === 'standard') { bestGp = gp; break; }
        if (!bestGp) bestGp = gp;
    }
    if (!bestGp && touchMode) isTouch = true;
    
    if (!bestGp && !isTouch) return; // No inputs available

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

    let changed = false;

    if (!isTouch && bestGp) {
        let dz = gpDeadzones[bestGp.index] !== undefined ? gpDeadzones[bestGp.index] : 0.05;
        for (let i = 0; i < 4; i++) {
            let val = bestGp.axes[i] || 0;
            if (Math.abs(val) < dz) val = 0;
            else val = Math.sign(val) * ((Math.abs(val) - dz) / (1 - dz));
            
            let finalVal = Math.round(val * 32767);
            // Micro-jitter filter: ignore axis changes smaller than 32/32767 (~0.09%)
            // This is sub-pixel level, preserving exact angles for Smash Bros while stopping resting tremor spam.
            if (Math.abs(cache.axes[i] - finalVal) > 32) {
                changed = true;
                cache.axes[i] = finalVal;
            }
            state.axes[i] = cache.axes[i];
        }
        for (let i = 0; i < 16; i++) {
            const b = bestGp.buttons[i];
            const v = Math.round((b?.value || 0) * 255);
            state.buttons[i].value = v;
            state.buttons[i].pressed = b?.pressed || false;
            if (cache.btns[i] !== v) { changed = true; cache.btns[i] = v; }
        }
        applyCalibration(bestGp, state);
    } else if (isTouch) {
        for (let i = 0; i < 4; i++) {
            state.axes[i] = Math.round((touchState.axes[i] || 0) * 32767);
            if (cache.axes[i] !== state.axes[i]) { changed = true; cache.axes[i] = state.axes[i]; }
        }
        for (let i = 0; i < 16; i++) {
            const b = touchState.buttons[i];
            const v = Math.round((b?.value || 0) * 255);
            state.buttons[i].value = v;
            state.buttons[i].pressed = b?.pressed || false;
            if (cache.btns[i] !== v) { changed = true; cache.btns[i] = v; }
        }
    }

    if (hidDevice && hostMotionEnabled) {
        state.axes[2] = Math.max(-32767, Math.min(32767, state.axes[2] + Math.round(hidGyroX * 32767)));
        state.axes[3] = Math.max(-32767, Math.min(32767, state.axes[3] + Math.round(hidGyroY * 32767)));
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

    const forceHb = now - (lastGpSend[vIndex] || 0) > 100;
    if (changed || forceHb) {
        lastGpSend[vIndex] = now;
        sendInputData(_packGamepadBinary(vIndex, state));
    }
}

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
    view.setInt16(4, state.axes[0] || 0, true);
    view.setInt16(6, state.axes[1] || 0, true);
    view.setInt16(8, state.axes[2] || 0, true);
    view.setInt16(10, state.axes[3] || 0, true);
    
    buf[12] = state.buttons[6]?.value || 0;
    buf[13] = state.buttons[7]?.value || 0;
    
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
    document.getElementById('overlayStatus').textContent = msg;
    document.getElementById('topStatus').textContent = msg;
    if (live) document.getElementById('liveDot').style.display = 'inline-block';
}
function showOverlay(v) { document.getElementById('overlay').classList.toggle('gone', !v); }

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
    const useVps = location.hostname === 'publicnearcade.cutefame.net' || urlParams.has('v3') || urlParams.has('vps');
    if (useVps) return; // In VPS mode, all inputs flow cleanly over the main /vps WebSocket

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
            const current = document.getElementById('status')?.innerText || '';
            if (current.includes('Discovering') && typeof setStatus === 'function') {
                setStatus('Scanning trackers for host session...');
            }
        }, 7000);
        window._p2pProgression2 = setTimeout(() => {
            const current = document.getElementById('status')?.innerText || '';
            if (current.includes('Scanning') && typeof setStatus === 'function') {
                setStatus('Still searching, please wait...');
            }
        }, 14000);
        
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
                if (typeof setStatus === 'function') setStatus('Host found, negotiating P2P connection...');
                if (typeof ws.onopen === 'function') ws.onopen();
            });
        }
        stopReconnect = false;
    } else {
        // Always use /vps for the public domain or if v3 is forced
        const useVps = location.hostname === 'publicnearcade.cutefame.net' || urlParams.has('v3') || urlParams.has('vps');
        let wsUrl = useVps
            ? `${proto}://${host}/vps`
            : `${proto}://${host}/ws/viewer`;

        if (enteredPin) wsUrl += (wsUrl.includes('?') ? '&' : '?') + `pin=${encodeURIComponent(enteredPin)}`;
        if (enteredPassword) wsUrl += (wsUrl.includes('?') ? '&' : '?') + `password=${encodeURIComponent(enteredPassword)}`;
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        stopReconnect = false;

        // ── EXPERIMENTAL WEBTRANSPORT CLIENT ──────────────────────────────────────
        const wtRequested = urlParams.get('wt') === '1' || urlParams.get('pipeline') === 'webtransport';
        if (useVps && wtRequested && 'WebTransport' in window) {
            try {
                const wtUrl = `https://${host}:4433/wt`;
                const wt = new WebTransport(wtUrl);
                wt.ready.then(() => {
                    console.log('[WebTransport] Connected to UDP datagram router.');
                    window.wtInputWriter = wt.datagrams.writable.getWriter();
                }).catch(e => console.warn('[WebTransport] Handshake failed, falling back to WS:', e));
                wt.closed.then(() => { 
                    window.wtInputWriter = null; 
                    console.log('[WebTransport] Session closed.'); 
                }).catch(()=>{});
            } catch (e) {
                console.warn('[WebTransport] Setup error:', e);
            }
        }
    }

    ws.onopen = () => {
        ws.send(JSON.stringify({
            type: 'join', viewerId: myId, name: myName, pin: enteredPin,
            viewerRegion, clientVersion: CLIENT_VERSION,
            isDesktopApp: urlParamsGlobal.has('compat')
        }));
        knownNativePads.forEach(pInfo => ws.send(JSON.stringify(Object.assign({ type: 'gpid' }, pInfo))));
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

        // webcodecs-config arrives on the main WS in VPS mode (replayed by the
        // Rust router on join). In WebRTC-only mode it arrives on the DataChannel.
        if (msg.type === 'smart-db') {
            smartDb = msg.payload || {};
            window.smartDb = smartDb;
            const frame = document.getElementById('controllerGuideFrame');
            if (frame?.contentWindow) frame.contentWindow.postMessage({ type: 'NEARSEC_SMART_DB', db: smartDb }, '*');
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
            const onPinScreen = pinScreen && !pinScreen.classList.contains('gone');
            if (!onPinScreen || _nsHostConnected) return;
            let sf = document.getElementById('_nsStandbyFrame');
            if (!sf) {
                sf = document.createElement('iframe');
                sf.id = '_nsStandbyFrame';
                sf.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:none;z-index:9000;background:#080808;';
                sf.src = '/standby.html';
                document.body.appendChild(sf);
            } else {
                sf.style.display = 'block';
            }
            showOverlay(false);
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
            _nsHostConnected = true;
            if (pc) { try { pc.close(); } catch { } pc = null; }
            const videoEl = document.getElementById('video');
            if (videoEl?.srcObject) { videoEl.srcObject.getTracks().forEach(t => t.stop()); videoEl.srcObject = null; }
            document.getElementById('frameCanvas').style.display = 'none';
            processorRunning = false;
            showOverlay(true); setStatus('Host reconnected, waiting for stream...');
            document.getElementById('spinner').style.display = 'block';
            // Display the host's saved name in both the overlay and the topbar pill
            if (msg.hostName) {
                const overlayEl = document.getElementById('sessionHostName');
                if (overlayEl) { overlayEl.textContent = 'HOST SESSION — ' + msg.hostName; overlayEl.style.display = 'block'; }
                const topEl = document.getElementById('topHostName');
                const flagHtml = msg.hostRegion ? `<span class="fi fi-${msg.hostRegion}"></span> ` : '';
                if (topEl) topEl.innerHTML = flagHtml + msg.hostName;
                const pillEl = document.getElementById('hostNamePill');
                if (pillEl) pillEl.style.display = '';
                document.title = 'Nearsec — ' + msg.hostName;
            }
            // CRITICAL FIX: Do NOT send request-offer unconditionally here.
            // The Host already automatically sends an offer when 'viewer-joined' is received.
            // Sending request-offer causes a duplicate 'viewer-joined' trigger on the Host,
            // which forces the Host to destroy the active RTCPeerConnection and start over,
            // resulting in 'User-Initiated Abort' / DataChannel disconnect loops!
            return;
        }
        if (msg.type === 'tunnel-url') return;

        if (msg.type === 'offer') {
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
            myId = msg.viewerId;
            sessionStorage.setItem('ns_viewer_id', myId);
            const nameEl = document.querySelector('#talkingMe .talking-name');
            if (nameEl) nameEl.textContent = myName + ' (You)';

            // --> START THE FAST LANE NOW THAT WE KNOW OUR ID <--
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
        if (msg.type === 'host-disconnected' || msg.type === 'host-stream-stopped') {
            _nsHostConnected = false;
            
            // Capture the exact moment the stream stopped so it doesn't go to black
            _freezeFrameForSwap();

            // Make the native HTML overlay semi-transparent so the frozen game is visible
            const overlay = document.getElementById('overlay');
            if (overlay) overlay.style.backgroundColor = 'rgba(10, 10, 12, 0.75)';
            
            showOverlay(true);
            setStatus('Host stopped streaming');
            document.getElementById('spinner').style.display = 'block';

            if (pc) { pc.close(); pc = null; }
            if (video) video.srcObject = null;
            return;
        }

        if (msg.type === 'session-full') {
            showOverlay(true);
            setStatus(`Session full — ${msg.reason || 'maximum players reached'}`);
            document.getElementById('spinner').style.display = 'none';
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
            document.getElementById('spinner').style.display = 'none';
            if (pc) { pc.close(); pc = null; }
            video.srcObject = null; return;
        }
        if (msg.type === 'ctrl-settings') {
            hostMotionEnabled = msg.enableMotion;
            window.hostAllowVR = msg.expDevices && msg.expDevices.some(d => d.enabled && d.val === 'vr');
            if (typeof maybeShowVRButton === 'function') maybeShowVRButton();
            
            if (msg.expDevices) {
                const select = document.getElementById('inputModeSelect');
                if (select) {
                    const currentVal = select.value;
                    let html = '<option value="gamepad">Standard Gamepad</option>';
                    const enabledExp = msg.expDevices.filter(d => d.enabled).map(d => d.val);
                    if (enabledExp.includes('guitar')) html += '<option value="guitar">Guitar Hero Controller</option>';
                    if (enabledExp.includes('hotas')) html += '<option value="hotas">Flight Stick / HOTAS / Wheel</option>';
                    if (enabledExp.includes('eye')) html += '<option value="eyetracking">Webcam Eye / Head Tracking</option>';
                    if (enabledExp.includes('tablet')) html += '<option value="tablet">Drawing Tablet (Stylus)</option>';
                    
                    select.innerHTML = html;
                    
                    if (Array.from(select.options).some(o => o.value === currentVal)) {
                        select.value = currentVal;
                    } else {
                        select.value = 'gamepad';
                        if (window.updateInputMode) window.updateInputMode('gamepad');
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
        if (msg.type === 'chat') { appendChat(msg.from || msg.name, msg.msg, msg.viewerId === myId); return; }
        if (msg.type === 'host-voice-cmd' && msg.targetViewerId === myId) {
            if (msg.action === 'mute') {
                forceMutedByHost = true; disableMic(); updateMicButton();
                appendChat('Nearsec', 'The host has muted your microphone.', false);
            } else {
                forceMutedByHost = false; updateMicButton();
                appendChat('Nearsec', 'The host unmuted you.', false);
            }
            return;
        }
        // Stub: handle server-sent VAD feed
        if (msg.type === 'voice-activity') { updateTalkingOverlay(msg.activeSpeakers || []); return; }
        if (msg.type === 'roster') {
            const listEl = document.getElementById('lobbyList');
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
            setTimeout(connect, 2000);
        };
    })(ws);
}

// pinRequired is declared early at the top of the file.
// For local (non-VPS) servers, check the HTTP API on load.
(function checkLocalPinRequirement() {
    const urlParams = new URLSearchParams(window.location.search);
    const useVps = location.hostname === 'publicnearcade.cutefame.net' || urlParams.has('v3') || urlParams.has('vps');
    if (!useVps) {
        safeApiJson('/api/pin-required', { required: true }).then(d => {
            pinRequired = d.required !== false;
            if (!pinRequired) {
                const wrap = document.getElementById('pinWrap');
                if (wrap) wrap.style.display = 'none';
            }
        });
    }
    // VPS pin state is handled by the early standby WebSocket at the top of this file.
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
        if (d.version && d.version !== CLIENT_VERSION) alert(`Version mismatch: Host v${d.version}, You v${CLIENT_VERSION}`);
    }).finally(() => {
        connect();
        if (!gpPolling) activateGamepad();
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
function appendChat(name, text, isMe) {
    const el = document.getElementById('chatLog');
    if (isMe) {
        const now = Date.now();
        if (text === lastChatMsg && now - lastChatTime < 1000) return;
        lastChatMsg = text; lastChatTime = now;
    }
    const d = document.createElement('div');
    d.className = 'cmsg';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'cname' + (isMe ? ' me' : '');
    nameSpan.textContent = name;
    d.appendChild(nameSpan);
    d.appendChild(document.createTextNode(text));
    el.appendChild(d); el.scrollTop = el.scrollHeight;
}
function sendChat() {
    const inp = document.getElementById('chatMsg');
    const msg = inp.value.trim();
    if (!msg || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat', from: myName, msg }));
    appendChat(myName, msg, true);
    inp.value = '';
}
function toggleChat() {
    document.getElementById('chatPanel').classList.toggle('open');
    document.getElementById('nsBar').classList.remove('open');
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
async function updateStats() {
    if (!pc) return;
    try {
        const stats = await pc.getStats();
        let rtt = null, jitter = null, kbps = null, packetsLost = 0, packetsReceived = 0;
        for (const r of stats.values()) {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null)
                rtt = (r.currentRoundTripTime * 1000).toFixed(0);
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
                packetsLost = r.packetsLost || 0;
                packetsReceived = r.packetsReceived || 1;
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
            statsHud.style.display = 'flex';

            // ── Quality tier from RTT + packet loss ──────────────────────────
            const rttN = parseInt(rtt);
            const lossRatio = packetsReceived > 0 ? (packetsLost / (packetsLost + packetsReceived)) * 100 : 0;

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
                    else videoEl.playbackRate = 1.25;
                }
                if (bufMs > 40 && bufMs > _prevJitterBufMs + 5) {
                    requestKeyframeFromHost();
                }
                _prevJitterBufMs = bufMs;
            }
        }
    } catch (_) {}
}, 500);

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
    const btn = document.getElementById('rumbleBtn');
    if (btn) {
        btn.textContent = `Rumble: ${clientRumbleEnabled ? 'ON' : 'OFF'}`;
        btn.classList.toggle('ns-btn-active', clientRumbleEnabled);
    }
}
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('rumbleBtn');
    if (btn) {
        btn.textContent = `Rumble: ${clientRumbleEnabled ? 'ON' : 'OFF'}`;
        btn.classList.toggle('ns-btn-active', clientRumbleEnabled);
    }
});

// ── WEBCODECS VIEWER INITIALIZER ──
function initWebCodecsViewer(config) {
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
        
        if (CUSTOM_WEBCODECS) {
            wcCtx = wcCanvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
            if (!wcCtx) wcCtx = wcCanvas.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
        } else {
            wcCtx = null;
        }

        if (wcCtx) {
            wcGlTexture = _setupWebGL(wcCtx);
        } else {
            wcCtx = wcCanvas.getContext('2d', { alpha: false });
            wcGlTexture = null;
        }
        
        // Ensure KBM pointer lock works on the experimental WebCodecs canvas
        if (typeof requestPointerLock === 'function') {
            wcCanvas.addEventListener('click', requestPointerLock);
        }

        wcCanvas.style.display = 'block';
    } else {
        wcCanvas.style.display = 'block';
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

    if (!wcCtx) {
        if (CUSTOM_WEBCODECS) {
            wcCtx = wcCanvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
            if (!wcCtx) wcCtx = wcCanvas.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
        }
        if (wcCtx) {
            wcGlTexture = _setupWebGL(wcCtx);
        } else {
            wcCtx = wcCanvas.getContext('2d', { alpha: false });
            wcGlTexture = null;
        }
    }

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
            // BUG 2/5 FIX: Use hardware codedWidth, and re-acquire the context after resize!
            if (wcCanvas.width !== frame.codedWidth || wcCanvas.height !== frame.codedHeight) {
                wcCanvas.width = frame.codedWidth;
                wcCanvas.height = frame.codedHeight;
                if (wcCtx && wcGlTexture) wcCtx.viewport(0, 0, wcCanvas.width, wcCanvas.height);
            }
            if (wcCtx && wcGlTexture) {
                wcCtx.activeTexture(wcCtx.TEXTURE0);
                wcCtx.bindTexture(wcCtx.TEXTURE_2D, wcGlTexture);
                wcCtx.texImage2D(wcCtx.TEXTURE_2D, 0, wcCtx.RGBA, wcCtx.RGBA, wcCtx.UNSIGNED_BYTE, frame);
                wcCtx.drawArrays(wcCtx.TRIANGLE_STRIP, 0, 4);
            } else if (wcCtx) {
                wcCtx.drawImage(frame, 0, 0, wcCanvas.width, wcCanvas.height);
            }
            frame.close();

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
        console.log('[Nearsec] Steam Deck detected — auto-entering immersive mode');
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
    if (!el) return;
    if (el.classList.contains('gone')) {
        el.classList.remove('gone');
        window.startNetStats();
    } else {
        el.classList.add('gone');
        clearInterval(netStatsInterval);
    }
};

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
            if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
                const el = document.getElementById('nsPing');
                if(el) el.textContent = (report.currentRoundTripTime * 1000).toFixed(0) + ' ms';
            }
        });
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
            btn.textContent = 'Enter VR Mode';
            btn.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:9999; padding:12px 24px; font-weight:bold; background:var(--accent); color:#000; border:none; border-radius:8px; cursor:pointer; box-shadow:0 4px 15px rgba(192,132,252,0.4); font-family:sans-serif;';
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
