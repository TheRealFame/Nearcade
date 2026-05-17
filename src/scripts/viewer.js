const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const host = location.host;
let ws, pc, myId = sessionStorage.getItem('ns_viewer_id');
let myName = localStorage.getItem('ns_name') || 'Guest' + Math.floor(Math.random() * 9000 + 1000);
document.getElementById('nameInput').value = myName;
const CLIENT_VERSION = "1.0.0";
let enteredPin = '', audioMuted = false;
let kbEnabled = false;

const CONTROLLER_GUIDE_STORAGE_KEY = 'ns_controller_guide_ack';

function openControllerGuide() { document.getElementById('controllerGuideModal').classList.remove('hidden'); }
function closeControllerGuide() { document.getElementById('controllerGuideModal').classList.add('hidden'); }
function acknowledgeControllerGuide() {
    closeControllerGuide();
}
function maybeShowControllerGuide() {
    setTimeout(() => { openControllerGuide(); }, 700);
}

async function createPC() {
    if (pc) {
        try { pc.close(); } catch (e) {}
    }

    pc = new RTCPeerConnection({
        // ── CRITICAL FIX: Removed dead TURN servers to fix 15-second timeouts ──
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        sdpSemantics: 'unified-plan'
    });

    pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ice-viewer', candidate: e.candidate }));
        }
    };

    pc.ontrack = (e) => {
        try {
            if (e.receiver) e.receiver.playoutDelayHint = 0.035;
        } catch (err) {}

        const track = e.track;
        preferReceiverCodec(e.transceiver);

        if (track.kind === 'video') {
            startFrameProcessor(track);
        } else if (track.kind === 'audio') {
            if (!video.srcObject) video.srcObject = new MediaStream();
            video.srcObject.addTrack(track);
        }
    };

    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') {
            setStatus('Live', true);
            document.getElementById('overlay').classList.add('gone');
            document.getElementById('spinner').style.display = 'none';
        } else if (s === 'disconnected' || s === 'failed') {
            setStatus('Connection lost...');
            document.getElementById('overlay').classList.remove('gone');
            document.getElementById('spinner').style.display = 'block';
        }
    };
}

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
    video.style.opacity = '0';
    video.style.position = 'absolute';
    video.style.pointerEvents = 'none';

    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    let pending = null;
    let firstFrame = true;

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
            frameCanvas.width = pending.displayWidth;
            frameCanvas.height = pending.displayHeight;
        }
        frameCtx.drawImage(pending, 0, 0);
        pending.close();
        pending = null;
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
        video.style.opacity = '1';
        video.style.position = 'static';
        video.style.pointerEvents = 'auto';
    });
}

const keyMap = {
    'KeyW': 'KEY_W', 'KeyA': 'KEY_A', 'KeyS': 'KEY_S', 'KeyD': 'KEY_D',
    'ArrowUp': 'KEY_UP', 'ArrowDown': 'KEY_DOWN', 'ArrowLeft': 'KEY_LEFT', 'ArrowRight': 'KEY_RIGHT',
    'Space': 'KEY_SPACE', 'Enter': 'KEY_ENTER', 'Escape': 'KEY_ESC',
    'ShiftLeft': 'KEY_LEFTSHIFT', 'ControlLeft': 'KEY_LEFTCTRL', 'Tab': 'KEY_TAB',
    'KeyQ': 'KEY_Q', 'KeyE': 'KEY_E', 'KeyR': 'KEY_R', 'KeyF': 'KEY_F', 'KeyC': 'KEY_C',
    'KeyZ': 'KEY_Z', 'KeyX': 'KEY_X', 'KeyV': 'KEY_V', 'KeyB': 'KEY_B', 'Digit1': 'KEY_1', 'Digit2': 'KEY_2'
};
const mouseMap = { 0: 'BTN_LEFT', 1: 'BTN_MIDDLE', 2: 'BTN_RIGHT' };

function sendKbm(data) {
    if (ws && ws.readyState === 1 && document.pointerLockElement) {
        data.type = 'keyboard';
        ws.send(JSON.stringify(data));
    }
}

function requestPointerLock() {
    if (!kbEnabled) return;
    if (!document.pointerLockElement) {
        const container = document.getElementById('video-container') || document.body;
        container.requestPointerLock().catch(() => {});
    }
}
frameCanvas.addEventListener('click', requestPointerLock);
video.addEventListener('click', requestPointerLock);

