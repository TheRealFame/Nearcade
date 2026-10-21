#!/usr/bin/env bash
set -euo pipefail

# Fetch latest release data from GitHub API
RELEASE_JSON=$(curl -sfL https://api.github.com/repos/TheRealFame/Nearcade/releases/latest 2>/dev/null) || {
  echo "Error: Failed to fetch latest release metadata from GitHub API" >&2
  exit 1
}

TAG=$(python3 -c "import sys, json; print(json.loads(sys.argv[1])['tag_name'])" "$RELEASE_JSON")
echo "=== Nearcade ${TAG} release hashes ==="

python3 - "$RELEASE_JSON" "$@" <<'EOF'
import sys
import json
import urllib.request
import hashlib

data = json.loads(sys.argv[1])
requested = sys.argv[2:]

assets = data.get("assets", [])
if not assets:
    print("No assets found in release.", file=sys.stderr)
    sys.exit(0)

installers = []
for asset in assets:
    name = asset["name"]
    url = asset["browser_download_url"]
    if requested:
        if name in requested or any(r in name for r in requested):
            installers.append((name, url))
    else:
        if any(name.endswith(ext) for ext in (".dmg", ".exe", ".AppImage", ".deb", ".pacman", ".rpm")):
            installers.append((name, url))

if not installers:
    print("No matching release installer assets found.", file=sys.stderr)
    sys.exit(0)

for name, url in installers:
    print(f"Hashing {name}...", file=sys.stderr)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Nearcade-Packaging"})
        hasher = hashlib.sha256()
        with urllib.request.urlopen(req) as resp:
            while chunk := resp.read(1024 * 1024):
                hasher.update(chunk)
        print(f"{name}: {hasher.hexdigest()}")
    except Exception as err:
        print(f"{name}: ERROR ({err})", file=sys.stderr)
EOF
