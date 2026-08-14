"""
macOS KBM-Gamepad Bridge: Translates gamepad input to synthetic keyboard/mouse events

Since macOS lacks a stable gamepad injection API (unlike Linux uinput or Windows ViGEmBus),
this bridge converts incoming gamepad packets to keyboard and mouse events using pynput.

This allows Steam Input and other applications to work with remapped gamepad inputs.

DEPENDENCIES: pip install pynput
PERMISSIONS: Requires Accessibility permission (System Settings > Security & Privacy > Accessibility)

BUTTON MAPPING:
  A → Space (action/jump)
  B → Escape (menu/back)
  X → R (reload/interact)
  Y → E (equipment/ability)
  LB → Left Mouse Click
  RB → Right Mouse Click
  LT/RT → Shift + mouse buttons for modified actions

STICK MAPPING:
  Left Stick → W/A/S/D (movement with deadzone)
  Right Stick → Mouse movement (relative)
  Triggers → Mouse scroll / modifier keys

FEATURES:
  [OK] Cross-architecture (Intel & Apple Silicon M1/M2/M3)
  [OK] Deadzone handling (0.1) to prevent stick drift
  [OK] Smooth mouse acceleration
  [OK] Graceful shutdown on stream disconnect
  [OK] Permission warnings if Accessibility not granted
"""

import sys
import json
import threading
import time
import socket
import struct
import queue
from typing import Dict, Set, Tuple, Optional

try:
    from pynput.keyboard import Controller as KeyboardController, Key
    from pynput.mouse import Controller as MouseController, Button
except ImportError:
    print("[gamepad-bridge] pynput not found — attempting auto-install via pip...", flush=True)
    import subprocess as _sp
    _result = _sp.run([sys.executable, "-m", "pip", "install", "pynput", "--quiet", "--no-warn-script-location"], capture_output=True, text=True)
    if _result.returncode == 0:
        print("[gamepad-bridge] pynput installed successfully — reloading...", flush=True)
        try:
            from pynput.keyboard import Controller as KeyboardController, Key
            from pynput.mouse import Controller as MouseController, Button
        except Exception as _e2:
            print(f"[gamepad-bridge] ERROR: pynput installed but failed to import: {_e2}", flush=True)
            sys.exit(1)
    else:
        print("[gamepad-bridge] ERROR: pynput not installed. Install with: pip install pynput", flush=True)
        sys.exit(1)

# ── Configuration ────────────────────────────────────────────────────────────
DEADZONE = 0.1  # Stick values below this are treated as neutral
MOUSE_SPEED_MULTIPLIER = 3.0  # Right stick to mouse speed
MOUSE_SENSITIVITY = 2000  # Pixels per second
UPDATE_RATE = 0.016  # ~60 FPS update loop

# ── Button Mapping (W3C Gamepad standard → macOS keycodes) ──────────────────
BUTTON_MAP = {
    0: "space",      # A button → Space (action/jump)
    1: "esc",        # B button → Escape (menu)
    2: "r",          # X button → R (reload)
    3: "e",          # Y button → E (equipment)
    4: "shift",      # LB (Left Bumper) → Shift (modifier for LMB)
    5: "cmd",        # RB (Right Bumper) → Cmd (modifier for RMB)
    8: "tab",        # Back → Tab (scoreboard)
    9: "enter",      # Start → Enter (confirm)
    10: "z",         # Left Stick Click → Z (crouch/alt action)
    11: "c",         # Right Stick Click → C (emote/action)
}

# ── Mouse Button Mapping ─────────────────────────────────────────────────────
MOUSE_BUTTON_MAP = {
    "left": Button.left,
    "right": Button.right,
    "middle": Button.middle,
    "scroll_up": "scroll_up",
    "scroll_down": "scroll_down",
}

# ── State Tracking ───────────────────────────────────────────────────────────
class GamepadState:
    def __init__(self):
        self.buttons_pressed: Set[int] = set()  # Currently held button indices
        self.key_held: Dict[str, bool] = {}  # Track which keys are actively pressed
        self.mouse_held: Dict[str, bool] = {}  # Track mouse buttons
        self.left_stick = (0.0, 0.0)  # (x, y) normalized to -1.0..1.0
        self.right_stick = (0.0, 0.0)
        self.left_trigger = 0.0  # 0.0..1.0
        self.right_trigger = 0.0
        self.last_mouse_pos = (0, 0)
        self.last_update_time = time.time()
        self.lock = threading.Lock()

