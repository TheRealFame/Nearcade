const proto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws, currentStream, peerConnections = {}, knownViewers = new Set(), viewerCount = 0;
let audioCtx, analyser, animFrame;
let pinEnabled = true, currentPin = '----';
let kbmPanicActive = false;

let audioSettings = {
    forceAudioEnabled: localStorage.getItem('ns_force_audio_enabled') !== 'false',
        defaultDevice: localStorage.getItem('ns_audio_device') || 'default'
};

Pusher.logToConsole = true;
const pusher = new Pusher('a93f5405058cd9fc7967', {
    cluster: 'us2',
    authEndpoint: 'https://nearsec.cutefame.net/api/pusher-auth'
});
const arcadeChannel = pusher.subscribe('private-arcade-global');
let arcadePingInterval = null;
let arcadeOverrodePin = false;
const hostSessionId = 'ns-' + Math.random().toString(36).substr(2, 9);

const congestionControl = {
    enabled: true,
    minRttMs: 40,
    maxRttMs: 120,
    packetLossThreshold: 5,
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
            const currentBitrate = params.encodings?.[0]?.maxBitrate || parseInt(document.getElementById('bitrateSelect').value);
            const lastAdj = congestionControl.lastAdjustment[viewerId] || { bitrate: currentBitrate, time: 0 };
            const timeSinceLastAdj = Date.now() - lastAdj.time;

            let shouldReduce = false;
            let reason = '';

            if (packetLoss > congestionControl.packetLossThreshold) {
                shouldReduce = true;
                reason = `high packet loss (${packetLoss.toFixed(1)}%)`;
            } else if (rttMs > congestionControl.maxRttMs) {
                shouldReduce = true;
                reason = `high RTT (${rttMs}ms > ${congestionControl.maxRttMs}ms)`;
            } else if (timeSinceLastAdj > congestionControl.recoveryTimeout &&
                currentBitrate < lastAdj.bitrate * 0.95 &&
                rttMs < congestionControl.minRttMs) {
                const recovered = Math.min(lastAdj.bitrate, currentBitrate * 1.1);
            if (params.encodings?.length) {
                params.encodings[0].maxBitrate = Math.round(recovered);
            }
            await sender.setParameters(params);
            congestionControl.lastAdjustment[viewerId] = { bitrate: recovered, time: Date.now() };
            log(`Congestion: Bitrate recovered to ${Math.round(recovered/1000)}kbps for ${viewerId}`, 'ok');
            return;
                }

                if (shouldReduce && timeSinceLastAdj > 2000) {
                    const newBitrate = Math.round(currentBitrate * 0.8);
                    if (params.encodings?.length) {
                        params.encodings[0].maxBitrate = Math.max(500000, newBitrate);
                    }
                    await sender.setParameters(params);
                    congestionControl.lastAdjustment[viewerId] = { bitrate: currentBitrate, time: Date.now() };
                    log(`Congestion: Bitrate reduced to ${Math.round(newBitrate/1000)}kbps (${reason})`, 'warn');
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

const savedCodec = localStorage.getItem('ns_codec');
if (savedCodec) document.getElementById('codecSelect').value = savedCodec;
document.getElementById('codecSelect').addEventListener('change', (e) => localStorage.setItem('ns_codec', e.target.value));

const savedBitrate = localStorage.getItem('ns_bitrate');
if (savedBitrate) document.getElementById('bitrateSelect').value = savedBitrate;
document.getElementById('bitrateSelect').addEventListener('change', (e) => localStorage.setItem('ns_bitrate', e.target.value));

const savedDeg = localStorage.getItem('ns_deg');
if (savedDeg) document.getElementById('degSelect').value = savedDeg;
document.getElementById('degSelect').addEventListener('change', (e) => localStorage.setItem('ns_deg', e.target.value));

const savedRes = localStorage.getItem('ns_res');
if (savedRes) document.getElementById('resSelect').value = savedRes;
document.getElementById('resSelect').addEventListener('change', (e) => localStorage.setItem('ns_res', e.target.value));

const savedFps = localStorage.getItem('ns_fps');
if (savedFps) document.getElementById('fpsSelect').value = savedFps;
document.getElementById('fpsSelect').addEventListener('change', (e) => localStorage.setItem('ns_fps', e.target.value));

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
    const preferred = 'video/' + document.getElementById('codecSelect').value;
    const sorted = [
        ...caps.codecs.filter(c => c.mimeType === preferred),
        ...caps.codecs.filter(c => c.mimeType !== preferred)
    ];
    let used = null;
    pc.getTransceivers().forEach(t => {
        if (t.sender?.track?.kind === 'video') {
            try { t.setCodecPreferences(sorted); used = sorted[0]?.mimeType || null; } catch { }
        }
    });
    return used;
}

// ── DYNAMIC FRAMERATE BINDING ──
async function setLowLatencyParams(pc) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return;
    try {
        const params = sender.getParameters();
        const bitVal = parseInt(document.getElementById('bitrateSelect').value, 10);
        const fpsVal = parseInt(document.getElementById('fpsSelect')?.value) || 60;
        if (params.encodings?.length) {
            if (bitVal > 0) {
                params.encodings[0].maxBitrate = bitVal;
            } else {
                delete params.encodings[0].maxBitrate;
            }
            params.encodings[0].maxFramerate = fpsVal;
            params.encodings[0].networkPriority = 'high';
            params.encodings[0].priority = 'high';
            params.encodings[0].degradationPreference = 'maintain-framerate';
        }
        await sender.setParameters(params);
    } catch { }
}

