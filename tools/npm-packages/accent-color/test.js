const accent = require('./index.js');

const result = accent.get();
if (result) {
  console.log(`Platform: ${accent.platform}`);
  console.log(`Accent:   ${result.hex}`);
  console.log(`RGB:      ${result.rgb.r}, ${result.rgb.g}, ${result.rgb.b}`);
  console.log(`HSL:      ${result.hsl.h}°, ${result.hsl.s}%, ${result.hsl.l}%`);
  if (result.preset) console.log(`Preset:   ${result.preset}`);
} else {
  console.log(`Platform ${accent.platform} is not supported yet`);
}

accent.getAsync().then(r => {
  if (r) console.log(`Async:    ${r.hex}`);
});
