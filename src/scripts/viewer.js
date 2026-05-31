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
    auto: { label: 'Auto',  maxBitrate: null,      maxHeight: null, scaleDown: 1   },
    low:  { label: 'Low',   maxBitrate: 1_500_000, maxHeight: 720,  scaleDown: 2   },
    high: { label: 'High',  maxBitrate: 8_000_000, maxHeight: 2160, scaleDown: 1   },
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
            try { await recv.setParameters(params); } catch(_) {}
        }

        // 2. Also send a hint to the host via WS so it can optionally adjust its encoder
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
                type:    'viewer-bw-hint',
                profile: _bwProfile,
                maxBitrate:  profile.maxBitrate,
                maxHeight:   profile.maxHeight,
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
let sysAudioCtx = null;
let nextAudioTime = 0;
let stopReconnect = false;
let myName = localStorage.getItem('ns_name') || 'Guest' + Math.floor(Math.random() * 9000 + 1000);
document.getElementById('nameInput').value = myName;
let enteredPin = '', audioMuted = false;
let kbEnabled = false;

// ── VOICE CHAT STATE ──────────────────────────────────────────────────────────
let localMicStream = null;
let micSender      = null;
let micEnabled     = false;
let forceMutedByHost = false;

// Voice Activity Detection
let vadAudioCtx    = null;
let vadAnalyser    = null;
let vadSource      = null;
let vadRafId       = null;
const VAD_THRESHOLD = 18;   // RMS energy level (0-255)
const VAD_HOLD_MS   = 800;  // ms to hold "talking" indicator after silence
let vadTalkingTimer = null;
let vadIsTalking    = false;
// ─────────────────────────────────────────────────────────────────────────────

const CONTROLLER_GUIDE_STORAGE_KEY = 'ns_controller_guide_ack';
const CLIENT_VERSION = window.NEARSEC_VERSION || '1.0.0';

document.addEventListener('click', unlockAudio, { once: true, passive: true });
document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });

function unlockAudio() {
    if (!sysAudioCtx) sysAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (sysAudioCtx.state === 'suspended') sysAudioCtx.resume();
    console.log('[Audio] Engine Unlocked by user gesture');
}

