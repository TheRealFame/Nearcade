"""
Linux uinput backend — stable, primary target.

KBM Emulation logic:
  1. If a window-focus message arrives AND the title matches a CSV row,
     use the CSV flat bindings for that game. All viewers switch to kbm_emulated.
  2. If no CSV match (or no window-focus received), fall back to kbm_bindings.json.
  3. Gamepad mode works independently and is unaffected.
  4. Hybrid toggle (ctrl-settings-hybrid) disables auto-map and resets to gamepad.

CSV format (17 data columns after title):
  title, KEY_W, KEY_A, KEY_S, KEY_D, KEY_SPACE, KEY_J, KEY_K, KEY_L,
         KEY_U, KEY_I, KEY_O, KEY_P, KEY_M, KEY_N, KEY_ENTER, KEY_TAB, KEY_ESCAPE
  Values: BTN_* for face buttons, ABS_Y_UP / ABS_Y_DOWN / ABS_X_LEFT / ABS_X_RIGHT for sticks,
          ABS_HAT0Y_UP etc for d-pad, or blank to ignore that key.
"""

import sys, json, os, atexit, csv, gc
import time
import struct
import threading
import select
from collections import deque

try:
    import uinput
    UINPUT_OK = True
except ImportError:
    print(json.dumps({"type": "error", "code": "E100", "message": "python-uinput is missing or /dev/uinput lacks permissions. Please run the setup script!"}), flush=True)
    UINPUT_OK = False

if UINPUT_OK:
    W3C_MAP = {
        0: uinput.BTN_A,    1: uinput.BTN_B,    2: uinput.BTN_Y,    3: uinput.BTN_X, # FIX: Swapped X/Y for PS4 Native
        4: uinput.BTN_TL,   5: uinput.BTN_TR,
        8: uinput.BTN_SELECT, 9: uinput.BTN_START,
        10: uinput.BTN_THUMBL, 11: uinput.BTN_THUMBR,
        16: uinput.BTN_MODE,
    }
    BTNS = list(W3C_MAP.values())
    # Add L2/R2 capabilities so the CSV shooters can actually fire
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



# ── Controller profiles ────────────────────────────────────────────────────────
PROFILES = {
    'xbox360':     (0x045E, 0x028E, 0x0110, 'Xbox 360 Controller'),
    'xboxone':     (0x045E, 0x02EA, 0x0101, 'Xbox One Controller'),
    'xbox':        (0x045E, 0x028E, 0x0110, 'Xbox 360 Controller'),
    'ds4':         (0x054C, 0x09CC, 0x0100, 'Wireless Controller'),
    'ps4':         (0x054C, 0x09CC, 0x0100, 'Wireless Controller'),
    'playstation': (0x054C, 0x09CC, 0x0100, 'Wireless Controller'),
    'dualshock4':  (0x054C, 0x09CC, 0x0100, 'Wireless Controller'),
    'dualsense':   (0x054C, 0x0CE6, 0x0100, 'Wireless Controller'),
    'switchpro':   (0x057E, 0x2009, 0x0001, 'Pro Controller'),
    'switch':      (0x057E, 0x2009, 0x0001, 'Pro Controller'),
    'nintendo':    (0x057E, 0x2009, 0x0001, 'Pro Controller'),
}

# ── KBM passthrough device ────────────────────────────────────────────────────
kbm_device = None
if UINPUT_OK:
    KBM_EVENTS = [uinput.REL_X, uinput.REL_Y, uinput.REL_WHEEL,
                  uinput.BTN_LEFT, uinput.BTN_RIGHT, uinput.BTN_MIDDLE]
    for _n in dir(uinput):
        if _n.startswith("KEY_"):
            KBM_EVENTS.append(getattr(uinput, _n))
    try:
        kbm_device = uinput.Device(KBM_EVENTS, name="Nearsec_KBM_Injector")
    except Exception as e:
        print(json.dumps({"type": "error", "code": "E101", "message": f"KBM device failed (check /dev/uinput permissions): {e}"}), flush=True)

# ── State ──────────────────────────────────────────────────────────────────────
devices          = {}
device_profiles  = {}
viewer_modes     = {}   # vid → 'gamepad' | 'kbm' | 'kbm_emulated' | 'disabled'
viewer_ctrl_type = {}   # vid → profile key
_input_queues    = {}
_active_binds    = None
_auto_map_on     = True
_is_hybrid       = False





