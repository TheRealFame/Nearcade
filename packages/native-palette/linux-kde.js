const fs = require('fs');
const os = require('os');
const path = require('path');
const ini = require('ini');

function parseRgbToHex(rgbStr) {
  if (!rgbStr) return null;
  const parts = rgbStr.split(',').map(n => parseInt(n.trim(), 10));
  if (parts.length >= 3 && !parts.some(isNaN)) {
    return '#' + parts.slice(0, 3).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function getKdeTheme() {
  try {
    const kdeglobalsPath = path.join(os.homedir(), '.config', 'kdeglobals');
    if (!fs.existsSync(kdeglobalsPath)) return null;

    const raw = fs.readFileSync(kdeglobalsPath, 'utf-8');
    const config = ini.parse(raw);

    const colors = {};

    if (config['Colors:Window']) {
      colors.bg = parseRgbToHex(config['Colors:Window'].BackgroundNormal);
      colors.text = parseRgbToHex(config['Colors:Window'].ForegroundNormal);
      colors.muted = parseRgbToHex(config['Colors:Window'].ForegroundInactive);
    }
    
    if (config['Colors:View']) {
      colors.sidebar = parseRgbToHex(config['Colors:View'].BackgroundNormal);
      colors.border = parseRgbToHex(config['Colors:View'].BackgroundAlternate); // Or Window Alternate
    }

    if (config['Colors:Button']) {
      colors.surface = parseRgbToHex(config['Colors:Button'].BackgroundNormal);
      colors.surfaceHover = parseRgbToHex(config['Colors:Button'].BackgroundAlternate);
    }

    if (config['Colors:Selection']) {
      colors.accent = parseRgbToHex(config['Colors:Selection'].BackgroundNormal);
    }

    // Filter out nulls and see if we have enough colors
    const hasTheme = colors.bg && colors.surface;
    if (hasTheme) {
      // Fallbacks within the theme if anything is missing
      if (!colors.sidebar) colors.sidebar = colors.bg;
      if (!colors.surfaceHover) colors.surfaceHover = colors.surface;
      if (!colors.text) colors.text = '#ffffff';
      if (!colors.muted) colors.muted = '#888888';
      if (!colors.border) colors.border = colors.surface;

      return colors;
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = getKdeTheme;
