const { execFileSync } = require('child_process');

function get() {
  try {
    const out = execFileSync('dbus-send', [
      '--session', '--print-reply',
      '--dest=org.freedesktop.portal.Desktop',
      '/org/freedesktop/portal/desktop',
      'org.freedesktop.portal.Settings.ReadOne',
      'string:org.freedesktop.appearance',
      'string:accent-color',
    ], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

    const doubles = [...out.matchAll(/double\s+([\d.]+)/g)];
    if (doubles.length >= 3) {
      const r = Math.round(parseFloat(doubles[0][1]) * 255);
      const g = Math.round(parseFloat(doubles[1][1]) * 255);
      const b = Math.round(parseFloat(doubles[2][1]) * 255);
      return color(r, g, b);
    }
  } catch {}

  try {
    const out = execFileSync('gsettings', [
      'get', 'org.gnome.desktop.interface', 'accent-color'
    ], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const name = out.trim().replace(/'/g, '');
    const gnome = GNOME_COLORS[name];
    if (gnome) return color(gnome.r, gnome.g, gnome.b, gnome.name);
  } catch {}

  try {
    const out = execFileSync('gsettings', [
      'get', 'org.gnome.desktop.interface', 'gtk-theme'
    ], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (out.toLowerCase().includes('dark')) {
      return color(0x99, 0x99, 0x99, 'default-dark');
    }
  } catch {}

  try {
    const out = execFileSync('kreadconfig5', [
      '--file', 'kdeglobals', '--group', 'General', '--key', 'AccentColor'
    ], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const parts = out.trim().split(',').map(Number);
    if (parts.length >= 3 && parts.every(n => !isNaN(n))) {
      return color(parts[0], parts[1], parts[2]);
    }
  } catch {}

  return getFallback();
}

const GNOME_COLORS = {
  blue:   { r: 53,  g: 132, b: 228, name: 'blue' },
  teal:   { r: 25,  g: 162, b: 155, name: 'teal' },
  green:  { r: 51,  g: 171, b: 80,  name: 'green' },
  yellow: { r: 242, g: 185, b: 53,  name: 'yellow' },
  orange: { r: 245, g: 135, b: 31,  name: 'orange' },
  red:    { r: 207, g: 73,  b: 73,  name: 'red' },
  purple: { r: 130, g: 90,  b: 209, name: 'purple' },
  pink:   { r: 222, g: 82,  b: 150, name: 'pink' },
  slate:  { r: 120, g: 120, b: 130, name: 'slate' },
  default: { r: 53, g: 132, b: 228, name: 'blue' },
};

function getFallback() {
  return color(0x8b, 0x5c, 0xf6);
}

function color(r, g, b, name) {
  const h = (v) => v.toString(16).padStart(2, '0');
  const hex = `#${h(r)}${h(g)}${h(b)}`;
  return { hex, rgb: { r, g, b }, hsl: rgbToHsl(r, g, b), preset: name || null };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    switch (mx) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

module.exports = { get };
