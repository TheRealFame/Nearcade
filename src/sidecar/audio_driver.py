"""
Nearcade — Cross-platform audio capture sidecar
Global Mirror architecture: dynamically discovers the Default Sink Monitor
via `pactl get-default-sink` and bridges it into NearsecAppAudio via
module-loopback. This survives Bluetooth device reconnections because
we never hardcode a sink name like `bluez_output.*`.
"""
import subprocess
import sys
import time

CHUNK = 1024
RATE  = 48000


# ─────────────────────────────────────────────────────────────────────────────
# STARTUP PURGE — kill any stale NearsecVirtual / loopback modules
# left over from a prior crash before we create anything new.
# ─────────────────────────────────────────────────────────────────────────────

def _pactl(*args, timeout=4):
    """Run a pactl command and return (returncode, stdout, stderr)."""
    try:
        r = subprocess.run(['pactl'] + list(args),
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except Exception as exc:
        sys.stderr.write(f"[audio_driver] pactl error: {exc}\n")
        return 1, '', str(exc)


def unload_stale_modules():
    """
    Scan all loaded PulseAudio/PipeWire modules and unload anything that
    matches our virtual sink or loopback names so we never create duplicates.
    """
    rc, out, _ = _pactl('list', 'short', 'modules')
    if rc != 0 or not out:
        return

    stale = []
    for line in out.splitlines():
        # Match: NearsecVirtual*, NearsecAppAudio, NearsecAppMic, or any
        # loopback whose argument string references our sinks.
        if any(tok in line for tok in (
            'NearsecVirtual', 'NearsecAppAudio', 'NearsecAppMic',
        )):
            parts = line.split()
            if parts and parts[0].isdigit():
                stale.append(parts[0])

    if not stale:
        sys.stderr.write('[audio_driver] Startup purge: no stale modules found.\n')
        return

    sys.stderr.write(
        f'[audio_driver] Startup purge: unloading {len(stale)} stale '
        f'module(s): [{", ".join(stale)}]\n'
    )
    for mod_id in stale:
        _pactl('unload-module', mod_id)
        sys.stderr.write(f'[audio_driver] Unloaded stale module {mod_id}\n')


# ─────────────────────────────────────────────────────────────────────────────
# GLOBAL MIRROR — dynamically resolve Default Sink and create loopback
# ─────────────────────────────────────────────────────────────────────────────

def get_default_sink():
    """
    Returns the current default sink name from PulseAudio/PipeWire.
    Uses `pactl get-default-sink` so it always reflects the live state,
    even after a Bluetooth device disconnects/reconnects.
    """
    rc, out, _ = _pactl('get-default-sink')
    if rc == 0 and out and out != 'NearsecAppAudio':
        return out
    # Fallback: find the first non-Nearsec sink in the list
    rc2, sinks, _ = _pactl('list', 'short', 'sinks')
    if rc2 == 0:
        for line in sinks.splitlines():
            parts = line.split()
            if len(parts) >= 2 and 'NearsecAppAudio' not in parts[1]:
                return parts[1]
    return None


def load_global_mirror(default_sink):
    """
    Create a module-loopback that reads from `<default_sink>.monitor`
    (whatever the system is currently playing) and outputs into
    NearsecAppAudio (our virtual null-sink).

    Because we resolve the sink at runtime rather than hardcoding it,
    this survives Bluetooth reconnections and output device changes.
    """
    monitor = f'{default_sink}.monitor'
    rc, mod_id, err = _pactl(
        'load-module', 'module-loopback',
        f'source={monitor}',
        'sink=NearsecAppAudio',
        'latency_msec=20',
        'sink_input_properties=media.name=NearsecVirtualCapture',
        timeout=6,
    )
    if rc == 0 and mod_id.isdigit():
        sys.stderr.write(
            f'[audio_driver] Global Mirror: loopback {mod_id} '
            f'({monitor} → NearsecAppAudio)\n'
        )
        return mod_id
    sys.stderr.write(
        f'[audio_driver] Loopback creation failed: {err}\n'
    )
    return None


def unload_module(mod_id):
    if mod_id:
        _pactl('unload-module', mod_id)
        sys.stderr.write(f'[audio_driver] Unloaded loopback module {mod_id}\n')


# ─────────────────────────────────────────────────────────────────────────────
# PCM CAPTURE — stream raw audio frames to Node.js via stdout
# ─────────────────────────────────────────────────────────────────────────────

def run_capture_loop(loopback_id):
    import pyaudio

    p = pyaudio.PyAudio()
    device_index = None

    # Prefer the remap-source mic, then any monitor of our null-sink
    for i in range(p.get_device_count()):
        dev  = p.get_device_info_by_index(i)
        name = dev.get('name', '').lower()
        if 'nearsecappmic' in name or 'nearsecappaudio' in name or 'monitor' in name:
            if dev.get('maxInputChannels', 0) > 0:
                device_index = i
                sys.stderr.write(
                    f'[audio_driver] Capture device: {dev["name"]} (idx {i})\n'
                )
                break

    stream = None
    try:
        stream = p.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=RATE,
            input=True,
            input_device_index=device_index,
            frames_per_buffer=CHUNK,
        )
        sys.stderr.write('[audio_driver] Capture stream open — streaming to Node.js\n')
        while True:
            data = stream.read(CHUNK, exception_on_overflow=False)
            sys.stdout.buffer.write(data)
            sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        sys.stderr.write(f'[audio_driver] Capture error: {exc}\n')
    finally:
        if stream is not None:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        p.terminate()
        unload_module(loopback_id)


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def main():
    sys.stderr.write('[audio_driver] Starting (Global Mirror architecture)\n')

    # 1. Kill stale modules from any prior crash
    unload_stale_modules()

    # 2. Discover the live default sink dynamically — never hardcode
    default_sink = get_default_sink()
    if default_sink:
        sys.stderr.write(f'[audio_driver] Default sink: {default_sink}\n')
    else:
        sys.stderr.write(
            '[audio_driver] WARNING: Could not determine default sink. '
            'Will attempt direct capture from NearsecAppAudio monitor.\n'
        )

    # 3. Create the Global Mirror loopback
    loopback_id = None
    if default_sink:
        loopback_id = load_global_mirror(default_sink)
        if not loopback_id:
            sys.stderr.write(
                '[audio_driver] Mirror creation failed — '
                'falling back to direct monitor capture.\n'
            )

    # 4. Stream PCM audio to Node.js
    run_capture_loop(loopback_id)


if __name__ == '__main__':
    main()
