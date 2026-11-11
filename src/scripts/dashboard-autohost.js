// Containers and Auto-Host Module
let _autoSteamByLabel = new Map();
let _autoSteamLoaded = false;
let _autoSteamLoading = false;
let _autoSteamLastPickedName = '';

let _allDetectedGames = [];
let _activeAutoTab = 'setup';
let _activeGameFilter = 'all';
let _selectedAutoGame = null;
let _editingHostId = null;
let _autoLaunchMode = 'background';
let _selectedMonitorHostId = null;

function _getAutoHostPort() {
  if (typeof _getServerPort === 'function') return _getServerPort();
  const params = new URLSearchParams(window.location.search);
  return params.get('port') || window.location.port || '3000';
}

function switchAutoHostTab(tabName) {
  _activeAutoTab = tabName;
  const tabIds = {
    setup: 'autohostTabSetup',
    monitor: 'autohostTabMonitor',
    settings: 'autohostTabSettings'
  };

  const nav = document.getElementById('autoHostTabsNav');
  if (nav) {
    const tabs = nav.querySelectorAll('.autohost-tab-link');
    const order = ['setup', 'monitor', 'settings'];
    tabs.forEach((t, idx) => {
      t.classList.toggle('active', order[idx] === tabName);
    });
  }

  Object.keys(tabIds).forEach(t => {
    const el = document.getElementById(tabIds[t]);
    if (el) {
      if (t === tabName) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }
  });

  if (tabName === 'setup' && (!_allDetectedGames || _allDetectedGames.length === 0)) {
    loadAutoHostGames();
  } else if (tabName === 'monitor') {
    renderMonitorInstances();
  } else if (tabName === 'settings') {
    checkAutoHostPreflight();
  }
}

function onLaunchModeChanged(val) {
  _autoLaunchMode = val || 'background';
}

function toggleCustomCommandDrawer() {
  const drawer = document.getElementById('autoCustomDrawer');
  if (!drawer) return;
  drawer.style.display = (drawer.style.display === 'none') ? 'flex' : 'none';
}

function selectAutoTunnelProvider(provider) {
  const sel = document.getElementById('autoTunnel');
  if (sel) sel.value = provider;

  const cards = document.querySelectorAll('#autoProvidersGrid .autohost-provider-card');
  cards.forEach(c => {
    c.classList.toggle('selected', c.dataset.provider === provider);
  });

  const teleBadge = document.getElementById('autoTeleTunnel');
  if (teleBadge) teleBadge.textContent = 'Tunnel: ' + provider;
}

function selectAutoMaxPlayers(count) {
  const input = document.getElementById('autoMaxPlayers');
  if (input) input.value = count;

  const group = document.getElementById('autoMaxPlayersGroup');
  if (group) {
    const btns = group.querySelectorAll('.autohost-segmented-btn');
    btns.forEach(b => {
      b.classList.toggle('active', b.textContent.trim().startsWith(count));
    });
  }
}

function checkAutoHostPreflight() {
  const port = _getAutoHostPort();
  const alertEl = document.getElementById('autohostPreflightAlert');
  const msgEl = document.getElementById('autohostPreflightMsg');
  const codeEl = document.getElementById('autohostPreflightCode');
  const descEl = document.getElementById('preflightXvfbDesc');
  const badgeEl = document.getElementById('preflightXvfbBadge');
  const audioBadge = document.getElementById('preflightAudioBadge');

  fetch(`http://localhost:${port}/api/autohost/preflight`)
    .then(r => r.json())
    .then(d => {
      if (audioBadge && d.pulseSink) audioBadge.textContent = d.pulseSink;
      if (d.isLinux) {
        if (d.hasXvfb) {
          if (badgeEl) {
            badgeEl.textContent = 'Installed';
            badgeEl.style.color = '#22c55e';
          }
          if (descEl) descEl.textContent = 'Virtual X11 framebuffer is installed and ready for headless hosting.';
          if (alertEl) alertEl.style.display = 'none';
        } else {
          if (badgeEl) {
            badgeEl.textContent = 'Missing';
            badgeEl.style.color = '#ef4444';
          }
          if (descEl) descEl.textContent = 'xvfb-run is required to isolate the game from your physical monitor.';
          if (alertEl) {
            alertEl.style.display = 'flex';
            if (msgEl) msgEl.textContent = 'xvfb-run is not installed. Install it on your host system:';
            if (codeEl) {
              codeEl.style.display = 'block';
              codeEl.textContent = 'sudo apt install xvfb';
            }
          }
        }
      } else {
        if (badgeEl) badgeEl.textContent = d.platform || 'Supported';
        if (descEl) descEl.textContent = 'Application segmentation via virtual display driver or desktop capturer.';
        if (alertEl) alertEl.style.display = 'none';
      }
    })
    .catch(() => {
      if (badgeEl) badgeEl.textContent = 'Ready';
    });
}

