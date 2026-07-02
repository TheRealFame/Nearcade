# ==============================================================================
# backend_adaptive.py — Adaptive Controller Backend
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
# Device target:   Microsoft Xbox Adaptive Controller, PS5 Access Controller, or
#                  any custom accessibility switch / joystick arrangement.
#
# Web API:         navigator.getGamepads() — Adaptive Controllers appear as
#                  standard gamepads with variable button/axis counts depending
#                  on what peripherals are plugged into their 3.5mm jacks.
#
# Host Injection:  Xbox 360 / Xbox One controller emulation via uinput (Linux)
#                  or ViGEmBus (Windows). Because adaptive controllers already
#                  present themselves as Xbox-shaped gamepads on the viewer OS,
#                  this backend is essentially identical to the standard gamepad
#                  pipeline, but is kept separate so that accessibility-specific
#                  remapping logic (e.g. axis inversion, button hold delays,
#                  single-switch scanning) can be added without affecting the
#                  main input driver.
#
# Accessibility extensions (planned, not yet implemented):
#   - Axis inversion per-axis
#   - Button hold-to-repeat (for users who cannot release quickly)
#   - "Scanning" mode: a single switch cycles through logical buttons
#
# Packet format (JSON over stdin, one per line):
#   Standard gamepad packet (same as linux_uinput.py receives):
#   {
#     "type":    "gamepad",
#     "buttons": int,   # 16-bit bitmask
#     "axes":    [float, float, float, float],   # LX, LY, RX, RY  -1.0..1.0
#     "lt":      float, # Left trigger  0.0..1.0
#     "rt":      float, # Right trigger 0.0..1.0
#     "pad_id":  str,   # Viewer pad identifier
#   }
#
#   Optional accessibility config packet (send once at start):
#   {
#     "type":        "adaptive-config",
#     "invertAxes":  [int, ...],   # Axis indices to invert, e.g. [1, 3]
#     "holdDelay":   int,          # ms a button must be held before registering (0 = off)
#     "scanMode":    bool,         # Enable single-switch scanning mode
#   }
# ==============================================================================

import sys
import json
import time

# Default accessibility config
_cfg = {
    "invertAxes": [],
    "holdDelay":  0,
    "scanMode":   False,
}

AXIS_MID = 16383
AXIS_MAX = 32767
TRIG_MAX = 255


def _norm_axis(v):
    return max(0, min(AXIS_MAX, int((float(v) + 1.0) / 2.0 * AXIS_MAX)))


def _norm_trig(v):
    return max(0, min(TRIG_MAX, int(float(v) * TRIG_MAX)))


