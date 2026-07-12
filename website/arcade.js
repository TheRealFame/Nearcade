/**
 * Nearcade Arcade Shared Logic
 * Handles session fetching, latency pings, and grid rendering.
 */

const API_URL = 'https://nearcade.cutefame.net/api/arcade/sessions';
const WS_URL = (() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const host = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? location.host
    : 'nearcade.cutefame.net';
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
'ts.net',
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

// ── Session Management ─────────────────────────────────────────────────
async function fetchSessions() {
    try {
        const res = await fetch(API_URL);
        if (res.ok) {
            const data = await res.json();
            sessions = data;
            if (typeof filterCards === 'function') filterCards();
            if (typeof updateLiveDot === 'function') updateLiveDot(sessions.length > 0);
        }
    } catch (e) {
        console.error('[Arcade] Failed to fetch sessions:', e);
    }
}

// Initial load
fetchSessions();
// ───────────────────────────────────────────────────────────────────

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
const reportedSessions = new Set();

arcadeChannel.bind('client-session-ping', (data) => {
    console.log(`[Arcade Debug]  INCOMING PING | ID: ${data.id} | Game: ${data.game || data.gameTitle}`);
    console.debug('[Arcade Debug] Raw Payload:', JSON.stringify(data));

    if (!data.version) {
        console.warn(`[Arcade Debug]  REJECTED: Session from outdated client (no version field) -> ${data.id}`);
        return;
    }

    if (!isAllowedArcadeUrl(data.url)) {
        console.warn(`[Arcade Debug]  REJECTED: Unapproved tunnel domain -> ${data.url}`);
        return;
    }

    // Ping server to maintain session in KV
    fetch('/api/arcade/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).catch(e => console.error('[Arcade] Server ping failed:', e));

    const existing = sessions.find(s => s.id === data.id);
    if (existing) {
        existing.lastSeen = Date.now();
        if (data.os) existing.os = data.os;
        if (data.codecType) existing.codecType = data.codecType;
        if (data.codec) existing.codec = data.codec;
    } else {
        data.game = data.game || data.gameTitle;
        data.lastSeen = Date.now();
        data.category = data.category || '';

            sessions.unshift(data);


        sessions.unshift(data);

        if (typeof updateLiveDot === 'function') updateLiveDot(true);
        if (typeof filterCards === 'function') filterCards();

        fetchThumbnailForSession(data);
    }
});

arcadeChannel.bind('client-session-stop', (data) => {
    sessions = sessions.filter(s => s.id !== data.id);
    saveSessionCache();
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

    if (initialCount > 0) {
        console.log(`[Arcade Debug]  Running heartbeat check on ${initialCount} active sessions...`);
    }

    sessions = sessions.filter(s => {
        const ageMs = now - s.lastSeen;
        const isAlive = ageMs < 25000;
        if (!isAlive) {
            console.log(`[Arcade Debug]  Dropped session ${s.id} (No ping for ${Math.round(ageMs/1000)}s)`);
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
    if (!session?.version) {
        console.warn('[Arcade] Blocked session from outdated client (no version):', session?.id);
        return;
    }
    if (!isAllowedArcadeUrl(session?.url)) {
        console.warn('[Arcade] Blocked session with disallowed URL:', session?.url);
        return;
    }
    if (!sessions.find(s => s.id === session.id)) {
        const newSession = {
            id: session.id || ('arcade-' + Date.now()),
            game: session.game || session.gameTitle,
            thumbnail: session.thumbnail,
            region: session.hostRegion || (window.I18N ? window.I18N.t('Live Arcade') : 'Live Arcade'),
            hasPin: session.hasPin || session.requirePin,
            url: session.url || session.tunnelUrl,
            viewers: session.viewers || session.viewerCount || 0,
            category: session.category || '',
            lastSeen: Date.now()
        };

        sessions.unshift(newSession);
        filterCards();

        //  Fetch the thumbnail dynamically if it's missing
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
        console.log(`[Arcade Debug]  Pinging tunnel: ${session.url}`);
        const t0 = performance.now();
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        
        const res = await fetch(session.url + '/api/info', { 
            method: 'GET', 
            mode: 'cors', 
            cache: 'no-store',
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!res.ok) throw new Error('Host returned error status');
        
        // Verify it's a real Nearcade host by parsing the JSON
        const data = await res.json();
        if (!data || !data.hostName) throw new Error('Invalid host data');

        const rawMs = performance.now() - t0;
        const ms = Math.max(1, Math.round(rawMs / 2.5));
        let color = ms < 60 ? 'green' : ms < 120 ? 'yellow' : 'red';

        console.log(`[Arcade Debug] ⏱ Latency to ${session.id}: ${ms}ms (${color})`);
        latencyMap[session.id] = { ms, color };
    } catch (err) {
        console.warn(`[Arcade Debug] ⚠ Ping failed for ${session.id} - Host might be offline, dropped, or invalid.`, err.message);
        latencyMap[session.id] = { ms: null, color: 'pending' };
        
        // Optionally flag or remove the session if it's completely unreachable
        // But for now, just show it as pending/offline.
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
    const activePill = document.querySelector('.cat-pill.active');
    const cat = activePill ? activePill.innerText.trim() : 'All Sessions';
    filteredSessions = sessions.filter(s => {
        const matchesSearch = !q || s.game.toLowerCase().includes(q) || (s.region || '').toLowerCase().includes(q);
        const matchesCat = cat === 'All Sessions' || (s.category || '') === cat || (s.category || '') === cat.replace(' &amp; ', ' & ');
        return matchesSearch && matchesCat;
    });
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

    const osIcons = {
        'Windows': '<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M0 0h11.37v11.37H0zM12.63 0H24v11.37H12.63zM0 12.63h11.37V24H0zM12.63 12.63H24V24H12.63z"/></svg>',
        'macOS': '<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M17.7 12.7c-.1-3.4 2.8-5 2.9-5.1-1.6-2.3-4-2.6-4.9-2.7-2.1-.2-4.1 1.2-5.1 1.2-1.1 0-2.7-1.2-4.5-1.2-2.3 0-4.5 1.4-5.7 3.5-2.5 4.3-.6 10.6 1.7 14.1 1.2 1.7 2.6 3.7 4.5 3.6 1.8-.1 2.5-1.2 4.7-1.2s2.8 1.2 4.7 1.1c1.9 0 3.2-1.8 4.4-3.5 1.4-2 1.9-3.9 2-4-.1 0-3.8-1.5-3.9-5.8zM14.8 4.1c1-.8 1.7-1.9 1.5-3.1-1.5.1-3.2.9-4.2 1.9-.9.9-1.7 2.1-1.5 3.3 1.6.1 3.2-.8 4.2-2.1z"/></svg>',
        'Linux': '<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
        'Android': '<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24c-2.86-1.21-6.08-1.21-8.94 0L5.65 5.67c-.19-.29-.58-.38-.87-.2-.28.18-.37.54-.22.83L6.4 9.48C3.32 11.11 1 14.38 1 18h22c0-3.62-2.32-6.89-5.4-8.52zM7 15.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm10 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>',
    };
    const osIcon = osIcons[s.os] || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="32" height="32"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

    const thumbHtml = s.thumbnail
    ? `<div class="thumb" style="background-image:url(${JSON.stringify(s.thumbnail)})">
    <div class="latency-tag ${latClass}" id="lat-${s.id}">${latLabel}</div>
    </div>`
    : `<div class="thumb no-img" style="display:flex;align-items:center;justify-content:center;gap:12px;">
    ${osIcon}
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6;"><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg>
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

    const codecBadge = s.codecType === 'WebCodecs'
    ? `<span class="tag" style="background:var(--accent-dim);color:var(--accent);border-color:var(--accent);">WC</span>`
    : s.codecType
    ? `<span class="tag" style="background:rgba(68,204,68,0.15);color:var(--green);border-color:var(--green);">RT</span>`
    : '';

    card.innerHTML = thumbHtml + `
    <div class="card-body">
    <div class="card-title">${escHtml(s.game)}</div>
    ${s.hostName ? `<div class="card-host">by ${escHtml(s.hostName)}</div>` : ''}
    <div class="card-info">
    ${s.hostRegion ? `<span class="tag"><span class="fi fi-${s.hostRegion.toLowerCase()}"></span> ${escHtml(s.hostRegion.toUpperCase())}</span>` : (s.region ? `<span class="tag"><span class="fi fi-${s.region.toLowerCase()}"></span> ${escHtml(s.region)}</span>` : '')}
    <span class="tag">${s.hasPin ? I18N.t('PIN Required') : I18N.t('Public')}</span>
    ${codecBadge}
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
        Nearcade verifies that sessions use approved tunnel providers but cannot audit host behaviour.
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