function loadAutoHostGames(force) {
  if (_autoSteamLoading && !force) return Promise.resolve();
  _autoSteamLoading = true;

  const grid = document.getElementById('autoGamesGrid');
  if (grid) grid.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--muted); grid-column: 1 / -1;">Scanning installed game libraries...</div>';

  const port = _getAutoHostPort();
  return fetch(`http://localhost:${port}/api/games`)
    .then(r => r.json())
    .then(d => {
      _allDetectedGames = Array.isArray(d.games) ? d.games : [];
      _allDetectedGames.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || String(a.name).localeCompare(String(b.name)));

      _autoSteamByLabel = new Map();
      _allDetectedGames.forEach(g => {
        if (g.launcher === 'steam') {
          const label = String(g.name);
          const key = _autoSteamByLabel.has(label) ? `${label} (${g.id})` : label;
          _autoSteamByLabel.set(key, g);
        }
      });
      _autoSteamLoaded = true;

      renderAutoGamesList();
    })
    .catch(() => {
      if (grid) grid.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--muted); grid-column: 1 / -1;">Could not scan game libraries. You can type a custom command below.</div>';
    })
    .finally(() => {
      _autoSteamLoading = false;
    });
}

function loadAutoHostSteamGames(force) {
  return loadAutoHostGames(force);
}

function filterAutoGames(filter) {
  _activeGameFilter = filter || 'all';

  const nav = document.getElementById('autoGameFilterNav');
  if (nav) {
    const btns = nav.querySelectorAll('.autohost-segmented-btn');
    const filters = ['all', 'steam', 'heroic_lutris', 'emulators', 'custom'];
    btns.forEach((b, idx) => {
      b.classList.toggle('active', filters[idx] === filter);
    });
  }

  if (filter === 'custom') {
    const drawer = document.getElementById('autoCustomDrawer');
    if (drawer) drawer.style.display = 'flex';
  }

  renderAutoGamesList();
}

function onAutoGameSearch(_query) {
  renderAutoGamesList();
}

function getLaunchCmdForGame(g) {
  if (!g) return '';
  if (g.launcher === 'steam') {
    return `steam steam://rungameid/${g.id}`;
  } else if (g.launcher === 'heroic') {
    return `heroic heroic://launch/${g.id}`;
  } else if (g.launcher === 'lutris') {
    return `lutris lutris:rungame/${g.id}`;
  } else if (g.cmd) {
    return g.cmd;
  }
  return String(g.name || '');
}

function getGameArtUrl(g) {
  if (!g) return '';
  if (g.launcher === 'steam') {
    return `/api/game-art/${encodeURIComponent(g.id)}`;
  }
  if (g.artCover) {
    if (g.artCover.startsWith('/api/') || g.artCover.startsWith('http')) return g.artCover;
    return `/api/local-image?path=${encodeURIComponent(g.artCover.replace(/^file:\/\//, ''))}`;
  }
  return '';
}

function selectAutoGame(g) {
  _selectedAutoGame = g;
  const nameInput = document.getElementById('autoName');
  const cmdInput = document.getElementById('autoCmd');

  if (nameInput) nameInput.value = g.name || '';
  if (cmdInput) cmdInput.value = getLaunchCmdForGame(g);

  const titleEl = document.getElementById('autoSelectedTitle');
  const metaEl = document.getElementById('autoSelectedMeta');
  const thumbEl = document.getElementById('autoSelectedThumb');

  if (titleEl) titleEl.textContent = g.name || 'Selected Game';
  if (metaEl) metaEl.textContent = `Launcher: ${g.launcher || 'custom'} | ID: ${g.id || 'n/a'}`;

  const artUrl = getGameArtUrl(g);
  if (thumbEl) {
    if (artUrl) {
      thumbEl.src = artUrl;
      thumbEl.style.display = 'block';
    } else {
      thumbEl.style.display = 'none';
    }
  }

  document.querySelectorAll('#autoGamesGrid .autohost-game-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.gameId === String(g.id));
  });
}