async function applyBitrateToAll() {
    for (const pc of Object.values(peerConnections)) {
        await setLowLatencyParams(pc);
    }
    const bitVal = parseInt(document.getElementById('bitrateSelect').value, 10);
    log('Stream bitrate changed to ' + (bitVal > 0 ? (bitVal / 1000000) + ' Mbps' : 'Auto'), 'ok');
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

function renderUrls(d) {
    const el = document.getElementById('urlList');
    el.innerHTML = '';
    const tunnelUrl = d.tunnelUrl || null;
    const rows = [
        tunnelUrl
        ? { url: tunnelUrl, label: 'HTTPS tunnel ← share this', color: 'var(--accent)' }
        : { url: 'Waiting for tunnel...', label: 'tunnel starting up', color: '#444', noclick: true },
        { url: `http://${d.lanIP}:${d.port}/`, label: 'LAN — same network only', color: '#555' },
    ];
    if (!tunnelUrl && d.publicIP)
        rows.splice(1, 0, { url: `http://${d.publicIP}:${d.port}/`, label: 'Public IP (needs port forward)', color: '#666' });
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

const savedViewerModes = JSON.parse(localStorage.getItem('ns_saved_modes') || '{}');

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

        r.innerHTML = `
        <div class="rnum">${index + 1}</div>
        <div style="flex:1; overflow:hidden;">
        <div class="rname">${v.name}</div>
        <div style="display:flex; align-items:center; gap: 6px; margin-top: 4px;">
        <img src="${iconSrc}" style="width: 14px; height: 14px; filter: invert(0.8);" id="icon-${v.id}" />
        <select class="form-select" style="padding: 2px 4px; font-size: 9px; width: auto;" onchange="changeInputMode('${v.id}', this.value, '${v.name.replace(/'/g, "\\'")}')">
        <option value="gamepad" ${currentMode === 'gamepad' ? 'selected' : ''}>Gamepad</option>
        <option value="kbm" ${currentMode === 'kbm' ? 'selected' : ''}>Raw KBM</option>
        <option value="kbm_emulated" ${currentMode === 'kbm_emulated' ? 'selected' : ''}>Emulated KBM</option>
        <option value="disabled" ${currentMode === 'disabled' ? 'selected' : ''}>Disabled</option>
        </select>
        </div>
        </div>
        <div class="rstat">${v.slot !== null ? '(Assigned)' : ''}</div>
        <button class="rlock" onclick="toggleSlotLock('${v.id}')" title="Lock this slot" style="background:none; border:none; cursor:pointer; padding:0 4px; width:20px; height:20px; display:flex; align-items:center;">
        <img src="/assets/icons/${v.locked ? 'lock' : 'lock-open'}.svg" style="width:14px;height:14px;filter:invert(0.5);" />
        </button>
        <button class="rkick" onclick="killGp('${v.id}')" title="Revoke input">×</button>
        `;
        c.appendChild(r);
    });
    attachDragDrop(c);
}