document.addEventListener('click', (e) => {
    if (e.target === frameCanvas || e.target === video) {
        requestPointerLock();
    }
});

document.addEventListener('keydown', e => {
    if (!document.pointerLockElement) return;
    if (keyMap[e.code]) { e.preventDefault(); sendKbm({ event: 'keydown', key: keyMap[e.code] }); }
});
document.addEventListener('keyup', e => {
    if (!document.pointerLockElement) return;
    if (keyMap[e.code]) { e.preventDefault(); sendKbm({ event: 'keyup', key: keyMap[e.code] }); }
});
document.addEventListener('mousemove', e => {
    if (!document.pointerLockElement) return;
    sendKbm({ event: 'mousemove', dx: e.movementX, dy: e.movementY });
});
document.addEventListener('mousedown', e => {
    if (!document.pointerLockElement) return;
    if (mouseMap[e.button]) sendKbm({ event: 'keydown', key: mouseMap[e.button] });
});
document.addEventListener('mouseup', e => {
    if (!document.pointerLockElement) return;
    if (mouseMap[e.button]) sendKbm({ event: 'keyup', key: mouseMap[e.button] });
});

let touchMode = false;
let useGyro = false;

const touchState = {
    axes: [0, 0, 0, 0],
    buttons: new Array(17).fill(0).map(() => ({ pressed: false, value: 0 }))
};

function toggleTouch() {
    touchMode = !touchMode;
    document.getElementById('touchUI').classList.toggle('gone', !touchMode);
    document.getElementById('touchToggleBtn').style.color = touchMode ? 'var(--accent)' : '';
    document.getElementById('bar').classList.remove('open');
}

const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
if (isMobileDevice) {
    touchMode = true;
    document.addEventListener("DOMContentLoaded", () => {
        const tUI = document.getElementById('touchUI');
        const tBtn = document.getElementById('touchToggleBtn');
        if (tUI) tUI.classList.remove('gone');
        if (tBtn) tBtn.style.color = 'var(--accent)';
    });
}

async function toggleGyro() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            const permissionState = await DeviceOrientationEvent.requestPermission();
            if (permissionState === 'granted') useGyro = !useGyro;
        } catch(e) { console.error(e); }
    } else {
        useGyro = !useGyro;
    }
    const btn = document.getElementById('gyroToggleBtn');
    btn.textContent = 'Aim Gyro: ' + (useGyro ? 'ON' : 'OFF');
    btn.style.color = useGyro ? 'var(--accent)' : 'white';
    btn.style.borderColor = useGyro ? 'var(--accent)' : 'rgba(255,255,255,0.08)';

    if (!useGyro) {
        touchState.axes[2] = 0;
        touchState.axes[3] = 0;
    }
}

window.addEventListener('deviceorientation', (e) => {
    if (!useGyro || !touchMode) return;
    let rx = e.gamma / 45.0;
    let ry = (e.beta - 45) / 45.0;
    touchState.axes[2] = Math.max(-1, Math.min(1, rx));
    touchState.axes[3] = Math.max(-1, Math.min(1, ry));
});

document.querySelectorAll('[data-btn]').forEach(el => {
    el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        touchState.buttons[el.dataset.btn].pressed = true;
        touchState.buttons[el.dataset.btn].value = 1;
        el.style.transform = 'scale(0.9)';
    }, {passive: false});

    el.addEventListener('touchend', (e) => {
        e.preventDefault();
        touchState.buttons[el.dataset.btn].pressed = false;
        touchState.buttons[el.dataset.btn].value = 0;
        el.style.transform = 'scale(1)';
    }, {passive: false});
});

const jBase = document.getElementById('jBase');
const jStick = document.getElementById('jStick');
let jBaseRect = null;

function updateStick(touch) {
    if (!jBaseRect) return;
    const centerX = jBaseRect.left + jBaseRect.width / 2;
    const centerY = jBaseRect.top + jBaseRect.height / 2;
    const maxDist = jBaseRect.width / 2;

    let dx = touch.clientX - centerX;
    let dy = touch.clientY - centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > maxDist) {
        dx = (dx / dist) * maxDist;
        dy = (dy / dist) * maxDist;
    }

    jStick.style.transform = `translate(${dx}px, ${dy}px)`;
    touchState.axes[0] = dx / maxDist;
    touchState.axes[1] = dy / maxDist;
}

