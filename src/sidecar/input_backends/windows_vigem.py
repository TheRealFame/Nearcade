"""
NearsecTogether — Windows ViGEmBus backend
Virtual controller + KBM injection via vgamepad and pyautogui.

All errors are emitted as JSON to stdout so the Node.js orchestrator
(InputOrchestrator.js) can surface them to the Electron frontend:
  {"type": "error",   "message": "...", "code": "..."}
  {"type": "ready",   "message": "..."}
  {"type": "log",     "message": "..."}
"""

import sys
import json
import gc


# ── JSON protocol helpers ─────────────────────────────────────────────────────

def _emit(payload: dict):
    """Write a JSON line to stdout, flushed immediately."""
    print(json.dumps(payload), flush=True)

def _log(msg: str):
    _emit({"type": "log", "message": msg})

def _error(msg: str, code: str = "VIGEM_ERROR"):
    _emit({"type": "error", "message": msg, "code": code})


# ── Dependency checks — emit structured JSON on failure ──────────────────────

try:
    import vgamepad as vg
except ImportError:
    _error(
        "vgamepad not installed. Install with: pip install vgamepad  "
        "ViGEmBus driver also required: https://github.com/nefarius/ViGEmBus/releases",
        "VIGEMBUS_MISSING"
    )
    sys.exit(1)
except Exception as e:
    # vgamepad imports successfully but ViGEmBus service is not running/installed
    _error(
        f"vgamepad loaded but ViGEmBus driver error: {e}  "
        "Install ViGEmBus: https://github.com/nefarius/ViGEmBus/releases",
        "VIGEMBUS_MISSING"
    )
    sys.exit(1)

try:
    import pyautogui
    pyautogui.FAILSAFE = False
    pyautogui.PAUSE = 0  # Eliminate artificial delays during KBM injection
    KBM_ENABLED = True
    _log("pyautogui loaded — KBM passthrough enabled")
except ImportError:
    _log("WARNING: pyautogui not installed — KBM passthrough disabled. Install: pip install pyautogui")
    KBM_ENABLED = False


# ── Key map: KEY_* tokens → pyautogui key names ──────────────────────────────

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
    "BTN_LEFT": "left",
    "BTN_MIDDLE": "middle",
    "BTN_RIGHT": "right",
}

# ── Module state ──────────────────────────────────────────────────────────────

# devices: pad_id → VX360Gamepad instance
devices = {}
# viewer_modes: viewer_id → 'gamepad' | 'kbm' | 'hybrid' | 'kbm_emulated'
viewer_modes = {}


# ── Axis conversion helpers ───────────────────────────────────────────────────

def _clamp(value: float, lo: float, hi: float) -> float:
    """Clamp a float to [lo, hi]."""
    return max(lo, min(hi, value))


def _axis_to_float(raw) -> float:
    """
    Convert the raw axis value from Node.js payload to vgamepad float range [-1.0, +1.0].

    Node sends axes as integers in the range -32767..+32767 (matching the
    W3C Gamepad API specification). vgamepad expects -1.0..+1.0.

    Division by 32767.0 (not 32768) avoids overflow at the negative extreme:
      -32767 / 32767.0 = -1.0 exactly
      +32767 / 32767.0 = +1.0 exactly
    """
    try:
        return _clamp(float(raw) / 32767.0, -1.0, 1.0)
    except (TypeError, ValueError):
        return 0.0


def _trigger_to_float(raw) -> float:
    """
    Convert raw trigger value to vgamepad float range [0.0, +1.0].

    Node sends trigger axes as integers in 0..255.
    vgamepad expects 0.0..1.0.
    """
    try:
        return _clamp(float(raw) / 255.0, 0.0, 1.0)
    except (TypeError, ValueError):
        return 0.0


# ── Button application helper ─────────────────────────────────────────────────

