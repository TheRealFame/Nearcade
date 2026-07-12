"""
Nearcade — Windows HIDMaestro backend
Virtual controller via HIDMaestro SDK (.NET bridge) + KBM injection via pyautogui.

Emits JSON to stdout for InputOrchestrator.js:
  {"type": "error",   "message": "...", "code": "..."}
  {"type": "ready",   "message": "..."}
  {"type": "log",     "message": "..."}
  {"type": "rumble",  "pad_id": "...", "strong": 0.5, "weak": 0.3, "duration": 250}
"""

import sys
import json
import gc
import os
import subprocess
import threading
import queue


# ── JSON protocol helpers ─────────────────────────────────────────────

def _emit(payload: dict):
    print(json.dumps(payload), flush=True)

def _log(msg: str):
    _emit({"type": "log", "message": msg})

def _error(msg: str, code: str = "HIDMAESTRO_ERROR"):
    _emit({"type": "error", "message": msg, "code": code})


# ── PyAutoGUI for KBM ─────────────────────────────────────────────────

try:
    import pyautogui
    pyautogui.FAILSAFE = False
    pyautogui.PAUSE = 0
    KBM_ENABLED = True
    _log("pyautogui loaded — KBM passthrough enabled")
except ImportError:
    _log("WARNING: pyautogui not installed — KBM passthrough disabled")
    KBM_ENABLED = False

PYAUTOGUI_KEY_MAP = {
    "KEY_A": "a", "KEY_B": "b", "KEY_C": "c", "KEY_D": "d",
    "KEY_E": "e", "KEY_F": "f", "KEY_G": "g", "KEY_H": "h",
    "KEY_I": "i", "KEY_J": "j", "KEY_K": "k", "KEY_L": "l",
    "KEY_M": "m", "KEY_N": "n", "KEY_O": "o", "KEY_P": "p",
    "KEY_Q": "q", "KEY_R": "r", "KEY_S": "s", "KEY_T": "t",
    "KEY_U": "u", "KEY_V": "v", "KEY_W": "w", "KEY_X": "x",
    "KEY_Y": "y", "KEY_Z": "z",
    "KEY_0": "0", "KEY_1": "1", "KEY_2": "2", "KEY_3": "3",
    "KEY_4": "4", "KEY_5": "5", "KEY_6": "6", "KEY_7": "7",
    "KEY_8": "8", "KEY_9": "9",
    "KEY_UP": "up", "KEY_DOWN": "down", "KEY_LEFT": "left", "KEY_RIGHT": "right",
    "KEY_SPACE": "space", "KEY_ENTER": "enter", "KEY_ESC": "escape",
    "KEY_LEFTSHIFT": "shift", "KEY_RIGHTSHIFT": "shift",
    "KEY_LEFTCTRL": "ctrl", "KEY_RIGHTCTRL": "ctrl",
    "KEY_LEFTALT": "alt", "KEY_RIGHTALT": "alt",
    "KEY_TAB": "tab", "KEY_BACKSPACE": "backspace",
    "KEY_CAPSLOCK": "capslock",
    "KEY_F1": "f1", "KEY_F2": "f2", "KEY_F3": "f3", "KEY_F4": "f4",
    "KEY_F5": "f5", "KEY_F6": "f6", "KEY_F7": "f7", "KEY_F8": "f8",
    "KEY_F9": "f9", "KEY_F10": "f10", "KEY_F11": "f11", "KEY_F12": "f12",
    "BTN_LEFT": "left", "BTN_MIDDLE": "middle", "BTN_RIGHT": "right",
}


# ── Nearcade → HIDMaestro conversion ─────────────────────────────────