if (jBase) {
    jBase.addEventListener('touchstart', (e) => {
        e.preventDefault();
        jBaseRect = jBase.getBoundingClientRect();
        updateStick(e.touches[0]);
    }, {passive: false});

    jBase.addEventListener('touchmove', (e) => {
        e.preventDefault();
        updateStick(e.touches[0]);
    }, {passive: false});

    jBase.addEventListener('touchend', (e) => {
        e.preventDefault();
        jStick.style.transform = `translate(0px, 0px)`;
        touchState.axes[0] = 0;
        touchState.axes[1] = 0;
    }, {passive: false});
}

let hidDevice = null;
let hostMotionEnabled = false;
let hidGyroX = 0, hidGyroY = 0;

async function requestHID() {
    if (!('hid' in navigator)) {
        alert('WebHID is not supported in this browser. Please use Chrome/Edge on Desktop/Android.');
        return;
    }
    try {
        const devices = await navigator.hid.requestDevice({
            filters: [
                { vendorId: 0x054c },
                { vendorId: 0x057e }
            ]
        });

        if (devices.length > 0) {
            hidDevice = devices[0];
            await hidDevice.open();
            console.log('HID Device opened:', hidDevice.productName);

            hidDevice.addEventListener('inputreport', handleHIDReport);

            const btn = document.getElementById('hidBtn');
            btn.style.color = 'var(--accent)';
            btn.textContent = 'Gyro: ON';
        }
    } catch (err) {
        console.error('HID Request failed:', err);
    }
}

function handleHIDReport(event) {
    const { data, reportId } = event;
    const vendorId = hidDevice.vendorId;

    let rawPitch = 0;
    let rawYaw = 0;

    if (vendorId === 0x054c) {
        let isDualSense = hidDevice.productName.toLowerCase().includes('dualsense') || hidDevice.productId === 0x0ce6;
        let offset = 0;

        if (reportId === 0x01) offset = isDualSense ? 16 : 13;
        else if (reportId === 0x11 || reportId === 0x31) offset = isDualSense ? 15 : 14;
        else return;

        if (data.byteLength < offset + 4) return;

        rawPitch = data.getInt16(offset, true);
        rawYaw = data.getInt16(offset + 2, true);

        hidGyroX = rawYaw / 15000.0;
        hidGyroY = rawPitch / 15000.0;
    }
    else if (vendorId === 0x057e) {
        if (reportId !== 0x30) return;
        if (data.byteLength < 25) return;

        rawPitch = data.getInt16(19, true);
        rawYaw = data.getInt16(21, true);

        hidGyroX = rawYaw / 30000.0;
        hidGyroY = rawPitch / 30000.0;
    }
}

const calibMaps = {};

(function loadSavedCalibMaps() {
    const PREFIX = 'nearsec_map_';
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) {
            try { calibMaps[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k)); } catch {}
        }
    }
})();

window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'NEARSEC_CONFIG_UPDATE' && e.data.hardwareId) {
        calibMaps[e.data.hardwareId] = e.data.map;
        console.log('[calib] map updated for', e.data.hardwareId);
    }
});

function applyCalibration(gp, state) {
    const safeId = gp.id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);
    const m = calibMaps[safeId];
    if (!m) return;

    if (m.rsx != null) state.axes[2] = Math.round((gp.axes[m.rsx] || 0) * 32767);
    if (m.rsy != null) state.axes[3] = Math.round((gp.axes[m.rsy] || 0) * 32767);

    function readTrigger(mapping) {
        if (!mapping) return 0;
        if (mapping.type === 'btn') {
            return Math.round((gp.buttons[mapping.idx]?.value || 0) * 255);
        }
        const raw = gp.axes[mapping.idx] ?? -1;
        const norm = Math.max(0, (raw + 1) / 2);
        return norm < 0.05 ? 0 : Math.round(norm * 255);
    }

    const ltVal = readTrigger(m.lt);
    const rtVal = readTrigger(m.rt);
    if (ltVal > 0 || m.lt) {
        state.buttons[6] = { pressed: ltVal > 10, value: ltVal };
    }
    if (rtVal > 0 || m.rt) {
        state.buttons[7] = { pressed: rtVal > 10, value: rtVal };
    }
}