function openControllerGuide()  { document.getElementById('controllerGuideModal').classList.remove('hidden'); }
function closeControllerGuide() { document.getElementById('controllerGuideModal').classList.add('hidden'); }
function acknowledgeControllerGuide() {
    closeControllerGuide();
}
function maybeShowControllerGuide() {
    // Always show guide for viewers so they can configure inputs
    setTimeout(() => openControllerGuide(), 700);
}
// ── PEER CONNECTION ───────────────────────────────────────────────────────────
async function createPC() {
    if (pc) { try { pc.close(); } catch (e) {} }
    console.log('[WebRTC] Initializing new PeerConnection...');

    pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ],
        bundlePolicy:   'max-bundle',
        rtcpMuxPolicy:  'require',
        sdpSemantics:   'unified-plan'
    });

    pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] Connection State: ${pc.connectionState}`);
        if (pc.connectionState === 'failed')      setStatus('Connection failed. Retrying...');
        if (pc.connectionState === 'disconnected') console.warn('[WebRTC] Disconnected.');
    };
    pc.oniceconnectionstatechange = () => console.log(`[WebRTC] ICE State: ${pc.iceConnectionState}`);
    pc.onsignalingstatechange     = () => console.log(`[WebRTC] Signaling State: ${pc.signalingState}`);
    pc.onicecandidateerror        = (e) => console.error('[WebRTC] ICE Error:', e);

    pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ice-viewer', candidate: e.candidate, viewerId: myId }));
        }
    };

    pc.ontrack = (e) => {
        console.log(`[WebRTC] Received Track: ${e.track.kind}`);
        if (e.track.kind === 'video') {
            const video = document.getElementById('preview') || document.querySelector('video');
            if (video) {
                video.srcObject = e.streams[0];
                if (typeof showOverlay === 'function') showOverlay(false);
                setStatus('');
                const spinner = document.getElementById('spinner');
                if (spinner) spinner.style.display = 'none';
                console.log('[WebRTC] Video stream attached!');
            }
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
    streamVol:   parseFloat(localStorage.getItem('ns_vol_stream')  ?? '1.0'),
    micGain:     parseFloat(localStorage.getItem('ns_vol_micgain') ?? '1.0'),
    selfMonitor: parseFloat(localStorage.getItem('ns_vol_selfmon') ?? '0.0'),
    othersVol:   parseFloat(localStorage.getItem('ns_vol_others')  ?? '1.0'),
};

document.addEventListener('DOMContentLoaded', () => {
    const sv = document.getElementById('streamVolSlider');
    const sg = document.getElementById('micGainSlider');
    const sm = document.getElementById('selfMonitorSlider');
    const ov = document.getElementById('othersVolSlider');
    if (sv) { sv.value = Math.round(_audioPrefs.streamVol   * 100); const d = document.getElementById('streamVolVal');   if (d) d.textContent = sv.value; }
    if (sg) { sg.value = Math.round(_audioPrefs.micGain     * 100); const d = document.getElementById('micGainVal');     if (d) d.textContent = sg.value; }
    if (sm) { sm.value = Math.round(_audioPrefs.selfMonitor * 100); const d = document.getElementById('selfMonitorVal'); if (d) d.textContent = sm.value; }
    if (ov) { ov.value = Math.round(_audioPrefs.othersVol   * 100); const d = document.getElementById('othersVolVal');   if (d) d.textContent = ov.value; }
    // Apply stream volume to video immediately
    const videoEl = document.getElementById('video');
    if (videoEl) videoEl.volume = _audioPrefs.streamVol;
});

// Stream volume
function setStreamVolume(val) {
    const v = parseInt(val, 10);
    _audioPrefs.streamVol = v / 100;
    localStorage.setItem('ns_vol_stream', _audioPrefs.streamVol);
    const videoEl = document.getElementById('video');
    if (videoEl) videoEl.volume = _audioPrefs.streamVol;
    const display = document.getElementById('streamVolVal');
    if (display) display.textContent = v;
    if (v > 0 && audioMuted) {
        audioMuted = false;
        if (videoEl?.srcObject) videoEl.srcObject.getAudioTracks().forEach(t => { t.enabled = true; });
        const btn = document.getElementById('audBtn');
        if (btn) { btn.textContent = 'Stream Audio'; btn.className = 'ns-bar-btn ns-btn-active'; }
    }
}

// Mic gain
let micGainNode  = null;
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
let selfMonitorSrc  = null;
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
        selfMonitorSrc  = sysAudioCtx.createMediaStreamSource(localMicStream);
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
    if (selfMonitorSrc)  { try { selfMonitorSrc.disconnect();  } catch {} selfMonitorSrc  = null; }
    if (selfMonitorGain) { try { selfMonitorGain.disconnect(); } catch {} selfMonitorGain = null; }
    const slider = document.getElementById('selfMonitorSlider');
    const valEl  = document.getElementById('selfMonitorVal');
    if (slider) slider.value = 0;
    if (valEl)  valEl.textContent = '0';
    _audioPrefs.selfMonitor = 0;
    localStorage.setItem('ns_vol_selfmon', '0');
}

// Audio panel toggle (floating bottom-right button)
function toggleAudioPanel() {
    const panel = document.getElementById('audioPanel');
    const btn   = document.getElementById('audioBtn');
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
    try { if (vadSource)   { vadSource.disconnect();  vadSource   = null; } } catch {}
    try { if (vadAudioCtx) { vadAudioCtx.close();     vadAudioCtx = null; } } catch {}
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
function preferReceiverCodec(transceiver) {
    const caps = RTCRtpReceiver.getCapabilities?.('video');
    if (!caps || !transceiver) return null;
    const sorted = [
        ...CODEC_PRIORITY.flatMap(mime => caps.codecs.filter(c => c.mimeType === mime)),
        ...caps.codecs.filter(c => !CODEC_PRIORITY.includes(c.mimeType))
    ];
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
    'KeyW':'KEY_W','KeyA':'KEY_A','KeyS':'KEY_S','KeyD':'KEY_D',
    'ArrowUp':'KEY_UP','ArrowDown':'KEY_DOWN','ArrowLeft':'KEY_LEFT','ArrowRight':'KEY_RIGHT',
    'Space':'KEY_SPACE','Enter':'KEY_ENTER','Escape':'KEY_ESC',
    'ShiftLeft':'KEY_LEFTSHIFT','ControlLeft':'KEY_LEFTCTRL','Tab':'KEY_TAB',
    'KeyQ':'KEY_Q','KeyE':'KEY_E','KeyR':'KEY_R','KeyF':'KEY_F','KeyC':'KEY_C',
    'KeyZ':'KEY_Z','KeyX':'KEY_X','KeyV':'KEY_V','KeyB':'KEY_B','Digit1':'KEY_1','Digit2':'KEY_2',
    // ── NEW FULL ALPHABET & NUMBERS ──
    'KeyT':'KEY_T','KeyY':'KEY_Y','KeyU':'KEY_U','KeyI':'KEY_I','KeyO':'KEY_O','KeyP':'KEY_P',
    'KeyG':'KEY_G','KeyH':'KEY_H','KeyJ':'KEY_J','KeyK':'KEY_K','KeyL':'KEY_L',
    'KeyM':'KEY_M','KeyN':'KEY_N',
    'Digit3':'KEY_3','Digit4':'KEY_4','Digit5':'KEY_5','Digit6':'KEY_6',
    'Digit7':'KEY_7','Digit8':'KEY_8','Digit9':'KEY_9','Digit0':'KEY_0',
    'Minus':'KEY_MINUS','Equal':'KEY_EQUAL','Backspace':'KEY_BACKSPACE',
    'BracketLeft':'KEY_LEFTBRACE','BracketRight':'KEY_RIGHTBRACE','Backslash':'KEY_BACKSLASH',
    'Semicolon':'KEY_SEMICOLON','Quote':'KEY_APOSTROPHE','Comma':'KEY_COMMA',
    'Period':'KEY_DOT','Slash':'KEY_SLASH','AltLeft':'KEY_LEFTALT','Capslock':'KEY_CAPSLOCK'
};
const mouseMap = { 0:'BTN_LEFT', 1:'BTN_MIDDLE', 2:'BTN_RIGHT' };

function sendKbm(data) {
    if (ws && ws.readyState === 1 && document.pointerLockElement) {
        data.type = 'keyboard';
        ws.send(JSON.stringify(data));
    }
}
function requestPointerLock() {
    if (!kbEnabled) return;
    if (!document.pointerLockElement) {
        const c = document.getElementById('video-container') || document.body;
        // FIX: Make it safe for Firefox (which doesn't return a Promise)
        const promise = c.requestPointerLock();
        if (promise && typeof promise.catch === 'function') {
            promise.catch(() => {});
        }
    }
}
frameCanvas.addEventListener('click', requestPointerLock);
video.addEventListener('click', requestPointerLock);
document.addEventListener('click', e => { if (e.target === frameCanvas || e.target === video) requestPointerLock(); });
document.addEventListener('keydown', e => { if (!document.pointerLockElement) return; if (keyMap[e.code]) { e.preventDefault(); sendKbm({ event:'keydown', key:keyMap[e.code] }); } });
document.addEventListener('keyup',   e => { if (!document.pointerLockElement) return; if (keyMap[e.code]) { e.preventDefault(); sendKbm({ event:'keyup',   key:keyMap[e.code] }); } });
document.addEventListener('mousemove', e => { if (!document.pointerLockElement) return; sendKbm({ event:'mousemove', dx:e.movementX, dy:e.movementY }); });
document.addEventListener('mousedown', e => { if (!document.pointerLockElement) return; if (mouseMap[e.button]) sendKbm({ event:'keydown', key:mouseMap[e.button] }); });
document.addEventListener('mouseup',   e => { if (!document.pointerLockElement) return; if (mouseMap[e.button]) sendKbm({ event:'keyup',   key:mouseMap[e.button] }); });

// ── TOUCH ─────────────────────────────────────────────────────────────────────
let touchMode = false, useGyro = false;
const touchState = {
    axes: [0,0,0,0],
    buttons: new Array(17).fill(0).map(() => ({ pressed:false, value:0 }))
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
        try { const s = await DeviceOrientationEvent.requestPermission(); if (s === 'granted') useGyro = !useGyro; } catch(e) {}
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
    el.addEventListener('touchstart', e => { e.preventDefault(); touchState.buttons[el.dataset.btn].pressed = true; touchState.buttons[el.dataset.btn].value = 1; el.style.transform = 'scale(0.9)'; }, {passive:false});
    el.addEventListener('touchend',   e => { e.preventDefault(); touchState.buttons[el.dataset.btn].pressed = false; touchState.buttons[el.dataset.btn].value = 0; el.style.transform = 'scale(1)'; }, {passive:false});
});

const jBase = document.getElementById('jBase');
const jStick = document.getElementById('jStick');
let jBaseRect = null;
function updateStick(touch) {
    if (!jBaseRect) return;
    const cx = jBaseRect.left + jBaseRect.width/2, cy = jBaseRect.top + jBaseRect.height/2, max = jBaseRect.width/2;
    let dx = touch.clientX - cx, dy = touch.clientY - cy;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > max) { dx = (dx/dist)*max; dy = (dy/dist)*max; }
    jStick.style.transform = `translate(${dx}px,${dy}px)`;
    touchState.axes[0] = dx/max; touchState.axes[1] = dy/max;
}
if (jBase) {
    jBase.addEventListener('touchstart', e => { e.preventDefault(); jBaseRect = jBase.getBoundingClientRect(); updateStick(e.touches[0]); }, {passive:false});
    jBase.addEventListener('touchmove',  e => { e.preventDefault(); updateStick(e.touches[0]); }, {passive:false});
    jBase.addEventListener('touchend',   e => { e.preventDefault(); jStick.style.transform = 'translate(0px,0px)'; touchState.axes[0] = 0; touchState.axes[1] = 0; }, {passive:false});
}

// ── HID GYRO ──────────────────────────────────────────────────────────────────
let hidDevice = null, hostMotionEnabled = false, hidGyroX = 0, hidGyroY = 0;
async function requestHID() {
    if (!('hid' in navigator)) { alert('WebHID not supported. Use Chrome/Edge.'); return; }
    try {
        const devices = await navigator.hid.requestDevice({ filters: [{ vendorId:0x054c },{ vendorId:0x057e }] });
        if (devices.length > 0) {
            hidDevice = devices[0]; await hidDevice.open();
            hidDevice.addEventListener('inputreport', handleHIDReport);
            const btn = document.getElementById('hidBtn');
            if (btn) { btn.classList.add('ns-btn-active'); btn.textContent = 'Gyro HID: ON'; }
        }
    } catch(err) { console.error('HID failed:', err); }
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
        hidGyroX = data.getInt16(off+2, true) / 15000.0;
        hidGyroY = data.getInt16(off,   true) / 15000.0;
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
        if (k && k.startsWith(PREFIX)) { try { calibMaps[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k)); } catch {} }
    }
})();
window.addEventListener('message', e => {
    if (e.data?.type === 'NEARSEC_CONFIG_UPDATE' && e.data.hardwareId) calibMaps[e.data.hardwareId] = e.data.map;
});
function applyCalibration(gp, state) {
    const safeId = gp.id.replace(/[^a-zA-Z0-9_\-]/g,'_').slice(0,60);
    const m = calibMaps[safeId];
    if (!m) return;
    if (m.rsx != null) state.axes[2] = Math.round((gp.axes[m.rsx]||0)*32767);
    if (m.rsy != null) state.axes[3] = Math.round((gp.axes[m.rsy]||0)*32767);
    function readTrigger(mp) {
        if (!mp) return 0;
        if (mp.type==='btn') return Math.round((gp.buttons[mp.idx]?.value||0)*255);
        const raw = gp.axes[mp.idx] ?? -1;
        const norm = Math.max(0,(raw+1)/2);
        return norm < 0.05 ? 0 : Math.round(norm*255);
    }
    const lt = readTrigger(m.lt), rt = readTrigger(m.rt);
    if (lt > 0 || m.lt) state.buttons[6] = { pressed: lt>10, value: lt };
    if (rt > 0 || m.rt) state.buttons[7] = { pressed: rt>10, value: rt };
}

// ── GAMEPAD POLLING ───────────────────────────────────────────────────────────
let gpPolling = false, lastGpStr = {}, lastGpSend = {};
let sentGpid = new Set();

function activateGamepad() {
    if (gpPolling) return;
    gpPolling = true;
    const pmt = document.getElementById('gpPrompt');
    if (pmt) { pmt.classList.add('active'); pmt.textContent = 'Grab A Gamepad!'; }
    setInterval(pollGamepad, 4);
}

function pollGamepad() {
    if (!gpPolling) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const now = Date.now();
    for (const gp of pads) {
        if (!gp) continue;
        if (!sentGpid.has(gp.index) && ws?.readyState === 1) {
            let cleanName = gp.id.replace(/^[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-/,'').replace(/\(.*?\)/g,'').replace(/[^a-zA-Z0-9 -]/g,'').trim() || 'Standard Controller';
            ws.send(JSON.stringify({ type:'gpid', padIndex:gp.index, id:gp.id, name:cleanName }));
            sentGpid.add(gp.index);
        }
        const forceHb = now - (lastGpSend[gp.index]||0) > 100;
        const state = { type:'gamepad', padIndex:gp.index, axes:Array.from(gp.axes).map(v=>Math.round(v*32767)), buttons:gp.buttons.map(b=>({ pressed:b.pressed, value:Math.round(b.value*255) })) };
        applyCalibration(gp, state);
        if (hidDevice && hostMotionEnabled) {
            state.axes[2] = Math.max(-32767, Math.min(32767, state.axes[2] + Math.round(hidGyroX*32767)));
            state.axes[3] = Math.max(-32767, Math.min(32767, state.axes[3] + Math.round(hidGyroY*32767)));
        }
        const str = JSON.stringify(state);
        if (str !== lastGpStr[gp.index] || forceHb) { lastGpStr[gp.index] = str; lastGpSend[gp.index] = now; if (ws?.readyState===1) ws.send(str); }
    }
    if (touchMode) {
        const vIndex = 99;
        if (!sentGpid.has(vIndex) && ws?.readyState===1) {
            ws.send(JSON.stringify({ type:'gpid', padIndex:vIndex, id:'virtual-touch', name:'Mobile Touch Controls' }));
            sentGpid.add(vIndex);
        }
        const state = { type:'gamepad', padIndex:vIndex, axes:touchState.axes.map(v=>Math.round(v*32767)), buttons:touchState.buttons.map(b=>({ pressed:b.pressed, value:Math.round(b.value*255) })) };
        const str = JSON.stringify(state);
        const forceHb = now - (lastGpSend[vIndex]||0) > 100;
        if (str !== lastGpStr[vIndex] || forceHb) { lastGpStr[vIndex] = str; lastGpSend[vIndex] = now; if (ws?.readyState===1) ws.send(str); }
    }
}

['click','touchstart','keydown'].forEach(ev => document.addEventListener(ev, () => { if (!gpPolling) activateGamepad(); }, { once:true, passive:true }));
window.addEventListener('gamepadconnected', e => {
    if (!gpPolling) activateGamepad();
    document.getElementById('gpPrompt')?.classList.add('gone');
    let cleanName = e.gamepad.id.replace(/^[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-/,'').replace(/\(.*?\)/g,'').replace(/[^a-zA-Z0-9 -]/g,'').trim() || 'Standard Controller';
    if (ws?.readyState===1) ws.send(JSON.stringify({ type:'gpid', padIndex:e.gamepad.index, id:e.gamepad.id, name:cleanName }));
});

// ── STATUS / OVERLAY ──────────────────────────────────────────────────────────
function log(msg) { console.log(msg); }
function setStatus(msg, live) {
    document.getElementById('overlayStatus').textContent = msg;
    document.getElementById('topStatus').textContent = msg;
    if (live) document.getElementById('liveDot').style.display = 'inline-block';
}
function showOverlay(v) { document.getElementById('overlay').classList.toggle('gone', !v); }

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
async function connect() {
    let wsUrl = `${proto}://${host}/ws/viewer`;
    if (enteredPin) wsUrl += `?pin=${encodeURIComponent(enteredPin)}`;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    stopReconnect = false;

    ws.onopen = () => ws.send(JSON.stringify({ type:'join', viewerId:myId, name:myName, pin:enteredPin, clientVersion:CLIENT_VERSION }));

    ws.onmessage = async (e) => {
        // Binary audio
        if (e.data instanceof ArrayBuffer) {
            if (!sysAudioCtx || sysAudioCtx.state !== 'running') return;
            try {
                let safeLen = e.data.byteLength - (e.data.byteLength % 2);
                if (!safeLen) return;
                const int16   = new Int16Array(e.data.slice(0, safeLen));
                const float32 = new Float32Array(int16.length);
                for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;
                const buf = sysAudioCtx.createBuffer(1, float32.length, 48000);
                buf.getChannelData(0).set(float32);
                const src = sysAudioCtx.createBufferSource();
                src.buffer = buf; src.connect(sysAudioCtx.destination);
                if (nextAudioTime < sysAudioCtx.currentTime) nextAudioTime = sysAudioCtx.currentTime + 0.1;
                src.start(nextAudioTime);
                nextAudioTime += buf.duration;
            } catch(err) { console.error('[Audio] Playback error:', err); }
            return;
        }

        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'host-connected') {
            if (pc) { try { pc.close(); } catch {} pc = null; }
            const videoEl = document.getElementById('video');
            if (videoEl?.srcObject) { videoEl.srcObject.getTracks().forEach(t=>t.stop()); videoEl.srcObject = null; }
            document.getElementById('frameCanvas').style.display = 'none';
            processorRunning = false;
            showOverlay(true); setStatus('Host reconnected, waiting for stream...');
            document.getElementById('spinner').style.display = 'block';
            setTimeout(() => ws?.readyState===1 && ws.send(JSON.stringify({ type:'request-offer' })), 800);
            return;
        }
        if (msg.type === 'tunnel-url') return;

        if (msg.type === 'offer') {
            if (pc) { try { pc.close(); } catch {} pc = null; }
            await createPC();
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                pc._remoteSet = true;
                for (const c of (pc._iceBuf||[])) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
                pc._iceBuf = [];
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ type:'answer', sdp:pc.localDescription }));
                // Apply bandwidth profile now that transceivers are negotiated
                _applyBwProfile(pc);
            } catch(err) { console.error('[webrtc] offer error:', err.message); try { pc.close(); } catch {} pc = null; }
            return;
        }
        if (msg.type === 'ice-host' && msg.candidate) {
            if (!pc) return;
            if (pc._remoteSet) { try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {} }
            else { pc._iceBuf = pc._iceBuf||[]; pc._iceBuf.push(msg.candidate); }
            return;
        }
        if (msg.type === 'pin-required') { document.getElementById('pinScreen').classList.remove('gone'); return; }
        if (msg.type === 'pin-rejected') {
            stopReconnect = true;
            document.getElementById('pinScreen').classList.remove('gone');
            document.getElementById('pinErr').textContent = msg.reason === 'kicked' ? 'You were kicked by the Host.' : 'Incorrect PIN.';
            document.getElementById('pinInput').value = '';
            if (msg.reason === 'kicked') ws.close();
            return;
        }
        if (msg.type === 'your-id') {
            myId = msg.viewerId;
            sessionStorage.setItem('ns_viewer_id', myId);
            const nameEl = document.querySelector('#talkingMe .talking-name');
            if (nameEl) nameEl.textContent = myName + ' (You)';
            return;
        }
        if (msg.type === 'host-stream-ready') { setStatus('Host found, connecting...'); maybeShowControllerGuide(); return; }
        if (msg.type === 'host-disconnected' || msg.type === 'host-stream-stopped') {
            showOverlay(true); setStatus('Host stopped streaming');
            if (pc) { pc.close(); pc = null; }
            video.srcObject = null; return;
        }
        if (msg.type === 'host-not-streaming') {
            showOverlay(true); setStatus('Host is not sharing their screen yet...');
            document.getElementById('spinner').style.display = 'none';
            if (pc) { pc.close(); pc = null; }
            video.srcObject = null; return;
        }
        if (msg.type === 'ctrl-settings') {
            hostMotionEnabled = msg.enableMotion;
            const hBtn = document.getElementById('hidBtn');
            if (hBtn) hBtn.style.display = hostMotionEnabled ? 'block' : 'none';
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
                        if (!hostAdded) { listEl.innerHTML += `<div class="roster-item"><span>👑 Host</span><span class="roster-badge">Streaming</span></div>`; hostAdded = true; }
                        const isMe = baseId === myId;
                        listEl.innerHTML += `<div class="roster-item${isMe?' roster-me':''}">${v.name.replace(/ \d+$/,'')} ${isMe?'(You)':''}</div>`;
                    }
                });
            }
            return;
        }
    };

    ws.onclose = event => {
        const AUTH_CODES = new Set([4001,4002,4003]);
        if (AUTH_CODES.has(event.code) || stopReconnect) {
            document.getElementById('pinScreen').classList.remove('gone');
            const errEl = document.getElementById('pinErr');
            if (errEl) errEl.textContent = event.code===4003 ? 'You were kicked by the host.' : event.code===4001 ? 'Too many attempts. Wait 2 minutes.' : 'Incorrect PIN.';
            document.getElementById('pinInput').value = '';
            enteredPin = ''; stopReconnect = false; return;
        }
        setTimeout(connect, 2000);
    };
}

