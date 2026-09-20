#!/usr/bin/env python3
"""
Centralized ICE Server Configuration for Python backends.
Single source of truth for all STUN/TURN servers.
Mirrors src/scripts/core/network/ice-servers.js
"""

# STUN Servers — kept to 3 (mirrors ice-servers.js). More than ~4 slows
# ICE discovery on every offer. Python format (stun://)
STUN_SERVERS = [
    "stun://stun.l.google.com:19302",
    "stun://stun1.l.google.com:19302",
    "stun://stun.cloudflare.com:3478",
]

# JavaScript format (stun:) for reference
STUN_SERVERS_JS = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
]


def get_stun_servers():
    """Return list of STUN servers in Python format."""
    return STUN_SERVERS


def get_stun_servers_js():
    """Return list of STUN servers in JavaScript format."""
    return STUN_SERVERS_JS


def build_ice_servers(turn_servers=None):
    """
    Build ICE server configuration for webrtcbin.
    
    Args:
        turn_servers: List of TURN server dicts with keys: urls, username, credential
    
    Returns:
        dict with 'stun' (list) and 'turn' (list) keys
    """
    return {
        'stun': STUN_SERVERS,
        'turn': turn_servers or [],
    }


if __name__ == '__main__':
    import json
    print(json.dumps({
        'stun': STUN_SERVERS,
        'stun_js': STUN_SERVERS_JS,
    }, indent=2))