# nearcade-sidecapture

**Not general screen/window capture.** This is Nearcade's "extras" capture
tool for *external video sources* — webcams and HDMI/USB capture cards
today, with Android screen mirroring (scrcpy-style) planned as a second
source type later. It does not capture your desktop or other application
windows; that's a different problem with a different tool.

Cross-platform capture-card / webcam capture, as a Rust library plus a CLI
and a Tauri GUI built on top of it. Replaces the old Python/Tkinter +
`gst-launch-1.0` subprocess tool — same underlying idea (GStreamer), but
driven through gstreamer-rs directly instead of shelling out and
string-splitting a pipeline, which is what caused the flakiness before
(device-busy errors mid-swap, fragile fallback-pipeline retries, etc).

## Workspace layout

```
capture-core/       Library. Device enumeration + pipeline lifecycle.
                     No subprocesses, no CLI/GUI-specific code at all.
capture-cli/         Thin binary: `nearcade-sidecapture list` / `start`.
capture-gui/         Tauri app. src-tauri/ = Rust backend (exposes Tauri
                     commands that call straight into capture-core).
                     dist/index.html = the actual UI, Nearcade-themed.
```

## Planned: Android capture (scrcpy-style) as a second source

Not implemented yet — noted here so the intent isn't lost. The idea is a
second capture source type alongside webcam/capture-card, mirroring an
Android device's screen the way scrcpy does. Two real open questions to
resolve before building it, rather than guessing at answers now:

1. **Device discovery** — scrcpy's own device list normally comes from
   `adb devices`. Avoiding a user-visible ADB dependency means either (a)
   vendoring/bundling `adb` so it's invisible to the user rather than
   something they install themselves, or (b) implementing Android's
   wireless-debugging (mDNS-based) pairing directly, which is a real
   reverse-engineering/protocol-implementation effort, not a quick wrapper.
2. **The scan itself** — a device-grid UI with a buffer/loading animation
   that runs for as long as discovery takes, rather than a fixed timeout,
   was requested. That's a straightforward UI pattern once (1) is settled,
   but depends entirely on how discovery ends up working — a polling ADB
   scan behaves differently (start/stop, has a natural "done" signal) than
   an mDNS-based listener (which is generally open-ended / event-driven and
   needs its own "stop scanning" affordance).

This deserves its own focused design pass rather than being bolted onto
the webcam/capture-card work — the two source types don't share much
beyond both ending up as a GStreamer pipeline eventually.


Nearcade itself can depend on `capture-core` directly as a path/git
dependency — it does not need to shell out to the CLI. The CLI exists for
scripting / testing / manual use outside of Nearcade.

## Prerequisites (all platforms)

- Rust (stable), via [rustup](https://rustup.rs)
- GStreamer 1.20+ with base/good/bad plugins

### Linux (Debian/Ubuntu)

```bash
sudo apt install \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-vaapi \
  libgtk-3-dev libwebkit2gtk-4.1-dev # Tauri's Linux webview deps
```

### macOS

```bash
brew install gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad
```

### Windows

Install the GStreamer MSVC development installer from gstreamer.freedesktop.org
(both runtime and development packages), and ensure `GSTREAMER_1_0_ROOT_MSVC_X86_64`
is set so gstreamer-rs's build script can find it.

## Building

```bash
# Library + CLI only:
cargo build --release -p nearcade-sidecapture

# List devices:
./target/release/nearcade-sidecapture list

# Start capture from the CLI:
./target/release/nearcade-sidecapture start --device /dev/video2 --width 1280 --height 720 --fps 30
```

### GUI (Tauri)

```bash
cargo install tauri-cli --version "^2"
cd capture-gui
cargo tauri dev      # dev mode, hot-reloads dist/index.html
cargo tauri build    # produces a real installer/binary per-OS
```

## Known caveats

The core pipeline (device enumeration, v4l2src/decodebin negotiation,
brightness/contrast/mirror, the embedded appsink preview) has been built
successfully and tested against real hardware (a Razer Kiyo and an HDMI
capture card), so the items below are the remaining known gaps rather than
"this might not even compile" guesses.

1. **NDI requires `gst-plugins-bad` with NDI SDK support.** The documented
   from-source build in this README explicitly disables `bad` (see the
   `meson setup` command above), so `ndisink` will not exist yet on a
   system set up purely by following these instructions. Turning on the
   NDI toggle (or `--ndi` on the CLI) before that's addressed fails with a
   clear `MissingElement("ndisink...")` error rather than doing nothing
   silently — but actually using it means either:
   - Rebuilding GStreamer with `-Dbad=enabled` (and the NDI SDK installed
     and discoverable by meson), or
   - Installing a distro/vendor package that already ships `ndisink`
     built against the NDI SDK, if one exists for your system.
   Neither has been done/tested yet — treat NDI as wired-but-unverified
   until someone actually has `ndisink` available and tries it.
2. **`mfvideosrc` / `avfvideosrc` property names** (`device-path` on
   Windows, `device-index` on macOS) are written from documentation
   recall, not tested against real Windows/macOS hardware (everything
   verified so far has been on Linux). Run `gst-inspect-1.0 mfvideosrc` /
   `gst-inspect-1.0 avfvideosrc` on the target machine to confirm exact
   property names before relying on them there.
3. **`vaapipostproc` is Linux/Intel-AMD-VAAPI-only** and is skipped
   entirely on Windows/macOS (falls back to software convert/scale only) —
   intentional, not a bug. Windows/macOS hardware acceleration
   (D3D11/VideoToolbox) is a follow-up, not yet wired.
4. **Element message names for signal-loss detection**
   (`no-signal` / `signal` in `pipeline.rs`'s `watch_bus`) are
   driver/plugin-dependent and haven't been confirmed against a real
   signal-drop event on the HDMI capture card yet (only device-open/close
   has been tested, not physically disconnecting the HDMI source mid-run).
   If signal-loss detection doesn't fire when expected, run with
   `GST_DEBUG=v4l2*:5` and check the actual element message structure name
   your driver posts, then adjust the string match in `watch_bus`.
5. **Upscale is a plain `videoscale` resize, not true FSR.** The "Upscale
   Output" option in the GUI does a standard scale, not AMD's edge-aware
   FSR algorithm — sharper upscaling would need `vaapipostproc`'s scaling
   filter tuned for it, or a dedicated FSR GStreamer element. Treat the
   current upscale option as "stretch to a higher resolution," not
   "enhance detail."

## The embedded preview

The video preview renders inside the app window now — no separate native
popup. The pipeline runs `tee → queue → videoconvert → jpegenc → appsink`
in Rust; each JPEG-encoded frame is pulled in an `appsink` callback, sent
to the Tauri frontend as a base64 data URL over a `capture://frame` event,
and assigned directly to the `<img id="previewImg">` in `dist/index.html`.

This is deliberately simple (an `<img>` src swap, not a `<canvas>` with
manual drawing) since it's easy to reason about and fast enough for
typical webcam frame rates. If frame-rate/latency ever becomes a problem,
the next step up is a `<canvas>` with `createImageBitmap()` to avoid the
browser's implicit image-decode-on-assign overhead, or dropping JPEG
encoding entirely in favor of a raw-frame path with a WebGL/WebGPU
uploader for the least CPU overhead. None of that has been needed against
today's testing, so it hasn't been built.

## License

MIT