function changeInputMode(viewerId, newMode, viewerName) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'set-input-mode', viewerId: viewerId, mode: newMode }));
        log(`Input mode for viewer ${viewerId} set to ${newMode}`, 'ok');
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
    pinEnabled = !pinEnabled;
    const btn = document.getElementById('pinToggle');
    btn.textContent = pinEnabled ? 'ON' : 'OFF';
    btn.className = 'tog-btn' + (pinEnabled ? ' on' : '');
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: pinEnabled }));
}

function regeneratePin() {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'regen-pin' }));
        log('Requesting new PIN...', 'ok');
    }
}

function connectWS() {
    ws = new WebSocket(proto + '://' + location.host + '/ws/host');
    ws.onopen = () => {
        log('Connected to server', 'ok');
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
                log('Viewer ' + (msg.name || msg.viewerId) + ' joined', 'ok');
            } else {
                log('Viewer ' + (msg.name || msg.viewerId) + ' re-offer requested', 'ok');
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
            log('Viewer ' + msg.viewerId + ' left');
        }
        if (msg.type === 'roster') {
            renderRoster(msg.viewers);
            document.getElementById('viewerCount').textContent = msg.controllerCount ?? msg.viewers.length;
        }
        if (msg.type === 'answer') {
            const pc = peerConnections[msg._viewerId];
            if (pc) {
                if (pc.signalingState !== 'have-local-offer') return;
                try { await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)); } catch (e) { log('answer err: ' + e.message, 'err'); }
            }
        }
        if (msg.type === 'ice-viewer') {
            const pc = peerConnections[msg._viewerId];
            if (pc && msg.candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch { } }
        }

        if (msg.type === 'tunnel-url') {
            log('Tunnel ready: ' + msg.url, 'ok');
            fetch('/api/info').then(r => r.json()).then(d => { d.tunnelUrl = msg.url; renderUrls(d); });
            closeTunnelModal();
        }
        if (msg.type === 'tunnel-error') {
            log('Tunnel failed: ' + msg.provider, 'err');
            showTunnelError('Failed to start ' + msg.provider + '.\n\nIf using a SSH tunnel (localhost.run / serveo), outbound port 22 is likely blocked by your router/ISP.\n\nTry using cloudflared instead.');
        }
        if (msg.type === 'chat') appendChat(msg.from, msg.msg, false);
        if (msg.type === 'viewer-gpid') log('Controller: ' + msg.id, 'ok');
        if (msg.type === 'arcade-session-active') log('Arcade session is LIVE on Nearsec Arcade!', 'ok');
        if (msg.type === 'arcade-session-error') log('Arcade error: ' + (msg.reason || 'unknown'), 'err');
        if (msg.type === 'regen-pin') {
            currentPin = msg.pin;
            document.getElementById('pinVal').textContent = msg.pin;
            log('PIN regenerated: ' + msg.pin, 'ok');
        }
    };
    ws.onclose = () => { log('Disconnected — retrying', 'warn'); setTimeout(connectWS, 2000); };
    ws.onerror = () => log('WS error', 'err');
}

