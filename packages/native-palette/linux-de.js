const { execSync } = require('child_process');

// Standard well-known GTK theme palettes
const palettes = {
  // GNOME standard (Adwaita)
  'adwaita-dark': {
    bg: '#242424', sidebar: '#1e1e1e', surface: '#303030', surfaceHover: '#3c3c3c',
    text: '#ffffff', muted: '#9a9996', border: '#1e1e1e', accent: '#3584e4'
  },
  'adwaita': {
    bg: '#fafafa', sidebar: '#f0f0f0', surface: '#ffffff', surfaceHover: '#f5f5f5',
    text: '#000000', muted: '#77767b', border: '#e6e6e6', accent: '#3584e4'
  },
  // Ubuntu standard (Yaru)
  'yaru-dark': {
    bg: '#1e1e1e', sidebar: '#111111', surface: '#2d2d2d', surfaceHover: '#3d3d3d',
    text: '#f7f7f7', muted: '#b3b3b3', border: '#1e1e1e', accent: '#e95420'
  },
  // Linux Mint standard (Mint-Y-Dark)
  'mint-y-dark': {
    bg: '#2f3032', sidebar: '#2a2b2d', surface: '#383a3c', surfaceHover: '#424446',
    text: '#dfdfdf', muted: '#a0a0a0', border: '#252627', accent: '#62a05f'
  },
  // Pop!_OS standard
  'pop-dark': {
    bg: '#333132', sidebar: '#292728', surface: '#413e3f', surfaceHover: '#4d4a4b',
    text: '#f2f2f2', muted: '#b0afb0', border: '#292728', accent: '#f6d32d'
  }
};

function getGtkTheme() {
  try {
    let themeName = '';
    try {
      themeName = execSync('gsettings get org.gnome.desktop.interface gtk-theme', { stdio: 'pipe' }).toString().trim().replace(/'/g, '').toLowerCase();
    } catch(e) {}

    let colorScheme = '';
    try {
      colorScheme = execSync('gsettings get org.gnome.desktop.interface color-scheme', { stdio: 'pipe' }).toString().trim().replace(/'/g, '');
    } catch(e) {}

    // Match exact theme first
    for (const [key, palette] of Object.entries(palettes)) {
      if (themeName.includes(key)) {
        return palette;
      }
    }

    // Generic match
    if (colorScheme === 'prefer-dark' || themeName.includes('dark')) {
      return palettes['adwaita-dark'];
    } else if (colorScheme === 'prefer-light' || themeName) {
      return palettes['adwaita'];
    }

    return null;
  } catch (e) {
    return null;
  }
}

module.exports = getGtkTheme;
