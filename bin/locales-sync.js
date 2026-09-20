/**
 * bin/locales-sync.js — keep locale files aligned with en.json key order.
 *
 * Autotranslate services rewrite whole files and scramble key order, which
 * makes human review/diffing miserable (runtime doesn't care: lookup is
 * per-key with English fallback). Run this instead of hand-sorting:
 *
 *   node bin/locales-sync.js           # rewrite fr/de/es/ja/pt in en order
 *   node bin/locales-sync.js --check   # exit 1 if any file is misordered
 *
 * Rules: keys follow en.json order, existing translations untouched,
 * missing keys stay absent (English fallback covers them — report lists
 * them for translators), extra keys are preserved at the end.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets', 'locales');
const LANGS = ['fr', 'de', 'es', 'ja', 'pt'];

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
}

function audit() {
  const en = load('en');
  const enKeys = Object.keys(en);
  const report = [];
  for (const lang of LANGS) {
    let dict;
    try {
      dict = load(lang);
    } catch (e) {
      report.push({ lang, error: String(e.message || e) });
      continue;
    }
    const keys = Object.keys(dict);
    const missing = enKeys.filter((k) => !(k in dict));
    const extra = keys.filter((k) => !enKeys.includes(k));
    const ordered = keys.filter((k) => k in en);
    const wantOrder = enKeys.filter((k) => k in dict);
    report.push({
      lang,
      keys: keys.length,
      missing,
      extra,
      ordered: JSON.stringify(ordered) === JSON.stringify(wantOrder),
    });
  }
  return { enKeys, report };
}

function sync() {
  const { enKeys, report } = audit();
  const en = load('en');
  for (const r of report) {
    if (r.error) {
      console.log(`${r.lang}: SKIPPED (${r.error})`);
      continue;
    }
    const dict = load(r.lang);
    const out = {};
    for (const k of enKeys) {
      if (k in dict) out[k] = dict[k];
    }
    for (const k of r.extra) out[k] = dict[k];
    fs.writeFileSync(path.join(DIR, r.lang + '.json'), JSON.stringify(out, null, 2) + '\n');
    console.log(
      `${r.lang}: reordered ${r.keys} keys` +
      (r.missing.length ? `, MISSING (left for translators): ${r.missing.join(', ')}` : ', complete') +
      (r.extra.length ? `, kept ${r.extra.length} extra at end` : '')
    );
  }
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const { report } = audit();
    let bad = 0;
    for (const r of report) {
      if (r.error || !r.ordered || r.missing.length || r.extra.length) {
        bad++;
        console.log(
          `${r.lang}: ` +
          (r.error ? `ERROR ${r.error}` : `ordered=${r.ordered} missing=[${r.missing.join(',')}] extra=[${r.extra.join(',')}]`)
        );
      } else {
        console.log(`${r.lang}: ok`);
      }
    }
    process.exit(bad ? 1 : 0);
  } else {
    sync();
  }
}

module.exports = { audit };
