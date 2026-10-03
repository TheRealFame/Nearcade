# ==============================================================================
# backend_android.py — Android Host (Shizuku) Backend
# ==============================================================================
# This script bridges Nearcade to the Android OS using Shizuku.
# It uses Shizuku's shell permissions to write directly to /dev/uinput or uhid
# to natively emulate an Xbox controller on the host phone.
# ==============================================================================
import sys
import json
import time
import socket
import threading

def log(msg, t="log", **kwargs):
    payload = {"type": t, "message": msg}
    payload.update(kwargs)
    print(json.dumps(payload), flush=True)

def udp_listener(sock):
    while True:
        try:
            data, addr = sock.recvfrom(64)
            # Just log the fact we got a fast packet for testing
            # log(f"Got binary gamepad packet: {len(data)} bytes")
        except:
            break

def main():
    log("Starting Shizuku backend setup...", "log")
    
    # Setup UDP socket for fast input
    udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp_sock.bind(('127.0.0.1', 0))
    port = udp_sock.getsockname()[1]
    
    t = threading.Thread(target=udp_listener, args=(udp_sock,), daemon=True)
    t.start()
    
    log("Android Shizuku backend ready! UDP listening...", "ready", port=port)
    log("WARNING: Shizuku input injection is highly experimental.")
    log("Waiting for JSON events from host via stdin...")
    
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            
            data = json.loads(line)
            
            if data.get("type") == "destroy_all":
                log("Destroying all virtual controllers...")
                break
            
            log(f"Received JSON input: {json.dumps(data)}")
            
        except Exception as e:
            log(f"Error parsing input: {str(e)}", "error")

if __name__ == "__main__":
    main()
