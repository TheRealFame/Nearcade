const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function isUrl(v) {
  return typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://"));
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const clientIP = request.headers.get("cf-connecting-ip") || "unknown";

      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

      // Health
      if (url.pathname === "/api/health") {
        return json({ status: "ok", ip: clientIP });
      }

      // Ban check for all requests
      if (env.BANS_KV && clientIP !== "unknown") {
        try {
          const isBanned = await env.BANS_KV.get(`ban_${clientIP}`);
          if (isBanned) return json({ error: "BANNED" }, 403);
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

          if (env.BANS_KV) {
            // Dedup old sessions from same host (tunnel URL)
            if (session.url) {
              const oldId = await env.BANS_KV.get(`host_sess_${session.url}`);
              if (oldId && oldId !== session.id) {
                await env.BANS_KV.delete(`sess_${oldId}`);
                await env.BANS_KV.delete(`webhook_rep_${oldId}`);
              }
              await env.BANS_KV.put(`host_sess_${session.url}`, session.id, { expirationTtl: 86400 });
            }
            await env.BANS_KV.put(`sess_${session.id}`, JSON.stringify(session), { expirationTtl: 120 });

            // Deduplicate webhook (only send once per session)
            const already = await env.BANS_KV.get(`webhook_rep_${session.id}`);
            if (!already && env.ARCADE_WEBHOOK) {
              const roleId = env.ARCADE_ROLE_ID || "";
              const thumbnail = isUrl(session.thumbnail) ? { url: session.thumbnail } : undefined;
              const gameTitle = (session.game && !session.game.match(/^(Unknown Game|Arcade Game|Game)$/i)) ? session.game : "🎮 Game";
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
              const payload = roleId
                ? { content: `<@&${roleId}>`, embeds: [embed], username: "Nearcade Arcade", avatar_url: "https://nearcade.cutefame.net/favicon.ico" }
                : { embeds: [embed], username: "Nearcade Arcade", avatar_url: "https://nearcade.cutefame.net/favicon.ico" };
              await fetch(env.ARCADE_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
              await env.BANS_KV.put(`webhook_rep_${session.id}`, "1", { expirationTtl: 3600 });
            }
          }
          return json({ success: true });
        } catch (e) {
          console.error("[Worker] Arcade Ping Error:", e.message);
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
              if (val) sessions.push(JSON.parse(val));
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
            // Clean up host mapping too
            const existing = await env.BANS_KV.get(`sess_${id}`);
            if (existing) {
              const old = JSON.parse(existing);
              if (old.url) await env.BANS_KV.delete(`host_sess_${old.url}`);
            }
            await env.BANS_KV.delete(`sess_${id}`);
            await env.BANS_KV.delete(`webhook_rep_${id}`);
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

          return json({ message: "Unknown action" }, 400);
        }

        return new Response("Method Not Allowed", { status: 405, headers: CORS });
      }

      // Home page
      if (url.pathname === "/" || url.pathname === "/home") {
        if (env.ASSETS) {
          const asset = await env.ASSETS.fetch(new Request("https://nearcade.cutefame.net/nearsec-home.html", request));
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