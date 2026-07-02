# ==============================================================================
# backend_vr.py — WebXR / VR Headset 6-DOF Backend
# ==============================================================================
# SUBJECT TO CHANGE: This code is a forward-looking implementation concept
# based on the DEVICE_SPECS.md and ARCHITECTURE_CONCEPT.md documents. The API
# surface, packet format, and OS injection method may change significantly before
# this backend is activated. Do NOT enable without reviewing against the active
# InputOrchestrator.js implementation.
#
# OPEN TO PULL REQUESTS: If you wish to implement and test this backend
# for your specific hardware, feel free to open a PR!
# ==============================================================================
#
# Device target:   WebXR-compatible VR headsets (Meta Quest, Valve Index via
#                  browser passthrough, etc.). 6-DOF head position + rotation,
#                  plus both hand controllers.
#
# Web API:         WebXR Device API (navigator.xr.requestSession("immersive-vr")).
#                  The viewer JS reads XRFrame pose data at 90 Hz+ and packs
#                  head + left/right hand quaternion + position into each packet.
#
# Host Injection:  Custom C++ SteamVR (OpenVR) driver plugin.
#                  This Python script acts as a UDP bridge:
#                  - Receives JSON from Node.js stdin
#                  - Forwards packed binary 6-DOF data over a local UDP socket
#                    to the SteamVR C++ driver listening on STEAMVR_PORT.
#                  The C++ driver is NOT included here — it is a separate
#                  compiled .so / .dll that must be installed into the SteamVR
#                  drivers directory. This backend is a placeholder relay only.
#
# COMPLEXITY NOTE: This is rated "Extreme" in DEVICE_SPECS.md.
#                  Asynchronous Timewarp (ATW) on the viewer side mitigates
#                  network motion-to-photon latency, but true SteamVR integration
#                  requires the companion native driver.
#
# Packet format (JSON over stdin, one per line):
#   {
#     "head": {
#       "qx": float, "qy": float, "qz": float, "qw": float,  # Quaternion
#       "px": float, "py": float, "pz": float                 # Position (metres)
#     },
#     "left": {   # Left controller — same structure as head
#       "qx": float, "qy": float, "qz": float, "qw": float,
#       "px": float, "py": float, "pz": float,
#       "trigger": float,  # 0.0 – 1.0 analog trigger
#       "grip":    float,  # 0.0 – 1.0 grip
#       "ax": float, "ay": float,  # Thumbstick axes
#       "buttons": int             # Bitmask: bit0=A/X, bit1=B/Y, bit2=menu, bit3=thumbstick click
#     },
#     "right": { ... }   # Same structure as left
#   }
#
# Binary UDP payload sent to SteamVR driver (56 bytes, little-endian):
#   4B  uint32  sequence number
#   7×4B float  head quat(xyzw) + pos(xyz)
#   7×4B float  left quat + pos
#   7×4B float  right quat + pos
#   1B  uint8   button bitmask left
#   1B  uint8   button bitmask right
#   2B  uint8   trigger_l, trigger_r  (0–255)
#   2B  uint8   grip_l,    grip_r     (0–255)
# ==============================================================================

import sys
import json
import struct
import socket

STEAMVR_HOST = "127.0.0.1"
STEAMVR_PORT = 27015   # Agreed port between this script and the C++ SteamVR driver plugin


def _pack_pose(p):
    """Pack a pose dict into 7 floats: qx qy qz qw px py pz."""
    return (
        float(p.get("qx", 0)), float(p.get("qy", 0)),
        float(p.get("qz", 0)), float(p.get("qw", 1)),
        float(p.get("px", 0)), float(p.get("py", 0)),
        float(p.get("pz", 0)),
    )


def _build_packet(seq, data):
    """Pack all 6-DOF + controller state into a compact binary UDP payload."""
    head  = _pack_pose(data.get("head",  {}))
    left  = _pack_pose(data.get("left",  {}))
    right = _pack_pose(data.get("right", {}))

    lc = data.get("left",  {})
    rc = data.get("right", {})

    btn_l   = int(lc.get("buttons", 0)) & 0xFF
    btn_r   = int(rc.get("buttons", 0)) & 0xFF
    trig_l  = max(0, min(255, int(float(lc.get("trigger", 0)) * 255)))
    trig_r  = max(0, min(255, int(float(rc.get("trigger", 0)) * 255)))
    grip_l  = max(0, min(255, int(float(lc.get("grip",    0)) * 255)))
    grip_r  = max(0, min(255, int(float(rc.get("grip",    0)) * 255)))

    # fmt: 1×uint32 + 21×float + 2×uint8 + 4×uint8 = 4 + 84 + 6 = 94 bytes
    return struct.pack(
        "<I21f6B",
        seq,
        *head, *left, *right,
        btn_l, btn_r, trig_l, trig_r, grip_l, grip_r,
    )


def start_vr_backend():
    print("[backend_vr] Initializing WebXR / VR Headset Backend...", flush=True)
    print(
        f"[backend_vr] Forwarding 6-DOF data to SteamVR driver at "
        f"{STEAMVR_HOST}:{STEAMVR_PORT} (C++ driver must be installed separately).",
        flush=True,
    )

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    except OSError as err:
        print(f"[backend_vr] Fatal: Could not open UDP socket: {err}", file=sys.stderr)
        sys.exit(1)

    seq = 0
    for line in sys.stdin:
        try:
            data = json.loads(line)
            packet = _build_packet(seq, data)
            sock.sendto(packet, (STEAMVR_HOST, STEAMVR_PORT))
            seq = (seq + 1) & 0xFFFFFFFF
        except (json.JSONDecodeError, KeyError, ValueError, OSError):
            continue

    sock.close()


if __name__ == "__main__":
    start_vr_backend()
