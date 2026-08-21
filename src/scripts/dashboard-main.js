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
    window.NEARCADE_VERSION = version;
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
    if (window.NEARCADE_VERSION && vEl) vEl.textContent = 'v' + window.NEARCADE_VERSION;
    if (window.NEARCADE_COMMIT && cEl) cEl.textContent = window.NEARCADE_COMMIT;
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
  const txt = 'v' + (window.NEARCADE_VERSION || 'unknown') + (window.NEARCADE_COMMIT ? '-' + window.NEARCADE_COMMIT : '');
  navigator.clipboard.writeText(txt).catch(() => { });
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
    const res = await fetch((window.NEARCADE_ARCADE_URL || 'https://nearcade.cutefame.net') + '/api/client-version');
    if (!res.ok) return;
    const data = await res.json();
    const minVer = data.minimum || '0.0.0';
    if (compareVersions(window.NEARCADE_VERSION, minVer) < 0) {
      const overlay = document.createElement('div');
      overlay.id = 'clientVersionOverlay';
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

  if (name === 'arcade') {
    const arcadeFrame = document.querySelector('#panel-arcade iframe');
    if (arcadeFrame && !arcadeFrame.getAttribute('src')) {
      const savedLang = localStorage.getItem('ns_lang') || navigator.language.split('-')[0] || 'en';
      const currentPort = _getServerPort();
      let url = (window.NEARCADE_ARCADE_URL || 'https://nearcade.cutefame.net') + '/arcade?electron=1&port=' + currentPort + '&lang=' + savedLang;
      if (window.isVrFilterEnabled) {
        url += '&vr=1';
      }
      arcadeFrame.src = url;
      setTimeout(applyVrFilterState, 50); // Apply style when loaded
    }
  } else if (name === 'serverlist') {
    fetchCommunityServers();
  } else if (name === 'turnlist') {
    fetchCommunityTurnServers();
  }
}

window.isVrFilterEnabled = false; // Forced false until ready: localStorage.getItem('ns_vr_filter') === 'true';

function applyVrFilterState() {
  const btn = document.getElementById('vrFilterBtn');
  if (!btn) return;
  const icon = btn.querySelector('i');
  const text = btn.querySelector('span');
  
  if (window.isVrFilterEnabled) {
    btn.style.borderColor = 'var(--accent)';
    btn.style.boxShadow = '0 0 15px var(--accent-glow)';
    if (icon) icon.style.color = 'var(--accent)';
    if (text) text.style.color = 'var(--accent)';
  } else {
    btn.style.borderColor = 'var(--border)';
    btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
    if (icon) icon.style.color = 'var(--muted)';
    if (text) text.style.color = 'var(--muted)';
  }
}

window.toggleVrFilter = function() {
  // Disabled until VR integration is finalized.
  console.log("VR filter is temporarily disabled, just opening arcade.");
  switchTab('arcade');
  return;
  /*
  window.isVrFilterEnabled = !window.isVrFilterEnabled;
  localStorage.setItem('ns_vr_filter', window.isVrFilterEnabled ? 'true' : 'false');
  applyVrFilterState();

  const arcadeFrame = document.querySelector('#panel-arcade iframe');
  if (arcadeFrame) {
    const savedLang = localStorage.getItem('ns_lang') || navigator.language.split('-')[0] || 'en';
    const currentPort = _getServerPort();
    let url = (window.NEARCADE_ARCADE_URL || 'https://nearcade.cutefame.net') + '/arcade?electron=1&port=' + currentPort + '&lang=' + savedLang;
    if (window.isVrFilterEnabled) {
      url += '&vr=1';
    }
    arcadeFrame.src = url;
  }
  */
}

let appConfig = {};

const DEFAULT_ACCENT = '#c084fc';
const DEFAULT_ACCENT2 = '#c084fc';
const DEFAULT_ACCENT_DIM = 'rgba(192,132,252,0.15)';
const DEFAULT_ACCENT_GLOW = 'rgba(192,132,252,0.35)';

