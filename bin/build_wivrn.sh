#!/bin/bash
# bin/build_wivrn.sh
# Build WiVRn server inside a disposable container (distrobox by default, Docker with --docker).
# Compiled binaries are placed in bin/ next to this script.
# The container and all intermediate build artefacts are deleted after a successful build.
#
# Usage:
#   bash bin/build_wivrn.sh           # distrobox mode (default)
#   bash bin/build_wivrn.sh --docker  # plain Docker mode (if distrobox storage is broken)
#   WIVRN_TAG=v0.23 bash bin/build_wivrn.sh  # pin a specific upstream tag/commit
#   WIVRN_LOG=/tmp/wivrn-build.log bash bin/build_wivrn.sh  # capture full log
set -euo pipefail

# ── Log file: tee all output to WIVRN_LOG if set ─────────────────────────────
if [[ -n "${WIVRN_LOG:-}" ]]; then
    exec > >(tee -a "$WIVRN_LOG") 2>&1
    echo "[build_wivrn] Logging to $WIVRN_LOG"
fi

# ── Argument parsing ─────────────────────────────────────────────────────────
USE_DOCKER=0
for arg in "$@"; do
    [[ "$arg" == "--docker" ]] && USE_DOCKER=1
done

# ── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$PROJECT_DIR/src/tools/wivrn-src"
OUT_DIR="$SCRIPT_DIR"
BUILDER="nearsec-wivrn-builder"

# ── Pin: use the checked-out WiVRn HEAD, or override via env ─────────────────
if [[ -d "$SRC_DIR/.git" ]]; then
    WIVRN_COMMIT="${WIVRN_TAG:-$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo "")}"
else
    WIVRN_COMMIT="${WIVRN_TAG:-}"
fi

echo "=============================================="
echo "  Nearcade — WiVRn Server Builder"
echo "  Project : $PROJECT_DIR"
echo "  Output  : $OUT_DIR/wivrn-server"
echo "  Commit  : ${WIVRN_COMMIT:-latest}"
echo "  Mode    : $([ $USE_DOCKER -eq 1 ] && echo Docker || echo distrobox)"
echo "=============================================="

mkdir -p "$OUT_DIR"

# ── Sanity check: distrobox must be healthy in non-docker mode ────────────────
if [[ $USE_DOCKER -eq 0 ]]; then
    if ! distrobox list &>/dev/null; then
        echo "[build_wivrn] WARN: distrobox not healthy. Try: bash bin/build_wivrn.sh --docker"
        exit 1
    fi
fi

# ── Tear down any stale container ────────────────────────────────────────────
if [[ $USE_DOCKER -eq 1 ]]; then
    docker rm -f "$BUILDER" 2>/dev/null || true
else
    distrobox rm -f "$BUILDER" 2>/dev/null || true
fi

# ── The build script that runs inside the container ──────────────────────────
# Written to a temp file so shell quoting is not a nightmare.
BUILD_SCRIPT=$(mktemp /tmp/wivrn-build-script.XXXXXX.sh)
trap 'rm -f "$BUILD_SCRIPT"' EXIT

cat > "$BUILD_SCRIPT" << 'INNER_EOF'
#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# In Docker we run as root; in distrobox we run as the user and need sudo
if [ "$(id -u)" = "0" ]; then
    APT="apt-get"
else
    APT="sudo apt-get"
fi

echo "[inner] Installing build dependencies..."
$APT update -qq
$APT install -y -qq \
    build-essential \
    cmake \
    ninja-build \
    git \
    pkg-config \
    python3 \
    libvulkan-dev \
    vulkan-validationlayers \
    glslang-tools \
    libavcodec-dev \
    libavfilter-dev \
    libdrm-dev \
    libegl-dev \
    libgl-dev \
    libglib2.0-dev \
    libpipewire-0.3-dev \
    libx264-dev \
    libudev-dev \
    libusb-1.0-0-dev \
    libcap-dev \
    libbsd-dev \
    libssl-dev \
    libboost-dev \
    libboost-iostreams-dev \
    libboost-locale-dev \
    libboost-thread-dev \
    nlohmann-json3-dev \
    libeigen3-dev \
    libavahi-client-dev \
    libavahi-glib-dev \
    libnotify-dev \
    librsvg2-dev \
    libarchive-dev \
    libsystemd-dev \
    bsdextrautils \
    libbluetooth-dev \
    libgles2-mesa-dev \
    libcli11-dev \
    wget \
    ca-certificates \
    2>&1 | tail -5


