#!/usr/bin/env python3
"""
GStreamer WebRTC Capture Daemon for Nearcade
=============================================
Receives screen capture via PipeWire portal, encodes via x264enc (stable software),
streams via webrtcbin. Emits thumbnails for host preview.
"""
import os
import sys
import json
import base64
import time
import signal

import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
gi.require_version('GstSdp', '1.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gst, GstWebRTC, GstSdp, GLib

# ── Config ──────────────────────────────────────────────────────────────────────
STUN_SERVER = "stun://stun.l.google.com:19302"

# ── IPC Helpers ─────────────────────────────────────────────────────────────────
def emit_ipc(obj):
    """Emit JSON line to stdout for Electron CaptureManager."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

class GstWebRTCapture:
    def __init__(self, source_id=None, source_name=None):
        self.source_id = source_id
        self.source_name = source_name
        self.pipe = None
        self.webrtc = None
        self._last_thumb_ts = 0.0
        self.frame_count = 0

    def build_pipeline(self):
        # Determine capture element
        if self.source_id:
            capture_element = f"pipewiresrc path={self.source_id} do-timestamp=true"
        else:
            capture_element = "pipewiresrc do-timestamp=true"

        # Force Software Encoder (x264enc) for all Linux captures.
        # Hardware encoders like vaapih264enc frequently crash the GStreamer pipeline
        # during DMABuf memory uploads, which kills both WebRTC and the thumbnail feed.
        hw_encoder = "x264enc tune=zerolatency speed-preset=ultrafast byte-stream=true"
        emit_ipc({"type": "info", "message": "Using stable Software Encoder (x264enc)"})

        PIPELINE_DESC = f"""
            webrtcbin name=sendrecv bundle-policy=max-bundle stun-server={STUN_SERVER}
            
            {capture_element} do-timestamp=true
              ! video/x-raw ! videoconvert
              ! tee name=t
              
            t. ! queue max-size-time=500000000 leaky=downstream
              ! videoconvert
              ! {hw_encoder}
              ! rtph264pay config-interval=-1 aggregate-mode=zero-latency
              ! application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000
              ! sendrecv.
              
            t. ! queue max-size-buffers=1 leaky=downstream
              ! videoconvert
              ! videoscale ! video/x-raw,width=480,height=270
              ! videorate ! video/x-raw,framerate=15/1
              ! jpegenc quality=70
              ! appsink name=thumb_sink emit-signals=true max-buffers=1 drop=true sync=false
              
            pulsesrc
              ! audio/x-raw,rate=48000,channels=1
              ! audioconvert ! audioresample
              ! opusenc bitrate=128000
              ! rtpopuspay
              ! application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000
              ! queue max-size-time=500000000 leaky=downstream
              ! sendrecv.
        """

        try:
            self.pipe = Gst.parse_launch(PIPELINE_DESC)
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

        ret = self.pipe.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            emit_ipc({"type": "error", "message": "Pipeline failed to start (PLAYING state failed)."})
            sys.exit(1)

    def on_new_thumbnail(self, sink):
        try:
            # Throttle: 15fps cap (~66ms). Drain bursts after stalls.
            now = time.monotonic()
            last = getattr(self, '_last_thumb_ts', 0.0)
            if now - last < 0.066:
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
                
                if not hasattr(self, 'frame_count'):
                    self.frame_count = 0
                self.frame_count += 1
                if self.frame_count % 50 == 0:
                    emit_ipc({"type": "info", "message": f"Thumbnail frame {self.frame_count}"})
            
        except Exception as e:
            emit_ipc({"type": "error", "message": f"Thumbnail error: {e}"})
        return Gst.FlowReturn.OK

    # ── GStreamer Bus Callbacks ────────────────────────────────────────────────
    def on_bus_error(self, bus, message):
        err, debug = message.parse_error()
        pass

    def on_state_changed(self, bus, message):
        if message.src != self.pipe:
            return
        old, new, pending = message.parse_state_changed()
        emit_ipc({"type": "info", "message": f"Pipeline state: {old.value_nick} -> {new.value_nick}"})

    # ── WebRTC Offer / Answer ─────────────────────────────────────────────────
    def on_negotiation_needed(self, element):
        emit_ipc({"type": "info", "message": "WebRTC negotiation needed — creating offer"})
        promise = Gst.Promise.new_with_change_func(self.on_offer_created, element, None)
        element.emit('create-offer', None, promise)

    def on_offer_created(self, promise, element, _):
        promise.wait()
        reply = promise.get_reply()
        offer = reply.get_value('offer')
        element.set_local_description(offer)
        sdp_text = offer.sdp.as_text()
        emit_ipc({"type": "sdp", "data": sdp_text})

    def send_ice_candidate(self, element, mlineindex, candidate):
        cand_text = candidate.to_string()
        emit_ipc({"type": "ice", "mlineindex": mlineindex, "candidate": cand_text})

    def handle_answer(self, sdp_text):
        sdp = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(bytes(sdp_text, 'utf-8'), sdp)
        answer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.ANSWER, sdp)
        promise = Gst.Promise.new()
        self.webrtc.emit('set-remote-description', answer, promise)
        promise.interrupt()

    def handle_ice(self, mlineindex, candidate_text):
        candidate = GstSdp.SDPMessage.new()
        # Parse candidate
        from gi.repository import GstSdp as GstSdpMod
        cand = GstSdpMod.SDPCandidate()
        cand.parse(candidate_text)
        self.webrtc.emit('add-ice-candidate', mlineindex, cand)

    def run(self):
        loop = GLib.MainLoop()
        try:
            loop.run()
        except KeyboardInterrupt:
            pass
        finally:
            if self.pipe:
                self.pipe.set_state(Gst.State.NULL)

def main():
    Gst.init(None)
    Gst.debug_set_active(False)
    Gst.debug_set_default_threshold(0)

    # Parse args from CaptureManager
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-id', default=None)
    parser.add_argument('--source-name', default=None)
    args = parser.parse_args()

    cap = GstWebRTCapture(source_id=args.source_id, source_name=args.source_name)
    cap.build_pipeline()
    emit_ipc({"type": "ready", "message": "GStreamer WebRTC pipeline running"})
    cap.run()

if __name__ == '__main__':
    main()