async function applySystemAccent() {
  const useAccent = appConfig.useSystemAccent !== undefined ? appConfig.useSystemAccent : (localStorage.getItem('ns_use_system_accent') === 'true');
  localStorage.setItem('ns_use_system_accent', useAccent ? 'true' : 'false');
  const indicator = document.getElementById('sysAccentIndicator');
  const root = document.documentElement;

  const applyDefault = () => {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-rgb');
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
    const r = parseInt(accent.slice(1, 3), 16);
    const g = parseInt(accent.slice(3, 5), 16);
    const b = parseInt(accent.slice(5, 7), 16);
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
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
    root.style.removeProperty('--surface-rgb');
    root.style.removeProperty('--surface-hover');
    root.style.removeProperty('--card');
    root.style.removeProperty('--card2');
    root.style.removeProperty('--text');
    root.style.removeProperty('--muted');
    root.style.removeProperty('--muted2');
    root.style.removeProperty('--border');
    root.style.removeProperty('--bg-rgb');
    if (appConfig.useSystemAccent) {
      applySystemAccent();
    } else {
      root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-rgb');
      root.style.removeProperty('--accent-dim');
      root.style.removeProperty('--accent-glow');
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

      const hexToRgb = (hex) => {
        if (!hex || !hex.startsWith('#') || hex.length !== 7) return null;
        return {
          r: parseInt(hex.slice(1,3), 16),
          g: parseInt(hex.slice(3,5), 16),
          b: parseInt(hex.slice(5,7), 16)
        };
      };

      const acc = hexToRgb(theme.accent);
      if (acc) {
        root.style.setProperty('--accent-dim', `rgba(${acc.r},${acc.g},${acc.b},0.15)`);
        root.style.setProperty('--accent-glow', `rgba(${acc.r},${acc.g},${acc.b},0.35)`);
      }

      const surf = hexToRgb(theme.surface);
      if (surf) {
        root.style.setProperty('--surface-rgb', `${surf.r}, ${surf.g}, ${surf.b}`);
        root.style.setProperty('--card', `rgba(${surf.r},${surf.g},${surf.b},0.92)`);
        root.style.setProperty('--card2', `rgba(${surf.r},${surf.g},${surf.b},0.95)`);
      }

      const bgRgb = hexToRgb(theme.bg);
      if (bgRgb) {
        root.style.setProperty('--bg-rgb', `${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}`);
      }

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
let _syncTimer = null;
let _bootTime = Date.now();
function syncToNode() {
  clearTimeout(_syncTimer);
  const elapsed = Date.now() - _bootTime;
  const delay = Math.max(500, 3000 - elapsed); // Delay until 3s after boot, then 500ms debounce
  _syncTimer = setTimeout(() => {
    const port = _getServerPort();
    fetch(`http://localhost:${port}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_cfgWithoutTunnel())
    }).catch(() => { });
  }, delay);
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
      setTimeout(() => {
        fetch(`http://localhost:${_getServerPort()}/api/config`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hostAvatar: String(savedHostAvatar) })
        }).catch(() => { });
      }, 3000);
    }

    const hostAvatarPreview = document.getElementById('hostAvatarPreview');
    if (hostAvatarPreview) hostAvatarPreview.src = `/assets/avatars/avatar-${savedHostAvatar}.svg`;

    window.randomizeHostAvatar = function () {
      const newAv = Math.floor(Math.random() * 100) + 1;
      localStorage.setItem('ns_host_avatar', newAv);
      localStorage.setItem('ns_avatar', newAv);
      if (hostAvatarPreview) hostAvatarPreview.src = `/assets/avatars/avatar-${newAv}.svg`;

      fetch(`http://localhost:${_getServerPort()}/api/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostAvatar: String(newAv) })
      }).catch(() => { });
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
  document.getElementById('settingTrackVrMode')?.classList.toggle('on', !!appConfig.vrMode);
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
  document.getElementById('settingTrackWindowsExperimental')?.classList.toggle('on', !!appConfig.windowsExperimental);

  const brandText = document.querySelector('.brand-text');
  if (brandText) {
    brandText.textContent = appConfig.vrMode ? 'NEARCADE VR' : 'NEARCADE';
  }
  
  const brandLogo = document.querySelector('.brand-logo');
  if (brandLogo) {
    let use3D = !!appConfig.vrMode;
    if (appConfig.overrideLogo === '3d') use3D = true;
    if (appConfig.overrideLogo === '2d') use3D = false;
    brandLogo.src = use3D ? '../../assets/NearcadeIcon3D.png' : '../../assets/NearcadeLogo.png';
  }
  const gamesTabSpan = document.getElementById('gamesTab');
  if (gamesTabSpan) {
    gamesTabSpan.innerHTML = appConfig.vrMode ? 'V<br>R<br><br>G<br>A<br>M<br>E<br>S' : 'G<br>A<br>M<br>E<br>S';
  }
  const gamesLibBtn = document.querySelector('#gamesLibraryBtn span');
  if (gamesLibBtn) {
    gamesLibBtn.textContent = appConfig.vrMode ? 'VR Library' : 'Library';
  }

  // Expose Linux Advanced Setup on Linux regardless of vrMode
  const linuxSetupRow = document.getElementById('settingRowLinuxSetup');
  if (linuxSetupRow) {
    linuxSetupRow.style.display = (window.electronAPI && navigator.platform.toLowerCase().includes('linux')) ? 'flex' : 'none';
  }

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

function toggleBrandLogo() {
  const isCurrently3D = document.querySelector('.brand-logo').src.includes('NearcadeIcon3D');
  appConfig.overrideLogo = isCurrently3D ? '2d' : '3d';
  saveAppConfigToElectron();
  syncToNode();
  syncSettingsUI();
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
  if (window.electronAPI) {
    window.electronAPI.saveSettings({ tunnelProvider: appConfig.tunnelProvider });
  }
  const port = _getServerPort();
  fetch(`http://localhost:${port}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tunnelProvider: appConfig.tunnelProvider })
  }).catch(() => { });
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
      }).catch(() => { });
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
  if (['tray', 'hwDecode', 'discordRPC', 'rumble', 'checkForUpdates', 'useSystemAccent', 'useNativeTheme', 'windowsExperimental', 'vrMode'].includes(key)) {
    appConfig[key] = !appConfig[key];
    const tk = key === 'hwDecode' ? 'HWDecode' :
      key === 'discordRPC' ? 'DiscordRPC' :
        key === 'checkForUpdates' ? 'CheckForUpdates' :
          key === 'useSystemAccent' ? 'SystemAccent' :
            key === 'useNativeTheme' ? 'NativeTheme' :
              key === 'windowsExperimental' ? 'WindowsExperimental' :
                key.charAt(0).toUpperCase() + key.slice(1);
    const tr = document.getElementById('settingTrack' + tk);
    if (tr) tr.classList.toggle('on', appConfig[key]);
    if (window.electronAPI) window.electronAPI.saveSettings(appConfig);

    if (key === 'useSystemAccent' && !appConfig.useNativeTheme) applySystemAccent();
    if (key === 'useNativeTheme') applyNativeTheme();
    if (key === 'vrMode' && appConfig.vrMode && window.electronAPI && window.electronAPI.startWivrn) {
      window.electronAPI.startWivrn().then(res => {
        const modal = document.getElementById('wivrnModal');
        const title = document.getElementById('wivrnModalTitle');
        const body = document.getElementById('wivrnModalBody');
        const actions = document.getElementById('wivrnModalActions');
        if (modal && title && body && actions) {
          if (res.success) {
            title.innerHTML = '<span style="color:var(--green)">WiVRn Started</span>';
            body.innerHTML = 'WiVRn server successfully started in the background.<br><br>Ready for headset connections!';
            actions.innerHTML = `<button class="btn-confirm" onclick="document.getElementById('wivrnModal').classList.add('gone');">Dismiss</button>`;
          } else {
            title.innerHTML = '<span style="color:var(--danger)">WiVRn Failed to Start</span>';
            body.innerHTML = `Failed to start WiVRn server.<br><br><span style="color:var(--danger)">Error: ${res.error || 'Unknown error'}</span><br><br>Did you run the Linux Advanced Installer script? It is required to install WiVRn dependencies.`;
            actions.innerHTML = `
              <button class="btn-skip" onclick="document.getElementById('wivrnModal').classList.add('gone'); toggleAppSetting('vrMode');" style="margin-right:8px;">Dismiss</button>
              <button class="btn-confirm" onclick="document.getElementById('wivrnModal').classList.add('gone'); toggleAppSetting('vrMode'); if(window.electronAPI) window.electronAPI.runAdvancedLinuxSetup();">Run Installer</button>
            `;
          }
          modal.classList.remove('gone');
        }
      }).catch(e => {
        const modal = document.getElementById('wivrnModal');
        if (modal) {
          document.getElementById('wivrnModalTitle').innerHTML = '<span style="color:var(--danger)">Error</span>';
          document.getElementById('wivrnModalBody').textContent = e.message;
          document.getElementById('wivrnModalActions').innerHTML = `<button class="btn-confirm" onclick="document.getElementById('wivrnModal').classList.add('gone');">Dismiss</button>`;
          modal.classList.remove('gone');
        }
      });
    }
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
  const _arcadeOrigin = (window.NEARCADE_ARCADE_URL || 'https://nearcade.cutefame.net');
  if (event.origin.includes(new URL(_arcadeOrigin).hostname) && event.data?.type === 'JOIN_SESSION') {
    if (window.electronAPI) window.electronAPI.joinSession(event.data.url, { game: event.data.game });
  }
});

