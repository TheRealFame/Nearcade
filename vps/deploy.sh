#!/usr/bin/env bash
# deploy.sh
# Nearcade VPS deployment script
# Starts the Node.js application server on port 3001 and the Rust SFU router on port 3000.
# Both processes run in the background and write logs to the vps directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VPS_DIR="$SCRIPT_DIR"

# Resolve the Node.js version from the root package.json
NODE_VERSION="$(node -e "process.stdout.write(require('$PROJECT_ROOT/package.json').version)")"

echo "========================================"
echo "  Nearcade Deploy  v${NODE_VERSION}"
echo "========================================"
echo ""

# Step 1: Install Node.js dependencies from the project root
echo "[1/5] Installing Node.js dependencies..."
cd "$PROJECT_ROOT"
npm install --omit=dev
echo "      Done."
echo ""

# Step 2: Ensure .env exists and optionally install TURN server
echo "[2/5] Checking environment and TURN setup..."
if [ ! -f "$PROJECT_ROOT/.env" ]; then
    echo "      Creating default .env file..."
    cat <<EOF > "$PROJECT_ROOT/.env"
# Nearcade Configuration
TUNNEL=vps

# P2P TURN/STUN Configuration (Auto-populated if you install coturn)
STUN_URL=
TURN_URL=
TURN_USERNAME=
TURN_CREDENTIAL=
EOF
fi

if ! command -v turnserver &> /dev/null; then
    echo ""
    read -p "      Would you like to install a TURN server for WebRTC P2P fallback? (y/N): " install_turn
    if [[ "$install_turn" =~ ^[Yy]$ ]]; then
        if [ -f "$PROJECT_ROOT/bin/setup_turn.sh" ]; then
            chmod +x "$PROJECT_ROOT/bin/setup_turn.sh"
            sudo "$PROJECT_ROOT/bin/setup_turn.sh"
            
            # Auto-populate the .env file with the VPS public IP
            PUBLIC_IP=$(curl -s https://api.ipify.org || echo "YOUR_VPS_IP")
            sed -i "s|^STUN_URL=.*|STUN_URL=stun:${PUBLIC_IP}:3478|" "$PROJECT_ROOT/.env"
            sed -i "s|^TURN_URL=.*|TURN_URL=turn:${PUBLIC_IP}:3478|" "$PROJECT_ROOT/.env"
            sed -i "s|^TURN_USERNAME=.*|TURN_USERNAME=nearsec|" "$PROJECT_ROOT/.env"
            sed -i "s|^TURN_CREDENTIAL=.*|TURN_CREDENTIAL=nearsec_turn_secret_change_me|" "$PROJECT_ROOT/.env"
            echo "      .env file automatically configured with IP $PUBLIC_IP."
        else
            echo "      Error: bin/setup_turn.sh not found."
        fi
    fi
else
    echo "      TURN server (coturn) is already installed."
fi
echo ""


# Step 3: Build the Rust router if the binary is missing or the source is newer
RUST_BIN="$VPS_DIR/target/release/nearsec-router"
echo "[3/5] Checking Rust router binary..."
cd "$VPS_DIR"
if [ ! -f "$RUST_BIN" ] || find "$VPS_DIR/src" -name "*.rs" -newer "$RUST_BIN" | grep -q .; then
    echo "      Building Rust router (this may take a minute on the first run)..."
    cargo build --release
    echo "      Build complete."
else
    echo "      Binary is up to date, skipping build."
fi
echo ""

# Step 4: Kill any stale processes occupying ports 3000 or 3001
echo "[4/5] Clearing ports 3000 and 3001..."
for PORT in 3000 3001; do
    PID="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
    if [ -n "$PID" ]; then
        kill "$PID" 2>/dev/null || true
        echo "      Stopped previous process on port $PORT (PID $PID)"
    fi
done
sleep 1
echo ""

# Step 5: Launch both processes
echo "[5/5] Starting services..."

echo "      Setting permissions on project directory..."
chmod -R 755 "$PROJECT_ROOT"

# Node.js application server on port 3001
PORT=3001 node "$PROJECT_ROOT/src/scripts/server.js" \
    > "$VPS_DIR/node.log" 2>&1 &
NODE_PID=$!
echo "      Node.js server started (PID $NODE_PID, port 3001)"
echo "      Log: $VPS_DIR/node.log"

# Load .env if it exists so MASTER_KEY is available
if [ -f "$PROJECT_ROOT/.env" ]; then
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
fi

# Rust SFU router on port 3000
PORT=3000 "$RUST_BIN" \
    > "$VPS_DIR/router.log" 2>&1 &
RUST_PID=$!
echo "      Rust router started  (PID $RUST_PID, port 3000)"
echo "      Log: $VPS_DIR/router.log"

# Write PIDs so you can stop processes cleanly later
echo "$NODE_PID" > "$VPS_DIR/node.pid"
echo "$RUST_PID" > "$VPS_DIR/router.pid"

echo ""
echo "========================================"
echo "  Both services are running."
echo ""
echo "  To stop them:"
echo "    kill \$(cat $VPS_DIR/node.pid) \$(cat $VPS_DIR/router.pid)"
echo ""
echo "  To follow logs:"
echo "    tail -f $VPS_DIR/node.log"
echo "    tail -f $VPS_DIR/router.log"
echo "========================================"
