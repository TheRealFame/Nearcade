#!/usr/bin/env python3
# ==============================================================================
# gstreamer_webrtc.py  Native GStreamer WebRTC Backend
# ==============================================================================
# Handles WebRTC signaling (SDP Offers/Answers + ICE) and capture via
# PipeWire. Falls back to XDG Desktop Portal if no headless node is found.
# ==============================================================================

import sys
import json
import threading
import argparse
import random
import base64
import time
import dbus
from dbus.mainloop.glib import DBusGMainLoop

import gi

PRINT_LOCK = threading.Lock()
def emit_ipc(msg_dict):
    with PRINT_LOCK:
        print(json.dumps(msg_dict), flush=True)
gi.require_version('Gst', '1.0')
try:
    gi.require_version('GstWebRTC', '1.0')
except ValueError:
    print(json.dumps({"type": "error", "message": "GstWebRTC not installed. Run: sudo apt install gir1.2-gst-plugins-bad-1.0"}))
    sys.exit(1)
try:
    gi.require_version('GstSdp', '1.0')
except ValueError:
    print(json.dumps({"type": "error", "message": "GstSdp not installed. Run: sudo apt install gir1.2-gst-plugins-bad-1.0"}))
    sys.exit(1)

from gi.repository import Gst, GstWebRTC, GLib, GstSdp
import signal
import dbus

PORTAL_SESSION_HANDLE = None
_backend = None

def cleanup_and_exit(signum, frame):
    global PORTAL_SESSION_HANDLE
    # Stop the pipeline first so streaming threads join before the
    # interpreter tears down (a new-sample callback firing mid-teardown
    # segfaulted here). Then close the portal session and exit.
    try:
        if _backend is not None:
            _backend._thumb_run = False
            if getattr(_backend, 'pipe', None) is not None:
                _backend.pipe.set_state(Gst.State.NULL)
    except Exception:
        pass
    if PORTAL_SESSION_HANDLE:
        try:
            bus = dbus.SessionBus()
            session = bus.get_object("org.freedesktop.portal.Desktop", PORTAL_SESSION_HANDLE)
            session.Close()
        except Exception:
            pass
    sys.exit(0)

signal.signal(signal.SIGTERM, cleanup_and_exit)
signal.signal(signal.SIGINT, cleanup_and_exit)

#  STUN Servers (same pool as host.js) - fallback if /api/turn fails
DEFAULT_STUN_SERVERS = [
    "stun://stun.l.google.com:19302",
    "stun://stun1.l.google.com:19302",
    "stun://stun2.l.google.com:19302",
    "stun://stun3.l.google.com:19302",
    "stun://stun4.l.google.com:19302",
    "stun://stun.cloudflare.com:3478",
]

