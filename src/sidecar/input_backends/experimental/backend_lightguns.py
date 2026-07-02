# ==============================================================================
# backend_lightguns.py — Light Gun / Absolute Mouse Backend
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
# Device target:   USB light guns (e.g. Sinden, GUN4IR) or any pointer device
#                  requiring absolute screen-coordinate injection on the host.
#
# Web API:         PointerEvent / MouseEvent. The viewer JS uses the pointer
#                  lock API or raw coordinates within a canvas to obtain
#                  normalised X/Y position and trigger state.
#
#                  KNOWN LIMITATION: Web browsers do not expose raw device
#                  coordinates for hardware light guns — the gun must be
#                  recognised by the viewer OS as a mouse/tablet, and the
#                  viewer JS reads that pointer position from the browser window.
#
# Host Injection:
#   - Linux:   evdev UInput absolute mouse (EV_ABS, INPUT_PROP_DIRECT).
#              This maps pixel coordinates onto the host's primary display.
#              A "host_width" / "host_height" config packet must be sent first
#              so the backend knows the scaling target resolution.
#   - Windows: user32 SendInput with MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE.
#              The Windows absolute coordinate system is 0–65535 regardless of
#              actual resolution, so no config packet is required.
#
# Packet format (JSON over stdin, one per line):
#   Config (send once at start):
#   { "type": "config", "hostW": int, "hostH": int }
#
#   Input events:
#   {
#     "x":       float,  # Normalised 0.0 (left) – 1.0 (right)
#     "y":       float,  # Normalised 0.0 (top)  – 1.0 (bottom)
#     "trigger": int,    # 0 or 1 — primary fire button (left click)
#     "btn2":    int,    # 0 or 1 — secondary button (right click, optional)
#   }
# ==============================================================================

import sys
import json

DEFAULT_HOST_W = 1920
DEFAULT_HOST_H = 1080


def start_lightguns_backend():
    print("[backend_lightguns] Initializing Light Gun / Absolute Mouse Backend...", flush=True)

    host_w = DEFAULT_HOST_W
    host_h = DEFAULT_HOST_H

    # ------------------------------------------------------------------
    # LINUX (evdev / uinput) — absolute pointer device
    # ------------------------------------------------------------------
    if sys.platform.startswith("linux"):
        try:
            from evdev import UInput, ecodes as e, AbsInfo

            # Defer UInput creation until we receive the config packet with
            # the host resolution, so ABS_X / ABS_Y maximums are correct.
            ui = None

            def _create_ui(w, h):
                cap = {
                    e.EV_KEY: [e.BTN_LEFT, e.BTN_RIGHT],
                    e.EV_ABS: [
                        (e.ABS_X, AbsInfo(value=0, min=0, max=w - 1, fuzz=0, flat=0, resolution=0)),
                        (e.ABS_Y, AbsInfo(value=0, min=0, max=h - 1, fuzz=0, flat=0, resolution=0)),
                    ],
                }
                # INPUT_PROP_DIRECT tells the kernel this is a touch/tablet-style
                # absolute device (not a relative mouse), matching light-gun behaviour.
                device = UInput(cap, name="Nearsec Virtual Light Gun", version=0x3)
                device.device.set_absinfo(e.ABS_X, AbsInfo(value=0, min=0, max=w - 1, fuzz=0, flat=0, resolution=0))
                return device

            for line in sys.stdin:
                try:
                    data = json.loads(line)

                    # Config packet — (re)initialise with correct resolution
                    if data.get("type") == "config":
                        host_w = int(data.get("hostW", DEFAULT_HOST_W))
                        host_h = int(data.get("hostH", DEFAULT_HOST_H))
                        if ui:
                            ui.close()
                        ui = _create_ui(host_w, host_h)
                        print(
                            f"[backend_lightguns] Reconfigured for {host_w}x{host_h} host resolution.",
                            flush=True,
                        )
                        continue

                    # Lazily create UInput on first real input if no config was sent
                    if ui is None:
                        ui = _create_ui(host_w, host_h)
                        print(
                            f"[backend_lightguns] Virtual light gun created at /dev/uinput "
                            f"({host_w}x{host_h}).",
                            flush=True,
                        )

                    if "x" in data and "y" in data:
                        px = max(0, min(host_w - 1, int(float(data["x"]) * host_w)))
                        py = max(0, min(host_h - 1, int(float(data["y"]) * host_h)))
                        ui.write(e.EV_ABS, e.ABS_X, px)
                        ui.write(e.EV_ABS, e.ABS_Y, py)

                    if "trigger" in data:
                        ui.write(e.EV_KEY, e.BTN_LEFT, 1 if data["trigger"] else 0)
                    if "btn2" in data:
                        ui.write(e.EV_KEY, e.BTN_RIGHT, 1 if data["btn2"] else 0)

                    ui.syn()

                except (json.JSONDecodeError, KeyError, ValueError):
                    continue

        except ImportError:
            print("[backend_lightguns] Error: 'evdev' module not installed.", file=sys.stderr)
            sys.exit(1)
        except PermissionError:
            print("[backend_lightguns] Error: Permission denied accessing /dev/uinput.", file=sys.stderr)
            sys.exit(1)

    # ------------------------------------------------------------------
    # WINDOWS — user32 SendInput absolute mouse
    # ------------------------------------------------------------------
    elif sys.platform == "win32":
        import ctypes

        print("[backend_lightguns] Using Windows SendInput absolute mouse injection.", flush=True)

        for line in sys.stdin:
            try:
                data = json.loads(line)

                if data.get("type") == "config":
                    # Windows uses 0–65535 regardless of resolution — no action needed
                    continue

                if "x" in data and "y" in data:
                    wx = int(float(data["x"]) * 65535)
                    wy = int(float(data["y"]) * 65535)
                    # MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE = 0x8001
                    ctypes.windll.user32.mouse_event(0x8001, wx, wy, 0, 0)

                if data.get("trigger"):
                    ctypes.windll.user32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
                else:
                    ctypes.windll.user32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP

                if "btn2" in data:
                    code = 0x0008 if data["btn2"] else 0x0010   # RIGHTDOWN / RIGHTUP
                    ctypes.windll.user32.mouse_event(code, 0, 0, 0, 0)

            except (json.JSONDecodeError, KeyError, ValueError):
                continue

    # ------------------------------------------------------------------
    # macOS — not implemented
    # ------------------------------------------------------------------
    else:
        print(
            f"[backend_lightguns] Platform '{sys.platform}' is not yet supported.",
            file=sys.stderr,
        )
        for _ in sys.stdin:
            pass
        sys.exit(1)


if __name__ == "__main__":
    start_lightguns_backend()
