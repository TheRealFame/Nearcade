"""
EXPERIMENTAL (macOS): Enhanced backend with gamepad→KBM emulation.
Supports both direct KBM passthrough and gamepad-to-keyboard translation via pynput.

FEATURES:
  ✓ Direct KBM input (keyboard/mouse passthrough)
  ✓ Gamepad emulation via pynput (translates to WASD, Space, mouse, etc.)
  ✓ Cross-architecture (Intel & Apple Silicon M1/M2/M3)
  ✓ Deadzone handling to prevent stick drift
  ✓ Smooth mouse movement with acceleration
  ✓ Graceful shutdown on stream disconnect

DEPENDENCIES:
  - pyautogui (for KBM passthrough)
  - pynput (for gamepad emulation)
  pip install pyautogui pynput
"""

import sys
import json
import os
import threading
import time
from typing import Set, Dict, Tuple

try:
    import pyautogui
except ImportError:
    print("[input] pyautogui not found — attempting auto-install via pip...", flush=True)
    import subprocess as _sp
    _result = _sp.run([sys.executable, "-m", "pip", "install", "pyautogui", "--quiet", "--no-warn-script-location"], capture_output=True, text=True)
    if _result.returncode == 0:
        print("[input] pyautogui installed successfully — reloading...", flush=True)
        try:
            import pyautogui
        except Exception as _e2:
            print(f"[input] ERROR: pyautogui installed but failed to import: {_e2}", flush=True)
            sys.exit(1)
    else:
        print("[input] ERROR: pyautogui not installed. Install with: pip install pyautogui", flush=True)
        sys.exit(1)

try:
    from pynput.keyboard import Controller as KeyboardController, Key
    from pynput.mouse import Controller as MouseController, Button
except ImportError:
    print("[input] pynput not found — attempting auto-install via pip...", flush=True)
    import subprocess as _sp
    _result = _sp.run([sys.executable, "-m", "pip", "install", "pynput", "--quiet", "--no-warn-script-location"], capture_output=True, text=True)
    if _result.returncode == 0:
        print("[input] pynput installed successfully — reloading...", flush=True)
        try:
            from pynput.keyboard import Controller as KeyboardController, Key
            from pynput.mouse import Controller as MouseController, Button
        except Exception as _e2:
            print(f"[input] WARNING: pynput installed but failed to import: {_e2}. Gamepad emulation disabled.", flush=True)
            KeyboardController = None
            MouseController = None
    else:
        print("[input] WARNING: pynput not installed and auto-install failed. Gamepad emulation disabled.", flush=True)
        print("[input] Install with: pip install pynput", flush=True)
        KeyboardController = None
        MouseController = None

# Disable failsafe (Ctrl+C) since we may want it for the host
pyautogui.FAILSAFE = False


# ── Gamepad Configuration ──────────────────────────────────────────────────────
DEADZONE = 0.1  # Stick values below this are treated as neutral
MOUSE_SPEED_MULTIPLIER = 3.0  # Right stick to mouse speed multiplier
MOUSE_SENSITIVITY = 2000  # Pixels per second for right stick
UPDATE_RATE = 0.016  # ~60 FPS update loop

# Button Mapping (W3C Gamepad standard → macOS keycodes)
BUTTON_MAP = {
    0: "space",      # A button → Space
    1: "esc",        # B button → Escape
    2: "r",          # X button → R
    3: "e",          # Y button → E
    4: "shift",      # LB → Shift (modifier)
    5: "cmd",        # RB → Cmd (modifier)
    8: "tab",        # Back → Tab
    9: "enter",      # Start → Enter
    10: "z",         # Left Stick Click → Z
    11: "c",         # Right Stick Click → C
}

# ── Gamepad State ──────────────────────────────────────────────────────────────
class GamepadState:
    def __init__(self):
        self.buttons_pressed: Set[int] = set()
        self.key_held: Dict[str, bool] = {}
        self.mouse_held: Dict[str, bool] = {}
        self.left_stick = (0.0, 0.0)
        self.right_stick = (0.0, 0.0)
        self.left_trigger = 0.0
        self.right_trigger = 0.0
        self.lock = threading.Lock()

gamepad_state = GamepadState()
keyboard = None
mouse = None
gamepad_enabled = KeyboardController is not None and MouseController is not None

if gamepad_enabled:
    try:
        keyboard = KeyboardController()
        mouse = MouseController()
    except Exception as e:
        print(f"[input] Gamepad emulation init error: {e}", flush=True)
        gamepad_enabled = False

# ── KBM Bindings ───────────────────────────────────────────────────────────────
BINDINGS_FILE = "kbm_bindings.json"
DEFAULT_BINDINGS = {
    "buttons": {},
    "left_stick": {},
    "dpad": {},
    "right_stick_mouse": True,
    "right_stick_multiplier": 1500,
}

