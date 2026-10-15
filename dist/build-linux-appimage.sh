#!/usr/bin/env bash
set -e

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "================================================="
echo " Nearcade Linux AppImage One-Click Build Script "
echo "================================================="

cd "$REPO_ROOT"

echo "Building Nearcade Linux AppImage via electron-builder..."
npx electron-builder --linux AppImage --publish never

echo ""
echo "================================================="
echo "✓ Linux AppImage build completed!"
echo "  Outputs located in $REPO_ROOT/dist:"
find "$REPO_ROOT/dist" -maxdepth 1 -name "*.AppImage" -exec ls -lh {} + 2>/dev/null || true
echo "================================================="
