#!/bin/sh
# deb/rpm post-install: expose the capital-N console launcher alongside `nearcade`.
# Runs as root during package install. Never fails the install.
if command -v nearcade >/dev/null 2>&1; then
  ln -sf "$(command -v nearcade)" /usr/local/bin/Nearcade || true
fi
exit 0