async function sendOfferToViewer(viewerId) {
    if (!currentStream) return;
    if (peerConnections[viewerId]) {
        try { peerConnections[viewerId].close(); } catch { }
        delete peerConnections[viewerId];
    }
    const pc = new RTCPeerConnection({
        // ── CRITICAL FIX: Removed dead TURN servers causing 15-second hang loops ──
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        sdpSemantics: 'unified-plan',
    });
    peerConnections[viewerId] = pc;

    currentStream.getTracks().forEach(track => {
        pc.addTrack(track, currentStream);
    });

    const codec = preferVideoCodec(pc);
    if (codec) document.getElementById('codecBadge').textContent = codec.split('/')[1];

    // ── CRITICAL FIX: 3-Second Fast Retry Handshake (Bypasses 15-second ICE fails) ──
    let connectTimeout = setTimeout(() => {
        if (pc.connectionState !== 'connected' && peerConnections[viewerId] === pc) {
            log('Handshake timeout for ' + viewerId + ', fast retrying...', 'warn');
            sendOfferToViewer(viewerId);
        }
    }, 3000);

    pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate) {
            ws.send(JSON.stringify({ type: 'ice-host', candidate: e.candidate, _viewerId: viewerId }));
        }
    };
    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        log('Viewer ' + viewerId + ': ' + s, s === 'connected' ? 'ok' : s === 'failed' ? 'err' : '');
        if (s === 'connected') {
            clearTimeout(connectTimeout);
            setLowLatencyParams(pc);
            monitorCongestion(pc, viewerId);
        }
        if (s === 'failed' || s === 'disconnected') {
            clearTimeout(connectTimeout);
            if (peerConnections[viewerId] === pc) {
                log('Retrying offer to ' + viewerId, 'warn');
                delete peerConnections[viewerId];
                setTimeout(() => sendOfferToViewer(viewerId), 1000);
            }
        }
    };

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription({ type: offer.type, sdp: offer.sdp });
        ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription, _viewerId: viewerId }));
        log('Offer → viewer ' + viewerId, 'ok');
    } catch (err) {
        log('Fatal WebRTC Error for ' + viewerId + ': ' + err.message, 'err');
    }
}

let selectedSourceId = null;

