import sys
import json
import time

def start_tablet_backend():
    print("[backend_tablets] Initializing Tablet Backend...", flush=True)
    
    # -----------------------------
    # LINUX IMPLEMENTATION (evdev)
    # -----------------------------
    if sys.platform.startswith("linux"):
        try:
            from evdev import UInput, ecodes as e, AbsInfo
            
            # Define capabilities for a Graphics Tablet (Stylus + Pressure + Tilt)
            cap = {
                e.EV_KEY: [e.BTN_TOUCH, e.BTN_TOOL_PEN],
                e.EV_ABS: [
                    # Mapping normalized (0.0 - 1.0) values to an arbitrary 0-10000 grid for precision
                    (e.ABS_X, AbsInfo(value=0, min=0, max=10000, fuzz=0, flat=0, resolution=0)),
                    (e.ABS_Y, AbsInfo(value=0, min=0, max=10000, fuzz=0, flat=0, resolution=0)),
                    (e.ABS_PRESSURE, AbsInfo(value=0, min=0, max=1000, fuzz=0, flat=0, resolution=0)),
                    (e.ABS_TILT_X, AbsInfo(value=0, min=-90, max=90, fuzz=0, flat=0, resolution=0)),
                    (e.ABS_TILT_Y, AbsInfo(value=0, min=-90, max=90, fuzz=0, flat=0, resolution=0)),
                ]
            }
            
            # Spawn the virtual drawing tablet at the kernel level
            ui = UInput(cap, name="Nearsec Virtual Tablet", version=0x3)
            print("[backend_tablets] Virtual tablet created successfully at /dev/uinput.", flush=True)
            
            # Read streaming JSON data from Node.js standard input
            for line in sys.stdin:
                try:
                    data = json.loads(line)
                    
                    if 'x' in data and 'y' in data:
                        # Convert normalized 0.0-1.0 coordinate from the web browser to the 10000 grid
                        ui.write(e.EV_ABS, e.ABS_X, int(data['x'] * 10000))
                        ui.write(e.EV_ABS, e.ABS_Y, int(data['y'] * 10000))
                        
                    if 'pressure' in data:
                        # Normalize 0.0-1.0 pressure to 1000 levels
                        pressure_val = int(data['pressure'] * 1000)
                        ui.write(e.EV_ABS, e.ABS_PRESSURE, pressure_val)
                        
                        # Tell the OS the pen is physically touching the screen if pressure > 0
                        ui.write(e.EV_KEY, e.BTN_TOUCH, 1 if pressure_val > 0 else 0)
                        
                    if 'tiltX' in data:
                        ui.write(e.EV_ABS, e.ABS_TILT_X, int(data['tiltX']))
                    if 'tiltY' in data:
                        ui.write(e.EV_ABS, e.ABS_TILT_Y, int(data['tiltY']))
                        
                    # Sync the event frame to the kernel
                    ui.syn()
                    
                except json.JSONDecodeError:
                    continue

        except ImportError:
            print("[backend_tablets] Error: 'evdev' module is not installed.", file=sys.stderr)
            sys.exit(1)
        except PermissionError:
            print("[backend_tablets] Error: Permission denied. Must be run with uinput permissions.", file=sys.stderr)
            sys.exit(1)
            
    # -----------------------------
    # WINDOWS / MAC FALLBACK
    # -----------------------------
    else:
        # Note: Windows doesn't natively support user-mode virtual digitizers (pens with pressure)
        # without installing a Virtual Tablet Driver (VTD) like OpenTabletDriver's vmulti implementation.
        # This fallback simply maps absolute coordinates to the system mouse cursor (no pressure support).
        print(f"[backend_tablets] Platform '{sys.platform}' detected. Falling back to simple absolute mouse injection (No Pressure).", flush=True)
        try:
            import ctypes
            # Read streaming JSON data
            for line in sys.stdin:
                try:
                    data = json.loads(line)
                    
                    # On Windows, we can use user32.dll for absolute mouse mapping as a fallback
                    if sys.platform == 'win32' and 'x' in data and 'y' in data:
                        x = int(data['x'] * 65535)
                        y = int(data['y'] * 65535)
                        # MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE = 0x8001
                        ctypes.windll.user32.mouse_event(0x8001, x, y, 0, 0)
                        
                        if 'pressure' in data:
                            # If pressure is greater than 0, simulate Left Mouse Button down
                            is_down = data['pressure'] > 0
                            # MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004
                            if is_down:
                                ctypes.windll.user32.mouse_event(0x0002, 0, 0, 0, 0)
                            else:
                                ctypes.windll.user32.mouse_event(0x0004, 0, 0, 0, 0)
                except Exception:
                    pass
        except Exception as e:
            print(f"[backend_tablets] Error in fallback injection: {e}", file=sys.stderr)
            sys.exit(1)

if __name__ == "__main__":
    start_tablet_backend()