def _nearcade_to_hm_buttons(btns: int) -> int:
    hm = 0
    if btns & 0x0001: hm |= 1 << 0   # A
    if btns & 0x0002: hm |= 1 << 1   # B
    if btns & 0x0004: hm |= 1 << 2   # X
    if btns & 0x0008: hm |= 1 << 3   # Y
    if btns & 0x0100: hm |= 1 << 4   # LB
    if btns & 0x0200: hm |= 1 << 5   # RB
    if btns & 0x2000: hm |= 1 << 6   # Back/Select
    if btns & 0x1000: hm |= 1 << 7   # Start
    if btns & 0x0400: hm |= 1 << 8   # L3
    if btns & 0x0800: hm |= 1 << 9   # R3
    if btns & 0x4000: hm |= 1 << 10  # Guide
    return hm

HM_HAT_MAP = {
    (0, 0, 0, 0): 0,  # None
    (1, 0, 0, 0): 1,  # North
    (1, 0, 1, 0): 2,  # NorthEast
    (0, 0, 1, 0): 3,  # East
    (0, 1, 1, 0): 4,  # SouthEast
    (0, 1, 0, 0): 5,  # South
    (0, 1, 0, 1): 6,  # SouthWest
    (0, 0, 0, 1): 7,  # West
    (1, 0, 0, 1): 8,  # NorthWest
}

def _dpad_to_hmhat(btns: int) -> int:
    return HM_HAT_MAP.get(((btns >> 4) & 1, (btns >> 5) & 1, (btns >> 6) & 1, (btns >> 7) & 1), 0)

def _axis_to_hm(val) -> float:
    try:
        f = float(val) / 32767.0
        return max(0.0, min(1.0, (f + 1.0) / 2.0))
    except (TypeError, ValueError):
        return 0.5

def _trig_to_hm(val) -> float:
    try:
        return max(0.0, min(1.0, float(val)))
    except (TypeError, ValueError):
        return 0.0

HM_PROFILE_MAP = {
    'xbox360':   'xbox-360-wired',
    'xbox':      'xbox-360-wired',
    'xboxone':   'xbox-one-s',
    'ds4':       'dualshock-4-v1-full',
    'ps4':       'dualshock-4-v1-full',
    'playstation':'dualsense',
    'dualshock4':'dualshock-4-v1-full',
    'dualsense': 'dualsense',
    'switchpro': 'switch-pro',
    'switch':    'switch-pro',
    'nintendo':  'switch-pro',
}


# ── HmBridge subprocess management ────────────────────────────────────

_hm_bridge: subprocess.Popen = None
_hm_stdin_lock = threading.Lock()
_hm_stdout_queue: queue.Queue = queue.Queue()
_event_queue: queue.Queue = queue.Queue()
_viewer_modes: dict = {}
_viewer_pads: dict = {}


def _find_hm_bridge() -> str | None:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for p in [
        os.path.join(script_dir, 'HmBridge', 'HmBridge.exe'),
        os.path.join(script_dir, 'HmBridge', 'bin', 'Release',
                     'net10.0-windows10.0.26100.0', 'win-x64', 'HmBridge.exe'),
    ]:
        if os.path.isfile(p):
            return p
    return None


def _hm_write(obj: dict):
    global _hm_bridge
    if _hm_bridge is None or _hm_bridge.stdin is None:
        return
    with _hm_stdin_lock:
        try:
            _hm_bridge.stdin.write(json.dumps(obj) + '\n')
            _hm_bridge.stdin.flush()
        except (BrokenPipeError, OSError):
            pass


def _hm_stdout_reader():
    global _hm_bridge
    if _hm_bridge is None or _hm_bridge.stdout is None:
        return
    for raw in _hm_bridge.stdout:
        line = raw.strip()
        if line:
            try:
                _hm_stdout_queue.put(json.loads(line))
            except json.JSONDecodeError:
                pass


def _hm_stderr_reader():
    global _hm_bridge
    if _hm_bridge is None or _hm_bridge.stderr is None:
        return
    for raw in _hm_bridge.stderr:
        line = raw.strip()
        if line:
            _emit({"type": "log", "message": f"[HmBridge] {line}"})


# ── Stdin reader thread ───────────────────────────────────────────────