# ── Find CSV ──────────────────────────────────────────────────────────────────
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_CSV_PATH   = None
_search     = _SCRIPT_DIR
for _ in range(5):
    for candidate in [
        os.path.join(_search, 'config', 'game_profiles.csv'),
        os.path.join(_search, 'game_profiles.csv'),
    ]:
        if os.path.exists(candidate):
            _CSV_PATH = candidate
            break
    if _CSV_PATH:
        break
    _search = os.path.dirname(_search)

if _CSV_PATH:
    print(f"[input] CSV database: {_CSV_PATH}", flush=True)
else:
    print("[input] WARNING: game_profiles.csv not found — CSV auto-map disabled", flush=True)

# ── Find JSON fallback ─────────────────────────────────────────────────────────
_JSON_PATH  = None
_search     = _SCRIPT_DIR
for _ in range(5):
    for candidate in [
        os.path.join(_search, 'config', 'kbm_bindings.json'),
        os.path.join(_search, 'kbm_presets', 'kbm_bindings.json'),
        os.path.join(_search, 'kbm_bindings.json'),
    ]:
        if os.path.exists(candidate):
            _JSON_PATH = candidate
            break
    if _JSON_PATH:
        break
    _search = os.path.dirname(_search)

if _JSON_PATH:
    print(f"[input] JSON fallback: {_JSON_PATH}", flush=True)
else:
    print("[input] WARNING: kbm_bindings.json not found — no KBM fallback", flush=True)

# ── CSV column order ───────────────────────────────────────────────────────────
CSV_KEYS = [
    "KEY_W", "KEY_A", "KEY_S", "KEY_D",
    "KEY_SPACE", "KEY_J", "KEY_K", "KEY_L",
    "KEY_U", "KEY_I", "KEY_O", "KEY_P",
    "KEY_M", "KEY_N", "KEY_ENTER", "KEY_TAB", "KEY_ESCAPE",
]

_csv_entries = []

def _load_csv():
    global _csv_entries
    if not _CSV_PATH:
        return
    rows = []
    bad  = 0
    try:
        with open(_CSV_PATH, newline='', encoding='utf-8') as f:
            for line_num, row in enumerate(csv.reader(f), start=1):
                if not row or row[0].strip().startswith('#'):
                    continue
                frag = row[0].strip().lower()
                if not frag:
                    continue

                # Validate column count — a row with fewer than 2 columns has
                # no bindings and is almost always a formatting mistake.
                if len(row) < 2:
                    print(f"[input] CSV line {line_num}: skipping row '{row[0].strip()}' — no binding columns", flush=True)
                    bad += 1
                    continue

                # Validate that binding values look like key names (KEY_* or BTN_*)
                # rather than garbage data from a broken export.
                binds = {}
                for i, key in enumerate(CSV_KEYS):
                    col = i + 1
                    if col < len(row):
                        val = row[col].strip()
                        if not val:
                            continue
                        if not (val.startswith('KEY_') or val.startswith('BTN_') or val.startswith('ABS_')):
                            print(f"[input] CSV line {line_num}: unrecognised binding value '{val}' for {key} — skipping column", flush=True)
                            bad += 1
                            continue
                        binds[key] = val

                if binds:
                    rows.append((frag, binds))
                else:
                    print(f"[input] CSV line {line_num}: '{row[0].strip()}' has no valid bindings — skipping", flush=True)
                    bad += 1

        _csv_entries = rows
        if bad:
            print(f"[input] CSV loaded {len(_csv_entries)} profiles ({bad} row(s) skipped — check game_profiles.csv)", flush=True)
        else:
            print(f"[input] Loaded {len(_csv_entries)} CSV game profiles", flush=True)
    except Exception as e:
        print(f"[input] CSV load error: {e}", flush=True)

def resolve_csv(title: str):
    if not title:
        return None
    tl = title.lower()
    for frag, binds in _csv_entries:
        if frag in tl:
            return binds
    return None

_load_csv()

# ── JSON fallback loader ───────────────────────────────────────────────────────
_json_binds = None

