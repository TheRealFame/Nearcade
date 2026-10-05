# Android Capture (scrcpy-style) — Implementation Spec

Status: **not started.** This is a planning document for whoever (human or
AI) picks this up next. Nothing described here exists in the codebase yet.
Read this fully before writing code — the sequencing matters, and the
wrong order (e.g. building the UI before discovery is solved) wastes work.

## 1. What this is, and what it explicitly is not

This adds a **second capture source type** to `nearcade-sidecapture`,
alongside the existing webcam/HDMI-capture-card source. It mirrors an
Android device's screen (and optionally audio, touch/key input) the way
`scrcpy` does — by pushing a small server component onto the device and
streaming H.264/H.265/AV1 video back over a socket.

It is **not**:
- General screen/window capture of the *host* machine (that's a different
  problem; see the main README's opening scope note).
- A full device-management tool (file browser, app installer, shell
  access). Out of scope unless explicitly revisited later.
- A fork or vendored copy of scrcpy's desktop client. We speak the
  protocol; we don't reuse Genymobile's C/SDL codebase.

## 2. The two problems, kept separate

Resist the urge to solve these together. They're independent and have
different failure modes:

### 2a. Getting an ADB connection to the device (discovery + pairing + transport)

### 2b. Once connected, pushing/running the scrcpy server and consuming its stream

**2b is the easy, well-documented part.** scrcpy's server protocol
(socket count and order, the dummy byte, metadata format, video/audio/
control packet framing) is public and stable — see Genymobile/scrcpy's own
`app/src/main` for the reference, and the "Scrcpy Server Integration and
Upgrade" doc pattern from the XRSec/Screen-Remote project (an existing
Android client that reimplements the scrcpy protocol independently) for
what a clean integration checklist looks like: pin an exact server
version + its SHA-256, push it via the existing ADB connection, open the
sockets in the order the server expects, and verify against a real device
before considering it done.

**2a is the actual hard problem**, and it's why this whole feature is
deferred rather than half-built. The rest of this document is almost
entirely about 2a, because 2b only matters once 2a works.

## 3. What "avoid the ADB binary" actually means

The original ask was to "skip the need of adb" — worth being precise
about what that can and can't mean, because there are two different
things people mean by "avoid ADB":

- **Avoid the `adb` binary/CLI as an external dependency the user has to
  install.** This is achievable. ADB is a *protocol*, not just the
  Google-shipped binary — it can be reimplemented directly in Rust (or any
  language), the same way the `dadb` library did for Kotlin/JVM
  (referenced below) and the way the browser-based WebUSB scrcpy clients
  do for JS. The user never sees or installs "adb"; the app just speaks
  the protocol itself.
- **Avoid ADB (the protocol/authentication model) entirely.** This is
  **not achievable** without Android itself changing — Wireless Debugging
  *is* ADB-over-TLS. There is no alternate, non-ADB pairing mechanism
  Android exposes for this. Any tool that mirrors an Android screen over
  the network, including scrcpy itself, is built on top of ADB's pairing
  and transport. Don't scope this feature around eliminating ADB the
  protocol — scope it around eliminating ADB the external binary.

So: the real target is **a Rust-native ADB client library**, either
hand-rolled against the protocol spec or via an existing Rust ADB crate
if one is mature enough (check crates.io for current state — `adb_client`
and similar exist; evaluate freshness and protocol coverage before
committing to one, since this space changes).

## 4. The pairing/connect state machine (get this right first)

This is the part most likely to be built wrong if rushed. Confirmed from
real prior art (the XRSec/Screen-Remote project's own internal docs,
which describe exactly this problem):

> Wireless Debugging has two independent phases: **pairing** establishes
> trust material, while **connect** establishes a verifiable TLS ADB
> transport. Pairing success is not connect success, and mDNS discovery
> is not automatic pairing.

Concretely:

1. **Pairing phase.** The user opens Developer Options → Wireless
   Debugging → "Pair device with pairing code" on the Android device.
   This gives them an IP, a *temporary* port, and a 6-digit code — all
   three are needed and all expire. The desktop/app side submits all
   three to complete pairing, which establishes trust (a certificate/key
   exchange), not a working connection.
2. **Discovery.** Pairing and connect are advertised as **separate mDNS
   services**: `_adb-tls-pairing._tcp` and `_adb-tls-connect._tcp`. A
   device advertising itself for pairing is not necessarily reachable for
   connect yet, and vice versa. Don't conflate "I see it on mDNS" with
   "I can connect to it."
3. **Connect phase.** Only after pairing succeeds can a real ADB-over-TLS
   connection be established, using the `_adb-tls-connect._tcp` service
   (or a manually-entered IP:port if the user already knows it and paired
   previously — paired devices don't need to re-pair on every connection,
   only re-authenticate the transport).
4. **Only after connect succeeds** should the scrcpy server be pushed and
   started. Don't let UI code conflate "device discovered" with "device
   ready" at any layer — this was explicitly called out as a design
   mistake to avoid in the Screen-Remote project's own docs.

Ports for pairing and connect are **different and not fixed** — don't
hardcode `5555` anywhere; that's ADB's traditional USB-forwarding default,
not related to Wireless Debugging's dynamic ports. (This bit real people:
see Genymobile/scrcpy issue #3591, where `--tcpip` failed for months of
users because it assumed a fixed port that Wireless Debugging doesn't
use.)

## 5. Recommended architecture

