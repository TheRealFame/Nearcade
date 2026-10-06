#!/bin/sh
# deb/rpm post-install: expose the capital-N console launcher alongside `nearcade`.
# Runs as root during package install. Never fails the install.
if command -v nearcade >/dev/null 2>&1; then
  ln -sf "$(command -v nearcade)" /usr/local/bin/Nearcade || true
fi

# Set up the Chromium setuid sandbox helper so the app can stay sandboxed
# even where unprivileged user namespaces are locked down (Ubuntu 24.04+
# AppArmor restrict_unprivileged_userns). This is what Google Chrome's own
# deb does; without it such systems fall back to --no-sandbox.
# The helper lives next to the installed binary; locate it robustly.
for _cand in /opt/Nearcade/chrome-sandbox /usr/lib/nearcade/chrome-sandbox; do
  if [ -f "$_cand" ]; then
    chown root:root "$_cand" || true
    chmod 4755 "$_cand" || true
  fi
done
exit 0
