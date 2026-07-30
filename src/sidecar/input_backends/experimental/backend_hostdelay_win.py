import sys, json, time, threading, ctypes
from ctypes import wintypes
import os

def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)

try:
    import vgamepad as vg
except ImportError:
    eprint("vgamepad not installed")
    sys.exit(0)

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
    eprint("XInput not found")
    sys.exit(0)

XInputGetState = xinput.XInputGetState
XInputGetState.argtypes = [wintypes.DWORD, ctypes.POINTER(XINPUT_STATE)]
XInputGetState.restype = wintypes.DWORD

delay_ms = 0.0
enabled = False
virtual_pads = {}
physical_indices = set()
last_states = {}

def scan_physical():
    physical = []
    for i in range(4):
        state = XINPUT_STATE()
        res = XInputGetState(i, ctypes.byref(state))
        if res == 0:
            physical.append(i)
    return physical

def delayed_write(vpad, gamepad_state, delay):
    if delay > 0:
        time.sleep(delay)
    try:
        vpad.report.wButtons = gamepad_state.wButtons
        vpad.report.bLeftTrigger = gamepad_state.bLeftTrigger
        vpad.report.bRightTrigger = gamepad_state.bRightTrigger
        vpad.report.sThumbLX = gamepad_state.sThumbLX
        vpad.report.sThumbLY = gamepad_state.sThumbLY
        vpad.report.sThumbRX = gamepad_state.sThumbRX
        vpad.report.sThumbRY = gamepad_state.sThumbRY
        vpad.update()
    except Exception:
        pass

def windows_loop():
    while True:
        if not enabled:
            time.sleep(0.1)
            continue
            
        for i in list(physical_indices):
            state = XINPUT_STATE()
            res = XInputGetState(i, ctypes.byref(state))
            if res == 0:
                if i not in virtual_pads:
                    virtual_pads[i] = vg.VX360Gamepad()
                
                if i not in last_states or last_states[i] != state.dwPacketNumber:
                    last_states[i] = state.dwPacketNumber
                    gp_copy = XINPUT_GAMEPAD()
                    ctypes.memmove(ctypes.byref(gp_copy), ctypes.byref(state.Gamepad), ctypes.sizeof(XINPUT_GAMEPAD))
                    threading.Thread(target=delayed_write, args=(virtual_pads[i], gp_copy, delay_ms / 1000.0)).start()
            else:
                if i in virtual_pads:
                    try:
                        virtual_pads[i].reset()
                        virtual_pads[i].update()
                    except: pass
                    del virtual_pads[i]
                if i in last_states:
                    del last_states[i]
                # If disconnected, remove from tracked physical indices
                physical_indices.discard(i)
        
        time.sleep(0.008)

threading.Thread(target=windows_loop, daemon=True).start()

for line in sys.stdin:
    try:
        msg = json.loads(line)
        if "enabled" in msg:
            if msg["enabled"] and not enabled:
                enabled = True
                physical_indices.clear()
                physical_indices.update(scan_physical())
            elif not msg["enabled"] and enabled:
                enabled = False
                for k, v in list(virtual_pads.items()):
                    try:
                        v.reset()
                        v.update()
                    except: pass
                virtual_pads.clear()
                physical_indices.clear()
                last_states.clear()
        if "delayMs" in msg:
            delay_ms = float(msg["delayMs"])
    except Exception:
        pass
