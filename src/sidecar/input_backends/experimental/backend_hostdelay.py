import sys, json, time, threading, queue, signal

try:
    import evdev
except ImportError:
    sys.exit(0)

virtual_pads = {}
physical_pads = {}
delay_ms = 0.0
enabled = False

def writer_loop(q, vpad):
    """Single writer thread per pad: reads from queue, sleeps until target time."""
    while True:
        item = q.get()
        if item is None:
            break
        target_time, ev = item
        now = time.time()
        sleep_time = target_time - now
        if sleep_time > 0:
            time.sleep(sleep_time)
        try:
            vpad.write_event(ev)
        except Exception:
            pass

def listen_to_device(path, phys_pad, vpad):
    q = queue.Queue(maxsize=4096)
    w = threading.Thread(target=writer_loop, args=(q, vpad), daemon=True)
    w.start()
    try:
        for event in phys_pad.read_loop():
            if not enabled:
                break
            try:
                target_time = time.time() + (delay_ms / 1000.0)
                q.put_nowait((target_time, event))
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

def sigterm_handler(_signo, _stack_frame):
    ungrab_all()
    sys.exit(0)

signal.signal(signal.SIGTERM, sigterm_handler)

try:
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
finally:
    ungrab_all()