function renderAutoGamesList() {
  const grid = document.getElementById('autoGamesGrid');
  if (!grid) return;

  const searchInput = document.getElementById('autoGameSearch');
  const query = (searchInput ? searchInput.value : '').trim().toLowerCase();

  let filtered = _allDetectedGames.filter(g => {
    if (query && !String(g.name || '').toLowerCase().includes(query)) return false;

    if (_activeGameFilter === 'steam') {
      return g.launcher === 'steam';
    } else if (_activeGameFilter === 'heroic_lutris') {
      return g.launcher === 'heroic' || g.launcher === 'lutris' || g.launcher === 'epic';
    } else if (_activeGameFilter === 'emulators') {
      const name = String(g.name || '').toLowerCase();
      return name.includes('retroarch') || name.includes('mame') || name.includes('dolphin') || name.includes('pcsx') || name.includes('rpcs');
    }
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--muted); grid-column: 1 / -1;">No matching games found. Type a command in the Custom Command drawer.</div>';
    return;
  }

  let html = '';
  filtered.slice(0, 60).forEach(g => {
    const isSelected = _selectedAutoGame && String(_selectedAutoGame.id) === String(g.id);
    const artUrl = getGameArtUrl(g);
    const safeName = String(g.name || '').replace(/"/g, '&quot;');
    const safeLauncher = String(g.launcher || 'game').replace(/"/g, '&quot;');

    html += `
      <div class="autohost-game-card ${isSelected ? 'selected' : ''}" data-game-id="${g.id}" onclick="selectAutoGameFromGrid('${g.id}')">
        ${artUrl ? `<img class="autohost-game-art" src="${artUrl}" alt="${safeName}" loading="lazy" onerror="this.style.display='none'">` : '<div class="autohost-game-art"></div>'}
        <div class="autohost-game-meta">
          <div class="autohost-game-title" title="${safeName}">${safeName}</div>
          <div class="autohost-game-launcher">${safeLauncher}</div>
        </div>
      </div>
    `;
  });

  grid.innerHTML = html;
}

window.selectAutoGameFromGrid = function(gameId) {
  const g = _allDetectedGames.find(item => String(item.id) === String(gameId));
  if (g) selectAutoGame(g);
};

function onAutoGamePicked(quiet) {
  const input = document.getElementById('autoGamePick');
  if (!input) return;
  const meta = document.getElementById('autoGamePickMeta');
  const game = _autoSteamByLabel.get(input.value.trim());
  if (!game) {
    if (meta && !quiet) meta.textContent = 'Unknown entry - pick a suggested game, or type a command below.';
    return;
  }
  selectAutoGame(game);
}

// ═══════════════════════════════════════════════════════════════
// MONITOR TAB CONTROLLER: Mini Dashboard Interface
// ═══════════════════════════════════════════════════════════════

function renderMonitorInstances() {
  const list = document.getElementById('autoMonitorInstancesList');
  if (!list) return;

  const hosts = (typeof appConfig !== 'undefined' && appConfig.autoHosts) ? appConfig.autoHosts : [];
  const curStatus = (typeof currentGameStatus !== 'undefined') ? currentGameStatus : { running: false };

  const runningBadge = document.getElementById('autoMonitorRunningBadge');
  const liveCount = curStatus.running ? 1 : 0;
  if (runningBadge) runningBadge.textContent = `${liveCount} Live`;

  if (hosts.length === 0) {
    list.innerHTML = '<div style="font-size: 11px; color: var(--muted); text-align: center; padding: 12px;">No auto-hosts configured yet. Add one in Setup.</div>';
    selectMonitorInstance(null);
    return;
  }

  let html = '';
  hosts.forEach(h => {
    const isRunning = curStatus.running && curStatus.command === h.cmd;
    const isSelected = _selectedMonitorHostId === h.id || (!_selectedMonitorHostId && isRunning);

    html += `
      <div class="autohost-instance-item ${isSelected ? 'active' : ''}" onclick="selectMonitorInstance(${h.id})">
        <div style="display: flex; align-items: center; gap: 8px; overflow: hidden;">
          <div class="autohost-status-dot ${isRunning ? 'active' : ''}"></div>
          <div style="font-size: 12px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${h.name}</div>
        </div>
        <div style="font-size: 10px; color: ${isRunning ? '#22c55e' : 'var(--muted)'}; font-weight: 600;">
          ${isRunning ? 'ACTIVE' : 'OFFLINE'}
        </div>
      </div>
    `;
  });

  list.innerHTML = html;

  if (!_selectedMonitorHostId && hosts.length > 0) {
    const runningHost = hosts.find(h => curStatus.running && curStatus.command === h.cmd);
    selectMonitorInstance(runningHost ? runningHost.id : hosts[0].id);
  }
}

function selectMonitorInstance(id) {
  _selectedMonitorHostId = id;

  const hosts = (typeof appConfig !== 'undefined' && appConfig.autoHosts) ? appConfig.autoHosts : [];
  const h = hosts.find(item => item.id === id);
  const curStatus = (typeof currentGameStatus !== 'undefined') ? currentGameStatus : { running: false };

  const targetTitle = document.getElementById('autoMonitorTargetTitle');
  const targetTag = document.getElementById('autoMonitorTargetTag');
  const statusDot = document.getElementById('autoMonitorStatusDot');
  const tunnelVal = document.getElementById('autoMonitorTunnel');
  const viewersVal = document.getElementById('autoMonitorViewers');
  const launchBtn = document.getElementById('autoMonitorLaunchBtn');
  const stopBtn = document.getElementById('autoMonitorStopBtn');
  const placeholder = document.getElementById('autoMonitorPlaceholder');
  const iframe = document.getElementById('autoMonitorIframe');

  document.querySelectorAll('#autoMonitorInstancesList .autohost-instance-item').forEach(el => {
    el.classList.toggle('active', el.textContent.includes(h ? h.name : '___'));
  });

  if (!h) {
    if (targetTitle) targetTitle.textContent = 'No Session Selected';
    if (targetTag) targetTag.textContent = 'Standby';
    if (statusDot) statusDot.classList.remove('active');
    if (launchBtn) launchBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';
    if (placeholder) placeholder.style.display = 'flex';
    if (iframe) iframe.style.display = 'none';
    return;
  }

  const isRunning = curStatus.running && curStatus.command === h.cmd;

  if (targetTitle) targetTitle.textContent = h.name;
  if (targetTag) {
    targetTag.textContent = isRunning ? 'Running' : 'Standby';
    targetTag.style.color = isRunning ? '#22c55e' : 'var(--muted)';
  }
  if (statusDot) statusDot.classList.toggle('active', isRunning);
  if (tunnelVal) tunnelVal.textContent = h.tunnel || 'Default';
  if (viewersVal) viewersVal.textContent = isRunning ? `${curStatus.viewers || 0} Players` : '0 Players';

  if (isRunning) {
    if (launchBtn) launchBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'inline-block';
    if (placeholder) placeholder.style.display = 'none';
    if (iframe) {
      iframe.style.display = 'block';
      if (!iframe.src || !iframe.src.includes('host-minimal.html')) {
        iframe.src = '/pages/host-minimal.html?auto=1';
      }
    }
  } else {
    if (launchBtn) launchBtn.style.display = 'inline-block';
    if (stopBtn) stopBtn.style.display = 'none';
    if (placeholder) placeholder.style.display = 'flex';
    if (iframe) {
      iframe.style.display = 'none';
      iframe.src = '';
    }
  }
}

function openMonitorFullscreen() {
  const hosts = (typeof appConfig !== 'undefined' && appConfig.autoHosts) ? appConfig.autoHosts : [];
  const h = hosts.find(item => item.id === _selectedMonitorHostId) || hosts[0];
  const title = h ? h.name : 'Auto-Host';
  const url = `/host?auto=1&title=${encodeURIComponent(title)}`;
  window.location.href = url;
}

function openMonitorPopout() {
  const hosts = (typeof appConfig !== 'undefined' && appConfig.autoHosts) ? appConfig.autoHosts : [];
  const h = hosts.find(item => item.id === _selectedMonitorHostId) || hosts[0];
  const title = h ? h.name : 'Auto-Host';
  const url = `/host?auto=1&title=${encodeURIComponent(title)}`;
  window.open(url, '_blank', 'width=1280,height=720,menubar=no,toolbar=no,location=no');
}

function launchSelectedMonitorSession() {
  if (_selectedMonitorHostId) {
    launchAutoHostById(_selectedMonitorHostId);
  } else {
    deployCurrentAutoHost();
  }
}

function openAutoHostEditor() {
  const currentConfig = (typeof appConfig !== 'undefined' && appConfig.autoHosts) ? appConfig.autoHosts : [];
  const editorHtml = `
    <div id="hostEditorModal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); display:flex; justify-content:center; align-items:center; z-index:999999;">
      <div style="background:var(--surface); padding:20px; border-radius:12px; width:640px; max-width:92%; border:1px solid var(--border);">
        <h3 style="margin-bottom:10px; color:var(--accent);">Edit Auto-Hosts (JSON)</h3>
        <textarea id="hostEditorText" style="width:100%; height:320px; background:#000; color:#0f0; font-family:monospace; font-size:12px; padding:10px; border:1px solid #333; border-radius:6px;">${JSON.stringify(currentConfig, null, 2)}</textarea>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:15px;">
          <button style="padding:8px 16px; cursor:pointer; background:transparent; border:1px solid var(--border); color:#fff; border-radius:6px;" onclick="document.getElementById('hostEditorModal').remove()">Cancel</button>
          <button style="padding:8px 16px; cursor:pointer; background:var(--accent); border:none; color:#000; border-radius:6px; font-weight:bold;" onclick="saveAutoHostConfig()">Save Changes</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', editorHtml);
}

function saveAutoHostConfig() {
  try {
    const parsed = JSON.parse(document.getElementById('hostEditorText').value);
    if (typeof appConfig !== 'undefined') appConfig.autoHosts = parsed;
    if (typeof saveAppConfigToElectron === 'function') saveAppConfigToElectron();
    if (typeof syncToNode === 'function') syncToNode();
    const modal = document.getElementById('hostEditorModal');
    if (modal) modal.remove();
    renderAutoHosts();
    renderMonitorInstances();
  } catch (e) {
    alert('Invalid JSON! Check for missing commas or quotes.');
  }
}

function saveAutoHost() {
  const nameInput = document.getElementById('autoName');
  const cmdInput = document.getElementById('autoCmd');
  const tunnelInput = document.getElementById('autoTunnel');
  const maxPlayersInput = document.getElementById('autoMaxPlayers');

  const name = nameInput ? nameInput.value.trim() : '';
  const cmd = cmdInput ? cmdInput.value.trim() : '';
  const tunnel = tunnelInput ? (tunnelInput.value || 'default') : 'default';
  const maxPlayers = maxPlayersInput ? (maxPlayersInput.value || '4') : '4';

  if (!name || !cmd) {
    alert('Please choose a game or provide both a Game Name and Launch Command.');
    return;
  }
  if (typeof appConfig === 'undefined') return;
  if (!appConfig.autoHosts) appConfig.autoHosts = [];

  const existing = _editingHostId
    ? appConfig.autoHosts.find(h => h.id === _editingHostId)
    : appConfig.autoHosts.find(h => h.name === name);

  if (existing) {
    existing.name = name;
    existing.cmd = cmd;
    existing.tunnel = tunnel;
    existing.maxPlayers = maxPlayers;
    existing.status = 'offline';
  } else {
    appConfig.autoHosts.push({
      id: Date.now(),
      name,
      cmd,
      tunnel,
      maxPlayers,
      status: 'offline'
    });
  }

  _editingHostId = null;
  if (typeof saveAppConfigToElectron === 'function') saveAppConfigToElectron();
  if (typeof syncToNode === 'function') syncToNode();

  renderAutoHosts();
  renderMonitorInstances();
  switchAutoHostTab('monitor');
}

function shellQuote(s) {
  return '"' + String(s).replace(/[\\"`$]/g, (m) => '\\' + m) + '"';
}

