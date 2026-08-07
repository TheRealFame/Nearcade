// host-engine.js — Shared Host Engine Component
// https://github.com/TheRealFame/Nearcade
//
// Self-contained engine logic factored out of host.js. Provides browser-global
// helpers the host app depends on:
//   - per-viewer WebRTC stats poll (RTT + packet loss)
//   - host-side voice activity detection (VAD)
//   - PPS flood protection + latency tuning constants
//   - community TURN ladder probe + ultra-low-latency Opus SDP munging
//   - client version check
//   - congestion-based adaptive bitrate control
//   - iGPU detection + codec preference + codec auto-benchmark
//   - sender low-latency parameters / apply-bitrate-to-all
//
// BOTH files are classic (non-module) scripts that share the global scope via
// top-level let/const/function bindings. This file MUST be loaded BEFORE
// host.js — references to engine bindings from host.js resolve at call time,
// and the engine never touches host.js state at load time.

// ── [extracted from host.js] ─────────────────────────────────────────
// ── PER-VIEWER WebRTC STATS (RTT + packet loss) ────────────────────────
const _viewerStats = {}; // viewerId → { rtt: null, loss: null }
let _statsInterval = null;

function _startViewerStatsPoll() {
    if (_statsInterval) return;
    _statsInterval = setInterval(async () => {
        for (const [vid, pc] of Object.entries(peerConnections)) {
            try {
                const reports = await pc.getStats();
                let rtt = null, sent = 0, lost = 0;
                reports.forEach(r => {
                    // Best RTT source: nominated candidate-pair
                    if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) {
                        rtt = Math.round(r.currentRoundTripTime * 1000);
                    }
                    // Packet loss from outbound-rtp video track
                    if (r.type === 'outbound-rtp' && r.kind === 'video') {
                        sent = r.packetsSent || 0;
                    }
                    if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
                        lost = r.packetsLost || 0;
                        // Some browsers expose RTT here too; prefer candidate-pair but fall back
                        if (rtt == null && r.roundTripTime != null) {
                            rtt = Math.round(r.roundTripTime * 1000);
                        }
                    }
                });
                const loss = (sent + lost) > 0 ? ((lost / (sent + lost)) * 100).toFixed(1) : '0.0';
                _viewerStats[vid] = { rtt, loss: parseFloat(loss) };
                // Update tooltip on the live card if it exists
                _updateRcardTooltip(vid);
            } catch (_) {}
        }
    }, 3000);
}

function _stopViewerStatsPoll() {
    if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
}

function _updateRcardTooltip(vid) {
    const s = _viewerStats[vid];
    if (!s) return;
    const rttStr = s.rtt != null ? `${s.rtt} ms` : '-- ms';
    const lossStr = s.loss != null ? `${s.loss.toFixed(1)}%` : '--%';
    const titleText = `Ping: ${rttStr} | Loss: ${lossStr}`;

    document.querySelectorAll(`.rcard[data-id="${vid}"]`).forEach(card => {
        card.title = titleText;
    });

    const tip = document.getElementById(`stat-tip-${vid}`);
    if (tip) {
        const lossColor = s.loss > 5 ? '#f87171' : s.loss > 1 ? '#fb923c' : '#4ade80';
        const rttColor  = s.rtt  > 150 ? '#f87171' : s.rtt > 60 ? '#fb923c' : '#4ade80';
        tip.innerHTML =
            `<span style="color:${rttColor}">⬤</span> ${rttStr} &nbsp; ` +
            `<span style="color:${lossColor}">⬤</span> ${lossStr} loss`;
    }
}

// ── [extracted from host.js] ─────────────────────────────────────────
// ── VOICE ACTIVITY DETECTION (Host-side VAD) ──────────────────────────
const VAD_THRESHOLD = 22; // RMS energy threshold (0-255)
const VAD_HOLD_MS = 800;  // silence before untalking
const _viewerVADs = {};   // viewerId → { audioCtx, source, analyser, talking, silenceStart }
let _vadInterval = null;

function _getRMS(analyser) {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = data[i] - 128; sum += v * v; }
    return Math.sqrt(sum / data.length);
}

