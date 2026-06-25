import sys
import json
import time
import platform
import threading
import os

def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)

os_type = platform.system()

def emit_state(pad_index, state):
    print(json.dumps({"type": "gamepad_state", "index": pad_index, "state": state}), flush=True)

def emit_connected(pad_index, name, id_str):
    print(json.dumps({"type": "gamepad_connected", "index": pad_index, "name": name, "id": id_str}), flush=True)

def emit_disconnected(pad_index):
    print(json.dumps({"type": "gamepad_disconnected", "index": pad_index}), flush=True)

if os_type == "Windows":
    import ctypes
    from ctypes import wintypes
    
    class XINPUT_GAMEPAD(ctypes.Structure):
        _fields_ = [
            ("wButtons", wintypes.WORD),
            ("bLeftTrigger", wintypes.BYTE),
            ("bRightTrigger", wintypes.BYTE),
            ("sThumbLX", wintypes.SHORT),
            ("sThumbLY", wintypes.SHORT),
            ("sThumbRX", wintypes.SHORT),
            ("sThumbRY", wintypes.SHORT),
        ]

    class XINPUT_STATE(ctypes.Structure):
        _fields_ = [
            ("dwPacketNumber", wintypes.DWORD),
            ("Gamepad", XINPUT_GAMEPAD),
        ]

    xinput = None
    for dll in ("xinput1_4.dll", "xinput1_3.dll", "xinput9_1_0.dll"):
        try:
            xinput = ctypes.windll.LoadLibrary(dll)
            break
        except Exception:
            pass

    if not xinput:
        eprint("No XInput found")
        sys.exit(1)
        
    XInputGetState = xinput.XInputGetState
    XInputGetState.argtypes = [wintypes.DWORD, ctypes.POINTER(XINPUT_STATE)]
    XInputGetState.restype = wintypes.DWORD

    def windows_loop():
        last_states = {}
        while True:
            for i in range(4):
                state = XINPUT_STATE()
                res = XInputGetState(i, ctypes.byref(state))
                if res == 0:
                    gp = state.Gamepad
                    btns = [
                        (gp.wButtons & 0x1000) != 0, # A
                        (gp.wButtons & 0x2000) != 0, # B
                        (gp.wButtons & 0x4000) != 0, # X
                        (gp.wButtons & 0x8000) != 0, # Y
                        (gp.wButtons & 0x0100) != 0, # LB
                        (gp.wButtons & 0x0200) != 0, # RB
                        gp.bLeftTrigger > 0,         # LT
                        gp.bRightTrigger > 0,        # RT
                        (gp.wButtons & 0x0020) != 0, # Back
                        (gp.wButtons & 0x0010) != 0, # Start
                        (gp.wButtons & 0x0040) != 0, # L3
                        (gp.wButtons & 0x0080) != 0, # R3
                        (gp.wButtons & 0x0001) != 0, # DUp
                        (gp.wButtons & 0x0002) != 0, # DDown
                        (gp.wButtons & 0x0004) != 0, # DLeft
                        (gp.wButtons & 0x0008) != 0, # DRight
                        False
                    ]
                    
                    btn_objs = []
                    for idx, pressed in enumerate(btns):
                        if idx == 6:
                            btn_objs.append({"pressed": pressed, "value": gp.bLeftTrigger})
                        elif idx == 7:
                            btn_objs.append({"pressed": pressed, "value": gp.bRightTrigger})
                        else:
                            btn_objs.append({"pressed": pressed, "value": 255 if pressed else 0})

                    lx = max(-32767, gp.sThumbLX)
                    ly = max(-32767, -gp.sThumbLY) if gp.sThumbLY != -32768 else 32767
                    rx = max(-32767, gp.sThumbRX)
                    ry = max(-32767, -gp.sThumbRY) if gp.sThumbRY != -32768 else 32767

                    new_s = {"axes": [lx, ly, rx, ry], "buttons": btn_objs}
                    
                    if i not in last_states:
                        emit_connected(i, "XInput Controller", f"xinput_{i}")
                    
                    str_s = json.dumps(new_s)
                    if last_states.get(i) != str_s:
                        last_states[i] = str_s
                        emit_state(i, new_s)
                else:
                    if i in last_states:
                        del last_states[i]
                        emit_disconnected(i)
            time.sleep(0.008)

    threading.Thread(target=windows_loop, daemon=True).start()

