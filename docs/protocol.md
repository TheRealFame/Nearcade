# Nearcade Streaming Protocol — Open Specification

**Status:** Draft · v1 · applies to Nearcade 3.0.x
**License:** Public — the protocol itself is open. The Nearcade implementation is NOT open source; this document is the contract you build against.

---

## 1. Purpose & Conformance Model

Nearcade is a low-latency remote-play system: a **Host** (a "streamer") broadcasts a live game session over WebRTC, and any number of **Viewers** join through a web page, send input, and watch the encoded video.

This document defines the wire protocol so that **independent implementations** can act as:

- a **Host / streamer client** (encode video, receive input, broadcast), or
- a **Viewer client** (decode video, send input, join sessions),

and interoperate with the official Nearcade signaling server and with each other.

What is **public** (specified here): REST endpoints, WebSocket signaling, WebRTC negotiation, data channels, video framing, input encoding, presence/pairing.

What is **intentionally out of scope** (implementation detail, not required for interop): the web UI, the input backends (evdev/uinput, XInput, virtual gamepads), the virtual audio engine, the WebGL rendering pipeline, the Rust VPS router internals, and any sidecar binaries. Implementations may replace all of these with their own equivalents.

**Conformance:** a client is conformant if it implements the message contracts in §3–§9. The signaling server is role-agnostic — it authenticates, relays, and enforces limits; it does not care which implementation produced the frames.

**Terminology:** *server* = the Node signaling server (reference: `src/scripts/server.js`). *Host* = the streaming client. *Viewer* = the joining client.

---

## 2. Architecture Overview

```
   Viewer (browser/desktop)          Signaling Server            Host ("streamer")
   ┌──────────────────┐   WebSocket  ┌──────────────────┐  WebSocket   ┌──────────────┐
   │ join/answer/ice  │ ───────────► │ relay + enforce  │ ◄─────────── │ offer/ice    │
   │ video decode     │ ◄─────────── │ limits + auth    │ ───────────► │ video encode │
   │ input send       │ ────────────►                  │ ────────────► │ input recv   │
   └────────┬─────────┘              └────────┬─────────┘              └──────┬───────┘
            │                                │                                 │
            └────────────── WebRTC (P2P) ──────────────────────────────────────┘
                      data channels: "input" (viewer→host), "webcodecs" (host→viewer)
```

- Signaling: everything from both sides flows through the server's WebSocket endpoints (§4).
- Media: video frames and input travel peer-to-peer over WebRTC once negotiated (§5–§7). In forced-relay conditions the server may fall back to relaying (see §9).
- Optionally, a Rust VPS router can sit between the host and its viewers (§10). It is a protocol-compatible alternative transport, not a requirement.

---

## 3. HTTP REST Surface

