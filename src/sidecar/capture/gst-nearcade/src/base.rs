//! Capture-source resolution: PipeWire node discovery (port of the
//! pipewire-capture.js logic) + launch-string fragments.
//!
//! NOTE: XDG portal screencast (dbus) is not implemented in this prototype —
//! use --node, or keep the Python backend where portal fallback is needed.
//! The error for that case is explicit rather than silent.

use std::process::Command;

#[derive(Debug, Clone)]
pub struct PwNode {
    pub id: String,
    pub name: String,
    pub class: String,
    pub description: String,
}

fn parse_nodes(text: &str) -> Vec<PwNode> {
    let mut nodes = Vec::new();
    let mut cur: Option<PwNode> = None;
    let mut id = String::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("node:") {
            if let Some(n) = cur.take() {
                nodes.push(n);
            }
            id = rest.trim().to_string();
            cur = Some(PwNode {
                id: id.clone(),
                name: String::new(),
                class: String::new(),
                description: String::new(),
            });
        } else if let Some(n) = cur.as_mut() {
            if let Some(v) = t.strip_prefix("node.name") {
                n.name = v.trim_matches(|c| c == '=' || c == '"' || c == ' ').to_string();
            } else if let Some(v) = t.strip_prefix("media.class") {
                n.class = v.trim_matches(|c| c == '=' || c == '"' || c == ' ').to_string();
            } else if let Some(v) = t.strip_prefix("node.description") {
                n.description = v.trim_matches(|c| c == '=' || c == '"' || c == ' ').to_string();
            }
        }
        let _ = &id;
    }
    if let Some(n) = cur.take() {
        nodes.push(n);
    }
    nodes
        .into_iter()
        .filter(|n| {
            n.class == "Video/Sink"
                || n.class == "Video/Source"
                || ["gamescope", "steamvr", "wivrn", "monado"]
                    .iter()
                    .any(|k| n.name.contains(k))
        })
        .collect()
}

/// List video PipeWire nodes (`--mode list`).
pub fn list_nodes() -> Vec<PwNode> {
    let out = Command::new("pw-cli")
        .arg("list-objects")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    parse_nodes(&out)
}

const PRIORITY: &[&str] = &["wivrn", "monado", "gamescope", "steamvr", "vrcompositor", "steam"];

/// Headless node pick, same priority order as the JS side.
pub fn find_gamescope_node() -> Option<PwNode> {
    let nodes = list_nodes();
    for kw in PRIORITY {
        if let Some(n) = nodes.iter().find(|n| {
            n.name.to_lowercase().contains(kw) || n.description.to_lowercase().contains(kw)
        }) {
            return Some(n.clone());
        }
    }
    None
}

/// GStreamer source element fragment for a node id/serial.
pub fn source_for_node(node: &str) -> String {
    format!("pipewiresrc target-object={node} do-timestamp=true")
}