let _lastActiveString = '';
function _startVADBroadcast() {
    if (_vadInterval) return;
    _vadInterval = setInterval(() => {
        const active = [];
        for (const [vid, vad] of Object.entries(_viewerVADs)) {
            const level = _getRMS(vad.analyser);
            const speaking = level > 12; // More sensitive threshold
            if (speaking && !vad.talking) {
                vad.talking = true; vad.silenceStart = 0;
            }
            else if (!speaking && vad.talking) {
                if (!vad.silenceStart) vad.silenceStart = Date.now();
                else if (Date.now() - vad.silenceStart > 1000) vad.talking = false; // 1s hold
            } else if (speaking) { vad.silenceStart = 0; }
            if (vad.talking) active.push(vid);
        }
        
        const activeStr = active.sort().join(',');
        if (activeStr !== _lastActiveString) {
            _lastActiveString = activeStr;
            
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'voice-activity', activeSpeakers: active }));
            }

            // Render hostVcOverlay ONLY when the active speakers list changes
            const vcOverlay = document.getElementById('hostVcOverlay');
            const vcList = document.getElementById('hostVcList');
            if (vcOverlay && vcList) {
                if (appSettings.vcOverlayPreview) {
                    vcOverlay.style.display = 'flex';
                    let html = '';
                    for (const [vid, vad] of Object.entries(_viewerVADs)) {
                        if (vad.talking) {
                            let name = (typeof viewerNames !== 'undefined' && viewerNames.get(vid)) ? viewerNames.get(vid) : vid;
                            let avatar = null;
                            let color = 'var(--accent)';
                            
                            if (typeof _lastRosterList !== 'undefined') {
                                const rosterObj = _lastRosterList.find(x => x.id === vid || x.id.startsWith(vid + '_'));
                                if (rosterObj) {
                                    if (rosterObj.name) name = rosterObj.name;
                                    if (rosterObj.avatar) avatar = rosterObj.avatar;
                                    if (rosterObj.color) color = rosterObj.color;
                                }
                            }
                            name = name.substring(0, 15);

                            let avatarHtml = '';
                            if (avatar) {
                                let avatarUrl = avatar;
                                if (String(avatar).length <= 3 && !String(avatar).includes('/')) {
                                    avatarUrl = `/assets/avatars/avatar-${avatar}.svg`;
                                }
                                avatarHtml = `<img src="${avatarUrl}" style="width:16px; height:16px; border-radius:50%; object-fit:cover; box-shadow:0 0 8px ${color};">`;
                            } else {
                                avatarHtml = `<div style="width:16px; height:16px; background:${color}; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:bold; color:#fff; box-shadow:0 0 8px ${color};">${name.charAt(0).toUpperCase()}</div>`;
                            }

                            html += `<div style="display:flex; align-items:center; gap:8px; padding:4px 8px; background:rgba(0,0,0,0.4); border-radius:6px; border:1px solid ${color};">
                                        ${avatarHtml}
                                        <div style="font-size:11px; font-weight:600; color:#fff;">${name}</div>
                                     </div>`;
                        }
                    }
                    vcList.innerHTML = html;
                } else {
                    vcOverlay.style.display = 'none';
                }
            }

            document.querySelectorAll('.rcard').forEach(card => {
                const vid = card.dataset.id;
                if (vid && active.includes(vid)) {
                    card.style.boxShadow = '0 0 10px rgba(139, 92, 246, 0.6)';
                    card.style.borderColor = 'var(--accent)';
                    card.style.transition = 'box-shadow 0.1s, border-color 0.1s';
                } else {
                    card.style.boxShadow = '';
                    card.style.borderColor = '';
                }
            });
        }
    }, 100);
}

function _setupViewerVAD(viewerId, stream) {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        _viewerVADs[viewerId] = { audioCtx, source, analyser, talking: false, silenceStart: 0 };
        _startVADBroadcast();
    } catch (e) { console.warn('[VAD] Failed to setup for', viewerId, e); }
}

function _removeViewerVAD(viewerId) {
    const vad = _viewerVADs[viewerId];
    if (vad) { try { vad.audioCtx.close(); } catch (_) { } delete _viewerVADs[viewerId]; }
}
// ── [extracted from host.js] ─────────────────────────────────────────
// ── PPS (Packets-Per-Second) flood protection ─────────────────────────────────
// Tracks input message counts per viewer. If any viewer exceeds 300 msgs/sec
// they are immediately disconnected.
const _ppsCount = {};          // viewerId → count in current window
const _ppsWindow = {};          // viewerId → window start timestamp (ms)
const PPS_LIMIT = 300;
const PPS_WINDOW = 1000;        // ms

