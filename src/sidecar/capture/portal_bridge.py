#!/usr/bin/env python3
"""
portal_bridge.py — Wayland capture bridge: XDG Portal screencast -> PipeWire
-> (GStreamer dumb reader) -> FFmpeg hardware encode -> fragmented MP4.

Why this shape: on Wayland, x11grab sees only the XWayland root (black +
cursor) and kmsgrab needs DRM master (the compositor holds it). The sanctioned
path is the portal, but FFmpeg cannot speak portal/PipeWire. So GStreamer does
exactly ONE dumb job (pipewiresrc -> rawvideo fdsink); every encoding decision
stays in FFmpeg, whose flags mirror CaptureManager._buildFFmpegArgs.

Process contract (matches the GStreamer-backend JSON-over-stdio protocol):
  - stdout (fd 1) carries PURE fragmented-MP4 bytes (pumped from ffmpeg).
    Node relays it to the HTTP stream server byte-identical to _startFFmpeg.
    NEVER print text to stdout.
  - stderr carries JSON status lines + ffmpeg's raw stderr passthrough
    (frame= progress lines feed the Node watchdog unchanged):
      {"type": "portal-ready", "width": W, "height": H, "fps": F, "node": N}
      {"type": "error", "message": "..."}
      {"type": "exit", "code": N, "who": "gst"|"ffmpeg"}
  - --test skips the portal (headless CI): videotestsrc ball -> same chain.
  - SIGTERM tears down children orderly (TERM, then KILL).

Portal flow adapted from gstreamer_webrtc.py (same persist/monitor choices).
"""
import argparse
import json
import os
import random
import signal
import subprocess
import sys
import threading

CHILDREN = []

# Children must die with us (even on SIGKILL, which we cannot catch):
# plain Popen orphans gst/ffmpeg into permanently-running zombies every time
# a supervisor kills this bridge. PDEATHSIG via preexec_fn is stdlib-only.
try:
    import ctypes as _ctypes

    _libc = _ctypes.CDLL("libc.so.6", use_errno=True)

    def _die_with_parent():
        try:
            _libc.prctl(1, signal.SIGTERM)
        except Exception:
            pass
except Exception:
    def _die_with_parent():
        pass


def jem(msg):
    sys.stderr.write(json.dumps(msg) + "\n")
    sys.stderr.flush()


