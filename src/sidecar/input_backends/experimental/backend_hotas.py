# ==============================================================================
# backend_hotas.py — HOTAS / Flight Stick / Steering Wheel Experimental Backend
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
# Device target:   Flight Sticks, HOTAS (Hands On Throttle And Stick), Steering
#                  Wheels, and any other high-axis-count DirectInput joystick.
#
# Web API:         navigator.getGamepads() — the Gamepad API reads these devices
#                  but may scramble axis IDs compared to native drivers. A
#                  front-end calibration/mapping UI is required before streaming
#                  can be useful. (No Force Feedback over web.)
#
# Host Injection:  Linux: evdev UInput with EV_ABS for 8+ axes + 32 buttons.
#                  Windows: ViGEmBus / vJoy virtual joystick (not yet wired up).
#                  macOS: Not implemented (no viable user-mode HID injection).
#
# Packet format (JSON over stdin, one per line):
#   {
#     "axes":    [float, ...],   # Up to 8 raw axis values, -1.0 to 1.0
#     "buttons": [int, ...],     # Raw button states, 0 or 1, up to 32 entries
#     "hatX":    float,          # POV Hat X axis, -1.0 to 1.0
#     "hatY":    float,          # POV Hat Y axis, -1.0 to 1.0
#   }
# ==============================================================================

import sys
import json

# Maximum axes and buttons the virtual joystick will expose.
MAX_AXES    = 8
MAX_BUTTONS = 32

# Axis scale: map -1.0 → +1.0 to 0 → 32767 (centred at 16383)
AXIS_MAX = 32767
AXIS_MID = 16383


def start_hotas_backend():
    print("[backend_hotas] Initializing HOTAS / Flight Stick Backend...", flush=True)

    # ------------------------------------------------------------------
    # LINUX (evdev / uinput)
    # ------------------------------------------------------------------
    if sys.platform.startswith("linux"):
        try:
            from evdev import UInput, ecodes as e, AbsInfo

            # Build axis capability list dynamically for MAX_AXES axes.
            # Linux ABS_X through ABS_RZ covers the first 6; ABS_THROTTLE
            # and ABS_RUDDER cover extras common on HOTAS hardware.
            abs_codes = [
                e.ABS_X, e.ABS_Y, e.ABS_Z,
                e.ABS_RX, e.ABS_RY, e.ABS_RZ,
                e.ABS_THROTTLE, e.ABS_RUDDER,
            ]
            abs_info = AbsInfo(value=AXIS_MID, min=0, max=AXIS_MAX, fuzz=16, flat=128, resolution=0)

            # Hat (POV) switches map to ABS_HAT0X / ABS_HAT0Y
            hat_info = AbsInfo(value=0, min=-1, max=1, fuzz=0, flat=0, resolution=0)

            cap = {
                e.EV_KEY: list(range(e.BTN_JOYSTICK, e.BTN_JOYSTICK + MAX_BUTTONS)),
                e.EV_ABS: (
                    [(code, abs_info) for code in abs_codes[:MAX_AXES]]
                    + [(e.ABS_HAT0X, hat_info), (e.ABS_HAT0Y, hat_info)]
                ),
            }

            ui = UInput(cap, name="Nearsec Virtual HOTAS", version=0x3)
            print("[backend_hotas] Virtual HOTAS created at /dev/uinput.", flush=True)

            for line in sys.stdin:
                try:
                    data = json.loads(line)

                    # Axes — map -1.0..1.0 → 0..32767
                    for i, val in enumerate(data.get("axes", [])):
                        if i >= MAX_AXES:
                            break
                        mapped = int((float(val) + 1.0) / 2.0 * AXIS_MAX)
                        ui.write(e.EV_ABS, abs_codes[i], max(0, min(AXIS_MAX, mapped)))

                    # Buttons — BTN_JOYSTICK + index
                    for i, state in enumerate(data.get("buttons", [])):
                        if i >= MAX_BUTTONS:
                            break
                        ui.write(e.EV_KEY, e.BTN_JOYSTICK + i, 1 if state else 0)

                    # HAT / POV switch
                    if "hatX" in data:
                        hx = max(-1, min(1, int(float(data["hatX"]))))
                        ui.write(e.EV_ABS, e.ABS_HAT0X, hx)
                    if "hatY" in data:
                        hy = max(-1, min(1, int(float(data["hatY"]))))
                        ui.write(e.EV_ABS, e.ABS_HAT0Y, hy)

                    ui.syn()

                except (json.JSONDecodeError, KeyError, ValueError):
                    continue

        except ImportError:
            print("[backend_hotas] Error: 'evdev' module not installed.", file=sys.stderr)
            sys.exit(1)
        except PermissionError:
            print("[backend_hotas] Error: Permission denied accessing /dev/uinput.", file=sys.stderr)
            sys.exit(1)

    # ------------------------------------------------------------------
    # WINDOWS / macOS — not yet implemented
    # ------------------------------------------------------------------
    else:
        print(
            f"[backend_hotas] Platform '{sys.platform}' not yet supported. "
            "Windows support requires vJoy or ViGEmBus virtual joystick drivers.",
            file=sys.stderr,
        )
        # Drain stdin so Node.js pipe does not block
        for _ in sys.stdin:
            pass
        sys.exit(1)


if __name__ == "__main__":
    start_hotas_backend()
