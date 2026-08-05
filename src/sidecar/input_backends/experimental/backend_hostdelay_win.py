import sys, json, time, threading, ctypes, struct
from ctypes import wintypes
import queue as _queue

try:
    import vgamepad as vg
except ImportError:
    sys.exit(0)

try:
    from vgamepad.win.vigem_client import VIGEMClient
except ImportError:
    try:
        from vgamepad.vigem import VIGEMClient
    except ImportError:
        VIGEMClient = None

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
    sys.exit(0)

XInputGetState = xinput.XInputGetState
XInputGetState.argtypes = [wintypes.DWORD, ctypes.POINTER(XINPUT_STATE)]
XInputGetState.restype = wintypes.DWORD

delay_ms = 0.0
enabled = False
virtual_pads = {}
physical_indices = set()
last_states = {}

def writer_loop(vpad, q):
    """Single writer thread per pad: drains queue, sleeps delay_ms before each write."""
    while True:
        state = q.get()
        if state is None:
            break
        d = delay_ms / 1000.0
        if d > 0:
            time.sleep(d)
        try:
            vpad.report.wButtons = state.wButtons
            vpad.report.bLeftTrigger = state.bLeftTrigger
            vpad.report.bRightTrigger = state.bRightTrigger
            vpad.report.sThumbLX = state.sThumbLX
            vpad.report.sThumbLY = state.sThumbLY
            vpad.report.sThumbRX = state.sThumbRX
            vpad.report.sThumbRY = state.sThumbRY
            vpad.update()
        except Exception:
            pass

def scan_physical():
    try:
        return set(VIGEMClient()._get_vigem_bus()._bus.search_physical() or [])
    except Exception:
        indices = set()
        for i in range(4):
            state = XINPUT_STATE()
            if XInputGetState(i, ctypes.byref(state)) == 0:
                indices.add(i)
        return indices

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
                    virtual_pads[i] = {
                        'vpad': vg.VX360Gamepad(),
                        'q': _queue.Queue(maxsize=256),
                        't': threading.Thread(
                            target=writer_loop,
                            args=(virtual_pads[i]['vpad'], virtual_pads[i]['q']),
                            daemon=True
                        )
                    }
                    virtual_pads[i]['t'].start()

                if i not in last_states or last_states[i] != state.dwPacketNumber:
                    last_states[i] = state.dwPacketNumber
                    gp_copy = XINPUT_GAMEPAD()
                    ctypes.memmove(ctypes.byref(gp_copy), ctypes.byref(state.Gamepad), ctypes.sizeof(XINPUT_GAMEPAD))
                    try:
                        virtual_pads[i]['q'].put_nowait(gp_copy)
                    except _queue.Full:
                        pass
            else:
                if i in virtual_pads:
                    try:
                        virtual_pads[i]['vpad'].reset()
                        virtual_pads[i]['vpad'].update()
                    except: pass
                    virtual_pads[i]['q'].put(None)
                    virtual_pads[i]['t'].join(timeout=2)
                    del virtual_pads[i]
                if i in last_states:
                    del last_states[i]
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
                        v['vpad'].reset()
                        v['vpad'].update()
                    except: pass
                virtual_pads.clear()
                physical_indices.clear()
                last_states.clear()
        if "delayMs" in msg:
            delay_ms = float(msg["delayMs"])
    except Exception:
        pass