let gpPolling = false, gpRaf = null, lastGpStr = {}, lastGpSend = {};
let sentGpid = new Set();

function activateGamepad() {
    if (gpPolling) return;
    gpPolling = true;
    const pmt = document.getElementById('gpPrompt');
    if(pmt) {
        pmt.classList.add('active');
        pmt.textContent = 'Grab A Gamepad!';
    }
    setInterval(pollGamepad, 4);
}

function pollGamepad() {
    if (!gpPolling) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const now = Date.now();

    for (const gp of pads) {
        if (!gp) continue;
        if (!sentGpid.has(gp.index)) {
            if (ws && ws.readyState === 1) {
                let cleanName = gp.id.replace(/^[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-/, '').replace(/\(.*?\)/g, '').replace(/[^a-zA-Z0-9 -]/g, '').trim();
                if (!cleanName) cleanName = "Standard Controller";
                ws.send(JSON.stringify({ type: 'gpid', padIndex: gp.index, id: gp.id, name: cleanName }));
                sentGpid.add(gp.index);
            }
        }

        const forceHb = now - (lastGpSend[gp.index] || 0) > 100;
        const state = {
            type: 'gamepad',
            padIndex: gp.index,
            axes: Array.from(gp.axes).map(v => Math.round(v * 32767)),
            buttons: gp.buttons.map(b => ({ pressed: b.pressed, value: Math.round(b.value * 255) }))
        };

        applyCalibration(gp, state);

        if (hidDevice && hostMotionEnabled) {
            let newRx = state.axes[2] + Math.round(hidGyroX * 32767);
            let newRy = state.axes[3] + Math.round(hidGyroY * 32767);
            state.axes[2] = Math.max(-32767, Math.min(32767, newRx));
            state.axes[3] = Math.max(-32767, Math.min(32767, newRy));
        }

        const str = JSON.stringify(state);
        if (str !== lastGpStr[gp.index] || forceHb) {
            lastGpStr[gp.index] = str;
            lastGpSend[gp.index] = now;
            if (ws && ws.readyState === 1) ws.send(str);
        }
    }

    if (touchMode) {
        const vIndex = 99;
        if (!sentGpid.has(vIndex)) {
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'gpid', padIndex: vIndex, id: 'virtual-touch', name: 'Mobile Touch Controls' }));
                sentGpid.add(vIndex);
            }
        }
        const state = {
            type: 'gamepad',
            padIndex: vIndex,
            axes: touchState.axes.map(v => Math.round(v * 32767)),
            buttons: touchState.buttons.map(b => ({ pressed: b.pressed, value: Math.round(b.value * 255) }))
        };
        const str = JSON.stringify(state);
        const forceHb = now - (lastGpSend[vIndex] || 0) > 100;
        if (str !== lastGpStr[vIndex] || forceHb) {
            lastGpStr[vIndex] = str;
            lastGpSend[vIndex] = now;
            if (ws && ws.readyState === 1) ws.send(str);
        }
    }
}

['click', 'touchstart', 'keydown'].forEach(ev =>
document.addEventListener(ev, () => { if (!gpPolling) activateGamepad(); }, { once: true, passive: true })
);

window.addEventListener('gamepadconnected', (e) => {
    if (!gpPolling) activateGamepad();
    const pmt = document.getElementById('gpPrompt');
    if (pmt) pmt.classList.add('gone');
    let cleanName = e.gamepad.id.replace(/^[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-/, '').replace(/\(.*?\)/g, '').replace(/[^a-zA-Z0-9 -]/g, '').trim();
    if (!cleanName) cleanName = "Standard Controller";
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'gpid', padIndex: e.gamepad.index, id: e.gamepad.id, name: cleanName }));
});

function setStatus(msg, live) {
    document.getElementById('overlayStatus').textContent = msg;
    document.getElementById('topStatus').textContent = msg;
    if (live) document.getElementById('liveDot').style.display = 'inline-block';
}
function showOverlay(v) {
    document.getElementById('overlay').classList.toggle('gone', !v);
}

