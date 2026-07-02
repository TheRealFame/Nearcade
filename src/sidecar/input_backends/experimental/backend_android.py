# ==============================================================================
# backend_android.py — Android Host (Rooted) Backend
# ==============================================================================
# SUBJECT TO CHANGE: This code is a forward-looking implementation concept
# based on the DEVICE_SPECS.md and ARCHITECTURE_CONCEPT.md documents. The API
# surface, packet format, and OS injection method may change significantly before
# this backend is activated. Do NOT enable without reviewing against the active
# InputOrchestrator.js implementation.
#
# OPEN TO PULL REQUESTS: If you wish to implement and test this backend
# for your specific hardware, feel free to open a PR!
# ==============================================================================
#
# !! COMPLEXITY: IMPOSSIBLE OVER WEB — READ CAREFULLY !!
#
# As documented in DEVICE_SPECS.md §8, the Host side of a Nearsec session
# CANNOT be a mobile browser. The viewer side is always a web browser, but
# the Host must be a native, rooted Android APK running a background service.
#
# This script is therefore NOT a standard stdin-pipe sidecar like the other
# backends. It is a REFERENCE IMPLEMENTATION / PROTOTYPE for what a rooted
# Android host service would need to do — specifically, injecting input events
# into /dev/uinput on Android using the 'su' shell.
#
# Practical path to Android Host support:
#   1. A Kivy / BeeWare / native Java APK wraps this Python logic.
#   2. The APK binds a background Service that opens a WebSocket to the
#      Nearsec signaling server as the host role.
#   3. Incoming gamepad payloads from viewers are forwarded via ADB shell
#      or sendevent calls to /dev/input/event* on the Android device.
#   4. Root access (via 'su') is required to write to /dev/uinput.
#
# This file is intentionally left as a documentation stub with skeleton code
# only. Attempting to run it outside of a rooted Android ADB shell environment
# will fail immediately.
#
# ADB sendevent protocol reference:
#   sendevent <device> <type> <code> <value>
#   type 3 = EV_ABS, type 1 = EV_KEY, type 0 = EV_SYN (SYN_REPORT)
#
# Packet format (JSON over stdin, one per line):
#   Same standard gamepad packet format as the other backends:
#   {
#     "type":    "gamepad",
#     "buttons": int,
#     "axes":    [float, float, float, float],
#     "lt":      float,
#     "rt":      float,
#   }
# ==============================================================================

import sys
import json
import subprocess
import shutil

# The Android input event device node — must be discovered at runtime on the device.
# Typical paths: /dev/input/event3 or /dev/input/event4 (varies by ROM / kernel).
# A helper function below attempts to discover the correct node via 'getevent -l'.
ANDROID_EVENT_DEV = "/dev/input/event3"   # Placeholder — override via config packet


def _sendevent(dev, ev_type, code, value):
    """Write a single input event via 'su -c sendevent' on rooted Android."""
    cmd = f"su -c 'sendevent {dev} {ev_type} {code} {value}'"
    subprocess.run(cmd, shell=True, capture_output=True)


def _syn(dev):
    """Send EV_SYN / SYN_REPORT to flush the event batch."""
    _sendevent(dev, 0, 0, 0)


def _discover_event_device():
    """
    Attempt to locate the virtual gamepad event node by querying 'getevent -l'.
    Returns the first device path containing 'Virtual' or 'Gamepad', or falls
    back to ANDROID_EVENT_DEV.
    """
    try:
        result = subprocess.run(["su", "-c", "getevent -l"], capture_output=True, text=True, timeout=3)
        for line in result.stdout.splitlines():
            if "Virtual" in line or "Gamepad" in line or "uinput" in line.lower():
                parts = line.split()
                if parts:
                    return parts[0].rstrip(":")
    except Exception:
        pass
    return ANDROID_EVENT_DEV


def start_android_backend():
    print("[backend_android] Android Host Backend (Rooted) — Reference Stub", flush=True)

    # Safety check — this is meaningless outside Android / ADB
    if not shutil.which("su") and not sys.platform.startswith("linux"):
        print(
            "[backend_android] Fatal: 'su' not found. This backend requires a "
            "rooted Android device with ADB shell access.",
            file=sys.stderr,
        )
        for _ in sys.stdin:
            pass
        sys.exit(1)

    event_dev = _discover_event_device()
    print(f"[backend_android] Using input event device: {event_dev}", flush=True)

    for line in sys.stdin:
        try:
            data = json.loads(line)

            if data.get("type") == "android-config":
                event_dev = data.get("eventDev", event_dev)
                print(f"[backend_android] Event device updated to: {event_dev}", flush=True)
                continue

            if data.get("type") != "gamepad":
                continue

            # --- Axis injection (EV_ABS = 3) ---
            # ABS_X=0, ABS_Y=1, ABS_RX=3, ABS_RY=4, ABS_Z=2, ABS_RZ=5
            raw_axes = data.get("axes", [0, 0, 0, 0])
            ABS_CODES = [0, 1, 3, 4]
            for i, code in enumerate(ABS_CODES):
                v = float(raw_axes[i]) if i < len(raw_axes) else 0.0
                mapped = int((v + 1.0) / 2.0 * 32767)
                _sendevent(event_dev, 3, code, max(0, min(32767, mapped)))

            # Triggers
            lt = int(float(data.get("lt", 0)) * 255)
            rt = int(float(data.get("rt", 0)) * 255)
            _sendevent(event_dev, 3, 2, max(0, min(255, lt)))   # ABS_Z
            _sendevent(event_dev, 3, 5, max(0, min(255, rt)))   # ABS_RZ

            # --- Button injection (EV_KEY = 1) ---
            # BTN_SOUTH=304, BTN_EAST=305, BTN_WEST=307, BTN_NORTH=308
            BTN_CODES = [304, 305, 307, 308, 310, 311, 314, 315, 316, 317, 318]
            buttons = int(data.get("buttons", 0))
            for i, code in enumerate(BTN_CODES):
                _sendevent(event_dev, 1, code, 1 if (buttons & (1 << i)) else 0)

            _syn(event_dev)

        except (json.JSONDecodeError, KeyError, ValueError):
            continue


if __name__ == "__main__":
    start_android_backend()
