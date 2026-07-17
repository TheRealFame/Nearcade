#!/usr/bin/env bash
set -euo pipefail

LATEST=$(curl -sL https://api.github.com/repos/TheRealFame/Nearcade/releases/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")
VERSION=${LATEST#v}

echo "=== Nearcade v$VERSION release hashes ==="

for asset in \
  "Nearcade-Setup-${VERSION}.exe" \
  "Nearcade-${VERSION}-universal.dmg" \
  "Nearcade-${VERSION}.AppImage" \
  "Nearcade-${VERSION}.pacman"; do
  url="https://github.com/TheRealFame/Nearcade/releases/download/${LATEST}/${asset}"
  hash=$(curl -sL "$url" | sha256sum | cut -d' ' -f1)
  echo "$asset: $hash"
done
