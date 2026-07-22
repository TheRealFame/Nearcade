const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function parseXresources() {
  const xresPath = path.join(os.homedir(), '.Xresources');
  if (!fs.existsSync(xresPath)) return null;

  try {
    const raw = fs.readFileSync(xresPath, 'utf-8');
    const colors = {};
    const lines = raw.split('\n');

    for (const line of lines) {
      if (line.startsWith('!') || !line.includes(':')) continue;
      const parts = line.split(':');
      const key = parts[0].trim().toLowerCase();
      const val = parts[1].trim();

      if (key.includes('background') && !colors.bg) colors.bg = val;
      if (key.includes('foreground') && !colors.text) colors.text = val;
      if (key.includes('color8') || key.includes('color 8')) colors.muted = val; // Typically bright black / gray
      if (key.includes('color4') || key.includes('color 4')) colors.accent = val; // Blue is often used as accent
    }

    if (colors.bg && colors.text) {
      // Derive surfaces if bare minimum found
      colors.sidebar = colors.bg;
      colors.surface = colors.bg;
      colors.surfaceHover = colors.bg;
      colors.border = colors.muted || '#444444';
      if (!colors.accent) colors.accent = '#8b5cf6'; // Generic fallback
      return colors;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function getBareTheme() {
  try {
    // 1. Try XDG Desktop Portal for color-scheme (used by modern bare WMs like Sway)
    try {
      const scheme = execSync('dbus-send --print-reply=literal --dest=org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop org.freedesktop.portal.Settings.Read string:"org.freedesktop.appearance" string:"color-scheme"', { stdio: 'pipe' }).toString().trim();
      if (scheme.includes('1')) { // 1 = Dark
        return {
          bg: '#1e1e1e', sidebar: '#1a1a1a', surface: '#252526', surfaceHover: '#333333',
          text: '#ffffff', muted: '#888888', border: '#333333', accent: '#8b5cf6'
        };
      }
    } catch(e) {}

    // 2. Try .Xresources
    const xTheme = parseXresources();
    if (xTheme) return xTheme;

    // 3. Fail gracefully
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = getBareTheme;