def _apply_btn(gp, btns: list, idx: int, const):
    """Press or release a vgamepad button based on the W3C buttons array."""
    if idx >= len(btns):
        return
    entry = btns[idx]
    # W3C GamepadButton is { pressed: bool, value: float }
    # Node may send it as a dict or as a bare bool/number depending on the path.
    pressed = False
    if isinstance(entry, dict):
        pressed = bool(entry.get("pressed", False))
    else:
        pressed = bool(entry)

    if pressed:
        gp.press_button(button=const)
    else:
        gp.release_button(button=const)


# ── Main run loop ─────────────────────────────────────────────────────────────

def run():
    _emit({"type": "ready", "message": "Windows vgamepad + pyautogui backend initialized"})

    stdin_raw = open(sys.stdin.fileno(), 'rb', buffering=0)

    for raw_line in stdin_raw:
        line = raw_line.decode('utf-8', errors='replace').strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        try:
            _process(msg)
        except Exception as e:
            _error(f"Unexpected error processing message: {e}", "PROCESS_ERROR")


def _process(msg: dict):
    msg_type = msg.get("type", "")
    vid = str(msg.get("viewer_id", msg.get("viewerId", "")))

    # ── Mode updates ──────────────────────────────────────────────────────────
    if msg_type == "set-input-mode":
        viewer_modes[str(msg.get("viewerId", vid))] = msg.get("mode", "gamepad")
        return

    # ── Viewer cleanup ────────────────────────────────────────────────────────
    if msg_type in ("flush_neutral", "disconnect_viewer", "destroy_all"):
        # Find all pad slots belonging to this viewer (pad IDs are "viewerId_N")
        keys_to_remove = [
            k for k in list(devices.keys())
            if str(k).startswith(vid + "_") or str(k) == vid
        ]
        for k in keys_to_remove:
            gp = devices.pop(k, None)
            if gp is not None:
                try:
                    # Zero out the controller state before destroying
                    gp.left_joystick(x_value=0, y_value=0)
                    gp.right_joystick(x_value=0, y_value=0)
                    gp.left_trigger(value=0)
                    gp.right_trigger(value=0)
                    gp.update()
                except Exception:
                    pass
                del gp
        if msg_type == "destroy_all":
            devices.clear()
        gc.collect()
        return

    # ── Current mode for this viewer ─────────────────────────────────────────
    current_mode = viewer_modes.get(vid, "gamepad")

    # ── KBM handling ─────────────────────────────────────────────────────────
    if msg_type in ("kbm", "keyboard"):
        if not KBM_ENABLED:
            return
        if current_mode not in ("kbm", "hybrid", "kbm_emulated"):
            return
        _handle_kbm(msg)
        return

    # ── Gamepad handling ─────────────────────────────────────────────────────
    if msg_type == "gamepad":
        if current_mode not in ("gamepad", "hybrid"):
            return
        _handle_gamepad(msg)
        return


def _handle_kbm(msg: dict):
    """Inject keyboard/mouse events via pyautogui."""
    event_type = msg.get("event", "")

    if event_type == "mousemove":
        dx = msg.get("dx", 0)
        dy = msg.get("dy", 0)
        if dx != 0 or dy != 0:
            try:
                pyautogui.move(int(dx), int(dy))
            except Exception:
                pass
        return

    if event_type in ("keydown", "keyup"):
        key_name = msg.get("key", "")
        py_key = PYAUTOGUI_KEY_MAP.get(key_name)
        if py_key is None:
            # Fall back: strip KEY_ prefix and lower-case
            py_key = key_name.lower().replace("key_", "")

        try:
            is_mouse = "btn_" in key_name.lower()
            if is_mouse:
                if event_type == "keydown":
                    pyautogui.mouseDown(button=py_key)
                else:
                    pyautogui.mouseUp(button=py_key)
            else:
                if event_type == "keydown":
                    pyautogui.keyDown(py_key)
                else:
                    pyautogui.keyUp(py_key)
        except Exception:
            pass


