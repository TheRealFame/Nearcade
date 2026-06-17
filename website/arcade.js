/**
 * Nearsec Arcade Shared Logic
 * Handles session fetching, latency pings, and grid rendering.
 */

const API_URL = 'https://nearsec.cutefame.net/api/arcade/sessions';
const WS_URL = (() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const host = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? location.host
    : 'nearsec.cutefame.net';
    return `${proto}://${host}/ws/arcade`;
})();
const POLL_INTERVAL = 4500;

// ── Security: only sessions from these tunnel providers are shown ─────────────
// Enforced client-side as a second layer; server validates before broadcasting.
const ARCADE_ALLOWED_DOMAINS = [
'trycloudflare.com',
'zrok.io',
'cutefame.net',
'localhost.run',
'serveo.net',
];

// Inside your web i18n script's targetLang definition:
const urlParams = new URLSearchParams(window.location.search);
const targetLang = urlParams.get('lang') || localStorage.getItem('ns_lang') || navigator.language.split('-')[0] || 'en';
function isAllowedArcadeUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'https:') return false;
        return ARCADE_ALLOWED_DOMAINS.some(d =>
        u.hostname === d || u.hostname.endsWith('.' + d)
        );
    } catch { return false; }
}

let sessions = [];
let filteredSessions = [];
let activeSession = null;
let latencyMap = {};
let arcadeWS = null;
let currentLiveSession = null;

const modal = document.getElementById('gamepadModal');

// Grab all the category pills — guard against null so the script doesn't
// crash if loaded in a sandboxed iframe or extension context where some
// elements may not exist yet.
const categoryPills = document.querySelectorAll('.cat-pill');

if (categoryPills && categoryPills.length) {
  categoryPills.forEach(pill => {
    pill.addEventListener('click', (e) => {
        // 1. Visually update the active button
        const activePill = document.querySelector('.cat-pill.active');
        if (activePill) activePill.classList.remove('active');
        e.target.classList.add('active');

        // 2. Get the category text (e.g., "Fighting", "All Sessions")
        const selectedCategory = e.target.innerText;

        // 3. Filter logic handled by filterCards() which reads the active pill
        if (typeof filterCards === 'function') filterCards();
    });
  });
}

window.openGamepadTester = function() {
    const modal = document.getElementById('gamepadModal');
    if (modal) {
        modal.classList.add('open');
    }
};

window.closeGamepadTester = function() {
    const modal = document.getElementById('gamepadModal');
    if (modal) {
        modal.classList.remove('open');
    }
};

// --- Pusher Connection & State ---
Pusher.logToConsole = true;
const pusher = new Pusher('a93f5405058cd9fc7967', {
    cluster: 'us2',
    authEndpoint: '/api/pusher-auth'
});

// We use a 'private-' channel to allow client-to-client events
const arcadeChannel = pusher.subscribe('private-arcade-global');

arcadeChannel.bind('client-session-ping', (data) => {
    console.log(`[Arcade Debug] 📥 INCOMING PING | ID: ${data.id} | Game: ${data.game || data.gameTitle}`);
    console.debug('[Arcade Debug] Raw Payload:', JSON.stringify(data));

    if (!isAllowedArcadeUrl(data.url)) {
        console.warn(`[Arcade Debug] 🛑 REJECTED: Unapproved tunnel domain -> ${data.url}`);
        return;
    }

    const existing = sessions.find(s => s.id === data.id);
    if (existing) {
        existing.lastSeen = Date.now(); // Update heartbeat
    } else {
        // Normalize properties in case the host sends slightly different keys
        data.game = data.game || data.gameTitle;
        data.lastSeen = Date.now();

        sessions.unshift(data);

        // Trigger your UI updates
        if (typeof updateLiveDot === 'function') updateLiveDot(true);
        if (typeof filterCards === 'function') filterCards();

        // Fetch the thumbnail dynamically if it's missing
        fetchThumbnailForSession(data);
    }
});

arcadeChannel.bind('client-session-stop', (data) => {
    sessions = sessions.filter(s => s.id !== data.id);
    if (typeof filterCards === 'function') filterCards();
});

