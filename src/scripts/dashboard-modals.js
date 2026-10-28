// ── Companion Device Pairing ──────────────────────────────────────────
function startCompanionPairingGen() {
  const el = document.getElementById('companionPinDisplayGen');
  const label = document.getElementById('companionPinLabelGen');
  const timer = document.getElementById('companionPinTimerGen');
  const box = document.getElementById('companionPairingBoxGen');

  if (!el || !label || !timer || !box) return;

  el.style.fontSize = '36px';
  el.style.letterSpacing = '6px';
  el.innerText = Math.floor(100000 + Math.random() * 900000).toString();
  label.innerText = 'Pairing PIN';
  box.style.borderColor = 'var(--accent)';
  timer.style.display = 'block';
  timer.style.animation = 'none';
  void timer.offsetWidth;
  timer.style.animation = 'pinTimerGen 30s linear forwards';

  timer.onanimationend = () => {
    if (!document.getElementById('mobileLinkModal').classList.contains('gone')) {
      startCompanionPairingGen();
    }
  };
}

function startCompanionPairingAuth() {
  const input = document.getElementById('companionPinInputAuth');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 100);
  }
}

function pairCompanionDevice() {
  const pin = document.getElementById('companionPinInputAuth').value;
  if (!pin || pin.length !== 6) {
    if (window.showError) window.showError('Please enter a valid 6-digit PIN', 'yellow');
    return;
  }
  let devices = JSON.parse(localStorage.getItem('ns_companions') || '[]');
  devices.push({ pin, date: Date.now() });
  localStorage.setItem('ns_companions', JSON.stringify(devices));

  if (window.renderCompanionDevices) window.renderCompanionDevices();

  document.getElementById('mobileAuthModal').classList.add('gone');
  document.getElementById('mobileAuthModal').classList.remove('open');
}

window.renderCompanionDevices = function () {
  let devices = JSON.parse(localStorage.getItem('ns_companions') || '[]');
  const list = document.getElementById('companionDevicesList');
  const modalLists = [document.getElementById('pairedDevicesListModalAuth'), document.getElementById('pairedDevicesListModalGen')];

  let modalHtml = '';
  let bubbleHtml = '';

  devices.forEach((d, index) => {
    modalHtml += `<div style="background: var(--surface-hover); padding: 8px 12px; border-radius: 6px; font-size: 11px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border); margin-bottom: 8px;">
       <div>
         <div style="font-weight: bold; color: #fff;">Companion Device</div>
         <div style="color: var(--muted); margin-top: 2px;">Paired: ${new Date(d.date).toLocaleDateString()}</div>
       </div>
       <button onclick="unpairCompanion(${index})" style="background: none; border: none; color: var(--danger); cursor: pointer; padding: 4px;">Unpair</button>
    </div>`;

    bubbleHtml += `<div title="Click to view device stream" onclick="joinCompanion(${index})" style="position: relative; width: 40px; height: 40px; border-radius: 50%; background: var(--surface-hover); border: 2px solid var(--border); display: flex; justify-content: center; align-items: center; cursor: pointer; transition: all 0.2s; flex-shrink: 0;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
      <i class="fas fa-desktop" style="color: var(--muted); font-size: 16px;"></i>
      <div style="position: absolute; bottom: 0; right: 0; width: 10px; height: 10px; background: #34d399; border-radius: 50%; border: 2px solid var(--surface);"></div>
    </div>`;
  });

  if (list) {
    list.innerHTML = bubbleHtml || '<span class="companion-empty-hint" style="font-size: 11px; color: var(--muted); font-style: italic;">No devices paired</span>';
  }
  modalLists.forEach(l => {
    if (l) {
      if (devices.length === 0) {
        l.innerHTML = `<div style="padding: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; text-align: center; font-style: italic;">No companion devices currently paired.</div>`;
      } else {
        l.innerHTML = modalHtml;
      }
    }
  });
};

