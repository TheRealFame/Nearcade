// ── Boot-phase timing (diagnoses "dashboard freezes for a moment") ─────────
// Records wall-clock marks during startup; 3 s after load, prints ONE line
// naming only phases slower than 250 ms. Silent on fast boots. This exists
// because a momentary post-splash freeze can come from anywhere (script
// parse under load, awaited accent/IPC, first data batch) and guessing
// wastes everyone's time.
const __bootT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
const __bootMarks = [];
function __bootMark(name) {
  try {
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - __bootT0;
    __bootMarks.push([name, Math.round(t)]);
  } catch (_) {}
}
try {
  setTimeout(() => {
    try {
      const slow = __bootMarks.filter(([, t]) => t > 250);
      if (slow.length) console.log('[boot] slow phases (>250ms): ' + slow.map(([n, t]) => `${n}=${t}ms`).join(' '));
    } catch (_) {}
  }, 3000);
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('load', () => __bootMark('window-load'), { once: true });
  }
} catch (_) {}
// ── In-app confirm modal (replaces all native confirm() calls) ────────────────
// Returns a Promise<boolean> so callers can await it just like confirm().
function showAppConfirm(title, message, okLabel = 'OK', cancelLabel = 'Cancel') {
  return new Promise((resolve) => {
    const existing = document.getElementById('_appConfirmOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = '_appConfirmOverlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'background:rgba(0,0,0,0.65)', 'backdrop-filter:blur(4px)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font-family:inherit'
    ].join(';');

    // Sanitise message for display (convert \n to <br>)
    const safeMsg = String(message)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    overlay.innerHTML = `
      <div style="background:var(--surface,#1e1b2e);border:1px solid var(--border,rgba(255,255,255,0.08));
                  border-radius:14px;padding:28px 32px;max-width:420px;width:90%;box-shadow:0 24px 60px rgba(0,0,0,0.7);">
        <h3 style="margin:0 0 12px;font-size:16px;font-weight:700;color:var(--text,#f4f4f5);">${title}</h3>
        <p style="margin:0 0 24px;font-size:13px;color:var(--muted,#a1a1aa);line-height:1.7;">${safeMsg}</p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="_appConfirmCancel" style="padding:9px 20px;border-radius:8px;font-size:13px;font-weight:600;
                  cursor:pointer;border:1px solid var(--border,rgba(255,255,255,0.08));
                  background:var(--card,rgba(44,44,46,0.92));color:var(--text,#f4f4f5);font-family:inherit;">
            ${cancelLabel}
          </button>
          <button id="_appConfirmOk" style="padding:9px 20px;border-radius:8px;font-size:13px;font-weight:600;
                  cursor:pointer;border:none;background:var(--accent,#c084fc);color:#000;font-family:inherit;">
            ${okLabel}
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const finish = (result) => { overlay.remove(); resolve(result); };
    document.getElementById('_appConfirmOk').addEventListener('click', () => finish(true));
    document.getElementById('_appConfirmCancel').addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
  });
}

// ── GLOBAL STYLE REFRESH ──────────────────────────────────────────────────
// Instantly applies persisted CSS variables from localStorage before the DOM
// or Electron APIs are fully ready to prevent style-flashing during navigation.
(function applyPersistedStyles() {
  try {
    const root = document.documentElement;
    // 1. Accent Color
    const accent = localStorage.getItem('ns_chat_color');
    const useSystemAccent = localStorage.getItem('ns_use_system_accent') === 'true';
    if (accent && useSystemAccent && accent !== '#c084fc') {
      const r = parseInt(accent.slice(1, 3), 16);
      const g = parseInt(accent.slice(3, 5), 16);
      const b = parseInt(accent.slice(5, 7), 16);
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
      root.style.setProperty('--accent2', accent);
      root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.15)`);
      root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.35)`);
    }

    // 2. Native Theme (Backgrounds, Surfaces, Text)
    const useNative = localStorage.getItem('ns_use_native_theme') === 'true';
    if (useNative) {
      const themeStr = localStorage.getItem('ns_native_theme_payload');
      if (themeStr) {
        const theme = JSON.parse(themeStr);
        root.style.setProperty('--bg', theme.bg);
        root.style.setProperty('--sidebar', theme.surface || theme.sidebar);
        root.style.setProperty('--surface', theme.surface);
        root.style.setProperty('--surface-hover', theme.surfaceHover);
        root.style.setProperty('--text', theme.text);
        root.style.setProperty('--muted', theme.muted);
        root.style.setProperty('--muted2', theme.muted2);
        root.style.setProperty('--border', theme.border);

        const hexToRgb = (hex) => {
          if (!hex || !hex.startsWith('#') || hex.length !== 7) return null;
          return {
            r: parseInt(hex.slice(1, 3), 16),
            g: parseInt(hex.slice(3, 5), 16),
            b: parseInt(hex.slice(5, 7), 16)
          };
        };

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
      }
    }
  } catch (e) {
    console.warn('Failed to apply persisted styles:', e);
  }
})();

document.addEventListener('DOMContentLoaded', async () => {
  __bootMark('dom-ready');
  const vEl = document.getElementById('version-text');
  const cEl = document.getElementById('commit-hash');

  await applySystemAccent();
  __bootMark('accent+version-ready');

  // Handle ?tab= URL parameter for deep-linking from web viewer
  const urlParams = new URLSearchParams(window.location.search);
  if (window.AndroidClipboard && typeof window.AndroidClipboard.getStatusBarHeight === 'function') {
    try {
      const sbPx = window.AndroidClipboard.getStatusBarHeight() / (window.devicePixelRatio || 1);
      if (sbPx > 0) {
        document.documentElement.style.setProperty('--android-status-bar', sbPx + 'px');
      }
    } catch (_) {}
  }
  if (urlParams.has('portrait')) {
    document.documentElement.classList.add('portrait-mode');
  }
  const isHandheld = urlParams.has('handheld') || urlParams.has('tv') || localStorage.getItem('ns_handheld_mode') === 'true';
  if (isHandheld) {
    document.documentElement.classList.add('handheld-mode');
    if (typeof initHandheldStatusBar === 'function') initHandheldStatusBar();
  }
  const tabParam = urlParams.get('tab');
  if (tabParam && typeof switchTab === 'function') {
    // Delay slightly to ensure tabs are initialized
    setTimeout(() => switchTab(tabParam), 100);
  }

  // Random brand color: purple, orange, or white (or indigo in light mode)
  const isLightMode = window.matchMedia('(prefers-color-scheme: light)').matches;
  const brandColors = [
    { color: '#c084fc', stroke: 'rgba(192,132,252,0.3)', shadow: 'rgba(192,132,252,' },
    { color: '#ff8a4c', stroke: 'rgba(255,138,76,0.3)', shadow: 'rgba(255,138,76,' },
    { color: isLightMode ? '#6366f1' : '#eef0ff', stroke: isLightMode ? 'rgba(99,102,241,0.3)' : 'rgba(238,240,255,0.3)', shadow: isLightMode ? 'rgba(99,102,241,' : 'rgba(238,240,255,' },
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

function toggleMobileDrawer() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  if (sb.classList.contains('mobile-open')) {
    closeMobileDrawer();
  } else {
    openMobileDrawer();
  }
}

function openMobileDrawer() {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.add('mobile-open');
  if (bd) bd.classList.add('open');
}

function closeMobileDrawer() {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebarBackdrop');
  if (sb) sb.classList.remove('mobile-open');
  if (bd) bd.classList.remove('open');
}

window.toggleMobileDrawer = toggleMobileDrawer;
window.openMobileDrawer = openMobileDrawer;
window.closeMobileDrawer = closeMobileDrawer;

function switchTab(name) {
  closeMobileDrawer();
  // Null-safe panel swap — if a panel doesn't exist, log and bail rather than crash
  const panel = document.getElementById('panel-' + name);
  if (!panel) {
    console.warn('[switchTab] No panel found for:', name);
    return;
  }
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('active'));
  panel.classList.add('active');
  document.getElementById('tab-' + name)?.classList.add('active');
  const bnavBtn = document.getElementById('bnav-' + name);
  if (bnavBtn) {
    bnavBtn.classList.add('active');
  } else {
    document.getElementById('bnav-more')?.classList.add('active');
  }

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
      const safeLang = encodeURIComponent(String(savedLang).replace(/[^a-zA-Z0-9_\-]/g, '') || 'en');
      const safePort = encodeURIComponent(String(_getServerPort()).replace(/[^0-9]/g, '') || '3000');
      const rawBase = window.NEARCADE_ARCADE_URL || 'https://nearcade.cutefame.net';
      let safeBase = 'https://nearcade.cutefame.net';
      try {
        const parsed = new URL(rawBase);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          safeBase = parsed.origin;
        }
      } catch (_) {}
      let url = `${safeBase}/arcade?electron=1&port=${safePort}&lang=${safeLang}`;
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
  } else if (name === 'containers') {
    // Scanning libraryfolders.vdf + every appmanifest_*.acf takes a moment —
    // only do it when the user actually opens Auto-Hosts.
    loadAutoHostSteamGames();
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
  const indicator = document.getElementById('sysAccentIndicator');
  if (appConfig.useNativeTheme) {
    if (indicator) indicator.style.display = 'none';
    return;
  }

  const useAccent = appConfig.useSystemAccent !== undefined ? appConfig.useSystemAccent : (localStorage.getItem('ns_use_system_accent') === 'true');
  localStorage.setItem('ns_use_system_accent', useAccent ? 'true' : 'false');
  const root = document.documentElement;

  const applyDefault = () => {
    // If native theme is active, let it govern the accent color instead of falling back to purple
    if (appConfig.useNativeTheme) {
      const stored = localStorage.getItem('ns_native_theme_payload');
      if (stored) {
        try {
          const t = JSON.parse(stored);
          if (t.accent) return; // Native theme has an accent, do not overwrite it
        } catch (_) {}
      }
    }

    root.style.setProperty('--accent', DEFAULT_ACCENT);
    root.style.setProperty('--accent-rgb', '192, 132, 252');
    root.style.setProperty('--accent2', DEFAULT_ACCENT2);
    root.style.setProperty('--accent-dim', DEFAULT_ACCENT_DIM);
    root.style.setProperty('--accent-glow', DEFAULT_ACCENT_GLOW);
    if (indicator) indicator.style.display = 'none';

    if (appConfig.hostColor !== '#c084fc') {
      appConfig.hostColor = '#c084fc';
      localStorage.setItem('ns_chat_color', '#c084fc');
      syncToNode();
    }
  };

  if (!useAccent) {
    applyDefault();
    return;
  }
  try {
    let accent = null;
    if (window.electronAPI && typeof window.electronAPI.getAccentColor === 'function') {
      try {
        accent = await window.electronAPI.getAccentColor();
      } catch (_) {}
    }
    if (!accent && window.AndroidClipboard && typeof window.AndroidClipboard.getSystemAccentColor === 'function') {
      try {
        accent = window.AndroidClipboard.getSystemAccentColor();
      } catch (_) {}
    }
    if (!accent) {
      try {
        const testEl = document.createElement('div');
        testEl.style.color = 'AccentColor';
        testEl.style.display = 'none';
        document.head.appendChild(testEl);
        const comp = getComputedStyle(testEl).color;
        document.head.removeChild(testEl);
        const m = comp && comp.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (m) {
          const hex = '#' + [m[1], m[2], m[3]].map(v => parseInt(v, 10).toString(16).padStart(2, '0')).join('');
          if (hex !== '#000000' && hex !== '#ffffff') accent = hex;
        }
      } catch (_) {}
    }

    if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent)) {
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
    root.style.setProperty('--accent-ink', ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) > 0.45 ? '#111116' : '#ffffff');
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
    // Always sync the accent color state whether we apply a native theme or not
    applySystemAccent();
    if (indicator) indicator.style.display = 'none';
    return;
  }

  try {
    const theme = await window.electronAPI.getNativeTheme();
    if (theme) {
      root.style.setProperty('--bg', theme.bg);
      root.style.setProperty('--sidebar', theme.surface || theme.sidebar);
      root.style.setProperty('--surface', theme.surface);
      root.style.setProperty('--surface-hover', theme.surfaceHover);
      root.style.setProperty('--text', theme.text);
      root.style.setProperty('--muted', theme.muted);
      root.style.setProperty('--muted2', theme.muted2);
      root.style.setProperty('--border', theme.border);

      const hexToRgb = (hex) => {
        if (!hex || !hex.startsWith('#') || hex.length !== 7) return null;
        return {
          r: parseInt(hex.slice(1,3), 16),
          g: parseInt(hex.slice(3,5), 16),
          b: parseInt(hex.slice(5,7), 16)
        };
      };

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

      if (theme.accent) {
        root.style.setProperty('--accent', theme.accent);
        root.style.setProperty('--accent2', theme.accent);
        const r = parseInt(theme.accent.slice(1, 3), 16);
        const g = parseInt(theme.accent.slice(3, 5), 16);
        const b = parseInt(theme.accent.slice(5, 7), 16);
        root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
        root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.15)`);
        root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.35)`);
        root.style.setProperty('--accent-ink', ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) > 0.45 ? '#111116' : '#ffffff');
        
        if (appConfig.hostColor !== theme.accent) {
          appConfig.hostColor = theme.accent;
          localStorage.setItem('ns_chat_color', theme.accent);
        }
      }

      localStorage.setItem('ns_native_theme_payload', JSON.stringify(theme));
      syncToNode();
      if (indicator) indicator.style.display = 'inline-block';
    } else {
      localStorage.removeItem('ns_native_theme_payload');
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
      if (indicator) indicator.style.display = 'none';
    }
  } catch (e) {
    console.error('Failed to get native theme:', e);
  }
}

function _getServerPort() {
  const p = new URLSearchParams(window.location.search).get('port') || '3000';
  const num = parseInt(p, 10);
  if (!Number.isNaN(num) && num > 0 && num <= 65535) {
    return String(num);
  }
  return '3000';
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
    if (document.getElementById('settingCustomUrl')) document.getElementById('settingCustomUrl').value = appConfig.customUrl || '';

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
    const safeHostAvatar = String(savedHostAvatar || '').replace(/[^a-zA-Z0-9_\-]/g, '') || '1';
    if (hostAvatarPreview) hostAvatarPreview.src = `/assets/avatars/avatar-${safeHostAvatar}.svg`;

    window.randomizeHostAvatar = function () {
      const newAv = Math.floor(Math.random() * 100) + 1;
      localStorage.setItem('ns_host_avatar', newAv);
      localStorage.setItem('ns_avatar', newAv);
      const safeNewAv = String(newAv || '').replace(/[^a-zA-Z0-9_\-]/g, '') || '1';
      if (hostAvatarPreview) hostAvatarPreview.src = `/assets/avatars/avatar-${safeNewAv}.svg`;

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
  document.getElementById('settingTrackAndroidExperimental')?.classList.toggle('on', !!appConfig.androidExperimental);
  document.getElementById('settingTrackHandheldMode')?.classList.toggle('on', document.documentElement.classList.contains('handheld-mode'));

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

function saveCustomUrl(val) {
  appConfig.customUrl = val.trim();
  saveAppConfigToElectron();
  syncToNode();
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
  fetch(`http://localhost:${_getServerPort()}/api/tunnels/start`, {
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

    if (key === 'useSystemAccent') applySystemAccent();
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
  const inputEl = document.getElementById('directLinkInput');
  const errEl = document.getElementById('directLinkErr');
  try {
    let text = '';
    if (window.AndroidClipboard && typeof window.AndroidClipboard.getClipboard === 'function') {
      text = window.AndroidClipboard.getClipboard();
    }
    if (!text && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Clipboard) {
      try {
        const res = await window.Capacitor.Plugins.Clipboard.read();
        text = res?.value || '';
      } catch (_) {}
    }
    if (!text && navigator.clipboard && navigator.clipboard.readText) {
      text = await navigator.clipboard.readText().catch(() => '');
    }
    if (text && text.trim()) {
      inputEl.value = text.trim();
      inputEl.focus();
      if (errEl) errEl.textContent = '';
      return;
    }
    if (errEl) errEl.textContent = 'Clipboard is empty.';
  } catch (_) {
    if (errEl) errEl.textContent = 'Could not read clipboard. Please paste manually.';
  }
}