const cursor = document.getElementById('virtual-cursor');
let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
let lastTime = performance.now();

function updateGamepad(time) {
  const dt = Math.min((time - lastTime) / 1000, 0.1); // Cap delta time at 100ms
  lastTime = time;

  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    cursor.style.display = 'block';
    const dx = p.axes[0], dy = p.axes[1];

    // At 60hz, we moved 14 pixels per frame (840px per second)
    const speed = 840;

    if (Math.abs(dx) > 0.15) cx += dx * speed * dt;
    if (Math.abs(dy) > 0.15) cy += dy * speed * dt;

    cx = Math.max(0, Math.min(window.innerWidth, cx));
    cy = Math.max(0, Math.min(window.innerHeight, cy));
    cursor.style.left = cx + 'px';
    cursor.style.top = cy + 'px';

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
window.addEventListener('gamepadconnected', () => {
  lastTime = performance.now();
  requestAnimationFrame(updateGamepad);
});

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
    cursor.style.display = 'block';
    if (e.key === 'ArrowUp') cy -= 40;
    if (e.key === 'ArrowDown') cy += 40;
    if (e.key === 'ArrowLeft') cx -= 40;
    if (e.key === 'ArrowRight') cx += 40;
    
    cx = Math.max(0, Math.min(window.innerWidth, cx));
    cy = Math.max(0, Math.min(window.innerHeight, cy));
    cursor.style.left = cx + 'px';
    cursor.style.top = cy + 'px';
    
    if (e.key === 'Enter') {
      cursor.classList.add('clicking');
      setTimeout(() => cursor.classList.remove('clicking'), 150);
      const el = document.elementFromPoint(cx, cy);
      if (el && typeof el.click === 'function') el.click();
    }
  }
});

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

  loadAndSyncSettings();
  checkFirstRun();
});

// ── Auto-Host Logic ────────────────────────────────────────────────────────
let currentGameStatus = { running: false, command: null, tunnelUrl: null, log: '' };

