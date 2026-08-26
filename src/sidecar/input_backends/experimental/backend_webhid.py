# ==============================================================================
# backend_webhid.py — Raw WebHID DualSense/Switch Passthrough (1000Hz)
# ==============================================================================
# This backend receives raw USB `inputreport` byte arrays straight from the 
# browser via the WebRTC DataChannel. It completely bypasses the browser's 
# 4ms `setInterval` clamp and the Gamepad API's mapping logic.
#
# Because WebHID fires an interrupt exactly when the controller pushes data,
# this pipeline achieves true 1000Hz (1ms) eSports latency.
# ==============================================================================

import sys
import json
import base64

AXIS_MID = 16383
AXIS_MAX = 32767

def start_webhid_backend():
    print("[backend_webhid] Initializing Raw WebHID eSports Backend (1000Hz)...", flush=True)

    if sys.platform.startswith("linux"):
        try:
            from evdev import UInput, ecodes as e, AbsInfo

            axis_info_stick = AbsInfo(value=AXIS_MID, min=0, max=AXIS_MAX, fuzz=16, flat=128, resolution=0)
            axis_info_hat   = AbsInfo(value=0, min=-1, max=1, fuzz=0, flat=0, resolution=0)
            axis_info_trig  = AbsInfo(value=0, min=0, max=255, fuzz=0, flat=0, resolution=0)

            cap = {
                e.EV_KEY: [
                    e.BTN_SOUTH, e.BTN_EAST, e.BTN_NORTH, e.BTN_WEST,
                    e.BTN_TL, e.BTN_TR, e.BTN_TL2, e.BTN_TR2,
                    e.BTN_SELECT, e.BTN_START, e.BTN_MODE,
                    e.BTN_THUMBL, e.BTN_THUMBR,
                ],
                e.EV_ABS: [
                    (e.ABS_X,      axis_info_stick),
                    (e.ABS_Y,      axis_info_stick),
                    (e.ABS_RX,     axis_info_stick),
                    (e.ABS_RY,     axis_info_stick),
                    (e.ABS_Z,      axis_info_trig),
                    (e.ABS_RZ,     axis_info_trig),
                    (e.ABS_HAT0X,  axis_info_hat),
                    (e.ABS_HAT0Y,  axis_info_hat),
                ],
            }

            ui = UInput(cap, name="Nearsec Virtual WebHID", version=0x3)
            print("[backend_webhid] Virtual WebHID controller created at /dev/uinput.", flush=True)

            # DPAD mapping for DualSense (0 = N, 1 = NE, 2 = E, 3 = SE, 4 = S, 5 = SW, 6 = W, 7 = NW, 8 = None)
            dpad_map = {
                0: (0, -1), 1: (1, -1), 2: (1, 0), 3: (1, 1),
                4: (0, 1), 5: (-1, 1), 6: (-1, 0), 7: (-1, -1), 8: (0, 0)
            }

            for line in sys.stdin:
                try:
                    data = json.loads(line)
                    if data.get("type") != "webhid":
                        continue

                    vid = data.get("vid")
                    buffer_b64 = data.get("buffer")
                    if not buffer_b64:
                        continue
                        
                    raw = base64.b64decode(buffer_b64)
                    
                    # ----------------------------------------------------------
                    # DUALSENSE / DS4 PARSING (0x054c)
                    # ----------------------------------------------------------
                    if vid == 0x054c:
                        # DualSense USB Report is ID 0x01
                        if raw[0] == 0x01 and len(raw) >= 10:
                            # Axes (0-255 mapped to 0-32767)
                            ui.write(e.EV_ABS, e.ABS_X,  int(raw[1] * 128.5))
                            ui.write(e.EV_ABS, e.ABS_Y,  int(raw[2] * 128.5))
                            ui.write(e.EV_ABS, e.ABS_RX, int(raw[3] * 128.5))
                            ui.write(e.EV_ABS, e.ABS_RY, int(raw[4] * 128.5))
                            
                            # Buttons Byte 1 (D-Pad + Face Buttons)
                            b1 = raw[5]
                            dpad_val = b1 & 0x0F
                            hx, hy = dpad_map.get(dpad_val, (0, 0))
                            ui.write(e.EV_ABS, e.ABS_HAT0X, hx)
                            ui.write(e.EV_ABS, e.ABS_HAT0Y, hy)
                            
                            ui.write(e.EV_KEY, e.BTN_WEST,  1 if (b1 & 0x10) else 0) # Square -> X
                            ui.write(e.EV_KEY, e.BTN_SOUTH, 1 if (b1 & 0x20) else 0) # Cross -> A
                            ui.write(e.EV_KEY, e.BTN_EAST,  1 if (b1 & 0x40) else 0) # Circle -> B
                            ui.write(e.EV_KEY, e.BTN_NORTH, 1 if (b1 & 0x80) else 0) # Triangle -> Y
                            
                            # Buttons Byte 2
                            b2 = raw[6]
                            ui.write(e.EV_KEY, e.BTN_TL, 1 if (b2 & 0x01) else 0) # L1
                            ui.write(e.EV_KEY, e.BTN_TR, 1 if (b2 & 0x02) else 0) # R1
                            ui.write(e.EV_KEY, e.BTN_TL2, 1 if (b2 & 0x04) else 0) # L2
                            ui.write(e.EV_KEY, e.BTN_TR2, 1 if (b2 & 0x08) else 0) # R2
                            ui.write(e.EV_KEY, e.BTN_SELECT, 1 if (b2 & 0x10) else 0) # Share
                            ui.write(e.EV_KEY, e.BTN_START, 1 if (b2 & 0x20) else 0) # Options
                            ui.write(e.EV_KEY, e.BTN_THUMBL, 1 if (b2 & 0x40) else 0) # L3
                            ui.write(e.EV_KEY, e.BTN_THUMBR, 1 if (b2 & 0x80) else 0) # R3
                            
                            # Buttons Byte 3
                            b3 = raw[7]
                            ui.write(e.EV_KEY, e.BTN_MODE, 1 if (b3 & 0x01) else 0) # PS Button
                            
                            # Triggers (0-255)
                            ui.write(e.EV_ABS, e.ABS_Z, raw[8])
                            ui.write(e.EV_ABS, e.ABS_RZ, raw[9])

                            ui.syn()

                except Exception as ex:
                    print(f"[backend_webhid] Parsing error: {ex}", file=sys.stderr)
                    continue

        except ImportError:
            print("[backend_webhid] Error: 'evdev' module not installed.", file=sys.stderr)
            sys.exit(1)
        except PermissionError:
            print("[backend_webhid] Error: Permission denied accessing /dev/uinput.", file=sys.stderr)
            sys.exit(1)

    else:
        print("[backend_webhid] Platform not yet supported. Windows requires ViGEmBus.", file=sys.stderr)
        for _ in sys.stdin:
            pass
        sys.exit(1)

if __name__ == "__main__":
    start_webhid_backend()
