/**
 * src/scripts/core/server/turn-auth.js
 * Handles dynamic TURN server credential generation
 */

const crypto = require('crypto');

module.exports = function(app) {
  app.get("/api/turn", (req, res) => {
    const iceServers = [];

    // ── Custom STUN server (optional) ───────────────────────────────────────
    if (process.env.STUN_URL) {
      iceServers.push({ urls: process.env.STUN_URL });
    }

    // ── Custom TURN server (optional) ───────────────────────────────────────
    if (process.env.TURN_URL) {
      const entry = { urls: [] };
      entry.urls.push(process.env.TURN_URL);
      if (process.env.TURN_URL_TLS) entry.urls.push(process.env.TURN_URL_TLS);
      
      if (process.env.TURN_SECRET) {
        // Use TURN REST API to generate time-limited (24 hour) credentials
        const unixTimeStamp = Math.floor(Date.now() / 1000) + 24 * 3600;
        const usernameBase = process.env.TURN_USERNAME || 'nearcade';
        entry.username = `${unixTimeStamp}:${usernameBase}`;
        
        const hmac = crypto.createHmac('sha1', process.env.TURN_SECRET);
        hmac.update(entry.username);
        entry.credential = hmac.digest('base64');
      } else {
        // Fallback to static credentials if secret is not provided
        if (process.env.TURN_USERNAME) entry.username = process.env.TURN_USERNAME;
        if (process.env.TURN_CREDENTIAL) entry.credential = process.env.TURN_CREDENTIAL;
      }
      iceServers.push(entry);
    }

    // ── Legacy Metered.ca env vars (backward compat) ────────────────────────
    if (!process.env.TURN_URL && process.env.METERED_TURN_URL) {
      iceServers.push({
        urls: [
          process.env.METERED_TURN_URL,
          process.env.METERED_TURN_URL_SECURE || ''
        ].filter(Boolean),
        username: process.env.METERED_TURN_USERNAME || 'openrelayproject',
        credential: process.env.METERED_TURN_CREDENTIAL || 'openrelayproject'
      });
    }

    // Return null if nothing is configured — clients will use their built-in STUN pool
    if (iceServers.length === 0) return res.json(null);
    res.json(iceServers.length === 1 ? iceServers[0] : iceServers);
  });
};
