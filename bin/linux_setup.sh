#!/usr/bin/env bash
# Nearcade — Linux Setup Script
# Installs udev rules for virtual controllers, loads uinput, copies the app
# icon, and verifies/installs audio/Python dependencies automatically.

set -uo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────────
if command -v tput >/dev/null 2>&1 && [ -t 1 ]; then
  BOLD="$(tput bold)"; RESET="$(tput sgr0)"
  GREEN="$(tput setaf 2)"; YELLOW="$(tput setaf 3)"; RED="$(tput setaf 1)"
else
  BOLD=''; RESET=''; GREEN=''; YELLOW=''; RED=''
fi

ok()   { echo "${GREEN}✓${RESET} $*"; }
warn() { echo "${YELLOW}!${RESET} $*"; }
fail() { echo "${RED}✗${RESET} $*"; }
info() { echo "  $*"; }

echo ""
echo "${BOLD}Nearcade — Linux Setup${RESET}"
echo "────────────────────────────────────────"

# ── Require root ────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  if sudo -n true 2>/dev/null; then
    echo "Using cached sudo credentials..."
    exec sudo "$0" "$@"
  else
    echo "${YELLOW}This script needs root to write udev rules, install dependencies, and load kernel modules.${RESET}"
    echo "Re-run with: ${BOLD}sudo bash $0${RESET}"
    exit 1
  fi
fi

# ── Copy app icon ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &>/dev/null && pwd )"
if [ -f "/tmp/NearcadeLogo.png" ] && cp "/tmp/NearcadeLogo.png" /usr/share/pixmaps/NearcadeLogo.png 2>/dev/null; then
  ok "App icon copied to /usr/share/pixmaps/"
elif cp "$SCRIPT_DIR/../assets/NearcadeLogo.png" /usr/share/pixmaps/NearcadeLogo.png 2>/dev/null; then
  ok "App icon copied to /usr/share/pixmaps/"
else
  warn "Could not copy icon (non-fatal)"
fi

# ── Dependency Auto-Installer ────────────────────────────────────────────────
MISSING_SYSTEM=0

if ! command -v pipewire >/dev/null 2>&1 || \
   ! command -v pactl >/dev/null 2>&1 || \
   ! command -v python3 >/dev/null 2>&1; then
   MISSING_SYSTEM=1
fi

if ! python3 -c "import pyaudio" 2>/dev/null; then
   MISSING_SYSTEM=1
fi

if [ $MISSING_SYSTEM -eq 1 ]; then
  echo ""
  echo "${YELLOW}Missing system dependencies detected. Attempting auto-installation...${RESET}"

  if grep -qi "steamos" /etc/os-release 2>/dev/null; then
    echo "${BOLD}SteamOS detected.${RESET} Temporarily disabling read-only filesystem..."
    steamos-readonly disable || true
    pacman -Sy --noconfirm --needed pipewire pipewire-pulse wireplumber python python-pip portaudio
  elif command -v apt-get >/dev/null 2>&1; then
    echo "${BOLD}Debian/Ubuntu system detected.${RESET}"
    apt-get update
    apt-get install -y pipewire pipewire-pulse pulseaudio-utils python3 python3-pip portaudio19-dev python3-pyaudio
  elif command -v rpm-ostree >/dev/null 2>&1; then
    echo "${BOLD}Immutable Fedora-based OS (Bazzite/Silverblue) detected.${RESET}"
    echo "Installing via rpm-ostree..."
    rpm-ostree install -y pipewire pipewire-pulseaudio pulseaudio-utils python3 python3-pip portaudio-devel python3-pyaudio || true
    echo "${YELLOW}Notice: Immutable systems require a system reboot for ostree packages to apply!${RESET}"
  elif command -v dnf >/dev/null 2>&1; then
    echo "${BOLD}Fedora/RHEL system detected.${RESET}"
    dnf install -y pipewire pipewire-pulseaudio pulseaudio-utils python3 python3-pip portaudio-devel python3-pyaudio
  elif command -v pacman >/dev/null 2>&1; then
    echo "${BOLD}Arch Linux system detected.${RESET}"
    pacman -Sy --noconfirm --needed pipewire pipewire-pulse wireplumber python python-pip portaudio python-pyaudio
  elif command -v zypper >/dev/null 2>&1; then
    echo "${BOLD}openSUSE system detected.${RESET}"
    zypper install -y pipewire pipewire-pulseaudio pulseaudio-utils python3 python3-pip portaudio-devel python3-PyAudio
  elif command -v xbps-install >/dev/null 2>&1; then
    echo "${BOLD}Void Linux system detected.${RESET}"
    xbps-install -Sy pipewire wireplumber pipewire-pulse python3 python3-pip portaudio-devel python3-pyaudio
  else
    echo "${RED}Could not detect package manager. You may need to install dependencies manually.${RESET}"
  fi
