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

from gi.repository import Gst, GstWebRTC, GLib
import signal
import dbus

PORTAL_SESSION_HANDLE = None

def cleanup_and_exit(signum, frame):
    global PORTAL_SESSION_HANDLE
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

#  STUN Servers (same pool as host.js)
STUN_SERVER = "stun://stun.l.google.com:19302"

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
                dbus.Dictionary({"handle_token": token_start}, signature='sv')
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
            bus.add_signal_receiver(
                on_select_sources_response, signal_name="Response",
                bus_name="org.freedesktop.portal.Desktop", path=req_path_select
            )
            screencast.SelectSources(
                dbus.ObjectPath(session_handle),
                dbus.Dictionary({
                    "types": dbus.UInt32(3),   # 1=monitor 2=window 3=both
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

        parser = argparse.ArgumentParser()
        parser.add_argument('--node', type=str, help='PipeWire serial to capture headlessly')
        args, _ = parser.parse_known_args()

        #  Resolve capture source
        # Portal tokens (window:X:Y or screen:X:Y) are not headless node IDs.
        # They indicate the user selected a window/screen via the portal.
        # In this case, we must trigger the portal flow to get fd+node_id.
        is_portal_token = args.node and (args.node.startswith('window:') or args.node.startswith('screen:'))

        if args.node and not is_portal_token:
            capture_element = f"pipewiresrc path={args.node} do-timestamp=true"
            emit_ipc({"type": "info", "message": f"Headless PipeWire capture: node {args.node}"})
        else:
            emit_ipc({"type": "info", "message": "Requesting Wayland XDG Portal capture..."})
            fd, node_id = self.request_portal_screencast()
            if fd is None:
                emit_ipc({"type": "error", "message": "Portal denied or timed out."})
                sys.exit(1)
            capture_element = f"pipewiresrc fd={fd} path={node_id} do-timestamp=true"
            emit_ipc({"type": "info", "message": f"Portal capture: fd={fd} node={node_id}"})

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
        for element, name, convert, caps, props in [
            ("vah264enc", "vah264enc (VA-API)",
             "vapostproc", "video/x-raw(memory:VAMemory),format=NV12",
             "rate-control=cbr bitrate=8000 key-int-max=60"),
            ("vaapih264enc", "vaapih264enc (VA-API)",
             "vaapipostproc", "video/x-raw(memory:VASurface),format=NV12",
             "tune=low-power rate-control=cbr bitrate=8000 keyframe-period=30"),
            ("nvh264enc", "nvh264enc (NVENC)",
             "videoconvert", "video/x-raw,format=NV12",
             "preset=low-latency-hq bitrate=8000 gop-size=30 rc-mode=cbr"),
            ("vulkanh264enc", "vulkanh264enc (Vulkan)",
             "videoconvert", "video/x-raw,format=NV12",
             "rate-control=cbr bitrate=8000 gop-size=30"),
        ]:
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

        emit_ipc({"type": "info", "message": f"Using encoder: {encoder_name}"})
        emit_ipc({"type": "info", "message": "Supported codecs: H264"})

        rtppay = "rtph264pay config-interval=-1 aggregate-mode=zero-latency"
        rtp_caps = "application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000"
            # Pipeline description template - defined as instance attribute to avoid module-level formatting issues
        self._PIPELINE_TEMPLATE = (
            "webrtcbin name=sendrecv bundle-policy=max-bundle stun-server={STUN_SERVER}\n"
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
            "  ! appsink name=thumb_sink emit-signals=true max-buffers=1 drop=true sync=false\n"
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
                STUN_SERVER=STUN_SERVER,
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

        # Configure STUN (belt-and-suspenders via property too)
        self.webrtc.set_property("stun-server", STUN_SERVER)

        # Wire up WebRTC signals
        self.webrtc.connect('on-negotiation-needed', self.on_negotiation_needed)
        self.webrtc.connect('on-ice-candidate', self.send_ice_candidate)

        # Bus error / state listeners
        bus = self.pipe.get_bus()
        bus.add_signal_watch()
        bus.connect('message::error', self.on_bus_error)
        bus.connect('message::state-changed', self.on_state_changed)

        # Connect appsink to extract thumbnails
        thumb_sink = self.pipe.get_by_name("thumb_sink")
        if thumb_sink:
            thumb_sink.connect("new-sample", self.on_new_thumbnail)
            emit_ipc({"type": "info", "message": "Thumbnail branch wired"})
        else:
            emit_ipc({"type": "error", "message": "preview appsink not found; continuing without thumbnails"})

        # Source-rate heartbeat: pad probe counts buffers entering the tee,
        # reported every 10s by a GLib timer (fires even with zero buffers,
        # so silence itself is the signal). Tells "portal delivers nothing"
        # (source 0/s) apart from "preview branch dead".
        self._src_count = 0
        self._thumb_count = 0
        tee = self.pipe.get_by_name("t")
        if tee is not None:
            teepad = tee.get_static_pad("sink")
            if teepad is not None:
                teepad.add_probe(Gst.PadProbeType.BUFFER, self._tee_probe)
        GLib.timeout_add_seconds(10, self._rate_tick)

        ret = self.pipe.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            emit_ipc({"type": "error", "message": "Pipeline failed to start (PLAYING state failed)."})
            sys.exit(1)

    def _tee_probe(self, pad, info):
        self._src_count += 1
        return Gst.PadProbeReturn.OK

    def _rate_tick(self):
        emit_ipc({"type": "info", "message": f"capture rate: {self._src_count} bufs/10s, thumbnails: {self._thumb_count}/10s"})
        self._src_count = 0
        self._thumb_count = 0
        return True

    def on_new_thumbnail(self, sink):
        try:
            # Throttle: 60fps cap (~16ms). Drain bursts after stalls.
            now = time.monotonic()
            last = getattr(self, '_last_thumb_ts', 0.0)
            if now - last < 0.016:
                # Drain the sample so the appsink queue doesn't back up.
                sink.emit("pull-sample")
                return Gst.FlowReturn.OK
            sample = sink.emit("pull-sample")
            if not sample:
                return Gst.FlowReturn.OK

            buf = sample.get_buffer()
            result, mapinfo = buf.map(Gst.MapFlags.READ)
            if result:
                b64 = base64.b64encode(mapinfo.data).decode('utf-8')
                emit_ipc({"type": "thumbnail", "data": b64})
                buf.unmap(mapinfo)
                self._last_thumb_ts = now
                self._thumb_count += 1

                if not hasattr(self, 'frame_count'):
                    self.frame_count = 0
                self.frame_count += 1
                if self.frame_count % 50 == 0:
                    emit_ipc({"type": "info", "message": f"Thumbnail frame {self.frame_count}"})

        except Exception as e:
            emit_ipc({"type": "error", "message": f"Thumbnail error: {e}"})
        return Gst.FlowReturn.OK

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

        sdp_text = offer.sdp.as_text()
        emit_ipc({'type': 'sdp', 'sdp': sdp_text})
        emit_ipc({"type": "info", "message": "SDP offer sent to server"})

    def send_ice_candidate(self, element, mlineindex, candidate):
        print(json.dumps({
            'type': 'ice',
            'sdpMLineIndex': mlineindex,
            'candidate': candidate
        }), flush=True)

    #  Handle Viewer Answer + ICE
    def handle_incoming_sdp(self, sdp_string):
        try:
            res, sm = Gst.SDPMessage.new()
            Gst.SDPMessage.parse_buffer(sdp_string.encode(), sm)
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
    backend = GstWebRTCBackend()
    backend.start()