def request_portal_monitor():
    """Run CreateSession -> SelectSources(monitor) -> Start -> OpenPipeWireRemote.
    Returns (fd, node_id, width, height) or (None, None, 0, 0) on failure.
    Interactive: the compositor shows the screen picker (60 s budget)."""
    import dbus
    import dbus.mainloop.glib
    from gi.repository import GLib

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    sender = bus.get_unique_name()[1:].replace('.', '_')

    token_create = "nearcade_pb_create_" + str(random.randint(100000, 999999))
    token_select = "nearcade_pb_select_" + str(random.randint(100000, 999999))
    token_start = "nearcade_pb_start_" + str(random.randint(100000, 999999))
    req_create = f"/org/freedesktop/portal/desktop/request/{sender}/{token_create}"
    req_select = f"/org/freedesktop/portal/desktop/request/{sender}/{token_select}"
    req_start = f"/org/freedesktop/portal/desktop/request/{sender}/{token_start}"

    portal = bus.get_object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
    screencast = dbus.Interface(portal, "org.freedesktop.portal.ScreenCast")

    loop = GLib.MainLoop()
    out = {"fd": None, "node": None, "w": 0, "h": 0, "session": None}

    def on_start_response(response, results):
        bus.remove_signal_receiver(on_start_response, signal_name="Response", path=req_start)
        if response != 0:
            jem({"type": "error", "message": f"portal Start denied/timed out: {response}"})
            loop.quit()
            return
        streams = results.get('streams', [])
        if streams:
            out["node"] = int(streams[0][0])
            props = dict(streams[0][1]) if len(streams[0]) > 1 else {}
            size = props.get('size', (0, 0))
            try:
                out["w"], out["h"] = int(size[0]), int(size[1])
            except Exception:
                pass
            try:
                fd = screencast.OpenPipeWireRemote(
                    dbus.ObjectPath(out["session"]), dbus.Dictionary(signature='sv'))
                out["fd"] = fd.take()
            except Exception as e:
                jem({"type": "error", "message": f"OpenPipeWireRemote failed: {e}"})
        loop.quit()

    def on_select_response(response, results):
        bus.remove_signal_receiver(on_select_response, signal_name="Response", path=req_select)
        if response != 0:
            jem({"type": "error", "message": f"portal SelectSources failed: {response}"})
            loop.quit()
            return
        bus.add_signal_receiver(on_start_response, signal_name="Response",
                                bus_name="org.freedesktop.portal.Desktop", path=req_start)
        screencast.Start(dbus.ObjectPath(out["session"]), "",
                         dbus.Dictionary({"handle_token": token_start,
                                          "persist_mode": dbus.UInt32(1)}, signature='sv'))

    def on_create_response(response, results):
        bus.remove_signal_receiver(on_create_response, signal_name="Response", path=req_create)
        if response != 0:
            jem({"type": "error", "message": f"portal CreateSession failed: {response}"})
            loop.quit()
            return
        handle = results.get('session_handle')
        if not handle:
            loop.quit()
            return
        out["session"] = str(handle)
        bus.add_signal_receiver(on_select_response, signal_name="Response",
                                bus_name="org.freedesktop.portal.Desktop", path=req_select)
        screencast.SelectSources(
            dbus.ObjectPath(out["session"]),
            dbus.Dictionary({"types": dbus.UInt32(1), "multiple": False,
                             "handle_token": token_select}, signature='sv'))

    bus.add_signal_receiver(on_create_response, signal_name="Response",
                            bus_name="org.freedesktop.portal.Desktop", path=req_create)
    screencast.CreateSession(
        dbus.Dictionary({"session_handle_token": token_create,
                         "handle_token": token_create}, signature='sv'))
    GLib.timeout_add_seconds(60, loop.quit)
    loop.run()
    # Session stays alive: the bus connection + handle live as long as we do.
    return out["fd"], out["node"], out["w"], out["h"]


def build_ffmpeg_args(a, w, h):
    kb = max(100, round(a.bitrate / 1000))
    g = max(1, a.fps)  # 1s GOP mirrors CaptureManager (MSE/join latency)
    args = ["-hide_banner", "-loglevel", "info",
            "-f", "rawvideo", "-pix_fmt", "nv12", "-s", f"{w}x{h}",
            "-framerate", str(a.fps), "-i", "-"]
    if a.encoder == "vaapi":
        args += ["-vf", "format=nv12,hwupload", "-vaapi_device", a.vaapi_device,
                 "-c:v", "h264_vaapi", "-profile:v", "high", "-level", "4.2",
                 "-b:v", f"{kb}k", "-bf", "0", "-g", str(g)]
    elif a.encoder == "nvenc":
        args += ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ll",
                 "-b:v", f"{kb}k", "-bf", "0", "-g", str(g), "-cq", "20"]
    else:
        args += ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                 "-b:v", f"{kb}k", "-bf", "0", "-g", str(g)]
    args += ["-f", "mp4", "-movflags", "empty_moov+default_base_moof+frag_keyframe+skip_sidx", "pipe:1"]
    return args


def teardown(signum=None, frame=None):
    for p in CHILDREN:
        try:
            p.terminate()
        except Exception:
            pass


