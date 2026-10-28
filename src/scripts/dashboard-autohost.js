// ── Containers and Auto-Host Module ──────────────────────────────────
let _autoSteamByLabel = new Map();
let _autoSteamLoaded = false;
let _autoSteamLoading = false;
let _autoSteamLastPickedName = '';

function _getAutoHostPort() {
  if (typeof _getServerPort === 'function') return _getServerPort();
  const params = new URLSearchParams(window.location.search);
  return params.get('port') || window.location.port || '3000';
}

function openAutoHostEditor() {
  const currentConfig = (typeof appConfig !== 'undefined' && appConfig.autoHosts) ? appConfig.autoHosts : [];
  const editorHtml = `
            <div id="hostEditorModal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); display:flex; justify-content:center; align-items:center; z-index:999999;">
                <div style="background:var(--surface); padding:20px; border-radius:8px; width:600px; max-width:90%; border:1px solid var(--border);">
                    <h3 style="margin-bottom:10px; color:var(--accent);">Edit Auto-Hosts (JSON)</h3>
                    <textarea id="hostEditorText" style="width:100%; height:300px; background:#000; color:#0f0; font-family:monospace; padding:10px; border:1px solid #333;">${JSON.stringify(currentConfig, null, 2)}</textarea>
                    <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:15px;">
                        <button style="padding: 8px 16px; cursor: pointer; background: transparent; border: 1px solid var(--border); color: #fff; border-radius: 4px;" onclick="document.getElementById('hostEditorModal').remove()">Cancel</button>
                        <button style="padding: 8px 16px; cursor: pointer; background: var(--accent); border: none; color: #000; border-radius: 4px; font-weight: bold;" onclick="saveAutoHostConfig()">Save Changes</button>
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
  } catch (e) {
    alert('Invalid JSON! Check for missing commas or quotes.');
  }
}

function loadAutoHostSteamGames(force) {
  if (_autoSteamLoading || (_autoSteamLoaded && !force)) return Promise.resolve();
  _autoSteamLoading = true;
  const meta = document.getElementById('autoGamePickMeta');
  if (meta) meta.textContent = 'Scanning installed Steam libraries…';

  const port = _getAutoHostPort();
  return fetch(`http://localhost:${port}/api/games`)
    .then(r => r.json())
    .then(d => {
      const games = (d.games || []).filter(g => g.launcher === 'steam');
      games.sort((a, b) => (b.lastPlayed - a.lastPlayed) || String(a.name).localeCompare(String(b.name)));

      _autoSteamByLabel = new Map();
      const dl = document.getElementById('autoSteamGames');
      if (dl) dl.textContent = '';

      games.forEach(g => {
        const label = String(g.name);
        const key = _autoSteamByLabel.has(label) ? `${label} (${g.id})` : label;
        _autoSteamByLabel.set(key, g);
        if (!dl) return;
        const opt = document.createElement('option');
        opt.value = key;
        dl.appendChild(opt);
      });

      _autoSteamLoaded = true;
      if (meta) {
        meta.textContent = games.length
          ? `${games.length} Steam games detected — pick one to auto-fill its launch command.`
          : 'No installed Steam games found. Type a launch command manually below.';
      }
    })
    .catch(() => {
      if (meta) meta.textContent = 'Could not scan installed games — type a launch command manually below.';
    })
    .finally(() => { _autoSteamLoading = false; });
}

function onAutoGamePicked(quiet) {
  const input = document.getElementById('autoGamePick');
  if (!input) return;
  const meta = document.getElementById('autoGamePickMeta');
  const game = _autoSteamByLabel.get(input.value.trim());
  if (!game) {
    if (meta && !quiet) meta.textContent = 'Unknown entry — pick a suggested game, or type a command below.';
    return;
  }

  const cmd = `steam steam://rungameid/${game.id}`;
  const cmdInput = document.getElementById('autoCmd');
  if (cmdInput) cmdInput.value = cmd;

  const nameInput = document.getElementById('autoName');
  const currentName = nameInput ? nameInput.value.trim() : '';
  if (nameInput && (!currentName || currentName === _autoSteamLastPickedName)) {
    nameInput.value = game.name;
    _autoSteamLastPickedName = game.name;
  }

  if (meta) meta.textContent = `Steam AppID ${game.id} → ${cmd}`;
}

function saveAutoHost() {
  const name = document.getElementById('autoName').value.trim();
  const cmd = document.getElementById('autoCmd').value.trim();
  const tunnel = document.getElementById('autoTunnel').value;

  if (!name || !cmd) return;
  if (typeof appConfig === 'undefined') return;
  if (!appConfig.autoHosts) appConfig.autoHosts = [];
  const existing = appConfig.autoHosts.find(h => h.name === name);
  if (existing) {
    existing.cmd = cmd;
    existing.tunnel = tunnel;
    existing.status = 'offline';
  } else {
    appConfig.autoHosts.push({ id: Date.now(), name, cmd, tunnel, status: 'offline' });
  }

  if (typeof saveAppConfigToElectron === 'function') saveAppConfigToElectron();
  if (typeof syncToNode === 'function') syncToNode();
  renderAutoHosts();
  document.getElementById('autoName').value = '';
  document.getElementById('autoCmd').value = '';
}