function connect() {
    const url = proto + '://' + host + '/ws/viewer' + (enteredPin ? '?pin=' + enteredPin : '');
    ws = new WebSocket(url);

    ws.onopen = () => {
        setStatus('Waiting for host...');
        ws.send(JSON.stringify({ type: 'set-name', name: myName }));
        if (myId) ws.send(JSON.stringify({ type: 'viewer-rejoin', viewerId: myId }));
    };

    ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);

        if (msg.type === 'pin-rejected') {
            document.getElementById('pinScreen').classList.remove('gone');
            document.getElementById('pinErr').textContent = 'Wrong PIN — try again';
            ws.close(); return;
        }
        if (msg.type === 'your-id') {
            myId = msg.viewerId;
            sessionStorage.setItem('ns_viewer_id', myId);
        }
        if (msg.type === 'host-connected') {
            setStatus('Host is online, waiting for stream...');
        }
        if (msg.type === 'host-stream-ready') {
            setStatus('Host found, connecting...');
            maybeShowControllerGuide();
        }
        if (msg.type === 'offer') {
            if (pc) {
                try { pc.close(); } catch (e) {}
                pc = null;
            }

            await createPC();

            try {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                pc._remoteSet = true;
                for (const c of (pc._iceBuf || [])) {
                    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { }
                }
                pc._iceBuf = [];
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
            } catch (e) {
                console.error('[webrtc] offer error:', e.message);
                try { pc.close(); } catch {}
                pc = null;
            }
        }
        if (msg.type === 'ice-host' && msg.candidate) {
            if (!pc) return;
            if (pc._remoteSet) {
                try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch { }
            } else {
                pc._iceBuf = pc._iceBuf || [];
                pc._iceBuf.push(msg.candidate);
            }
        }
        if (msg.type === 'host-disconnected' || msg.type === 'host-stream-stopped') {
            showOverlay(true); setStatus('Host stopped streaming');
            if (pc) { pc.close(); pc = null; }
            video.srcObject = null;
        }
        if (msg.type === 'host-not-streaming') {
            showOverlay(true); setStatus('Host is not sharing their screen yet...');
            document.getElementById('spinner').style.display = 'none';
            if (pc) { pc.close(); pc = null; }
            video.srcObject = null;
        }

        if (msg.type === 'ctrl-settings') {
            hostMotionEnabled = msg.enableMotion;
            const hBtn = document.getElementById('hidBtn');
            if(hBtn) hBtn.style.display = hostMotionEnabled ? 'block' : 'none';
        }

        if (msg.type === 'input-state') {
            kbEnabled = !!msg.kb;
            if (!kbEnabled && document.pointerLockElement) {
                document.exitPointerLock();
            }
            const hint = document.getElementById('kbmHint');
            if (hint) hint.style.display = kbEnabled ? 'inline' : 'none';
        }

        if (msg.type === 'chat') appendChat(msg.from, msg.msg, false);
    };

        ws.onclose = () => { setStatus('Reconnecting...'); setTimeout(connect, 2000); };
}

let pinRequired = false;
fetch('/api/pin-required').then(r => r.json()).then(d => {
    pinRequired = d.required;
    if (!d.required) document.getElementById('pinWrap').style.display = 'none';
}).catch(() => {
    document.getElementById('pinWrap').style.display = 'none';
});

function submitPin() {
    const nameVal = document.getElementById('nameInput').value.trim();
    if (nameVal) {
        myName = nameVal;
        localStorage.setItem('ns_name', myName);
    }

    if (pinRequired) {
        const val = document.getElementById('pinInput').value.trim();
        if (val.length !== 4) { document.getElementById('pinErr').textContent = 'Enter 4 digits'; return; }
        enteredPin = val;
    }
    document.getElementById('pinErr').textContent = '';
    document.getElementById('pinScreen').classList.add('gone');

    fetch('/api/info')
    .then(r => r.json())
    .then(d => {
        if (d.version && d.version !== CLIENT_VERSION) {
            alert(`Version mismatch: Host is using v${d.version}, but you are using v${CLIENT_VERSION}. Things might not work perfectly!`);
        }
        connect();
        if (!gpPolling) activateGamepad();
    })
    .catch(() => {
        connect();
        if (!gpPolling) activateGamepad();
    });
}

let lastChatMsg = '';
let lastChatTime = 0;

