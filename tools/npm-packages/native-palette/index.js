const getWindowsMacTheme = require('./windows-mac');
const getKdeTheme = require('./linux-kde');
const getGtkTheme = require('./linux-de');
const getBareTheme = require('./linux-bare');
const accentColor = require('@nearcade/accent-color');

function getFallbackTheme() {
  let isDark = true;
  try {
    const { nativeTheme } = require('electron');
    isDark = nativeTheme.shouldUseDarkColors;
  } catch (e) {}

  let accent = '#8b5cf6';
  try {
    const c = accentColor.get();
    if (c && c.hex) accent = c.hex;
  } catch (e) {}

  return {
    bg: isDark ? '#1e1e1e' : '#f0f0f0',
    sidebar: isDark ? '#252526' : '#e0e0e0',
    surface: isDark ? '#2d2d30' : '#ffffff',
    surfaceHover: isDark ? '#3e3e42' : '#f5f5f5',
    text: isDark ? '#d4d4d4' : '#000000',
    muted: isDark ? '#808080' : '#666666',
    muted2: isDark ? '#555555' : '#999999',
    border: isDark ? '#404040' : '#cccccc',
    accent: accent
  };
}

function getThemeColors() {
  let theme = null;

  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      theme = getWindowsMacTheme();
    } else if (process.platform === 'linux') {
      // Try KDE first (kdeglobals)
      theme = getKdeTheme();
      
      // If not KDE, try GTK (gsettings)
      if (!theme) {
        theme = getGtkTheme();
      }

      // If not GTK, try bare WMs (Xresources, XDG Portal)
      if (!theme) {
        theme = getBareTheme();
      }
    }
  } catch (e) {
    console.error('[os-theme-colors] Failed to extract native theme:', e);
  }

  // Final validation and fallback
  if (!theme || !theme.bg || !theme.surface) {
    theme = getFallbackTheme();
  }

  // Ensure accent color is always populated via dependency if missing
  if (!theme.accent) {
    try {
      const c = accentColor.get();
      if (c && c.hex) {
        theme.accent = c.hex;
      } else {
        theme.accent = '#8b5cf6';
      }
    } catch (e) {
      theme.accent = '#8b5cf6';
    }
  }

  return theme;
}

module.exports = { getThemeColors };