def load_json_fallback():
    global _json_binds
    if _json_binds is not None:
        return _json_binds
    if not _JSON_PATH:
        return None
    try:
        with open(_JSON_PATH) as f:
            _json_binds = json.load(f)
        print(f"[input] JSON fallback loaded", flush=True)
        return _json_binds
    except Exception as e:
        print(f"[input] JSON load error: {e}", flush=True)
        return None

load_json_fallback()

# ── atexit cleanup ─────────────────────────────────────────────────────────────
def _cleanup():
    global kbm_device
    print("[input] Destroying virtual devices...", flush=True)
    _btn_held.clear()
    for dev in list(devices.values()):
        try: dev.destroy()
        except Exception: pass
    devices.clear()
    if kbm_device:
        try: kbm_device.destroy()
        except Exception: pass
    kbm_device = None


atexit.register(_cleanup)

# ── Device factory ─────────────────────────────────────────────────────────────
def make_gamepad(profile_key: str = 'xbox360'):
    if not UINPUT_OK:
        return None
    v, p, ver, real_name = PROFILES.get(profile_key, PROFILES['xbox360'])

    # bustype=3 tells Linux/Steam this is a physical USB device (BUS_USB).
    return uinput.Device(BTNS + AXES, name=real_name, vendor=v, product=p, version=ver, bustype=3)

# ── Input queue (gamepad path) ─────────────────────────────────────────────────
def _enqueue(pad_id, msg):
    if pad_id not in _input_queues:
        _input_queues[pad_id] = deque(maxlen=64)
    _input_queues[pad_id].append(msg)

def _drain(pad_id):
    q = _input_queues.get(pad_id)
    while q:
        _emit_gp(pad_id, q.popleft())

def _emit_gp(pad_id, msg):
    if not UINPUT_OK: return
    gp = devices.get(pad_id)
    if not gp: return
    
    # Check if we are receiving the new flat schema from InputOrchestrator validation
    if "lx" in msg or isinstance(msg.get("buttons"), int):
        btns_mask = msg.get("buttons", 0)
        lx = msg.get("lx", 0)
        ly = msg.get("ly", 0)
        rx = msg.get("rx", 0)
        ry = msg.get("ry", 0)
        lt = msg.get("lt", 0.0)
        rt = msg.get("rt", 0.0)
        
        # Correct bitmask values matching W3C_TO_JS in server.js
        JS_BITMASK = {
            0: 0x0001, 1: 0x0002, 2: 0x0004, 3: 0x0008,   # A, B, X, Y
            4: 0x0100, 5: 0x0200,                         # LB, RB
            8: 0x2000, 9: 0x1000,                         # Select, Start
            10: 0x0400, 11: 0x0800,                       # L3, R3
            16: 0x4000                                    # Guide
        }
        for w3c_idx, btn in W3C_MAP.items():
            mask = JS_BITMASK.get(w3c_idx)
            if mask:
                is_pressed = (btns_mask & mask) != 0
                gp.emit(btn, 1 if is_pressed else 0, syn=False)
            
        gp.emit(uinput.ABS_X, lx, syn=False)
        gp.emit(uinput.ABS_Y, ly, syn=False)
        gp.emit(uinput.ABS_RX, rx, syn=False)
        gp.emit(uinput.ABS_RY, ry, syn=False)
        gp.emit(uinput.ABS_Z, int(lt * 255), syn=False)
        gp.emit(uinput.ABS_RZ, int(rt * 255), syn=False)
        
        # D-pad (bits 4-7 mapped from W3C 12-15)
        # 0x0040 (D-Left), 0x0080 (D-Right), 0x0010 (D-Up), 0x0020 (D-Down)
        hx = -1 if (btns_mask & 0x0040) else 1 if (btns_mask & 0x0080) else 0
        hy = -1 if (btns_mask & 0x0010) else 1 if (btns_mask & 0x0020) else 0
        gp.emit(uinput.ABS_HAT0X, hx, syn=False)
        gp.emit(uinput.ABS_HAT0Y, hy, syn=False)
        
    else:
        # Legacy array schema fallback
        btns = msg.get("buttons", [])
        axes = msg.get("axes", [])
        for w3c, btn in W3C_MAP.items():
            if len(btns) > w3c:
                gp.emit(btn, 1 if btns[w3c]["pressed"] else 0, syn=False)
        if len(axes) >= 2:
            gp.emit(uinput.ABS_X, int(axes[0]), syn=False)
            gp.emit(uinput.ABS_Y, int(axes[1]), syn=False)
        if len(axes) >= 4:
            gp.emit(uinput.ABS_RX, int(axes[2]), syn=False)
            gp.emit(uinput.ABS_RY, int(axes[3]), syn=False)
        if len(btns) > 6:
            gp.emit(uinput.ABS_Z, int(btns[6].get("value", 0) * 255), syn=False)
        if len(btns) > 7:
            gp.emit(uinput.ABS_RZ, int(btns[7].get("value", 0) * 255), syn=False)
        if len(btns) > 15:
            hx = -1 if btns[14]["pressed"] else 1 if btns[15]["pressed"] else 0
            hy = -1 if btns[12]["pressed"] else 1 if btns[13]["pressed"] else 0
            gp.emit(uinput.ABS_HAT0X, hx, syn=False)
            gp.emit(uinput.ABS_HAT0Y, hy, syn=False)
            
    gp.syn()