function buildAutoHostCommand(h) {
  const tunnel = h.tunnel && h.tunnel !== 'default' ? ` --game-tunnel ${h.tunnel}` : '';
  return `./bin/start-arcade.sh --game-name ${shellQuote(h.name || 'Auto-Host')}${tunnel}`;
}

function deployCurrentAutoHost() {
  const curStatus = (typeof currentGameStatus !== 'undefined') ? currentGameStatus : { running: false };
  if (curStatus.running) {
    killGame();
    return;
  }

  const nameInput = document.getElementById('autoName');
  const cmdInput = document.getElementById('autoCmd');
  const tunnelInput = document.getElementById('autoTunnel');
  const modeSel = document.getElementById('autoLaunchMode');

  const name = nameInput ? nameInput.value.trim() : '';
  const cmd = cmdInput ? cmdInput.value.trim() : '';
  const tunnel = tunnelInput ? (tunnelInput.value || 'default') : 'default';
  const mode = modeSel ? (modeSel.value || 'background') : 'background';

  if (!cmd || !name) {
    alert('Select an installed game or provide a Game Name and Command in Setup first.');
    switchAutoHostTab('setup');
    return;
  }

  saveAutoHost();

  const port = _getAutoHostPort();
  const cfgWithoutTunnel = typeof _cfgWithoutTunnel === 'function' ? _cfgWithoutTunnel() : appConfig;
  fetch('http://localhost:' + port + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfgWithoutTunnel)
  }).catch(() => { }).then(() => fetch('http://localhost:' + port + '/api/open-terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: buildAutoHostCommand({ name, tunnel }),
      name,
      tunnel,
      mode
    })
  })).then(r => r.json()).then(d => {
    if (!d.ok) alert('Launch failed: ' + (d.reason || ''));
  }).catch(() => alert('Launch failed.'));

  switchAutoHostTab('monitor');
}