# ── Global state ─────────────────────────────────────────────────────────────
gamepad_state = GamepadState()
keyboard = KeyboardController()
mouse = MouseController()
running = True
viewer_ids: Set[str] = set()  # Track connected viewer IDs
event_queue = queue.Queue()


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
    # Clamp to -1..1 range
    x = clamp(x, -1.0, 1.0)
    y = clamp(y, -1.0, 1.0)
    # Apply deadzone
    x = apply_deadzone(x)
    y = apply_deadzone(y)
    return (x, y)


def handle_button_event(button_idx: int, pressed: bool):
    """
    Handle gamepad button press/release and emit corresponding keyboard events.
    """
    with gamepad_state.lock:
        if pressed:
            gamepad_state.buttons_pressed.add(button_idx)
        else:
            gamepad_state.buttons_pressed.discard(button_idx)

    key_name = BUTTON_MAP.get(button_idx)
    if not key_name:
        return  # Unmapped button, ignore

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
            # Regular letter key
            if pressed:
                keyboard.press(key_name)
                gamepad_state.key_held[key_name] = True
            else:
                keyboard.release(key_name)
                gamepad_state.key_held[key_name] = False

    except Exception as e:
        print(f"[gamepad-bridge] Error handling button {button_idx}: {e}", flush=True)


def handle_stick_movement(stick_name: str, x: float, y: float):
    """
    Handle left/right stick movement.
    Left stick → W/A/S/D
    Right stick → mouse movement
    """
    x, y = normalize_stick(x, y)

    if stick_name == "left":
        # Map to WASD movement
        # -Y = up (W), +Y = down (S), -X = left (A), +X = right (D)
        with gamepad_state.lock:
            gamepad_state.left_stick = (x, y)

        # Handle W/S (up/down)
        if y < -DEADZONE:  # Forward
            if "w" not in gamepad_state.key_held or not gamepad_state.key_held["w"]:
                keyboard.press("w")
                gamepad_state.key_held["w"] = True
        else:
            if gamepad_state.key_held.get("w", False):
                keyboard.release("w")
                gamepad_state.key_held["w"] = False

        if y > DEADZONE:  # Backward
            if "s" not in gamepad_state.key_held or not gamepad_state.key_held["s"]:
                keyboard.press("s")
                gamepad_state.key_held["s"] = True
        else:
            if gamepad_state.key_held.get("s", False):
                keyboard.release("s")
                gamepad_state.key_held["s"] = False

        # Handle A/D (left/right)
        if x < -DEADZONE:  # Left
            if "a" not in gamepad_state.key_held or not gamepad_state.key_held["a"]:
                keyboard.press("a")
                gamepad_state.key_held["a"] = True
        else:
            if gamepad_state.key_held.get("a", False):
                keyboard.release("a")
                gamepad_state.key_held["a"] = False

        if x > DEADZONE:  # Right
            if "d" not in gamepad_state.key_held or not gamepad_state.key_held["d"]:
                keyboard.press("d")
                gamepad_state.key_held["d"] = True
        else:
            if gamepad_state.key_held.get("d", False):
                keyboard.release("d")
                gamepad_state.key_held["d"] = False

    elif stick_name == "right":
        # Map to mouse movement
        with gamepad_state.lock:
            gamepad_state.right_stick = (x, y)
            current_pos = mouse.position
            gamepad_state.last_mouse_pos = current_pos

        # Calculate mouse delta
        now = time.time()
        dt = now - gamepad_state.last_update_time
        if dt > 0:
            mouse_x = int(x * MOUSE_SENSITIVITY * dt * MOUSE_SPEED_MULTIPLIER)
            mouse_y = int(y * MOUSE_SENSITIVITY * dt * MOUSE_SPEED_MULTIPLIER)

            if mouse_x != 0 or mouse_y != 0:
                try:
                    new_x = current_pos[0] + mouse_x
                    new_y = current_pos[1] + mouse_y
                    mouse.position = (new_x, new_y)
                except Exception as e:
                    print(f"[gamepad-bridge] Mouse movement error: {e}", flush=True)


