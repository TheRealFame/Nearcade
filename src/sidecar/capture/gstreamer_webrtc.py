#!/usr/bin/env python3
# ==============================================================================
# gstreamer_webrtc.py — Native GStreamer WebRTC Backend
# ==============================================================================
# Handles WebRTC signaling (SDP Offers/Answers + ICE) and capture via
# PipeWire. Falls back to XDG Desktop Portal if no headless node is found.
# ==============================================================================

import sys
import json
import threading
import argparse
import random

import dbus
from dbus.mainloop.glib import DBusGMainLoop

import gi
gi.require_version('Gst', '1.0')
try:
    gi.require_version('GstWebRTC', '1.0')
except ValueError:
    print(json.dumps({"type": "error", "message": "GstWebRTC not installed. Run: sudo apt install gir1.2-gst-plugins-bad-1.0"}))
    sys.exit(1)

from gi.repository import Gst, GstWebRTC, GLib

# ─── STUN Servers (same pool as host.js) ──────────────────────────────────────
STUN_SERVER = "stun://stun.l.google.com:19302"


class GstWebRTCBackend:

    # ── XDG Desktop Portal Screencast ─────────────────────────────────────────
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
                print(json.dumps({"type": "error", "message": f"Start failed: {response}"}), flush=True)
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
                    print(json.dumps({"type": "error", "message": f"OpenPipeWireRemote failed: {e}"}), flush=True)
            portal_loop.quit()

        def on_select_sources_response(response, results):
            bus.remove_signal_receiver(on_select_sources_response, signal_name="Response", path=req_path_select)
            if response != 0:
                print(json.dumps({"type": "error", "message": f"SelectSources failed: {response}"}), flush=True)
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
            bus.remove_signal_receiver(on_create_session_response, signal_name="Response", path=req_path_create)
            if response != 0:
                print(json.dumps({"type": "error", "message": f"CreateSession failed: {response}"}), flush=True)
                portal_loop.quit()
                return
            session_str = results.get('session_handle')
            if not session_str:
                portal_loop.quit()
                return
            session_handle = str(session_str)
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
        return fd_out, node_id_out

    # ── Init ──────────────────────────────────────────────────────────────────
    def __init__(self):
        Gst.init(None)
        self.loop = GLib.MainLoop()
        self._answer_received = False

        parser = argparse.ArgumentParser()
        parser.add_argument('--node', type=str, help='PipeWire serial to capture headlessly')
        args, _ = parser.parse_known_args()

        # ── Resolve capture source ─────────────────────────────────────────
        if args.node:
            capture_element = f"pipewiresrc target-object={args.node}"
            print(json.dumps({"type": "info", "message": f"Headless PipeWire capture: node {args.node}"}), flush=True)
        else:
            print(json.dumps({"type": "info", "message": "Requesting Wayland XDG Portal capture..."}), flush=True)
            fd, node_id = self.request_portal_screencast()
            if fd is None:
                print(json.dumps({"type": "error", "message": "Portal denied or timed out."}), flush=True)
                sys.exit(1)
            capture_element = f"pipewiresrc fd={fd} path={node_id}"
            print(json.dumps({"type": "info", "message": f"Portal capture: fd={fd} node={node_id}"}), flush=True)

        # ── Pipeline ───────────────────────────────────────────────────────
        # Notes:
        #  - capsfilter after pipewiresrc allows any raw format through
        #  - videorate stabilises variable-FPS portal streams
        #  - config-interval=-1 embeds SPS/PPS in every keyframe packet
        #  - queue elements prevent blocking between encode and network stages
        #  - stun-server property gives webrtcbin public IP awareness
        PIPELINE_DESC = f"""
            webrtcbin name=sendrecv bundle-policy=max-bundle stun-server={STUN_SERVER}
            {capture_element} do-timestamp=true
              ! video/x-raw ! videoconvert ! videorate
              ! video/x-raw,framerate=30/1
              ! x264enc tune=zerolatency bitrate=4000 speed-preset=ultrafast
                  key-int-max=60
              ! rtph264pay config-interval=-1 aggregate-mode=zero-latency
              ! application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000
              ! queue max-size-time=200000000
              ! sendrecv.
            pulsesrc
              ! audio/x-raw,rate=48000,channels=1
              ! audioconvert ! audioresample
              ! opusenc bitrate=128000
              ! rtpopuspay
              ! application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000
              ! queue max-size-time=200000000
              ! sendrecv.
        """

        try:
            self.pipe = Gst.parse_launch(PIPELINE_DESC)
        except GLib.Error as e:
            print(json.dumps({"type": "error", "message": f"Pipeline parse error: {e}"}), flush=True)
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

        ret = self.pipe.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            print(json.dumps({"type": "error", "message": "Pipeline failed to start (PLAYING state failed)."}), flush=True)
            sys.exit(1)

    # ── GStreamer Bus Callbacks ────────────────────────────────────────────────
    def on_bus_error(self, bus, message):
        err, debug = message.parse_error()
        print(json.dumps({"type": "error", "message": f"GST: {err.message}", "debug": debug}), flush=True)

    def on_state_changed(self, bus, message):
        if message.src != self.pipe:
            return
        old, new, pending = message.parse_state_changed()
        print(json.dumps({"type": "info", "message": f"Pipeline state: {old.value_nick} -> {new.value_nick}"}), flush=True)

    # ── WebRTC Offer / Answer ─────────────────────────────────────────────────
    def on_negotiation_needed(self, element):
        print(json.dumps({"type": "info", "message": "WebRTC negotiation needed — creating offer"}), flush=True)
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
        print(json.dumps({'type': 'sdp', 'sdp': sdp_text}), flush=True)
        print(json.dumps({"type": "info", "message": "SDP offer sent to server"}), flush=True)

    def send_ice_candidate(self, element, mlineindex, candidate):
        print(json.dumps({
            'type': 'ice',
            'sdpMLineIndex': mlineindex,
            'candidate': candidate
        }), flush=True)

    # ── Handle Viewer Answer + ICE ─────────────────────────────────────────────
    def handle_incoming_sdp(self, sdp_string):
        try:
            res, sm = Gst.SDPMessage.new()
            Gst.SDPMessage.parse_buffer(sdp_string.encode(), sm)
            answer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.ANSWER, sm)
            promise = Gst.Promise.new()
            self.webrtc.emit('set-remote-description', answer, promise)
            promise.interrupt()
            print(json.dumps({"type": "info", "message": "Remote SDP answer applied"}), flush=True)
            self._answer_received = True
        except Exception as e:
            print(json.dumps({"type": "error", "message": f"Failed to apply SDP answer: {e}"}), flush=True)
        return False  # Remove from GLib idle

    def handle_incoming_ice(self, mlineindex, candidate_str):
        try:
            self.webrtc.emit('add-ice-candidate', mlineindex, candidate_str)
        except Exception as e:
            print(json.dumps({"type": "error", "message": f"Failed to add ICE candidate: {e}"}), flush=True)
        return False  # Remove from GLib idle

    # ── Stdin Reader (Signaling from Node.js → Python) ────────────────────────
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
                # Viewer's SDP answer — extract sdp string
                sdp_val = msg.get('sdp', '')
                sdp_str = sdp_val.get('sdp') if isinstance(sdp_val, dict) else str(sdp_val)
                if sdp_str:
                    GLib.idle_add(self.handle_incoming_sdp, sdp_str)

            elif msg_type == 'ice-viewer':
                # ──────────────────────────────────────────────────────────────
                # CRITICAL: viewer.js sends { type: 'ice-viewer', candidate: RTCIceCandidate }
                # RTCIceCandidate serialises as { candidate: "...", sdpMLineIndex: N, ... }
                # We need the raw candidate SDP line string and the mline index.
                # ──────────────────────────────────────────────────────────────
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
