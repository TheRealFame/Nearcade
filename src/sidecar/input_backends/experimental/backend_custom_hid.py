import sys
import json
import os
import atexit
import signal

try:
    import uinput
    UINPUT_OK = True
except ImportError:
    UINPUT_OK = False
    print(json.dumps({"type": "error", "message": "python-uinput not found"}), flush=True)

devices = {}

# Switch Pro Vendor 0x057e, Product 0x2009
if UINPUT_OK:
    W3C_MAP = {
        0: uinput.BTN_B,    # W3C A -> Switch B
        1: uinput.BTN_A,    # W3C B -> Switch A
        2: uinput.BTN_X,    # W3C X -> Switch Y
        3: uinput.BTN_Y,    # W3C Y -> Switch X
        4: uinput.BTN_TL,
        5: uinput.BTN_TR,
        8: uinput.BTN_SELECT,
        9: uinput.BTN_START,
        10: uinput.BTN_THUMBL,
        11: uinput.BTN_THUMBR,
        16: uinput.BTN_MODE,
    }
    BTNS = list(W3C_MAP.values())
    if hasattr(uinput, 'BTN_TL2'): BTNS.append(uinput.BTN_TL2)
    if hasattr(uinput, 'BTN_TR2'): BTNS.append(uinput.BTN_TR2)
    
    AXES = [
        uinput.ABS_X    + (-32767, 32767, 16, 128),
        uinput.ABS_Y    + (-32767, 32767, 16, 128),
        uinput.ABS_RX   + (-32767, 32767, 16, 128),
        uinput.ABS_RY   + (-32767, 32767, 16, 128),
        uinput.ABS_Z    + (0, 255, 0, 0),
        uinput.ABS_RZ   + (0, 255, 0, 0),
        uinput.ABS_HAT0X + (-1, 1, 0, 0),
        uinput.ABS_HAT0Y + (-1, 1, 0, 0),
    ]

def _cleanup():
    for dev in devices.values():
        try: dev.destroy()
        except: pass
    devices.clear()

atexit.register(_cleanup)

def get_device(pad_id):
    if not UINPUT_OK: return None
    if pad_id not in devices:
        devices[pad_id] = uinput.Device(
            BTNS + AXES, 
            name="Nintendo Switch Pro Controller", 
            vendor=0x057e, 
            product=0x2009, 
            version=0x0001, 
            bustype=3
        )
        print(f"[switchpro] Created Switch Pro device for {pad_id}", flush=True)
    return devices[pad_id]

def process_message(msg):
    msg_type = msg.get('type')
    
    if msg_type == 'allocate_slot':
        pad_id = msg.get('pad_id')
        get_device(pad_id)
        return
        
    if msg_type == 'free_slot':
        pad_id = msg.get('pad_id')
        if pad_id in devices:
            try: devices[pad_id].destroy()
            except: pass
            del devices[pad_id]
        return

    if msg_type == 'custom_hid':
        pad_id = msg.get('pad_id')
        if not pad_id: return
        
        dev = get_device(pad_id)
        if not dev: return
        
        btns_mask = msg.get('buttons', 0)
        lx = msg.get("lx", 0)
        ly = msg.get("ly", 0)
        rx = msg.get("rx", 0)
        ry = msg.get("ry", 0)
        lt = msg.get("lt", 0.0)
        rt = msg.get("rt", 0.0)

        JS_BITMASK = {
            0x0001: uinput.BTN_B,   # Viewer A -> Switch B
            0x0002: uinput.BTN_A,   # Viewer B -> Switch A
            0x0004: uinput.BTN_Y,   # Viewer X -> Switch Y
            0x0008: uinput.BTN_X,   # Viewer Y -> Switch X
            0x0100: uinput.BTN_TL,
            0x0200: uinput.BTN_TR,
            0x2000: uinput.BTN_SELECT,
            0x1000: uinput.BTN_START,
            0x0400: uinput.BTN_THUMBL,
            0x0800: uinput.BTN_THUMBR,
            0x4000: uinput.BTN_MODE
        }
        
        for mask, ubtn in JS_BITMASK.items():
            is_pressed = (btns_mask & mask) != 0
            dev.emit(ubtn, 1 if is_pressed else 0, syn=False)
            
        dev.emit(uinput.ABS_X, lx, syn=False)
        dev.emit(uinput.ABS_Y, ly, syn=False)
        dev.emit(uinput.ABS_RX, rx, syn=False)
        dev.emit(uinput.ABS_RY, ry, syn=False)
        dev.emit(uinput.ABS_Z, int(lt * 255), syn=False)
        dev.emit(uinput.ABS_RZ, int(rt * 255), syn=False)
        
        hx = -1 if (btns_mask & 0x0040) else 1 if (btns_mask & 0x0080) else 0
        hy = -1 if (btns_mask & 0x0010) else 1 if (btns_mask & 0x0020) else 0
        dev.emit(uinput.ABS_HAT0X, hx, syn=False)
        dev.emit(uinput.ABS_HAT0Y, hy, syn=False)
        
        dev.syn()

def run():
    print(json.dumps({"type": "ready", "message": "Experimental Switch Pro backend loaded"}), flush=True)
    
    def sigterm_handler(_signo, _stack_frame):
        print(f"[switchpro] Caught SIGTERM, shutting down...", flush=True)
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, sigterm_handler)

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line: continue
            try:
                msg = json.loads(line)
                process_message(msg)
            except Exception as e:
                pass
    finally:
        _cleanup()
        print("[switchpro] Closed virtual Switch Pro backend.", flush=True)

if __name__ == '__main__':
    run()
