import sys, json, time, threading, queue

try:
    import evdev
except ImportError:
    sys.exit(0)

virtual_pads = {}
physical_pads = {}
delay_ms = 0.0
enabled = False

def writer_loop(q, vpad):
    """Single writer thread per pad: reads from queue, sleeps (delay_ms) before each write.
    Preserves event order and inter-event timing."""
    while True:
        ev = q.get()
        if ev is None:
            break
        d = delay_ms / 1000.0
        if d > 0:
            time.sleep(d)
        try:
            vpad.write_event(ev)
            vpad.syn()
        except Exception:
            pass

def listen_to_device(path, phys_pad, vpad):
    q = queue.Queue(maxsize=256)
    w = threading.Thread(target=writer_loop, args=(q, vpad), daemon=True)
    w.start()
    try:
        for event in phys_pad.read_loop():
            if not enabled:
                break
            try:
                q.put_nowait(event)
            except queue.Full:
                pass
    except Exception:
        pass
    finally:
        q.put(None)
        # Wait for writer thread to finish draining
        w.join(timeout=2)
        if path in physical_pads:
            try: physical_pads[path].ungrab()
            except: pass
            del physical_pads[path]
        if path in virtual_pads:
            try: virtual_pads[path].close()
            except: pass
            del virtual_pads[path]

def scan_and_grab():
    devices = [evdev.InputDevice(path) for path in evdev.list_devices()]
    for d in devices:
        # Exclude existing virtual pads to prevent infinite loops
        if "Nearcade" in d.name or "Virtual" in d.name or "uinput" in d.name.lower():
            continue

        cap = d.capabilities()
        if evdev.ecodes.EV_KEY in cap and evdev.ecodes.EV_ABS in cap:
            keys = cap[evdev.ecodes.EV_KEY]
            if evdev.ecodes.BTN_SOUTH in keys or evdev.ecodes.BTN_GAMEPAD in keys or evdev.ecodes.BTN_A in keys:
                if d.path not in physical_pads:
                    try:
                        d.grab()
                        vpad = evdev.UInput.from_device(d, name=f"Nearcade Delayed: {d.name}")
                        physical_pads[d.path] = d
                        virtual_pads[d.path] = vpad
                        threading.Thread(target=listen_to_device, args=(d.path, d, vpad), daemon=True).start()
                    except Exception as e:
                        pass

def ungrab_all():
    global enabled
    enabled = False
    for path, p in list(physical_pads.items()):
        try: p.ungrab()
        except: pass
    for path, v in list(virtual_pads.items()):
        try: v.close()
        except: pass
    physical_pads.clear()
    virtual_pads.clear()

for line in sys.stdin:
    try:
        msg = json.loads(line)
        if "enabled" in msg:
            if msg["enabled"] and not enabled:
                enabled = True
                scan_and_grab()
            elif not msg["enabled"] and enabled:
                ungrab_all()
        if "delayMs" in msg:
            delay_ms = float(msg["delayMs"])
    except Exception:
        pass