def _ensure_gp(pad_id, vid):
    if not UINPUT_OK: return
    wanted = viewer_ctrl_type.get(pad_id) or viewer_ctrl_type.get(vid) or viewer_ctrl_type.get("") or 'xbox360'
    if device_profiles.get(pad_id) != wanted:
        old = devices.pop(pad_id, None)
        if old:
            try: old.destroy()
            except Exception: pass
        gp = make_gamepad(wanted)
        devices[pad_id]         = gp
        device_profiles[pad_id] = wanted
        _, _, _, label = PROFILES.get(wanted, ('','','','unknown'))
        print(f"[input] Created {label}: {pad_id[:12]}", flush=True)

# ── UNIFIED KBM emulation handler ─────────────────────────────────────────────
def _emit_kbm_event(pad_id: str, vid: str, key: str, is_down: bool, binds: dict):
    if not UINPUT_OK or not binds:
        return

    _ensure_gp(pad_id, vid)
    gp = devices.get(pad_id)
    if not gp:
        return

    dn = 1 if is_down else 0
    is_flat = isinstance(next(iter(binds.values()), None), str)

    if is_flat:
        target = binds.get(key)
        if not target:
            return

        alias_map = {
            "BTN_SOUTH": "BTN_A",
            "BTN_EAST": "BTN_B",
            "BTN_NORTH": "BTN_X",
            "BTN_WEST": "BTN_Y"
        }
        target = alias_map.get(target, target)

        if target.startswith("BTN_") and hasattr(uinput, target):
            btn_const = getattr(uinput, target)
            held_key  = (id(gp), btn_const)
            already_down = _btn_held.get(held_key, False)

            # FIX: Completely ignore OS key-repeats. If it's already held down,
            # do not force a release. Just let the game read the continuous hold.
            if is_down and already_down:
                return

            _btn_held[held_key] = is_down
            gp.emit(btn_const, dn)

        elif target.startswith("ABS_"):
            # Stop axes from spamming the kernel during key-repeats
            held_key = (id(gp), target)
            already_down = _btn_held.get(held_key, False)
            if is_down and already_down:
                return
            _btn_held[held_key] = is_down

            if target == "ABS_Y_UP":
                gp.emit(uinput.ABS_Y, -32767 if is_down else 0)
            elif target == "ABS_Y_DOWN":
                gp.emit(uinput.ABS_Y,  32767 if is_down else 0)
            elif target == "ABS_X_LEFT":
                gp.emit(uinput.ABS_X, -32767 if is_down else 0)
            elif target == "ABS_X_RIGHT":
                gp.emit(uinput.ABS_X,  32767 if is_down else 0)
            elif target == "ABS_HAT0Y_UP":
                gp.emit(uinput.ABS_HAT0Y, -1 if is_down else 0)
            elif target == "ABS_HAT0Y_DOWN":
                gp.emit(uinput.ABS_HAT0Y,  1 if is_down else 0)
            elif target == "ABS_HAT0X_LEFT":
                gp.emit(uinput.ABS_HAT0X, -1 if is_down else 0)
            elif target == "ABS_HAT0X_RIGHT":
                gp.emit(uinput.ABS_HAT0X,  1 if is_down else 0)

    else:
        # Nested JSON Block (Your provided format)
        btn_target = binds.get("buttons", {}).get(key)
        if btn_target and hasattr(uinput, btn_target):
            btn_const = getattr(uinput, btn_target)
            held_key  = (id(gp), btn_const)
            already_down = _btn_held.get(held_key, False)

            # FIX: Ignore OS key-repeats for buttons
            if is_down and already_down:
                return

            _btn_held[held_key] = is_down
            gp.emit(btn_const, dn)

        for section in ["left_stick", "dpad"]:
            m = binds.get(section, {}).get(key)
            if m:
                ax  = m.get("axis")
                val = m.get("val", 0)
                if ax and hasattr(uinput, ax):
                    held_key = (id(gp), ax, key)
                    already_down = _btn_held.get(held_key, False)

                    # FIX: Ignore OS key-repeats for analog sticks/D-Pads
                    if is_down and already_down:
                        continue

                    _btn_held[held_key] = is_down
                    gp.emit(getattr(uinput, ax), val if is_down else 0)

    gp.syn()