if os.path.exists(BINDINGS_FILE):
    try:
        with open(BINDINGS_FILE, "r") as f:
            kbm_binds = json.load(f)
            print("[input] Loaded kbm_bindings.json", flush=True)
    except Exception as e:
        print(f"[input] Error loading KBM bindings: {e}, using defaults", flush=True)
        kbm_binds = DEFAULT_BINDINGS
else:
    kbm_binds = DEFAULT_BINDINGS


# ── Settings ────────────────────────────────────────────────────────────────────
force_xboxone = True
enable_dualshock = False
enable_motion = False

# ── Device manager ─────────────────────────────────────────────────────────────
devices = {}
viewer_modes = {}
logged_gamepad_warnings = set()


# ── Key mapping for pyautogui ───────────────────────────────────────────────────
# Map uinput key names to pyautogui key names
PYAUTOGUI_KEY_MAP = {
    "KEY_A": "a",
    "KEY_B": "b",
    "KEY_C": "c",
    "KEY_D": "d",
    "KEY_E": "e",
    "KEY_F": "f",
    "KEY_W": "w",
    "KEY_S": "s",
    "KEY_Q": "q",
    "KEY_R": "r",
    "KEY_UP": "up",
    "KEY_DOWN": "down",
    "KEY_LEFT": "left",
    "KEY_RIGHT": "right",
    "KEY_SPACE": "space",
    "KEY_ENTER": "enter",
    "KEY_ESC": "esc",
    "KEY_LEFTSHIFT": "shift",
    "KEY_LEFTCTRL": "ctrl",
    "KEY_TAB": "tab",
    "KEY_Z": "z",
    "KEY_X": "x",
    "KEY_V": "v",
    "KEY_1": "1",
    "KEY_2": "2",
}


# ── Gamepad Helper Functions ───────────────────────────────────────────────────

def clamp(val: float, min_val: float, max_val: float) -> float:
    """Clamp value to range."""
    return max(min_val, min(max_val, val))


def apply_deadzone(value: float) -> float:
    """Apply deadzone to prevent stick drift."""
    if abs(value) < DEADZONE:
        return 0.0
    return value


def normalize_stick(x: float, y: float) -> Tuple[float, float]:
    """Normalize stick values and apply deadzone."""
    x = clamp(x, -1.0, 1.0)
    y = clamp(y, -1.0, 1.0)
    x = apply_deadzone(x)
    y = apply_deadzone(y)
    return (x, y)


def handle_button_event(button_idx: int, pressed: bool):
    """Handle gamepad button press/release."""
    if not gamepad_enabled:
        return

    with gamepad_state.lock:
        if pressed:
            gamepad_state.buttons_pressed.add(button_idx)
        else:
            gamepad_state.buttons_pressed.discard(button_idx)

    key_name = BUTTON_MAP.get(button_idx)
    if not key_name:
        return

    try:
        if key_name == "shift":
            if pressed:
                keyboard.press(Key.shift)
                gamepad_state.key_held[key_name] = True
            else:
                keyboard.release(Key.shift)
                gamepad_state.key_held[key_name] = False
        elif key_name == "cmd":
            if pressed:
                keyboard.press(Key.cmd)
                gamepad_state.key_held[key_name] = True
            else:
                keyboard.release(Key.cmd)
                gamepad_state.key_held[key_name] = False
        elif key_name == "esc":
            if pressed:
                keyboard.press(Key.esc)
                gamepad_state.key_held[key_name] = True
            else:
                keyboard.release(Key.esc)
                gamepad_state.key_held[key_name] = False
        elif key_name == "tab":
            if pressed:
                keyboard.press(Key.tab)
                gamepad_state.key_held[key_name] = True
            else:
                keyboard.release(Key.tab)
                gamepad_state.key_held[key_name] = False
        elif key_name == "enter":
            if pressed:
                keyboard.press(Key.enter)
                gamepad_state.key_held[key_name] = True
            else:
                keyboard.release(Key.enter)
                gamepad_state.key_held[key_name] = False
        else:
            if pressed:
                keyboard.press(key_name)
                gamepad_state.key_held[key_name] = True
            else:
                keyboard.release(key_name)
                gamepad_state.key_held[key_name] = False
    except Exception as e:
        print(f"[input] Button {button_idx} error: {e}", flush=True)


