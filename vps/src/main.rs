/*!
 * NearsecTogether VPS SFU — Dumb-Pipe WebSocket Router
 *
 * Architecture
 * ────────────
 * One Host connects and authenticates with MASTER_KEY.
 * Many Viewers connect — they do NOT supply a key.
 *
 * Data flow:
 *   Host  →  binary frame       →  broadcast to ALL Viewers (video chunks)
 *   Host  →  text "webcodecs-config" JSON → stored as last_config, broadcast
 *   Viewer → text/binary input  →  forward ONLY to Host, injecting viewer ID
 *
 * Config replay:
 *   When a Viewer connects, the router immediately sends them the most recent
 *   "webcodecs-config" text message seen from the Host. Without this, late-
 *   joining viewers have no VideoDecoder configuration and cannot decode frames.
 *
 * Concurrency model:
 *   Each connection runs in its own Tokio task.
 *   All shared state lives in Arc<RwLock<RouterState>>.
 *   Video broadcast uses per-viewer unbounded mpsc channels so a slow viewer
 *   cannot block the host encode loop.
 *
 * Environment variables:
 *   MASTER_KEY  — required; secret shared with the Electron host
 *   PORT        — default 9000
 */

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    sync::Arc,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, RwLock},
};
use tokio_tungstenite::{
    accept_async,
    tungstenite::Message,
};
use uuid::Uuid;