function launchAutoHostById(id) {
  const hosts = (typeof appConfig !== 'undefined' && appConfig.autoHosts) ? appConfig.autoHosts : [];
  const h = hosts.find(item => item.id === id);
  if (!h) return;

  const nameInput = document.getElementById('autoName');
  const cmdInput = document.getElementById('autoCmd');
  if (nameInput) nameInput.value = h.name;
  if (cmdInput) cmdInput.value = h.cmd;
  selectAutoTunnelProvider(h.tunnel || 'default');

  deployCurrentAutoHost();
}

function editAutoHostById(id) {
  const hosts = (typeof appConfig !== 'undefined' && appConfig.autoHosts) ? appConfig.autoHosts : [];
  const h = hosts.find(item => item.id === id);
  if (!h) return;

  _editingHostId = id;
  const nameInput = document.getElementById('autoName');
  const cmdInput = document.getElementById('autoCmd');
  if (nameInput) nameInput.value = h.name;
  if (cmdInput) cmdInput.value = h.cmd;
  selectAutoTunnelProvider(h.tunnel || 'default');
  selectAutoMaxPlayers(h.maxPlayers || '4');

  const titleEl = document.getElementById('autoSelectedTitle');
  const metaEl = document.getElementById('autoSelectedMeta');
  if (titleEl) titleEl.textContent = h.name;
  if (metaEl) metaEl.textContent = `Editing preset: ${h.name}`;

  switchAutoHostTab('setup');
}

