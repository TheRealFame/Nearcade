const { execFileSync } = require('child_process');

function get() {
  try {
    const out = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent',
      '/v', 'AccentColor'
    ], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

    const match = out.match(/AccentColor\s+REG_DWORD\s+0x([0-9a-fA-F]{6})/);
    if (!match) {
      return getFallback();
    }

    const abgr = parseInt(match[1], 16);
    const b = (abgr >> 16) & 0xff;
    const g = (abgr >> 8) & 0xff;
    const r = abgr & 0xff;

    return color(r, g, b);
  } catch {
    return getFallback();
  }
}

async function getAsync() {
  return get();
}

function getFallback() {
  return color(0x8b, 0x5c, 0xf6);
}

function color(r, g, b) {
  const h = (v) => v.toString(16).padStart(2, '0');
  const hex = `#${h(r)}${h(g)}${h(b)}`;
  return { hex, rgb: { r, g, b }, hsl: rgbToHsl(r, g, b) };
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

module.exports = { get, getAsync };
