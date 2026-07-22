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
        
        // Compute dims
        if (theme.accent.startsWith('#') && theme.accent.length === 7) {
          const rVal = parseInt(theme.accent.slice(1,3), 16);
          const gVal = parseInt(theme.accent.slice(3,5), 16);
          const bVal = parseInt(theme.accent.slice(5,7), 16);
          r.style.setProperty('--accent-dim', `rgba(${rVal},${gVal},${bVal},0.15)`);
          r.style.setProperty('--accent-glow', `rgba(${rVal},${gVal},${bVal},0.35)`);
        }
      }
    } catch(e) {}
  } else if (savedAccent) {
    const root = document.documentElement;
    root.style.setProperty('accent-color', savedAccent);
    root.style.setProperty('--accent', savedAccent);
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
