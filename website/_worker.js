export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';

    // ==========================================
    // CORS HEADERS (Moved to the top!)
    // ==========================================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    console.log(`[Worker]  Request: ${request.method} ${url.pathname}`);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ==========================================
    // THE BOUNCER: Check the Ban List
    // ==========================================
    if (env.BANS_KV && clientIP !== 'unknown') {
      if (url.pathname === '/' || url.pathname.includes('/arcade') || url.pathname.startsWith('/api/')) {
        const isBanned = await env.BANS_KV.get(clientIP);

        if (isBanned) {
          console.log(`[Worker]  Blocked banned IP: ${clientIP}`);

          // FOR HOSTS/API CALLS: Return clean JSON with CORS so the app can read the 403 status
          if (url.pathname.startsWith('/api/')) {
            return new Response(JSON.stringify({ error: "BANNED", message: "Your IP is banned." }), {
              status: 403,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }

          // FOR WEB VIEWERS: Return a slick, dark-themed HTML popup
          return new Response(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
          <meta charset="UTF-8">
          <title>Access Denied - Nearsec Arcade</title>
          <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700&display=swap" rel="stylesheet">
          <style>
          body { background: #0b0d0f; margin: 0; height: 100vh; display: flex; justify-content: center; align-items: center; font-family: 'Outfit', sans-serif; color: #f0f3f5; }
          .modal { background: #121518; border: 1px solid #ff5d3d; border-radius: 12px; padding: 40px; text-align: center; max-width: 400px; box-shadow: 0 16px 48px rgba(0,0,0,0.8); }
          .modal h2 { color: #ff5d3d; margin: 0 0 15px 0; letter-spacing: 1px; text-transform: uppercase; }
          .modal p { color: #949ba4; font-size: 14px; line-height: 1.6; margin: 0; }
          </style>
          </head>
          <body>
          <div class="modal">
          <h2>Access Denied</h2>
          <p>Your connection has been blocked. This IP address is banned from the Nearsec Arcade network.</p>
          </div>
          </body>
          </html>
          `, { status: 403, headers: { "Content-Type": "text/html", ...corsHeaders } });
        }
      }
    }

    // ==========================================
    // ROUTE 2.5: Pusher Private Channel Auth
    // ==========================================
    if (url.pathname === "/api/pusher-auth") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
      }

      try {
        // Pusher authentication sends raw form-urlencoded data: socket_id=XXXX&channel_name=XXXX
        const formData = await request.formData();
        const socketId = formData.get("socket_id");
        const channelName = formData.get("channel_name");

        if (!socketId || !channelName) {
          return new Response("Bad Request", { status: 400, headers: corsHeaders });
        }

        // Generate the HMAC SHA-256 signature required by Pusher
        const stringToSign = `${socketId}:${channelName}`;
        const encoder = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey(
          "raw",
          encoder.encode(env.PUSHER_SECRET), // Make sure PUSHER_SECRET is set in Worker env variables
                                                        { name: "HMAC", hash: "SHA-256" },
                                                        false,
                                                        ["sign"]
        );

        const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(stringToSign));
        const signatureHex = Array.from(new Uint8Array(signatureBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

        const authResponse = {
          auth: `${env.PUSHER_KEY}:${signatureHex}` // Make sure PUSHER_KEY matches your Pusher App Key
        };

        return new Response(JSON.stringify(authResponse), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Auth Failed", details: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // ROUTE 3: Arcade Moderation API
    // ==========================================
    if (url.pathname.includes("/api/mod")) {
      // 1. Verify the Secret Token
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || authHeader !== `Bearer ${env.MOD_SECRET_TOKEN}`) {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }

      // Handle GET: List all bans
      if (request.method === 'GET') {
        const list = await env.BANS_KV.list();
        // Return just the keys (the IP addresses)
        const bannedIPs = list.keys.map(k => k.name);
        return new Response(JSON.stringify(bannedIPs), { headers: { 'Content-Type': 'application/json', ...corsHeaders }});
      }

      // Handle POST: Ban or Unban
      if (request.method === 'POST') {
        try {
          const body = await request.json();

          if (body.action === 'ban' && body.ipToBan) {
            // Store the IP in KV. Value doesn't matter, just the key.
            await env.BANS_KV.put(body.ipToBan, JSON.stringify({ date: Date.now(), reason: 'CLI Ban' }));
            return new Response(JSON.stringify({ success: true, message: `Banned ${body.ipToBan}` }), { headers: corsHeaders });
          }

          if (body.action === 'unban' && body.ipToUnban) {
            await env.BANS_KV.delete(body.ipToUnban);
            return new Response(JSON.stringify({ success: true, message: `Unbanned ${body.ipToUnban}` }), { headers: corsHeaders });
          }

          return new Response(JSON.stringify({ message: 'Invalid action' }), { status: 400, headers: corsHeaders });
        } catch (e) {
          return new Response(JSON.stringify({ message: 'Bad request payload' }), { status: 400, headers: corsHeaders });
        }
      }

      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    // ==========================================
    // FALLBACK: Graceful Routing Pass-Through
    // ==========================================
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Redirect or return a clean index message instead of a fatal 500 crash
    return new Response(JSON.stringify({ status: "online", service: "Nearsec Arcade Gateway" }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
};
