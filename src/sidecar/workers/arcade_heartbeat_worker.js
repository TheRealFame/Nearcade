/**
 * arcade_heartbeat_worker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker thread for arcade session heartbeats and Pusher channel sync.
 *
 * Owns:
 *   • Periodic ping to keep the Pusher private-arcade-global channel alive.
 *   • Re-broadcasting the active session list to Pusher on a configurable interval
 *     so late-joining arcade clients on remote pages stay in sync.
 *
 * IPC contract (parentPort messages):
 *
 *   ← main thread sends:
 *     { type: 'session-active',  session: object }  → track new session + broadcast
 *     { type: 'session-stopped', id: string }       → remove session + broadcast
 *     { type: 'sessions-sync',   sessions: array }  → replace full session list
 *     { type: 'stop' }                              → clear intervals and exit cleanly
 *
 *   → worker posts back to main thread:
 *     { type: 'log',    message: string }
 *     { type: 'error',  message: string }
 *     { type: 'pusher-trigger', event: string, data: object }
 *       ↑ Main thread must call globalArcadeChannel.trigger(event, data) on receipt,
 *         because pusher-js channels must live on the same thread as the socket.
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) { parentPort.postMessage({ type: 'log',   message: `[arcade_heartbeat] ${msg}` }); }
function err(msg) { parentPort.postMessage({ type: 'error', message: `[arcade_heartbeat] ${msg}` }); }

function pusherTrigger(event, data) {
  parentPort.postMessage({ type: 'pusher-trigger', event, data });
}

// ── State ─────────────────────────────────────────────────────────────────────
const arcadeSessions = new Map();   // sessionId → session object

// ── Configuration ─────────────────────────────────────────────────────────────
// How often (ms) to re-broadcast the session list to Pusher for late-joiners.
const SYNC_INTERVAL_MS  = (workerData && workerData.syncIntervalMs)  || 30_000;
// How often (ms) to send a lightweight keepalive ping on the Pusher channel.
const PING_INTERVAL_MS  = (workerData && workerData.pingIntervalMs)  || 25_000;

// ── Intervals ─────────────────────────────────────────────────────────────────
let syncTimer = null;
let pingTimer = null;

function startIntervals() {
  // Keepalive ping — prevents Pusher from timing out the private channel
  pingTimer = setInterval(() => {
    if (arcadeSessions.size > 0) {
      pusherTrigger('client-heartbeat', { ts: Date.now() });
      log(`Heartbeat ping sent (${arcadeSessions.size} active session(s))`);
    }
  }, PING_INTERVAL_MS);

  // Full session re-sync — catches any viewers that missed the initial broadcast
  syncTimer = setInterval(() => {
    if (arcadeSessions.size === 0) return;
    const sessions = [...arcadeSessions.values()];
    pusherTrigger('client-sessions-sync', { sessions });
    log(`Periodic Pusher sync sent (${sessions.length} session(s))`);
  }, SYNC_INTERVAL_MS);

  log(`Intervals started — ping every ${PING_INTERVAL_MS}ms, sync every ${SYNC_INTERVAL_MS}ms`);
}

function stopIntervals() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  log('Intervals cleared.');
}

// ── Message dispatcher ─────────────────────────────────────────────────────────
parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {

      case 'session-active': {
        const { session } = msg;
        if (!session || !session.id) { err('session-active: missing session.id'); break; }
        arcadeSessions.set(session.id, session);
        pusherTrigger('client-session-active', { session });
        log(`Session registered: ${session.game} (id=${session.id})`);

        // Start intervals the moment the first session goes live
        if (arcadeSessions.size === 1) startIntervals();
        break;
      }

      case 'session-stopped': {
        const { id } = msg;
        if (arcadeSessions.has(id)) {
          arcadeSessions.delete(id);
          pusherTrigger('client-session-stopped', { id });
          log(`Session stopped: id=${id}`);
        }
        // Stop intervals once no sessions remain — saves battery/CPU
        if (arcadeSessions.size === 0) stopIntervals();
        break;
      }

      case 'sessions-sync': {
        // Full authoritative replacement (e.g. after server restart)
        arcadeSessions.clear();
        if (Array.isArray(msg.sessions)) {
          msg.sessions.forEach(s => arcadeSessions.set(s.id, s));
          log(`Full sync: ${arcadeSessions.size} session(s) loaded`);
        }
        // Restart intervals to match new state
        stopIntervals();
        if (arcadeSessions.size > 0) startIntervals();
        break;
      }

      case 'stop': {
        stopIntervals();
        log('Shutdown requested — exiting.');
        process.exit(0);
      }

      default:
        err(`Unknown message type: ${msg.type}`);
    }
  } catch (e) {
    err(`Unhandled error processing '${msg.type}': ${e.message}`);
  }
});

log('Worker thread started.');
