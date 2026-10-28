// ── Moderator and Ban Management Module ──────────────────────────────
function _getModPort() {
  if (typeof _getServerPort === 'function') return _getServerPort();
  const params = new URLSearchParams(window.location.search);
  return params.get('port') || window.location.port || '3000';
}

function saveModSettings() {
  if (typeof appConfig === 'undefined') return;
  appConfig.modEndpoint = document.getElementById('settingModEndpoint').value.trim() || undefined;
  appConfig.modSecret = document.getElementById('settingModSecret').value.trim() || undefined;

  const statusEl = document.getElementById('modConnectionStatus');
  if (statusEl) statusEl.textContent = '';
  if (typeof saveAppConfigToElectron === 'function') saveAppConfigToElectron();
  if (typeof syncToNode === 'function') syncToNode();
}

async function verifyModConnection() {
  let endpoint = document.getElementById('settingModEndpoint').value.trim();
  const secret = document.getElementById('settingModSecret').value.trim();
  const statusEl = document.getElementById('modConnectionStatus');
  if (!endpoint || !secret) {
    if (statusEl) {
      statusEl.textContent = 'Please fill in both fields first.';
      statusEl.style.color = 'var(--warn)';
    }
    return;
  }
  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    endpoint = 'https://' + endpoint;
  }
  endpoint = endpoint
    .replace(/\/+$/, '')
    .replace(/\/arcade\/?$/, '')
    .replace(/\/api\/mod\/?$/, '');
  endpoint += '/api/mod';
  if (statusEl) {
    statusEl.textContent = 'Verifying...';
    statusEl.style.color = 'var(--muted2)';
  }
  try {
    const res = await fetch(endpoint, {
      headers: { 'Authorization': 'Bearer ' + secret }
    });
    if (res.ok) {
      if (statusEl) {
        statusEl.textContent = 'Connected — API is live';
        statusEl.style.color = 'var(--green)';
      }
      const banArea = document.getElementById('banManagementArea');
      if (banArea) banArea.style.display = 'block';
      fetchBanList();
    } else if (res.status === 401) {
      if (statusEl) {
        statusEl.textContent = 'Unauthorized — check your token';
        statusEl.style.color = 'var(--danger)';
      }
    } else {
      if (statusEl) {
        statusEl.textContent = 'Error ' + res.status + ' — check your endpoint URL';
        statusEl.style.color = 'var(--danger)';
      }
    }
  } catch (e) {
    if (statusEl) {
      if (e.message?.includes('Failed to fetch') || e instanceof TypeError) {
        statusEl.textContent = 'CORS blocked — disable Browser Integrity Check in Cloudflare dashboard, or add WAF bypass rule for OPTIONS /api/*';
      } else {
        statusEl.textContent = 'Could not reach endpoint — ' + e.message;
      }
      statusEl.style.color = 'var(--danger)';
    }
  }
}

function getModCreds() {
  let endpoint = document.getElementById('settingModEndpoint').value.trim();
  const secret = document.getElementById('settingModSecret').value.trim();
  if (!endpoint || !secret) return null;
  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://'))
    endpoint = 'https://' + endpoint;
  endpoint = endpoint.replace(/\/+$/, '').replace(/\/arcade\/?$/, '').replace(/\/api\/mod\/?$/, '') + '/api/mod';
  return { endpoint, secret };
}

async function fetchBanList() {
  const creds = getModCreds();
  const statusEl = document.getElementById('banStatus');
  const container = document.getElementById('banListContainer');
  if (!creds) {
    if (statusEl) statusEl.textContent = 'Configure endpoint and secret first.';
    return;
  }
  if (statusEl) statusEl.textContent = 'Loading...';
  try {
    const res = await fetch(creds.endpoint, { headers: { 'Authorization': 'Bearer ' + creds.secret } });
    if (!res.ok) {
      if (statusEl) statusEl.textContent = 'Error ' + res.status;
      return;
    }
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) {
      if (container) container.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:13px;">No banned IPs.</div>';
      if (statusEl) statusEl.textContent = list.length + ' bans';
      return;
    }
    if (container) {
      container.innerHTML = list.map(ip =>
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--border);font-size:13px;">' +
        '<span style="color:var(--text);font-family:monospace;">' + ip + '</span>' +
        '<button onclick="executeUnban(\'' + ip + '\')" style="padding:4px 10px;border-radius:4px;cursor:pointer;font-weight:600;border:1px solid var(--danger);background:transparent;color:var(--danger);font-size:11px;font-family:inherit;">Unban</button>' +
        '</div>'
      ).join('');
    }
    if (statusEl) statusEl.textContent = list.length + ' ban' + (list.length !== 1 ? 's' : '');
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Failed to fetch ban list';
    if (container) container.innerHTML = '';
  }
}