async function joinDirectLink() {
  const inputVal = document.getElementById('directLinkInput').value.trim();
  const pinVal = document.getElementById('pinInput').value.trim();
  const errEl = document.getElementById('directLinkErr');
  if (!inputVal) {
    if (errEl) errEl.textContent = 'Please enter a valid URL or Room Code.';
    return;
  }

  // Check if it's a URL
  const isUrl = inputVal.startsWith('http://') || inputVal.startsWith('https://');

  if (isUrl) {
    if (errEl) errEl.textContent = '';
    if (window.electronAPI) {
      window.electronAPI.joinSession(inputVal, { game: 'Direct Connect' }, pinVal);
    } else {
      let viewerUrl = inputVal + (inputVal.includes('?') ? '&' : '?') + 'client=1&compat=1';
      if (pinVal) viewerUrl += `&pin=${encodeURIComponent(pinVal)}`;
      window.location.href = viewerUrl;
    }
  } else {
    // It's a Room Code
    if (errEl) errEl.textContent = '';
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
        if (typeof renderAutoHosts === 'function') renderAutoHosts();
      }
    }).catch(() => { });
  }, 1000);
}, 3000);

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

  const pendingJump = localStorage.getItem('ns_pending_host_jump') === 'true';

  if (autoStartEnabled || pendingJump) {
    if (pendingJump) localStorage.removeItem('ns_pending_host_jump');
    document.getElementById('settingTrackAutoHost')?.classList.add('on');
    if (!noAutoHost || pendingJump) {
      setTimeout(() => launchHostSession({ isAuto: !pendingJump }), 500);
    }
  }

  // 6. Set initial games tab visibility (connect is default active panel)
  const gamesTab = document.getElementById('gamesTab');
  const activePanel = document.querySelector('.panel.active');
  if (gamesTab && activePanel && activePanel.id !== 'panel-connect') {
    gamesTab.style.display = 'none';
  }
});

