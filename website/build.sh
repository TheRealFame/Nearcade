#!/bin/bash
set -e

echo "Building Nearcade Arcade..."

# Worker environment variables (set these before running build.sh, or use defaults)
MIN_CLIENT_VERSION="${MIN_CLIENT_VERSION:-}"
LATEST_CLIENT_VERSION="${LATEST_CLIENT_VERSION:-}"

# 1. Create directory structure
mkdir -p website/js website/assets website/arcade
mkdir -p website/pages website/arcade/pages

# 2. Copy source files — arcade is now the primary domain
cp website/nearcade-arcade.html website/index.html
cp website/nearcade-arcade.html website/arcade/index.html
cp website/arcade.js website/arcade/arcade.js

cp src/pages/gamepad-popup.html website/pages/gamepad-popup.html
cp src/pages/gamepad-popup.html website/arcade/pages/gamepad-popup.html

cp src/scripts/i18n.js website/js/i18n.js

cp src/pages/keyboard-popup.html website/pages/keyboard-popup.html
cp src/pages/keyboard-popup.html website/arcade/pages/keyboard-popup.html
cp src/pages/display-color-tweaks.html website/pages/display-color-tweaks.html
cp src/pages/display-color-tweaks.html website/arcade/pages/display-color-tweaks.html

cp -r assets/* website/assets/
cp assets/NearcadeLogo.png website/NearcadeLogo.png
cp assets/NearcadeTitle.png website/NearcadeTitle.png

# Strip large test files from worker assets (Cloudflare 25 MiB limit)
rm -f website/assets/benchmark.mp4 website/assets/test_*.mp4

# 3. Duplicate assets for backward-compat /arcade sub-route
cp -r website/js website/arcade/js
cp -r website/assets website/arcade/assets

# 4. Inject optional env vars into worker (fallback when GitHub API is unreachable)
if [ -n "$MIN_CLIENT_VERSION" ] || [ -n "$LATEST_CLIENT_VERSION" ]; then
  # Wrap in a marker that _worker.js already reads at runtime via env.*
  echo "[build] MIN_CLIENT_VERSION=${MIN_CLIENT_VERSION:-unset} LATEST_CLIENT_VERSION=${LATEST_CLIENT_VERSION:-unset}"
fi

# 5. Copy worker to root for wrangler deploy (keep source in website/)
cp website/_worker.js ./_worker.js 2>/dev/null || true

echo "Build complete. Ready for deployment."
