import sys
import json
import subprocess
import atexit

loaded_modules = []
current_sinks = {} # sink_id -> {'mod_sink': '1', 'mod_loop': '2', 'desc': 'Name'}

def run_pactl(args):
    try:
        result = subprocess.run(['pactl'] + args, capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"[backend_virtualmic] pactl error: {e.stderr.strip()}", file=sys.stderr)
        return None
    except FileNotFoundError:
        print("[backend_virtualmic] pactl command not found. Are you on Linux with PulseAudio/PipeWire?", file=sys.stderr)
        sys.exit(1)

def cleanup():
    print("[backend_virtualmic] Shutting down, cleaning up all virtual microphones...", flush=True)
    for info in current_sinks.values():
        if info.get('mod_loop'): subprocess.run(['pactl', 'unload-module', str(info['mod_loop'])], capture_output=True)
        if info.get('mod_sink'): subprocess.run(['pactl', 'unload-module', str(info['mod_sink'])], capture_output=True)
    print("[backend_virtualmic] Cleanup complete.", flush=True)

atexit.register(cleanup)

def cleanup_orphans():
    out = run_pactl(['list', 'short', 'modules'])
    if not out: return
    for line in out.splitlines():
        if 'NearcadeMic_' in line:
            parts = line.split()
            if len(parts) > 0 and parts[0].isdigit():
                run_pactl(['unload-module', parts[0]])
                print(f"[backend_virtualmic] Unloaded orphaned module {parts[0]}", flush=True)

def sync_sinks(requested_sinks):
    hw_sink = run_pactl(['get-default-sink'])
    
    # 1. Remove sinks that are no longer requested or need renaming
    req_dict = {s['id']: s.get('desc', f"NearcadeMic_{s['id']}") for s in requested_sinks}
    to_remove = []
    for sid, info in current_sinks.items():
        if sid not in req_dict or info['desc'] != req_dict[sid]:
            to_remove.append(sid)
            
    for sid in to_remove:
        info = current_sinks[sid]
        if info.get('mod_loop'): run_pactl(['unload-module', str(info['mod_loop'])])
        if info.get('mod_sink'): run_pactl(['unload-module', str(info['mod_sink'])])
        del current_sinks[sid]
        print(f"[backend_virtualmic] Removed virtual mic {sid}", flush=True)

    # 2. Add new sinks
    for s in requested_sinks:
        sid = s['id']
        desc = s.get('desc', f'NearcadeMic_{sid}')
        
        if sid not in current_sinks:
            safe_name = "".join(c for c in sid if c.isalnum())
            sink_name = f'NearcadeMic_{safe_name}'
            out1 = run_pactl(['load-module', 'module-null-sink', f'sink_name={sink_name}', f'sink_properties=device.description="{desc}"'])
            
            out2 = None
            if hw_sink and 'NearcadeMic' not in hw_sink:
                out2 = run_pactl(['load-module', 'module-loopback', f'source={sink_name}.monitor', f'sink={hw_sink}', 'latency_msec=30'])
                
            if out1 and out1.isdigit():
                current_sinks[sid] = {'mod_sink': out1, 'mod_loop': out2, 'desc': desc}
                print(f"[backend_virtualmic] Created virtual mic '{desc}' (ID: {out1})", flush=True)
                # Auto-set the first one as default if it's shared
                if sid == 'shared':
                    run_pactl(['set-default-source', f'{sink_name}.monitor'])

def start_virtual_mic():
    if not sys.platform.startswith("linux"):
        print("[backend_virtualmic] Error: Virtual Microphone is only supported on Linux via PulseAudio/PipeWire.", file=sys.stderr)
        sys.exit(1)

    print("[backend_virtualmic] Virtual Microphone orchestrator started.", flush=True)
    cleanup_orphans()
    
    # Default to a shared mic on boot to maintain backward compatibility with old behavior
    sync_sinks([{"id": "shared", "desc": "NearcadeMic_Shared"}])

    try:
        for line in sys.stdin:
            try:
                msg = json.loads(line)
                if msg.get('type') == 'virtualmic' and msg.get('action') == 'sync_sinks':
                    sinks = msg.get('sinks', [])
                    sync_sinks(sinks)
            except json.JSONDecodeError:
                pass
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    start_virtual_mic()