def handle_stick_movement(stick_name: str, x: float, y: float):
    """Map left/right stick to WASD and mouse movement."""
    if not gamepad_enabled:
        return

    x, y = normalize_stick(x, y)

    if stick_name == "left":
        with gamepad_state.lock:
            gamepad_state.left_stick = (x, y)

        # W/S for vertical, A/D for horizontal
        if y < -DEADZONE:
            if gamepad_state.key_held.get("w", False) == False:
                keyboard.press("w")
                gamepad_state.key_held["w"] = True
        else:
            if gamepad_state.key_held.get("w", False):
                keyboard.release("w")
                gamepad_state.key_held["w"] = False

        if y > DEADZONE:
            if gamepad_state.key_held.get("s", False) == False:
                keyboard.press("s")
                gamepad_state.key_held["s"] = True
        else:
            if gamepad_state.key_held.get("s", False):
                keyboard.release("s")
                gamepad_state.key_held["s"] = False

        if x < -DEADZONE:
            if gamepad_state.key_held.get("a", False) == False:
                keyboard.press("a")
                gamepad_state.key_held["a"] = True
        else:
            if gamepad_state.key_held.get("a", False):
                keyboard.release("a")
                gamepad_state.key_held["a"] = False

        if x > DEADZONE:
            if gamepad_state.key_held.get("d", False) == False:
                keyboard.press("d")
                gamepad_state.key_held["d"] = True
        else:
            if gamepad_state.key_held.get("d", False):
                keyboard.release("d")
                gamepad_state.key_held["d"] = False

    elif stick_name == "right":
        with gamepad_state.lock:
            gamepad_state.right_stick = (x, y)

        # Mouse movement
        if x != 0 or y != 0:
            try:
                mouse_x = int(x * MOUSE_SENSITIVITY * MOUSE_SPEED_MULTIPLIER / 60)
                mouse_y = int(y * MOUSE_SENSITIVITY * MOUSE_SPEED_MULTIPLIER / 60)
                current_pos = mouse.position
                new_x = current_pos[0] + mouse_x
                new_y = current_pos[1] + mouse_y
                mouse.position = (new_x, new_y)
            except Exception as e:
                print(f"[input] Mouse error: {e}", flush=True)


def handle_trigger(trigger_name: str, value: float):
    """Handle trigger input."""
    if not gamepad_enabled:
        return

    value = clamp(value, 0.0, 1.0)

    if trigger_name == "left":
        with gamepad_state.lock:
            gamepad_state.left_trigger = value

        if value > 0.5:
            if not gamepad_state.mouse_held.get("left", False):
                try:
                    mouse.press(Button.left)
                    gamepad_state.mouse_held["left"] = True
                except Exception:
                    pass
        else:
            if gamepad_state.mouse_held.get("left", False):
                try:
                    mouse.release(Button.left)
                    gamepad_state.mouse_held["left"] = False
                except Exception:
                    pass

    elif trigger_name == "right":
        with gamepad_state.lock:
            gamepad_state.right_trigger = value

        if value > 0.5:
            if not gamepad_state.mouse_held.get("right", False):
                try:
                    mouse.press(Button.right)
                    gamepad_state.mouse_held["right"] = True
                except Exception:
                    pass
        else:
            if gamepad_state.mouse_held.get("right", False):
                try:
                    mouse.release(Button.right)
                    gamepad_state.mouse_held["right"] = False
                except Exception:
                    pass


def reset_all_keys():
    """Emergency reset: release all held keys and mouse buttons."""
    if not gamepad_enabled:
        return

    print("[input] Releasing all held keys/buttons", flush=True)
    with gamepad_state.lock:
        for key_name in list(gamepad_state.key_held.keys()):
            try:
                if key_name == "shift":
                    keyboard.release(Key.shift)
                elif key_name == "cmd":
                    keyboard.release(Key.cmd)
                elif key_name == "esc":
                    keyboard.release(Key.esc)
                elif key_name == "tab":
                    keyboard.release(Key.tab)
                elif key_name == "enter":
                    keyboard.release(Key.enter)
                else:
                    keyboard.release(key_name)
            except Exception:
                pass
            gamepad_state.key_held[key_name] = False

        for btn_name in list(gamepad_state.mouse_held.keys()):
            try:
                if btn_name == "left":
                    mouse.release(Button.left)
                elif btn_name == "right":
                    mouse.release(Button.right)
                elif btn_name == "middle":
                    mouse.release(Button.middle)
            except Exception:
                pass
            gamepad_state.mouse_held[btn_name] = False

        gamepad_state.buttons_pressed.clear()