let pinRequired = false;
fetch('/api/pin-required').then(r=>r.json()).then(d => {
    pinRequired = d.required;
    if (!d.required) document.getElementById('pinWrap').style.display = 'none';
}).catch(() => document.getElementById('pinWrap').style.display = 'none');

function submitPin() {
    const nameVal = document.getElementById('nameInput').value.trim();
    if (nameVal) { myName = nameVal; localStorage.setItem('ns_name', myName); }
    if (pinRequired) {
        const val = document.getElementById('pinInput').value.trim();
        if (val.length !== 4) { document.getElementById('pinErr').textContent = 'Enter 4 digits'; return; }
        enteredPin = val;
    }
    document.getElementById('pinErr').textContent = '';
    document.getElementById('pinScreen').classList.add('gone');
    fetch('/api/info').then(r=>r.json()).then(d => {
        if (d.version && d.version !== CLIENT_VERSION) alert(`Version mismatch: Host v${d.version}, You v${CLIENT_VERSION}`);
        connect(); if (!gpPolling) activateGamepad();
    }).catch(() => { connect(); if (!gpPolling) activateGamepad(); });
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
    d.innerHTML = `<span class="cname${isMe?' me':''}">${name}</span>${text}`;
    el.appendChild(d); el.scrollTop = el.scrollHeight;
}
function sendChat() {
    const inp = document.getElementById('chatMsg');
    const msg = inp.value.trim();
    if (!msg || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type:'chat', from:myName, msg }));
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
    } catch {}
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
        let rtt = null, jitter = null, kbps = null;
        for (const r of stats.values()) {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = (r.currentRoundTripTime * 1000).toFixed(0);
            if (r.type === 'inbound-rtp' && r.kind === 'video' && prevStatsTime) {
                const eDelta = (r.jitterBufferEmittedCount||1) - prevEmitted;
                if (eDelta > 0) jitter = (((r.jitterBufferDelay||0) - prevJitterDelay) / eDelta * 1000).toFixed(0);
                kbps = (((r.bytesReceived - prevBytesReceived) * 8) / ((r.timestamp - prevStatsTime) / 1000) / 1000).toFixed(0);
                prevBytesReceived = r.bytesReceived; prevStatsTime = r.timestamp;
                prevJitterDelay = r.jitterBufferDelay||0; prevEmitted = r.jitterBufferEmittedCount||1;
            } else if (r.type === 'inbound-rtp' && r.kind === 'video') {
                prevBytesReceived = r.bytesReceived; prevStatsTime = r.timestamp;
                prevJitterDelay = r.jitterBufferDelay||0; prevEmitted = r.jitterBufferEmittedCount||1;
            }
        }
        if (rtt !== null) {
            statsHud.style.display = 'flex';
            statsHud.textContent = [rtt+'ms RTT', jitter&&jitter+'ms buf', kbps&&kbps+'kbps'].filter(Boolean).join(' · ');
        }
    } catch {}
}
setInterval(updateStats, 2000);

// ── FULLSCREEN ────────────────────────────────────────────────────────────────
function landscape() { if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(()=>{}); }
function toggleFS() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().then(landscape).catch(()=>{});
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
        document.documentElement.requestFullscreen().then(landscape).catch(()=>{});
        const immBtn = document.getElementById('immersiveBtn');
        if (immBtn) immBtn.style.display = 'none';
    }
})();

// ── SIDE BAR FADE ─────────────────────────────────────────────────────────────
(function() {
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
        if (Math.sqrt(dx*dx+dy*dy) < 14) return;
        lastX = e.clientX; lastY = e.clientY;
        showBtn();
    }, { passive:true });
    showBtn();
})();