All endpoints are plain HTTP/JSON. Viewer-safe endpoints are reachable from remote clients; admin endpoints require a localhost connection (the host's own machine).

### 3.1 `GET /api/info`

Public. Response:

```json
{
  "lanIP": "192.168.1.5",
  "port": 3000,
  "pin": "1234",            // ONLY present when the request originates from localhost
  "hasPin": true,
  "pinEnabled": true,
  "publicIP": null,
  "tunnelUrl": "https://host.example.com",   // or null when no tunnel is up
  "version": "3.0.5",
  "arcadeUrl": "https://nearcade.cutefame.net"
}
```

### 3.2 `GET /api/turn`

Public. Returns **one of three shapes** — clients must handle all:

```json
null                                   // no TURN configured — use built-in STUN pool

{ "urls": ["stun:stun.l.google.com:19302"] }

[                                      // multiple server objects
  { "urls": ["turn:host:3478", "turn:host:5349?transport=tcp"],
    "username": "1824000000:nearcade", "credential": "<base64 HMAC-SHA1>" },
  { "urls": ["stun:stun.cloudflare.com:3478"] }
]
```

When the server holds a `TURN_SECRET`, credentials are **time-limited REST API credentials**: `username = "<unixTime+24h>:<turnUsername>"`, `credential = base64(HMAC-SHA1(secret, username))`. Do not hardcode TURN passwords; always use the credentials returned here.

### 3.3 `GET /api/pin-required`

```json
{ "required": true }
```

`required` is true when the host enabled the PIN and the request is not from a trusted local/private network.

### 3.4 Friends / presence endpoints

See §8. `/api/friends*` admin endpoints are localhost-only; `/api/ping` and `/api/p2p-invite` are public.

---

## 4. WebSocket Signaling

Three endpoints matter to clients:

| Path | Used by | Notes |
|---|---|---|
| `/ws/host` | Host | no auth challenge; last-connection-wins |
| `/ws/viewer` | Viewer | `?pin=` or `?password=` query params; mandatory auth handshake |
| `/ws/input` | Viewer (optional) | dedicated 250 Hz input lane, bound by an `identify` message |

Server behavior: `perMessageDeflate: false`, `maxPayload: 1048576` (1 MiB), heartbeat `ping` every 30 s, terminate on missing `pong`.

### 4.1 Viewer connection & auth (`/ws/viewer`)

1. Connect to `/ws/viewer?pin=<PIN>` or `/ws/viewer?password=<sessionPassword>`.
2. Server may reject immediately with a JSON message + close code (§4.5).
3. Server sends:

```json
{ "type": "auth-challenge", "nonce": "<uuid>" }
```

4. Within **8 seconds** the viewer must reply:

```json
{ "type": "auth-response", "hash": "<64-lowercase-hex>", "human": true }
```

where

```
hash = hex_lowercase( SHA-256( nonce + "nearcade_client_v3" ) )
```

(The suffix constant is part of the protocol — not a secret.)

5. On success the server sends:

```json
{ "type": "your-id", "viewerId": "v3f2a1b9", "name": "Guest1234" }
{ "type": "input-state", "gp": true, "kb": false, "mode": "gamepad" }
```

`viewerId` is `"v" + 8 lowercase hex`. Any messages the viewer sent before auth (e.g. `join`) are buffered (max 50) and replayed after auth completes.

### 4.2 Viewer → server messages (`/ws/viewer`)

| type | Payload fields | Notes |
|---|---|---|
| `join` | `{ name, viewerId, pin?, color?, avatar?, platform?, scriptVersion?, viewerRegion?, isDesktopApp? }` | `name` ≤ 20 chars; server replies `join-ack {id,name,viewerCount}` and notifies the host (`viewer-joined`) |
| `ping` | `{}` | replies `pong` |
| `answer` | `{ sdp }` | WebRTC answer; server injects `_viewerId` |
| `offer` | `{ sdp }` | viewer-initiated renegotiation |
| `ice-viewer` | `{ candidate }` | server renames to `_viewerId` |
| `viewer-mic-ready` | `{}` | triggers host re-offer (voice chat) |
| `set-viewer-volume` | `{ targetId, volume }` | 0–100 |
| `viewer-rejoin` | `{ viewerId }` | reclaims a slot; server emits `viewer-left`(old) + `viewer-joined`(new) to host |
| `request-offer` | `{}` | asks server to re-notify the host (do NOT send this unconditionally after `host-connected`) |
| `request-keyframe` | `{ viewerId? }` | relayed to host |
| `gpid` | `{ padIndex, id, name }` | registers a gamepad; server replies `pad_id = "<id>_<padIndex>"` and forwards `viewer-gpid` to host |
| `set-name` | `{ name }` | server replies `name-confirmed {name}`, host gets `viewer-renamed` |
| `update-color` | `{ color }` | roster refresh |
| `chat` | `{ from, msg, platform, color }` | sanitized + fanned out |
| `touch-disconnect` | `{}` | flushes virtual pad 99 |
| `gamepad` / `keyboard` | see §7 | `keyboard` is renamed `kbm` by the server; rate-capped at 300 msg/s |
| `webcodecs-health` | `{ wcHealthType, wcHealthData, viewerId }` | `frozen` / `black-screen` / `telemetry` / `fallback-request` |
| `vr` | `{ head:{px,py,pz,qw,qx,qy,qz}, left?, right? }` | optional VR pose injection |
| binary `0x01` | 14-byte gamepad packet (§7.2) | wrapped by the server as `0x80 | <len> | <viewerId utf8> | <payload>` for the host |

### 4.3 Server → viewer messages (`/ws/viewer`)

| type | Payload | Notes |
|---|---|---|
| `auth-challenge` | `{ nonce }` | |
| `your-id` | `{ viewerId, name }` | |
| `input-state` | `{ gp, kb, mode }` | input permission state |
| `join-ack` | `{ id, name, viewerCount }` | |
| `pong` | `{}` | |
| `host-connected` | `{ hostName, hostRegion }` | sent after `viewer-joined`, **before** the offer — ordering matters |
| `host-stream-ready` | `{}` | host is streaming |
| `host-not-streaming` | `{ viewerId }` | |
| `host-stream-stopped` | `{}` | |
| `host-disconnected` | `{}` | |
| `ctrl-settings` | `{ enableMotion, touchLayout, expDevices[] }` | |
| `tournament-mode` | `{ enabled }` | |
| `tunnel-url` | `{ url }` | |
| `offer` | `{ sdp: { type:"offer", sdp:"<SDP>" } }` | from host |
| `ice-host` | `{ candidate }` | from host |
| `roster` | `{ viewers:[{id,name,color,avatar,gp,kb,slot,locked,inputMode,platform,isHost}], controllerCount }` | |
| `chat` | `{ from, msg, viewerId?, platform?, color?, isHost? }` | |
| `rumble` | `{ strong, weak, duration }` | |
| `pin-rejected` | `{ reason? }` | wrong PIN |
| `session-password-required` | `{ reason }` | |
| `session-full` | `{ max, reason }` | |
| `session-blocked` | `{ reason, banExpiresAt? }` | URL-spam lockout / ban |
| `force-reload` | `{ viewerId, url }` | |
| `slot-assigned` | `{ slot }` | |
| `name-confirmed` | `{ name }` | |
| `voice-activity` | `{ activeSpeakers: [id,...] }` | |
| `host-voice-cmd` | `{ action:"mute"|"unmute", targetViewerId }` | |
| `input-ack` | `{ seq }` | every 10th input `_seq` on `/ws/input` |
| `webcodecs-config` | *string* (§7.3) | VPS mode |
| `vps-broadcast` | `{ payload }` | |

### 4.4 Host messages (`/ws/host`)

The host connects with no handshake. Last connection wins (hot-swap safe).

Host → server:

| type | Payload | Notes |
|---|---|---|
| `webcodecs-config` | *raw string* | broadcast verbatim to all viewers (§7.3) |
| `host-region` | `{ region }` | 2-char lowercase |
| `offer` / `ice-host` / `answer` | `+ _viewerId` | routed to that viewer's socket |
| `request-offer` | `{ viewerId }` | ask server to re-fire `viewer-joined` to us |
| `viewer-mic-ready`-style relays | `{}` | see viewer table — server re-relays them to the host |
| `host-voice-cmd` | `{ action, targetViewerId }` | to one viewer |
| `host-voice-broadcast` | `{ action }` | to every viewer |
| `force-reload` | `{ viewerId }` | |
| `kick-viewer` | `{ viewerId }` | viewer gets `pin-rejected reason:"kicked"` + close 4003 |
| `report-viewer` | `{ viewerId, anonHash?, reason?, sessionId? }` | moderation |
| `set-pin` | `{ enabled }` | toggles the PIN gate |
| `set-input` | `{ viewerId, gp, kb }` | input permissions |
| `assign-slot` / `toggle-slot-lock` / `set-viewer-slot` | `{ viewerId, slot, locked? }` | |
| `bind-evdev` | `{ viewerId, targetWindowName }` | |
| `chat` | `{ from, msg, platform, color }` | URL-spam filtered + fanned out |
| `set-ctrl-type` / `ctrl-settings` / `panic_toggle` / `window-focus` / `set-input-mode` | various | input driver config |
| `regen-pin` | — | new PIN |
| `host-stream-ready` / `host-stream-stopped` | — | streaming flags |
| `gamepad` / `keyboard` / `kbm` / `gpid` | `+ viewerId` | VPS-mode input relay |
| **anything else** | — | broadcast verbatim to all viewers (e.g. `{type:"sync-pin", pin, enabled}`) |

Host → server binary: `0x80`-prefixed frames are wrapped gamepad (§7.2) for the input driver; **any other binary frame is a WebCodecs video chunk and is fanned out to every viewer** (this is the relay fallback path, §9).

Server → host: the server delivers relayed viewer messages (`join` becomes `viewer-joined {viewerId, name,...}`; `answer`, `ice-viewer`, `request-keyframe`, `gpid`, etc. are passed through with the viewer's `_viewerId`/`viewerId`).

### 4.5 Close codes & pre-auth rejections

| Condition | Message sent first | Close code |
|---|---|---|
| URL-spam lockout | `{type:"session-blocked",reason:"url-spam-timeout"}` | 4005 |
| Temporary ban | `{type:"session-blocked",reason:"banned",banExpiresAt}` | 4006 |
| PIN brute-force lockout | `{type:"pin-rejected",reason:"rate-limited"}` | 4001 |
| Wrong PIN (6 tries → 2 min lockout) | `{type:"pin-rejected"}` | 4002 |
| Wrong session password | `{type:"session-password-required",reason}` | 4004 |
| Auth not completed in 8 s | — | 4008 |
| Crypto hash mismatch | — | 4008 |
| Bot detection (optional) | — | 4009 |
| Turnstile missing/failed (optional) | — | 4010 |
| Input flood (>300 non-gamepad/s) | `{type:"viewer-flood-kick"}` (to host) | 1008 |

### 4.6 `/ws/input` (optional fast lane)

1. First message: `{ "type": "identify", "viewerId": "<id>" }`.
2. Then: binary `0x01` packets (gamepad) and `{type:"gpid"}`, `{type:"gamepad"|"keyboard",...}` JSON messages, delivered straight to the host's input driver. `input-ack {seq}` every 10th `_seq`.

---

## 5. WebRTC Negotiation

- **PC options (host):** `bundlePolicy: "max-bundle"`, `rtcpMuxPolicy: "require"`, `sdpSemantics: "unified-plan"`.
- The **host creates the offer** and sends `{type:"offer", sdp, _viewerId, codec:"vp9"|"h264"|"av1"|"hevc"|"vp8"|null}`; `codec` is informational (parsed from the SDP).
- The **viewer answers** with `{type:"answer", sdp, _viewerId}`.
- ICE candidates: `{type:"ice-viewer", candidate, viewerId}` (viewer→host) and `{type:"ice-host", candidate, _viewerId}` (host→viewer), relayed by the server.
- Viewer ICE ladder (recommended): Google STUN pool → `stun.cloudflare.com:3478` → `/api/turn` → community TURN servers.
- Do **not** send `request-offer` right after `host-connected` — it destroys freshly negotiated peer connections.
- Voice: viewers may request an audio track via renegotiation (`viewer-mic-ready`); opus `ptime` is munged to 1 ms for low latency.

---

## 6. Data Channels

Negotiated on the host's offer.

| Label | Options | Direction | Content |
|---|---|---|---|
| `webcodecs` | `{ ordered:false, maxRetransmits:0, priority:"low" }` | host→viewer | `webcodecs-config` JSON **strings** + binary video chunks |
| `input` | `{ ordered:false, maxRetransmits:0, priority:"high" }` | viewer→host | gamepad/keyboard (§7) |
| `ladder-ping` | reliable (default) | either | TURN liveness probe only |

When the `webcodecs` channel opens, the host must immediately send the cached config (if any) and then force a keyframe. On the `input` channel the host injects `viewerId`/`viewer_id` into every JSON payload it receives.

---

## 7. Wire Formats

### 7.1 Gamepad JSON (canonical)

```json
{
  "type": "gamepad",
  "viewerId": "v3f2a1b9",
  "pad_id": "v3f2a1b9_0",
  "padIndex": 0,
  "buttons": 4213,
  "lx": -32767, "ly": 0, "rx": 32767, "ry": -32767,
  "lt": 0, "rt": 255,
  "_seq": 42,
  "history": [ { "...same fields...", "_ts": 123.456 } ]
}
```

- `buttons` is a **16-bit bitmask** over W3C gamepad button indices:

| bit | 0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0100 | 0x0200 | 0x2000 | 0x1000 | 0x0400 | 0x0800 | 0x0010 | 0x0020 | 0x0040 | 0x0080 | 0x4000 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| button | A(0) | B(1) | X(2) | Y(3) | LB(4) | RB(5) | Select(8) | Start(9) | L3(10) | R3(11) | D-Up(12) | D-Down(13) | D-Left(14) | D-Right(15) | Guide(16) |

- `lx/ly/rx/ry`: int16 range **−32767..+32767** (raw W3C −1..+1 × 32767).
- `lt/rt`: **0..255** (W3C `buttons[6]/[7].value` 0..1 × 255).
- `history`: last ≤3 prior states with `_ts` (redundancy mode; optional).
- `_seq`: monotonic per-viewer sequence; the server acks every 10th on `/ws/input`.
- **Raw W3C arrays are also accepted:** `{type:"gamepad", axes:[...≤20], buttons:[{pressed,value}...≤40]}` — the server normalizes to the canonical form. **Empty arrays are valid** (releasing all buttons) and must never be rejected.
- The server injects `pad_id = "<viewerId>_<padIndex>"`; pad index 99 is the touch/virtual pad.

### 7.2 Binary gamepad packet — 14 bytes, little-endian

```
byte  0:  0x01                    marker
byte  1:  padIndex                0..16 (99 = touch)
bytes 2-3: uint16 LE  buttons      bitmask (as §7.1)
bytes 4-11: 4 × int16 LE  lx, ly, rx, ry
byte  12:  lt  0..255
byte  13:  rt  0..255
```

Over `/ws/viewer`, the server wraps it for the host: `0x80 | <utf8Len> | <viewerId utf8> | <payload>`. The host unwraps and forwards the raw 14 bytes to its input layer.

### 7.3 Video stream (WebCodecs)

**Config** — sent as a JSON **string** over the `webcodecs` data channel (and re-sent on: channel open, every `request-keyframe`, and encoder metadata emission):

```json
{
  "type": "webcodecs-config",
  "codec": "av01.0.04M.08",
  "codedWidth": 1920,
  "codedHeight": 1080,
  "description": [0,0,1,103, ...]
}
```

- `codec` is a WebCodecs codec string (`av01.*`, `vp09.*`, `vp8`, `avc1.*`, `hvc1.*`).
- `description` is the AVCC extradata as a byte **array**, or **null** when absent (some Linux hardware encoders cannot emit it — the reference implementation falls back to VP9 there).
- Config strings must **never** be dropped under congestion; a late-joining viewer that misses the config will never initialize its decoder (permanent black screen).

**Video chunks** — binary packets:

```
byte  0:    uint8   isKeyframe   (1 = keyframe, 0 = delta)
bytes 1-8:  float64 timestamp    microseconds, LITTLE-ENDIAN
bytes 9+:   EncodedVideoChunk payload (Annex-B / AVCC NAL units)
```

Receiver: `new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp, data })`. Minimum length is 10 bytes; first byte must be 0 or 1. Viewers must wait for a keyframe after config before decoding.

**Congestion control (host):** when a data channel's `bufferedAmount` exceeds **1 MiB** (3 MiB for 1 s after a keyframe), drop video frames and force a keyframe. This prevents permanent latency degradation.

### 7.4 Keyboard / mouse JSON

```json
{ "type": "keyboard", "viewerId": "v3f2a1b9", "pad_id": "v3f2a1b9_0",
  "event": "keydown | keyup | mousemove", "key": "KEY_A | BTN_LEFT | ..." }
{ "type": "keyboard", "viewerId": "...", "pad_id": "..._0",
  "event": "mousemove", "dx": 12, "dy": -3 }
```

`key` uses Linux evdev names. The server renames `keyboard` → `kbm` when relaying.

---

## 8. Friends, Presence & P2P Invites (open sub-protocol)

Presence and private-session invites use HMAC-signed requests so a friend's **public UUID alone cannot be spoofed**. The pairing secret is shared out-of-band.

### 8.1 Signature primitive

```
sig = hex_lowercase( HMAC-SHA256( pairingSecret, parts.join(":") ) )   // 64 hex chars

valid iff:
  ts within ±90 s of the receiver's clock
  sig matches /^[0-9a-f]{64}$/
  ts is strictly greater than the last accepted ts for that identity (replay guard)
```

### 8.2 `POST /api/ping` — "I'm online, here's my session"

Public, rate-limited 5 req/60 s per IP.

```json
{ "uuid": "<uuid-v4>", "name": "<≤32 chars>", "avatar": 0,
  "url": "https://<session link, ≤500 chars>",
  "ts": 1754000000000,
  "sig": "<hmac over [uuid, ts, url]>" }
```

Responses: `200 {ok:true, pong:true, at:<ms>}` · `400 invalid friend id` · `403 pings disabled | not on friend list` · `403 pairing required {needsPairing:true}` · `403 bad signature` · `429 rate limited`.

The signed `url` is stored as the friend's current session link; because it is inside the signature, a spoofer cannot swap in their own link.

### 8.3 `POST /api/p2p-invite` — server-to-server invite

Public, rate-limited 10 req/60 s per IP.

```json
{ "fromUuid": "<inviter uuid-v4>", "fromName": "<≤32 chars>",
  "roomCode": "abc123-def456",
  "ts": 1754000000000,
  "sig": "<hmac over [fromUuid, ts, roomCode]>" }
```

The receiver verifies `fromUuid` is on their friend list and that they hold a stored pairing secret for it. Responses mirror §8.2 (`invites disabled | not on friend list | not paired {needsPairing:true} | bad signature`). Accepted invites are surfaced to the host dashboard and expire after **10 minutes**.

### 8.4 Pairing ceremony

1. **Host adds a friend:** `POST /api/friends/add {uuid}` (localhost) → `{ok, friends, secret}` — the 48-hex secret is returned exactly once. `POST /api/friends/paircode {uuid}` re-returns it.
2. The host sends the code to the friend **out-of-band**.
3. **Friend stores it:** `POST /api/friends/secret {uuid: <host uuid>, secret}` (localhost on their side).
4. Now both sides can sign pings/invites for each other.

### 8.5 Room codes (P2P sessions)

`roomCode = <6 base36 chars>-<6 base36 chars>` (always matches `^[0-9a-z]{6}-[0-9a-z]{6}$`). Viewers join a P2P session by visiting `/?host=p2p://<roomCode>`. PIN is forced off in P2P mode.

---

## 9. Relay Fallback

When the host runs behind the optional VPS router (§10), or when ICE fails, the server relays instead of the peers:

- Host binary frames → forwarded to all viewers (disambiguated from audio by the §7.3 9-byte header check).
- Audio: **Int16 LE, mono, 48 kHz**, converted to float by viewers at `/32768.0`.
- `webcodecs-config` strings are cached (`last_config`) by the router and replayed to late joiners.

---

## 10. Optional VPS Router Mode (protocol-compatible transport)

A host may authenticate to a router instance with `{type:"auth", role:"host", key:"<master key>"}`; viewers with `{type:"auth", role:"viewer", ...}`. Router messages use **kebab-case** type names and viewer ids are full UUIDv4. Message types:

| type | direction | purpose |
|---|---|---|
| `auth-ok` / `auth-fail` | router→client | auth result |
| `ping` / `pong` | both | heartbeat |
| `host-connected` | router→viewers | host authenticated (also to `?standby=true` listeners) |
| `host-disconnected` / `stream-active` / `stream-idle` | router→viewers | lifecycle |
| `viewer-input` | router→host | `{viewer_id, payload}` — the viewer's first message is its `join` |
| `viewer-joined` / `viewer-left` | router→host | `{viewer_id}` |
| `viewer-authorized` | host→router | authorize a waiting viewer |
| `viewer-dispatch` | host→router | `{viewer_id, payload}` targeted message |
| `set-pin` | host→router | mirrors the PIN gate |

Hosts must accept `viewer_id` **or** `viewerId` casing in router messages. This mode is optional — the local signaling server path (§3–§9) is the baseline contract.

---

## 11. Constants & Limits

| Constant | Value |
|---|---|
| Viewer id format | `v` + 8 lowercase hex |
| Auth timeout | 8 s |
| Auth challenge suffix | `nearcade_client_v3` |
| PIN tries before lockout / lockout duration | 6 / 2 min |
| Max WS payload | 1 MiB |
| WS heartbeat | ping every 30 s, terminate on missing pong |
| Input flood cap | 300 non-gamepad msgs/s |
| Buffer-bloat threshold | 1 MiB (3 MiB for 1 s post-keyframe) |
| `webcodecs-config` | never dropped |
| Friend online window | last ping within 10 min |
| Pending invite TTL | 10 min |
| Signature skew / replay | ±90 s / monotonic ts |
| Ping / invite rate limits | 5/60 s, 10/60 s per IP |
| Name limits | viewer ≤20, friend ≤32 chars |

---

## 12. Conformance Checklist — Building Your Own Streamer

To ship a compatible Host client you must:

1. Connect to `/ws/host`; on each `viewer-joined` create an RTCPeerConnection (`max-bundle`, `require` rtcpMux, unified-plan).
2. Send `{type:"offer", sdp, _viewerId}` and `{type:"ice-host", candidate, _viewerId}`; handle `answer` and `ice-viewer`.
3. Open the `input` data channel (viewer→host) with the §6 options; parse §7.1/§7.2/§7.4 input and feed your own input backend.
4. Encode video with WebCodecs (`keyframe every ≤200 ms` cadence recommended); send the `webcodecs-config` string on the `webcodecs` channel open and on every `request-keyframe`; send chunks in §7.3 framing; obey §7.3 congestion rules.
5. Send `host-stream-ready`/`host-stream-stopped`; honor `set-pin`; respond to `request-keyframe`.
6. Optionally: presence (signed pings §8.2), P2P invites (§8.3), chat relay, roster.

A conformant viewer needs: auth handshake (§4.1), `join`, offer/answer/ICE (§5), WebCodecs decode (§7.3), and input sending (§7.1/§7.2).

---

## 13. Security Notes

- TURN credentials are time-limited; refresh from `/api/turn` rather than caching long-term.
- The auth hash constant is public; the PIN/session password is the real gate.
- Friend UUIDs are **public identifiers** — never a credential. Presence and invites are secured by HMAC pairing secrets (§8).
- Servers enforce rate limits, input caps, and URL-spam filtering; clients should tolerate `429` and the close codes in §4.5.