// ── Message types ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ClientMsg {
    Auth    { role: Option<String>, key: Option<String> },
    Ping    {},
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ServerMsg<'a> {
    AuthOk      { message: &'a str },
    AuthFail    { message: &'a str },
    Pong        {},
    ViewerInput { viewer_id: &'a str, payload: &'a str },
    ViewerJoined{ viewer_id: &'a str },
    ViewerLeft  { viewer_id: &'a str },
}

// ── Shared state ──────────────────────────────────────────────────────────────

/// Channel for pushing messages to a single viewer task.
type ViewerTx = mpsc::UnboundedSender<Message>;

struct RouterState {
    /// Sender side of the host's dedicated input channel.
    host_tx: Option<mpsc::UnboundedSender<Message>>,

    /// All connected viewer channels, keyed by UUID.
    viewers: HashMap<String, ViewerTx>,

    /// The most recent "webcodecs-config" text message received from the Host.
    /// Replayed to every viewer immediately on connection so their VideoDecoder
    /// initialises correctly even when they join after the stream started.
    last_config: Option<String>,
}

impl RouterState {
    fn new() -> Self {
        RouterState {
            host_tx:     None,
            viewers:     HashMap::new(),
            last_config: None,
        }
    }

    /// Broadcast a binary video frame to every connected viewer.
    fn broadcast_video(&self, frame: Message) {
        for tx in self.viewers.values() {
            // Silently ignore send errors — dead channels are cleaned up on disconnect.
            let _ = tx.send(frame.clone());
        }
    }

    /// Broadcast a text message (e.g. webcodecs-config) to every connected viewer.
    fn broadcast_text(&self, text: String) {
        for tx in self.viewers.values() {
            let _ = tx.send(Message::Text(text.clone()));
        }
    }

    /// Forward viewer input to the host, injecting the viewer's UUID.
    fn forward_to_host(&self, viewer_id: &str, payload: &str) {
        if let Some(tx) = &self.host_tx {
            let msg  = ServerMsg::ViewerInput { viewer_id, payload };
            let json = serde_json::to_string(&msg).unwrap_or_default();
            let _ = tx.send(Message::Text(json));
        }
    }

    /// Notify host that a viewer joined.
    fn notify_host_viewer_joined(&self, viewer_id: &str) {
        if let Some(tx) = &self.host_tx {
            let msg  = ServerMsg::ViewerJoined { viewer_id };
            let json = serde_json::to_string(&msg).unwrap_or_default();
            let _ = tx.send(Message::Text(json));
        }
    }

    /// Notify host that a viewer left.
    fn notify_host_viewer_left(&self, viewer_id: &str) {
        if let Some(tx) = &self.host_tx {
            let msg  = ServerMsg::ViewerLeft { viewer_id };
            let json = serde_json::to_string(&msg).unwrap_or_default();
            let _ = tx.send(Message::Text(json));
        }
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let master_key = env::var("MASTER_KEY").unwrap_or_else(|_| {
        eprintln!("[nearsec-router] FATAL: MASTER_KEY environment variable not set.");
        std::process::exit(1);
    });
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9000);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(&addr).await.unwrap_or_else(|e| {
        eprintln!("[nearsec-router] FATAL: Cannot bind {}:{} — {}", addr.ip(), port, e);
        std::process::exit(1);
    });

    let state:      Arc<RwLock<RouterState>> = Arc::new(RwLock::new(RouterState::new()));
    let master_key: Arc<String>              = Arc::new(master_key);

    println!("[nearsec-router] Listening on ws://0.0.0.0:{}", port);

    loop {
        match listener.accept().await {
            Ok((stream, peer_addr)) => {
                let state      = Arc::clone(&state);
                let master_key = Arc::clone(&master_key);
                tokio::spawn(async move {
                    handle_connection(stream, peer_addr, state, master_key).await;
                });
            }
            Err(e) => {
                eprintln!("[nearsec-router] Accept error: {}", e);
            }
        }
    }
}

// ── Connection handler ────────────────────────────────────────────────────────

async fn handle_connection(
    raw:        TcpStream,
    peer:       SocketAddr,
    state:      Arc<RwLock<RouterState>>,
    master_key: Arc<String>,
) {
    let ws_stream = match accept_async(raw).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[nearsec-router] WS handshake failed for {}: {}", peer, e);
            return;
        }
    };

    println!("[nearsec-router] Connected: {}", peer);
    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // ── Authentication phase ──────────────────────────────────────────────────
    // The first text message must be a JSON auth payload.
    // Clients have 5 seconds to send it before being dropped.
    let first_msg = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        ws_rx.next(),
    ).await;

    let first_text = match first_msg {
        Ok(Some(Ok(Message::Text(t)))) => t,
        _ => {
            eprintln!("[nearsec-router] {} did not authenticate in time — dropping", peer);
            let _ = ws_tx.send(Message::Text(
                serde_json::to_string(&ServerMsg::AuthFail { message: "auth timeout" }).unwrap()
            )).await;
            return;
        }
    };

    let client_msg: Result<ClientMsg, _> = serde_json::from_str(&first_text);
    let is_host = match &client_msg {
        Ok(ClientMsg::Auth { key: Some(k), .. }) => k == master_key.as_str(),
        _ => false,
    };

    // ── Host path ─────────────────────────────────────────────────────────────
    if is_host {
        // Only ONE host allowed at a time.
        {
            let r = state.read().await;
            if r.host_tx.is_some() {
                eprintln!("[nearsec-router] {} attempted host auth but host already connected", peer);
                let _ = ws_tx.send(Message::Text(
                    serde_json::to_string(&ServerMsg::AuthFail { message: "host already connected" }).unwrap()
                )).await;
                return;
            }
        }

        // Create an mpsc channel so viewer tasks can push input back to this host task.
        let (host_input_tx, mut host_input_rx) = mpsc::unbounded_channel::<Message>();
        {
            let mut w = state.write().await;
            w.host_tx = Some(host_input_tx);
            // Clear any stale config from the previous host session.
            w.last_config = None;
        }

        println!("[nearsec-router] Host authenticated from {}", peer);
        let _ = ws_tx.send(Message::Text(
            serde_json::to_string(&ServerMsg::AuthOk { message: "host authenticated" }).unwrap()
        )).await;

        // Two concurrent sub-tasks inside the host connection:
        //
        //   task_a — drain the host WebSocket:
        //     • Binary messages  → broadcast raw video frames to all viewers
        //     • Text messages    → if it contains "webcodecs-config", store it
        //                          as last_config AND broadcast to all viewers
        //                          so currently-connected viewers get it too.
        //                          Other text is forwarded as-is.
        //
        //   task_b — drain the host input channel:
        //     • Everything pushed here comes from viewer tasks (input packets,
        //       join/leave notifications). Write it straight to the host socket.

        let state_a = Arc::clone(&state);

        let task_a = async {
            while let Some(msg_result) = ws_rx.next().await {
                match msg_result {
                    Ok(Message::Binary(data)) => {
                        let r = state_a.read().await;
                        r.broadcast_video(Message::Binary(data));
                    }
                    Ok(Message::Text(text)) => {
                        // Webcodecs-config: store for late-joining viewer replay AND broadcast
                        if text.contains("webcodecs-config") {
                            let mut w = state_a.write().await;
                            w.last_config = Some(text.clone());
                            w.broadcast_text(text);
                        } else {
                            // All other host text (stream-idle, stream-active, etc.) must
                            // reach viewers. Previously these were silently dropped.
                            let r = state_a.read().await;
                            r.broadcast_text(text);
                        }
                    }
                    Ok(Message::Ping(_)) => {}
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        };

        let task_b = async {
            while let Some(msg) = host_input_rx.recv().await {
                if ws_tx.send(msg).await.is_err() {
                    break;
                }
            }
        };

        tokio::select! {
            _ = task_a => {},
            _ = task_b => {},
        }

        // Host disconnected — clear all host-related state but leave viewers connected
        // so they see a clean disconnect rather than a sudden drop.
        {
            let mut w = state.write().await;
            w.host_tx     = None;
            w.last_config = None;
        }
        println!("[nearsec-router] Host disconnected from {}", peer);

    // ── Viewer path ───────────────────────────────────────────────────────────
    } else {
        let viewer_id = Uuid::new_v4().to_string();

        // Create the per-viewer channel and register it.
        let (viewer_tx, mut viewer_rx) = mpsc::unbounded_channel::<Message>();

        // Read last_config while holding the write lock so we register the viewer
        // and snapshot the config atomically — no window where a config update
        // could arrive between registration and the replay send.
        let config_to_replay: Option<String> = {
            let mut w = state.write().await;
            w.viewers.insert(viewer_id.clone(), viewer_tx);
            w.notify_host_viewer_joined(&viewer_id);
            // Clone the config string while still holding the lock.
            w.last_config.clone()
        };

        println!("[nearsec-router] Viewer {} connected from {}", viewer_id, peer);

        // Tell the viewer they're accepted.
        let _ = ws_tx.send(Message::Text(
            serde_json::to_string(&ServerMsg::AuthOk { message: "viewer accepted" }).unwrap()
        )).await;

        // ── Config replay ─────────────────────────────────────────────────────
        // If the host has already sent a webcodecs-config packet, send it to
        // this viewer immediately so their VideoDecoder can initialise before
        // the first binary frame arrives via the broadcast channel.
        if let Some(cfg_str) = config_to_replay {
            println!("[nearsec-router] Replaying webcodecs-config to viewer {}", viewer_id);
            if ws_tx.send(Message::Text(cfg_str)).await.is_err() {
                // Viewer closed before we could even send the config — clean up and exit.
                let mut w = state.write().await;
                w.viewers.remove(&viewer_id);
                w.notify_host_viewer_left(&viewer_id);
                println!("[nearsec-router] Viewer {} dropped before config replay", viewer_id);
                return;
            }
        }

        let state_clone = Arc::clone(&state);
        let vid_clone   = viewer_id.clone();

        // task_a: broadcast channel → viewer WebSocket (video frames + text from host)
        let task_a = async {
            while let Some(frame) = viewer_rx.recv().await {
                if ws_tx.send(frame).await.is_err() {
                    break;
                }
            }
        };

        // task_b: viewer WebSocket → host (input packets)
        let task_b = async {
            while let Some(msg_result) = ws_rx.next().await {
                match msg_result {
                    Ok(Message::Text(t)) => {
                        let r = state_clone.read().await;
                        r.forward_to_host(&vid_clone, &t);
                    }
                    Ok(Message::Binary(b)) => {
                        let text = String::from_utf8_lossy(&b).into_owned();
                        let r = state_clone.read().await;
                        r.forward_to_host(&vid_clone, &text);
                    }
                    Ok(Message::Ping(_)) => {
                        // tungstenite handles pong automatically; just consume the message.
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        };

        tokio::select! {
            _ = task_a => {},
            _ = task_b => {},
        }

        // Viewer disconnected — remove from state and notify host.
        {
            let mut w = state.write().await;
            w.viewers.remove(&viewer_id);
            w.notify_host_viewer_left(&viewer_id);
        }
        println!("[nearsec-router] Viewer {} disconnected from {}", viewer_id, peer);
    }
}