setTimeout(() => {
  setInterval(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const activePort = urlParams.get('port') || '3000';
    fetch(`http://localhost:${activePort}/api/status`).then(r => r.json()).then(status => {
      if (status.running !== currentGameStatus.running || status.log !== currentGameStatus.log) {
        currentGameStatus = status;
        renderAutoHosts();
      }
    }).catch(() => { });
  }, 1000);
}, 3000);

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

  // Show HIDMaestro and Windows Experimental setting only on Windows (desktop Electron)
  const hmRow = document.getElementById('settingRowHidMaestro');
  if (hmRow) {
    hmRow.style.display = (window.electronAPI && navigator.platform.includes('Win')) ? 'flex' : 'none';
  }
  const winExpRow = document.getElementById('settingRowWindowsExperimental');
  if (winExpRow) {
    winExpRow.style.display = (window.electronAPI && navigator.platform.includes('Win')) ? 'flex' : 'none';
  }
  const vbCableRow = document.getElementById('settingRowVBCable');
  if (vbCableRow) {
    vbCableRow.style.display = (window.electronAPI && navigator.platform.includes('Win')) ? 'flex' : 'none';
  }
  const linuxSetupRow = document.getElementById('settingRowLinuxSetup');
  if (linuxSetupRow) {
    // Only expose the Advanced Setup (Linux) row if Nearcade VR Mode is actually enabled
    linuxSetupRow.style.display = (window.electronAPI && navigator.platform.toLowerCase().includes('linux') && appConfig.vrMode) ? 'flex' : 'none';
  }

  // 2. Restore UI version toggle
  if (localStorage.getItem('ns_ui_version') === 'old') {
    document.getElementById('settingTrackOldUI')?.classList.add('on');
  }

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

async function fetchCommunityServers() {
  const container = document.getElementById('serverListContainer');
  if (!container) return;

  container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px;">Loading community servers...</div>`;

  try {
    const res = await fetch(`http://localhost:${_getServerPort()}/api/community-servers`);
    if (!res.ok) throw new Error('Failed to fetch');
    const servers = await res.json();

    container.innerHTML = '';

    // Add "Reset to Default STUN" button
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
      alert("Reset STUN server back to the Google default.\\n\\nYour changes have been discarded.");
      fetchCommunityServers(); // Re-render the list
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
          const confirmMsg = "PRIVACY WARNING:\\n\\nIf you select a Community STUN Server, your public IP address will be visible to the person hosting the server.\\n\\nDo you want to proceed and use " + server.name + "?";
          if (!confirm(confirmMsg)) return;

          // Save to localStorage for the viewer side
          localStorage.setItem('ns_custom_stun', server.url);

          // Save to env for the host side
          if (window.electronAPI && window.electronAPI.saveEnv) {
            window.electronAPI.saveEnv('STUN_URL', server.url);
          }

          // Re-render UI to show new active state
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
  // Actually probe every server — including the metered.ca default — with a
  // real TURN allocation. Never assume a relay is alive.
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
          console.log('[TURN Ping] gathered:', event.candidate.type, event.candidate.candidate);
          if (event.candidate.type === 'relay' || event.candidate.candidate.includes('typ relay')) {
            finish(true);
          }
        } else {
          finish(false);
        }
      };

      setTimeout(() => finish(false), 10000); // 10s timeout to be safe

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
    const res = await fetch(`http://localhost:${_getServerPort()}/api/community-turn-servers`);
    if (!res.ok) throw new Error('Failed to fetch');
    const servers = await res.json();

    container.innerHTML = '';

    // Add "Reset to Default TURN" button
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
      alert("Reset TURN server back to the default.\\n\\nYour changes have been discarded.");
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
      // The bundled Metered.ca default relay is often slow/down; don't draw a
      // red/offline dot next to it — it is a fallback, not a choice.
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
          const confirmMsg = "CRITICAL PRIVACY WARNING:\\n\\nThis server will route ALL of your game video, audio, and input traffic.\\n\\nOnly proceed if you trust this server host.\\n\\nProceed with " + server.name + "?";
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

      if (hideDot) return; // metered.ca default: no status dot, no probe
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

            // If the user's currently selected custom server is offline, auto-fallback
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
  reader.onload = function (e) {
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
  }).catch(() => { });
}

function openAutoHostTerminal() {
  const cmd = document.getElementById('autoCmd').value.trim();
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
  if (!isLinux) { const v = document.getElementById('settingRowVrMode'); if (v) v.style.display = 'none'; }
})();