// ── Latency tuning constants ────────────────────────────────────────────────────
const KEYFRAME_INTERVAL_MS = 200;   // was 500
const CONGESTION_KEYFRAME_THRESHOLD_MS = 20; // was 40

function _checkPps(viewerId) {
    const now = Date.now();
    if (!_ppsWindow[viewerId] || now - _ppsWindow[viewerId] >= PPS_WINDOW) {
        _ppsWindow[viewerId] = now;
        _ppsCount[viewerId] = 1;
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
// ── [extracted from host.js] ─────────────────────────────────────────
// ── COMMUNITY TURN LADDER ────────────────────────────────────────────────
// Fetched once, filtered to entries that respond on the real TURN port, and
// used only as the *additional* fallback tier so a dead public relay can never
// gate the whole ICE handshake.
let _communityTurnLadder = [];
let _communityTurnFetchPromise = null;
const busyTurnUrls = new Set();
async function _loadCommunityTurnLadder() {
    try {
        const res = await fetch('/api/community-turn-servers');
        if (!res.ok) { _communityTurnLadder = []; return; }
        const servers = await res.json();
        const results = [];
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
// ─────────────────────────────────────────────────────────────────────────────
// Function to munge the SDP before setting local description for ultra-low latency audio
function forceOpusLowLatency(sdp) {
    const sdpLines = sdp.split('\r\n');
    let opusPayload = -1;
    for (let line of sdpLines) {
        if (line.startsWith('a=rtpmap:') && line.includes('opus/48000/2')) {
            opusPayload = line.split(':')[1].split(' ')[0];
            break;
        }
    }
    if (opusPayload !== -1) {
        const fmtpRegex = new RegExp(`^a=fmtp:${opusPayload} `);
        for (let i = 0; i < sdpLines.length; i++) {
            if (fmtpRegex.test(sdpLines[i])) {
                if (!sdpLines[i].includes('ptime')) {
                    sdpLines[i] += '; ptime=2.5; minptime=2.5; stereo=0; useinbandfec=1';
                }
                break;
            }
        }
    }
    return sdpLines.join('\r\n');
}
// ── [extracted from host.js] ─────────────────────────────────────────
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
        const res = await fetch((window.NEARCADE_ARCADE_URL || 'https://nearcade.cutefame.net') + '/api/client-version');
        if (!res.ok) return;
        const data = await res.json();
        const minVer = data.minimum || '0.0.0';
        if (compareVersions(window.NEARCADE_VERSION, minVer) < 0) {
            const overlay = document.createElement('div');
            overlay.id = 'versionCheckOverlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = '<div style="background:#121518;border:1px solid #ff5d3d;border-radius:12px;padding:40px;max-width:420px;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,0.8);font-family:sans-serif;">'
                + '<h2 style="color:#ff5d3d;margin:0 0 12px 0;text-transform:uppercase;letter-spacing:1px;">Client Outdated</h2>'
                + '<p style="color:#949ba4;font-size:14px;line-height:1.6;margin:0 0 16px 0;">'
                + 'You are running <strong style="color:#f0f3f5;">Nearcade v' + window.NEARCADE_VERSION + '</strong>.<br>'
                + 'The arcade directory requires at least <strong style="color:#f0f3f5;">v' + minVer + '</strong>.<br><br>'
                + 'Please update to the latest version to continue hosting arcade sessions.</p>'
                + '<a href="https://github.com/TheRealFame/Nearcade/releases/latest" target="_blank" style="display:inline-block;background:#ff5d3d;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Download Update</a>'
                + '</div>';
            document.body.appendChild(overlay);
        }
    } catch (_) { }
}
// ── [extracted from host.js] ─────────────────────────────────────────
const congestionControl = {
    enabled: true,
    maxRttMs: 120,
    spikeMargin: 60,          // ms above baseline to consider RTT-inflated (congestion)
    recoveryMargin: 25,       // ms above baseline to consider RTT-normal (recovery)
    packetLossThreshold: 5,
    statsPollInterval: 500,   // was 2000
    recoveryTimeout: 2500,     // was 5000
    lastAdjustment: {}         // FIX: Stores individual viewer states
};

async function monitorCongestion(pc, viewerId) {
    if (!congestionControl.enabled) return;
    if (appSettings.tournamentMode) { console.log('[Tournament] Congestion monitoring disabled'); return; }

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

            // Track and decay baseline: RTT inflation (queue buildup = congestion); stable high RTT (relay/TURN path) is NOT congestion.
            if (!congestionControl.baselineRtt && rttMs > 0) {
                congestionControl.baselineRtt = rttMs;
            }
            if (congestionControl.baselineRtt && rttMs < congestionControl.baselineRtt) {
                congestionControl.baselineRtt = rttMs; // slowly recover baseline if RTT drops
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

            // Decayed baseline: when RTT drops, pull baseline toward it so recovery stays reachable.
            if (!lastAdj.baselineRtt && rttMs > 0) {
                lastAdj.baselineRtt = rttMs;
            } else if (lastAdj.baselineRtt && rttMs < lastAdj.baselineRtt) {
                lastAdj.baselineRtt = rttMs;
            }

            const baseline = lastAdj.baselineRtt || congestionControl.baselineRtt || rttMs;
            const timeSinceLastAdj = Date.now() - lastAdj.time;
            const degPref = document.getElementById('degSelect')?.value || 'maintain-framerate';
            const ceiling = configuredBitrate > 0 ? configuredBitrate : lastAdj.bitrate;

            // Convergence detection: RTT is within recovery margin of baseline, and enough time since last adjust,
            // and bitrate hasn't already recovered to ceiling.
            if (timeSinceLastAdj > congestionControl.recoveryTimeout &&
                currentBitrate < ceiling * 0.95 &&
                rttMs < baseline + congestionControl.recoveryMargin) {

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
                    } catch (e) { }
                }

                congestionControl.lastAdjustment[viewerId] = { bitrate: recovered, time: Date.now(), baselineRtt: lastAdj.baselineRtt };
                console.log(I18N.t('Congestion: Bitrate recovered to ${Math.round(recovered/1000)}kbps for ${viewerId}').replace('${Math.round(recovered/1000)}', Math.round(recovered / 1000)).replace('${viewerId}', viewerId));
                return;
            }

            // Reduced: only when packet loss is high OR RTT is inflated significantly above baseline
            // (a stable 137ms relay path should NOT be punished — that's distance, not congestion).
            const rttInflated = rttMs > Math.max(congestionControl.maxRttMs, baseline * 1.4, baseline + congestionControl.spikeMargin);
            let shouldReduce = false;
            let reason = '';

            if (packetLoss > congestionControl.packetLossThreshold) {
                shouldReduce = true;
                reason = `high packet loss (${packetLoss.toFixed(1)}%)`;
            } else if (rttInflated) {
                shouldReduce = true;
                reason = `RTT inflation (${rttMs}ms vs baseline ${baseline}ms)`;
            }

            if (shouldReduce && timeSinceLastAdj > 2000) {
                const isCrisp = (degPref === 'maintain-resolution');
                const reductionFactor = isCrisp ? 0.95 : 0.80;
                const minFloor = isCrisp ? 2500000 : 500000;
                const newBitrate = Math.round(currentBitrate * reductionFactor);
                const clamped = Math.max(minFloor, newBitrate);

                // Don't keep applying the same floor — the encoder already has the floor value.
                if (clamped < currentBitrate) {
                    try { // <--- INNER TRY (The INVALID_STATE fix)
                        const freshParams = sender.getParameters();
                        if (freshParams.encodings?.length) {
                            freshParams.encodings[0].maxBitrate = clamped;
                            freshParams.encodings[0].degradationPreference = degPref;
                        }
                        await sender.setParameters(freshParams);

                        if (typeof _wcEncoder !== 'undefined' && _wcEncoder && _wcEncoder.state !== 'closed' && _wcEncoder._lastConfig) {
                            try {
                                _wcEncoder._lastConfig.bitrate = clamped;
                                _wcEncoder.configure(_wcEncoder._lastConfig);
                            } catch (e) { }
                        }

                        congestionControl.lastAdjustment[viewerId] = { bitrate: clamped, time: Date.now(), baselineRtt: lastAdj.baselineRtt };
                        console.warn(I18N.t('Congestion: Bitrate reduced to ${Math.round(clamped/1000)}kbps (${reason})').replace('${Math.round(clamped/1000)}', Math.round(clamped / 1000)).replace('${reason}', reason));
                    } catch (e) {
                        console.warn('[Congestion] Failed to apply bitrate reduction:', e.message);
                    }
                }
            }
        } catch (outerErr) { }
    };

    const interval = setInterval(async () => {
        if (!peerConnections[viewerId]) {
            clearInterval(interval);
            return;
        }
        await poll();
    }, congestionControl.statsPollInterval);
}
// ── [extracted from host.js] ─────────────────────────────────────────
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
    } catch (e) { }
})();