SRC=/project/src/tools/wivrn-src
if [ ! -f "$SRC/CMakeLists.txt" ]; then
    echo "[inner] Cloning WiVRn from upstream..."
    git clone --recursive https://github.com/WiVRn/WiVRn.git "$SRC"
fi

# Docker runs as root but the volume is owned by the host user — mark it safe
git config --global --add safe.directory "$SRC"
git config --global --add safe.directory "$SRC/_deps" 2>/dev/null || true

echo "[inner] Fetching tags and checking out v26.6.1..."
git -C "$SRC" reset --hard HEAD
git -C "$SRC" fetch --tags
git -C "$SRC" checkout v26.6.1

echo "[inner] Updating submodules..."
git -C "$SRC" submodule update --init --recursive 2>&1 | tail -3

echo "[inner] Applying Nearcade patches..."
for patch in "$SRC"/contribute/nearsec-patches/*.patch; do
    if [ -f "$patch" ]; then
        echo "  Applying $(basename "$patch")..."
        git -C "$SRC" apply "$patch" 2>&1 || true
    fi
done

BUILD_DIR=$(mktemp -d /tmp/wivrn-build.XXXXXX)
echo "[inner] Configuring in $BUILD_DIR ..."
cmake -S "$SRC" -B "$BUILD_DIR" \
    -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DWIVRN_BUILD_SERVER=ON \
    -DWIVRN_BUILD_SERVER_LIBRARY=ON \
    -DWIVRN_BUILD_CLIENT=OFF \
    -DWIVRN_BUILD_DASHBOARD=OFF \
    -DWIVRN_BUILD_WIVRNCTL=ON \
    -DWIVRN_USE_VAAPI=ON \
    -DWIVRN_USE_VULKAN_ENCODE=OFF \
    -DWIVRN_USE_X264=ON \
    -DWIVRN_USE_NVENC=ON \
    -DWIVRN_USE_PIPEWIRE=ON \
    -DWIVRN_USE_SYSTEMD=OFF \
    -DWIVRN_WERROR=OFF \
    -DWIVRN_USE_SYSTEM_BOOST=ON \
    -DWIVRN_USE_ELOGIND=OFF \
    -DGIT_DESC="v26.6.1" \
    -DGIT_COMMIT="HEAD"

echo "[inner] Compiling (this takes several minutes)..."
cmake --build "$BUILD_DIR" --target wivrn-server wivrnctl -j"$(nproc)" 2>&1

echo "[inner] Copying outputs..."
cp "$BUILD_DIR/server/wivrn-server" /project/bin/wivrn-server
chmod +x /project/bin/wivrn-server

WIVRNCTL="$BUILD_DIR/server/wivrnctl"
if [ ! -f "$WIVRNCTL" ]; then
    WIVRNCTL="$BUILD_DIR/tools/wivrnctl/wivrnctl"
fi
if [ -f "$WIVRNCTL" ]; then
    cp "$WIVRNCTL" /project/bin/wivrnctl
    chmod +x /project/bin/wivrnctl
fi

# Also build the Monado OpenXR runtime shared library and install manifest
echo "[inner] Building Monado OpenXR runtime library..."
cmake --build "$BUILD_DIR" --target openxr_wivrn -j"$(nproc)" 2>&1
WIVRN_SO="$BUILD_DIR/_deps/monado-build/src/xrt/targets/openxr/libopenxr_wivrn.so"
if [ -f "$WIVRN_SO" ]; then
    mkdir -p /project/bin/lib/wivrn
    cp "$WIVRN_SO" /project/bin/lib/wivrn/
    chmod +x /project/bin/lib/wivrn/libopenxr_wivrn.so
    echo "[inner] Monado runtime library copied"

    # Generate OpenXR manifest with a placeholder path — fixed from host side
    cat > /project/bin/lib/wivrn/openxr_wivrn.json << 'MANIFEST_EOF'
{
    "file_format_version": "1.0.0",
    "runtime": {
        "library_path": "REPLACE_ME_WITH_HOST_PATH",
        "name": "WiVRn"
    },
    "enable": true
}
MANIFEST_EOF
    echo "[inner] OpenXR manifest written (path needs host-side fixup)"
fi

rm -rf "$BUILD_DIR"
echo "[inner] ✓ Done."
INNER_EOF
chmod +x "$BUILD_SCRIPT"

# ── Execute inside the chosen container runtime ───────────────────────────────
if [[ $USE_DOCKER -eq 1 ]]; then
    echo "[build_wivrn] Running build inside Docker container '$BUILDER'..."
    docker run --rm \
        --name "$BUILDER" \
        -v "$PROJECT_DIR:/project:z" \
        -v "$BUILD_SCRIPT:/tmp/wivrn-inner-build.sh:ro" \
        docker.io/library/ubuntu:26.04 \
        bash /tmp/wivrn-inner-build.sh
else
    echo "[build_wivrn] Creating distrobox container '$BUILDER'..."
    distrobox create \
        --name "$BUILDER" \
        --image docker.io/library/ubuntu:26.04 \
        --volume "$PROJECT_DIR:/project:z" \
        --volume "$BUILD_SCRIPT:/tmp/wivrn-inner-build.sh:ro" \
        --yes
    echo "[build_wivrn] Entering container and building..."
    distrobox enter "$BUILDER" -- bash /tmp/wivrn-inner-build.sh
fi

# ── Fix up the manifest path (host-side) ──────────────────────────────────────
MANIFEST_FILE="$OUT_DIR/lib/wivrn/openxr_wivrn.json"
if [[ -f "$MANIFEST_FILE" ]]; then
    HOST_LIB_PATH="$OUT_DIR/lib/wivrn/libopenxr_wivrn.so"
    cat "$MANIFEST_FILE" | sed "s|REPLACE_ME_WITH_HOST_PATH|$HOST_LIB_PATH|g" | sudo tee "$MANIFEST_FILE" > /dev/null
    sudo ln -sf "$MANIFEST_FILE" "$OUT_DIR/openxr_wivrn.json" 2>/dev/null || true
    echo "[build_wivrn] Manifest fixed: $MANIFEST_FILE"
    echo "[build_wivrn] Symlink: $OUT_DIR/openxr_wivrn.json → $MANIFEST_FILE"
fi

# ── Destroy the container (distrobox only; Docker --rm handles it) ────────────
if [[ $USE_DOCKER -eq 0 ]]; then
    echo "[build_wivrn] Destroying distrobox container '$BUILDER'..."
    distrobox rm -f "$BUILDER"
    echo "[build_wivrn] ✓ Container destroyed."
fi

# ── Final verification ────────────────────────────────────────────────────────
if [[ -f "$OUT_DIR/wivrn-server" ]]; then
    echo ""
    echo "=============================================="
    echo "  Build complete!"
    echo "  wivrn-server : $OUT_DIR/wivrn-server"
    [[ -f "$OUT_DIR/wivrnctl" ]] && echo "  wivrnctl     : $OUT_DIR/wivrnctl"
    [[ -f "$OUT_DIR/openxr_wivrn.json" ]] && echo "  OpenXR manifest: $OUT_DIR/openxr_wivrn.json"
    echo "  Start with   : $OUT_DIR/wivrn-server"
    echo "=============================================="
else
    echo "[build_wivrn] ✗ wivrn-server not found in $OUT_DIR — build failed." >&2
    exit 1
fi