function appendChat(name, text, isMe) {
    const el = document.getElementById('chatLog');
    if (isMe) {
        const now = Date.now();
        if (text === lastChatMsg && now - lastChatTime < 1000) {
            return;
        }
        lastChatMsg = text;
        lastChatTime = now;
    }
    const d = document.createElement('div');
    d.className = 'cmsg';
    d.innerHTML = '<span class="cname' + (isMe ? ' me' : '') + '">' + name + '</span>' + text;
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
function toggleChat() { document.getElementById('chatPanel').classList.toggle('open'); }
function toggleAudio() {
    audioMuted = !audioMuted;
    if (video.srcObject) video.srcObject.getAudioTracks().forEach(t => { t.enabled = !audioMuted; });
    document.getElementById('audBtn').textContent = audioMuted ? 'Muted' : 'Audio';
}

let wakeLock = null;
async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            if (document.visibilityState === 'visible') acquireWakeLock();
        });
    } catch { }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquireWakeLock();
});
acquireWakeLock();

const statsHud = document.getElementById('statsHud');
let prevBytesReceived = 0, prevStatsTime = 0, prevJitterDelay = 0, prevEmitted = 0;

async function updateStats() {
    if (!pc) return;
    try {
        const stats = await pc.getStats();
        let rtt = null, jitter = null, fps = null, kbps = null;
        for (const r of stats.values()) {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null)
                rtt = (r.currentRoundTripTime * 1000).toFixed(0);
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
                const emitted = r.jitterBufferEmittedCount || 1;
                const delay = r.jitterBufferDelay || 0;

                if (prevStatsTime) {
                    const emittedDelta = emitted - prevEmitted;
                    const delayDelta = delay - prevJitterDelay;
                    if (emittedDelta > 0) jitter = ((delayDelta / emittedDelta) * 1000).toFixed(0);

                    const dt = (r.timestamp - prevStatsTime) / 1000;
                    kbps = (((r.bytesReceived - prevBytesReceived) * 8) / dt / 1000).toFixed(0);
                }
                prevBytesReceived = r.bytesReceived;
                prevStatsTime = r.timestamp;
                prevJitterDelay = delay;
                prevEmitted = emitted;
            }
        }
        if (rtt !== null) {
            statsHud.style.display = 'flex';
            statsHud.textContent = [
                rtt != null ? rtt + 'ms RTT' : null,
                jitter != null ? jitter + 'ms buf' : null,
                fps != null ? fps + 'fps' : null,
                kbps != null ? kbps + 'kbps' : null,
            ].filter(Boolean).join('  ·  ');
        }
    } catch { }
}
setInterval(updateStats, 2000);

function landscape() {
    if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => { });
}
function toggleFS() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().then(landscape).catch(() => { });
        document.getElementById('fsBtn').textContent = '[x] Full';
    } else {
        document.exitFullscreen();
        document.getElementById('fsBtn').textContent = '[ ] Full';
    }
}

let clientRumbleEnabled = localStorage.getItem('ns_rumble') !== 'false';

function toggleClientRumble() {
    clientRumbleEnabled = !clientRumbleEnabled;
    localStorage.setItem('ns_rumble', clientRumbleEnabled);
    updateRumbleBtn();
}

function updateRumbleBtn() {
    const rBtn = document.getElementById('rumbleBtn');
    if (rBtn) {
        rBtn.textContent = 'Rumble: ' + (clientRumbleEnabled ? 'ON' : 'OFF');
        rBtn.style.color = clientRumbleEnabled ? '#777' : '#ff4444';
    }
}

document.addEventListener('DOMContentLoaded', updateRumbleBtn);

document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) landscape();
    document.getElementById('fsBtn').textContent = document.fullscreenElement ? '[x] Full' : '[ ] Full';
});

(function () {
    const fsBtn = document.getElementById('fsOverlayBtn');
    if (!fsBtn) return;
    let hideTimer = null;
    let lastX = 0, lastY = 0;
    const MOVE_THRESHOLD = 14;

    function showBtn() {
        fsBtn.style.opacity = '1';
        fsBtn.style.pointerEvents = 'auto';
        document.body.style.cursor = '';
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            fsBtn.style.opacity = '0';
            fsBtn.style.pointerEvents = 'none';
            document.body.style.cursor = 'none';
        }, 2700);
    }

    document.addEventListener('mousemove', (e) => {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        if (Math.sqrt(dx * dx + dy * dy) < MOVE_THRESHOLD) return;
        lastX = e.clientX;
        lastY = e.clientY;
        showBtn();
    }, { passive: true });

    showBtn();
})();
