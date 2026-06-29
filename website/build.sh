#!/bin/bash
set -e

echo "Building Nearsec Arcade..."

# 1. Create directory structure
mkdir -p website/js website/assets website/arcade
mkdir -p website/pages website/arcade/pages

# 2. Copy source files
cp website/nearsec-home.html website/index.html
cp website/nearsec-arcade.html website/arcade/index.html
cp website/arcade.js website/arcade/arcade.js

cp src/pages/gamepad-popup.html website/pages/gamepad-popup.html
cp src/pages/gamepad-popup.html website/arcade/pages/gamepad-popup.html

cp src/scripts/i18n.js website/js/i18n.js

cp -r assets/* website/assets/
cp assets/NearsecTogetherLogo.png website/NearsecTogetherLogo.png
cp assets/NearsecTogetherTitle.png website/NearsecTogetherTitle.png

# 3. Duplicate assets for arcade sub-route
cp -r website/js website/arcade/js
cp -r website/assets website/arcade/assets

# 4. Extract worker
mv website/_worker.js ./_worker.js 2>/dev/null || true

echo "Build complete. Ready for deployment."