let _ignoredAdminPrompt = false;
async function launchHostSession(opts = {}) {
  // Ask for elevation once per app session (reloads dashboard)
  if (!appConfig.hidmaestro && window.electronAPI && window.electronAPI.checkElevation && navigator.userAgent.includes('Windows')) {
    const isElevated = await window.electronAPI.checkElevation();
    if (!isElevated) {
      const wantsElevate = await showAppConfirm(
        'Elevation Required',
        `Nearcade requires Administrator privileges on Windows for Keyboard/Mouse emulation (UIPI) and ViGEmBus virtual gamepad drivers.\n\nPlease click OK to elevate Nearcade's permissions.`,
        'OK',
        'Cancel'
      );
      if (wantsElevate) {
        localStorage.setItem('ns_pending_host_jump', 'true');
        const success = await window.electronAPI.elevateApp();
        if (success) {
          // The app will now relaunch. We wait for it to exit.
          await new Promise(r => setTimeout(r, 2000));
          return;
        } else {
          // Clean up if it failed (e.g. UAC cancelled)
          localStorage.removeItem('ns_pending_host_jump');
        }
      }
      // If cancelled or failed, close the prompt and stop the host launch
      return;
    }
  }
  // Force direct storage read to prevent race condition with appConfig caching
  let uiVer = localStorage.getItem('ns_ui_version') || 'default';
  // Migrate old setting format if present
  if (uiVer === 'new') uiVer = 'default';
  if (uiVer === 'old') uiVer = 'minimal';

  if (window.AndroidClipboard && typeof window.AndroidClipboard.setOrientation === 'function') {
    try { window.AndroidClipboard.setOrientation('landscape'); } catch (_) {}
  }
  if (screen.orientation && typeof screen.orientation.lock === 'function') {
    screen.orientation.lock('landscape').catch(() => {});
  }

  if (window.electronAPI && window.electronAPI.openHost) {
    window.electronAPI.openHost(uiVer);
  } else {
    const port = _getServerPort();
    let path = '/host';
    if (uiVer === 'minimal') path = '/host-minimal';
    else if (uiVer === 'playground') path = '/host-playground';
    else if (uiVer === 'custom') path = '/host-custom';
    const targetUrl = new URL(path, `http://127.0.0.1:${port}`);
    window.location.href = targetUrl.href;
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

(function () {
  const isLinux = navigator.userAgent.includes('Linux') && !navigator.userAgent.includes('Android');
  if (isLinux) { const b = document.getElementById('btnOpenTerminal'); if (b) b.style.display = 'block'; }
  if (!isLinux) { const v = document.getElementById('settingRowVrMode'); if (v) v.style.display = 'none'; }
  const isAndroid = navigator.userAgent.includes('Android') || (typeof window.Capacitor !== 'undefined' && window.Capacitor?.getPlatform() === 'android') || !!window.AndroidClipboard;
  const androidRow = document.getElementById('settingRowAndroidExperimental');
  if (androidRow && !isAndroid) androidRow.style.display = 'none';
  if (isAndroid) {
    const tabContainers = document.getElementById('tab-containers');
    if (tabContainers) tabContainers.style.display = 'none';
    const moreCardAutoHosts = document.getElementById('moreCardAutoHosts');
    if (moreCardAutoHosts) moreCardAutoHosts.style.display = 'none';
  }
})();


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
async function exitNearcadeApp() {
  const confirmed = await showAppConfirm(
    "Exit Nearcade",
    "Are you sure you want to completely shut down and exit Nearcade?",
    "Exit",
    "Cancel"
  );
  if (confirmed) {
    if (window.electronAPI && typeof window.electronAPI.closeApp === 'function') {
      window.electronAPI.closeApp();
    } else {
      fetch('/api/shutdown', { method: 'POST' }).then(() => {
        window.close();
      }).catch(() => { window.close(); });
    }
  }
}