def start_adaptive_backend():
    print("[backend_adaptive] Initializing Adaptive Controller Backend...", flush=True)

    # ------------------------------------------------------------------
    # LINUX (evdev / uinput) — Xbox 360 shaped virtual gamepad
    # ------------------------------------------------------------------
    if sys.platform.startswith("linux"):
        try:
            from evdev import UInput, ecodes as e, AbsInfo

            axis_info_stick = AbsInfo(value=AXIS_MID, min=0, max=AXIS_MAX, fuzz=16, flat=128, resolution=0)
            axis_info_trig  = AbsInfo(value=0, min=0, max=TRIG_MAX,  fuzz=0,  flat=0,   resolution=0)
            axis_info_hat   = AbsInfo(value=0, min=-1, max=1,        fuzz=0,  flat=0,   resolution=0)

            cap = {
                e.EV_KEY: [
                    e.BTN_SOUTH, e.BTN_EAST, e.BTN_NORTH, e.BTN_WEST,
                    e.BTN_TL, e.BTN_TR, e.BTN_TL2, e.BTN_TR2,
                    e.BTN_SELECT, e.BTN_START, e.BTN_MODE,
                    e.BTN_THUMBL, e.BTN_THUMBR,
                ],
                e.EV_ABS: [
                    (e.ABS_X,     axis_info_stick),
                    (e.ABS_Y,     axis_info_stick),
                    (e.ABS_RX,    axis_info_stick),
                    (e.ABS_RY,    axis_info_stick),
                    (e.ABS_Z,     axis_info_trig),
                    (e.ABS_RZ,    axis_info_trig),
                    (e.ABS_HAT0X, axis_info_hat),
                    (e.ABS_HAT0Y, axis_info_hat),
                ],
            }

            BUTTON_CODES = [
                e.BTN_SOUTH, e.BTN_EAST, e.BTN_WEST, e.BTN_NORTH,
                e.BTN_TL, e.BTN_TR, e.BTN_SELECT, e.BTN_START,
                e.BTN_MODE, e.BTN_THUMBL, e.BTN_THUMBR,
                e.BTN_TL2, e.BTN_TR2,
            ]
            DPAD_BITMASKS = {12: (0, -1), 13: (0, 1), 14: (-1, 0), 15: (1, 0)}

            ui = UInput(cap, name="Nearsec Virtual Adaptive Controller", version=0x3)
            print("[backend_adaptive] Virtual adaptive controller created at /dev/uinput.", flush=True)

            for line in sys.stdin:
                try:
                    data = json.loads(line)

                    if data.get("type") == "adaptive-config":
                        _cfg["invertAxes"] = data.get("invertAxes", [])
                        _cfg["holdDelay"]  = int(data.get("holdDelay", 0))
                        _cfg["scanMode"]   = bool(data.get("scanMode", False))
                        print(f"[backend_adaptive] Config updated: {_cfg}", flush=True)
                        continue

                    if data.get("type") != "gamepad":
                        continue

                    # Axes (with optional inversion)
                    raw_axes = data.get("axes", [0, 0, 0, 0])
                    axis_codes = [e.ABS_X, e.ABS_Y, e.ABS_RX, e.ABS_RY]
                    for i, code in enumerate(axis_codes):
                        v = float(raw_axes[i]) if i < len(raw_axes) else 0.0
                        if i in _cfg["invertAxes"]:
                            v = -v
                        ui.write(e.EV_ABS, code, _norm_axis(v))

                    # Triggers
                    ui.write(e.EV_ABS, e.ABS_Z,  _norm_trig(data.get("lt", 0)))
                    ui.write(e.EV_ABS, e.ABS_RZ, _norm_trig(data.get("rt", 0)))

                    # Buttons (bitmask)
                    buttons = int(data.get("buttons", 0))
                    hat_x, hat_y = 0, 0
                    for i, code in enumerate(BUTTON_CODES):
                        if i in DPAD_BITMASKS:
                            if buttons & (1 << i):
                                hat_x, hat_y = DPAD_BITMASKS[i]
                        else:
                            ui.write(e.EV_KEY, code, 1 if (buttons & (1 << i)) else 0)

                    ui.write(e.EV_ABS, e.ABS_HAT0X, hat_x)
                    ui.write(e.EV_ABS, e.ABS_HAT0Y, hat_y)

                    ui.syn()

                except (json.JSONDecodeError, KeyError, ValueError, IndexError):
                    continue

        except ImportError:
            print("[backend_adaptive] Error: 'evdev' module not installed.", file=sys.stderr)
            sys.exit(1)
        except PermissionError:
            print("[backend_adaptive] Error: Permission denied accessing /dev/uinput.", file=sys.stderr)
            sys.exit(1)

    # ------------------------------------------------------------------
    # WINDOWS / macOS — not yet implemented
    # ------------------------------------------------------------------
    else:
        print(
            f"[backend_adaptive] Platform '{sys.platform}' not yet supported. "
            "Windows support requires ViGEmBus.",
            file=sys.stderr,
        )
        for _ in sys.stdin:
            pass
        sys.exit(1)


if __name__ == "__main__":
    start_adaptive_backend()
