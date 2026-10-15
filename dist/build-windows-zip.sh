#!/usr/bin/env bash
set -e

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=============================================="
echo " Nearcade Windows ZIP One-Click Build Script "
echo "=============================================="

cd "$REPO_ROOT"

echo "Building Nearcade Windows ZIP archive via electron-builder..."
npx electron-builder --win zip --publish never

echo ""
echo "=============================================="
echo "✓ Windows ZIP build completed!"
echo "  Outputs located in $REPO_ROOT/dist:"
find "$REPO_ROOT/dist" -maxdepth 1 -name "*.zip" -exec ls -lh {} + 2>/dev/null || true
echo "=============================================="
