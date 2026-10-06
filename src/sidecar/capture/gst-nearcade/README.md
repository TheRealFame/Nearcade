# gst-nearcade — native GStreamer capture backend (Rust)

Rust port of `../gstreamer_webrtc.py`. Same JSON-over-stdio wire protocol,
so `CaptureManager.js` cannot tell which backend produced the messages.

## Modes

- `--mode webrtc` (default): capture → H264 encode → `webrtcbin` (+ throttled
  JPEG preview). Speaks offer/answer/ICE JSON on stdin/stdout exactly like
  the Python backend.
- `--mode webcodecs`: capture → H264 encode → appsink, one `h264-chunk`
  JSON message per access unit (base64 Annex-B + `keyframe` bool).
- `--mode list`: print PipeWire video nodes as JSON and exit.

Common flags: `--node ID`, `--width/--height/--fps/--bitrate`,
`--encoder x264|vaapi` (default `x264`, parity with Python),
`--no-preview`, `--test-src` (videotestsrc instead of PipeWire),
`--help`.

Not yet ported: XDG portal screencast (needs a D-Bus client). Pass `--node`
or keep the Python backend where portal fallback is required.

## Layout (single crate, modules)

- `src/base.rs` — PipeWire node discovery (`pw-cli`), source fragments
- `src/ipc.rs` — line-JSON protocol (`info/error/thumbnail/sdp/ice/h264-chunk/nodes`)
- `src/webrtc.rs` — webrtcbin pipeline + signaling
- `src/webcodecs.rs` — encode → appsink chunk pipeline (+ Annex-B keyframe scan)
- `src/preview.rs` — shared throttled thumbnail branch (480x270 @ 2fps, q50,
  400ms guard)

## Building (no root)

Needs GStreamer 1.28+ dev files (headers + `.pc`). Without sudo, vendor them:

```sh
# download the -dev debs, extract under /tmp/gst-root, fix prefixes/symlinks
export PKG_CONFIG_PATH=/tmp/gst-root/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig
export LIBRARY_PATH=/tmp/gst-root/usr/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu
cargo build --release
```

gstreamer-rs 0.25 needs system GStreamer ≥ 1.28 (the `-sys` build scripts
enforce it); runtime here is 1.28.2.

## Headless checks (no display needed)

```sh
./target/release/gst-nearcade --mode list
./target/release/gst-nearcade --mode webcodecs --test-src --width 640 --height 360 --fps 15
./target/release/gst-nearcade --mode webrtc --test-src --width 640 --height 360 --fps 15
```

## Wiring into the app (next step, not done)

`CaptureManager._startGstWebRTC` currently spawns `python3 gstreamer_webrtc.py`.
Point it at this binary instead (same argv `--node`, same stdout JSON) — the
`setGstSignalingCallback` consumer needs zero changes, plus a new consumer
for `h264-chunk` messages on the WebCodecs path.