async function showSourceSelectionModal() {
    if (!window.electronAPI || !window.electronAPI.getWindowSources) {
        log('Source selection not available on this platform', 'warn');
        startCapture();
        return;
    }

    try {
        const sources = await window.electronAPI.getWindowSources();
        if (!sources || sources.length === 0) {
            log('No sources available, using default capture', 'warn');
            startCapture();
            return;
        }

        const sourceGrid = document.getElementById('sourceGrid');
        sourceGrid.innerHTML = '';
        selectedSourceId = null;
        document.getElementById('confirmSourceBtn').disabled = true;

        sources.forEach((source, idx) => {
            const card = document.createElement('div');
            card.className = 'source-card';
            card.id = 'source-' + idx;
            card.onclick = () => selectSource(idx, source.id);

            const thumbnail = source.thumbnail || '';
            const imgHtml = thumbnail ? `<img src="${thumbnail}" class="source-thumbnail" alt="${source.name}">` : '<div class="source-thumbnail" style="background: #333; display: flex; align-items: center; justify-content: center; color: #888;">No Preview</div>';

            const sourceType = source.isScreen ? '🖥️ Screen' : '🪟 Window';
            card.innerHTML = `
            ${imgHtml}
            <div class="source-name">${source.name}</div>
            <div class="source-type">${sourceType}</div>
            `;

            sourceGrid.appendChild(card);
        });

        document.getElementById('sourceModal').classList.remove('gone');
    } catch (e) {
        log('Error loading sources: ' + e.message, 'error');
        startCapture();
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

async function startCapture() {
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnSwitch').disabled = true;

    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); stopAudioMeter(); currentStream = null; }
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};

    // ── CRITICAL FIX: Safe Audio Config to prevent "Capture Cancelled" on Windows ──
    const isLinux = navigator.userAgent.includes('Linux') || navigator.platform.toLowerCase().includes('linux');
    const sysAudioConfig = isLinux ? false : audioSettings.forceAudioEnabled;

    // ── CRITICAL FIX: Direct UI binding without Abort-crashing constraints ──
    const fpsVal = parseInt(document.getElementById('fpsSelect')?.value) || 60;
    const resVal = document.getElementById('resSelect')?.value || '1080p';

    let videoConstraints = { frameRate: { ideal: fpsVal } };
    if (resVal === '720p') videoConstraints.height = { ideal: 720 };
    if (resVal === '1080p') videoConstraints.height = { ideal: 1080 };
    if (resVal === '1440p') videoConstraints.height = { ideal: 1440 };
    if (resVal === '4k') videoConstraints.height = { ideal: 2160 };

    try {
        let screenStream;

        if (selectedSourceId && window.electronAPI) {
            try {
                // Window Capture MUST use getUserMedia, not getDisplayMedia
                screenStream = await navigator.mediaDevices.getUserMedia({
                    audio: isLinux ? false : (audioSettings.forceAudioEnabled ? {
                        mandatory: { chromeMediaSource: 'desktop' }
                    } : false),
                    video: {
                        mandatory: {
                            chromeMediaSource: 'desktop',
                            chromeMediaSourceId: selectedSourceId,
                            maxFrameRate: fpsVal
                        }
                    }
                });
                log('Using selected source: ' + selectedSourceId, 'ok');
            } catch (e) {
                log('Source selection failed, falling back to system dialog: ' + e.message, 'warn');
                selectedSourceId = null;
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: videoConstraints,
                    audio: sysAudioConfig
                });
            }
        } else {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: videoConstraints,
                audio: sysAudioConfig
            });
        }

        selectedSourceId = null;

        const vTrack = screenStream.getVideoTracks()[0];
        if (!vTrack || vTrack.readyState === 'ended') {
            log('Screen capture cancelled', 'warn'); setCapDot('');
            document.getElementById('btnStart').disabled = false; return;
        }

        vTrack.contentHint = 'motion';
        const settings = vTrack.getSettings();
        const combined = new MediaStream();
        combined.addTrack(vTrack);

        // Linux System Audio Virtual Sink Logic
        let aTrack = screenStream.getAudioTracks()[0] || null;
        if (isLinux) {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const loopbackDevice = devices.find(d => d.kind === 'audioinput' &&
                (d.label.includes('NearsecAppAudio') || d.label.toLowerCase().includes('monitor of')));

                if (loopbackDevice) {
                    const audioStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            deviceId: { exact: loopbackDevice.deviceId },
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false
                        }
                    });
                    aTrack = audioStream.getAudioTracks()[0];
                    if (aTrack) {
                        combined.addTrack(aTrack);
                        log('System Audio Mixed: ' + loopbackDevice.label, 'ok');
                    }
                }
            } catch (audErr) {
                console.warn('Linux audio loopback initialization failed:', audErr);
            }
        } else if (aTrack) {
            log('System Audio Track Found: ' + (aTrack.label || 'default'), 'ok');
        }

        if (!aTrack) {
            log('No audio track selected in capture prompt', 'warn');
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
                    log('Microphone added: ' + (micTrack.label || 'default'), 'ok');
                }
            } catch (e) {
                log('Mic capture failed: ' + e.message, 'warn');
            }
        }

        currentStream = combined;

        const prev = document.getElementById('preview');
        if (appSettings.hidePreviewOnStart) {
            previewHidden = true;
            prev.style.display = 'none';
            const btn = document.getElementById('btnPreviewToggle');
            if (btn) { btn.textContent = '▶ Show Preview'; btn.style.color = 'var(--warn)'; }
        } else {
            prev.srcObject = screenStream;
        }

        if (settings.width && settings.height) prev.style.aspectRatio = settings.width + '/' + settings.height;
        document.getElementById('prevOverlay').classList.add('hidden');
        document.getElementById('trackInfo').innerHTML =
        '<strong>' + (vTrack.label || 'Screen') + '</strong><br>' +
        settings.width + '×' + settings.height + ' @ ' + Math.round(settings.frameRate || 0) + 'fps<br>' +
        (aTrack ? 'Audio Mixed via Null Sink' : 'No system audio forward');

        setCapDot('live');
        if (aTrack) { setAudDot('live', 'Audio active'); startAudioMeter(combined); }
        else setAudDot('warn', 'No audio — Check source');

        ws.send(JSON.stringify({ type: 'host-stream-ready' }));
        sysChat('Stream started.');
        [...knownViewers].forEach(id => sendOfferToViewer(id));

        vTrack.onended = () => { log('Capture ended by OS', 'warn'); stopCapture(); };
        document.getElementById('btnSwitch').disabled = false;
        document.getElementById('btnStop').disabled = false;
        document.getElementById('btnKbmPanic').disabled = false;
    } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'AbortError') log('Capture cancelled', 'warn');
        else { log('Capture failed: ' + err.message, 'err'); setCapDot('err'); }
        document.getElementById('btnStart').disabled = false;
    }
}

