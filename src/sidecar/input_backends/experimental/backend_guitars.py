# ==============================================================================
# backend_guitars.py — Guitar Hero / Rock Band Rhythm Controller Backend
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
# Device target:   Guitar Hero controllers, Rock Band guitars, and similar
#                  rhythm game peripherals presented via the Gamepad API.
#
# Web API:         navigator.getGamepads() — guitars appear as standard gamepads.
#                  Only a custom fret-to-button mapping layer is needed.
#
# Host Injection:  Xbox 360 emulation via uinput (Linux) or ViGEmBus (Windows).
#                  Games (GH/RB clones) natively accept Xbox controller shapes.
#
# Mapping concept (Guitar Hero standard layout):
#   Fret Green  → A  (BTN_SOUTH)
#   Fret Red    → B  (BTN_EAST)
#   Fret Yellow → Y  (BTN_NORTH)
#   Fret Blue   → X  (BTN_WEST)
#   Fret Orange → LB (BTN_TL)
#   Strum Up    → D-Pad Up
#   Strum Down  → D-Pad Down
#   Whammy Bar  → Right Stick Y axis (ABS_RY)
#   Star Power  → RB (BTN_TR)
#   Start       → Start (BTN_START)
#   Select      → Back  (BTN_SELECT)
#
# Packet format (JSON over stdin, one per line):
#   {
#     "frets":   [int, int, int, int, int],  # G, R, Y, B, O — 0 or 1
#     "strum":   int,                         # -1 down, 0 none, 1 up
#     "whammy":  float,                       # 0.0 – 1.0
#     "star":    int,                         # 0 or 1 (tilt / star power)
#     "start":   int,
#     "select":  int,
#   }
# ==============================================================================

import sys
import json

# Fret button → Xbox-like button code mapping index (matches uinput Xbox layout)
# Order: Green, Red, Yellow, Blue, Orange
FRET_MAP = [0, 1, 3, 2, 4]   # South, East, North, West, TL

AXIS_MID = 16383
AXIS_MAX = 32767


def start_guitars_backend():
    print("[backend_guitars] Initializing Guitar / Rhythm Controller Backend...", flush=True)

    # ------------------------------------------------------------------
    # LINUX (evdev / uinput)  — Xbox 360 shaped virtual gamepad
    # ------------------------------------------------------------------
    if sys.platform.startswith("linux"):
        try:
            from evdev import UInput, ecodes as e, AbsInfo

            axis_info_stick = AbsInfo(value=AXIS_MID, min=0, max=AXIS_MAX, fuzz=16, flat=128, resolution=0)
            axis_info_hat   = AbsInfo(value=0, min=-1, max=1, fuzz=0, flat=0, resolution=0)
            axis_info_trig  = AbsInfo(value=0, min=0, max=255, fuzz=0, flat=0, resolution=0)

            cap = {
                e.EV_KEY: [
                    e.BTN_SOUTH, e.BTN_EAST, e.BTN_NORTH, e.BTN_WEST,
                    e.BTN_TL, e.BTN_TR,
                    e.BTN_SELECT, e.BTN_START, e.BTN_MODE,
                    e.BTN_THUMBL, e.BTN_THUMBR,
                ],
                e.EV_ABS: [
                    (e.ABS_X,      axis_info_stick),
                    (e.ABS_Y,      axis_info_stick),
                    (e.ABS_RX,     axis_info_stick),
                    (e.ABS_RY,     axis_info_stick),   # Whammy bar
                    (e.ABS_Z,      axis_info_trig),
                    (e.ABS_RZ,     axis_info_trig),
                    (e.ABS_HAT0X,  axis_info_hat),
                    (e.ABS_HAT0Y,  axis_info_hat),
                ],
            }

            btn_codes = [
                e.BTN_SOUTH, e.BTN_EAST, e.BTN_NORTH, e.BTN_WEST,
                e.BTN_TL,    e.BTN_TR,
            ]

            ui = UInput(cap, name="Nearsec Virtual Guitar", version=0x3)
            print("[backend_guitars] Virtual guitar controller created at /dev/uinput.", flush=True)

            for line in sys.stdin:
                try:
                    data = json.loads(line)

                    # Fret buttons
                    for i, state in enumerate(data.get("frets", [])):
                        if i >= len(FRET_MAP):
                            break
                        ui.write(e.EV_KEY, btn_codes[FRET_MAP[i]], 1 if state else 0)

                    # Strum bar → D-Pad Y hat
                    strum = data.get("strum", 0)
                    ui.write(e.EV_ABS, e.ABS_HAT0Y, -max(-1, min(1, int(strum))))

                    # Whammy bar → ABS_RY (inverted: rest = max, pressed = 0)
                    if "whammy" in data:
                        whammy_mapped = int((1.0 - float(data["whammy"])) * AXIS_MAX)
                        ui.write(e.EV_ABS, e.ABS_RY, max(0, min(AXIS_MAX, whammy_mapped)))

                    # Star Power / tilt → BTN_TR
                    if "star" in data:
                        ui.write(e.EV_KEY, e.BTN_TR, 1 if data["star"] else 0)

                    if "start" in data:
                        ui.write(e.EV_KEY, e.BTN_START, 1 if data["start"] else 0)
                    if "select" in data:
                        ui.write(e.EV_KEY, e.BTN_SELECT, 1 if data["select"] else 0)

                    ui.syn()

                except (json.JSONDecodeError, KeyError, ValueError):
                    continue

        except ImportError:
            print("[backend_guitars] Error: 'evdev' module not installed.", file=sys.stderr)
            sys.exit(1)
        except PermissionError:
            print("[backend_guitars] Error: Permission denied accessing /dev/uinput.", file=sys.stderr)
            sys.exit(1)

    # ------------------------------------------------------------------
    # WINDOWS / macOS — not yet implemented
    # ------------------------------------------------------------------
    else:
        print(
            f"[backend_guitars] Platform '{sys.platform}' not yet supported. "
            "Windows support requires ViGEmBus.",
            file=sys.stderr,
        )
        for _ in sys.stdin:
            pass
        sys.exit(1)


if __name__ == "__main__":
    start_guitars_backend()
