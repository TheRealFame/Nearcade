#!/bin/bash
# Nearcade Sidecar Compiler
# Builds input sidecars using Rust (primary) with Nuitka as a fallback.
# Run once per platform before building a release.
#
# Rust sidecars are the preferred path (faster startup, no Python dependency).
# Nuitka is only used if a Rust binary is unavailable for a given target.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKENDS_DIR="$SCRIPT_DIR/../src/sidecar/input_backends"
BIN_DIR="$BACKENDS_DIR/bin"

echo "[compile_sidecars] Nearcade Sidecar Compiler (Rust-first)"
mkdir -p "$BIN_DIR"

OS="$(uname -s)"
echo "[compile_sidecars] Platform: $OS"

# ── Rust build helper ─────────────────────────────────────────────────────────

build_rust() {
    local crate_dir="$1"
    local binary_name="$2"
    local dest_name="$3"

    echo "[compile_sidecars] Building Rust: $binary_name"
    if ! command -v cargo &>/dev/null; then
        echo "[compile_sidecars] WARNING: cargo not found — skipping $binary_name"
        return 1
    fi

    (cd "$crate_dir" && cargo build --release 2>&1)
    local ext=""
    [[ "$OS" == MINGW* || "$OS" == CYGWIN* || "$OS" == MSYS* ]] && ext=".exe"
    local src="$crate_dir/target/release/${binary_name}${ext}"
    if [ -f "$src" ]; then
        cp "$src" "$BIN_DIR/$dest_name"
        echo "[compile_sidecars]   ✓ $dest_name"
        return 0
    else
        echo "[compile_sidecars]   ✗ Binary not found at $src"
        return 1
    fi
}

# ── Nuitka fallback helper ────────────────────────────────────────────────────

build_nuitka() {
    local script="$1"
    echo "[compile_sidecars] Nuitka fallback: $script"
    if ! python3 -m nuitka --version &>/dev/null 2>&1 && ! python -m nuitka --version &>/dev/null 2>&1; then
        echo "[compile_sidecars] WARNING: Nuitka not installed. Run: pip install nuitka"
        return 1
    fi
    local py_cmd="python3"
    command -v python3 &>/dev/null || py_cmd="python"
    (cd "$BACKENDS_DIR" && $py_cmd -m nuitka --assume-yes-for-downloads --onefile --output-dir=bin "$script")
    echo "[compile_sidecars]   ✓ $script (Nuitka)"
}

# ── Platform-specific builds ──────────────────────────────────────────────────

case "$OS" in
    Linux*)
        echo ""
        echo "[compile_sidecars] === Linux Sidecars ==="
        build_rust "$BACKENDS_DIR/rust_uinput"       "linux_uinput"  "linux_uinput.bin"   \
            || build_nuitka "linux_uinput.py"

        build_rust "$BACKENDS_DIR/rust_read_gamepads" "read_gamepads" "read_gamepads.bin"  \
            || build_nuitka "read_gamepads.py"
        ;;

    Darwin*)
        echo ""
        echo "[compile_sidecars] === macOS Sidecars ==="
        build_rust "$BACKENDS_DIR/rust_mac_bridge"    "mac_gamepad_bridge" "mac_gamepad_bridge.bin" \
            || build_nuitka "mac_gamepad_bridge.py"

        build_rust "$BACKENDS_DIR/rust_read_gamepads" "read_gamepads" "read_gamepads_macos.bin" \
            || build_nuitka "read_gamepads.py"
        ;;

    MINGW*|CYGWIN*|MSYS*)
        echo ""
        echo "[compile_sidecars] === Windows Sidecars ==="
        build_rust "$BACKENDS_DIR/rust_vigem"       "windows_vigem"       "windows_vigem.exe"

        build_rust "$BACKENDS_DIR/rust_hidmaestro"  "windows_hidmaestro"  "windows_hidmaestro.exe" \
            || build_nuitka "windows_hidmaestro.py"

        build_rust "$BACKENDS_DIR/rust_read_gamepads" "read_gamepads" "read_gamepads.exe" \
            || build_nuitka "read_gamepads.py"
        ;;

    *)
        echo "[compile_sidecars] ERROR: Unknown OS '$OS'"
        exit 1
        ;;
esac

echo ""
echo "[compile_sidecars] Done. Binaries:"
ls -lh "$BIN_DIR/"
