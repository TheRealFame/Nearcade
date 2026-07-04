# ==============================================================================
# backend_eyetracking.py — Eye / Head Tracking Backend
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
# Device target:   Webcam-based eye/gaze tracking (WebGazer.js) or WebXR HMD
#                  head position data. Hardware Tobii devices are NOT accessible
#                  via browser APIs and are not in scope.
#
# Web API:         WebGazer.js (webcam gaze estimation) or WebXR API head pose.
#                  Outputs normalized (0.0–1.0) gaze coordinates on the page.
#
# Host Injection:
#   - Virtual joystick (ABS_X / ABS_Y) — simple cross-game compatibility
#   - FreeTrack / OpenTrack UDP protocol (port 4242) — supported by games that
#     accept TrackIR input (e.g. MSFS, IL-2, DCS World, Euro Truck Sim)
#   The backend defaults to FreeTrack UDP and falls back to a virtual joystick
#   if the UDP send fails or a "--joystick" flag is passed.
#
# FreeTrack protocol (UDP, little-endian floats):
#   Offset 0:  float yaw   (degrees, -180 to 180)
#   Offset 4:  float pitch (degrees, -90  to 90)
#   Offset 8:  float roll  (degrees, -180 to 180)
#   Offset 12: float x     (mm, -100 to 100)
#   Offset 16: float y     (mm, -100 to 100)
#   Offset 20: float z     (mm, -100 to 100)
#   Total: 24 bytes
#
# Packet format (JSON over stdin, one per line):
#   {
#     "gazeX":  float,  # Normalised gaze X 0.0 (left) – 1.0 (right)
#     "gazeY":  float,  # Normalised gaze Y 0.0 (top)  – 1.0 (bottom)
#     "yaw":    float,  # Head yaw   degrees (optional, from WebXR)
#     "pitch":  float,  # Head pitch degrees (optional)
#     "roll":   float,  # Head roll  degrees (optional)
#     "x":      float,  # Head X position mm (optional)
#     "y":      float,  # Head Y position mm (optional)
#     "z":      float,  # Head Z position mm (optional)
#   }
# ==============================================================================

import sys
import json
import struct
import socket

FREETRACK_HOST = "127.0.0.1"
FREETRACK_PORT = 4242   # Standard OpenTrack / FreeTrack UDP output port

AXIS_MID = 16383
AXIS_MAX = 32767


def _gaze_to_yaw_pitch(gaze_x, gaze_y, fov_h=70.0, fov_v=50.0):
    """Convert a normalised gaze point to approximate head yaw/pitch angles."""
    yaw   = (float(gaze_x) - 0.5) * fov_h
    pitch = (float(gaze_y) - 0.5) * fov_v * -1   # Invert: top of screen = look up
    return yaw, pitch


def _build_freetrack_packet(yaw, pitch, roll=0.0, x=0.0, y=0.0, z=0.0):
    """Pack 6-DOF floats into a 24-byte FreeTrack/OpenTrack UDP payload."""
    return struct.pack("<ffffff", float(yaw), float(pitch), float(roll),
                      float(x), float(y), float(z))


def start_eyetracking_backend():
    print("[backend_eyetracking] Initializing Eye / Head Tracking Backend...", flush=True)

    use_joystick = "--joystick" in sys.argv

    # Attempt to open UDP socket for FreeTrack output
    udp_sock = None
    if not use_joystick:
        try:
            udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            print(
                f"[backend_eyetracking] FreeTrack UDP output → {FREETRACK_HOST}:{FREETRACK_PORT}",
                flush=True,
            )
        except OSError as err:
            print(f"[backend_eyetracking] Could not open UDP socket: {err}. Falling back to joystick.", file=sys.stderr)
            use_joystick = True

    # ------------------------------------------------------------------
    # LINUX fallback joystick (evdev / uinput) — used when UDP fails
    # or --joystick flag is passed.
    # ------------------------------------------------------------------
    ui = None
    if use_joystick and sys.platform.startswith("linux"):
        try:
            import uinput
            events = [
                uinput.BTN_JOYSTICK,
                uinput.ABS_X + (0, AXIS_MAX, 0, 0),
                uinput.ABS_Y + (0, AXIS_MAX, 0, 0),
            ]
            ui = uinput.Device(events, name="Nearsec Virtual Eye Tracker", vendor=0x045E, product=0x028E, version=0x0110, bustype=3)
            print("[backend_eyetracking] Virtual joystick fallback created at /dev/uinput.", flush=True)
        except ImportError as err:
            print(f"[backend_eyetracking] Could not create virtual joystick: python-uinput not installed", file=sys.stderr)
            sys.exit(1)
        except Exception as err:
            print(f"[backend_eyetracking] Could not create virtual joystick: {err}", file=sys.stderr)
            sys.exit(1)
    elif use_joystick:
        print(
            f"[backend_eyetracking] Platform '{sys.platform}' does not support virtual joystick fallback.",
            file=sys.stderr,
        )
        sys.exit(1)

    # ------------------------------------------------------------------
    # Main processing loop
    # ------------------------------------------------------------------
    for line in sys.stdin:
        try:
            data = json.loads(line)

            # Resolve yaw/pitch: prefer explicit values, fall back to gaze conversion
            if "yaw" in data and "pitch" in data:
                yaw   = float(data["yaw"])
                pitch = float(data["pitch"])
            elif "gazeX" in data and "gazeY" in data:
                yaw, pitch = _gaze_to_yaw_pitch(data["gazeX"], data["gazeY"])
            else:
                continue

            roll = float(data.get("roll", 0.0))
            hx   = float(data.get("x",    0.0))
            hy   = float(data.get("y",    0.0))
            hz   = float(data.get("z",    0.0))

            if udp_sock:
                packet = _build_freetrack_packet(yaw, pitch, roll, hx, hy, hz)
                udp_sock.sendto(packet, (FREETRACK_HOST, FREETRACK_PORT))

            if ui:
                import uinput
                norm_x = max(0, min(AXIS_MAX, int((yaw   / 180.0 + 0.5) * AXIS_MAX)))
                norm_y = max(0, min(AXIS_MAX, int((pitch /  90.0 + 0.5) * AXIS_MAX)))
                ui.emit(uinput.ABS_X, norm_x, syn=False)
                ui.emit(uinput.ABS_Y, norm_y, syn=True)

        except (json.JSONDecodeError, KeyError, ValueError, OSError):
            continue

    if udp_sock:
        udp_sock.close()


if __name__ == "__main__":
    start_eyetracking_backend()
