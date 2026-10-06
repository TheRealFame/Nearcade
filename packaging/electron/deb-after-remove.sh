#!/bin/sh
# deb/rpm post-remove: clean up the capital-N console launcher symlink.
rm -f /usr/local/bin/Nearcade || true
exit 0