async function fetchGameThumbnail(gameTitle) {
    try {
        const res = await fetch((window.NEARCADE_ARCADE_URL || 'https://nearcade.cutefame.net') + '/api/game-art?title=' + encodeURIComponent(gameTitle));
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

// ── [extracted from host.js] ─────────────────────────────────────────
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
    const pctEl = document.getElementById('codecBenchPct');

    if (btnSpeed.dataset.running || btnQuality.dataset.running) return;
    activeBtn.dataset.running = '1';
    btnSpeed.disabled = true;
    btnQuality.disabled = true;

    const originalHTML = activeBtn.innerHTML;
    // Just replace the text span if it exists, or the whole thing safely
    activeBtn.innerHTML = `<span>Running...</span>`;
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
        delete activeBtn.dataset.running; activeBtn.innerHTML = originalHTML;
        return;
    }

    // Map codec mime types to the codecSelect option values
    const CODEC_MAP = {
        'video/h264': 'H264',
        'video/hevc': 'H265',
        'video/vp8': 'VP8',
        'video/vp9': 'VP9',
        'video/av1': 'AV1',
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

    // Set up real video stream for benchmark
    const testVideo = document.createElement('video');
    testVideo.src = '/assets/benchmark.mp4';
    testVideo.muted = true;
    testVideo.loop = true;
    testVideo.playsInline = true;
    testVideo.style.display = 'none';
    document.body.appendChild(testVideo);

    benchLog('Waiting for video buffer...');
    try {
        await new Promise((res, rej) => {
            testVideo.oncanplaythrough = res;
            testVideo.onerror = () => rej(new Error('Failed to load benchmark.mp4'));
            testVideo.load();
        });
        await testVideo.play();
    } catch (e) {
        benchLog('Video playback blocked: ' + e.message, 'var(--error)');
        testVideo.removeAttribute('src');
        testVideo.load();
        if (testVideo.parentNode) testVideo.parentNode.removeChild(testVideo);
        btnSpeed.disabled = false; btnQuality.disabled = false;
        delete activeBtn.dataset.running; 
        activeBtn.innerHTML = originalHTML;
        return;
    }

    const results = [];

    for (let i = 0; i < toTest.length; i++) {
        const { mime, name } = toTest[i];
        const pct = Math.round((i / toTest.length) * 100);
        fillEl.style.width = pct + '%';
        pctEl.textContent = pct + '%';

        benchLog(`Testing ${name}...`);
        let bitrate = 0;
        let track = null;

        try {
            // Create a loopback PC pair
            const pc1 = new RTCPeerConnection();
            const pc2 = new RTCPeerConnection();
            pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => { });
            pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => { });

            // Add video track from the test video
            const stream = testVideo.captureStream(60);
            if (!stream) throw new Error('captureStream not supported');
            track = stream.getVideoTracks()[0];
            if (!track) throw new Error('Video track not available yet');
            pc1.addTrack(track, stream);

            // Create a sink video to force pc2 to actually decode frames
            const sinkVideo = document.createElement('video');
            sinkVideo.autoplay = true;
            sinkVideo.muted = true;
            sinkVideo.playsInline = true;
            sinkVideo.style.cssText = 'position:absolute; width:1px; height:1px; opacity:0; pointer-events:none;';
            document.body.appendChild(sinkVideo);

            pc2.ontrack = e => {
                if (e.streams && e.streams[0]) {
                    sinkVideo.srcObject = e.streams[0];
                }
            };

            // Prefer the specific codec on pc1's sender
            const allCodecs = caps.codecs;
            const preferred = allCodecs.filter(c => c.mimeType.toLowerCase() === mime);
            const rest = allCodecs.filter(c => c.mimeType.toLowerCase() !== mime);
            if (preferred.length === 0) { 
                benchLog(`  - ${name}: not in capabilities — skip`); 
                if (track) track.stop();
                sinkVideo.srcObject = null;
                pc1.close(); pc2.close(); 
                continue; 
            }
            pc1.getTransceivers().forEach(t => {
                if (t.sender?.track?.kind === 'video') {
                    try { t.setCodecPreferences([...preferred, ...rest]); } catch (_) { }
                }
            });

            const offer = await pc1.createOffer();
            await pc1.setLocalDescription(offer);
            await pc2.setRemoteDescription(offer);
            const answer = await pc2.createAnswer();
            await pc2.setLocalDescription(answer);
            await pc1.setRemoteDescription(answer);

            // Wait for connection (3s strict timeout)
            await new Promise((res, rej) => {
                const t = setTimeout(() => rej(new Error('ICE timeout')), 3000);
                pc2.onconnectionstatechange = () => {
                    if (pc2.connectionState === 'connected') { clearTimeout(t); res(); }
                    if (pc2.connectionState === 'failed') { clearTimeout(t); rej(new Error('ICE failed')); }
                };
            });

            // Wait 1s for codec to negotiate and stabilize
            await new Promise(r => setTimeout(r, 1000));

            // Check what codec actually got selected
            let actualCodec = null;
            let hardwareAccel = false;
            let startFreezeCount = 0;
            let startFreezeDuration = 0;

            try {
                const stats = await pc2.getStats();
                stats.forEach(r => {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') {
                        if (r.codecId) {
                            const codecStat = stats.get(r.codecId);
                            if (codecStat) actualCodec = codecStat.mimeType;
                        }
                        startFreezeCount = r.freezeCount || 0;
                        startFreezeDuration = r.totalFreezesDuration || 0;
                        const impl = r.decoderImplementation ? r.decoderImplementation.toLowerCase() : '';
                        if (impl && !impl.includes('libvpx') && !impl.includes('ffmpeg') && !impl.includes('software')) {
                            hardwareAccel = true;
                        }
                    }
                });
            } catch (_) { }

            if (actualCodec && !actualCodec.toLowerCase().includes(mime.split('/')[1])) {
                benchLog(`  - ${name}: browser used ${actualCodec} instead — skip`);
                if (track) track.stop();
                sinkVideo.srcObject = null;
                if (sinkVideo.parentNode) sinkVideo.parentNode.removeChild(sinkVideo);
                pc1.close(); pc2.close(); continue;
            }

            // Measure matrix over 8 seconds
            let lastBytes = 0, lastTime = 0;
            let totalFramesDecoded = 0, totalFramesDropped = 0, totalFreezes = 0;
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
                            totalFramesDecoded = (r.framesDecoded || 0);
                            totalFramesDropped = (r.framesDropped || 0);
                            totalFreezes = (r.freezeCount || 0) - startFreezeCount;
                        }
                    });
                } catch (_) { }
            }

            if (track) track.stop();
            sinkVideo.srcObject = null;
            if (sinkVideo.parentNode) sinkVideo.parentNode.removeChild(sinkVideo);
            pc1.close(); pc2.close();

            bitrate = samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0;
            const dropRate = (totalFramesDecoded + totalFramesDropped) > 0 ? (totalFramesDropped / (totalFramesDecoded + totalFramesDropped)) : 0;

            if (bitrate > 0) {
                if (dropRate > 0.05) {
                    benchLog(`  - ${name}: Disqualified! >5% frame drop rate (${(dropRate*100).toFixed(1)}%)`, 'var(--warn)');
                } else if (totalFreezes > 5) {
                    benchLog(`  - ${name}: Disqualified! Too many micro-stutters (${totalFreezes} freezes)`, 'var(--warn)');
                } else {
                    benchLog(`  + ${name}: ${bitrate} kbps | Drops: ${(dropRate*100).toFixed(1)}% | Freezes: ${totalFreezes} | HW: ${hardwareAccel ? 'Yes' : 'No'}`, 'var(--accent)');
                    results.push({ name, bitrate, dropRate, totalFreezes, hardwareAccel });
                }
            } else {
                benchLog(`  - ${name}: no frames received`);
            }
        } catch (err) {
            benchLog(`  - ${name}: ${err.message}`, 'var(--warn)');
            if (track) track.stop();
            if (sinkVideo.parentNode) sinkVideo.parentNode.removeChild(sinkVideo);
            continue;
        }
    }

    // Cleanup HTML5 Video
    testVideo.pause();
    testVideo.removeAttribute('src');
    testVideo.load();
    if (testVideo.parentNode) testVideo.parentNode.removeChild(testVideo);

    fillEl.style.width = '100%';
    pctEl.textContent = '100%';

    btnSpeed.disabled = false; btnQuality.disabled = false;
    delete activeBtn.dataset.running;
    activeBtn.innerHTML = originalHTML;

    if (results.length === 0) {
        benchLog('No codec produced usable output. Check GPU/driver.', 'var(--error)');
    } else {
        if (mode === 'speed') {
            document.getElementById('resSelect').value = "720";
            document.getElementById('fpsSelect').value = "60";
            // Speed Mode: Prioritize H.264 or VP8, Hardware Acceleration, then bitrate
            const speedOrder = ['H264', 'VP8', 'H265', 'VP9', 'AV1'];
            results.sort((a, b) => {
                const idxA = speedOrder.indexOf(a.name);
                const idxB = speedOrder.indexOf(b.name);
                if (a.hardwareAccel && !b.hardwareAccel) return -1;
                if (!a.hardwareAccel && b.hardwareAccel) return 1;
                if (idxA !== idxB) return (idxA !== -1 ? idxA : 99) - (idxB !== -1 ? idxB : 99);
                return b.bitrate - a.bitrate;
            });
        } else {
            document.getElementById('resSelect').value = "1080";
            document.getElementById('fpsSelect').value = "60";
            // Quality Mode: Prioritize AV1, VP9, H265, Hardware Acceleration, then lowest drop rate
            const qualityOrder = ['AV1', 'H265', 'VP9', 'H264', 'VP8'];
            results.sort((a, b) => {
                const idxA = qualityOrder.indexOf(a.name);
                const idxB = qualityOrder.indexOf(b.name);
                if (idxA !== idxB) return (idxA !== -1 ? idxA : 99) - (idxB !== -1 ? idxB : 99);
                if (a.hardwareAccel && !b.hardwareAccel) return -1;
                if (!a.hardwareAccel && b.hardwareAccel) return 1;
                return a.dropRate - b.dropRate; // lower drop rate is better
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
    activeBtn.innerHTML = originalHTML;
    delete activeBtn.dataset.running;
}
// ── [extracted from host.js] ─────────────────────────────────────────
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

            const targetRes = parseInt(document.getElementById('resSelect')?.value) || 0;
            const nativeHeight = sender.track?.getSettings()?.height || 1080;
            if (targetRes > 0 && targetRes < nativeHeight) {
                params.encodings[0].scaleResolutionDownBy = nativeHeight / targetRes;
            } else {
                delete params.encodings[0].scaleResolutionDownBy;
            }

            const degPref = document.getElementById('degSelect')?.value || 'maintain-framerate';
            params.encodings[0].degradationPreference = degPref;

            // Apply Temporal SVC for Smooth mode
            if (degPref === 'maintain-framerate') {
                params.encodings[0].scalabilityMode = 'L1T2';
            } else {
                delete params.encodings[0].scalabilityMode;
            }
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

    // Dynamically update WebCodecs encoder if running
    if (typeof _wcEncoder !== 'undefined' && _wcEncoder && _wcEncoder.state === 'configured') {
        const wcConfig = { ..._wcEncoder._lastConfig };
        const degPref = document.getElementById('degSelect')?.value || 'maintain-framerate';

        if (degPref === 'maintain-framerate' && (wcConfig.codec.startsWith('vp09') || wcConfig.codec.startsWith('av01') || wcConfig.codec.startsWith('vp8'))) {
            wcConfig.scalabilityMode = 'L1T2';
        } else {
            delete wcConfig.scalabilityMode;
        }

        const bitVal = parseInt(document.getElementById('bitrateSelect')?.value || 0, 10);
        if (bitVal > 0) wcConfig.bitrate = bitVal;

        const fpsVal = parseInt(document.getElementById('fpsSelect')?.value || 60, 10);
        if (fpsVal > 0) wcConfig.framerate = fpsVal;

        try {
            _wcEncoder.configure(wcConfig);
            _wcEncoder._lastConfig = wcConfig;
        } catch (e) {
            console.warn('[WebCodecs] Failed to update config dynamically:', e);
        }
    }

    const bitVal = parseInt(document.getElementById('bitrateSelect').value, 10);
    log(I18N.t('Stream bitrate changed to') + ' ' + (bitVal > 0 ? (bitVal / 1000000) + ' Mbps' : 'Auto'), 'ok');
}
