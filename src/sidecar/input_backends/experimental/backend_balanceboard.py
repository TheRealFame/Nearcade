# ==============================================================================
# backend_balanceboard.py — Balance Board / Wii Balance Board Backend
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
# Device target:   Wii Balance Board or similar 4-sensor weight platform.
#
# Web API:         Web Bluetooth or standard Gamepad API (OS-dependent pairing).
#                  The viewer JS reads 4-corner weight sensors and computes CoG.
#
# Host Injection:  Python uinput emitting ABS_X / ABS_Y as a virtual joystick,
#                  representing the Center of Gravity (CoG) on both axes.
#
# CoG calculation (performed on viewer side before sending):
#   cog_x = (topRight + bottomRight) - (topLeft + bottomLeft)   — normalised -1..1
#   cog_y = (topLeft  + topRight)    - (bottomLeft + bottomRight) — normalised -1..1
#
# Packet format (JSON over stdin, one per line):
#   {
#     "cogX":  float,  # Center of Gravity X, -1.0 (left) to 1.0 (right)
#     "cogY":  float,  # Center of Gravity Y, -1.0 (forward) to 1.0 (back)
#     "total": float,  # Total weight / pressure, 0.0 to 1.0 (optional)
#   }
#
#   Optional raw sensor passthrough (for host-side CoG computation):
#   {
#     "tl": float,  "tr": float,  # Top-Left, Top-Right weight 0.0–1.0
#     "bl": float,  "br": float,  # Bottom-Left, Bottom-Right weight 0.0–1.0
#   }
# ==============================================================================

import sys
import json

AXIS_MID = 16383
AXIS_MAX = 32767


def _cog_from_sensors(data):
    """Compute CoG from raw four-corner sensor values if present."""
    tl = float(data.get("tl", 0))
    tr = float(data.get("tr", 0))
    bl = float(data.get("bl", 0))
    br = float(data.get("br", 0))
    total = tl + tr + bl + br
    if total < 0.001:
        return 0.0, 0.0
    cog_x = ((tr + br) - (tl + bl)) / total
    cog_y = ((tl + tr) - (bl + br)) / total
    return max(-1.0, min(1.0, cog_x)), max(-1.0, min(1.0, cog_y))


def _norm_to_axis(v):
    """Map -1.0..1.0 to 0..32767."""
    return max(0, min(AXIS_MAX, int((float(v) + 1.0) / 2.0 * AXIS_MAX)))


def start_balanceboard_backend():
    print("[backend_balanceboard] Initializing Balance Board Backend...", flush=True)

    # ------------------------------------------------------------------
    # LINUX (evdev / uinput)
    # ------------------------------------------------------------------
    if sys.platform.startswith("linux"):
        try:
            from evdev import UInput, ecodes as e, AbsInfo

            axis_info = AbsInfo(value=AXIS_MID, min=0, max=AXIS_MAX, fuzz=8, flat=64, resolution=0)
            trig_info = AbsInfo(value=0, min=0, max=255, fuzz=0, flat=0, resolution=0)

            cap = {
                e.EV_KEY: [e.BTN_A],          # "A" = board pressed / weight detected
                e.EV_ABS: [
                    (e.ABS_X,  axis_info),     # CoG horizontal
                    (e.ABS_Y,  axis_info),     # CoG vertical
                    (e.ABS_Z,  trig_info),     # Total weight mapped to 0–255
                ],
            }

            ui = UInput(cap, name="Nearsec Virtual Balance Board", version=0x3)
            print("[backend_balanceboard] Virtual balance board created at /dev/uinput.", flush=True)

            for line in sys.stdin:
                try:
                    data = json.loads(line)

                    # Prefer pre-computed CoG; fall back to raw sensor passthrough
                    if "cogX" in data or "cogY" in data:
                        cog_x = float(data.get("cogX", 0.0))
                        cog_y = float(data.get("cogY", 0.0))
                    else:
                        cog_x, cog_y = _cog_from_sensors(data)

                    ui.write(e.EV_ABS, e.ABS_X, _norm_to_axis(cog_x))
                    ui.write(e.EV_ABS, e.ABS_Y, _norm_to_axis(cog_y))

                    # Total weight → Z axis (presence / weight magnitude)
                    if "total" in data:
                        total_mapped = int(float(data["total"]) * 255)
                        ui.write(e.EV_ABS, e.ABS_Z, max(0, min(255, total_mapped)))
                        # BTN_A signals "board is being stood on"
                        ui.write(e.EV_KEY, e.BTN_A, 1 if float(data["total"]) > 0.05 else 0)

                    ui.syn()

                except (json.JSONDecodeError, KeyError, ValueError):
                    continue

        except ImportError:
            print("[backend_balanceboard] Error: 'evdev' module not installed.", file=sys.stderr)
            sys.exit(1)
        except PermissionError:
            print("[backend_balanceboard] Error: Permission denied accessing /dev/uinput.", file=sys.stderr)
            sys.exit(1)

    # ------------------------------------------------------------------
    # WINDOWS / macOS — not yet implemented
    # ------------------------------------------------------------------
    else:
        print(
            f"[backend_balanceboard] Platform '{sys.platform}' is not yet supported.",
            file=sys.stderr,
        )
        for _ in sys.stdin:
            pass
        sys.exit(1)


if __name__ == "__main__":
    start_balanceboard_backend()