function killGame() {
  if (confirm("Stop the running game?")) {
    const port = _getServerPort();
    fetch(`http://localhost:${port}/api/restart-game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'KILL_ONLY' })
    });
  }
}

// ── Friend list & ping module ──────────────────────────────────────────
// Friends are keyed by each friend's own persistent UUID. Display names and
// avatars are DISPLAY ONLY. A ping is one-way: the friend notifies the host
// and (optionally) shares their current session link. The HOST decides to
// end their own session and join the friend's — the viewer never sees a
// popup or invite.
let _friendSeenPings = 0;
let _friendLastToastKey = null;
let _friendLastInviteKey = null;

const FRIEND_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function toggleFriendPanel() {
  const panel = document.getElementById('friendPanel');
  const overlay = document.getElementById('friendOverlay');
  const open = panel.style.transform === 'translateX(0%)';
  if (open) { closeFriendPanel(); return; }
  panel.style.transform = 'translateX(0%)';
  overlay.style.display = 'block';
  loadFriends();
  document.getElementById('friendPingBadge').style.display = 'none';
}

function closeFriendPanel() {
  document.getElementById('friendPanel').style.transform = 'translateX(105%)';
  document.getElementById('friendOverlay').style.display = 'none';
}

function copyFriendUuid() {
  const el = document.getElementById('myFriendUuid');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent.trim()).then(() => {
    const btn = document.getElementById('myFriendUuidCopy');
    if (btn) btn.textContent = I18N.t('Copied!');
    setTimeout(() => { if (btn) btn.textContent = I18N.t('Copy'); }, 1500);
  }).catch(() => { });
}

function friendDisplayName(f) {
  return (f && f.name) || (f && f.uuid ? f.uuid.slice(0, 8) : '');
}

async function loadFriends() {
  try {
    const res = await fetch(`http://localhost:${_getServerPort()}/api/friends`);
    if (!res.ok) return;
    const data = await res.json();
    updateFriendSections(data.enabled);
    const toggle = document.getElementById('friendPingToggle');
    if (toggle && toggle.checked !== data.enabled) {
      toggle.checked = data.enabled;
      renderToggleState(data.enabled);
    }
    const uuidEl = document.getElementById('myFriendUuid');
    if (uuidEl && data.myUuid && uuidEl.textContent !== data.myUuid) uuidEl.textContent = data.myUuid;
    updateFriendWarning(data.enabled);
    renderFriendList(data.friends || []);
    renderFriendPings(data.pings || [], data.friends || []);
    maybeShowPingToast(data.pings || []);
    maybeShowInvitePopup(data.invites || []);
    const panelOpen = document.getElementById('friendPanel').style.transform === 'translateX(0%)';
    if (!panelOpen && (data.pings || []).length > _friendSeenPings) {
      const badge = document.getElementById('friendPingBadge');
      const newCount = (data.pings || []).length - _friendSeenPings;
      badge.textContent = newCount;
      badge.style.display = 'inline-block';
    }
    _friendSeenPings = (data.pings || []).length;
  } catch (_) { }
}

function updateFriendSections(enabled) {
  const enablePopup = document.getElementById('friendEnablePopup');
  const section = document.getElementById('friendEnabledSection');
  if (enablePopup) enablePopup.style.display = enabled ? 'none' : 'block';
  if (section) section.style.display = enabled ? 'flex' : 'none';
  // The friends icon only shows while the setting is on. When it's off, a
  // small banner in its place offers to re-enable (the panel's enable card
  // is still reachable through it).
  const floatBtn = document.getElementById('friendFloatBtn');
  const enableBanner = document.getElementById('friendEnableFloatBanner');
  if (floatBtn) floatBtn.style.display = enabled ? 'flex' : 'none';
  if (enableBanner) enableBanner.style.display = enabled ? 'none' : 'block';
}

function updateFriendWarning(enabled) {
  const warn = document.getElementById('friendWarning');
  if (warn) warn.style.display = enabled ? 'block' : 'none';
}

function renderToggleState(enabled) {
  const bg = document.getElementById('friendPingToggleBg');
  const knob = document.getElementById('friendPingToggleKnob');
  if (bg) bg.style.background = enabled ? 'var(--accent,#c084fc)' : '#3a3745';
  if (knob) knob.style.transform = enabled ? 'translateX(18px)' : 'translateX(0)';
}

async function setFriendPingEnabled(enabled) {
  renderToggleState(enabled);
  updateFriendWarning(enabled);
  updateFriendSections(enabled);
  try {
    await fetch(`http://localhost:${_getServerPort()}/api/friends/toggle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    loadFriends();
  } catch (_) { }
}

// Show a toast when a NEW ping arrives. The toast offers to JOIN the
// friend's session — the host ends their own session and opens the
// friend's link. This is host-side only; viewers never see this.
function maybeShowPingToast(pings) {
  if (!pings.length) return;
  const newest = pings[0];
  const key = newest.uuid + ':' + newest.at;
  if (key === _friendLastToastKey) return;
  _friendLastToastKey = key;
  showFriendPingToast(newest);
}

function showFriendPingToast(ping) {
  const existing = document.getElementById('friendInviteToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'friendInviteToast';
  toast.style.cssText = 'position:fixed; bottom:70px; right:16px; z-index:1600; background:var(--surface,#16151d); border:1px solid var(--border,#2a2833); border-radius:12px; padding:14px 16px; width:290px; box-shadow:0 10px 30px rgba(0,0,0,0.45); display:flex; flex-direction:column; gap:10px;';
  const name = ping.name || friendDisplayName({ uuid: ping.uuid });
  toast.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px;">
      <img src="/assets/avatars/avatar-${ping.avatar || 1}.svg" style="width:36px; height:36px; border-radius:50%; background:#11111b; border:2px solid var(--accent,#c084fc); flex-shrink:0;"
        onerror="this.style.display='none'">
      <div style="flex:1; min-width:0;">
        <div style="font-size:13px; font-weight:700; color:var(--text,#e8e6ef); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${I18N.t('{name} pinged you').replace('{name}', name)}</div>
        ${ping.url ? `<div style="font-size:11px; color:var(--muted,#888); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${ping.url.replace(/^https?:\/\//, '')}</div>` : ''}
      </div>
      <button onclick="this.parentElement.parentElement.remove()" title="${I18N.t('Dismiss')}"
        style="background:transparent; border:none; color:var(--muted,#888); cursor:pointer; font-size:16px; line-height:1; padding:2px 4px;">×</button>
    </div>
    ${ping.url ? `<button onclick="joinFriendSession('${ping.url}', this)"
      style="background:#fff; border:none; border-radius:8px; padding:9px; color:#111; font-weight:700; font-size:12px; cursor:pointer; font-family:inherit; width:100%;">${I18N.t('Join their session')}</button>` : ''}
  `;
  document.body.appendChild(toast);
}

// ── P2P INVITE POPUP (friend side) ────────────────────────────────────────────
// When a friend's server invites us into their P2P session, a popup offers to
// join. Accepting navigates to our own viewer page with ?host=p2p://<roomCode>,
// which viewer.js handles natively. The room code is embedded in the button —
// it is never displayed as a bare link.
function maybeShowInvitePopup(invites) {
  if (!invites || !invites.length) return;
  const newest = invites[0];
  const key = newest.fromUuid + ':' + newest.at;
  if (key === _friendLastInviteKey) return;
  _friendLastInviteKey = key;
  showP2PInvitePopup(newest);
}

function showP2PInvitePopup(invite) {
  const existing = document.getElementById('friendP2PInvitePopup');
  if (existing) existing.remove();
  const popup = document.createElement('div');
  popup.id = 'friendP2PInvitePopup';
  popup.style.cssText = 'position:fixed; bottom:70px; right:16px; z-index:1650; background:var(--surface,#16151d); border:1px solid var(--accent,#c084fc); border-radius:12px; padding:14px 16px; width:300px; box-shadow:0 10px 30px rgba(0,0,0,0.45); display:flex; flex-direction:column; gap:10px;';
  const name = String(invite.fromName || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  popup.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px;">
      <div style="flex:1; min-width:0;">
        <div style="font-size:13px; font-weight:700; color:var(--text,#e8e6ef);">${I18N.t('{name} invited you to their session').replace('{name}', name)}</div>
        <div style="font-size:11px; color:var(--muted,#888); margin-top:2px;">${I18N.t('They are streaming directly to you over peer-to-peer.')}</div>
      </div>
      <button onclick="dismissP2PInvite('${invite.fromUuid}'); this.closest('#friendP2PInvitePopup').remove()" title="${I18N.t('Dismiss')}"
        style="background:transparent; border:none; color:var(--muted,#888); cursor:pointer; font-size:16px; line-height:1; padding:2px 4px;">×</button>
    </div>
    <button onclick="acceptP2PInvite('${invite.roomCode}')"
      style="background:var(--accent,#c084fc); border:none; border-radius:8px; padding:9px; color:#111; font-weight:700; font-size:12px; cursor:pointer; font-family:inherit; width:100%;">${I18N.t('Join their P2P session')}</button>
  `;
  document.body.appendChild(popup);
}

// Friend accepts: open their own viewer page pointed at the P2P room code.
// The friend's client joins the host's session once the room is discovered.
function acceptP2PInvite(roomCode) {
  const popup = document.getElementById('friendP2PInvitePopup');
  if (popup) popup.remove();
  dismissP2PInvite('');
  window.location.href = `/?host=p2p://${encodeURIComponent(roomCode)}`;
}

function dismissP2PInvite(fromUuid) {
  if (!fromUuid) return;
  fetch(`http://localhost:${_getServerPort()}/api/p2p-invite/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromUuid })
  }).catch(() => { });
}

// Host accepts the invite: ends their OWN session, then opens the
// friend's session link. The host is the one who joins — never the viewer.
async function joinFriendSession(url, btn) {
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = I18N.t('Joining...');
  try {
    await fetch(`http://localhost:${_getServerPort()}/api/capture/stop`, { method: 'POST' });
  } catch (_) { }
  setTimeout(() => {
    const t = document.getElementById('friendInviteToast');
    if (t) t.remove();
    window.location.href = url;
  }, 600);
}

async function addFriend() {
  const input = document.getElementById('friendUuidInput');
  const uuid = (input.value || '').trim().toLowerCase();
  const errEl = document.getElementById('friendAddErr');
  const myUuidEl = document.getElementById('myFriendUuid');
  if (!FRIEND_UUID_RE.test(uuid)) {
    if (errEl) errEl.textContent = I18N.t('Enter a valid friend ID (the full UUID from their app).');
    return;
  }
  if (myUuidEl && myUuidEl.textContent.trim() === uuid) {
    if (errEl) errEl.textContent = I18N.t('You can\'t add yourself as a friend.');
    return;
  }
  if (errEl) errEl.textContent = '';
  try {
    const res = await fetch(`http://localhost:${_getServerPort()}/api/friends/add`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid })
    });
    const data = await res.json();
    if (!data.ok) {
      if (errEl) errEl.textContent = data.error === 'cannot add yourself' ? I18N.t('You can\'t add yourself as a friend.') : (data.error || I18N.t('Failed to add friend.'));
      return;
    }
    input.value = '';
    renderFriendList(data.friends || []);
    if (data.secret) showPairNotice(uuid, data.secret);
  } catch (_) { }
}