def _handle_gamepad(msg: dict):
    """Inject gamepad state via vgamepad VX360Gamepad."""
    # pad_id is set by InputOrchestrator: 'viewerId_0', 'viewerId_1', etc.
    pad_id = str(msg.get("pad_id", msg.get("viewer_id", "default")))

    # Lazy-create the virtual gamepad for this slot
    if pad_id not in devices:
        try:
            gp = vg.VX360Gamepad()
            
            def _on_vibration(client, target, large_motor, small_motor, led_number, user_data):
                vid = str(user_data).split('_')[0] if "_" in str(user_data) else str(user_data)
                _emit({
                    "type": "rumble",
                    "viewerId": vid,
                    "strong": large_motor / 255.0,
                    "weak": small_motor / 255.0,
                    "duration": 250
                })

            gp.register_notification(callback_function=_on_vibration)

            gp.update()  # Send an initial neutral state to register with ViGEmBus
            devices[pad_id] = gp
            _log(f"Created virtual gamepad for slot: {pad_id}")
        except Exception as e:
            _error(
                f"Failed to create VX360Gamepad for {pad_id}: {e}  "
                "Ensure ViGEmBus is installed: https://github.com/nefarius/ViGEmBus/releases",
                "VIGEMBUS_CREATE_FAILED"
            )
            return

    gp = devices[pad_id]

    # Node sends:
    #   buttons: integer bitmask (from InputOrchestrator's _gpBuf)
    #   axes:    [lx, ly, rx, ry, lt, rt] where lx/ly/rx/ry are -32767..+32767
    #            and lt/rt are 0..255
    # OR (legacy W3C array path):
    #   buttons: array of { pressed, value }
    #   axes:    array of raw floats

    btns_raw = msg.get("buttons", 0)
    axes_raw = msg.get("axes", [])

    # InputOrchestrator normalizes viewer Gamepad API packets into named scalar
    # fields before forwarding them to the Python sidecar on Windows.
    if isinstance(btns_raw, int) and not axes_raw:
        axes_raw = [
            msg.get("lx", 0),
            msg.get("ly", 0),
            msg.get("rx", 0),
            msg.get("ry", 0),
            int(_clamp(float(msg.get("lt", 0) or 0) * 255.0, 0.0, 255.0)),
            int(_clamp(float(msg.get("rt", 0) or 0) * 255.0, 0.0, 255.0)),
        ]

    try:
        if isinstance(btns_raw, int):
            # Bitmask path — from InputOrchestrator's binary protocol
            _apply_bitmask(gp, btns_raw, axes_raw)
        else:
            # Legacy W3C array path — direct from viewer.js (pre-orchestrator)
            _apply_w3c_array(gp, btns_raw, axes_raw)

        gp.update()

    except Exception as e:
        _error(f"Error updating gamepad {pad_id}: {e}", "GAMEPAD_UPDATE_ERROR")


def _apply_bitmask(gp, buttons: int, axes: list):
    """
    Apply gamepad state from InputOrchestrator's compact bitmask + axes format.

    Bitmask layout (matches InputOrchestrator KBM_BTN_MAP):
      bit 0  (0x0001): A
      bit 1  (0x0002): B
      bit 2  (0x0004): X
      bit 3  (0x0008): Y
      bit 4  (0x0010): D-Up
      bit 5  (0x0020): D-Down
      bit 6  (0x0040): D-Left
      bit 7  (0x0080): D-Right
      bit 8  (0x0100): LB
      bit 9  (0x0200): RB
      bit 10 (0x0400): L3
      bit 11 (0x0800): R3
      bit 12 (0x1000): Start
      bit 13 (0x2000): Select/Back
      bit 14 (0x4000): Guide

    axes[0..3]: lx, ly, rx, ry  — integers -32767..+32767
    axes[4..5]: lt, rt           — integers 0..255
    """
    def _bit(mask): return bool(buttons & mask)
    def _press(const, state):
        if state: gp.press_button(button=const)
        else:     gp.release_button(button=const)

    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_A,              _bit(0x0001))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_B,              _bit(0x0002))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_X,              _bit(0x0004))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,              _bit(0x0008))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP,        _bit(0x0010))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,      _bit(0x0020))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT,      _bit(0x0040))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,     _bit(0x0080))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,  _bit(0x0100))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER, _bit(0x0200))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB,     _bit(0x0400))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB,    _bit(0x0800))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_START,          _bit(0x1000))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK,           _bit(0x2000))
    _press(vg.XUSB_BUTTON.XUSB_GAMEPAD_GUIDE,          _bit(0x4000))

    # Axes: lx/ly/rx/ry are -32767..+32767; lt/rt are 0..255
    if len(axes) >= 2:
        lx = _axis_to_float(axes[0])
        # ly: Node stores Y+ as "down" (positive = down), vgamepad Y+ = "up".
        # Negate ly so pushing the stick forward (up) maps to +Y in vgamepad.
        ly = -_axis_to_float(axes[1])
        gp.left_joystick_float(x_value_float=lx, y_value_float=ly)

    if len(axes) >= 4:
        rx = _axis_to_float(axes[2])
        ry = -_axis_to_float(axes[3])
        gp.right_joystick_float(x_value_float=rx, y_value_float=ry)

    if len(axes) >= 6:
        lt = _trigger_to_float(axes[4])
        rt = _trigger_to_float(axes[5])
        gp.left_trigger_float(value_float=lt)
        gp.right_trigger_float(value_float=rt)