def _forward_gst_err(gst):
    """Forward gst stderr (prefixed) so deaths are diagnosable downstream."""
    try:
        while True:
            chunk = gst.stderr.read(4096)
            if not chunk:
                break
            for line in chunk.decode('utf-8', 'replace').split('\n'):
                line = line.strip()
                if line:
                    sys.stderr.write(f"[gst] {line}\n")
                    sys.stderr.flush()
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--height", type=int, default=540)
    ap.add_argument("--fps", type=int, default=70)
    ap.add_argument("--bitrate", type=int, default=4000000)
    ap.add_argument("--encoder", default="software", choices=["vaapi", "nvenc", "software"])
    ap.add_argument("--vaapi-device", default="/dev/dri/renderD128")
    ap.add_argument("--ffmpeg-bin", default="ffmpeg")
    ap.add_argument("--test", action="store_true",
                    help="headless self-test: videotestsrc instead of portal")
    a = ap.parse_args()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda s, f: (teardown(), sys.exit(0)))

    w, h = a.width, a.height
    if a.test:
        # fdsink sync=true is LOAD-BEARING (like --quiet and videorate):
        # fdsink defaults to sync=false, i.e. an unthrottled firehose
        # (videotestsrc blasted 386fps here). sync=true paces to the pipeline
        # clock so the encoder receives realtime cadence.
        src = (f"videotestsrc pattern=ball ! video/x-raw,width={w},height={h} ! "
               f"videoconvert ! videorate ! "
               f"video/x-raw,format=NV12,width={w},height={h},framerate={a.fps}/1 ! fdsink sync=true")
        # --quiet is LOAD-BEARING: gst-launch status lines go to stdout by
        # default and would interleave with (and corrupt) the rawvideo bytes.
        # gst stderr is FORWARDED (not DEVNULL): a silent gst death is
        # otherwise undiagnosable; Node ignores non-frame lines harmlessly.
        gst = subprocess.Popen(
            ["gst-launch-1.0", "--quiet"] + src.split() + ["fd=1"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            preexec_fn=_die_with_parent)
        CHILDREN.append(gst)
        raw_r, raw_w = gst.stdout, None
        threading.Thread(target=_forward_gst_err, args=(gst,),
                         daemon=True).start()
    else:
        fd, node, pw, ph = request_portal_monitor()
        if fd is None or node is None:
            jem({"type": "error", "message": "portal produced no stream (denied/timeout)"})
            return 2
        if pw > 0 and ph > 0:
            w, h = pw, ph
        raw_r, raw_w = os.pipe()
        gst = subprocess.Popen(
            ["gst-launch-1.0", "--quiet", 
             "pipewiresrc", f"fd={fd}", f"path={node}", "always-copy=true", f"keepalive-time={int(1000/a.fps)}", "do-timestamp=true", "!",
             "videoconvert", "!", "videoscale", "!", "videorate", "!",
             f"video/x-raw,format=NV12,width={w},height={h},framerate={a.fps}/1", "!",
             "fdsink", "sync=false", f"fd={raw_w}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            pass_fds=(fd, raw_w), preexec_fn=_die_with_parent)
        CHILDREN.append(gst)
        threading.Thread(target=_forward_gst_err, args=(gst,),
                         daemon=True).start()
        os.close(raw_w)

    jem({"type": "portal-ready" if not a.test else "test-ready",
         "width": w, "height": h, "fps": a.fps, "node": -1})

    ff = subprocess.Popen(
        [a.ffmpeg_bin] + build_ffmpeg_args(a, w, h),
        stdin=raw_r, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        preexec_fn=_die_with_parent)
    CHILDREN.append(ff)
    if not a.test:
        try:
            raw_r.close()
        except Exception:
            pass

    # Pump compressed MP4 to OUR stdout (the Node relay). ~0.5 MB/s: trivial.
    out = sys.stdout.buffer

    def pump():
        try:
            while True:
                chunk = ff.stdout.read(65536)
                if not chunk:
                    break
                out.write(chunk)
                out.flush()
        except Exception:
            pass

    # Forward ffmpeg stderr (frame= progress + errors) to OUR stderr.
    # CHUNK reads, never readline(): ffmpeg progress updates are \r-terminated
    # (no \n until exit) — readline() would starve the watchdog forever while
    # encoding runs perfectly. This exact bug cost a full debug session.
    def watch_err():
        try:
            while True:
                chunk = ff.stderr.read(65536)
                if not chunk:
                    break
                sys.stderr.write(chunk.decode('utf-8', 'replace'))
                sys.stderr.flush()
        except Exception:
            pass

    threading.Thread(target=pump, daemon=True).start()
    threading.Thread(target=watch_err, daemon=True).start()

    code = ff.wait()
    jem({"type": "exit", "code": code, "who": "ffmpeg"})
    if gst.poll() is None:
        try:
            gst.terminate()
            gst.wait(timeout=3)
        except Exception:
            try:
                gst.kill()
            except Exception:
                pass
    if gst.returncode not in (0, None):
        jem({"type": "exit", "code": gst.returncode, "who": "gst"})
    return 0 if code == 0 else 3


if __name__ == "__main__":
    sys.exit(main())
