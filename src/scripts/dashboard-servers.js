// ── Community STUN & TURN Servers Module ──────────────────────────────
function _getServersPort() {
  if (typeof _getServerPort === 'function') return _getServerPort();
  const params = new URLSearchParams(window.location.search);
  return params.get('port') || window.location.port || '3000';
}

async function fetchCommunityServers() {
  const container = document.getElementById('serverListContainer');
  if (!container) return;

  container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px;">Loading community servers...</div>`;

  try {
    const res = await fetch(`http://localhost:${_getServersPort()}/api/community-servers`);
    if (!res.ok) throw new Error('Failed to fetch');
    const servers = await res.json();

    container.innerHTML = '';

    const resetContainer = document.createElement('div');
    resetContainer.style.display = 'flex';
    resetContainer.style.justifyContent = 'flex-end';
    resetContainer.style.marginBottom = '16px';
    resetContainer.innerHTML = `
          <button id="resetStunBtn" style="padding: 6px 12px; font-size: 12px; background: rgba(255,255,255,0.05); color: var(--text); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; transition: all 0.2s;">
            <i class="fas fa-undo" style="margin-right: 6px;"></i> Reset to Default Google STUN
          </button>
        `;
    container.appendChild(resetContainer);

    resetContainer.querySelector('#resetStunBtn').addEventListener('click', () => {
      localStorage.removeItem('ns_custom_stun');
      if (window.electronAPI && window.electronAPI.saveEnv) {
        window.electronAPI.saveEnv('STUN_URL', '');
      }
      alert("Reset STUN server back to the Google default.\n\nYour changes have been discarded.");
      fetchCommunityServers();
    });

    if (servers.length === 0) {
      const empty = document.createElement('div');
      empty.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px;">No servers currently available.</div>`;
      container.appendChild(empty);
      return;
    }

    const currentSelectedUrl = localStorage.getItem('ns_custom_stun');
    if (!currentSelectedUrl) {
      resetContainer.style.display = 'none';
    }

    servers.forEach(server => {
      const safeName = String(server.name).replace(/[<>"'&]/g, '');
      const safeDesc = String(server.description || '').replace(/[<>"'&]/g, '');
      const safeAuthor = String(server.author || '').replace(/[<>"'&]/g, '');
      const safeRegion = String(server.region || 'Unknown').replace(/[<>"'&]/g, '');
      const isSelected = currentSelectedUrl === server.url || (!currentSelectedUrl && safeName.includes("Default"));
      const card = document.createElement('div');
      card.className = 'container-card';
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'center';
      card.style.transition = 'all 0.3s ease';

      if (isSelected) {
        card.style.border = '2px solid var(--accent)';
        card.style.background = 'rgba(var(--accent-rgb), 0.05)';
        card.style.boxShadow = '0 0 15px rgba(var(--accent-rgb), 0.1)';
      }

      card.innerHTML = `
            <div style="flex: 1;">
              <h3 style="margin:0; font-size:16px; display:flex; align-items:center; gap:8px;">
                ${safeName}
                ${isSelected ? '<span style="font-size:10px; background:var(--accent); color:white; padding:2px 6px; border-radius:4px; font-weight:bold; letter-spacing:0.5px;">ACTIVE</span>' : ''}
              </h3>
              <p style="margin:6px 0; color:var(--muted); font-size:13px; line-height: 1.4;">${safeDesc}</p>
              <div style="font-size:11px; color:var(--text); opacity:0.8; display:flex; gap:12px;">
                <span><i class="fas fa-globe"></i> ${safeRegion}</span>
                <span><i class="fas fa-user"></i> ${safeAuthor}</span>
              </div>
            </div>
            <button class="primary-btn" style="padding:10px 20px; font-size:13px; font-weight: 600; border-radius: 8px; margin-left: 16px; ${isSelected ? 'background: rgba(255,255,255,0.1); color: var(--text); border: 1px solid var(--border); box-shadow: none;' : ''}" ${isSelected ? 'disabled' : ''}>
              ${isSelected ? 'Selected' : 'Select'}
            </button>
          `;

      if (!isSelected) {
        card.querySelector('button').addEventListener('click', () => {
          const confirmMsg = "PRIVACY WARNING:\n\nIf you select a Community STUN Server, your public IP address will be visible to the person hosting the server.\n\nDo you want to proceed and use " + server.name + "?";
          if (!confirm(confirmMsg)) return;

          localStorage.setItem('ns_custom_stun', server.url);

          if (window.electronAPI && window.electronAPI.saveEnv) {
            window.electronAPI.saveEnv('STUN_URL', server.url);
          }

          fetchCommunityServers();
        });
      }

      container.appendChild(card);
    });

  } catch (err) {
    console.error('Failed to fetch community STUN servers:', err);
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: #ff5d3d; border: 1px dashed var(--border); border-radius: 8px;">Failed to load server list. Check your internet connection.</div>`;
  }
}

async function checkTurnServerStatus(turnUrl, username, credential) {
  return new Promise((resolve) => {
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: [turnUrl], username, credential }]
      });

      let resolved = false;
      const finish = (status) => {
        if (resolved) return;
        resolved = true;
        pc.close();
        resolve(status);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          if (event.candidate.type === 'relay' || event.candidate.candidate.includes('typ relay')) {
            finish(true);
          }
        } else {
          finish(false);
        }
      };

      setTimeout(() => finish(false), 10000);

      pc.createDataChannel('ping');
      pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => finish(false));
    } catch (e) {
      resolve(false);
    }
  });
}

async function fetchCommunityTurnServers() {
  const container = document.getElementById('turnListContainer');
  if (!container) return;

  try {
    const res = await fetch(`http://localhost:${_getServersPort()}/api/community-turn-servers`);
    if (!res.ok) throw new Error('Failed to fetch');
    const servers = await res.json();

    container.innerHTML = '';

    const resetContainer = document.createElement('div');
    resetContainer.style.display = 'flex';
    resetContainer.style.justifyContent = 'flex-end';
    resetContainer.style.marginBottom = '16px';
    resetContainer.innerHTML = `
          <button id="resetTurnBtn" style="padding: 6px 12px; font-size: 12px; background: rgba(255,255,255,0.05); color: var(--text); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; transition: all 0.2s;">
            <i class="fas fa-undo" style="margin-right: 6px;"></i> Reset to Default TURN
          </button>
        `;
    container.appendChild(resetContainer);

    resetContainer.querySelector('#resetTurnBtn').addEventListener('click', () => {
      localStorage.removeItem('ns_custom_turn_url');
      localStorage.removeItem('ns_custom_turn_username');
      localStorage.removeItem('ns_custom_turn_credential');
      if (window.electronAPI && window.electronAPI.saveEnv) {
        window.electronAPI.saveEnv('TURN_URL', '');
        window.electronAPI.saveEnv('TURN_USERNAME', '');
        window.electronAPI.saveEnv('TURN_CREDENTIAL', '');
      }
      alert("Reset TURN server back to the default.\n\nYour changes have been discarded.");
      fetchCommunityTurnServers();
    });

    if (servers.length === 0) {
      const empty = document.createElement('div');
      empty.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px;">No servers currently available.</div>`;
      container.appendChild(empty);
      return;
    }

    const currentSelectedUrl = localStorage.getItem('ns_custom_turn_url');
    if (!currentSelectedUrl) {
      resetContainer.style.display = 'none';
    }

    for (const server of servers) {
      const safeName = String(server.name).replace(/[<>"'&]/g, '');
      const safeDesc = String(server.description || '').replace(/[<>"'&]/g, '');
      const safeAuthor = String(server.author || '').replace(/[<>"'&]/g, '');
      const safeRegion = String(server.region || 'Unknown').replace(/[<>"'&]/g, '');
      const isSelected = currentSelectedUrl === server.url || (!currentSelectedUrl && safeName.includes("Default"));
      const hideDot = !!(server.url && server.url.toLowerCase().includes('metered.ca'));
      const card = document.createElement('div');
      card.className = 'container-card';
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'center';
      card.style.transition = 'all 0.3s ease';

      if (isSelected) {
        card.style.border = '2px solid var(--accent)';
        card.style.background = 'rgba(var(--accent-rgb), 0.05)';
        card.style.boxShadow = '0 0 15px rgba(var(--accent-rgb), 0.1)';
      }

      card.innerHTML = `
            <div style="flex: 1;">
              <h3 style="margin:0; font-size:16px; display:flex; align-items:center; gap:8px;">
                ${hideDot ? '' : '<span class="ping-status" style="display:inline-block; width:10px; height:10px; border-radius:50%; background:gray;" title="Pinging..."></span>'}
                ${safeName}
                ${isSelected ? '<span style="font-size:10px; background:var(--accent); color:white; padding:2px 6px; border-radius:4px; font-weight:bold; letter-spacing:0.5px;">ACTIVE</span>' : ''}
              </h3>
              <p style="margin:6px 0; color:var(--muted); font-size:13px; line-height: 1.4;">${safeDesc}</p>
              <div style="font-size:11px; color:var(--text); opacity:0.8; display:flex; gap:12px;">
                <span><i class="fas fa-globe"></i> ${safeRegion}</span>
                <span><i class="fas fa-user"></i> ${safeAuthor}</span>
              </div>
            </div>
            <button class="primary-btn" style="padding:10px 20px; font-size:13px; font-weight: 600; border-radius: 8px; margin-left: 16px; ${isSelected ? 'background: rgba(255,255,255,0.1); color: var(--text); border: 1px solid var(--border); box-shadow: none;' : ''}" ${isSelected ? 'disabled' : ''}>
              ${isSelected ? 'Selected' : 'Select'}
            </button>
          `;

      if (!isSelected) {
        card.querySelector('button').addEventListener('click', () => {
          const confirmMsg = "CRITICAL PRIVACY WARNING:\n\nThis server will route ALL of your game video, audio, and input traffic.\n\nOnly proceed if you trust this server host.\n\nProceed with " + server.name + "?";
          if (!confirm(confirmMsg)) return;

          localStorage.setItem('ns_custom_turn_url', server.url);
          localStorage.setItem('ns_custom_turn_username', server.username);
          localStorage.setItem('ns_custom_turn_credential', server.credential);

          if (window.electronAPI && window.electronAPI.saveEnv) {
            window.electronAPI.saveEnv('TURN_URL', server.url);
            window.electronAPI.saveEnv('TURN_USERNAME', server.username);
            window.electronAPI.saveEnv('TURN_CREDENTIAL', server.credential);
          }

          fetchCommunityTurnServers();
        });
      }

      container.appendChild(card);

      if (hideDot) continue;
      checkTurnServerStatus(server.url, server.username, server.credential).then(isOnline => {
        const indicator = card.querySelector('.ping-status');
        if (indicator) {
          if (isOnline) {
            indicator.style.background = '#34d399';
            indicator.style.boxShadow = '0 0 5px #34d399';
            indicator.title = 'Online';
          } else {
            indicator.style.background = '#ef4444';
            indicator.style.boxShadow = 'none';
            indicator.title = 'Offline';

            if (isSelected && currentSelectedUrl === server.url) {
              console.warn('[WebRTC] Active Community TURN server is offline. Falling back to default.');
              localStorage.removeItem('ns_custom_turn_url');
              localStorage.removeItem('ns_custom_turn_username');
              localStorage.removeItem('ns_custom_turn_credential');
              if (window.electronAPI && window.electronAPI.saveEnv) {
                window.electronAPI.saveEnv('TURN_URL', '');
                window.electronAPI.saveEnv('TURN_USERNAME', '');
                window.electronAPI.saveEnv('TURN_CREDENTIAL', '');
              }
              fetchCommunityTurnServers();
            }
          }
        }
      });
    }

  } catch (err) {
    console.error('Failed to fetch community TURN servers:', err);
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: #ff5d3d; border: 1px dashed var(--border); border-radius: 8px;">Failed to load TURN server list. Check your internet connection.</div>`;
  }
}