class GstWebRTCBackend:

    #  XDG Desktop Portal Screencast
    def request_portal_screencast(self):
        bus = dbus.SessionBus()
        sender = bus.get_unique_name()[1:].replace('.', '_')

        token_create = "nearcade_create_" + str(random.randint(100000, 999999))
        req_path_create = f"/org/freedesktop/portal/desktop/request/{sender}/{token_create}"

        token_select = "nearcade_select_" + str(random.randint(100000, 999999))
        req_path_select = f"/org/freedesktop/portal/desktop/request/{sender}/{token_select}"

        token_start = "nearcade_start_" + str(random.randint(100000, 999999))
        req_path_start = f"/org/freedesktop/portal/desktop/request/{sender}/{token_start}"

        portal = bus.get_object("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
        screencast = dbus.Interface(portal, "org.freedesktop.portal.ScreenCast")

        portal_loop = GLib.MainLoop()
        fd_out = None
        node_id_out = None
        session_handle = None

        def on_start_response(response, results):
            nonlocal fd_out, node_id_out
            bus.remove_signal_receiver(on_start_response, signal_name="Response", path=req_path_start)
            if response != 0:
                emit_ipc({"type": "error", "message": f"Start failed: {response}"})
                portal_loop.quit()
                return
            streams = results.get('streams', [])
            if streams:
                node_id_out = int(streams[0][0])
                try:
                    unix_fd = screencast.OpenPipeWireRemote(
                        dbus.ObjectPath(session_handle),
                        dbus.Dictionary(signature='sv')
                    )
                    fd_out = unix_fd.take()
                except Exception as e:
                    emit_ipc({"type": "error", "message": f"OpenPipeWireRemote failed: {e}"})
            portal_loop.quit()

        def on_select_sources_response(response, results):
            bus.remove_signal_receiver(on_select_sources_response, signal_name="Response", path=req_path_select)
            if response != 0:
                emit_ipc({"type": "error", "message": f"SelectSources failed: {response}"})
                portal_loop.quit()
                return
            bus.add_signal_receiver(
                on_start_response, signal_name="Response",
                bus_name="org.freedesktop.portal.Desktop", path=req_path_start
            )
            screencast.Start(
                dbus.ObjectPath(session_handle), "",
                dbus.Dictionary({
                    "handle_token": token_start,
                    "persist_mode": dbus.UInt32(1)  # 1 = persistent (continues when unfocused)
                }, signature='sv')
            )

        def on_create_session_response(response, results):
            nonlocal session_handle
            global PORTAL_SESSION_HANDLE
            bus.remove_signal_receiver(on_create_session_response, signal_name="Response", path=req_path_create)
            if response != 0:
                emit_ipc({"type": "error", "message": f"CreateSession failed: {response}"})
                portal_loop.quit()
                return
            session_str = results.get('session_handle')
            if not session_str:
                portal_loop.quit()
                return
            session_handle = str(session_str)
            PORTAL_SESSION_HANDLE = session_handle
            self._portal_session_handle = session_handle

            # StreamRemoved is handled by the SINGLETON receiver registered in
            # __init__ (_on_portal_stream_removed_signal), matched against
            # self._portal_session_handle. (A per-session nested receiver used
            # to live here: it re-ran selection without rebuilding the
            # pipeline, whose dead fd then re-triggered it — an infinite
            # portal-dialog loop that could only be killed with the app.)

            bus.add_signal_receiver(
                on_select_sources_response, signal_name="Response",
                bus_name="org.freedesktop.portal.Desktop", path=req_path_select
            )
            screencast.SelectSources(
                dbus.ObjectPath(session_handle),
                dbus.Dictionary({
                    "types": dbus.UInt32(1),   # 1=monitor only (persists when unfocused)
                    "multiple": False,
                    "handle_token": token_select
                }, signature='sv')
            )

        bus.add_signal_receiver(
            on_create_session_response, signal_name="Response",
            bus_name="org.freedesktop.portal.Desktop", path=req_path_create
        )
        screencast.CreateSession(
            dbus.Dictionary({"session_handle_token": token_create, "handle_token": token_create}, signature='sv')
        )

        # User has up to 60 s to make a selection
        GLib.timeout_add_seconds(60, portal_loop.quit)
        portal_loop.run()

        # Keep session alive by not closing the session handle
        # The fd should remain valid as long as the session is alive
        return fd_out, node_id_out

    #  Init
    def __init__(self):
        Gst.init(None)
        self.loop = GLib.MainLoop()
        self._answer_received = False
        # Portal auto-recovery state. A dead source re-prompts the portal
        # dialog — strictly bounded, or one flapping source spams dialogs
        # until the app is killed. Attempts older than 120 s don't count.
        self._portal_recoveries = []
        self._portal_recovery_dead = False
        self._last_portal_recovery = 0.0
        self._portal_session_handle = None
        self._rate_timer_started = False
        try:
            _bus = dbus.SessionBus()
            _bus.add_signal_receiver(
                self._on_portal_stream_removed_signal,
                signal_name="StreamRemoved",
                bus_name="org.freedesktop.portal.Desktop",
                path="/org/freedesktop/portal/desktop",
            )
        except Exception as e:
            emit_ipc({"type": "info", "message": f"Portal event listener unavailable: {e}"})

        parser = argparse.ArgumentParser()
        parser.add_argument('--node', type=str, help='PipeWire serial to capture headlessly')
        parser.add_argument('--bitrate', type=int, default=8000, help='Target bitrate in kbps (default 8000)')
        parser.add_argument('--test-src', action='store_true', help='Use videotestsrc instead of portal (headless pipeline check)')
        args, _ = parser.parse_known_args()

        #  Resolve capture source
        # Priority: test source (headless check) > headless PipeWire node > XDG Portal (monitor only)
        if args.test_src:
            capture_element = "videotestsrc is-live=true"
            emit_ipc({"type": "info", "message": "Headless check: videotestsrc instead of portal"})
        elif args.node and not (args.node.startswith('window:') or args.node.startswith('screen:')):
            capture_element = f"pipewiresrc path={args.node} do-timestamp=true"
            emit_ipc({"type": "info", "message": f"Headless PipeWire capture: node {args.node}"})
        else:
            emit_ipc({"type": "info", "message": "Requesting Wayland XDG Portal screen capture..."})
            fd, node_id = self.request_portal_screencast()
            if fd is None:
                emit_ipc({"type": "error", "message": "Portal denied or timed out."})
                sys.exit(1)
            capture_element = f"pipewiresrc fd={fd} path={node_id} do-timestamp=true"
            emit_ipc({"type": "info", "message": f"Portal screen capture: fd={fd} node={node_id}"})
            self._portal_node_id = node_id

        #  Pipeline
        # Notes:
        #  - capsfilter after pipewiresrc allows any raw format through
        #  - videorate stabilises variable-FPS portal streams
        #  - config-interval=-1 embeds SPS/PPS in every keyframe packet
        #  - queue elements prevent blocking between encode and network stages
        #  - stun-server property gives webrtcbin public IP awareness
        # Hardware-only encoding: no software fallback. Probe for a usable
        # H.264 hardware encoder via gst-inspect (ground truth is the element
        # existing, not just the driver). Each entry pairs the encoder with
        # the converter that feeds it portal DMABuf frames:
        #   vah264enc    <- vapostproc    (VA memory zero-copy, verified e2e)
        #   vaapih264enc <- vaapipostproc (classic VA-API path)
        #   nvh264enc / vulkanh264enc <- videoconvert (self-uploading)
        import subprocess
        hw_encoder = None
        encoder_name = None
        hw_convert = None
        hw_caps = None
        for element, name, convert, caps, props_template in [
            ("vah264enc", "vah264enc (VA-API)",
             "vapostproc", "video/x-raw(memory:VAMemory),format=NV12",
             "rate-control=cbr bitrate={bitrate} key-int-max=60"),
            ("vaapih264enc", "vaapih264enc (VA-API)",
             "vaapipostproc", "video/x-raw(memory:VASurface),format=NV12",
             "tune=low-power rate-control=cbr bitrate={bitrate} keyframe-period=30"),
            ("nvh264enc", "nvh264enc (NVENC)",
             "videoconvert", "video/x-raw,format=NV12",
             "preset=low-latency-hq bitrate={bitrate} gop-size=30 rc-mode=cbr"),
            ("vulkanh264enc", "vulkanh264enc (Vulkan)",
             "videoconvert", "video/x-raw,format=NV12",
             "rate-control=cbr bitrate={bitrate} gop-size=30"),
        ]:
            props = props_template.format(bitrate=args.bitrate)
            try:
                found = subprocess.run(
                    ["gst-inspect-1.0", element],
                    capture_output=True, timeout=5).returncode == 0
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
            if not found:
                continue
            if convert != "videoconvert":
                try:
                    post_ok = subprocess.run(
                        ["gst-inspect-1.0", convert],
                        capture_output=True, timeout=5).returncode == 0
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    continue
                if not post_ok:
                    continue
            hw_encoder = f"{element} {props}"
            encoder_name = name
            hw_convert = convert
            hw_caps = caps
            break

        if hw_encoder is None:
            emit_ipc({"type": "error", "message": "no H.264 hardware encoder found (need vah264enc, vaapih264enc, nvh264enc or vulkanh264enc with its converter); GStreamer pipeline requires GPU encoding"})
            sys.exit(1)

        # Store for pipeline rebuild
        self._selected_encoder = element
        self._encoder_name = encoder_name
        self._hw_convert = hw_convert
        self._hw_caps = hw_caps
        self._bitrate = args.bitrate

        emit_ipc({"type": "info", "message": f"Using encoder: {encoder_name}"})
        emit_ipc({"type": "info", "message": "Supported codecs: H264"})

        rtppay = "rtph264pay config-interval=-1 aggregate-mode=zero-latency"
        rtp_caps = "application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000"
            # Pipeline description template - defined as instance attribute to avoid module-level formatting issues
        self._PIPELINE_TEMPLATE = (
            "webrtcbin name=sendrecv bundle-policy=max-bundle\n"
            "\n"
            "{capture_element}\n"
            "  ! tee name=t\n"
            "\n"
            "t. ! queue max-size-time=500000000 leaky=downstream\n"
            "  ! queue max-size-buffers=4 leaky=downstream\n"
            "  ! {hw_convert}\n"
            "  ! capsfilter caps={hw_caps}\n"
            "  ! {hw_encoder}\n"
            "  ! rtph264pay config-interval=-1 aggregate-mode=zero-latency\n"
            "  ! application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000\n"
            "  ! sendrecv.\n"
            "\n"
            "t. ! queue max-size-buffers=1 leaky=downstream\n"
            "  ! videoconvert\n"
            "  ! videoscale ! video/x-raw,width=1280,height=720\n"
            "  ! videorate ! video/x-raw,framerate=60/1\n"
            "  ! jpegenc quality=65\n"
            "  ! appsink name=thumb_sink emit-signals=false max-buffers=1 drop=true sync=false\n"
            "\n"
            "pulsesrc\n"
            "  ! audio/x-raw,rate=48000,channels=1\n"
            "  ! audioconvert ! audioresample\n"
            "  ! opusenc bitrate=128000\n"
            "  ! rtpopuspay\n"
            "  ! application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000\n"
            "  ! queue max-size-time=500000000 leaky=downstream\n"
            "  ! sendrecv."
        )
        # Pipeline description built; parse and launch
        try:
            pipeline_str = self._PIPELINE_TEMPLATE.format(
                capture_element=capture_element,
                hw_convert=hw_convert,
                hw_caps=hw_caps,
                hw_encoder=hw_encoder,
                rtppay=rtppay,
                rtp_caps=rtp_caps
            )
            self.pipe = Gst.parse_launch(pipeline_str)
        except GLib.Error as e:
            emit_ipc({"type": "error", "message": f"Pipeline parse error: {e}"})
            sys.exit(1)

        self.webrtc = self.pipe.get_by_name('sendrecv')

        # Configure ICE servers (STUN + TURN) - fetch from local server
        self._configure_ice_servers()

        # Wire up WebRTC signals
        self.webrtc.connect('on-negotiation-needed', self.on_negotiation_needed)
        self.webrtc.connect('on-ice-candidate', self.send_ice_candidate)

        # Bus error / state listeners
        bus = self.pipe.get_bus()
        bus.add_signal_watch()
        bus.connect('message::error', self.on_bus_error)
        bus.connect('message::state-changed', self.on_state_changed)

        # Thumbnail pump: appsink runs with emit-signals=false and a dedicated
        # thread does blocking pull_sample(). All Python execution stays off
        # the GStreamer streaming threads (a new-sample signal callback
        # segfaulted there). Daemon thread; exits when _thumb_run clears.
        self._thumb_sink = self.pipe.get_by_name("thumb_sink")
        self._thumb_run = False
        if self._thumb_sink is not None:
            emit_ipc({"type": "info", "message": "Thumbnail branch wired"})
            self._thumb_run = True
            self._thumb_gen = getattr(self, '_thumb_gen', 0) + 1
            threading.Thread(target=self._thumb_loop, daemon=True).start()
        else:
            emit_ipc({"type": "error", "message": "preview appsink not found; continuing without thumbnails"})

        # Source-rate heartbeat: pad probe counts buffers entering the tee,
        # reported every 10s by a GLib timer (fires even with zero buffers,
        # so silence itself is the signal). Tells "portal delivers nothing"
        # (source 0/s) apart from "preview branch dead".
        self._src_count = 0
        self._thumb_count = 0
        self._zero_rate_streak = 0  # consecutive 10s periods with 0 source bufs
        tee = self.pipe.get_by_name("t")
        if tee is not None:
            teepad = tee.get_static_pad("sink")
            if teepad is not None:
                teepad.add_probe(Gst.PadProbeType.BUFFER, self._tee_probe)
        self._rate_timer_started = True
        GLib.timeout_add_seconds(10, self._rate_tick)

        ret = self.pipe.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            emit_ipc({"type": "error", "message": "Pipeline failed to start (PLAYING state failed)."})
            sys.exit(1)

    def _tee_probe(self, pad, info):
        self._src_count += 1
        return Gst.PadProbeReturn.OK

    def _portal_node_alive(self):
        # Keepalive distinguisher: is the portal node still there, and in
        # what state? Returns (present, state) where state is the PipeWire
        # node state ('suspended' = compositor paused delivery, e.g.
        # minimized/hidden source; 'idle'/'running' = live) — or (False,
        # None) when gone, or (None, None) when it cannot be told.
        # Never prompts, never raises, runs only on zero-rate windows.
        nid = getattr(self, '_portal_node_id', None)
        if not nid:
            return None, None
        try:
            import shutil
            import subprocess
            import json as _json
            pwcli = shutil.which('pw-cli')
            pw_dump = shutil.which('pw-dump')
            if pw_dump:
                try:
                    out = subprocess.run(
                        [pw_dump, str(nid)],
                        capture_output=True, timeout=8,
                    ).stdout or b''
                    if out.strip():
                        try:
                            items = _json.loads(out.decode('utf-8', 'replace'))
                            if isinstance(items, list):
                                for n in items:
                                    if str(n.get('id', '')) == str(nid):
                                        state = (n.get('info') or {}).get('state')
                                        return True, state
                                return False, None
                        except Exception:
                            pass
                        return True, None
                except Exception:
                    pass
            if not pwcli:
                return None, None
            r = subprocess.run(
                [pwcli, 'info', str(nid)],
                capture_output=True, timeout=8,
            )
            if r.returncode != 0:
                return False, None
            out = (r.stdout or b'').decode('utf-8', 'replace').strip()
            if not out:
                return False, None
            return True, None
        except Exception:
            return None, None

    def _rate_tick(self):
        emit_ipc({"type": "info", "message": f"capture rate: {self._src_count} bufs/10s, thumbnails: {self._thumb_count}/10s"})
        if self._src_count == 0:
            self._zero_rate_streak += 1
            # NOTE: zero buffers does NOT mean a dead source. PipeWire
            # screencast is damage-driven: a static screen (paused game,
            # idle desktop, alt-tabbed-away fullscreen app) legitimately
            # delivers ~0 buffers for minutes. Re-prompting the portal here
            # attacked healthy streams and spammed dialogs, so: probe node
            # existence instead. Gone => bounded recovery. Present/unknown
            # => quiet (static suspected), StreamRemoved still recovers.
            if self._zero_rate_streak == 3:
                present, node_state = self._portal_node_alive()
                if present is False:
                    emit_ipc({"type": "warning", "message": "Portal node gone (keepalive probe) — treating source as dead"})
                    GLib.idle_add(self._recover_portal_full, 'node-gone')
                elif node_state == 'suspended':
                    emit_ipc({"type": "info", "message": "Capture idle: compositor suspended the source (minimized/hidden?) — waiting quietly, no dialogs. Restore the window to resume."})
                else:
                    emit_ipc({"type": "info", "message": "Capture rate zero for 30s — source alive or status unknown, likely a static screen (damage-driven capture idles); NOT re-prompting. StreamRemoved will trigger recovery if the source actually dies."})
        else:
            self._zero_rate_streak = 0
            # Healthy frames flowing: past flaps are forgiven, recovery budget restored.
            self._portal_recoveries = []
            self._portal_recovery_dead = False
        self._src_count = 0
        self._thumb_count = 0
        return True

    def _on_portal_stream_removed_signal(self, session_path, stream_node_id):
        # Singleton StreamRemoved receiver (registered once in __init__).
        try:
            if str(session_path) != str(self._portal_session_handle or ''):
                return
        except Exception:
            return
        emit_ipc({"type": "info", "message": f"Portal stream {stream_node_id} removed (window closed?); scheduling recovery..."})
        GLib.idle_add(self._recover_portal_full, 'stream-removed')

    def _recover_portal_full(self, reason):
        # THE single portal-recovery entry: full dialog flow + pipeline
        # rebuild + fresh WebRTC offer. Strictly bounded — a flapping source
        # must NEVER spam portal dialogs until the app is killed:
        # debounce 10 s, max 3 attempts per 120 s, then stop asking with a
        # clear error until frames flow again (which resets the budget).
        try:
            import time as _time
            now = _time.monotonic()
            if getattr(self, '_portal_recovery_dead', False):
                return False
            if now - getattr(self, '_last_portal_recovery', 0.0) < 10.0:
                return False
            recent = [t for t in getattr(self, '_portal_recoveries', []) if now - t < 120.0]
            if len(recent) >= 3:
                self._portal_recovery_dead = True
                emit_ipc({"type": "error", "message": "Portal source keeps disappearing (3 failed recoveries in 2 min) — auto-recovery stopped. Reselect the source to try again."})
                return False
            self._last_portal_recovery = now
            recent.append(now)
            self._portal_recoveries = recent
            emit_ipc({"type": "info", "message": f"Portal recovery ({reason}): re-prompting for a new source..."})
            try:
                if hasattr(self, 'pipe') and self.pipe:
                    self.pipe.set_state(Gst.State.NULL)
            except Exception:
                pass
            try:
                old_handle = getattr(self, '_portal_session_handle', None)
                if old_handle:
                    _bus = dbus.SessionBus()
                    _obj = _bus.get_object("org.freedesktop.portal.Desktop", old_handle)
                    _obj.Close()
            except Exception:
                pass
            self._rebuild_pipeline_with_new_portal()
        except Exception as e:
            emit_ipc({"type": "error", "message": f"Portal recovery failed: {e}"})
        return False  # one-shot idle callback

    def _restart_portal_session(self):
        # Legacy entry point (zero-rate watchdog). The old body only closed
        # the session and hoped — a dead end. Route into unified recovery.
        self._recover_portal_full('zero-rate')
        return False

    def _rebuild_pipeline_with_new_portal(self):
        """Re-run portal flow and rebuild pipeline with new fd/node_id"""
        emit_ipc({"type": "info", "message": "Rebuilding pipeline with new portal session..."})
        try:
            # Get new fd/node_id from portal
            fd, node_id = self.request_portal_screencast()
            if fd is None:
                emit_ipc({"type": "error", "message": "Portal denied or timed out during restart."})
                return
            
            capture_element = f"pipewiresrc fd={fd} path={node_id} do-timestamp=true"
            emit_ipc({"type": "info", "message": f"Portal screen capture (restarted): fd={fd} node={node_id}"})
            self._portal_node_id = node_id
            
            # Rebuild pipeline with new capture element
            self._rebuild_pipeline(capture_element)
            
        except Exception as e:
            emit_ipc({"type": "error", "message": f"Failed to rebuild pipeline: {e}"})

    def _rebuild_pipeline(self, capture_element):
        """Rebuild the GStreamer pipeline with a new capture element"""
        # Stop current pipeline
        if hasattr(self, 'pipe') and self.pipe:
            self.pipe.set_state(Gst.State.NULL)
        
        # Rebuild encoder props with current bitrate
        hw_encoder = self._build_encoder_props()
        
        # Rebuild pipeline string
        pipeline_str = self._PIPELINE_TEMPLATE.format(
            capture_element=capture_element,
            hw_convert=self._hw_convert,
            hw_caps=self._hw_caps,
            hw_encoder=hw_encoder,
            rtppay="rtph264pay config-interval=-1 aggregate-mode=zero-latency",
            rtp_caps="application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000"
        )
        
        try:
            self.pipe = Gst.parse_launch(pipeline_str)
        except GLib.Error as e:
            emit_ipc({"type": "error", "message": f"Pipeline rebuild parse error: {e}"})
            return
        
        self.webrtc = self.pipe.get_by_name('sendrecv')
        
        # Reconfigure ICE servers
        self._configure_ice_servers()
        
        # Reconnect WebRTC signals
        self.webrtc.connect('on-negotiation-needed', self.on_negotiation_needed)
        self.webrtc.connect('on-ice-candidate', self.send_ice_candidate)
        
        # Reconnect bus
        bus = self.pipe.get_bus()
        bus.add_signal_watch()
        bus.connect('message::error', self.on_bus_error)
        bus.connect('message::state-changed', self.on_state_changed)
        
        # Restart thumbnail pump (bump generation so any stale pump exits)
        self._thumb_sink = self.pipe.get_by_name("thumb_sink")
        self._thumb_run = True
        self._thumb_gen = getattr(self, '_thumb_gen', 0) + 1
        if self._thumb_sink is not None:
            emit_ipc({"type": "info", "message": "Thumbnail branch wired (restarted)"})
            threading.Thread(target=self._thumb_loop, daemon=True).start()
        else:
            emit_ipc({"type": "error", "message": "preview appsink not found; continuing without thumbnails"})
        
        # Re-setup source-rate heartbeat (guard: _rebuild_pipeline runs on
        # every recovery — only ever install ONE 10 s timer).
        self._src_count = 0
        self._thumb_count = 0
        self._zero_rate_streak = 0
        tee = self.pipe.get_by_name("t")
        if tee is not None:
            teepad = tee.get_static_pad("sink")
            if teepad is not None:
                teepad.add_probe(Gst.PadProbeType.BUFFER, self._tee_probe)
        if not getattr(self, '_rate_timer_started', False):
            self._rate_timer_started = True
            GLib.timeout_add_seconds(10, self._rate_tick)
        
        # Set to PLAYING
        ret = self.pipe.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            emit_ipc({"type": "error", "message": "Pipeline rebuild failed to start (PLAYING state failed)."})
            return
        
        emit_ipc({"type": "info", "message": "Pipeline rebuilt and playing with new portal session"})
        # New webrtcbin = new peer connection: solicit a fresh offer so
        # viewers renegotiate instead of staring at a dead transport.
        try:
            self.on_negotiation_needed(self.webrtc)
        except Exception as e:
            emit_ipc({"type": "error", "message": f"Post-rebuild offer failed: {e}"})

    def _build_encoder_props(self):
        """Build encoder properties string with current bitrate"""
        # Find the selected encoder's props template
        import subprocess
        for element, name, convert, caps, props_template in [
            ("vah264enc", "vah264enc (VA-API)",
             "vapostproc", "video/x-raw(memory:VAMemory),format=NV12",
             "rate-control=cbr bitrate={bitrate} key-int-max=60"),
            ("vaapih264enc", "vaapih264enc (VA-API)",
             "vaapipostproc", "video/x-raw(memory:VASurface),format=NV12",
             "tune=low-power rate-control=cbr bitrate={bitrate} keyframe-period=30"),
            ("nvh264enc", "nvh264enc (NVENC)",
             "videoconvert", "video/x-raw,format=NV12",
             "preset=low-latency-hq bitrate={bitrate} gop-size=30 rc-mode=cbr"),
            ("vulkanh264enc", "vulkanh264enc (Vulkan)",
             "videoconvert", "video/x-raw,format=NV12",
             "rate-control=cbr bitrate={bitrate} gop-size=30"),
        ]:
            if element == self._selected_encoder:
                return props_template.format(bitrate=self._bitrate)
        # Fallback
        return f"{self._selected_encoder} rate-control=cbr bitrate={self._bitrate}"

    def _configure_ice_servers(self):
        """Fetch ICE servers from local server and configure webrtcbin with STUN/TURN."""
        import urllib.request
        import json
        import sys
        sys.path.insert(0, '/home/fame/Documents/Nearcade/src/sidecar/capture')
        from ice_servers import STUN_SERVERS

        turn_servers = []

        # Try to fetch TURN credentials from local server
        try:
            req = urllib.request.Request('http://localhost:3000/api/turn')
            req.add_header('User-Agent', 'Nearcade-GStreamer')
            with urllib.request.urlopen(req, timeout=5) as response:
                data = json.loads(response.read().decode('utf-8'))
                if data:
                    if isinstance(data, list):
                        turn_servers.extend(data)
                    else:
                        turn_servers.append(data)
                    emit_ipc({"type": "info", "message": f"Fetched {len(turn_servers)} TURN server(s) from local API"})
        except Exception as e:
            emit_ipc({"type": "info", "message": f"Could not fetch TURN credentials: {e}; using STUN only"})

        # Configure webrtcbin with STUN servers (use first as primary, rest via add-turn-server)
        if STUN_SERVERS:
            # Primary STUN via property
            self.webrtc.set_property("stun-server", STUN_SERVERS[0])
            # Additional STUN servers via add-turn-server signal (libnice supports multiple)
            # STUN servers only need the URL (1 parameter), not username/credential/transport
            for stun in STUN_SERVERS[1:]:
                try:
                    self.webrtc.emit('add-turn-server', stun)
                except Exception as e:
                    emit_ipc({"type": "info", "message": f"Failed to add STUN server {stun}: {e}"})

        # Configure TURN servers via add-turn-server. The action signal takes
        # exactly ONE argument: a full URI with credentials embedded
        # (turn://user:pass@host:port). Passing url/user/pass as separate
        # args fails ("1 parameters needed") and silently drops the relay.
        from urllib.parse import quote
        for turn in turn_servers:
            try:
                urls = turn.get('urls', [])
                if isinstance(urls, str):
                    urls = [urls]
                username = turn.get('username', '')
                credential = turn.get('credential', '')
                for url in urls:
                    if not url:
                        continue
                    scheme, _, rest = str(url).strip().partition(':')
                    if rest.startswith('//'):
                        rest = rest[2:]
                    uri = f"{scheme}://{quote(username, safe='')}:{quote(credential, safe='')}@{rest}"
                    self.webrtc.emit('add-turn-server', uri)
                    emit_ipc({"type": "info", "message": "Added TURN server"})
            except Exception as e:
                emit_ipc({"type": "error", "message": f"Failed to add TURN server: {e}"})

        emit_ipc({"type": "info", "message": f"ICE servers configured ({len(STUN_SERVERS)}x STUN, {len(turn_servers)}x TURN)"})

    def _thumb_loop(self):
        # Blocking pull_sample() on a dedicated thread: safe (plain C call,
        # thread owns its GIL state normally), unlike a signal closure invoked
        # *by* a streaming thread. ~30fps emit cap; faster arrivals are
        # consumed and dropped so the queue never backs up.
        # Generation guard: pipeline rebuilds start a new pump; a stale pump
        # from the previous pipeline must exit instead of spinning forever on
        # a dead sink (and a dead pump must be LOUD — silent thread death
        # used to freeze the preview with zero diagnostics).
        my_gen = getattr(self, '_thumb_gen', 0)
        last = 0.0
        while getattr(self, '_thumb_run', False) and getattr(self, '_thumb_gen', 0) == my_gen:
            try:
                sample = self._thumb_sink.emit("pull-sample")
            except Exception as e:
                emit_ipc({"type": "error", "message": f"Thumbnail pump died (pull-sample raised, gen {my_gen}): {e}"})
                return
            if sample is None:
                if not getattr(self, '_thumb_run', False):
                    return
                time.sleep(0.05)
                continue
            now = time.monotonic()
            if now - last < 0.033:
                continue
            last = now
            try:
                buf = sample.get_buffer()
                if buf is None:
                    continue
                result, mapinfo = buf.map(Gst.MapFlags.READ)
                if not result:
                    continue
                try:
                    b64 = base64.b64encode(mapinfo.data).decode('utf-8')
                finally:
                    buf.unmap(mapinfo)
                emit_ipc({"type": "thumbnail", "data": b64})
                self._thumb_count += 1

                if not hasattr(self, 'frame_count'):
                    self.frame_count = 0
                self.frame_count += 1
                if self.frame_count % 50 == 0:
                    emit_ipc({"type": "info", "message": f"Thumbnail frame {self.frame_count}"})
            except Exception as e:
                emit_ipc({"type": "error", "message": f"Thumbnail error: {e}"})

    #  GStreamer Bus Callbacks
    def on_bus_error(self, bus, message):
        err, debug = message.parse_error()
        emit_ipc({"type": "error", "message": f"GStreamer bus error: {err} | {debug}"})
    def on_state_changed(self, bus, message):
        if message.src != self.pipe:
            return
        old, new, pending = message.parse_state_changed()
        emit_ipc({"type": "info", "message": f"Pipeline state: {old.value_nick} -> {new.value_nick}"})

    #  WebRTC Offer / Answer
    def on_negotiation_needed(self, element):
        emit_ipc({"type": "info", "message": "WebRTC negotiation needed  creating offer"})
        promise = Gst.Promise.new_with_change_func(self.on_offer_created, element, None)
        element.emit('create-offer', None, promise)

    def on_offer_created(self, promise, element, _):
        promise.wait()
        reply = promise.get_reply()
        offer = reply.get_value('offer')

        set_promise = Gst.Promise.new()
        element.emit('set-local-description', offer, set_promise)
        set_promise.interrupt()

        # Wait for ICE gathering so the FIRST offer already carries routable
        # candidates (polled off-thread; capped ~2.4 s, then send whatever we
        # have — trickle covers the rest). Offers sent pre-gathering burned an
        # offer cycle on every join.
        if getattr(self, '_offer_poll_active', False):
            return False
        self._offer_poll_active = True
        self._offer_gather_polls = 0
        GLib.timeout_add(200, self._emit_offer_when_gathered)
        return False

    def _emit_offer_when_gathered(self):
        try:
            state = None
            try:
                state = self.webrtc.get_property('ice-gathering-state')
                state = int(state.value_nick) if hasattr(state, 'value_nick') else int(state)
            except Exception:
                state = None
            # GstWebRTCICE gathering states: 0=new, 1=gathering, 2=complete
            self._offer_gather_polls = getattr(self, '_offer_gather_polls', 0) + 1
            if state != 2 and self._offer_gather_polls < 12:
                return True  # keep polling
            self._offer_poll_active = False
            try:
                local = self.webrtc.get_property('local-description')
                sdp_text = local.sdp.as_text() if local is not None else None
            except Exception:
                sdp_text = None
            if sdp_text:
                n_cands = sdp_text.count('a=candidate:')
                emit_ipc({'type': 'sdp', 'sdp': sdp_text})
                emit_ipc({"type": "info", "message": f"SDP offer sent to server (gathered, {n_cands} candidates)"})
            else:
                emit_ipc({"type": "error", "message": "No local description to offer"})
        except Exception as e:
            self._offer_poll_active = False
            emit_ipc({"type": "error", "message": f"Offer emit failed: {e}"})
        return False

    def send_ice_candidate(self, element, mlineindex, candidate):
        print(json.dumps({
            'type': 'ice',
            'sdpMLineIndex': mlineindex,
            'candidate': candidate
        }), flush=True)

    #  Handle Viewer Answer + ICE
    def handle_incoming_sdp(self, sdp_string):
        try:
            res, sm = GstSdp.SDPMessage.new()
            GstSdp.SDPMessage.parse_buffer(sdp_string.encode(), sm)
            answer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.ANSWER, sm)
            promise = Gst.Promise.new()
            self.webrtc.emit('set-remote-description', answer, promise)
            promise.interrupt()
            emit_ipc({"type": "info", "message": "Remote SDP answer applied"})
            self._answer_received = True
        except Exception as e:
            emit_ipc({"type": "error", "message": f"Failed to apply SDP answer: {e}"})
        return False  # Remove from GLib idle

    def handle_incoming_ice(self, mlineindex, candidate_str):
        try:
            self.webrtc.emit('add-ice-candidate', mlineindex, candidate_str)
        except Exception as e:
            emit_ipc({"type": "error", "message": f"Failed to add ICE candidate: {e}"})
        return False  # Remove from GLib idle

    #  Stdin Reader (Signaling from Node.js  Python)
    def read_stdin(self):
        for raw_line in sys.stdin:
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            try:
                msg = json.loads(raw_line)
            except Exception:
                continue

            msg_type = msg.get('type', '')

            if msg_type == 'answer':
                # Viewer's SDP answer  extract sdp string
                sdp_val = msg.get('sdp', '')
                sdp_str = sdp_val.get('sdp') if isinstance(sdp_val, dict) else str(sdp_val)
                if sdp_str:
                    GLib.idle_add(self.handle_incoming_sdp, sdp_str)

            elif msg_type == 'ice-viewer':
                #
                # CRITICAL: viewer.js sends { type: 'ice-viewer', candidate: RTCIceCandidate }
                # RTCIceCandidate serialises as { candidate: "...", sdpMLineIndex: N, ... }
                # We need the raw candidate SDP line string and the mline index.
                #
                cand_obj = msg.get('candidate', {})
                if isinstance(cand_obj, dict):
                    candidate_str = cand_obj.get('candidate', '')
                    mlineindex = int(cand_obj.get('sdpMLineIndex', 0))
                else:
                    candidate_str = str(cand_obj)
                    mlineindex = int(msg.get('sdpMLineIndex', 0))

                if candidate_str:
                    GLib.idle_add(self.handle_incoming_ice, mlineindex, candidate_str)

    def start(self):
        threading.Thread(target=self.read_stdin, daemon=True).start()
        self.loop.run()

if __name__ == '__main__':
    # Must set DBus main loop before any dbus calls
    DBusGMainLoop(set_as_default=True)
    _backend = GstWebRTCBackend()
    _backend.start()