```
capture-core/
  src/
    devices.rs         (existing — webcam/capture-card enumeration)
    pipeline.rs         (existing — GStreamer pipeline for that source)
    android/            (new module, self-contained)
      mod.rs
      discovery.rs      mDNS scanning for both pairing and connect services
      pairing.rs        pairing-code flow, trust material storage
      transport.rs       ADB-over-TLS connection once paired
      scrcpy_server.rs   push server APK/jar, open its sockets, parse
                          its stream framing
      device.rs          AndroidDevice type — the second variant
                          alongside CaptureDevice, OR a unified enum if
                          the GUI should list both source types in one
                          picker (design call, see open question below)
```

Keep the Android module's internals **out of `pipeline.rs`**. The
existing GStreamer pipeline is built around a local capture device
(`v4l2src`/`mfvideosrc`/`avfvideosrc`); an Android stream arrives as
already-encoded H.264/H.265/AV1 over a socket, which is a fundamentally
different starting point. The cleanest integration is probably:
`android::scrcpy_server` hands off a raw byte stream, which gets wrapped
in a small `appsrc`-based GStreamer pipeline (`appsrc → h264parse →
decodebin → ...`, reusing the *existing* decode/convert/tee/appsink/NDI
machinery from `pipeline.rs` once you're past the Android-specific parts).
That reuse is the payoff for keeping this modular — don't duplicate the
tee/preview/NDI logic for Android; feed it through the same downstream
stage.

## 6. Trust material storage

Once paired, the device's trust material (keys/cert) should persist so
the user doesn't re-pair every session — same expectation as the `adb`
binary's own `~/.android/adbkey`. Store it somewhere sensible and
app-scoped (not reusing the user's actual `~/.android` directory, to
avoid interfering with any real `adb` install they might separately
have). Follow the "ADB identity, TLS storage, and runtime files under an
app-private root" pattern — keep this out of the main app's general
config/settings storage; it's security-sensitive material and deserves
its own clearly-scoped location.

## 7. The device-grid scan UI (what was asked for)

> maybe the software should have queried and skip the need of adb and a
> separate scan for devices grid container that shows a buffer animation
> while it attempts to do so for as much time as it needs.

This is a UI decision that depends entirely on how discovery ends up
working, so don't build it before section 4 is solved:

- If discovery is **mDNS-based** (recommended — it's what Wireless
  Debugging actually advertises over), scanning is naturally **open-
  ended/event-driven**, not a fixed-duration poll. The grid should:
  - Show a buffer/loading state per empty slot while listening.
  - Populate a card the moment an mDNS service is resolved — don't wait
    for a scan "to finish," there is no finish, only "still listening."
  - Give the user an explicit "Stop scanning" affordance, since an
    open-ended listener has no natural end.
  - Distinguish a device seen on `_adb-tls-pairing._tcp` (needs pairing
    code entry) from one seen on `_adb-tls-connect._tcp` (already paired,
    ready to connect) — these are different card states/actions, not the
    same card with different labels.
- Cross-reference against section 4, point 2: a device can appear on one
  mDNS service and not the other. The grid needs to handle "seen but not
  connectable yet" as a real, displayed state, not an edge case.

## 8. Suggested build order

Don't attempt this all in one pass. Suggested checkpoints, each one a
real "it works" milestone before moving to the next:

1. **mDNS discovery only.** List `_adb-tls-pairing._tcp` and
   `_adb-tls-connect._tcp` services on the network in a terminal/log
   output — no UI, no pairing, just prove discovery works and that you
   can tell the two service types apart.
2. **Pairing flow, CLI-only.** Take an IP/port/code (typed in by hand for
   now, not yet auto-discovered) and complete a real pairing handshake
   against a real device. Confirm trust material gets stored and a second
   run doesn't need re-pairing.
3. **Connect + raw ADB shell command.** Prove the TLS transport works by
   running something trivial like `adb shell getprop` equivalent over
   your own implementation — no scrcpy yet, just confirm the ADB
   transport itself is solid.
4. **Push and run the scrcpy server, no video yet.** Confirm the server
   starts and you can open its control socket.
5. **Video stream → raw file.** Pull the H.264/H.265/AV1 stream and dump
   it to a file; confirm it's a valid, playable video with `ffplay` or
   similar before touching GStreamer integration.
6. **Wire into the existing pipeline** via `appsrc`, reusing
   decode/convert/tee/preview/NDI from the existing `pipeline.rs`.
7. **Only then** build the discovery/pairing GUI (the device grid from
   section 7) — by this point you know exactly what states and actions
   it needs to represent, instead of guessing.

## 9. Open questions to resolve before/during implementation

- **One unified device picker, or a separate "Android" tab/section?** The
  existing GUI's device dropdown assumes a flat list of local capture
  devices. Android devices have a fundamentally different lifecycle
  (discovery → pairing → connect, vs. "it's just there" for a webcam) —
  decide whether that deserves a visually distinct section rather than
  trying to force it into the same dropdown.
- **Rust ADB crate vs. hand-rolled.** Check crates.io at implementation
  time for ADB protocol crates' maturity — this space moves, and a
  well-maintained existing implementation could save significant time
  over hand-rolling section 4 from scratch. Don't assume hand-rolling is
  required without checking first.
- **Server version pinning.** Decide how the scrcpy server binary itself
  gets bundled/fetched/verified (pinned version + checksum, per the
  Screen-Remote integration pattern in section 2b) — this is a supply-
  chain decision, not just a technical one.