function stopCapture() {
    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
    stopAudioMeter();
    document.getElementById('preview').srcObject = null;
    document.getElementById('prevOverlay').classList.remove('hidden');
    setCapDot(''); setAudDot('', 'No audio');
    document.getElementById('trackInfo').textContent = '—';
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnSwitch').disabled = true;
    document.getElementById('btnStop').disabled = true;
    document.getElementById('btnKbmPanic').disabled = true;
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
        log('Arcade Mode: Session ended on Arcade', 'warn');
    }

    if (arcadeOverrodePin) {
        arcadeOverrodePin = false;
        pinEnabled = true;
        const btn = document.getElementById('pinToggle');
        if (btn) { btn.textContent = 'ON'; btn.className = 'tog-btn on'; }
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: true }));
        log('PIN re-enabled after Arcade session', 'ok');
    }

    log('Capture stopped');
    sysChat('Host stopped sharing.');
}

function updateKbmPanicButton() {
    const btn = document.getElementById('btnKbmPanic');
    if (!btn) return;

    if (kbmPanicActive) {
        btn.textContent = 'Release KBM';
        btn.style.background = '#FF0000';
        btn.style.borderColor = '#FFF';
    } else {
        btn.textContent = 'KBM Panic';
        btn.style.background = '#8B0000';
        btn.style.borderColor = '#FF0000';
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
        log('Using direct Port Forwarding. Share your Public IP URL.', 'ok');
        return;
    }

    document.getElementById('tunnelLoading').classList.remove('gone');
    document.getElementById('tunnelLoadText').textContent = 'Starting ' + provider + '...';

    log('Starting ' + provider + ' tunnel' + (remember ? ' (saved)' : '') + '…', 'ok');
    fetch('/api/start-tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, remember, vpsHost: document.getElementById("vpsHostInput")?.value?.trim() })
    }).catch(() => showTunnelError('Network request failed'));
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
    forceXboxOne: localStorage.getItem('ns_ctrl_forceXboxOne') === 'true',
        enableDualShock: localStorage.getItem('ns_ctrl_enableDualShock') === 'true',
        enableMotion: localStorage.getItem('ns_ctrl_enableMotion') === 'true',
        defaultInputMode: localStorage.getItem('ns_ctrl_defaultInputMode') || 'gamepad'
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
    log('ctrl-settings: ' + key + ' = ' + ctrlSettings[key], 'ok');
}

function changeDefaultInputMode(mode) {
    ctrlSettings.defaultInputMode = mode;
    localStorage.setItem('ns_ctrl_defaultInputMode', mode);
    applyCtrlSettingsUI();
    sendCtrlSettings();
    log('Default input mode set to: ' + mode, 'ok');
}

