document.addEventListener('DOMContentLoaded', async () => {
      const vEl = document.getElementById('version-text');
      const cEl = document.getElementById('commit-hash');

      await applySystemAccent();

      // Handle ?tab= URL parameter for deep-linking from web viewer
      const urlParams = new URLSearchParams(window.location.search);
      const tabParam = urlParams.get('tab');
      if (tabParam && typeof switchTab === 'function') {
        // Delay slightly to ensure tabs are initialized
        setTimeout(() => switchTab(tabParam), 100);
      }

      // Random brand color: purple, orange, or white
      const brandColors = [
        { color: '#c084fc', stroke: 'rgba(192,132,252,0.3)', shadow: 'rgba(192,132,252,' },
        { color: '#ff8a4c', stroke: 'rgba(255,138,76,0.3)', shadow: 'rgba(255,138,76,' },
        { color: '#eef0ff', stroke: 'rgba(238,240,255,0.3)', shadow: 'rgba(238,240,255,' },
      ];
      const bc = brandColors[Math.floor(Math.random() * brandColors.length)];
      const bt = document.querySelector('.brand-text');
      if (bt) {
        bt.style.color = bc.color;
        bt.style.webkitTextStroke = `0.5px ${bc.stroke}`;
        bt.style.textShadow = `0 0 12px ${bc.shadow}0.5), 0 0 30px ${bc.shadow}0.15)`;
      }

      if (window.electronAPI) {
        const { version, commit } = await window.electronAPI.getVersion();
        window.NEARSEC_VERSION = version;
        vEl.innerHTML = `v${version} <span style="opacity:0.5; margin-left:4px;">${commit}</span>`;
        if (typeof checkForUpdates === 'function') checkForUpdates(version);
        setTimeout(checkClientVersion, 1500);
        
        window.electronAPI.onUpdateReady((latestVersion) => {
          document.getElementById('updateVersion').textContent = latestVersion;
          document.getElementById('currentVersionModal').textContent = version;
          const dlBtn = document.querySelector('#updateModal .btn-primary');
          dlBtn.textContent = 'Restart & Install';
          dlBtn.onclick = () => { window.electronAPI.installUpdate(); };
          document.getElementById('updateModal').style.display = 'flex';
        });
      } else {
        if (window.NEARSEC_VERSION && vEl) vEl.textContent = 'v' + window.NEARSEC_VERSION;
        if (window.NEARSEC_COMMIT && cEl) cEl.textContent = window.NEARSEC_COMMIT;
        setTimeout(checkClientVersion, 1500);
      }
    });

    async function checkForUpdates(currentVersion) {
      let cfg = appConfig;
      if (window.electronAPI) {
          // Electron-updater handles background checking automatically.
          return;
      }
      
      if (cfg.checkForUpdates === false) return;

      try {
          const res = await fetch('https://api.github.com/repos/TheRealFame/Nearcade/releases/latest');
          if (!res.ok) return;
          const data = await res.json();
          const latest = data.tag_name;
          if (!latest) return;
          
          let pa = latest.replace(/[^0-9.]/g, '').split('.');
          let pb = currentVersion.replace(/[^0-9.]/g, '').split('.');
          let isNewer = false;
          for (let i = 0; i < 3; i++) {
              let na = Number(pa[i] || 0);
              let nb = Number(pb[i] || 0);
              if (na > nb) { isNewer = true; break; }
              if (nb > na) break;
          }
          
          if (isNewer) {
              document.getElementById('updateVersion').textContent = latest;
              document.getElementById('currentVersionModal').textContent = currentVersion;
              document.getElementById('updateModal').style.display = 'flex';
          }
      } catch (e) {
          console.error("Update check failed:", e);
      }
    }

    function copyVersion() {
      const txt = 'v' + (window.NEARSEC_VERSION || 'unknown') + (window.NEARSEC_COMMIT ? '-' + window.NEARSEC_COMMIT : '');
      navigator.clipboard.writeText(txt).catch(()=>{});
      const vEl = document.getElementById('version-text');
      const old = vEl.textContent;
      vEl.textContent = 'Copied!';
      setTimeout(() => {
        vEl.textContent = old;
      }, 1500);
    }

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

    async function checkClientVersion() {
      try {
        const res = await fetch((window.NEARSEC_ARCADE_URL || 'https://nearcade.cutefame.net') + '/api/client-version');
        if (!res.ok) return;
        const data = await res.json();
        const minVer = data.minimum || '0.0.0';
        if (compareVersions(window.NEARSEC_VERSION, minVer) < 0) {
          const overlay = document.createElement('div');
          overlay.id = 'clientVersionOverlay';
          overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
          overlay.innerHTML = '<div style="background:#121518;border:1px solid #ff5d3d;border-radius:12px;padding:40px;max-width:420px;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,0.8);font-family:sans-serif;">'
            + '<h2 style="color:#ff5d3d;margin:0 0 12px 0;text-transform:uppercase;letter-spacing:1px;">Client Outdated</h2>'
            + '<p style="color:#949ba4;font-size:14px;line-height:1.6;margin:0 0 16px 0;">'
            + 'You are running <strong style="color:#f0f3f5;">Nearcade v' + window.NEARSEC_VERSION + '</strong>.<br>'
            + 'The arcade directory requires at least <strong style="color:#f0f3f5;">v' + minVer + '</strong>.<br><br>'
            + 'Please update to the latest version to continue hosting arcade sessions.</p>'
            + '<a href="https://github.com/TheRealFame/Nearcade/releases/latest" target="_blank" style="display:inline-block;background:#ff5d3d;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Download Update</a>'
            + '</div>';
          document.body.appendChild(overlay);
        }
      } catch (_) {}
    }

    function toggleSidebar() { document.getElementById('sidebar').classList.toggle('collapsed'); }

    function switchTab(name) {
      // Null-safe panel swap — if a panel doesn't exist, log and bail rather than crash
      const panel = document.getElementById('panel-' + name);
      if (!panel) {
        console.warn('[switchTab] No panel found for:', name);
        return;
      }
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-btn').forEach(t => t.classList.remove('active'));
      panel.classList.add('active');
      document.getElementById('tab-' + name)?.classList.add('active');

      const docsBtn = document.getElementById('docsFloatBtn');
      if (docsBtn) {
        docsBtn.style.display = (name === 'arcade' || name === 'settings') ? 'none' : 'flex';
      }

      const versionDisplay = document.getElementById('version-display');
      if (versionDisplay) {
        versionDisplay.style.display = (name === 'arcade') ? 'none' : 'block';
      }

      const gamesTab = document.getElementById('gamesTab');
      if (gamesTab) gamesTab.style.display = (name === 'connect') ? 'flex' : 'none';
    }

    let appConfig = {};

    const DEFAULT_ACCENT = '#c084fc';
    const DEFAULT_ACCENT2 = '#c084fc';
    const DEFAULT_ACCENT_DIM = 'rgba(192,132,252,0.15)';
    const DEFAULT_ACCENT_GLOW = 'rgba(192,132,252,0.35)';

    async function applySystemAccent() {
      const useAccent = appConfig.useSystemAccent === true;
      localStorage.setItem('ns_use_system_accent', useAccent ? 'true' : 'false');
      const indicator = document.getElementById('sysAccentIndicator');
      const root = document.documentElement;
      
      const applyDefault = () => {
        root.style.removeProperty('--accent');
        root.style.removeProperty('--accent2');
        root.style.removeProperty('--accent-dim');
        root.style.removeProperty('--accent-glow');
        if (indicator) indicator.style.display = 'none';
        
        if (appConfig.hostColor !== '#c084fc') {
          appConfig.hostColor = '#c084fc';
          localStorage.setItem('ns_chat_color', '#c084fc');
          syncToNode();
        }
      };
      
      if (!window.electronAPI || !useAccent) {
        applyDefault();
        return;
      }
      try {
        const accent = await window.electronAPI.getAccentColor();
        if (!accent || accent === '#8b5cf6') {
          applyDefault();
          return;
        }
        const r = parseInt(accent.slice(1,3), 16);
        const g = parseInt(accent.slice(3,5), 16);
        const b = parseInt(accent.slice(5,7), 16);
        root.style.setProperty('--accent', accent);
        root.style.setProperty('--accent2', accent);
        root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.15)`);
        root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.35)`);
        if (indicator) indicator.style.display = 'inline-flex';
        
        if (appConfig.hostColor !== accent) {
          appConfig.hostColor = accent;
          localStorage.setItem('ns_chat_color', accent);
          syncToNode();
        }
      } catch (_) {
        applyDefault();
      }
    }

    async function applyNativeTheme() {
      const useNative = appConfig.useNativeTheme === true;
      localStorage.setItem('ns_use_native_theme', useNative ? 'true' : 'false');
      const indicator = document.getElementById('nativeThemeIndicator');
      const root = document.documentElement;

      if (!window.electronAPI || !useNative) {
        root.style.removeProperty('--bg');
        root.style.removeProperty('--sidebar');
        root.style.removeProperty('--surface');
        root.style.removeProperty('--surface-hover');
        root.style.removeProperty('--text');
        root.style.removeProperty('--muted');
        root.style.removeProperty('--muted2');
        root.style.removeProperty('--border');
        if (appConfig.useSystemAccent) {
          applySystemAccent();
        } else {
          root.style.removeProperty('--accent');
        }
        if (indicator) indicator.style.display = 'none';
        return;
      }

      try {
        const theme = await window.electronAPI.getNativeTheme();
        if (theme) {
          root.style.setProperty('--bg', theme.bg);
          root.style.setProperty('--sidebar', theme.sidebar);
          root.style.setProperty('--surface', theme.surface);
          root.style.setProperty('--surface-hover', theme.surfaceHover);
          root.style.setProperty('--text', theme.text);
          root.style.setProperty('--muted', theme.muted);
          root.style.setProperty('--muted2', theme.muted2);
          root.style.setProperty('--border', theme.border);
          root.style.setProperty('--accent', theme.accent);
          
          appConfig.hostColor = theme.accent;
          localStorage.setItem('ns_chat_color', theme.accent);
          localStorage.setItem('ns_native_theme_payload', JSON.stringify(theme));
          syncToNode();

          if (indicator) indicator.style.display = 'inline-block';
        }
      } catch (e) {
        console.error('Failed to get native theme:', e);
      }
    }

    function _getServerPort() {
      return new URLSearchParams(window.location.search).get('port') || '3000';
    }

    function toggleHidMaestro() {
      const was = appConfig.hidmaestro;
      const turningOn = !was;

      if (turningOn) {
        // Check if HmBridge.exe exists before enabling
        (async () => {
          let bridgeOk = false;
          if (window.electronAPI && window.electronAPI.checkHmBridge) {
            const result = await window.electronAPI.checkHmBridge();
            bridgeOk = result.exists;
          }
          showHidMaestroDisclaimer(bridgeOk);
        })();
      } else {
        appConfig.hidmaestro = false;
        syncSettingsUI();
        saveAppConfigToElectron();
        syncToNode();
      }
    }

    function showHidMaestroDisclaimer(bridgeFound) {
      const overlay = document.createElement('div');
      overlay.id = 'hidmaestroDisclaimer';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';

      let bridgeWarning = '';
      if (!bridgeFound) {
        bridgeWarning = `<p style="color:var(--danger);font-size:13px;line-height:1.6;margin:0 0 16px 0;">
          ⚠ HmBridge.exe not found. The HIDMaestro backend will not work until you
          <a href="https://github.com/cutefame/Nearcade/releases" target="_blank" style="color:var(--accent);">download the latest release</a>
          or build it from source:
          <code style="display:block;background:#000;padding:8px;margin:8px 0;border-radius:4px;font-size:11px;">cd src/sidecar/input_backends/HmBridge && dotnet publish -c Release -r win-x64 --self-contained false</code>
        </p>`;
      }

      overlay.innerHTML = `<div style="background:#121518;border:1px solid var(--warn);border-radius:12px;padding:32px;max-width:480px;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,0.8);font-family:sans-serif;">
        <h2 style="color:var(--warn);margin:0 0 12px 0;font-size:16px;">HIDMaestro Integration Notice</h2>
        <p style="color:#949ba4;font-size:13px;line-height:1.6;margin:0 0 16px 0;">
          Nearcade includes support for HIDMaestro as an <strong>experimental</strong> virtual controller backend.
          This feature uses the
          <a href="https://github.com/hifihedgehog/HIDMaestro" target="_blank" style="color:var(--accent);">HIDMaestro</a>
          open-source project.
        </p>
        <p style="color:#949ba4;font-size:13px;line-height:1.6;margin:0 0 16px 0;">
          I (Nearcade) do not actively support the HIDMaestro developers or their project beyond
          integrating it as an optional backend. I have no plans to provide financial or promotional
          support to them. This is purely a technical integration of their open-source work.
        </p>
        ${bridgeWarning}
        <p style="color:var(--warn);font-size:12px;line-height:1.5;margin:0 0 20px 0;">
          ⚠ Experimental: Not compatible with Arcade mode. May cause instability. Use at your own risk.
        </p>
        <button onclick="enableHidMaestro()" style="padding:10px 28px;border-radius:6px;border:none;background:var(--accent);color:#000;font-weight:600;cursor:pointer;">${bridgeFound ? 'I Understand, Enable' : 'Enable Anyway'}</button>
      </div>`;
      document.body.appendChild(overlay);
    }

    function enableHidMaestro() {
      appConfig.hidmaestro = true;
      syncSettingsUI();
      saveAppConfigToElectron();
      syncToNode();
      document.getElementById('hidmaestroDisclaimer')?.remove();
    }

    // Strip tunnel fields before saving — they're managed by the host/server
    function _cfgWithoutTunnel() {
        const c = { ...appConfig };
        delete c.tunnelProvider; delete c.neverAsk; delete c.vpsHost;
        return c;
    }
    function saveAppConfigToElectron() {
        if (window.electronAPI) window.electronAPI.saveSettings(_cfgWithoutTunnel());
    }
    function syncToNode() {
        const port = _getServerPort();
        fetch(`http://localhost:${port}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(_cfgWithoutTunnel())
        }).catch(()=>{});
    }

    async function loadAndSyncSettings() {
      if (!window.electronAPI) return;
      appConfig = await window.electronAPI.getSettings();
      syncSettingsUI();
      await applySystemAccent();
      if (appConfig.useNativeTheme) await applyNativeTheme();
    }

    function syncSettingsUI() {
      if (appConfig) {
        document.getElementById('settingHostName').value = appConfig.hostName || localStorage.getItem('ns_name') || '';
        
        let savedHostAvatar = appConfig.hostAvatar || localStorage.getItem('ns_host_avatar') || localStorage.getItem('ns_avatar');
        let needsSave = false;
        if (!savedHostAvatar) {
          savedHostAvatar = Math.floor(Math.random() * 100) + 1;
          localStorage.setItem('ns_host_avatar', savedHostAvatar);
          localStorage.setItem('ns_avatar', savedHostAvatar);
          needsSave = true;
        } else if (!appConfig.hostAvatar) {
          needsSave = true;
        }
        
        if (needsSave) {
          fetch(`http://localhost:${_getServerPort()}/api/config`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostAvatar: String(savedHostAvatar) })
          }).catch(()=>{});
        }

        const hostAvatarPreview = document.getElementById('hostAvatarPreview');
        if (hostAvatarPreview) hostAvatarPreview.src = `/assets/avatars/avatar-${savedHostAvatar}.svg`;
        
        window.randomizeHostAvatar = function() {
          const newAv = Math.floor(Math.random() * 100) + 1;
          localStorage.setItem('ns_host_avatar', newAv);
          localStorage.setItem('ns_avatar', newAv);
          if (hostAvatarPreview) hostAvatarPreview.src = `/assets/avatars/avatar-${newAv}.svg`;
          
          fetch(`http://localhost:${_getServerPort()}/api/config`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostAvatar: String(newAv) })
          }).catch(()=>{});
        };
      }
      
      const uiSel = document.getElementById('hostUISelect');
      if (uiSel) {
        let savedUI = localStorage.getItem('ns_ui_version') || 'default';
        if (savedUI === 'new') savedUI = 'default';
        if (savedUI === 'old') savedUI = 'minimal';
        uiSel.value = savedUI;
      }
      
      document.getElementById('settingTrackRumble')?.classList.toggle('on', appConfig.rumble !== false);
      document.getElementById('settingTrackHidMaestro')?.classList.toggle('on', !!appConfig.hidmaestro);
      document.getElementById('settingTrackTray')?.classList.toggle('on', appConfig.tray !== false);
      document.getElementById('settingTrackCheckForUpdates')?.classList.toggle('on', appConfig.checkForUpdates !== false);
      document.getElementById('settingTrackAlwaysOnTop')?.classList.toggle('on', !!appConfig.alwaysOnTop);
       document.getElementById('settingTrackSystemAccent')?.classList.toggle('on', appConfig.useSystemAccent === true);
       document.getElementById('settingTrackNativeTheme')?.classList.toggle('on', appConfig.useNativeTheme === true);
      document.getElementById('settingTrackBootHost')?.classList.toggle('on', !!appConfig.bootToHost);
      document.getElementById('settingTrackDiscordRPC')?.classList.toggle('on', appConfig.discordRPC !== false);
      document.getElementById('settingTrackHWDecode')?.classList.toggle('on', appConfig.hwDecode !== false);
      document.getElementById('settingTrackFpsUnlock')?.classList.toggle('on', !!appConfig.fpsUnlock);
      document.getElementById('settingTrackVsyncOff')?.classList.toggle('on', !!appConfig.vsyncOff);
      document.getElementById('settingTrackZeroCopy')?.classList.toggle('on', !!appConfig.zeroCopy);

      renderAutoHosts();

      if (document.getElementById('settingModEndpoint')) {
        document.getElementById('settingModEndpoint').value = appConfig.modEndpoint || '';
      }
      if (document.getElementById('settingModSecret')) {
        document.getElementById('settingModSecret').value = appConfig.modSecret || '';
      }
      if (document.getElementById('settingArcadeRoleId')) {
        document.getElementById('settingArcadeRoleId').value = appConfig.arcadeRoleId || '';
      }
      if (document.getElementById('settingNameBlacklist')) {
        document.getElementById('settingNameBlacklist').value = appConfig.nameBlacklist || '';
      }
    }

    function saveLangAndReload(val) {
      appConfig.lang = val;
      saveAppConfigToElectron();
      I18N.changeLanguage(val);
    }

    function saveHostName(val) {
      appConfig.hostName = val.trim();
      // Sync to standard local storage so Arcade and Viewer immediately see it
      localStorage.setItem('ns_name', appConfig.hostName);

      saveAppConfigToElectron();
      syncToNode();
    }

    let _tunnelProviders = null;

    async function toggleTunnelGrid() {
      const btn = document.getElementById('moreTunnelsBtn');
      const container = document.getElementById('tunnelGridContainer');
      const isOpen = container.classList.toggle('open');
      btn.classList.toggle('open', isOpen);

      if (isOpen && !_tunnelProviders) {
        try {
          const res = await fetch('/api/tunnels/providers');
          const data = await res.json();
          _tunnelProviders = data.providers || [];
          renderTunnelGrid();
        } catch (e) {
          document.getElementById('tunnelGridLoading').textContent = 'Failed to load: ' + e.message;
        }
      }
    }

    function renderTunnelGrid() {
      document.getElementById('tunnelGridLoading').style.display = 'none';
      const el = document.getElementById('tunnelGridContent');
      el.style.display = 'block';

      const only = _tunnelProviders.filter(p => !p.integrated);

      let html = '<div class="tunnel-section-label">Additional Tunnels</div>';
      html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;">';
      html += '<div class="tunnel-grid">';
      for (const p of only) html += tunnelCardHtml(p);
      html += '</div></div>';

      el.innerHTML = html;
    }

    function tunnelCardHtml(p) {
      const icon = p.name.charAt(0).toUpperCase();
      const dotClass = p.status.found ? 'found' : (p.status.error ? 'error' : 'missing');
      const dotLabel = p.requiresBinary === false ? 'no binary needed'
        : p.status.found ? 'binary found'
        : p.status.error ? 'error' : 'binary not detected';
      const badges = [
        p.difficulty ? '<span class="tc-badge ' + p.difficulty + '">' + p.difficulty + '</span>' : '',
        p.pricing ? '<span class="tc-badge ' + p.pricing + '">' + p.pricing + '</span>' : '',
      ].filter(Boolean).join(' ');

      const isActive = appConfig.tunnelProvider === p.id;
      return '<div class="tunnel-card' + (isActive ? ' highlight' : '') + '" id="tunnel-card-' + p.id + '" onclick="tunnelCardClick(\'' + p.id + '\')">' +
        '<div class="tc-header">' +
          '<div class="tc-icon">' + icon + '</div>' +
          '<div class="tc-name">' + p.name + '</div>' +
          badges +
        '</div>' +
        '<div class="tc-desc">' + p.description + '</div>' +
        '<div class="tc-footer">' +
          '<span class="tc-status"><span class="tc-dot ' + dotClass + '"></span> ' + dotLabel + '</span>' +
        '</div>' +
      '</div>';
    }

    function tunnelCardClick(id) {
      const p = _tunnelProviders.find(x => x.id === id);
      if (!p) return;
      document.querySelectorAll('.tunnel-card').forEach(c => c.classList.remove('highlight'));
      const card = document.getElementById('tunnel-card-' + id);
      if (card) card.classList.add('highlight');
      appConfig.tunnelProvider = id;
      saveOrSyncConfig();
      document.getElementById('moreTunnelsLabel').textContent = 'Starting ' + p.name + '...';

      const statusEl = document.getElementById('tunnelStatus');
      if (statusEl) {
        statusEl.textContent = 'Starting ' + p.name + '...';
        statusEl.className = 'tunnel-status loading';
        statusEl.style.display = 'block';
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 50000);
      fetch('/api/tunnels/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: id }),
        signal: controller.signal
      })
        .then(r => { clearTimeout(timeoutId); return r.json(); })
        .then(data => {
          if (data.success && data.url) {
            document.getElementById('moreTunnelsLabel').textContent = 'Active: ' + p.name;
            if (statusEl) {
              statusEl.innerHTML = '<span style="color:var(--green)">✓</span> ' + p.name + ' running<br><small>URL: <a href="' + data.url + '" target="_blank" style="color:var(--accent)">' + data.url + '</a></small>';
              statusEl.className = 'tunnel-status success';
            }
          } else {
            document.getElementById('moreTunnelsLabel').textContent = p.name + ' failed';
            if (statusEl) {
              statusEl.innerHTML = '<span style="color:var(--red)">✗</span> ' + p.name + ' failed: ' + (data.details || data.error || 'unknown error');
              statusEl.className = 'tunnel-status error';
            }
          }
          setTimeout(closeTunnelGrid, 6000);
        })
        .catch(e => {
          document.getElementById('moreTunnelsLabel').textContent = p.name + ' error';
          if (statusEl) {
            statusEl.innerHTML = '<span style="color:var(--red)">✗</span> Network error: ' + e.message;
            statusEl.className = 'tunnel-status error';
          }
        });
    }

    function saveOrSyncConfig() {
      saveAppConfigToElectron();
      syncToNode();
    }

    function closeTunnelGrid() {
      const btn = document.getElementById('moreTunnelsBtn');
      const container = document.getElementById('tunnelGridContainer');
      btn.classList.remove('open');
      container.classList.remove('open');
    }

    function saveModSettings() {
      appConfig.modEndpoint = document.getElementById('settingModEndpoint').value.trim() || undefined;
      appConfig.modSecret = document.getElementById('settingModSecret').value.trim() || undefined;

      document.getElementById('modConnectionStatus').textContent = '';
      saveAppConfigToElectron();
      syncToNode();
    }

    async function verifyModConnection() {
      let endpoint = document.getElementById('settingModEndpoint').value.trim();
      const secret = document.getElementById('settingModSecret').value.trim();
      const statusEl = document.getElementById('modConnectionStatus');
      if (!endpoint || !secret) {
        statusEl.textContent = 'Please fill in both fields first.';
        statusEl.style.color = 'var(--warn)';
        return;
      }
      // Normalize: auto-add https:// if protocol is missing
      if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
        endpoint = 'https://' + endpoint;
      }
      // Strip trailing slashes and /arcade path, then append /api/mod
      endpoint = endpoint
        .replace(/\/+$/, '')
        .replace(/\/arcade\/?$/, '')
        .replace(/\/api\/mod\/?$/, '');
      endpoint += '/api/mod';
      statusEl.textContent = 'Verifying...';
      statusEl.style.color = 'var(--muted2)';
      try {
        const res = await fetch(endpoint, {
          headers: { 'Authorization': 'Bearer ' + secret }
        });
        if (res.ok) {
          statusEl.textContent = 'Connected — API is live';
          statusEl.style.color = 'var(--green)';
          document.getElementById('banManagementArea').style.display = 'block';
          fetchBanList();
        } else if (res.status === 401) {
          statusEl.textContent = 'Unauthorized — check your token';
          statusEl.style.color = 'var(--danger)';
        } else {
          statusEl.textContent = 'Error ' + res.status + ' — check your endpoint URL';
          statusEl.style.color = 'var(--danger)';
        }
      } catch (e) {
        if (e.message?.includes('Failed to fetch') || e instanceof TypeError) {
          statusEl.textContent = 'CORS blocked — disable Browser Integrity Check in Cloudflare dashboard, or add WAF bypass rule for OPTIONS /api/*';
        } else {
          statusEl.textContent = 'Could not reach endpoint — ' + e.message;
        }
        statusEl.style.color = 'var(--danger)';
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
      if (!creds) { statusEl.textContent = 'Configure endpoint and secret first.'; return; }
      statusEl.textContent = 'Loading...';
      try {
        const res = await fetch(creds.endpoint, { headers: { 'Authorization': 'Bearer ' + creds.secret } });
        if (!res.ok) { statusEl.textContent = 'Error ' + res.status; return; }
        const list = await res.json();
        if (!Array.isArray(list) || list.length === 0) {
          container.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:13px;">No banned IPs.</div>';
          statusEl.textContent = list.length + ' bans';
          return;
        }
        container.innerHTML = list.map(ip =>
          '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--border);font-size:13px;">' +
          '<span style="color:var(--text);font-family:monospace;">' + ip + '</span>' +
          '<button onclick="executeUnban(\'' + ip + '\')" style="padding:4px 10px;border-radius:4px;cursor:pointer;font-weight:600;border:1px solid var(--danger);background:transparent;color:var(--danger);font-size:11px;font-family:inherit;">Unban</button>' +
          '</div>'
        ).join('');
        statusEl.textContent = list.length + ' ban' + (list.length !== 1 ? 's' : '');
      } catch (e) {
        statusEl.textContent = 'Failed to fetch ban list';
        container.innerHTML = '';
      }
    }

    async function executeBan() {
      const creds = getModCreds();
      const ip = document.getElementById('banIPInput').value.trim();
      const statusEl = document.getElementById('banStatus');
      if (!creds) { statusEl.textContent = 'Configure endpoint and secret first.'; return; }
      if (!ip) { statusEl.textContent = 'Enter an IP address.'; return; }
      statusEl.textContent = 'Banning ' + ip + '...';
      try {
        const res = await fetch(creds.endpoint, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + creds.secret, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'ban', ipToBan: ip })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          statusEl.textContent = 'Banned ' + ip;
          statusEl.style.color = 'var(--green)';
          document.getElementById('banIPInput').value = '';
          fetchBanList();
          showBanPopup(ip);
          fetch(`http://localhost:${_getServerPort()}/api/system-chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msg: '⚠ A viewer was banned from the session.' })
          }).catch(()=>{});
        } else {
          statusEl.textContent = data.message || 'Ban failed';
          statusEl.style.color = 'var(--danger)';
        }
      } catch (e) {
        statusEl.textContent = 'Request failed';
        statusEl.style.color = 'var(--danger)';
      }
    }

    function showBanPopup(ip) {
      const existing = document.getElementById('banPopup');
      if (existing) existing.remove();
      const popup = document.createElement('div');
      popup.id = 'banPopup';
      popup.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;background:#1a1a1a;border:1px solid var(--danger);border-radius:10px;padding:16px 20px;max-width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.6);animation:fadeIn 0.3s;font-family:inherit;';
      popup.innerHTML = '<div style="color:var(--danger);font-weight:700;font-size:14px;margin-bottom:4px;">⚠ IP Banned</div>' +
        '<div style="color:var(--text);font-size:13px;margin-bottom:8px;font-family:monospace;">' + ip + '</div>' +
        '<div style="color:var(--muted);font-size:12px;">A chat warning has been sent to all viewers.</div>' +
        '<button onclick="this.parentElement.remove()" style="margin-top:8px;padding:4px 12px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-family:inherit;">Dismiss</button>';
      document.body.appendChild(popup);
      setTimeout(() => { const p = document.getElementById('banPopup'); if (p) p.remove(); }, 8000);
    }

    async function executeUnban(ip) {
      const creds = getModCreds();
      const statusEl = document.getElementById('banStatus');
      if (!creds) return;
      statusEl.textContent = 'Unbanning ' + ip + '...';
      try {
        const res = await fetch(creds.endpoint, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + creds.secret, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unban', ipToUnban: ip })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          statusEl.textContent = 'Unbanned ' + ip;
          statusEl.style.color = 'var(--green)';
          fetchBanList();
        } else {
          statusEl.textContent = data.message || 'Unban failed';
          statusEl.style.color = 'var(--danger)';
        }
      } catch (e) {
        statusEl.textContent = 'Request failed';
        statusEl.style.color = 'var(--danger)';
      }
    }

    function toggleAppSetting(key) {
      if (['tray', 'hwDecode', 'discordRPC', 'rumble', 'checkForUpdates', 'useSystemAccent', 'useNativeTheme'].includes(key)) {
        appConfig[key] = !appConfig[key];
        const tk = key === 'hwDecode' ? 'HWDecode' : 
                   key === 'discordRPC' ? 'DiscordRPC' : 
                   key === 'checkForUpdates' ? 'CheckForUpdates' : 
                   key === 'useSystemAccent' ? 'SystemAccent' : 
                   key === 'useNativeTheme' ? 'NativeTheme' :
                   key.charAt(0).toUpperCase() + key.slice(1);
        const tr = document.getElementById('settingTrack' + tk);
        if (tr) tr.classList.toggle('on', appConfig[key]);
        if (window.electronAPI) window.electronAPI.saveSettings(appConfig);
        
        if (key === 'useSystemAccent' && !appConfig.useNativeTheme) applySystemAccent();
        if (key === 'useNativeTheme') applyNativeTheme();
      } else {
        appConfig[key] = !appConfig[key];
      }
      syncSettingsUI();
      if (window.electronAPI) {
        saveAppConfigToElectron();
        if (key === 'alwaysOnTop') window.electronAPI.toggleAlwaysOnTop();
      }
      syncToNode();
    }

    async function pasteFromClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        document.getElementById('directLinkInput').value = text;
        document.getElementById('directLinkInput').focus();
      } catch {
        document.getElementById('directLinkErr').textContent = '⚠ Could not read clipboard. Please paste manually.';
      }
    }

    async function joinDirectLink() {
      const inputVal = document.getElementById('directLinkInput').value.trim();
      const pinVal = document.getElementById('pinInput').value.trim();
      const errEl = document.getElementById('directLinkErr');
      if (!inputVal) { errEl.textContent = 'Please enter a valid URL or Room Code.'; return; }

      // Check if it's a URL
      const isUrl = inputVal.startsWith('http://') || inputVal.startsWith('https://');

      if (isUrl) {
        errEl.style.color = 'var(--muted)';
        errEl.textContent = 'Verifying tunnel...';
        try {
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 5000);
          const pingUrl = inputVal.replace(/\/$/, '') + '/api/info';
          await fetch(pingUrl, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
          clearTimeout(tid);
          errEl.textContent = '';
          if (window.electronAPI) {
            window.electronAPI.joinSession(inputVal, { game: 'Direct Connect' }, pinVal);
          } else {
            let navUrl = `viewer.html?client=1&compat=1&host=${encodeURIComponent(inputVal)}`;
            if (pinVal) navUrl += `&pin=${encodeURIComponent(pinVal)}`;
            window.location.href = navUrl;
          }
        } catch {
          errEl.style.color = 'var(--danger)';
          errEl.textContent = '⚠ Session unreachable. Make sure the host is online.';
        }
      } else {
        // It's a Room Code
        errEl.textContent = '';
        if (window.electronAPI) {
          window.electronAPI.joinSession(`p2p://${inputVal}`, { game: 'P2P Session' }, pinVal);
        } else {
          let navUrl = `viewer.html?client=1&compat=1&host=${encodeURIComponent('p2p://' + inputVal)}`;
          if (pinVal) navUrl += `&pin=${encodeURIComponent(pinVal)}`;
          window.location.href = navUrl;
        }
      }
    }

    window.addEventListener('message', (event) => {
      const _arcadeOrigin = (window.NEARSEC_ARCADE_URL || 'https://nearcade.cutefame.net');
      if (event.origin.includes(new URL(_arcadeOrigin).hostname) && event.data?.type === 'JOIN_SESSION') {
        if (window.electronAPI) window.electronAPI.joinSession(event.data.url, { game: event.data.game });
      }
    });

    const cursor = document.getElementById('virtual-cursor');
    let cx = window.innerWidth / 2, cy = window.innerHeight / 2;

    function updateGamepad() {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) {
        if (!p) continue;
        cursor.style.display = 'block';
        const dx = p.axes[0], dy = p.axes[1];
        if (Math.abs(dx) > 0.15) cx += dx * 14;
        if (Math.abs(dy) > 0.15) cy += dy * 14;
        cx = Math.max(0, Math.min(window.innerWidth,  cx));
        cy = Math.max(0, Math.min(window.innerHeight, cy));
        cursor.style.left = cx + 'px';
        cursor.style.top  = cy + 'px';
        if (p.buttons[0].pressed && !p._wasPressed) {
          cursor.classList.add('clicking');
          const el = document.elementFromPoint(cx, cy);
          if (el && typeof el.click === 'function') el.click();
          p._wasPressed = true;
        } else if (!p.buttons[0].pressed) {
          cursor.classList.remove('clicking');
          p._wasPressed = false;
        }
      }
      requestAnimationFrame(updateGamepad);
    }
    window.addEventListener('gamepadconnected', () => requestAnimationFrame(updateGamepad));

    async function checkFirstRun() {
      if (window.Capacitor || window.IS_CLIENT_ONLY) {
          document.body.classList.add('client-only');
          return;
      }

      if (!window.electronAPI) return;

      try {
        const result = await window.electronAPI.checkSystemSetup();
        if (!result || result.needsSetup) {
          window.location.href = '/setup';
        }
      } catch (e) {
        console.warn('[checkFirstRun] error:', e);
      }
    }

    window.addEventListener('DOMContentLoaded', () => {
      // Populate language select with fallback options in case i18n.js hasn't run yet
      const langSelect = document.getElementById('langSelect');
      if (langSelect && langSelect.options.length === 0) {
        [
          ['en', 'English'], ['es', 'Español'], ['fr', 'Français'],
          ['de', 'Deutsch'], ['pt', 'Português'], ['ja', '日本語'],
          ['ko', '한국어'], ['zh', '中文'], ['ru', 'Русский'],
        ].forEach(([val, label]) => {
          const opt = document.createElement('option');
          opt.value = val; opt.textContent = label;
          langSelect.appendChild(opt);
        });
      }

      const savedLang = localStorage.getItem('ns_lang') || navigator.language.split('-')[0] || 'en';
      if (langSelect) langSelect.value = savedLang;

      // Arcade panel iframe: always use the dynamic port and saved language
      const port = _getServerPort();
      const arcadeFrame = document.querySelector('#panel-arcade iframe');
      if (arcadeFrame) {
        arcadeFrame.src = (window.NEARSEC_ARCADE_URL || 'https://nearcade.cutefame.net') + '/arcade?electron=1&lang=' + savedLang;
      }

      loadAndSyncSettings();
      checkFirstRun();
    });

    // ── Auto-Host Logic ────────────────────────────────────────────────────────
    let currentGameStatus = { running: false, command: null, tunnelUrl: null, log: '' };

    setInterval(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const activePort = urlParams.get('port') || '3000';
        const port = _getServerPort();
        fetch(`http://localhost:${activePort}/api/status`).then(r => r.json()).then(status => {
            if (status.running !== currentGameStatus.running || status.log !== currentGameStatus.log) {
                currentGameStatus = status;
                renderAutoHosts();
            }
        }).catch(()=>{});
    }, 1000);

    function openAutoHostEditor() {
        const editorHtml = `
            <div id="hostEditorModal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); display:flex; justify-content:center; align-items:center; z-index:999999;">
                <div style="background:var(--surface); padding:20px; border-radius:8px; width:600px; max-width:90%; border:1px solid var(--border);">
                    <h3 style="margin-bottom:10px; color:var(--accent);">Edit Auto-Hosts (JSON)</h3>
                    <textarea id="hostEditorText" style="width:100%; height:300px; background:#000; color:#0f0; font-family:monospace; padding:10px; border:1px solid #333;">${JSON.stringify(appConfig.autoHosts || [], null, 2)}</textarea>
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
            appConfig.autoHosts = parsed;
            saveAppConfigToElectron();
            syncToNode();
            document.getElementById('hostEditorModal').remove();
            renderAutoHosts();
        } catch (e) {
            alert('Invalid JSON! Check for missing commas or quotes.');
        }
    }

    function saveAutoHost() {
        const name = document.getElementById('autoName').value.trim();
        const cmd = document.getElementById('autoCmd').value.trim();
        const tunnel = document.getElementById('autoTunnel').value;

        if (!name || !cmd) return;
        if (!appConfig.autoHosts) appConfig.autoHosts = [];
        appConfig.autoHosts.push({ id: Date.now(), name, cmd, tunnel, status: 'offline' });

        saveAppConfigToElectron();
        syncToNode();
        renderAutoHosts();
        document.getElementById('autoName').value = '';
        document.getElementById('autoCmd').value = '';
    }

    function renderAutoHosts() {
        const list = document.getElementById('activeAutoHostsList');
        if (!list) return;

        const hosts = appConfig.autoHosts || [];
        if (hosts.length === 0) {
            list.innerHTML = `<h2>Saved Configurations</h2><div style="padding: 30px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px;">No containers configured yet.</div>`;
            return;
        }

        let html = `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                        <h2 style="margin:0; border:none; padding:0;">Saved Configurations</h2>
                        <button style="padding:4px 12px; font-size:11px; cursor:pointer; border-radius:4px; background:transparent; border:1px solid var(--border); color:#fff;" onclick="openAutoHostEditor()">Edit JSON</button>
                    </div>`;

        hosts.forEach(h => {
            const isRunning = currentGameStatus.running && currentGameStatus.command === h.cmd;

            let logDisplay = '';
            if (isRunning) {
                logDisplay = `<div style="margin-top:8px; padding:6px; background:#000; border:1px solid #333; border-radius:4px; font-family:monospace; font-size:10px; color:#eab308;">> Game loop active inside Display :99</div>`;
            } else {
                logDisplay = `<div style="margin-top:8px; padding:6px; background:#000; border:1px solid #222; border-radius:4px; font-family:monospace; font-size:10px; color:#555;">To launch, run: ./bin/headless-host.cmd in a terminal</div>`;
            }

            let activeUrl = '';
            if (isRunning && currentGameStatus.tunnelUrl) {
                const cleanUrl = currentGameStatus.tunnelUrl.replace(/\/$/, '');
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

    // Load saved settings on boot
    document.addEventListener('DOMContentLoaded', () => {
    // 1. Hide PC-only elements if running on Android / Capacitor
    const isMobile = window.Capacitor || navigator.userAgent.includes('Android');
    if (isMobile) {
        ['docsFloatBtn', 'settingRowSetupWizard'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.setProperty('display', 'none', 'important');
        });
    }
    
    if (!window.electronAPI) {
        ['settingRowDiscordRPC', 'settingRowOpenLog', 'settingRowUpdates'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.setProperty('display', 'none', 'important');
        });
    }

    // Show HIDMaestro setting only on Windows (desktop Electron)
    const hmRow = document.getElementById('settingRowHidMaestro');
    if (hmRow) {
        hmRow.style.display = (window.electronAPI && navigator.platform.includes('Win')) ? 'flex' : 'none';
    }

    // 2. Restore UI version toggle
    if (localStorage.getItem('ns_ui_version') === 'old') {
        document.getElementById('settingTrackOldUI')?.classList.add('on');
    }

    // 3. Populate language select with fallback options
    const langSelect = document.getElementById('langSelect');
    if (langSelect && langSelect.options.length === 0) {
        [
            ['en', 'English'], ['es', 'Español'], ['fr', 'Français'],
            ['de', 'Deutsch'], ['pt', 'Português'], ['ja', '日本語'],
            ['ko', '한국어'], ['zh', '中文'], ['ru', 'Русский'],
        ].forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val; opt.textContent = label;
            langSelect.appendChild(opt);
        });
    }

    const savedLang = localStorage.getItem('ns_lang') || navigator.language.split('-')[0] || 'en';
    if (langSelect) langSelect.value = savedLang;

    // 4. Arcade panel iframe
    const port = _getServerPort();
    const arcadeFrame = document.querySelector('#panel-arcade iframe');
    if (arcadeFrame) {
        arcadeFrame.src = (window.NEARSEC_ARCADE_URL || 'https://nearcade.cutefame.net') + '/arcade?electron=1&lang=' + savedLang;
    }

    loadAndSyncSettings();
    checkFirstRun();

    // 5. Auto-start logic
    const params = new URLSearchParams(window.location.search);
    const noAutoHost = params.get('noAutoHost') === '1';

    const autoStartEnabled = appConfig.autoStartHost
        || appConfig.bootToHost
        || localStorage.getItem('ns_auto_host') === 'true';

if (autoStartEnabled) {
        document.getElementById('settingTrackAutoHost')?.classList.add('on');
        if (!noAutoHost) {
            setTimeout(launchHostSession, 500);
        }
    }

    // 6. Set initial games tab visibility (connect is default active panel)
    const gamesTab = document.getElementById('gamesTab');
    const activePanel = document.querySelector('.panel.active');
    if (gamesTab && activePanel && activePanel.id !== 'panel-connect') {
      gamesTab.style.display = 'none';
    }
  });

    function launchHostSession() {
      // Force direct storage read to prevent race condition with appConfig caching
      let uiVer = localStorage.getItem('ns_ui_version') || 'default';
      // Migrate old setting format if present
      if (uiVer === 'new') uiVer = 'default';
      if (uiVer === 'old') uiVer = 'minimal';

      if (window.electronAPI && window.electronAPI.openHost) {
        window.electronAPI.openHost(uiVer);
      } else {
        const port = _getServerPort();
        let path = '/host';
        if (uiVer === 'minimal') path = '/host-minimal';
        else if (uiVer === 'playground') path = '/host-playground';
        else if (uiVer === 'custom') path = '/host-custom';
        window.location.href = 'http://localhost:' + port + path;
      }
    }

    // Toggle Functions
    function setHostUI(val) {
      if (val === 'custom') {
        document.getElementById('customUIFile').click();
      }
      localStorage.setItem('ns_ui_version', val);
      appConfig.uiVersion = val;
      saveAppConfigToElectron();
    }
    
    function uploadCustomUI(input) {
      if (!input.files || !input.files[0]) return;
      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = function(e) {
        const content = e.target.result;
        fetch('http://localhost:' + _getServerPort() + '/api/save-custom-host', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: content })
        }).then(res => {
          if (res.ok) alert('Custom Host UI successfully uploaded!');
          else alert('Failed to save Custom UI');
        }).catch(err => {
          console.error(err);
          alert('Error uploading Custom UI');
        });
      };
      reader.readAsText(file);
      input.value = ''; // Reset so they can re-upload
    }

    function toggleAutoHost() {
      const track = document.getElementById('settingTrackAutoHost');
      const isAuto = track.classList.toggle('on');
      localStorage.setItem('ns_auto_host', isAuto ? 'true' : 'false');
      // Write to config file so bootToHost is authoritative
      appConfig.bootToHost = isAuto;
      appConfig.autoStartHost = isAuto;
      saveAppConfigToElectron();
      const port = _getServerPort();
      fetch('http://localhost:' + port + '/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootToHost: isAuto })
      }).catch(() => {});
    }

    function openAutoHostTerminal() {
      const cmd  = document.getElementById('autoCmd').value.trim();
      const name = document.getElementById('autoName').value.trim() || 'Auto-Host';
      if (!cmd) { alert('Enter a launch command first.'); return; }
      const port = _getServerPort();
      fetch('http://localhost:' + port + '/api/open-terminal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd, name })
      }).then(r => r.json()).then(d => { if (!d.ok) alert('Terminal failed: ' + (d.reason || '')); })
        .catch(() => alert('Terminal launch failed.'));
    }
    (function () {
      const isLinux = navigator.userAgent.includes('Linux') && !navigator.userAgent.includes('Android');
      if (isLinux) { const b = document.getElementById('btnOpenTerminal'); if (b) b.style.display = 'block'; }
    })();

    function killGame() {
        if(confirm("Stop the running game?")) {
            const port = _getServerPort();
            fetch(`http://localhost:${port}/api/restart-game`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: 'KILL_ONLY' })
            });
        }
    }