// Scan for 2 seconds, then hide loader and show empty state if nothing is found
setTimeout(() => {
    const loader = document.getElementById('arcadeLoader');
    if (loader) loader.classList.add('hidden');

    // Only show the empty state if we still haven't caught any sessions
    if (sessions.length === 0) {
        const empty = document.getElementById('emptyState');
        if (empty) empty.style.display = 'flex';
    }
}, 2000);
// --- Heartbeat Pruning Timer ---
// Check every 5 seconds. If a host hasn't pinged in 25 seconds, remove it.
setInterval(() => {
    const now = Date.now();
    const initialCount = sessions.length;

    // Log before pruning if we have active sessions
    if (initialCount > 0) {
        console.log(`[Arcade Debug] 🧹 Running heartbeat check on ${initialCount} active sessions...`);
    }

    sessions = sessions.filter(s => {
        const ageMs = now - s.lastSeen;
        const isAlive = ageMs < 25000;
        if (!isAlive) {
            console.log(`[Arcade Debug] 💀 Dropped session ${s.id} (No ping for ${Math.round(ageMs/1000)}s)`);
        }
        return isAlive;
    });

    if (sessions.length !== initialCount) {
        if (typeof filterCards === 'function') filterCards();
    }
    if (sessions.length === 0) {
        if (typeof updateLiveDot === 'function') updateLiveDot(false);
    }
}, 5000);

function addSessionToGrid(session) {
    if (!isAllowedArcadeUrl(session?.url)) {
        console.warn('[Arcade] Blocked session with disallowed URL:', session?.url);
        return;
    }
    if (!sessions.find(s => s.id === session.id)) {
        const newSession = {
            id: session.id || ('arcade-' + Date.now()),
            game: session.game || session.gameTitle,
            thumbnail: session.thumbnail,
            region: session.hostRegion || 'Live Arcade',
            hasPin: session.hasPin || session.requirePin,
            url: session.url || session.tunnelUrl,
            viewers: session.viewers || session.viewerCount || 0,
            lastSeen: Date.now() // Ensure lastSeen is set for the pruning timer
        };

        sessions.unshift(newSession);
        filterCards();

        // 🚀 Fetch the thumbnail dynamically if it's missing
        fetchThumbnailForSession(newSession);
    }
}

function removeSessionFromGrid(gameTitle) {
    sessions = sessions.filter(s => s.game !== gameTitle);
    filterCards();
}

async function fetchThumbnailForSession(session) {
    // If a thumbnail was already provided by the host, skip fetching
    if (session.thumbnail) return;

    // We need a game name to search for
    const title = session.game || session.gameTitle;
    if (!title) return;

    try {
        const response = await fetch(`/api/game-art?title=${encodeURIComponent(title)}`);
        if (response.ok) {
            const data = await response.json();
            if (data.thumbnail) {
                // Update the session object
                session.thumbnail = data.thumbnail;

                // PRELOAD: Download the image silently in the background
                const img = new Image();
                img.onload = () => {
                    // Once fully loaded, inject it directly into the DOM without rebuilding the grid
                    const thumbDiv = document.querySelector(`.client-card[data-id="${session.id}"] .thumb`);
                    if (thumbDiv) {
                        thumbDiv.style.backgroundImage = `url(${JSON.stringify(data.thumbnail)})`;
                        thumbDiv.classList.remove('no-img');
                        // Remove the placeholder SVG icon
                        const svg = thumbDiv.querySelector('svg');
                        if (svg) svg.remove();
                    }
                };
                img.src = data.thumbnail;
            }
        }
    } catch (err) {
        console.error('[Arcade] Failed to fetch game art for:', title, err);
    }
}

function updateLiveDot(ok) {
    const dot = document.getElementById('liveDot');
    if (!dot) return;
    if (ok) {
        dot.style.background = 'var(--green)';
        dot.style.boxShadow = '0 0 8px var(--green)';
    } else {
        dot.style.background = 'var(--red)';
        dot.style.boxShadow = 'none';
    }
}

