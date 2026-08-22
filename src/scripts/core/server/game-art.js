/**
 * src/scripts/core/server/game-art.js
 * Express endpoint for caching and serving Steam game art
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const gameArtCacheDir = path.join(os.homedir(), '.cache', 'Nearcade', 'game-art');
const GAME_ART_MAX_MB = 200;

function evictGameArtCache() {
  try {
    const files = fs.readdirSync(gameArtCacheDir).map(f => {
      const fp = path.join(gameArtCacheDir, f);
      const s = fs.statSync(fp);
      return { fp, mtime: s.mtimeMs, size: s.size };
    }).sort((a, b) => a.mtime - b.mtime); // oldest first
    let totalBytes = files.reduce((s, f) => s + f.size, 0);
    const limitBytes = GAME_ART_MAX_MB * 1024 * 1024;
    for (const f of files) {
      if (totalBytes <= limitBytes) break;
      try { fs.unlinkSync(f.fp); totalBytes -= f.size; } catch (_) {}
    }
  } catch (_) {}
}

module.exports = function(app) {
  app.get("/api/game-art/:appId", (req, res) => {
    const { appId } = req.params;
    if (!/^\d+$/.test(appId)) return res.status(400).end();
    fs.mkdirSync(gameArtCacheDir, { recursive: true });
    const cachePath = path.join(gameArtCacheDir, appId + '.jpg');
    if (fs.existsSync(cachePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(cachePath);
    }
    const urls = [
      `https://shared.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
      `https://steamcdn-a.akamaihd.net/steam/apps/${appId}/header.jpg`,
    ];
    let idx = 0;
    function tryFetch() {
      if (idx >= urls.length) return res.status(404).end();
      const url = urls[idx++];
      https.get(url, (resp) => {
        if (resp.statusCode !== 200) { resp.resume(); return tryFetch(); }
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          const buf = Buffer.concat(chunks);
          fs.writeFileSync(cachePath, buf);
          evictGameArtCache(); // trim oldest files if over 200MB
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.sendFile(cachePath);
        });
      }).on('error', tryFetch);
    }
    tryFetch();
  });
};