async function deleteAutoHostById(id) {
  const showConfirm = typeof showAppConfirm === 'function' ? showAppConfirm : window.confirm;
  if (await showConfirm('Delete Configuration', 'Remove this saved Auto-Host configuration?', 'Delete', 'Cancel')) {
    if (typeof appConfig !== 'undefined' && appConfig.autoHosts) {
      appConfig.autoHosts = appConfig.autoHosts.filter(item => item.id !== id);
      if (typeof saveAppConfigToElectron === 'function') saveAppConfigToElectron();
      if (typeof syncToNode === 'function') syncToNode();
      renderAutoHosts();
      renderMonitorInstances();
    }
  }
}

function onAutoHostPresetSelected(val) {
  if (val === 'new') {
    _editingHostId = null;
    const nameInput = document.getElementById('autoName');
    const cmdInput = document.getElementById('autoCmd');
    if (nameInput) nameInput.value = '';
    if (cmdInput) cmdInput.value = '';
    switchAutoHostTab('setup');
  } else {
    editAutoHostById(Number(val));
  }
}

function copyActiveArcadeLink() {
  const curStatus = (typeof currentGameStatus !== 'undefined') ? currentGameStatus : { running: false };
  if (curStatus.tunnelUrl) {
    const cleanUrl = curStatus.tunnelUrl.replace(/\/$/, '');
    navigator.clipboard.writeText(cleanUrl).then(() => {
      alert('Arcade link copied to clipboard: ' + cleanUrl);
    }).catch(() => {
      alert('Share URL: ' + cleanUrl);
    });
  }
}

function openAutoHostTerminal() {
  deployCurrentAutoHost();
}