// --- Latency Logic ---
async function pingSession(session) {
    if (latencyMap[session.id]) return;
    try {
        console.log(`[Arcade Debug] 🏓 Pinging tunnel: ${session.url}`);
        const t0 = performance.now();
        await fetch(session.url + '/api/info', { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
        const rawMs = performance.now() - t0;

        const ms = Math.max(1, Math.round(rawMs / 2.5));
        let color = ms < 60 ? 'green' : ms < 120 ? 'yellow' : 'red';

        console.log(`[Arcade Debug] ⏱️ Latency to ${session.id}: ${ms}ms (${color})`);
        latencyMap[session.id] = { ms, color };
    } catch (err) {
        console.warn(`[Arcade Debug] ⚠️ Ping failed for ${session.id} - Host might be offline or tunnel dropped.`);
        latencyMap[session.id] = { ms: null, color: 'pending' };
    }

    const tag = document.getElementById('lat-' + session.id);
    if (tag) updateLatencyTag(tag, session.id);
}

function updateLatencyTag(el, id) {
    const l = latencyMap[id];
    if (!l) return;
    el.className = 'latency-tag ' + (l.color || 'pending');
    el.textContent = l.ms !== null ? l.ms + 'ms' : '?';
}

// --- Rendering ---
function filterCards() {
    const searchInput = document.getElementById('searchInput');
    const q = (searchInput ? searchInput.value : '').toLowerCase();
    filteredSessions = sessions.filter(s =>
    !q || s.game.toLowerCase().includes(q) || (s.region || '').toLowerCase().includes(q)
    );
    renderGrid();
}

function renderGrid() {
    const grid = document.getElementById('clientGrid');
    const empty = document.getElementById('emptyState');
    const loader = document.getElementById('arcadeLoader');
    const countEl = document.getElementById('liveCount');

    if (loader) loader.classList.add('hidden');

    if (countEl) {
        countEl.textContent = sessions.length === 0 ? I18N.t('No sessions') :
        sessions.length === 1 ? I18N.t('1 session live') :
        sessions.length + ' ' + I18N.t('sessions live');
    }

    if (filteredSessions.length === 0) {
        [...grid.children].forEach(c => { if (c !== empty) c.remove(); });
        if (empty) empty.style.display = 'flex';
        return;
    }
    if (empty) empty.style.display = 'none';

    const existing = {};
    [...grid.children].forEach(c => { if (c.dataset.id) existing[c.dataset.id] = c; });

    filteredSessions.forEach((s, i) => {
        if (existing[s.id]) {
            updateLatencyTag(document.getElementById('lat-' + s.id), s.id);
            delete existing[s.id];
        } else {
            const card = buildCard(s, i);
            grid.appendChild(card);
            pingSession(s);
        }
    });
    Object.values(existing).forEach(c => c.remove());
}

function buildCard(s, index) {
    const card = document.createElement('div');
    card.className = 'client-card';
    card.dataset.id = s.id;
    card.style.animationDelay = Math.min(index * 40, 200) + 'ms';
    card.onclick = () => openJoin(s);

    const latency = latencyMap[s.id];
    const latClass = latency ? latency.color : 'pending';
    const latLabel = latency ? (latency.ms !== null ? latency.ms + 'ms' : '?') : '…';

    const thumbHtml = s.thumbnail
    ? `<div class="thumb" style="background-image:url(${JSON.stringify(s.thumbnail)})">
    <div class="latency-tag ${latClass}" id="lat-${s.id}">${latLabel}</div>
    </div>`
    : `<div class="thumb no-img">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
    <div class="latency-tag ${latClass}" id="lat-${s.id}">${latLabel}</div>
    </div>`;

    // --- NEW TAG VALIDATION LOGIC ---
    const ALLOWED_TAGS = [
        "Platform Fighter", "Co-op", "Survival", "Modded",
        "Retro", "RPG", "Anime", "Fighting", "Casual", "Tournament", "Story-Rich"
    ];

    // Filter out anything not on the whitelist and cap it at 3 tags so the UI doesn't break
    const safeTags = (s.customTags || [])
    .filter(tag => ALLOWED_TAGS.includes(tag))
    .slice(0, 3);

    const customTagsHtml = safeTags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('');
    // --------------------------------

    card.innerHTML = thumbHtml + `
    <div class="card-body">
    <div class="card-title">${escHtml(s.game)}</div>
    <div class="card-info">
    ${s.hostRegion ? `<span class="tag"><span class="fi fi-${s.hostRegion.toLowerCase()}"></span> ${escHtml(s.hostRegion.toUpperCase())}</span>` : (s.region ? `<span class="tag"><span class="fi fi-${s.region.toLowerCase()}"></span> ${escHtml(s.region)}</span>` : '')}
    <span class="tag">${s.hasPin ? I18N.t('PIN Required') : I18N.t('Public')}</span>
    ${customTagsHtml}
    </div>
    </div>`;

    return card;
}

function escHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// --- Modal & Navigation ---
function openJoin(session) {
    activeSession = session;
    const mThumb = document.getElementById('mThumb');
    if (session.thumbnail) {
        mThumb.style.backgroundImage = `url(${JSON.stringify(session.thumbnail)})`;
        mThumb.classList.remove('no-img');
    } else {
        mThumb.style.backgroundImage = '';
        mThumb.classList.add('no-img');
    }

    document.getElementById('mTitle').textContent = session.game;
    const meta = document.getElementById('mMeta');
    meta.innerHTML = '';

    // Add tags to modal...
    [session.region, (latencyMap[session.id]?.ms ? latencyMap[session.id].ms + 'ms' : null), (session.hasPin ? 'PIN Required' : 'Open')]
    .filter(val => val)
    .forEach(text => {
        const t = document.createElement('div');
        t.className = 'modal-tag'; t.textContent = text;
        meta.appendChild(t);
    });

    document.getElementById('pinSection').classList.toggle('show', !!session.hasPin);
    document.getElementById('joinModal').classList.add('open');
}

function closeJoin() {
    document.getElementById('joinModal').classList.remove('open');
    activeSession = null;
}

async function joinSession() {
    if (!activeSession || !activeSession.url) return;

    // Security disclaimer — shown every time before joining a third-party host
    if (!document.getElementById('securityDisclaimerShown')?.dataset.accepted) {
        showSecurityDisclaimer(() => _doJoin());
        return;
    }
    _doJoin();
}

function showSecurityDisclaimer(onAccept) {
    let overlay = document.getElementById('arcadeSecurityModal');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'arcadeSecurityModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;font-family:monospace;';
        overlay.innerHTML = `
        <div style="background:#1e1f22;border-radius:12px;padding:28px;max-width:460px;width:92vw;box-shadow:0 16px 48px rgba(0,0,0,.8);border:1px solid #333;">
        <div style="font-size:15px;font-weight:700;color:#f2f3f5;margin-bottom:10px;">Before you join</div>
        <p style="font-size:11px;color:#949ba4;line-height:1.7;margin-bottom:16px;">
        You are about to connect to a <strong style="color:#f2f3f5">third-party host machine</strong>.
        The transport is encrypted via WebRTC, but you should:
        </p>
        <ul style="font-size:11px;color:#949ba4;line-height:2;margin:0 0 16px 18px;">
        <li>Never enter passwords or personal credentials.</li>
        <li>Never download or run files offered during a session.</li>
        <li>Leave immediately if asked to do anything suspicious.</li>
        </ul>
        <p style="font-size:10px;color:#555;margin-bottom:20px;">
        Nearsec verifies that sessions use approved tunnel providers but cannot audit host behaviour.
        </p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="arcadeSecDecline" style="padding:8px 20px;border-radius:6px;border:none;background:#383a40;color:#b5bac1;font-family:inherit;font-size:11px;cursor:pointer;">Cancel</button>
        <button id="arcadeSecAccept" style="padding:8px 20px;border-radius:6px;border:none;background:#c084fc;color:#000;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;">I Understand — Join</button>
        </div>
        </div>`;
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    document.getElementById('arcadeSecAccept').onclick = () => {
        overlay.style.display = 'none';
        // Mark as accepted for this page session so it doesn't re-prompt in a loop
        let marker = document.getElementById('securityDisclaimerShown');
        if (!marker) { marker = document.createElement('div'); marker.id = 'securityDisclaimerShown'; marker.style.display = 'none'; document.body.appendChild(marker); }
        marker.dataset.accepted = '1';
        onAccept();
    };
    document.getElementById('arcadeSecDecline').onclick = () => { overlay.style.display = 'none'; };
}

async function _doJoin() {
    if (!activeSession || !activeSession.url) return;
    let joinUrl = activeSession.url;

    if (activeSession.hasPin) {
        const pin = document.getElementById('pinInput').value.trim();
        if (!pin) {
            document.getElementById('pinInput').style.borderColor = 'var(--red)';
            setTimeout(() => document.getElementById('pinInput').style.borderColor = '', 800);
            return;
        }
        joinUrl += (joinUrl.includes('?') ? '&' : '?') + 'pin=' + encodeURIComponent(pin);
    }

    const currentLang = localStorage.getItem('ns_lang') || 'en';
    joinUrl += (joinUrl.includes('?') ? '&' : '?') + 'lang=' + currentLang;

    closeJoin();

    const isElectron = new URLSearchParams(window.location.search).get('electron') === '1';
    if (isElectron && window.parent) {
        window.parent.postMessage({ type: 'JOIN_SESSION', url: joinUrl, game: activeSession.game }, '*');
        return;
    }

    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch (_) {}
    location.href = joinUrl;
}