def _stdin_thread():
    stdin_raw = open(sys.stdin.fileno(), 'rb', buffering=0)
    for raw_line in stdin_raw:
        line = raw_line.decode('utf-8', errors='replace').strip()
        if line:
            _event_queue.put(('json', line))


# ── KBM handler ───────────────────────────────────────────────────────

def _handle_kbm(msg: dict):
    if not KBM_ENABLED:
        return
    vid = str(msg.get("viewer_id", msg.get("viewerId", "")))
    mode = _viewer_modes.get(vid, "gamepad")
    if mode not in ("kbm", "hybrid", "kbm_emulated"):
        return

    event_type = msg.get("event", "")
    if event_type == "mousemove":
        dx = msg.get("dx", 0)
        dy = msg.get("dy", 0)
        if dx != 0 or dy != 0:
            try: pyautogui.move(int(dx), int(dy))
            except Exception: pass
        return

    if event_type in ("keydown", "keyup"):
        key_name = msg.get("key", "")
        py_key = PYAUTOGUI_KEY_MAP.get(key_name) or key_name.lower().replace("key_", "")
        try:
            is_mouse = "btn_" in key_name.lower()
            if is_mouse:
                if event_type == "keydown": pyautogui.mouseDown(button=py_key)
                else: pyautogui.mouseUp(button=py_key)
            else:
                if event_type == "keydown": pyautogui.keyDown(py_key)
                else: pyautogui.keyUp(py_key)
        except Exception: pass


# ── Message dispatcher ────────────────────────────────────────────────

def _process(msg: dict):
    msg_type = msg.get("type", "")
    vid = str(msg.get("viewer_id", msg.get("viewerId", "")))

    if msg_type == "set-input-mode":
        _viewer_modes[vid] = msg.get("mode", "gamepad")
        return

    if msg_type == "allocate_slot":
        pad_id = str(msg.get("pad_id", ""))
        profile_key = str(msg.get("profile", "xbox360"))
        hm_profile = HM_PROFILE_MAP.get(profile_key, 'xbox-360-wired')
        _hm_write({"type": "create", "pad_id": pad_id, "profile": hm_profile})
        _viewer_pads.setdefault(vid, set()).add(pad_id)
        return

    if msg_type == "free_slot":
        pad_id = str(msg.get("pad_id", ""))
        _hm_write({"type": "free", "pad_id": pad_id})
        _viewer_pads.get(vid, set()).discard(pad_id)
        return

    if msg_type in ("flush_neutral", "disconnect_viewer", "destroy_all"):
        if vid in _viewer_pads:
            for pid in list(_viewer_pads[vid]):
                _hm_write({"type": "free", "pad_id": pid})
            _viewer_pads[vid].clear()
        if msg_type == "destroy_all":
            _hm_write({"type": "destroy_all"})
        gc.collect()
        return

    if msg_type == "gamepad":
        mode = _viewer_modes.get(vid, "gamepad")
        if mode not in ("gamepad", "hybrid"):
            return

        pad_id = str(msg.get("pad_id", msg.get("viewer_id", "default")))
        btns_raw = msg.get("buttons", 0)

        if isinstance(btns_raw, int):
            buttons_val = btns_raw
        elif isinstance(btns_raw, list):
            buttons_val = 0
            masks = [0x0001, 0x0002, 0x0004, 0x0008, 0x0010, 0x0020,
                     0x0040, 0x0080, 0x0100, 0x0200, 0x0400, 0x0800,
                     0x1000, 0x2000, 0x4000]
            for i, b in enumerate(btns_raw):
                if isinstance(b, dict): b = b.get("pressed", False)
                if b and i < len(masks): buttons_val |= masks[i]
        else:
            buttons_val = 0

        hm_buttons = _nearcade_to_hm_buttons(buttons_val)
        hm_hat = _dpad_to_hmhat(buttons_val)
        axes = msg.get("axes", [])

        if "lx" in msg:
            lx = _axis_to_hm(msg["lx"]); ly = _axis_to_hm(msg["ly"])
            rx = _axis_to_hm(msg["rx"]); ry = _axis_to_hm(msg["ry"])
            lt = _trig_to_hm(msg.get("lt", 0.0))
            rt = _trig_to_hm(msg.get("rt", 0.0))
        elif len(axes) >= 6:
            lx = _axis_to_hm(axes[0]); ly = _axis_to_hm(axes[1])
            rx = _axis_to_hm(axes[2]); ry = _axis_to_hm(axes[3])
            lt = _trig_to_hm(axes[4]); rt = _trig_to_hm(axes[5])
        elif len(axes) >= 4:
            lx = _axis_to_hm(axes[0]); ly = _axis_to_hm(axes[1])
            rx = _axis_to_hm(axes[2]); ry = _axis_to_hm(axes[3])
            lt = 0.0; rt = 0.0
        else:
            lx = 0.5; ly = 0.5; rx = 0.5; ry = 0.5; lt = 0.0; rt = 0.0

        _hm_write({
            "type": "state", "pad_id": pad_id,
            "buttons": hm_buttons, "hat": hm_hat,
            "lx": lx, "ly": ly, "rx": rx, "ry": ry, "lt": lt, "rt": rt,
        })
        return

    if msg_type in ("kbm", "keyboard"):
        _handle_kbm(msg)
        return