function sendCtrlSettings() {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
            type: 'ctrl-settings',
            forceXboxOne: ctrlSettings.forceXboxOne,
                enableDualShock: ctrlSettings.enableDualShock,
                enableMotion: ctrlSettings.enableMotion,
                defaultInputMode: ctrlSettings.defaultInputMode
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
            log('⚠ Arcade: No tunnel URL yet. Start a tunnel first, then launch Arcade.', 'warn');
            return;
        }
        log(`Arcade Mode: ${arcadeConfig.title} (${arcadeConfig.maxPlayers} players) → ${info.tunnelUrl}`, 'ok');

        if (!arcadeConfig.requirePin && pinEnabled) {
            pinEnabled = false;
            arcadeOverrodePin = true;
            const btn = document.getElementById('pinToggle');
            if (btn) { btn.textContent = 'OFF'; btn.className = 'tog-btn'; }
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set-pin', enabled: false }));
            log('PIN disabled for Arcade session', 'ok');
        }

        const getPingData = () => ({
            id: hostSessionId,
            game: arcadeConfig.title,
            thumbnail: arcadeConfig.thumbnail,
            hasPin: arcadeConfig.requirePin,
            url: info.tunnelUrl,
            region: `${knownViewers.size}/${arcadeConfig.maxPlayers} Players • ${getHostOS()}`
        });

        arcadeChannel.trigger('client-session-ping', getPingData());
        sysChat('Arcade Mode started: ' + arcadeConfig.title);

        if (arcadePingInterval) clearInterval(arcadePingInterval);
        arcadePingInterval = setInterval(() => {
            arcadeChannel.trigger('client-session-ping', getPingData());
        }, 10000);

    }).catch(() => log('Arcade: Could not read server info', 'err'));
}

let previewHidden = false;
function togglePreview() {
    previewHidden = !previewHidden;
    const prev = document.getElementById('preview');
    const btn = document.getElementById('btnPreviewToggle');
    if (previewHidden) {
        prev.srcObject = null;
        prev.style.display = 'none';
        document.getElementById('prevOverlay').classList.remove('hidden');
        document.getElementById('prevOverlay').querySelector('span').textContent = 'Preview hidden — stream still active';
        if (btn) { btn.textContent = '▶ Show Preview'; btn.style.color = 'var(--warn)'; }
        log('Preview hidden — stream unaffected', 'ok');
    } else {
        prev.style.display = 'block';
        if (currentStream) {
            prev.srcObject = currentStream;
            document.getElementById('prevOverlay').classList.add('hidden');
        }
        if (btn) { btn.textContent = '◼ Hide Preview'; btn.style.color = ''; }
        log('Preview restored', 'ok');
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
    log('Setting ' + key + ' = ' + appSettings[key], 'ok');
}

function saveAudioDevice(type, deviceId) {
    if (type === 'input') {
        selectedMicDeviceId = deviceId;
        localStorage.setItem('ns_audio_input', deviceId);
    } else {
        selectedOutputDeviceId = deviceId;
        localStorage.setItem('ns_audio_output', deviceId);
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
        log('Audio device enumeration failed: ' + e.message, 'warn');
    }
}

function sysChat(text) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'chat', from: 'Nearsec', msg: text }));
    appendChat('Nearsec', text, false);
}

function createVirtualAudioCable() {
    log('Creating virtual audio cable...', 'ok');
    fetch('/api/create-virtual-audio', { method: 'POST' })
    .then(r => r.json())
    .then(res => {
        if (res.success) {
            log('Virtual cable created! Updating devices...', 'ok');
            setTimeout(() => {
                enumerateAudioDevices();
                document.getElementById('virtualAudioHelp').style.color = 'var(--accent)';
            }, 1000);
        } else {
            log('Failed to create cable: ' + res.error, 'err');
        }
    }).catch(e => log('Network error creating cable', 'err'));
}

applyCtrlSettingsUI();
connectWS();

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('auto') === '1') {
    const autoTitle = urlParams.get('title') || 'Arcade Game';
    const autoTunnel = urlParams.get('tunnel') || 'cloudflared';

    console.log(`[Headless] Initializing automated boot for: ${autoTitle}`);

    document.getElementById('arcadeGameTitle').value = autoTitle;
    document.getElementById('arcadeMaxPlayers').value = "4";
    document.getElementById('arcadeRequirePin').checked = false;

    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelProvider: autoTunnel, neverAsk: true })
    }).then(() => {
        setTimeout(() => {
            startArcadeSession();
        }, 2000);
    });
}
