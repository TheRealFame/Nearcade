//! Centralized ICE Server Configuration for Rust backends.
//! Mirrors src/scripts/core/network/ice-servers.js and src/sidecar/capture/ice_servers.py

/// STUN Servers — kept to 3 (mirrors ice-servers.js). More than ~4 slows
/// ICE discovery on every offer; the dead public TURNs stay out entirely
/// (real TURN comes from server /api/turn, not hardcoded).
/// Python/Rust format (stun://)
pub const STUN_SERVERS: &[&str] = &[
    "stun://stun.l.google.com:19302",
    "stun://stun1.l.google.com:19302",
    "stun://stun.cloudflare.com:3478",
];

/// JavaScript format (stun:) for reference
pub const STUN_SERVERS_JS: &[&str] = &[
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
];

/// Get STUN servers in Rust format
pub fn stun_servers() -> &'static [&'static str] {
    STUN_SERVERS
}

/// Get STUN servers in JavaScript format
pub fn stun_servers_js() -> &'static [&'static str] {
    STUN_SERVERS_JS
}

/// Build ICE server configuration for webrtcbin
pub fn build_ice_servers(turn_servers: Option<Vec<TurnServer>>) -> IceServers {
    IceServers {
        stun: STUN_SERVERS.iter().map(|s| s.to_string()).collect(),
        turn: turn_servers.unwrap_or_default(),
    }
}

#[derive(Debug, Clone)]
pub struct TurnServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

#[derive(Debug, Clone)]
pub struct IceServers {
    pub stun: Vec<String>,
    pub turn: Vec<TurnServer>,
}

impl Default for IceServers {
    fn default() -> Self {
        Self {
            stun: STUN_SERVERS.iter().map(|s| s.to_string()).collect(),
            turn: vec![],
        }
    }
}