# ── Run loop ──────────────────────────────────────────────────────────

def run():
    global _hm_bridge

    bridge_path = _find_hm_bridge()
    if bridge_path is None:
        _error(
            "HmBridge.exe not found. Download from the Nearcade releases page: "
            "https://github.com/cutefame/Nearcade/releases",
            "HM_BRIDGE_NOT_FOUND"
        )
        _emit({"type": "ready", "message": "HmBridge unavailable — KBM-only mode"})
    else:
        try:
            _hm_bridge = subprocess.Popen(
                [bridge_path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            _hm_write({"type": "init"})
            threading.Thread(target=_hm_stdout_reader, daemon=True).start()
            threading.Thread(target=_hm_stderr_reader, daemon=True).start()
            _log(f"HmBridge spawned: {bridge_path}")
            _emit({"type": "ready", "message": "Windows HIDMaestro backend initialized"})
        except Exception as e:
            _error(f"Failed to spawn HmBridge: {e}", "HM_BRIDGE_SPAWN_FAILED")
            _hm_bridge = None
            _emit({"type": "ready", "message": "HmBridge unavailable — KBM-only mode"})

    threading.Thread(target=_stdin_thread, daemon=True).start()

    # Main loop: drain HmBridge output queue, then block on stdin events
    try:
        while True:
            while True:
                try:
                    ev = _hm_stdout_queue.get_nowait()
                except queue.Empty:
                    break
                ev_type = ev.get("type")
                if ev_type == "rumble":
                    pad_id = str(ev.get("pad_id", ""))
                    vid = pad_id.split('_')[0] if '_' in pad_id else pad_id
                    _emit({
                        "type": "rumble",
                        "viewerId": vid,
                        "strong": ev.get("strong", 0),
                        "weak": ev.get("weak", 0),
                        "duration": ev.get("duration", 200),
                    })
                elif ev_type in ("error", "log", "ready"):
                    _emit(ev)

            ev = _event_queue.get()
            if ev[0] == 'json':
                msg = json.loads(ev[1])
                try:
                    _process(msg)
                except Exception as e:
                    _error(f"Unexpected error: {e}", "PROCESS_ERROR")
    except (EOFError, KeyboardInterrupt):
        pass

    if _hm_bridge:
        _hm_write({"type": "destroy_all"})
        try:
            _hm_bridge.stdin.close()
        except Exception: pass
        try:
            _hm_bridge.wait(timeout=5)
        except Exception:
            _hm_bridge.kill()


if __name__ == "__main__":
    run()