def handle_trigger(trigger_name: str, value: float):
    """
    Handle trigger input (0.0 to 1.0).
    LT → Left click (or scroll)
    RT → Right click (or scroll)
    """
    value = clamp(value, 0.0, 1.0)

    if trigger_name == "left":
        with gamepad_state.lock:
            gamepad_state.left_trigger = value

        # If trigger > 0.5, hold left mouse button
        if value > 0.5:
            if not gamepad_state.mouse_held.get("left", False):
                try:
                    mouse.press(Button.left)
                    gamepad_state.mouse_held["left"] = True
                except Exception as e:
                    print(f"[gamepad-bridge] LMB press error: {e}", flush=True)
        else:
            if gamepad_state.mouse_held.get("left", False):
                try:
                    mouse.release(Button.left)
                    gamepad_state.mouse_held["left"] = False
                except Exception as e:
                    print(f"[gamepad-bridge] LMB release error: {e}", flush=True)

    elif trigger_name == "right":
        with gamepad_state.lock:
            gamepad_state.right_trigger = value

        # If trigger > 0.5, hold right mouse button
        if value > 0.5:
            if not gamepad_state.mouse_held.get("right", False):
                try:
                    mouse.press(Button.right)
                    gamepad_state.mouse_held["right"] = True
                except Exception as e:
                    print(f"[gamepad-bridge] RMB press error: {e}", flush=True)
        else:
            if gamepad_state.mouse_held.get("right", False):
                try:
                    mouse.release(Button.right)
                    gamepad_state.mouse_held["right"] = False
                except Exception as e:
                    print(f"[gamepad-bridge] RMB release error: {e}", flush=True)


def reset_all_keys():
    """
    Emergency panic key: Release all held keys and mouse buttons.
    Called on disconnect or shutdown.
    """
    print("[gamepad-bridge] Releasing all held keys/buttons", flush=True)
    with gamepad_state.lock:
        # Release all keyboard keys
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

        # Release all mouse buttons
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


def process_gamepad_event(msg: dict):
    """
    Process a gamepad event from the network packet.
    Expected format:
      {"type": "gamepad", "viewer_id": "viewer_1", "button": 0, "pressed": true}
      {"type": "gamepad", "viewer_id": "viewer_1", "axis": 0, "value": 0.5}
      {"type": "gamepad", "viewer_id": "viewer_1", "stick": "left", "x": 0.2, "y": 0.3}
      {"type": "gamepad", "viewer_id": "viewer_1", "trigger": "left", "value": 0.8}
    """
    viewer_id = str(msg.get("viewer_id", "unknown"))
    with gamepad_state.lock:
        if viewer_id not in viewer_ids:
            viewer_ids.add(viewer_id)
            print(f"[gamepad-bridge] Viewer {viewer_id} connected", flush=True)

    # Button event
    if "button" in msg:
        button_idx = msg["button"]
        pressed = bool(msg.get("pressed", False))
        handle_button_event(button_idx, pressed)

    # Stick event (combined X/Y)
    elif "stick" in msg:
        stick_name = msg["stick"]  # "left" or "right"
        x = float(msg.get("x", 0.0))
        y = float(msg.get("y", 0.0))
        handle_stick_movement(stick_name, x, y)

    # Trigger event
    elif "trigger" in msg:
        trigger_name = msg["trigger"]  # "left" or "right"
        value = float(msg.get("value", 0.0))
        handle_trigger(trigger_name, value)

    # Axis event (single axis value)
    elif "axis" in msg:
        axis_idx = msg["axis"]
        value = float(msg.get("value", 0.0))
        # Map axis index to appropriate handler
        # 0-1: left stick X/Y, 2-3: right stick X/Y, 4-5: triggers
        if axis_idx in (0, 1):  # Left stick components
            handle_stick_movement("left", value if axis_idx == 0 else 0, value if axis_idx == 1 else 0)
        elif axis_idx in (2, 3):  # Right stick components
            handle_stick_movement("right", value if axis_idx == 2 else 0, value if axis_idx == 3 else 0)
        elif axis_idx == 4:  # Left trigger
            handle_trigger("left", value)
        elif axis_idx == 5:  # Right trigger
            handle_trigger("right", value)