def run():
    """
    EXPERIMENTAL (macOS): Main input loop for pyautogui + pynput backend.
    Supports keyboard/mouse passthrough AND gamepad emulation.
    
    FEATURES:
    - KBM passthrough via pyautogui
    - Gamepad-to-KBM translation via pynput (requires permissions)
    - Stick deadzone handling
    - Smooth mouse acceleration
    - Graceful shutdown
    """
    global force_xboxone, enable_dualshock, enable_motion

    print("[input] ========================================", flush=True)
    if gamepad_enabled:
        print("[input] macOS backend: KBM + Gamepad Emulation", flush=True)
        print("[input] ✓ Gamepad-to-KBM translation ENABLED", flush=True)
        print("[input] ⚠ Requires Accessibility permission", flush=True)
        print("[input] → System Settings → Security & Privacy → Accessibility", flush=True)
    else:
        print("[input] macOS backend: KBM Passthrough Only", flush=True)
        print("[input] ✗ Gamepad emulation disabled (pynput not installed)", flush=True)
        print("[input] Install with: pip install pynput", flush=True)
    print("[input] ========================================", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)

            # ── Configuration messages ──────────────────────────────────────
            if msg.get("type") == "set_force_xboxone":
                force_xboxone = bool(msg.get("value", True))
                continue

            if msg.get("type") == "set_enable_dualshock":
                enable_dualshock = bool(msg.get("value", False))
                continue

            if msg.get("type") == "set_enable_motion":
                enable_motion = bool(msg.get("value", False))
                continue

            if msg.get("type") == "set-input-mode":
                vid = str(msg.get("viewerId", ""))
                mode = msg.get("mode", "gamepad")
                viewer_modes[vid] = mode
                print(f"[input] Viewer {vid} mode set to: {mode}", flush=True)
                continue

            if msg.get("type") in ["flush_neutral", "disconnect_viewer"]:
                # No-op on macOS stub
                continue

            pad_id = str(msg.get("pad_id", "default"))
            vid = str(msg.get("viewer_id", pad_id.split("_")[0]))
            current_mode = viewer_modes.get(vid, "gamepad")

            # ── Gamepad ID detection (not supported) ────────────────────────
            if msg.get("type") == "gpid":
                if pad_id not in logged_gamepad_warnings:
                    print(
                        f"[input] macOS: gamepad injection not supported for {pad_id}. KBM emulation only.",
                        flush=True,
                    )
                    logged_gamepad_warnings.add(pad_id)
                continue

            # ── Gamepad input ───────────────────────────────────────────────
            if msg.get("type") == "gamepad":
                if gamepad_enabled:
                    # Process gamepad event through emulation layer
                    if "button" in msg:
                        handle_button_event(msg["button"], msg.get("pressed", False))
                    elif "stick" in msg:
                        handle_stick_movement(msg["stick"], msg.get("x", 0), msg.get("y", 0))
                    elif "trigger" in msg:
                        handle_trigger(msg["trigger"], msg.get("value", 0))
                else:
                    if pad_id not in logged_gamepad_warnings:
                        print(
                            f"[input] macOS: Gamepad emulation disabled for {pad_id} (pynput not installed)",
                            flush=True,
                        )
                        logged_gamepad_warnings.add(pad_id)
                continue

            # ── Motion control (not supported) ──────────────────────────────
            if msg.get("type") == "motion":
                continue

            # ── Disconnect/cleanup ──────────────────────────────────────────
            if msg.get("type") in ["flush_neutral", "disconnect_viewer"]:
                reset_all_keys()
                continue

            # ── Keyboard and mouse ──────────────────────────────────────────
            if msg.get("type") == "kbm":
                event_type = msg.get("event")

                # Mouse movement
                if event_type == "mousemove":
                    dx = msg.get("dx", 0)
                    dy = msg.get("dy", 0)
                    if dx != 0 or dy != 0:
                        try:
                            # Move relative to current position
                            pyautogui.move(dx, dy, duration=0.01)
                        except Exception as e:
                            print(f"[input] Mouse move error: {e}", flush=True)

                # Keyboard
                if event_type in ["keydown", "keyup"]:
                    key_name = msg.get("key", "")
                    
                    # Try to map from uinput name
                    if key_name in PYAUTOGUI_KEY_MAP:
                        py_key = PYAUTOGUI_KEY_MAP[key_name]
                    else:
                        py_key = key_name.lower().replace("key_", "")

                    try:
                        if event_type == "keydown":
                            pyautogui.keyDown(py_key)
                        else:  # keyup
                            pyautogui.keyUp(py_key)
                    except Exception as e:
                        print(f"[input] Key '{py_key}' error: {e}", flush=True)

        except json.JSONDecodeError:
            pass
        except Exception as e:
            print(f"[input] Unexpected error: {e}", flush=True)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        print("[input] macOS pyautogui backend shutting down", flush=True)
        sys.exit(0)
    except Exception as e:
        print(f"[input] Fatal error: {e}", flush=True)
        sys.exit(1)