_last_mouse_move = {}   
_btn_held        = {}   

def _maybe_reset_right_stick(pad_id, vid):
    if not UINPUT_OK: return
    t = _last_mouse_move.get(pad_id, 0)
    if t and (time.monotonic() - t) >= 0.032:
        gp = devices.get(pad_id)
        if gp:
            gp.emit(uinput.ABS_RX, 0, syn=False)
            gp.emit(uinput.ABS_RY, 0, syn=True)
        _last_mouse_move[pad_id] = 0

# ── Main loop ──────────────────────────────────────────────────────────────────
def run():
    global _active_binds, _auto_map_on, _is_hybrid
    print("[input] Loaded linux_uinput backend (stable, completely unified)", flush=True)

    # Use unbuffered binary stdin so every line Node writes is dispatched immediately
    # without waiting for the OS 8KB read buffer to fill. This is the main source
    # of variable controller latency on the Python side.
    stdin_raw = open(sys.stdin.fileno(), 'rb', buffering=0)

    for raw_line in stdin_raw:
        line = raw_line.decode('utf-8', errors='replace').strip()
        if not line:
            continue
        
        for _rspad in list(_last_mouse_move):
            if _last_mouse_move[_rspad]:
                _maybe_reset_right_stick(_rspad, _rspad.split('_')[0])

        try:
            msg      = json.loads(line)
            msg_type = msg.get("type")

            if msg_type == "window-focus":
                if not _auto_map_on:
                    continue
                title  = msg.get("title", "")
                binds  = resolve_csv(title)
                if binds:
                    _active_binds = binds
                    for vid in list(viewer_modes.keys()):
                        # FIX: Removed the line that forced xbox360.
                        # This respects your PS4/Switch choice.
                        viewer_modes[vid] = 'kbm_emulated'
                    print(f"[input] CSV match '{title}' → kbm_emulated ({len(binds)} binds)", flush=True)
                else:
                    _active_binds = None
                    print(f"[input] No CSV match for '{title}' — using JSON fallback if kbm_emulated", flush=True)
                continue

            if msg_type == "reload-csv":
                _load_csv()
                continue

            if msg_type == "ctrl-settings-hybrid":
                _is_hybrid = bool(msg.get("enabled", False))
                _auto_map_on = not _is_hybrid
                for vid in list(viewer_modes.keys()):
                    if viewer_modes[vid] not in ['kbm_emulated', 'kbm']:
                        viewer_modes[vid] = 'hybrid' if _is_hybrid else 'gamepad'
                _active_binds = None
                print(f"[input] Hybrid mode {'ON' if _is_hybrid else 'OFF'} (Auto-map {'ON' if _auto_map_on else 'OFF'})", flush=True)
                continue

            if msg_type == "set-ctrl-type":
                vid_tag = str(msg.get("viewerId") or msg.get("viewer_id", ""))
                raw_ctrl = str(msg.get("ctrlType") or msg.get("ctrl_type", "xbox360"))
                ctrl = raw_ctrl.lower()

                viewer_ctrl_type[vid_tag] = ctrl
                print(f"[input] Viewer {vid_tag} set to {ctrl}", flush=True)
                continue

            if msg_type == "set-input-mode":
                vid = str(msg.get("viewerId", "")).split('_')[0]
                viewer_modes[vid] = msg.get("mode", "gamepad")
                continue

            if msg_type in ["flush_neutral", "disconnect_viewer"]:
                vid  = str(msg.get("viewer_id", ""))
                keys = [k for k in list(devices) if k.startswith(vid + "_") or k == vid]
                for k in keys:
                    dev = devices.pop(k, None)
                    if dev:
                        try: dev.destroy()
                        except Exception: pass
                    _input_queues.pop(k, None)
                viewer_modes.pop(vid, None)
                viewer_ctrl_type.pop(vid, None)
                gc.collect()
                continue

            if msg_type == "destroy_all":
                _cleanup()
                continue

            # ====================================================================
            # THE RE-ORDERED INPUT PIPELINE STARTS HERE
            # ====================================================================

            pad_raw = str(msg.get("pad_id", ""))
            vid = str(msg.get("viewer_id") or msg.get("viewerId", ""))

            # FIX: If mobile touch controls stripped the ID to save bandwidth,
            # extract it directly from the pad_id (turns "v1_99" back into "v1")
            if not vid and pad_raw:
                vid = pad_raw.split("_")[0]

            if msg_type in ["kbm", "keyboard"]:
                active_pads = [p for p in devices.keys() if p.startswith(vid + "_")]
                pad_id = active_pads[0] if active_pads else f"{vid}_0"
            else:
                pad_id = pad_raw if pad_raw else f"{vid}_0"

            mode = viewer_modes.get(vid, "hybrid" if _is_hybrid else "gamepad")

            if msg_type in ["kbm", "keyboard"] and kbm_device and mode in ["kbm", "hybrid", "kbm_emulated"]:
                ev = msg.get("event")
                if ev == "mousemove":
                    dx, dy = msg.get("dx", 0), msg.get("dy", 0)
                    if dx: kbm_device.emit(uinput.REL_X, dx, syn=False)
                    if dy: kbm_device.emit(uinput.REL_Y, dy, syn=False)
                    kbm_device.syn()
                elif ev in ["keydown", "keyup"]:
                    k = msg.get("key", "")
                    v = 1 if ev == "keydown" else 0
                    if hasattr(uinput, k):
                        kbm_device.emit(getattr(uinput, k), v)
                elif ev in ["mousedown", "mouseup"]:
                    b = msg.get("button", 0)
                    v = 1 if ev == "mousedown" else 0
                    u = uinput.BTN_LEFT if b == 0 else uinput.BTN_MIDDLE if b == 1 else uinput.BTN_RIGHT
                    kbm_device.emit(u, v)
                continue

            if msg_type == "gamepad" and mode in ["gamepad", "hybrid", "kbm_emulated"]:
                _ensure_gp(pad_id, vid)
                _enqueue(pad_id, msg)
                _drain(pad_id)

            elif msg_type in ["kbm", "keyboard"] and mode in ["kbm_emulated", "hybrid"]:
                ev = msg.get("event")

                if ev in ["keydown", "keyup", "mousedown", "mouseup"]:
                    binds = _active_binds if _active_binds else load_json_fallback()
                    if binds:
                        is_down = ev in ["keydown", "mousedown"]

                        if ev in ["keydown", "keyup"]:
                            target_key = msg.get("key", "")
                        else:
                            btn_idx = msg.get("button", 0)
                            if btn_idx == 0: target_key = "BTN_LEFT"
                            elif btn_idx == 1: target_key = "BTN_MIDDLE"
                            elif btn_idx == 2: target_key = "BTN_RIGHT"
                            else: target_key = ""

                        _emit_kbm_event(pad_id, vid, target_key, is_down, binds)

                elif ev == "mousemove":
                    binds = _active_binds if _active_binds else load_json_fallback()

                    if binds and binds.get("right_stick_mouse", False):
                        mult = binds.get("right_stick_multiplier", 1500)
                        dx, dy = msg.get("dx", 0), msg.get("dy", 0)

                        _ensure_gp(pad_id, vid)
                        gp = devices.get(pad_id)
                        if gp and (dx or dy):
                            rx = max(-32767, min(32767, int(dx * mult)))
                            ry = max(-32767, min(32767, int(dy * mult)))

                            gp.emit(uinput.ABS_RX, rx, syn=False)
                            gp.emit(uinput.ABS_RY, ry, syn=True)
                            _last_mouse_move[pad_id] = time.monotonic()

        except json.JSONDecodeError:
            pass
        except Exception as e:
            print(f"[input] Error: {e}", flush=True)

if __name__ == "__main__":
    run()
