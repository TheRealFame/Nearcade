/**
 * Centralized ICE Server Configuration
 * Single source of truth for all STUN/TURN servers across the codebase.
 * 
 * Import in Node.js: const { STUN_SERVERS, buildIceServers } = require('./ice-servers');
 * Import in ES Modules: import { STUN_SERVERS, buildIceServers } from './ice-servers.js';
 * Import in Python: read this file or use the generated JSON
 */

// STUN Servers — kept to 3. Chrome slows ICE discovery badly with 5+
// servers, and every extra STUN adds gathering latency to every offer.
export const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

// Python/backend format (stun:// instead of stun:)
export const STUN_SERVERS_PYTHON = STUN_SERVERS.map(s => s.replace('stun:', 'stun://'));

// Community TURN servers — DISABLED by default (2026-09-16).
// Every entry below was observed returning ICE 701 (unreachable) in production:
// openrelay.metered.ca free tier is rate-limited/dead, numb.viagenie.ca has been
// dead for years, and turn:cloudflare.com:3478 accepts no guest logins.
// Dead TURN entries don't just fail — each one burns gathering time and fires
// 701 errors, which is what stretched viewer connects to 4+ offers. Real TURN
// still comes from /api/turn (TURN_SECRET) and the live-probed
// config/community-turn-servers.json ladder. Entries stay here (enabled:false)
// so the dashboard can still offer them as explicit opt-in picks.
export const COMMUNITY_TURN_SERVERS = [
  {
    name: 'Metered.ca TURN (TCP)',
    url: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
    enabled: false
  },
  {
    name: 'Metered.ca TURN (UDP)',
    url: 'turn:openrelay.metered.ca:3478?transport=udp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
    enabled: false
  },
  {
    name: 'Cloudflare TURN',
    url: 'turn:cloudflare.com:3478?transport=udp',
    username: 'guest',
    credential: 'guest',
    enabled: false
  },
  {
    name: 'Google TURN',
    url: 'turn:numb.viagenie.ca:3478?transport=udp',
    username: 'webrtc@live.com',
    credential: 'muazkh',
    enabled: false
  }
];

// Build ICE server array for RTCPeerConnection
export function buildIceServers(turnServers = []) {
  // Accept a single {urls,...} object too (/api/turn returns one object when
  // only a single TURN is configured). Previously a lone object was silently
  // dropped here AND re-added by callers, which invited duplicate entries.
  if (!Array.isArray(turnServers)) {
    turnServers = turnServers ? [turnServers] : [];
  }
  const iceServers = [];
  const seen = new Set();
  const push = (entry) => {
    const key = JSON.stringify(entry.urls || entry.url || '');
    if (seen.has(key)) return;
    seen.add(key);
    iceServers.push(entry);
  };
  
  // Tier 1: STUN servers
  for (const url of STUN_SERVERS) {
    push({ urls: url });
  }
  
  // Tier 2: Community TURN servers (default fallback)
  for (const turn of COMMUNITY_TURN_SERVERS) {
    if (turn && turn.enabled && turn.url) {
      const entry = { urls: turn.url };
      if (turn.username) entry.username = turn.username;
      if (turn.credential) entry.credential = turn.credential;
      push(entry);
    }
  }
  
  // Tier 3: Custom/configured TURN servers (if provided)
  for (const turn of turnServers) {
    if (turn && (turn.urls || turn.url)) {
      const entry = { urls: turn.urls || turn.url };
      if (turn.username) entry.username = turn.username;
      if (turn.credential) entry.credential = turn.credential;
      push(entry);
    }
  }
  
  return iceServers;
}

// Get STUN-only ICE servers
export function getStunOnlyIceServers() {
  return STUN_SERVERS.map(url => ({ urls: url }));
}

// Node.js / CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STUN_SERVERS,
    STUN_SERVERS_PYTHON,
    COMMUNITY_TURN_SERVERS,
    buildIceServers,
    getStunOnlyIceServers,
  };
}

// Browser global for non-module scripts
if (typeof window !== 'undefined') {
  window.ICE_SERVERS_API = {
    STUN_SERVERS,
    STUN_SERVERS_PYTHON,
    COMMUNITY_TURN_SERVERS,
    buildIceServers,
    getStunOnlyIceServers,
  };
}