function shellQuote(s) {
  return '"' + String(s).replace(/[\\"`$]/g, (m) => '\\' + m) + '"';
}

function buildAutoHostCommand(h) {
  const tunnel = h.tunnel ? ` --game-tunnel ${h.tunnel}` : '';
  return `./bin/start-arcade.sh --game-name ${shellQuote(h.name || 'Auto-Host')}${tunnel}`;
}

function renderAutoHosts() {
  const list = document.getElementById('activeAutoHostsList');
  if (!list) return;

  const hosts = (typeof appConfig !== 'undefined' && appConfig.autoHosts) ? appConfig.autoHosts : [];
  if (hosts.length === 0) {
    list.innerHTML = `<h2>Saved Configurations</h2><div style="padding: 30px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px;">No containers configured yet.</div>`;
    return;
  }

  let html = `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                        <h2 style="margin:0; border:none; padding:0;">Saved Configurations</h2>
                        <button style="padding:4px 12px; font-size:11px; cursor:pointer; border-radius:4px; background:transparent; border:1px solid var(--border); color:#fff;" onclick="openAutoHostEditor()">Edit JSON</button>
                    </div>`;

  const curStatus = (typeof currentGameStatus !== 'undefined') ? currentGameStatus : { running: false };

  hosts.forEach(h => {
    const isRunning = curStatus.running && curStatus.command === h.cmd;

    let logDisplay = '';
    const launchCmd = buildAutoHostCommand(h)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (isRunning) {
      logDisplay = `<div style="margin-top:8px; padding:6px; background:#000; border:1px solid #333; border-radius:4px; font-family:monospace; font-size:10px; color:#eab308;">&gt; Game loop active inside an isolated virtual display</div>`;
    } else {
      logDisplay = `<div style="margin-top:8px; padding:6px; background:#000; border:1px solid #222; border-radius:4px; font-family:monospace; font-size:10px; color:#555;">To launch: ${launchCmd}</div>`;
    }

    let activeUrl = '';
    if (isRunning && curStatus.tunnelUrl) {
      const cleanUrl = curStatus.tunnelUrl.replace(/\/$/, '');
      const shareUrl = `${cleanUrl}/?s=${h.id.toString().slice(-4)}`;
      activeUrl = `<div style="font-size:10px; color:#00ff88; margin-top:8px; padding-top:8px; border-top:1px solid #333;">Live Arcade Tunnel: <a href="${shareUrl}" target="_blank" style="color:#00ff88; text-decoration:none;">${shareUrl}</a></div>`;
    }

    const statusDot = isRunning
      ? `<div style="width:10px; height:10px; border-radius:50%; background:#00ff88; box-shadow:0 0 8px #00ff88; animation: pulse 2s infinite; margin-right:10px;"></div>`
      : `<div style="width:10px; height:10px; border-radius:50%; background:#444; margin-right:10px;"></div>`;

    html += `
            <div style="background: var(--surface); border: 1px solid ${isRunning ? 'var(--accent)' : 'var(--border)'}; padding: 16px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                <div style="overflow: hidden; padding-right: 16px; flex:1;">
                    <div style="display:flex; align-items:center;">
                        ${statusDot}
                        <div style="font-weight: 600; color: ${isRunning ? '#fff' : 'var(--accent)'}; font-size: 14px;">${h.name}</div>
                    </div>
                    <div style="font-size: 11px; color: var(--muted); font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top:6px;">> ${h.cmd}</div>
                    ${logDisplay}
                    ${activeUrl}
                </div>
            </div>`;
  });
  list.innerHTML = html + `<style>@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }</style>`;
}

function openAutoHostTerminal() {
  const cmd = document.getElementById('autoCmd').value.trim();
  const name = document.getElementById('autoName').value.trim();
  const tunnelSel = document.getElementById('autoTunnel');
  const tunnel = tunnelSel ? (tunnelSel.value || '') : 'default';
  if (!cmd) { alert('Enter a launch command first.'); return; }
  if (!name) { alert('Give this configuration a Game/Lobby Name first — the worker looks it up by name.'); return; }

  if (typeof appConfig === 'undefined') return;
  if (!appConfig.autoHosts) appConfig.autoHosts = [];
  const existing = appConfig.autoHosts.find(h => h.name === name);
  if (existing) { existing.cmd = cmd; existing.tunnel = tunnel; }
  else appConfig.autoHosts.push({ id: Date.now(), name, cmd, tunnel, status: 'offline' });
  if (typeof saveAppConfigToElectron === 'function') saveAppConfigToElectron();
  renderAutoHosts();

  const port = _getAutoHostPort();
  const cfgWithoutTunnel = typeof _cfgWithoutTunnel === 'function' ? _cfgWithoutTunnel() : appConfig;
  fetch('http://localhost:' + port + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfgWithoutTunnel)
  }).catch(() => { }).then(() => fetch('http://localhost:' + port + '/api/open-terminal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: buildAutoHostCommand({ name, tunnel }), name })
  })).then(r => r.json()).then(d => { if (!d.ok) alert('Launch failed: ' + (d.reason || '')); })
    .catch(() => alert('Launch failed.'));
}

async function killGame() {
  const showConfirm = typeof showAppConfirm === 'function' ? showAppConfirm : window.confirm;
  if (await showConfirm("Stop Game", "Stop the running game?", "Stop", "Cancel")) {
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootToHost: isAuto })
  }).catch(() => { });
}