def _apply_w3c_array(gp, btns: list, axes: list):
    """
    Apply gamepad state from the legacy W3C Gamepad API array format.
    Used when the packet arrives directly from viewer.js (not via orchestrator bitmask).

    btns: list of { pressed: bool, value: float } or bare booleans
    axes: list of raw floats -1.0..+1.0 from Gamepad.axes
    """
    _apply_btn(gp, btns, 0, vg.XUSB_BUTTON.XUSB_GAMEPAD_A)
    _apply_btn(gp, btns, 1, vg.XUSB_BUTTON.XUSB_GAMEPAD_B)
    _apply_btn(gp, btns, 2, vg.XUSB_BUTTON.XUSB_GAMEPAD_X)
    _apply_btn(gp, btns, 3, vg.XUSB_BUTTON.XUSB_GAMEPAD_Y)
    _apply_btn(gp, btns, 4, vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER)
    _apply_btn(gp, btns, 5, vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER)
    _apply_btn(gp, btns, 8, vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK)
    _apply_btn(gp, btns, 9, vg.XUSB_BUTTON.XUSB_GAMEPAD_START)
    _apply_btn(gp, btns, 10, vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB)
    _apply_btn(gp, btns, 11, vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB)
    _apply_btn(gp, btns, 12, vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP)
    _apply_btn(gp, btns, 13, vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN)
    _apply_btn(gp, btns, 14, vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT)
    _apply_btn(gp, btns, 15, vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT)
    _apply_btn(gp, btns, 16, vg.XUSB_BUTTON.XUSB_GAMEPAD_GUIDE)

    # W3C axes are already in -1.0..+1.0 range; clamp defensively.
    # Negate Y axes: W3C Y+ = down, ViGEm Y+ = up.
    if len(axes) >= 2:
        lx = _clamp(float(axes[0]), -1.0, 1.0)
        ly = -_clamp(float(axes[1]), -1.0, 1.0)
        gp.left_joystick_float(x_value_float=lx, y_value_float=ly)

    if len(axes) >= 4:
        rx = _clamp(float(axes[2]), -1.0, 1.0)
        ry = -_clamp(float(axes[3]), -1.0, 1.0)
        gp.right_joystick_float(x_value_float=rx, y_value_float=ry)

    # W3C triggers are axes[4]/axes[5] in 0.0..1.0 (some browsers put them in -1..+1)
    if len(axes) >= 6:
        lt = _clamp((float(axes[4]) + 1.0) / 2.0, 0.0, 1.0)
        rt = _clamp((float(axes[5]) + 1.0) / 2.0, 0.0, 1.0)
        gp.left_trigger_float(value_float=lt)
        gp.right_trigger_float(value_float=rt)


if __name__ == "__main__":
    run()