fi

# ── Dependency Verification ────────────────────────────────────────────────
echo ""
echo "${BOLD}Verifying dependencies...${RESET}"

if command -v pipewire >/dev/null 2>&1; then ok "pipewire          $(command -v pipewire)"; else fail "pipewire          NOT FOUND"; fi
if command -v pactl >/dev/null 2>&1; then ok "pactl             $(command -v pactl)"; else fail "pactl             NOT FOUND"; fi
if command -v python3 >/dev/null 2>&1; then ok "python3           $(command -v python3)"; else fail "python3           NOT FOUND"; fi

# ── Python Packages (pip) ──────────────────────────────────────────────────
if command -v python3 >/dev/null 2>&1 && command -v pip3 >/dev/null 2>&1; then
  echo ""
  echo "${BOLD}Verifying python-uinput module...${RESET}"
  if ! python3 -c "import uinput" 2>/dev/null; then
    if pip3 install python-uinput pyaudio --quiet 2>/dev/null; then
      ok "python-uinput installed via standard pip"
    else
      warn "Standard pip install blocked. Attempting system-level pip install..."
      pip3 install python-uinput pyaudio --break-system-packages --quiet \
        && pkexec echo "python-uinput installed via --break-system-packages" \
        || fail "Could not install python-uinput"
    fi
  else
    ok "python-uinput is already installed."
  fi

  if python3 -c "import pyaudio" 2>/dev/null; then
    ok "python3-pyaudio   available"
  else
    warn "PyAudio could not be imported! OS-level audio fallback disabled."
  fi
fi

# ── uinput kernel module ──────────────────────────────────────────────────────
echo ""
echo "${BOLD}Loading uinput module...${RESET}"
if modprobe uinput 2>/dev/null; then
  ok "uinput module loaded"
elif [ -e /dev/uinput ]; then
  ok "uinput is built into this kernel (modprobe not needed)"
else
  fail "uinput not available — controller input will not work"
  info "Try:  sudo modprobe uinput"
  info "Or check your kernel config for CONFIG_INPUT_UINPUT=y"
fi

# ── udev rules for virtual controllers ───────────────────────────────────────
echo ""
echo "${BOLD}Writing udev rules for virtual controllers...${RESET}"
RULE_FILE="/etc/udev/rules.d/99-nearsec-input.rules"

cat > "$RULE_FILE" << 'RULES'
# Nearcade — virtual controller udev rules
# Ensure uinput itself is accessible without root
KERNEL=="uinput", MODE="0666", GROUP="input", OPTIONS+="static_node=uinput"

# Xbox 360 Virtual Pad
SUBSYSTEM=="input", ATTRS{idVendor}=="045e", ATTRS{idProduct}=="028e", TAG+="uaccess"
# Xbox One Virtual Pad
SUBSYSTEM=="input", ATTRS{idVendor}=="045e", ATTRS{idProduct}=="02ea", TAG+="uaccess"
# Xbox Series Virtual Pad
SUBSYSTEM=="input", ATTRS{idVendor}=="045e", ATTRS{idProduct}=="0b12", TAG+="uaccess"
# PS4 DualShock 4 Virtual Pad
SUBSYSTEM=="input", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="09cc", TAG+="uaccess"
# PS5 DualSense Virtual Pad
SUBSYSTEM=="input", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="0ce6", TAG+="uaccess"
# Xbox One Virtual Pad — force joystick identity, suppress mouse/keyboard confusion
SUBSYSTEM=="input", ATTRS{name}=="Microsoft Xbox*", \
  ENV{ID_INPUT_JOYSTICK}="1", ENV{ID_INPUT_MOUSE}="0", ENV{ID_INPUT_KEY}="0"
RULES

udevadm control --reload-rules && udevadm trigger
if [ ! -f /etc/modules-load.d/uinput.conf ]; then
    echo "uinput" | tee /etc/modules-load.d/uinput.conf > /dev/null
    modprobe uinput || true
fi
ok "udev rules written to $RULE_FILE and reloaded"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "${GREEN}${BOLD}Setup complete.${RESET} Virtual controllers will now bypass Steam Input interference."
echo ""
