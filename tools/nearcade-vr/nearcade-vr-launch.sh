#!/bin/sh
# Nearcade Steam VR launcher (regenerated at boot on port 3000)
# Paste this path in Steam launch options:
#   /home/fame/Documents/Nearcade/bin/nearcade-vr-launch.sh %command%
NEARCADE_API="${NEARCADE_API:-http://127.0.0.1:3000}"
NEARCADE_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
VR_LIB="$NEARCADE_ROOT/bin/lib/wivrn/libopenxr_wivrn.so"
curl -s --max-time 3 "${NEARCADE_API}/api/vr-wake" >/dev/null 2>&1
export PRESSURE_VESSEL_IMPORT_OPENXR_1_RUNTIMES=1
if [ -n "$STEAM_COMPAT_MOUNTS" ]; then
  export STEAM_COMPAT_MOUNTS="$STEAM_COMPAT_MOUNTS:/run/user/$(id -u)/wivrn"
else
  export STEAM_COMPAT_MOUNTS="/run/user/$(id -u)/wivrn"
fi
export LIBVA_DRIVER_NAME=dummy
export XR_RUNTIME_JSON="${XR_RUNTIME_JSON:-$HOME/.local/share/openxr/1/active_runtime.json}"
if [ ! -f "$XR_RUNTIME_JSON" ]; then
  printf '{\n    "file_format_version": "1.0.0",\n    "runtime": {\n        "library_path": "%s",\n        "name": "WiVRn"\n    },\n    "enable": true\n}\n' "$VR_LIB" > "$XR_RUNTIME_JSON"
fi
exec "$@"