elif os_type == "Linux":
    try:
        import evdev
    except ImportError:
        eprint("evdev not installed")
        sys.exit(1)

    devices = {}
    
    def linux_loop():
        while True:
            for path in evdev.list_devices():
                if path not in devices:
                    try:
                        dev = evdev.InputDevice(path)
                        caps = dev.capabilities()
                        if evdev.ecodes.EV_ABS in caps and evdev.ecodes.EV_KEY in caps:
                            has_btn = any(btn in caps[evdev.ecodes.EV_KEY] for btn in [evdev.ecodes.BTN_GAMEPAD, evdev.ecodes.BTN_SOUTH])
                            if has_btn:
                                devices[path] = dev
                                idx = len(devices) - 1
                                dev.my_idx = idx
                                emit_connected(idx, dev.name, f"evdev_{path.replace('/', '_')}")
                                
                                def read_dev(d, i):
                                    state = {"axes": [0,0,0,0], "buttons": [{"pressed": False, "value": 0} for _ in range(17)]}
                                    btn_map = {
                                        evdev.ecodes.BTN_SOUTH: 0, evdev.ecodes.BTN_EAST: 1,
                                        evdev.ecodes.BTN_NORTH: 3, evdev.ecodes.BTN_WEST: 2,
                                        evdev.ecodes.BTN_TL: 4, evdev.ecodes.BTN_TR: 5,
                                        evdev.ecodes.BTN_TL2: 6, evdev.ecodes.BTN_TR2: 7,
                                        evdev.ecodes.BTN_SELECT: 8, evdev.ecodes.BTN_START: 9,
                                        evdev.ecodes.BTN_THUMBL: 10, evdev.ecodes.BTN_THUMBR: 11,
                                        evdev.ecodes.BTN_DPAD_UP: 12, evdev.ecodes.BTN_DPAD_DOWN: 13,
                                        evdev.ecodes.BTN_DPAD_LEFT: 14, evdev.ecodes.BTN_DPAD_RIGHT: 15,
                                        evdev.ecodes.BTN_MODE: 16,
                                    }
                                    
                                    axis_map = {}
                                    absinfo = d.capabilities().get(evdev.ecodes.EV_ABS, [])
                                    for code, info in absinfo:
                                        axis_map[code] = {"min": info.min, "max": info.max}
                                        
                                    def normalize_axis(val, amin, amax):
                                        if amax == amin: return 0
                                        v = ((val - amin) / (amax - amin)) * 2.0 - 1.0
                                        return int(v * 32767)

                                    try:
                                        for event in d.read_loop():
                                            changed = False
                                            if event.type == evdev.ecodes.EV_KEY:
                                                if event.code in btn_map:
                                                    b_idx = btn_map[event.code]
                                                    state["buttons"][b_idx] = {"pressed": event.value > 0, "value": 255 if event.value > 0 else 0}
                                                    changed = True
                                            elif event.type == evdev.ecodes.EV_ABS:
                                                info = axis_map.get(event.code)
                                                if not info: continue
                                                if event.code == evdev.ecodes.ABS_X:
                                                    state["axes"][0] = normalize_axis(event.value, info["min"], info["max"])
                                                    changed = True
                                                elif event.code == evdev.ecodes.ABS_Y:
                                                    state["axes"][1] = normalize_axis(event.value, info["min"], info["max"])
                                                    changed = True
                                                elif event.code == evdev.ecodes.ABS_RX or event.code == evdev.ecodes.ABS_Z:
                                                    state["axes"][2] = normalize_axis(event.value, info["min"], info["max"])
                                                    changed = True
                                                elif event.code == evdev.ecodes.ABS_RY or event.code == evdev.ecodes.ABS_RZ:
                                                    state["axes"][3] = normalize_axis(event.value, info["min"], info["max"])
                                                    changed = True
                                                elif event.code == evdev.ecodes.ABS_HAT0X:
                                                    state["buttons"][14]["pressed"] = event.value < 0; state["buttons"][14]["value"] = 255 if event.value < 0 else 0
                                                    state["buttons"][15]["pressed"] = event.value > 0; state["buttons"][15]["value"] = 255 if event.value > 0 else 0
                                                    changed = True
                                                elif event.code == evdev.ecodes.ABS_HAT0Y:
                                                    state["buttons"][12]["pressed"] = event.value < 0; state["buttons"][12]["value"] = 255 if event.value < 0 else 0
                                                    state["buttons"][13]["pressed"] = event.value > 0; state["buttons"][13]["value"] = 255 if event.value > 0 else 0
                                                    changed = True
                                            if changed:
                                                emit_state(i, state)
                                    except Exception:
                                        emit_disconnected(i)
                                        if path in devices: del devices[path]
                                
                                threading.Thread(target=read_dev, args=(dev, idx), daemon=True).start()
                    except Exception:
                        pass
            time.sleep(2)
            
    threading.Thread(target=linux_loop, daemon=True).start()
else:
    eprint("Native gamepads not supported on this OS via Python")

def stdin_loop():
    for line in sys.stdin:
        if not line.strip(): continue
        try:
            msg = json.loads(line)
            if msg.get("type") == "rumble":
                idx = msg.get("padIndex", 0)
                strong = msg.get("strong", 0.0)
                weak = msg.get("weak", 0.0)
                duration = msg.get("duration", 200)

                if os_type == "Windows" and xinput:
                    vib = XINPUT_VIBRATION()
                    vib.wLeftMotorSpeed = int(strong * 65535)
                    vib.wRightMotorSpeed = int(weak * 65535)
                    XInputSetState(idx, ctypes.byref(vib))
                    def stop_vib():
                        time.sleep(duration / 1000.0)
                        vib_stop = XINPUT_VIBRATION(0, 0)
                        XInputSetState(idx, ctypes.byref(vib_stop))
                    threading.Thread(target=stop_vib, daemon=True).start()

                elif os_type == "Linux":
                    dev_to_rumble = None
                    for path, dev in devices.items():
                        if getattr(dev, 'my_idx', -1) == idx:
                            dev_to_rumble = dev
                            break
                    if dev_to_rumble and evdev.ecodes.EV_FF in dev_to_rumble.capabilities():
                        try:
                            # evdev rumble
                            r = evdev.ff.Rumble(strong_magnitude=int(strong * 65535), weak_magnitude=int(weak * 65535))
                            effect_type = evdev.ff.EffectType(ff_rumble_effect=r)
                            effect = evdev.ff.Effect(
                                evdev.ecodes.FF_RUMBLE, -1, 0,
                                evdev.ff.Trigger(0, 0),
                                evdev.ff.Replay(int(duration), 0),
                                effect_type
                            )
                            eid = dev_to_rumble.upload_effect(effect)
                            dev_to_rumble.write(evdev.ecodes.EV_FF, eid, 1)
                            # Let it play out naturally, but we should eventually erase it to prevent leak.
                            # Usually simple controllers don't strictly require explicit erase.
                        except Exception as e:
                            eprint("Linux rumble failed:", e)
        except Exception as e:
            pass

# Start stdin loop on main thread to keep script alive and responsive
stdin_loop()

