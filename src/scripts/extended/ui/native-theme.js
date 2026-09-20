(function() {
  const useNative = localStorage.getItem('ns_use_native_theme') === 'true';
  const savedAccent = localStorage.getItem('ns_chat_color');

  if (useNative) {
    try {
      const themeStr = localStorage.getItem('ns_native_theme_payload');
      if (themeStr) {
        const theme = JSON.parse(themeStr);
        // Freshest accent wins: ns_chat_color is rewritten on every dashboard
        // accent/native fetch with live probe data, while a stored payload can
        // predate probe fixes (stale purple). Prefer chat color when present.
        try {
          const fresh = localStorage.getItem('ns_chat_color');
          if (fresh) theme.accent = fresh;
        } catch (_) {}
        const r = document.documentElement;
        
        // Host UI is always dark glassmorphism. Never override its base colors.
        const isHost = location.pathname.includes('/host');
        if (!isHost) {
          r.style.setProperty('--bg', theme.bg);
          r.style.setProperty('--sidebar', theme.sidebar);
          r.style.setProperty('--surface', theme.surface);
          r.style.setProperty('--surface-hover', theme.surfaceHover);
          r.style.setProperty('--text', theme.text);
          r.style.setProperty('--muted', theme.muted);
          r.style.setProperty('--muted2', theme.muted2);
          r.style.setProperty('--border', theme.border);
        }
        // Helper to convert hex to rgb
        const hexToRgb = (hex) => {
          if (!hex || !hex.startsWith('#') || hex.length !== 7) return null;
          return {
            r: parseInt(hex.slice(1,3), 16),
            g: parseInt(hex.slice(3,5), 16),
            b: parseInt(hex.slice(5,7), 16)
          };
        };
        // Readable ink for text placed ON accent fills (buttons, badges).
        // White text dies on light accents (white-on-white = 1:1); black
        // text dies on near-black accents. Pick per-accent luminance.
        const accentInk = (hex) => {
          const c = hexToRgb(hex);
          if (!c) return '#fff';
          const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
          return lum > 0.45 ? '#111116' : '#ffffff';
        };

        r.style.setProperty('--accent', theme.accent);
        if (theme.accent) {
          const acc = hexToRgb(theme.accent);
          if (acc) r.style.setProperty('--accent-rgb', `${acc.r}, ${acc.g}, ${acc.b}`);
          r.style.setProperty('--accent-ink', accentInk(theme.accent));
        }

        // Compute dims for accent
        const acc = hexToRgb(theme.accent);
        if (acc) {
          r.style.setProperty('--accent-dim', `rgba(${acc.r},${acc.g},${acc.b},0.15)`);
          r.style.setProperty('--accent-glow', `rgba(${acc.r},${acc.g},${acc.b},0.35)`);
        }
        // --accent2 was never set on this branch: anything using it fell back
        // to the light-purple default even with a live OS accent.
        if (theme.accent) {
          r.style.setProperty('--accent2', theme.accent);
          r.dataset.nsAccent = '1';
        }

        // Compute rgba for surfaces (needed for glassmorphism / host.css)
        const surf = hexToRgb(theme.surface);
        if (surf && !isHost) {
          r.style.setProperty('--surface-rgb', `${surf.r}, ${surf.g}, ${surf.b}`);
          r.style.setProperty('--card', `rgba(${surf.r},${surf.g},${surf.b},0.92)`);
          r.style.setProperty('--card2', `rgba(${surf.r},${surf.g},${surf.b},0.95)`);
        }
        
        const bgRgb = hexToRgb(theme.bg);
        if (bgRgb && !isHost) {
          r.style.setProperty('--bg-rgb', `${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}`);
        }
      }
    } catch(e) {}
  } else if (savedAccent) {
    const root = document.documentElement;
    const _inkFor = (hex) => {
      if (!hex || !hex.startsWith('#') || hex.length !== 7) return '#fff';
      const lum = (0.2126 * parseInt(hex.slice(1, 3), 16) + 0.7152 * parseInt(hex.slice(3, 5), 16) + 0.0722 * parseInt(hex.slice(5, 7), 16)) / 255;
      return lum > 0.45 ? '#111116' : '#ffffff';
    };
    root.style.setProperty('accent-color', savedAccent);
    root.style.setProperty('--accent', savedAccent);
    root.style.setProperty('--accent-ink', _inkFor(savedAccent));
    if (savedAccent.startsWith('#') && savedAccent.length === 7) {
      const r = parseInt(savedAccent.slice(1, 3), 16);
      const g = parseInt(savedAccent.slice(3, 5), 16);
      const b = parseInt(savedAccent.slice(5, 7), 16);
      root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    }
    root.style.setProperty('--accent2', savedAccent);
    root.dataset.nsAccent = '1';
    if (savedAccent.startsWith('#') && savedAccent.length === 7) {
      const r = parseInt(savedAccent.slice(1, 3), 16);
      const g = parseInt(savedAccent.slice(3, 5), 16);
      const b = parseInt(savedAccent.slice(5, 7), 16);
      root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.15)`);
      root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.35)`);
    }
  }

  // Self-sufficiency: pages that never visit the dashboard (host-first flows)
  // would otherwise sit on the CSS default forever when no stored color
  // exists. If nothing above applied an accent, ask the OS directly
  // (Electron only) and persist it so every page heals.
  try {
    if (!document.documentElement.dataset.nsAccent
      && window.electronAPI && typeof window.electronAPI.getAccentColor === 'function') {
      window.electronAPI.getAccentColor().then((accent) => {
        try {
          if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent)) return;
          const root = document.documentElement;
          if (root.dataset.nsAccent) return; // raced by another applier
          const r = parseInt(accent.slice(1, 3), 16);
          const g = parseInt(accent.slice(3, 5), 16);
          const b = parseInt(accent.slice(5, 7), 16);
          const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          root.style.setProperty('--accent', accent);
          root.style.setProperty('--accent2', accent);
          root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
          root.style.setProperty('--accent-ink', lum > 0.45 ? '#111116' : '#ffffff');
          root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.15)`);
          root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.35)`);
          root.dataset.nsAccent = '1';
          try { localStorage.setItem('ns_chat_color', accent); } catch (_) {}
        } catch (_) {}
      }).catch(() => {});
    }
  } catch (_) {}
})();
