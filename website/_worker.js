const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function isUrl(v) {
  return typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://"));
}

function sanitizeString(str, maxLen = 100) {
  if (typeof str !== "string") return "";
  return str.replace(/[<>"'`]/g, "").trim().substring(0, maxLen);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const clientIP = request.headers.get("cf-connecting-ip") || "unknown";

      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

      // Discoverable API index
      if (url.pathname === "/api") {
        return json({
          title: "Nearcade API",
          endpoints: {
            health: "GET /api/health",
            arcade_session_list: "GET /api/arcade/sessions",
            webhook_register: "POST /api/webhooks/register { url }",
            webhook_unregister: "POST /api/webhooks/unregister { id, secret }",
            mod: "GET|POST /api/mod (Bearer auth)",
            stub: "POST /api/arcade/ping — host session registration (private)",
          },
          note: "POST /api/webhooks/register with { url } to subscribe to session START/STOP events. Unregister with your { id, secret }."
        });
      }

      // Webhook endpoint (POST from hosts; don't confuse with webhooks API)
      if (url.pathname === "/api/webhooks" && request.method === "GET") {
        return json({
          register: "POST /api/webhooks/register  { url }",
          unregister: "POST /api/webhooks/unregister { id, secret }"
        });
      }

      // Health
      if (url.pathname === "/api/health") {
        return json({ status: "ok", ip: clientIP });
      }

      // Ban check for all requests (whitelist bypasses ban)
      if (env.BANS_KV && clientIP !== "unknown") {
        try {
          const isWhitelisted = await env.BANS_KV.get(`wl_${clientIP}`);
          if (!isWhitelisted) {
            const isBanned = await env.BANS_KV.get(`ban_${clientIP}`);
            if (isBanned) return json({ error: "BANNED" }, 403);
          }
        } catch (_) {}
      }

      // Pusher Auth
      if (url.pathname === "/api/pusher-auth") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
        if (!env.PUSHER_SECRET || !env.PUSHER_KEY) return json({ error: "Server config error: Pusher secrets missing" }, 500);
        try {
          const text = await request.text();
          const params = new URLSearchParams(text);
          const socketId = params.get("socket_id");
          const channelName = params.get("channel_name");
          if (!socketId || !channelName) return new Response("Missing socket_id/channel_name", { status: 400, headers: CORS });

          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey("raw", encoder.encode(env.PUSHER_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${socketId}:${channelName}`));
          const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
          return json({ auth: `${env.PUSHER_KEY}:${sigHex}` });
        } catch (e) {
          console.error("[Worker] Pusher Auth Error:", e.message);
          return json({ error: e.message }, 500);
        }
      }

      // Arcade Ping (session start from host)
      if (url.pathname === "/api/arcade/ping") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
        try {
          const session = await request.json();
          if (!session?.id) return new Response("Missing session ID", { status: 400, headers: CORS });
          if (session.inputOnly) return json({ error: "Input Only mode cannot be listed on the public Arcade." }, 403);
          
          if (env.BANS_KV && clientIP !== "unknown") {
            const rlKey = `rl_${clientIP}`;
            const lastReq = await env.BANS_KV.get(rlKey);
            if (lastReq && Date.now() - parseInt(lastReq) < 10000) {
              return json({ error: "Too Many Requests. Please wait 10 seconds between pings." }, 429);
            }
            await env.BANS_KV.put(rlKey, Date.now().toString(), { expirationTtl: 60 });
          }

          // Accept structured player counts; fall back to parsing region string
          let players = parseInt(session.players) || 1;
          let maxPlayers = parseInt(session.maxPlayers) || parseInt(session.region) || 4;
          if (isNaN(players) || players < 1) players = 1;
          if (isNaN(maxPlayers) || maxPlayers < 1) maxPlayers = 4;
          maxPlayers = Math.min(16, Math.max(1, maxPlayers));
          players = Math.min(maxPlayers, Math.max(1, players));
          session.region = `${players}/${maxPlayers} Players`;
          session.players = players;
          session.maxPlayers = maxPlayers;

          // Sanitize all host-provided metadata to prevent injection attacks
          session.game = sanitizeString(session.game, 150);
          session.hostName = sanitizeString(session.hostName, 50);
          session.hostRegion = sanitizeString(session.hostRegion, 20);
          session.region = sanitizeString(session.region, 20);
          session.os = sanitizeString(session.os, 30);
          session.codec = sanitizeString(session.codec, 30);
          session.codecType = sanitizeString(session.codecType, 30);
          session.category = sanitizeString(session.category, 50);
          session.version = sanitizeString(session.version, 20);
          if (session.themePayload) session.themePayload = sanitizeString(session.themePayload, 500);
          if (session.accentColor) session.accentColor = sanitizeString(session.accentColor, 20);
          if (session.thumbnail && !isUrl(session.thumbnail)) session.thumbnail = undefined;

          // Whitelist tunnel domains to prevent webhook spam from arbitrary URLs
          if (session.url) {
            const allowedDomains = /\.(trycloudflare\.com|lhr\.life|serveo\.net|bore\.pub|ngrok(?:-free)?\.app|playit\.gg|share\.zrok\.io)$/i;
            if (!allowedDomains.test(new URL(session.url).hostname)) {
              console.log(`[Worker] Rejected ping with disallowed domain: ${session.url}`);
              return new Response("Forbidden", { status: 403, headers: CORS });
            }
          }

if (env.BANS_KV) {
            // Deduplicate rapid pings (arcade.js clients proxy pings to worker)
            const pingHash = `${session.id}_${session.players || 0}`;
            const lastDedup = await env.BANS_KV.get(`pingdedup_${session.id}`);
            if (lastDedup === pingHash) {
              // Same ping data — skip KV write, but still check role pings + webhooks
            } else {
              await env.BANS_KV.put(`pingdedup_${session.id}`, pingHash, { expirationTtl: 12 });
              await env.BANS_KV.put(`sess_${session.id}`, JSON.stringify(session), { expirationTtl: 120 });
            }

            // Dedup old sessions from the same host (tunnel URL)
            if (session.url) {
              const oldId = await env.BANS_KV.get(`host_sess_${session.url}`);
              if (oldId && oldId !== session.id) {
                await env.BANS_KV.delete(`sess_${oldId}`);
                await env.BANS_KV.delete(`webhook_rep_${oldId}`);
              }
              await env.BANS_KV.put(`host_sess_${session.url}`, session.id, { expirationTtl: 86400 });
            }

            // Deduplicate webhook (only send once per session)
            const already = await env.BANS_KV.get(`webhook_rep_${session.id}`);
            if (!already && env.ARCADE_WEBHOOK) {
              const roleId = env.ARCADE_ROLE_ID || "";
              const thumbnail = isUrl(session.thumbnail) ? { url: session.thumbnail } : undefined;
              const gameTitle = (session.game && !session.game.match(/^(Unknown Game|Arcade Game|Game)$/i)) ? session.game : "🎮 Game";

              // Send initial webhook WITHOUT role ping (session started)
              const embed = {
                title: gameTitle,
                url: session.url,
                color: 0x00ff00,
                description: `**Host:** ${session.hostName || "Unknown"}\n**Region:** ${session.hostRegion || "?"}\n**Players:** ${session.region || "?"}`,
                fields: [
                  { name: "OS", value: session.os || "?", inline: true },
                  { name: "Codec", value: `${session.codec || "?"} (${session.codecType || "WebRTC"})`, inline: true },
                  { name: "Category", value: session.category || "General", inline: true }
                ],
                thumbnail,
                footer: { text: `Nearcade v${session.version || "3.0.2"}` },
                timestamp: new Date().toISOString()
              };
              const initalPayload = { embeds: [embed], username: "Nearcade Arcade", avatar_url: "https://nearcade.cutefame.net/favicon.ico" };
              await fetch(env.ARCADE_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(initalPayload) }).catch(() => {});

              // Schedule role ping after 15 minutes if session is still active
              if (roleId) {
                await env.BANS_KV.put(`role_ping_${session.id}`, JSON.stringify({
                  createdAt: Date.now(),
                  roleId: roleId,
                  gameTitle: gameTitle,
                  url: session.url,
                  hostName: session.hostName,
                  hostRegion: session.hostRegion,
                  region: session.region,
                  os: session.os,
                  codec: session.codec,
                  codecType: session.codecType,
                  category: session.category,
                  thumbnail: session.thumbnail,
                  version: session.version
                }), { expirationTtl: 3600 });
              }

              await env.BANS_KV.put(`webhook_rep_${session.id}`, "1", { expirationTtl: 3600 });

            // ── Deliver to user-registered webhooks (session-start) ──────
            if (ctx && env.BANS_KV) {
              const huskList = await env.BANS_KV.list({ prefix: "wh_" });
              for (const key of huskList.keys) {
                try {
                  const raw = await env.BANS_KV.get(key.name);
                  if (raw) {
                    const sub = JSON.parse(raw);
                    const kCount = await env.BANS_KV.get(`kick_${session.id}`);
                    const body = JSON.stringify({
                      type: "session-start",
                      session: { ...session, kickCount: kCount ? parseInt(kCount) : 0 }
                    });
                    ctx.waitUntil((async () => {
                      await fetch(sub.url, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          "X-Nearcade-Event": "session-start"
                        },
                        body,
                        signal: AbortSignal.timeout(6000)
                      });
                    })().catch(() => {}));
                  }
                } catch (_) {}
              }
            }
          }

            // Check for pending role pings that are ready (15 min elapsed)
            if (env.BANS_KV && env.ARCADE_WEBHOOK) {
              try {
                const pendingList = await env.BANS_KV.list({ prefix: "role_ping_" });
                const now = Date.now();
                for (const key of pendingList.keys) {
                  const raw = await env.BANS_KV.get(key.name);
                  if (!raw) continue;
                  const ping = JSON.parse(raw);
                  if (now - (ping.createdAt || 0) >= 15 * 60 * 1000) {
                    // It's been 15 minutes. Check if session is still alive.
                    const sessionId = key.name.replace("role_ping_", "");
                    const isActive = await env.BANS_KV.get(`sess_${sessionId}`);
                    if (isActive) {
                      const embed = {
                        title: ping.gameTitle || "🎮 Game",
                        url: ping.url,
                        color: 0xc084fc,
                        description: `**Host:** ${ping.hostName || "Unknown"}\n**Region:** ${ping.hostRegion || "?"}\n**Players:** ${ping.region || "?"}\n\n⏰ *Session has been running for over 15 minutes!*`,
                        fields: [
                          { name: "OS", value: ping.os || "?", inline: true },
                          { name: "Codec", value: `${ping.codec || "?"} (${ping.codecType || "WebRTC"})`, inline: true },
                          { name: "Category", value: ping.category || "General", inline: true }
                        ],
                        thumbnail: isUrl(ping.thumbnail) ? { url: ping.thumbnail } : undefined,
                        footer: { text: `Nearcade v${ping.version || "3.0.2"} • Role pinged` },
                        timestamp: new Date().toISOString()
                      };
                      const payload = {
                        content: `<@&${ping.roleId}>`,
                        embeds: [embed],
                        username: "Nearcade Arcade",
                        avatar_url: "https://nearcade.cutefame.net/favicon.ico"
                      };
                      await fetch(env.ARCADE_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
                    }
                    await env.BANS_KV.delete(key.name);
                  }
                }
              } catch (_) {}
            }
          }
          return json({ success: true });
        } catch (e) {
          console.error("[Worker] Arcade Ping Error:", e.message);
          return json({ error: e.message }, 500);
        }
      }

      // ── Webhook Registration API ─────────────────────────────────
      if (url.pathname === "/api/webhooks/register") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
        try {
          const body = await request.json();
          if (!body.url || !isUrl(body.url)) return json({ error: "Valid url field (https) is required." }, 400);
          let hookUrl;
          try { hookUrl = new URL(body.url); } catch (_) { return json({ error: "Invalid URL format." }, 400); }
          if (hookUrl.protocol !== "https:") return json({ error: "URL must be https." }, 400);
          const badHosts = /^(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|10\\\\.|172\\\\.(1[6-9]|2[0-9]|3[01])\\\\.|192\\\\.168\\\\.)/i;
          if (badHosts.test(hookUrl.hostname)) return json({ error: "Private/localhost URLs not allowed." }, 400);

          if (env.BANS_KV) {
            const rlKey = `whrl_${clientIP}`;
            const count = parseInt(await env.BANS_KV.get(rlKey) || "0");
            if (count >= 5) return json({ error: "Too many registrations. Try again later." }, 429);
            await env.BANS_KV.put(rlKey, String(count + 1), { expirationTtl: 3600 });
          }

          const id = "w" + crypto.randomUUID().replace(/-/g, "");
          const secretBytes = new Uint8Array(32);
          crypto.getRandomValues(secretBytes);
          const secret = Array.from(secretBytes).map(b => b.toString(16).padStart(2, "0")).join("");
          const record = { url: hookUrl.href, secret, createdAt: Date.now(), ip: clientIP };
          if (env.BANS_KV) {
            await env.BANS_KV.put(`wh_${id}`, JSON.stringify(record), { expirationTtl: 604800 });
            await env.BANS_KV.put(`whsec_${id}`, secret, { expirationTtl: 604800 });
          }
          return json({ id, secret });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      if (url.pathname === "/api/webhooks/unregister") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
        try {
          const body = await request.json();
          if (!body.id || !body.secret) return json({ error: "id and secret required." }, 400);
          if (typeof body.id !== "string" || body.id.length > 64 || typeof body.secret !== "string" || body.secret.length > 128) {
            return json({ error: "Invalid id or secret." }, 400);
          }
          if (env.BANS_KV) {
            const stored = await env.BANS_KV.get(`whsec_${body.id}`);
            if (!stored || stored !== body.secret) return json({ error: "Invalid or expired credentials." }, 403);
            await env.BANS_KV.delete(`wh_${body.id}`);
            await env.BANS_KV.delete(`whsec_${body.id}`);
          }
          return json({ success: true });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      // ── Arcade Volume Relay (host → worker → all registered webhooks) ───
      if (url.pathname === "/api/arcade/volume") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
        try {
          const body = await request.json();
          if (!body || !body.sessionId) return json({ error: "sessionId required" }, 400);
          if (!body.type || !["kick", "volume"].includes(body.type)) return json({ error: "Invalid event type" }, 400);
          if (env.BANS_KV) {
            const sessionId = sanitizeString(String(body.sessionId), 64);
            if (body.type === "kick") {
              const kKey = `kick_${sessionId}`;
              const current = parseInt(await env.BANS_KV.get(kKey) || "0");
              await env.BANS_KV.put(kKey, String(current + 1), { expirationTtl: 3600 });
            }
            if (body.type === "volume") {
              const vol = Math.max(0, Math.min(100, parseInt(body.volume) || 0));
              await env.BANS_KV.put(`vol_${sessionId}`, String(vol), { expirationTtl: 3600 });
            }
          }
          return json({ success: true });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      // ── Arcade Report Relay (server → worker: reports per session, triggers delist) ───
      if (url.pathname === "/api/arcade/report") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
        try {
          const body = await request.json();
          if (!body || !body.sessionId) return json({ error: "sessionId required" }, 400);
          const sessionId = sanitizeString(String(body.sessionId), 64);
          if (env.BANS_KV) {
            const kKey = `report_${sessionId}`;
            const current = parseInt(await env.BANS_KV.get(kKey) || "0");
            const next = current + 1;
            // Store report count with 1-hour TTL
            await env.BANS_KV.put(kKey, String(next), { expirationTtl: 3600 });

            if (next === 3 && body.tunnelUrl) {
              // 3 reports — delist for 10 minutes
              await env.BANS_KV.put(`delist_${sessionId}`, JSON.stringify({
                until: Date.now() + 10 * 60 * 1000,
                reason: 'reported',
                reports: next,
                hostName: sanitizeString(body.hostName || '', 50),
                tunnelUrl: sanitizeString(body.tunnelUrl || '', 200)
              }), { expirationTtl: 900 });
            } else if (next >= 5 && body.tunnelUrl) {
              // 5 reports — delist for 30 minutes
              await env.BANS_KV.put(`delist_${sessionId}`, JSON.stringify({
                until: Date.now() + 30 * 60 * 1000,
                reason: 'reported',
                reports: next,
                hostName: sanitizeString(body.hostName || '', 50),
                tunnelUrl: sanitizeString(body.tunnelUrl || '', 200)
              }), { expirationTtl: 1800 });
            }
          }
          return json({ success: true });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      // List active sessions
      if (url.pathname === "/api/arcade/sessions") {
        const sessions = [];
        if (env.BANS_KV) {
          const list = await env.BANS_KV.list({ prefix: "sess_" });
          for (const key of list.keys) {
            try {
              const val = await env.BANS_KV.get(key.name);
              if (val) {
                const sess = JSON.parse(val);
                const kCount = await env.BANS_KV.get(`kick_${sess.id}`);
                if (kCount) sess.kickCount = parseInt(kCount);
                const rCount = await env.BANS_KV.get(`report_${sess.id}`);
                if (rCount) sess.reportCount = parseInt(rCount);
                const delistRaw = await env.BANS_KV.get(`delist_${sess.id}`);
                if (delistRaw) {
                  try {
                    const delist = JSON.parse(delistRaw);
                    if (Date.now() < delist.until) {
                      sess.delisted = true;
                      sess.delistUntil = delist.until;
                      sess.delistReason = delist.reason;
                      sess.delistReports = delist.reports;
                    }
                  } catch (_) {}
                }
                if (!sess.delisted) sessions.push(sess);
              }
            } catch (_) {}
          }
        }
        return json(sessions);
      }

      // Arcade Stop (session end from host)
      if (url.pathname === "/api/arcade/stop") {
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
        try {
          const { id } = await request.json();
          if (!id) return new Response("Missing session ID", { status: 400, headers: CORS });
          if (env.BANS_KV) {
            let stoppedSession = null;
            const existing = await env.BANS_KV.get(`sess_${id}`);
            if (existing) {
              stoppedSession = JSON.parse(existing);
              if (stoppedSession.url) await env.BANS_KV.delete(`host_sess_${stoppedSession.url}`);
            }
            await env.BANS_KV.delete(`sess_${id}`);
            await env.BANS_KV.delete(`webhook_rep_${id}`);

            if (ctx && stoppedSession) {
              const huskList = await env.BANS_KV.list({ prefix: "wh_" });
              for (const key of huskList.keys) {
                try {
                  const raw = await env.BANS_KV.get(key.name);
                  if (raw) {
                    const sub = JSON.parse(raw);
                    const body = JSON.stringify({ type: "session-stop", session: stoppedSession });
                    ctx.waitUntil((async () => {
                      await fetch(sub.url, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          "X-Nearcade-Event": "session-stop"
                        },
                        body,
                        signal: AbortSignal.timeout(6000)
                      });
                    })().catch(() => {}));
                  }
                } catch (_) {}
              }
            }
          }
          return json({ success: true });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      }

      // Mod API (ban/unban/list with auth)
      if (url.pathname === "/api/mod") {
        const auth = request.headers.get("Authorization") || "";
        if (auth !== `Bearer ${env.MOD_SECRET_TOKEN}`) return json({ message: "Unauthorized" }, 401);

        if (request.method === "GET") {
          // List all banned IPs
          const bans = [];
          if (env.BANS_KV) {
            const list = await env.BANS_KV.list({ prefix: "ban_" });
            for (const key of list.keys) {
              try {
                const val = await env.BANS_KV.get(key.name);
                if (val) bans.push({ ip: key.name.slice(4), ...JSON.parse(val) });
              } catch (_) {}
            }
          }
          return json(bans);
        }

        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const { action, ipToBan, ipToUnban } = body;

          if (action === "ban") {
            if (!ipToBan) return json({ message: "Missing ipToBan" }, 400);
            // Blacklisting auto-removes any whitelist for this IP
            await env.BANS_KV.delete(`wl_${ipToBan}`);
            const record = { bannedAt: Date.now(), bannedBy: "mod" };
            await env.BANS_KV.put(`ban_${ipToBan}`, JSON.stringify(record));
            // Send ban webhook to MOD_WEBHOOK
            if (env.MOD_WEBHOOK) {
              const payload = {
                embeds: [{
                  title: "🚫 IP Banned",
                  color: 0xff0000,
                  description: `**IP:** \`${ipToBan}\`\n**Banned by:** mod`,
                  footer: { text: `Nearcade • ${new Date().toLocaleString()}` }
                }],
                username: "Nearcade Moderation"
              };
              await fetch(env.MOD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
            }
            return json({ success: true, message: `Banned ${ipToBan}` });
          }

          if (action === "unban") {
            if (!ipToUnban) return json({ message: "Missing ipToUnban" }, 400);
            await env.BANS_KV.delete(`ban_${ipToUnban}`);
            // Send unban webhook to MOD_WEBHOOK
            if (env.MOD_WEBHOOK) {
              const payload = {
                embeds: [{
                  title: "✅ IP Unbanned",
                  color: 0x00ff00,
                  description: `**IP:** \`${ipToUnban}\`\n**Unbanned by:** mod`,
                  footer: { text: `Nearcade • ${new Date().toLocaleString()}` }
                }],
                username: "Nearcade Moderation"
              };
              await fetch(env.MOD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
            }
            return json({ success: true, message: `Unbanned ${ipToUnban}` });
          }

          if (action === "whitelist") {
            const ipToSave = body.ipOrDomain || "";
            if (!ipToSave) return json({ message: "Missing ipOrDomain" }, 400);
            const ttl = body.ttlSeconds ? parseInt(body.ttlSeconds) : null;
            const record = { addedAt: Date.now(), addedBy: "mod" };
            const opts = {};
            if (ttl && ttl > 0) opts.expirationTtl = Math.min(ttl, 365 * 86400);
            await env.BANS_KV.put(`wl_${ipToSave}`, JSON.stringify(record), opts);
            return json({ success: true, message: `Whitelisted ${ipToSave}${ttl ? ' for ' + ttl + 's' : ' permanently'}` });
          }

          if (action === "unwhitelist") {
            const ipToRemove = body.ipOrDomain || "";
            if (!ipToRemove) return json({ message: "Missing ipOrDomain" }, 400);
            await env.BANS_KV.delete(`wl_${ipToRemove}`);
            return json({ success: true, message: `Removed whitelist for ${ipToRemove}` });
          }

          if (action === "list-whitelist") {
            const wlList = [];
            if (env.BANS_KV) {
              const list = await env.BANS_KV.list({ prefix: "wl_" });
              for (const key of list.keys) {
                try {
                  const val = await env.BANS_KV.get(key.name);
                  if (val) wlList.push({ ip: key.name.slice(3), ...JSON.parse(val) });
                } catch (_) {}
              }
            }
            return json(wlList);
          }

          return json({ message: "Unknown action" }, 400);
        }

        return new Response("Method Not Allowed", { status: 405, headers: CORS });
      }

      // Home page
      if (url.pathname === "/" || url.pathname === "/home") {
        if (env.ASSETS) {
          const asset = await env.ASSETS.fetch(new Request("https://nearcade.cutefame.net/nearcade-home.html", request));
          if (asset.status === 200) return asset;
        }
      }

      // Static assets
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("OK", { status: 200, headers: CORS });
    } catch (e) {
      console.error("[Worker] Global Error:", e.message);
      return json({ error: e.message }, 500);
    }
  }
};