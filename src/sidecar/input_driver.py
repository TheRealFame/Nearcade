"""
NearsecTogether Input Driver Dispatcher

Thin dispatcher: detects the OS at startup and loads the appropriate backend
module for virtual controller injection.

- Linux:   Uses uinput (stable, primary target)
- Windows: EXPERIMENTAL - Uses ViGEmBus + vgamepad
- macOS:   EXPERIMENTAL - KBM only via pyautogui (no gamepad)

All fatal errors are emitted as JSON to stdout so Node.js can parse them:
  {"type": "error", "message": "...", "code": "..."}
"""

import sys
import json
import platform


def _emit(payload: dict):
    """Write a JSON line to stdout, flushed immediately."""
    print(json.dumps(payload), flush=True)


def _emit_error(message: str, code: str = "INIT_ERROR"):
    _emit({"type": "error", "message": message, "code": code})


OS = platform.system()

_emit({"type": "log", "message": f"Detected OS: {OS}"})

if OS == "Linux":
    _emit({"type": "log", "message": "Loading Linux uinput backend (stable)"})
    try:
        from input_backends.linux_uinput import run
    except ImportError as e:
        _emit_error(f"Failed to import linux_uinput: {e}", "IMPORT_ERROR")
        sys.exit(1)

elif OS == "Windows":
    _emit({"type": "log", "message": "Loading Windows ViGEmBus backend (EXPERIMENTAL)"})
    _emit({
        "type": "log",
        "message": "Requires ViGEmBus driver: https://github.com/nefarius/ViGEmBus/releases"
    })
    try:
        from input_backends.windows_vigem import run
    except ImportError as e:
        _emit_error(
            f"Failed to import windows_vigem: {e}. "
            "Install with: pip install vgamepad pyautogui",
            "IMPORT_ERROR"
        )
        sys.exit(1)

elif OS == "Darwin":
    _emit({"type": "log", "message": "Loading macOS stub backend (EXPERIMENTAL, KBM only)"})
    _emit({"type": "log", "message": "Gamepad injection is NOT supported on macOS."})
    try:
        from input_backends.mac_stub import run
    except ImportError as e:
        _emit_error(f"Failed to import mac_stub: {e}", "IMPORT_ERROR")
        sys.exit(1)

else:
    _emit_error(f"Unsupported OS: {OS}", "UNSUPPORTED_OS")
    sys.exit(1)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        _emit({"type": "log", "message": "Shutting down gracefully"})
        sys.exit(0)
    except Exception as e:
        _emit_error(f"Fatal error in backend run(): {e}", "RUNTIME_ERROR")
        sys.exit(1)