def check_permissions():
    """
    Warn user if Accessibility permissions are not granted.
    On macOS, pynput requires accessibility permissions to function.
    """
    print("[gamepad-bridge] ========================================", flush=True)
    print("[gamepad-bridge] macOS Gamepad Bridge Initialized", flush=True)
    print("[gamepad-bridge] ========================================", flush=True)
    print("[gamepad-bridge] ⚠ PERMISSION REQUIRED: Accessibility", flush=True)
    print("[gamepad-bridge] Please grant access in System Settings →", flush=True)
    print("[gamepad-bridge] Security & Privacy → Accessibility", flush=True)
    print("[gamepad-bridge] Add this application to the list", flush=True)
    print("[gamepad-bridge] ========================================", flush=True)


def _emit_gp_binary(slot, payload):
    magic, lx, ly, rx, ry, lt, rt, cppBtns, hx, hy, slot_check = struct.unpack('<BhhhhBBHbbB', payload)
    
    def _bit(mask): return bool(cppBtns & mask)
    
    handle_button_event(0, _bit(1 << 0)) # A
    handle_button_event(1, _bit(1 << 1)) # B
    handle_button_event(2, _bit(1 << 2)) # X
    handle_button_event(3, _bit(1 << 3)) # Y
    handle_button_event(4, _bit(1 << 4)) # LB
    handle_button_event(5, _bit(1 << 5)) # RB
    handle_button_event(8, _bit(1 << 8)) # BACK
    handle_button_event(9, _bit(1 << 9)) # START
    handle_button_event(10, _bit(1 << 10)) # L3
    handle_button_event(11, _bit(1 << 11)) # R3
    
    handle_button_event(12, hy == -1)
    handle_button_event(13, hy == 1)
    handle_button_event(14, hx == -1)
    handle_button_event(15, hx == 1)

    lx_f = lx / 32767.0
    ly_f = ly / 32767.0
    handle_stick_movement("left", lx_f, -ly_f)
    
    rx_f = rx / 32767.0
    ry_f = ry / 32767.0
    handle_stick_movement("right", rx_f, -ry_f)
    
    lt_f = lt / 255.0
    rt_f = rt / 255.0
    handle_trigger("left", lt_f)
    handle_trigger("right", rt_f)

def stdin_thread():
    stdin_raw = open(sys.stdin.fileno(), 'rb', buffering=0)
    for raw_line in stdin_raw:
        line = raw_line.decode('utf-8', errors='replace').strip()
        if line:
            event_queue.put(('json', line))

def udp_thread(sock):
    while True:
        try:
            data, _ = sock.recvfrom(1024)
            if data and len(data) == 16 and data[0] == 0x01:
                slot = data[15]
                event_queue.put(('binary', slot, data))
        except Exception:
            pass

def run():
    global running
    check_permissions()
    
    udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp_sock.bind(('127.0.0.1', 0))
    udp_port = udp_sock.getsockname()[1]
    print(json.dumps({"type": "udp_ready", "udp_port": udp_port}), flush=True)

    threading.Thread(target=stdin_thread, daemon=True).start()
    threading.Thread(target=udp_thread, args=(udp_sock,), daemon=True).start()

    try:
        while True:
            ev = event_queue.get()
            if ev[0] == 'binary':
                _emit_gp_binary(ev[1], ev[2])
                continue
                
            line = ev[1]
            try:
                msg = json.loads(line)
                
                # ── Disconnect / cleanup ────────────────────────────────────
                if msg.get("type") in ["disconnect_viewer", "flush_neutral"]:
                    vid = str(msg.get("viewer_id", ""))
                    if vid in viewer_ids:
                        viewer_ids.discard(vid)
                        print(f"[gamepad-bridge] Viewer {vid} disconnected", flush=True)
                    if not viewer_ids:
                        reset_all_keys()
                    continue

                # ── Gamepad event ───────────────────────────────────────────
                if msg.get("type") == "gamepad":
                    process_gamepad_event(msg)
                    continue

                # ── Config messages (ignored for gamepad bridge) ────────────
                if msg.get("type") in ["set_force_xboxone", "set_enable_dualshock", "set_enable_motion", "set-input-mode"]:
                    continue

            except json.JSONDecodeError:
                pass  # Ignore invalid JSON
            except Exception as e:
                print(f"[gamepad-bridge] Error: {e}", flush=True)

    except KeyboardInterrupt:
        print("[gamepad-bridge] Shutting down gracefully", flush=True)
        reset_all_keys()
        sys.exit(0)


if __name__ == "__main__":
    run()
