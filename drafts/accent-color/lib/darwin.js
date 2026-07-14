const { execFileSync } = require('child_process');

const PRESET_COLORS = {
  [-1]: { r: 142, g: 142, b: 147, name: 'graphite' },
  [0]:  { r: 255, g: 59,  b: 48,  name: 'red' },
  [1]:  { r: 255, g: 149, b: 0,   name: 'orange' },
  [2]:  { r: 255, g: 204, b: 0,   name: 'yellow' },
  [3]:  { r: 52,  g: 199, b: 89,  name: 'green' },
  [4]:  { r: 0,   g: 122, b: 255, name: 'blue' },
  [5]:  { r: 175, g: 82,  b: 222, name: 'purple' },
  [6]:  { r: 255, g: 45,  b: 85,  name: 'pink' },
};

function get() {
  try {
    const out = execFileSync('defaults', ['read', '-g', 'AppleAccentColor'], {
      encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
    });
    const preset = parseInt(out.trim(), 10);
    if (preset in PRESET_COLORS) {
      const c = PRESET_COLORS[preset];
      return color(c.r, c.g, c.b, c.name);
    }
  } catch {}

  try {
    const out = execFileSync('defaults', ['read', '-g', 'AppleAquaColorVariant'], {
      encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
    });
    const variant = parseInt(out.trim(), 10);
    if (variant === 6) {
      return PRESET_COLORS[4]; // Blue default
    }
  } catch {}

  return getFallback();
}

function getFallback() {
  const c = PRESET_COLORS[4];
  return color(c.r, c.g, c.b, c.name);
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
