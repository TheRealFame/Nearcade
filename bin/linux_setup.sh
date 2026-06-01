#!/usr/bin/env bash
# NearsecTogether — Linux Setup Script
# Installs udev rules for virtual controllers, loads uinput, copies the app
# icon, and verifies audio/Python dependencies.
#
# Package installation is DISTRO-AGNOSTIC: we check for required tools and
# print clear, per-distro instructions when anything is missing rather than
# hard-coding apt-get calls that would fail on non-Debian systems.

set -euo pipefail

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
echo "${BOLD}NearsecTogether — Linux Setup${RESET}"
echo "────────────────────────────────────────"

# ── Require root for udev rules / modprobe ────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  if sudo -n true 2>/dev/null; then
    echo "Using cached sudo credentials..."
    exec sudo "$0" "$@"
  else
    echo "${YELLOW}This script needs root to write udev rules and load kernel modules.${RESET}"
    echo "Re-run with: ${BOLD}sudo bash $0${RESET}"
    exit 1
  fi
fi

# ── Copy app icon ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &>/dev/null && pwd )"
if cp "$SCRIPT_DIR/../assets/NearsecTogether.png" /usr/share/pixmaps/NearsecTogether.png 2>/dev/null; then
  ok "App icon copied to /usr/share/pixmaps/"
else
  warn "Could not copy icon (non-fatal)"
fi

# ── Dependency preflight check ────────────────────────────────────────────────
echo ""
echo "${BOLD}Checking dependencies...${RESET}"

MISSING_SYSTEM=()
MISSING_PYTHON=()

# Check: pipewire
if command -v pipewire >/dev/null 2>&1; then
  ok "pipewire          $(command -v pipewire)"
else
  fail "pipewire          NOT FOUND"
  MISSING_SYSTEM+=("pipewire")
fi

# Check: pactl  (pulseaudio-utils / pipewire-pulse)
if command -v pactl >/dev/null 2>&1; then
  ok "pactl             $(command -v pactl)"
else
  fail "pactl             NOT FOUND"
  MISSING_SYSTEM+=("pulseaudio-utils / pipewire-pulse  (provides pactl)")
fi

# Check: python3
if command -v python3 >/dev/null 2>&1; then
  ok "python3           $(command -v python3)"
else
  warn "python3           NOT FOUND  (audio sidecar disabled)"
  MISSING_SYSTEM+=("python3")
fi

# Check: pyaudio
if python3 -c "import pyaudio" 2>/dev/null; then
  ok "python3-pyaudio   available"
else
  warn "python3-pyaudio   NOT FOUND  (OS-level audio fallback disabled)"
  MISSING_PYTHON+=("pyaudio")
fi

# ── Install Python packages via pip if python3 is available ──────────────────
if command -v python3 >/dev/null 2>&1 && command -v pip3 >/dev/null 2>&1; then
  echo ""
  echo "${BOLD}Installing Python packages via pip...${RESET}"
  pip3 install python-uinput pyaudio --break-system-packages --quiet \
    && ok "python-uinput, pyaudio installed via pip" \
    || warn "pip install had warnings (check output above)"

  # Re-verify pyaudio
  if python3 -c "import pyaudio" 2>/dev/null; then
    ok "python3-pyaudio   now available"
  else
    warn "PyAudio still not importable — portaudio dev headers may be missing."
    info "Install the portaudio development headers for your distro:"
    info "  Debian/Ubuntu:  sudo apt install portaudio19-dev"
    info "  Fedora:         sudo dnf install portaudio-devel"
    info "  Arch:           sudo pacman -S portaudio"
    info "  openSUSE:       sudo zypper install portaudio-devel"
    info "Then re-run:  pip3 install pyaudio --break-system-packages"
  fi
fi

# ── Print distro-agnostic installation instructions for missing system pkgs ───
if [ ${#MISSING_SYSTEM[@]} -gt 0 ]; then
  echo ""
  echo "${RED}${BOLD}Missing system packages:${RESET}"
  for pkg in "${MISSING_SYSTEM[@]}"; do
    info "• $pkg"
  done
  echo ""
  echo "${YELLOW}Install them using your distribution's package manager:${RESET}"
  echo ""
  info "${BOLD}Debian / Ubuntu / Pop!_OS / Mint:${RESET}"
  info "  sudo apt install pipewire pipewire-pulse pulseaudio-utils python3 python3-pip portaudio19-dev"
  echo ""
  info "${BOLD}Fedora / RHEL / CentOS Stream:${RESET}"
  info "  sudo dnf install pipewire pipewire-pulseaudio pulseaudio-utils python3 python3-pip portaudio-devel"
  echo ""
  info "${BOLD}Arch / Manjaro / EndeavourOS:${RESET}"
  info "  sudo pacman -S pipewire pipewire-pulse wireplumber python python-pip portaudio"
  echo ""
  info "${BOLD}openSUSE Tumbleweed / Leap:${RESET}"
  info "  sudo zypper install pipewire pipewire-pulseaudio pulseaudio-utils python3 python3-pip portaudio-devel"
  echo ""
  info "${BOLD}Void Linux:${RESET}"
  info "  sudo xbps-install -S pipewire wireplumber pipewire-pulse python3 python3-pip portaudio-devel"
  echo ""
  info "${BOLD}NixOS:${RESET}"
  info "  Add to configuration.nix: pipewire, pipewire.pulse, python3, python3Packages.pyaudio"
  echo ""
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
# NearsecTogether — virtual controller udev rules
# Ensure uinput itself is accessible without root
KERNEL=="uinput", MODE="0666", OPTIONS+="static_node=uinput"

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
ok "udev rules written to $RULE_FILE and reloaded"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
if [ ${#MISSING_SYSTEM[@]} -eq 0 ]; then
  echo "${GREEN}${BOLD}Setup complete.${RESET} Virtual controllers will now bypass Steam Input interference."
else
  echo "${YELLOW}${BOLD}Setup partially complete.${RESET}"
  echo "Install the missing packages above, then re-run this script to verify."
fi
echo ""