window.joinCompanion = function (index) {
  if (window.showError) window.showError('Connecting to companion...', 'yellow');
  setTimeout(() => {
    window.location.href = `http://localhost:${window.location.port || 3000}/?tunnel=companion&pin=0000`;
  }, 1000);
};

window.unpairCompanion = function (index) {
  let devices = JSON.parse(localStorage.getItem('ns_companions') || '[]');
  devices.splice(index, 1);
  localStorage.setItem('ns_companions', JSON.stringify(devices));
  if (window.renderCompanionDevices) window.renderCompanionDevices();
};

document.addEventListener('DOMContentLoaded', () => {
  if (window.renderCompanionDevices) window.renderCompanionDevices();
});

// ── UI Version & About Modal ──────────────────────────────────────────
function toggleUIVersion() {
  const current = localStorage.getItem('ns_ui_version') || 'new';
  const next = current === 'new' ? 'old' : 'new';
  localStorage.setItem('ns_ui_version', next);
  alert(`Host UI set to: ${next.toUpperCase()} version. This will apply next time you launch a Host session.`);
}

function openAbout() {
  const modal = document.getElementById('aboutModal');
  if (modal) modal.style.display = 'flex';
}

function closeAbout() {
  const modal = document.getElementById('aboutModal');
  if (modal) modal.style.display = 'none';
}