async function killGame() {
  const showConfirm = typeof showAppConfirm === 'function' ? showAppConfirm : window.confirm;
  if (await showConfirm('Stop Game', 'Stop the running game session?', 'Stop', 'Cancel')) {
    const port = _getAutoHostPort();
    fetch(`http://localhost:${port}/api/restart-game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'KILL_ONLY' })
    });
  }
}

function toggleAutoHost() {
  const track = document.getElementById('settingTrackAutoHost');
  if (!track) return;
  const isAuto = track.classList.toggle('on');
  localStorage.setItem('ns_auto_host', isAuto ? 'true' : 'false');
  if (typeof appConfig !== 'undefined') {
    appConfig.bootToHost = isAuto;
    appConfig.autoStartHost = isAuto;
  }
  if (typeof saveAppConfigToElectron === 'function') saveAppConfigToElectron();
  const port = _getAutoHostPort();
  fetch('http://localhost:' + port + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootToHost: isAuto })
  }).catch(() => { });
}

function renderAutoHosts() {
  const list = document.getElementById('activeAutoHostsList');
  const hosts = (typeof appConfig !== 'undefined' && appConfig.autoHosts) ? appConfig.autoHosts : [];

  const sel = document.getElementById('autoHostConfigSelector');
  if (sel) {
    let opts = '<option value="new">+ New Auto-Host</option>';
    hosts.forEach(h => {
      opts += `<option value="${h.id}">${h.name}</option>`;
    });
    sel.innerHTML = opts;
    if (_editingHostId) sel.value = String(_editingHostId);
  }

  const curStatus = (typeof currentGameStatus !== 'undefined') ? currentGameStatus : { running: false };
  const isAnyRunning = !!curStatus.running;

  const deployBtn = document.getElementById('autoDeployBtn');
  if (deployBtn) {
    if (isAnyRunning) {
      deployBtn.textContent = 'Stop Auto-Host';
      deployBtn.className = 'autohost-btn-action autohost-btn-stop';
    } else {
      deployBtn.textContent = 'Deploy Auto-Host';
      deployBtn.className = 'autohost-btn-action autohost-btn-deploy';
    }
  }

  const teleDot = document.getElementById('autoTeleDot');
  const teleText = document.getElementById('autoTeleStatusText');
  const teleLinkBtn = document.getElementById('autoTeleLinkBtn');

  if (teleDot) teleDot.classList.toggle('active', isAnyRunning);
  if (teleText) {
    teleText.textContent = isAnyRunning
      ? 'Live - Isolated session running'
      : 'Standby - Ready to deploy';
  }
  if (teleLinkBtn) {
    teleLinkBtn.style.display = (isAnyRunning && curStatus.tunnelUrl) ? 'inline-block' : 'none';
  }

  if (_activeAutoTab === 'monitor') {
    renderMonitorInstances();
  }

  if (!list) return;

  if (hosts.length === 0) {
    list.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px;">No configurations saved yet. Select a game in the Setup tab to deploy.</div>';
    return;
  }

  let html = '';
  hosts.forEach(h => {
    const isRunning = curStatus.running && curStatus.command === h.cmd;
    const tunnelLabel = h.tunnel && h.tunnel !== 'default' ? h.tunnel : 'global default';

    html += `
      <div style="background: #0d1016; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 14px; display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 10px; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 240px;">
          <div class="autohost-status-dot ${isRunning ? 'active' : ''}"></div>
          <div style="display: flex; flex-direction: column; gap: 2px; overflow: hidden;">
            <div style="font-size: 13px; font-weight: 700; color: var(--text);">${h.name}</div>
            <div style="font-size: 10px; font-family: monospace; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${h.cmd}</div>
            <div style="font-size: 10px; color: var(--muted); margin-top: 2px;">Tunnel: ${tunnelLabel} · Max Players: ${h.maxPlayers || '4'}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          ${isRunning
            ? '<button type="button" class="autohost-btn-sm danger" onclick="killGame()">Stop</button>'
            : `<button type="button" class="autohost-btn-sm primary" onclick="launchAutoHostById(${h.id})">Launch</button>`
          }
          <button type="button" class="autohost-btn-sm" onclick="editAutoHostById(${h.id})">Edit</button>
          <button type="button" class="autohost-btn-sm danger" onclick="deleteAutoHostById(${h.id})">Delete</button>
        </div>
      </div>
    `;
  });

  list.innerHTML = html;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    checkAutoHostPreflight();
  });
} else {
  checkAutoHostPreflight();
}
