#!/bin/bash
# Nearcade - Steam Input Conflict Fix
# This script creates a udev rule to ensure virtual controllers are 
# accessible to the system but ignored by Steam's auto-configurator.

RULE_FILE="/etc/udev/rules.d/99-nearsec-input.rules"

echo "--- Creating udev rules for virtual controllers ---"

cat << EOF | sudo tee $RULE_FILE > /dev/null
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
# Ensure uinput itself is accessible
KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput"
EOF

echo "--- Reloading udev rules ---"
sudo udevadm control --reload-rules
sudo udevadm trigger

echo "--- Done. Virtual controllers will now bypass Steam Input interference. ---"