// One-time pairing-code reveal after adding a friend — the host copies this
// code and sends it to the friend out-of-band. The friend enters it in their
// own Dashboard → Enter Pairing Code. Pings/invites without a valid signature
// for this secret are rejected by the server.
function showPairNotice(uuid, secret) {
  const el = document.getElementById('friendPairNotice');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML =
    '<div style="font-weight:600; margin-bottom:4px;">' + I18N.t('Send this pairing code to your friend (along with your Friend ID):') + '</div>' +
    '<code style="display:block; user-select:all; word-break:break-all; background:#211f28; border:1px solid var(--border,#2a2833); border-radius:6px; padding:8px; font-size:12px; color:var(--accent,#c084fc);">' + secret + '</code>' +
    '<button onclick="copyPairCode(\'' + secret + '\')" style="margin-top:8px; background:#fff; border:none; border-radius:6px; padding:6px 12px; color:#111; font-weight:700; font-size:12px; cursor:pointer; font-family:inherit;">' + I18N.t('Copy Pairing Code') + '</button>' +
    '<div style="margin-top:6px; color:var(--muted,#888);">' + I18N.t('Tell your friend: this code proves their pings and invites really come from them. They paste it in their own app — Dashboard → Enter Pairing Code, or their profile → Pairing Code — along with your Friend ID. Until they do, their pings to you are rejected.') + '</div>';
}