function switchAboutTab(tabId, btnEl) {
  document.querySelectorAll('.ns-about-tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.ns-about-section').forEach(el => el.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  const target = document.getElementById('about-tab-' + tabId);
  if (target) target.classList.add('active');
}

// ── Documentation Viewer ───────────────────────────────────────────
function openDocs() {
  const modal = document.getElementById('docsModal');
  if (modal) modal.style.display = 'flex';
  loadDoc('GETTING_STARTED.md');
}

function closeDocs() {
  const modal = document.getElementById('docsModal');
  if (modal) modal.style.display = 'none';
}

function parseMarkdown(raw) {
  return raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```[\s\S]*?```/g, m => {
      const inner = m.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
      return `<pre style="background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 14px;overflow-x:auto;font-size:11px;line-height:1.6;margin:8px 0;">${inner}</pre>`;
    })
    .replace(/^# (.+)$/gm, '<h2 style="color:var(--accent);font-size:16px;font-weight:700;margin:16px 0 6px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:6px;">$1</h2>')
    .replace(/^## (.+)$/gm, '<h3 style="color:var(--text);font-size:13px;font-weight:600;margin:12px 0 4px;">$1</h3>')
    .replace(/^### (.+)$/gm, '<h4 style="color:var(--muted);font-size:11px;font-weight:600;margin:10px 0 3px;text-transform:uppercase;letter-spacing:.08em;">$1</h4>')
    .replace(/`([^`\n]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;font-size:11px;font-family:monospace;">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:12px 0;">')
    .replace(/^[-*] (.+)$/gm, '<li style="margin:3px 0 3px 16px;color:var(--muted);">$1</li>')
    .replace(/\n/g, '<br>');
}

async function loadDoc(filename) {
  const contentDiv = document.getElementById('docContent');
  if (!contentDiv) return;
  contentDiv.innerHTML = '<span style="color:var(--muted)">Loading...</span>';

  const port = new URLSearchParams(window.location.search).get('port') || '3000';
  const targetLang = (typeof I18N !== 'undefined' && I18N.targetLang) || 'en';
  const candidates = targetLang !== 'en'
    ? [`${targetLang}/${filename}`, filename]
    : [filename];

  try {
    let raw = null, used = null;
    if (window.electronAPI && window.electronAPI.readDoc) {
      for (const cand of candidates) {
        try { raw = await window.electronAPI.readDoc(cand); used = cand; break; } catch (_) { }
      }
      if (raw === null) throw new Error('Not found');
    } else {
      for (const cand of candidates) {
        const url = `http://localhost:${port}/docs/${cand}`;
        const res = await fetch(url);
        if (res.ok) { raw = await res.text(); used = cand; break; }
      }
      if (raw === null) throw new Error('Not found');
    }

    const html = parseMarkdown(raw);
    contentDiv.innerHTML = `<div style="line-height:1.7;font-size:13px;color:var(--muted);">${html}</div>`;
  } catch (e) {
    const safeFile = String(filename || '').replace(/[^a-zA-Z0-9_\-\.]/g, '');
    const safePort = String(port || '3000').replace(/[^0-9]/g, '');
    const url = `http://localhost:${safePort}/docs/${safeFile}`;
    contentDiv.textContent = '';
    const dangerSpan = document.createElement('span');
    dangerSpan.style.color = 'var(--danger)';
    dangerSpan.appendChild(document.createTextNode('Could not load '));
    const strong = document.createElement('strong');
    strong.textContent = safeFile;
    dangerSpan.appendChild(strong);
    dangerSpan.appendChild(document.createTextNode(' from '));
    const code = document.createElement('code');
    code.style.fontSize = '11px';
    code.textContent = url;
    dangerSpan.appendChild(code);
    dangerSpan.appendChild(document.createElement('br'));
    dangerSpan.appendChild(document.createElement('br'));
    const mutedSpan = document.createElement('span');
    mutedSpan.style.color = 'var(--muted)';
    mutedSpan.style.fontSize = '11px';
    mutedSpan.textContent = `Error: ${e.message}`;
    dangerSpan.appendChild(mutedSpan);
    contentDiv.appendChild(dangerSpan);
  }
}

// ── Splash Screen & Error Listener ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const splash = document.getElementById('ns-splash-screen');
  if (splash && sessionStorage.getItem('splashPlayed') !== 'true') {
    sessionStorage.setItem('splashPlayed', 'true');
    setTimeout(() => {
      splash.classList.add('fading-out');
      splash.style.opacity = '0';
      setTimeout(() => splash.style.display = 'none', 500);
    }, 1800);
  }

  if (window.electronAPI && window.electronAPI.onAppError) {
    window.electronAPI.onAppError((msg, severity) => {
      if (window.showError) window.showError(msg, severity);
    });
  }
});

// ── Games Launcher Overlay ──────────────────────────────────────────
(function initGamesLauncher() {
  window.openGamesOverlay = function () {
    const overlay = document.getElementById('gamesOverlay');
    if (!overlay) return;
    if (overlay.classList.contains('open')) {
      closeGamesOverlay();
      return;
    }
    const panel = overlay.querySelector('.go-panel');
    if (panel && !panel.querySelector('iframe')) {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || 'c084fc';
      panel.innerHTML = '<iframe src="/games-picker.html?accent=' + encodeURIComponent(accent) + '"></iframe>';
    }
    overlay.classList.add('open');
  };

  window.closeGamesOverlay = function () {
    const overlay = document.getElementById('gamesOverlay');
    if (overlay) overlay.classList.remove('open');
  };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeGamesOverlay();
  });

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'close-games') {
      closeGamesOverlay();
      return;
    }
    if (e.data && e.data.type === 'launch-game') {
      const overlay = document.getElementById('gamesOverlay');
      if (!overlay) return;
      const panel = overlay.querySelector('.go-panel');
      if (panel) {
        panel.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;">Launching ' + (e.data.name || '').replace(/[<>"&]/g, '') + '...</div>';
      }
      sessionStorage.setItem('ns_launch_game', JSON.stringify({
        launcher: e.data.launcher,
        gameId: e.data.gameId,
        name: (e.data.name || '').replace(/[<>"&]/g, '')
      }));
      fetch('/api/launch-game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launcher: e.data.launcher, gameId: e.data.gameId })
      }).then(() => {
        window.location.href = '/host?launch=1';
      }).catch(() => {
        window.location.href = '/host?launch=1';
      });
    }
  });
})();
