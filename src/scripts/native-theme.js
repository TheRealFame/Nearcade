(function() {
  const useNative = localStorage.getItem('ns_use_native_theme') === 'true';
  const savedAccent = localStorage.getItem('ns_chat_color');

  if (useNative) {
    try {
      const themeStr = localStorage.getItem('ns_native_theme_payload');
      if (themeStr) {
        const theme = JSON.parse(themeStr);
        const r = document.documentElement;
        r.style.setProperty('--bg', theme.bg);
        r.style.setProperty('--sidebar', theme.sidebar);
        r.style.setProperty('--surface', theme.surface);
        r.style.setProperty('--surface-hover', theme.surfaceHover);
        r.style.setProperty('--text', theme.text);
        r.style.setProperty('--muted', theme.muted);
        r.style.setProperty('--muted2', theme.muted2);
        r.style.setProperty('--border', theme.border);
        r.style.setProperty('--accent', theme.accent);
        if (theme.accent) {
          const acc = hexToRgb(theme.accent);
          if (acc) r.style.setProperty('--accent-rgb', `${acc.r}, ${acc.g}, ${acc.b}`);
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

        // Compute dims for accent
        const acc = hexToRgb(theme.accent);
        if (acc) {
          r.style.setProperty('--accent-dim', `rgba(${acc.r},${acc.g},${acc.b},0.15)`);
          r.style.setProperty('--accent-glow', `rgba(${acc.r},${acc.g},${acc.b},0.35)`);
        }

        // Compute rgba for surfaces (needed for glassmorphism / host.css)
        const surf = hexToRgb(theme.surface);
        if (surf) {
          r.style.setProperty('--surface-rgb', `${surf.r}, ${surf.g}, ${surf.b}`);
          r.style.setProperty('--card', `rgba(${surf.r},${surf.g},${surf.b},0.92)`);
          r.style.setProperty('--card2', `rgba(${surf.r},${surf.g},${surf.b},0.95)`);
        }
        
        const bgRgb = hexToRgb(theme.bg);
        if (bgRgb) {
          r.style.setProperty('--bg-rgb', `${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}`);
        }
      }
    } catch(e) {}
  } else if (savedAccent) {
    const root = document.documentElement;
    root.style.setProperty('accent-color', savedAccent);
    root.style.setProperty('--accent', savedAccent);
    if (savedAccent.startsWith('#') && savedAccent.length === 7) {
      const r = parseInt(savedAccent.slice(1, 3), 16);
      const g = parseInt(savedAccent.slice(3, 5), 16);
      const b = parseInt(savedAccent.slice(5, 7), 16);
      root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    }
    root.style.setProperty('--accent2', savedAccent);
    if (savedAccent.startsWith('#') && savedAccent.length === 7) {
      const r = parseInt(savedAccent.slice(1, 3), 16);
      const g = parseInt(savedAccent.slice(3, 5), 16);
      const b = parseInt(savedAccent.slice(5, 7), 16);
      root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.15)`);
      root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.35)`);
    }
  }
})();
