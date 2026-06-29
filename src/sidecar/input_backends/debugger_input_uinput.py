import subprocess
import json
import time

print(" Starting Nearsec Input Diagnostics...")

# Spawn your driver exactly how Node.js does it
driver = subprocess.Popen(
    ['python3', 'linux_uinput.py'],
    stdin=subprocess.PIPE,
    text=True,
    bufsize=1
)

def send_msg(msg_dict):
    """Encodes a dictionary to JSON and pipes it to the driver."""
    print(f" > Sending: {msg_dict.get('type')} / {msg_dict.get('event', '')}")
    driver.stdin.write(json.dumps(msg_dict) + '\n')
    driver.stdin.flush()
    time.sleep(1.5) # Pause so you have time to see it on the tester website

# Give the driver a second to load uinput devices
time.sleep(1)

try:
    print("\n--- PHASE 1: STANDARD GAMEPAD MODE ---")
    send_msg({"type": "set-input-mode", "viewerId": "test_1", "mode": "gamepad"})
    
    print("\n[Action] Pressing 'A' button...")
    # The script expects an array of button objects. Index 0 is BTN_A.
    btns_down = [{"pressed": False, "value": 0}] * 16
    btns_down[0] = {"pressed": True, "value": 255}
    send_msg({"type": "gamepad", "pad_id": "test_1", "viewer_id": "test_1", "buttons": btns_down, "axes": [0,0,0,0,0,0]})

    print("\n[Action] Releasing 'A' button...")
    btns_up = [{"pressed": False, "value": 0}] * 16
    send_msg({"type": "gamepad", "pad_id": "test_1", "viewer_id": "test_1", "buttons": btns_up, "axes": [0,0,0,0,0,0]})


    print("\n--- PHASE 2: HYBRID MODE (MOUSE AIMING) ---")
    # Enable Hybrid mode to unlock mouse-to-joystick
    send_msg({"type": "ctrl-settings-hybrid", "enabled": True})

    print("\n[Action] Flicking Mouse Right (Should spike Right Stick X-Axis)...")
    send_msg({"type": "kbm", "event": "mousemove", "dx": 20, "dy": 0, "pad_id": "test_1", "viewer_id": "test_1"})

    print("\n[Action] Flicking Mouse Down (Should spike Right Stick Y-Axis)...")
    send_msg({"type": "kbm", "event": "mousemove", "dx": 0, "dy": 20, "pad_id": "test_1", "viewer_id": "test_1"})


    print("\n--- PHASE 3: HYBRID MODE (MOUSE CLICKS) ---")
    print("\n[Action] Clicking Left Mouse Button (Should fire mapped trigger)...")
    send_msg({"type": "kbm", "event": "mousedown", "button": 0, "pad_id": "test_1", "viewer_id": "test_1"})
    
    print("\n[Action] Releasing Left Mouse Button...")
    send_msg({"type": "kbm", "event": "mouseup", "button": 0, "pad_id": "test_1", "viewer_id": "test_1"})


    print("\n Diagnostics Complete. Cleaning up...")
    send_msg({"type": "destroy_all"})

except KeyboardInterrupt:
    print("\nTest aborted.")
    send_msg({"type": "destroy_all"})
finally:
    driver.terminate()
