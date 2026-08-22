#!/usr/bin/env sh
# Nearcade community TURN entry generator.
# Run this next to nearcade-turn and it writes nearcade-turn-entry.json
# in the exact schema the repo's config/community-turn-servers.json
# uses — submit it as a PR and Nearcade players can join your relay.
set -e
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
printf 'Nearcade TURN entry generator\n'
printf 'Name (e.g. "fames-relay eu"): '; read NAME
printf 'Public IP/host of this server: '; read IP
printf 'TURN port [3478]: '; read PORT; [ -z "$PORT" ] && PORT=3478
printf 'Username (static pair, as passed to nearcade-turn): '; read USER
printf 'Password (static pair, as passed to nearcade-turn): '; read PASS
printf 'Region (e.g. EU-West): '; read REGION
printf 'Your name: '; read AUTHOR
printf 'Short description: '; read DESC
OUT="$DIR/nearcade-turn-entry.json"
cat > "$OUT" <<JSON
[
  {
    "name": "$NAME",
    "url": "turn:$IP:$PORT?transport=udp",
    "username": "$USER",
    "credential": "$PASS",
    "description": "$DESC",
    "region": "$REGION",
    "author": "$AUTHOR",
    "enabled": true
  }
]
JSON
printf '\nCreated %s\n' "$OUT"
printf 'Open a PR adding it to config/community-turn-servers.json in the\n'
printf 'Nearcade repo so players can find and join your server.\n'