async function copyPairCode(secret) {
  try {
    await navigator.clipboard.writeText(secret);
    const btn = document.querySelector('#friendPairNotice button');
    if (btn) btn.textContent = I18N.t('Copied!');
  } catch (_) { }
}

// Re-show a friend's pairing code from the ⋮ menu (in case the one-time
// notice was dismissed before the code was shared).
async function showFriendPairCode(uuid) {
  try {
    const res = await fetch(`http://localhost:${_getServerPort()}/api/friends/paircode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid })
    });
    const data = await res.json();
    if (data.ok && data.secret) showPairNotice(uuid, data.secret);
  } catch (_) { }
}

// Friend side: store the pairing secret their host gave us, keyed by the
// host's UUID. Used to verify the host's pings/invites to us.
async function enterPairCode() {
  const uuidEl = document.getElementById('friendPairUuidInput');
  const secEl = document.getElementById('friendPairSecretInput');
  const errEl = document.getElementById('friendPairErr');
  const uuid = (uuidEl.value || '').trim().toLowerCase();
  const secret = (secEl.value || '').trim().toLowerCase();
  if (errEl) errEl.style.color = '#f66';
  if (!FRIEND_UUID_RE.test(uuid)) {
    if (errEl) errEl.textContent = I18N.t('Enter a valid friend ID.');
    return;
  }
  if (!/^[0-9a-f]{48}$/.test(secret)) {
    if (errEl) errEl.textContent = I18N.t('Enter a valid 48-character pairing code.');
    return;
  }
  if (errEl) errEl.textContent = '';
  try {
    const res = await fetch(`http://localhost:${_getServerPort()}/api/friends/secret`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid, secret })
    });
    const data = await res.json();
    if (data.ok) {
      if (errEl) errEl.style.color = '#22c55e';
      if (errEl) errEl.textContent = I18N.t('Pairing saved — their pings and invites will now be accepted.');
      uuidEl.value = '';
      secEl.value = '';
    } else if (errEl) {
      errEl.textContent = data.error === 'invalid pairing code' ? I18N.t('Enter a valid 48-character pairing code.') : (data.error || I18N.t('Failed to save pairing code.'));
    }
  } catch (_) {
    if (errEl) errEl.textContent = I18N.t('Failed to save pairing code.');
  }
}

async function removeFriend(uuid) {
  try {
    const res = await fetch(`http://localhost:${_getServerPort()}/api/friends/remove`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid })
    });
    const data = await res.json();
    if (data.ok) renderFriendList(data.friends || []);
  } catch (_) { }
}