async function executeBan() {
  const creds = getModCreds();
  const ip = document.getElementById('banIPInput').value.trim();
  const statusEl = document.getElementById('banStatus');
  if (!creds) {
    if (statusEl) statusEl.textContent = 'Configure endpoint and secret first.';
    return;
  }
  if (!ip) {
    if (statusEl) statusEl.textContent = 'Enter an IP address.';
    return;
  }
  if (statusEl) statusEl.textContent = 'Banning ' + ip + '...';
  try {
    const res = await fetch(creds.endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + creds.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ban', ipToBan: ip })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (statusEl) {
        statusEl.textContent = 'Banned ' + ip;
        statusEl.style.color = 'var(--green)';
      }
      document.getElementById('banIPInput').value = '';
      fetchBanList();
      showBanPopup(ip);
      fetch(`http://localhost:${_getModPort()}/api/system-chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg: 'A viewer was banned from the session.' })
      }).catch(() => { });
    } else {
      if (statusEl) {
        statusEl.textContent = data.message || 'Ban failed';
        statusEl.style.color = 'var(--danger)';
      }
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = 'Request failed';
      statusEl.style.color = 'var(--danger)';
    }
  }
}

function showBanPopup(ip) {
  const existing = document.getElementById('banPopup');
  if (existing) existing.remove();
  const popup = document.createElement('div');
  popup.id = 'banPopup';
  popup.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;background:#1a1a1a;border:1px solid var(--danger);border-radius:10px;padding:16px 20px;max-width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.6);animation:fadeIn 0.3s;font-family:inherit;';

  const title = document.createElement('div');
  title.style.cssText = 'color:var(--danger);font-weight:700;font-size:14px;margin-bottom:4px;';
  title.textContent = 'IP Banned';
  popup.appendChild(title);

  const ipDiv = document.createElement('div');
  ipDiv.style.cssText = 'color:var(--text);font-size:13px;margin-bottom:8px;font-family:monospace;';
  ipDiv.textContent = String(ip || '');
  popup.appendChild(ipDiv);

  const noteDiv = document.createElement('div');
  noteDiv.style.cssText = 'color:var(--muted);font-size:12px;';
  noteDiv.textContent = 'A chat warning has been sent to all viewers.';
  popup.appendChild(noteDiv);

  const dismissBtn = document.createElement('button');
  dismissBtn.style.cssText = 'margin-top:8px;padding:4px 12px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-family:inherit;';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => popup.remove());
  popup.appendChild(dismissBtn);

  document.body.appendChild(popup);
  setTimeout(() => { const p = document.getElementById('banPopup'); if (p) p.remove(); }, 8000);
}

async function executeUnban(ip) {
  const creds = getModCreds();
  const statusEl = document.getElementById('banStatus');
  if (!creds) return;
  if (statusEl) statusEl.textContent = 'Unbanning ' + ip + '...';
  try {
    const res = await fetch(creds.endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + creds.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unban', ipToUnban: ip })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (statusEl) {
        statusEl.textContent = 'Unbanned ' + ip;
        statusEl.style.color = 'var(--green)';
      }
      fetchBanList();
    } else {
      if (statusEl) {
        statusEl.textContent = data.message || 'Unban failed';
        statusEl.style.color = 'var(--danger)';
      }
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = 'Request failed';
      statusEl.style.color = 'var(--danger)';
    }
  }
}