async function renameFriend(uuid) {
  const name = window.prompt(I18N.t('Enter a display name for this friend:'));
  if (name === null) return;
  const trimmed = name.trim().slice(0, 32);
  if (!trimmed) return;
  try {
    const res = await fetch(`http://localhost:${_getServerPort()}/api/friends/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid, name: trimmed })
    });
    const data = await res.json();
    if (data.ok) renderFriendList(data.friends || []);
  } catch (_) { }
}

async function copyFriendId(uuid) {
  try {
    await navigator.clipboard.writeText(uuid);
    const btn = document.querySelector('#friendMenu-' + uuid + ' .menu-copy');
    if (btn) {
      const t = btn.textContent;
      btn.textContent = I18N.t('Copied!');
      setTimeout(() => { btn.textContent = t; }, 1500);
    }
  } catch (_) { }
}

function toggleFriendMenu(uuid) {
  document.querySelectorAll('.friend-row-menu').forEach(m => {
    if (m.id !== 'friendMenu-' + uuid && m.style.display !== 'none') m.style.display = 'none';
  });
  const menu = document.getElementById('friendMenu-' + uuid);
  if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.friend-row-menu')) {
    document.querySelectorAll('.friend-row-menu').forEach(m => { m.style.display = 'none'; });
  }
});

function renderFriendList(friends) {
  const list = document.getElementById('friendList');
  const empty = document.getElementById('friendEmpty');
  if (!list) return;
  if (empty) empty.style.display = friends.length ? 'none' : 'block';
  list.innerHTML = '';
  const sorted = [...friends].sort((a, b) => {
    if (!!a.online !== !!b.online) return a.online ? -1 : 1;
    const an = (a.name || '').toLowerCase(), bn = (b.name || '').toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return (b.lastAt || 0) - (a.lastAt || 0);
  });
  sorted.forEach(f => {
    const row = document.createElement('div');
    const safeName = String(f.name || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
    const nameText = safeName || `<span style="color:var(--muted,#888);font-style:italic;">${I18N.t('Unknown friend')}</span>`;
    row.style.cssText = 'position:relative; display:flex; align-items:center; gap:10px; background:#211f28; border-radius:8px; padding:8px 10px; opacity:' + (f.online ? 1 : 0.55) + ';';
    row.innerHTML = `
      <span title="${f.online ? I18N.t('Online') : I18N.t('Offline')}"
        style="width:8px; height:8px; border-radius:50%; background:${f.online ? '#22c55e' : '#ef4444'}; flex-shrink:0;"></span>
      <img src="/assets/avatars/avatar-${f.avatar || 1}.svg" style="width:32px; height:32px; border-radius:50%; background:#11111b; border:2px solid var(--border,#2a2833); flex-shrink:0;"
        onerror="this.style.display='none'">
      <div style="flex:1; min-width:0;">
        <div style="font-size:13px; font-weight:600; color:var(--text,#e8e6ef); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${nameText}</div>
        <div style="font-size:11px; color:var(--muted,#888);">${f.uuid.slice(0, 13)}…</div>
      </div>
      <button onclick="event.stopPropagation(); toggleFriendMenu('${f.uuid}')" title="${I18N.t('Friend actions')}"
        style="background:transparent; border:none; color:var(--muted,#a6adc8); cursor:pointer; font-size:16px; line-height:1; padding:2px 6px; letter-spacing:1px;">⋮</button>
      <div id="friendMenu-${f.uuid}" class="friend-row-menu"
        style="display:none; position:absolute; right:8px; top:38px; z-index:60; background:#1c1a24; border:1px solid var(--border,#2a2833); border-radius:8px; min-width:180px; box-shadow:0 8px 24px rgba(0,0,0,0.5); padding:4px;">
        <button class="menu-copy" onclick="copyFriendId('${f.uuid}')"
          style="display:block; width:100%; text-align:left; background:transparent; border:none; color:var(--text,#e8e6ef); font-size:12px; font-family:inherit; padding:8px 10px; cursor:pointer; border-radius:6px;">${I18N.t('Copy Friend ID')}</button>
        <button onclick="showFriendPairCode('${f.uuid}')"
          style="display:block; width:100%; text-align:left; background:transparent; border:none; color:var(--text,#e8e6ef); font-size:12px; font-family:inherit; padding:8px 10px; cursor:pointer; border-radius:6px;">${I18N.t('Show Pairing Code')}</button>
        <button onclick="renameFriend('${f.uuid}')"
          style="display:block; width:100%; text-align:left; background:transparent; border:none; color:var(--text,#e8e6ef); font-size:12px; font-family:inherit; padding:8px 10px; cursor:pointer; border-radius:6px;">${I18N.t('Rename')}</button>
        <button onclick="removeFriend('${f.uuid}')"
          style="display:block; width:100%; text-align:left; background:transparent; border:none; color:#f66; font-size:12px; font-family:inherit; padding:8px 10px; cursor:pointer; border-radius:6px;">${I18N.t('Remove friend')}</button>
      </div>
    `;
    list.appendChild(row);
  });
}

function renderFriendPings(pings, friends) {
  const list = document.getElementById('friendPingList');
  if (!list) return;
  list.innerHTML = '';
  if (!pings.length) {
    list.textContent = I18N.t('No pings yet.');
    return;
  }
  const onlineMap = {};
  (friends || []).forEach(f => { onlineMap[f.uuid] = !!f.online; });
  pings.forEach(p => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:8px;';
    const when = timeAgo(p.at);
    const name = p.name || friendDisplayName({ uuid: p.uuid });
    const online = !!onlineMap[p.uuid];
    row.innerHTML = `
      <span title="${online ? I18N.t('Online') : I18N.t('Offline')}"
        style="width:7px; height:7px; border-radius:50%; background:${online ? '#22c55e' : '#ef4444'}; flex-shrink:0;"></span>
      <img src="/assets/avatars/avatar-${p.avatar || 1}.svg" style="width:20px; height:20px; border-radius:50%; background:#11111b; flex-shrink:0;"
        onerror="this.style.display='none'">
      <span style="flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${I18N.t('{name} pinged you').replace('{name}', name)}</span>
      <span style="font-size:11px; color:var(--muted2,#666); flex-shrink:0;">${when}</span>
    `;
    list.appendChild(row);
  });
}

function timeAgo(at) {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

setInterval(loadFriends, 8000);

document.addEventListener('DOMContentLoaded', () => {
    fetch('/api/game-profiles').then(r => r.json()).then(titles => {
        const dl = document.getElementById('arcadeGameTitles');
        if (dl && Array.isArray(titles)) {
            titles.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t;
                dl.appendChild(opt);
            });
        }
    }).catch(e => console.error('[dashboard] failed to load game profiles:', e));
});