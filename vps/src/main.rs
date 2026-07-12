/*!
 * Nearcade VPS SFU — Dumb-Pipe WebSocket Router
 *
 * Waiting-room model:
 *   Viewers land in `unverified_viewers` until the Host sends viewer-authorized.
 *   Only `active_viewers` receive video/audio/config broadcasts.
 *   Unverified viewers may send text (join/PIN) to the Host only.
 *
 * Standby model:
 *   Connections with ?standby=true go into `standby_viewers`.
 *   They receive stream-active / stream-idle broadcasts from the host.
 *   They never get pin-required and are silently dropped on disconnect.
 */

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    tungstenite::{
        handshake::server::{Request, Response},
        Message,
    },
};
use uuid::Uuid;

// ── Message types ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ClientMsg {
    Auth {
        #[allow(dead_code)]
        role: Option<String>,
        key: Option<String>,
    },
    Ping {},
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ServerMsg<'a> {
    AuthOk      { message: &'a str },
    AuthFail    { message: &'a str },
    #[allow(dead_code)]
    Pong        {},
    ViewerInput { viewer_id: &'a str, payload: &'a str },
    ViewerJoined{ viewer_id: &'a str },
    ViewerLeft  { viewer_id: &'a str },
}

enum HostCmd {
    Authorize(String),
    Dispatch(String, String),
    SetPin(bool),
}

// ── Shared state ──────────────────────────────────────────────────────────────

type ViewerTx = mpsc::UnboundedSender<Message>;

struct RouterState {
    host_tx:             Option<mpsc::UnboundedSender<Message>>,
    unverified_viewers:  HashMap<String, ViewerTx>,
    active_viewers:      HashMap<String, ViewerTx>,
    /// Standby connections (?standby=true) — only receive stream-active / stream-idle
    standby_viewers:     HashMap<String, ViewerTx>,
    last_config:         Option<String>,
    /// Mirrors the host's pinEnabled flag — when false, new viewers skip the pin check
    pin_enabled:         bool,
}

impl RouterState {
    fn new() -> Self {
        RouterState {
            host_tx:            None,
            unverified_viewers: HashMap::new(),
            active_viewers:     HashMap::new(),
            standby_viewers:    HashMap::new(),
            last_config:        None,
            pin_enabled:        true, // default on until host says otherwise
        }
    }

    fn broadcast_video(&self, frame: Message) {
        for tx in self.active_viewers.values() {
            let _ = tx.send(frame.clone());
        }
    }

    fn broadcast_text(&self, text: String) {
        for tx in self.active_viewers.values() {
            let _ = tx.send(Message::Text(text.clone()));
        }
    }

    /// Fan-out a stream-active or stream-idle message to standby connections only.
    fn broadcast_standby(&self, text: String) {
        for tx in self.standby_viewers.values() {
            let _ = tx.send(Message::Text(text.clone()));
        }
    }

    fn send_to_viewer(&self, viewer_id: &str, text: String) {
        if let Some(tx) = self.active_viewers.get(viewer_id) {
            let _ = tx.send(Message::Text(text));
            return;
        }
        if let Some(tx) = self.unverified_viewers.get(viewer_id) {
            let _ = tx.send(Message::Text(text));
        }
    }

    fn forward_to_host(&self, viewer_id: &str, payload: &str) {
        if payload.contains(r#""type":"gamepad""#) {
            println!("[nearsec-router] [DEBUG GAMEPAD] Relaying input for viewer {}", viewer_id);
        }
        if let Some(tx) = &self.host_tx {
            let msg  = ServerMsg::ViewerInput { viewer_id, payload };
            let json = serde_json::to_string(&msg).unwrap_or_default();
            let _ = tx.send(Message::Text(json));
        }
    }

    fn notify_host_viewer_joined(&self, viewer_id: &str) {
        if let Some(tx) = &self.host_tx {
            let msg  = ServerMsg::ViewerJoined { viewer_id };
            let json = serde_json::to_string(&msg).unwrap_or_default();
            let _ = tx.send(Message::Text(json));
        }
    }

    fn notify_host_viewer_left(&self, viewer_id: &str) {
        if let Some(tx) = &self.host_tx {
            let msg  = ServerMsg::ViewerLeft { viewer_id };
            let json = serde_json::to_string(&msg).unwrap_or_default();
            let _ = tx.send(Message::Text(json));
        }
    }

    fn viewer_pool(&self, viewer_id: &str) -> ViewerPool {
        if self.active_viewers.contains_key(viewer_id) {
            ViewerPool::Active
        } else if self.unverified_viewers.contains_key(viewer_id) {
            ViewerPool::Unverified
        } else {
            ViewerPool::None
        }
    }

    fn authorize_viewer(&mut self, viewer_id: &str) -> Option<String> {
        let tx = self.unverified_viewers.remove(viewer_id)?;
        self.active_viewers.insert(viewer_id.to_string(), tx.clone());
        let config = self.last_config.clone();
        self.notify_host_viewer_joined(viewer_id);
        if let Some(cfg) = &config {
            let _ = tx.send(Message::Text(cfg.clone()));
        }
        config
    }

    fn remove_viewer(&mut self, viewer_id: &str) -> bool {
        let was_active = self.active_viewers.remove(viewer_id).is_some();
        self.unverified_viewers.remove(viewer_id);
        was_active
    }
}

#[derive(PartialEq)]
enum ViewerPool {
    Active,
    Unverified,
    None,
}

// ── Query-string parser ───────────────────────────────────────────────────────
/// Returns true if the raw HTTP GET line contains standby=true in the query string.
fn is_standby_request(request_uri: &str) -> bool {
    if let Some(q) = request_uri.split('?').nth(1) {
        q.split('&').any(|pair| pair == "standby=true")
    } else {
        false
    }
}

fn parse_host_command(text: &str) -> Option<HostCmd> {
    let v: Value = serde_json::from_str(text).ok()?;
    let t = v.get("type")?.as_str()?;
    match t {
        "viewer-authorized" => {
            let id = v
                .get("viewerId")
                .or_else(|| v.get("viewer_id"))
                .and_then(|x| x.as_str())?
                .to_string();
            Some(HostCmd::Authorize(id))
        }
        "viewer-dispatch" => {
            let id = v
                .get("viewerId")
                .or_else(|| v.get("viewer_id"))
                .and_then(|x| x.as_str())?
                .to_string();
            let payload = v
                .get("payload")
                .and_then(|x| x.as_str())?
                .to_string();
            Some(HostCmd::Dispatch(id, payload))
        }
        "set-pin" => {
            let enabled = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true);
            Some(HostCmd::SetPin(enabled))
        }
        _ => None,
    }
}

/// Check whether a JSON text message is stream-active or stream-idle — these
/// must be forwarded to standby viewers as well as the normal broadcast.
fn is_stream_lifecycle_msg(text: &str) -> bool {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        matches!(v.get("type").and_then(|t| t.as_str()), Some("stream-active") | Some("stream-idle"))
    } else {
        false
    }
}

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

    // Spawn WebTransport UDP Router (If configured)
    let wt_state = Arc::clone(&state);
    tokio::spawn(async move {
        run_webtransport_server(wt_state).await;
    });

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

async fn handle_connection(
    raw:        TcpStream,
    peer:       SocketAddr,
    state:      Arc<RwLock<RouterState>>,
    master_key: Arc<String>,
) {
    // ── Peek the HTTP request URI before upgrading ────────────────────────────
    // We need to inspect the query string to detect ?standby=true without
    // blocking the upgrade. We capture the URI from the server callback.
    let mut standby = false;

    let ws_stream = {
        let standby_ref = &mut standby;
        match tokio_tungstenite::accept_hdr_async(raw, |req: &Request, resp: Response| {
            let uri = req.uri().to_string();
            *standby_ref = is_standby_request(&uri);
            Ok(resp)
        }).await {
            Ok(ws) => ws,
            Err(e) => {
                eprintln!("[nearsec-router] WS handshake failed for {}: {}", peer, e);
                return;
            }
        }
    };

    println!(
        "[nearsec-router] Connected: {} ({})",
        peer,
        if standby { "standby" } else { "normal" }
    );
    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // ── Standby fast-path ─────────────────────────────────────────────────────
    // Standby connections just sit and wait for stream-active / stream-idle.
    // They skip the auth/PIN dance entirely.
    if standby {
        let standby_id = Uuid::new_v4().to_string();
        let (standby_tx, mut standby_rx) = mpsc::unbounded_channel::<Message>();
        {
            let mut w = state.write().await;
            w.standby_viewers.insert(standby_id.clone(), standby_tx);
        }
        println!("[nearsec-router] Standby viewer {} registered from {}", standby_id, peer);

        let (is_host_connected, pin_req) = {
            let r = state.read().await;
            (r.host_tx.is_some(), r.pin_enabled)
        };
        let init_msg = if is_host_connected {
            format!(r#"{{"type":"stream-active","pinRequired":{}}}"#, pin_req)
        } else {
            format!(r#"{{"type":"stream-idle","pinRequired":{}}}"#, pin_req)
        };
        let _ = ws_tx.send(Message::Text(init_msg)).await;

        let task_send = async {
            while let Some(msg) = standby_rx.recv().await {
                if ws_tx.send(msg).await.is_err() { break; }
            }
        };
        let task_recv = async {
            // Standby viewers may send pings; we discard everything else.
            while let Some(msg_result) = ws_rx.next().await {
                match msg_result {
                    Ok(Message::Ping(_)) => {}
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        };

        tokio::select! {
            _ = task_send => {},
            _ = task_recv => {},
        }

        {
            let mut w = state.write().await;
            w.standby_viewers.remove(&standby_id);
        }
        println!("[nearsec-router] Standby viewer {} disconnected from {}", standby_id, peer);
        return;
    }

    // ── Normal auth flow ──────────────────────────────────────────────────────
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

    if is_host {
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

        let (host_input_tx, mut host_input_rx) = mpsc::unbounded_channel::<Message>();
        {
            let mut w = state.write().await;
            w.host_tx = Some(host_input_tx);
            w.last_config = None;
        }

        println!("[nearsec-router] Host authenticated from {}", peer);
        let _ = ws_tx.send(Message::Text(
            serde_json::to_string(&ServerMsg::AuthOk { message: "host authenticated" }).unwrap()
        )).await;

        let state_a = Arc::clone(&state);

        let task_a = async {
            while let Some(msg_result) = ws_rx.next().await {
                match msg_result {
                    Ok(Message::Binary(data)) => {
                        let r = state_a.read().await;
                        r.broadcast_video(Message::Binary(data));
                    }
                    Ok(Message::Text(text)) => {
                        if let Some(cmd) = parse_host_command(&text) {
                            let mut w = state_a.write().await;
                            match cmd {
                                HostCmd::Authorize(id) => {
                                    if w.authorize_viewer(&id).is_some() {
                                        println!("[nearsec-router] Viewer {} authorized", id);
                                    }
                                }
                                HostCmd::Dispatch(id, payload) => {
                                    w.send_to_viewer(&id, payload);
                                }
                                HostCmd::SetPin(enabled) => {
                                    w.pin_enabled = enabled;
                                    println!("[nearsec-router] PIN {}", if enabled { "enabled" } else { "disabled" });
                                    let msg = format!(r#"{{"type":"pin-update","pinRequired":{}}}"#, enabled);
                                    w.broadcast_standby(msg);
                                }
                            }
                            continue;
                        }

                        // Broadcast stream lifecycle events to standby viewers too
                        if is_stream_lifecycle_msg(&text) {
                            let r = state_a.read().await;
                            r.broadcast_standby(text.clone());
                            r.broadcast_text(text);
                        } else if text.contains("webcodecs-config") {
                            let mut w = state_a.write().await;
                            w.last_config = Some(text.clone());
                            w.broadcast_text(text);
                        } else {
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

        {
            let mut w = state.write().await;
            w.host_tx     = None;
            w.last_config = None;
            w.broadcast_text(r#"{"type":"host-disconnected"}"#.to_string());
            w.broadcast_standby(r#"{"type":"stream-idle"}"#.to_string());
        }
        println!("[nearsec-router] Host disconnected from {}", peer);

    } else {
        // Check if PIN is enabled on the VPS router level
        // If disabled, viewers skip the waiting-room and connect directly
        let pin_required = {
            let r = state.read().await;
            r.pin_enabled
        };

        let viewer_id = Uuid::new_v4().to_string();
        let (viewer_tx, mut viewer_rx) = mpsc::unbounded_channel::<Message>();

        {
            let mut w = state.write().await;
            w.unverified_viewers.insert(viewer_id.clone(), viewer_tx);
            w.forward_to_host(&viewer_id, &first_text);
        }

        println!("[nearsec-router] Viewer {} connected (unverified, pin_required={}) from {}", viewer_id, pin_required, peer);

        // Tell the viewer whether a PIN is required so viewer.js can skip the prompt
        let auth_msg = if pin_required {
            format!(r#"{{"type":"auth-ok","message":"viewer accepted","viewer_id":"{}"}}"#, viewer_id)
        } else {
            // Include pin_required=false so viewer.js knows to auto-join
            format!(r#"{{"type":"auth-ok","message":"viewer accepted","viewer_id":"{}","pin_required":false}}"#, viewer_id)
        };
        let _ = ws_tx.send(Message::Text(auth_msg)).await;

        let state_clone = Arc::clone(&state);
        let vid_clone   = viewer_id.clone();

        let task_a = async {
            while let Some(frame) = viewer_rx.recv().await {
                if ws_tx.send(frame).await.is_err() {
                    break;
                }
            }
        };

        let task_b = async {
            while let Some(msg_result) = ws_rx.next().await {
                match msg_result {
                    Ok(Message::Text(t)) => {
                        let r = state_clone.read().await;
                        r.forward_to_host(&vid_clone, &t);
                    }
                    Ok(Message::Binary(b)) => {
                        let pool = {
                            let r = state_clone.read().await;
                            r.viewer_pool(&vid_clone)
                        };
                        if pool == ViewerPool::Active {
                            println!("[nearsec-router] WARNING: Viewer {} sent binary data! String conversion may corrupt it. Use WebTransport for binary instead.", vid_clone);
                            let text = String::from_utf8_lossy(&b).into_owned();
                            let r = state_clone.read().await;
                            r.forward_to_host(&vid_clone, &text);
                        }
                    }
                    Ok(Message::Ping(_)) => {}
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        };

        tokio::select! {
            _ = task_a => {},
            _ = task_b => {},
        }

        {
            let mut w = state.write().await;
            let was_active = w.remove_viewer(&viewer_id);
            if was_active {
                w.notify_host_viewer_left(&viewer_id);
            }
        }
        println!("[nearsec-router] Viewer {} disconnected from {}", viewer_id, peer);
    }
}

// ── EXPERIMENTAL WEBTRANSPORT IMPLEMENTATION STUB ─────────────────────────────
async fn run_webtransport_server(_state: Arc<RwLock<RouterState>>) {
    /*
    use wtransport::endpoint::endpoint_builder::ServerEndpointBuilder;
    use wtransport::tls::Certificate;

    let cert_path = env::var("WT_CERT_PATH").unwrap_or_default();
    let key_path  = env::var("WT_KEY_PATH").unwrap_or_default();

    if cert_path.is_empty() || key_path.is_empty() {
        println!("[nearsec-router] WT_CERT_PATH or WT_KEY_PATH not set. WebTransport (QUIC) is DISABLED.");
        return;
    }

    let cert = match Certificate::load(&cert_path, &key_path).await {
        Ok(c) => c,
        Err(e) => {
            println!("[nearsec-router] Failed to load TLS certificates for WebTransport: {}", e);
            return;
        }
    };

    let endpoint = match ServerEndpointBuilder::new(cert)
        .bind("0.0.0.0:4433")
        .build() {
            Ok(ep) => ep,
            Err(e) => {
                println!("[nearsec-router] Failed to bind WebTransport UDP port 4433: {}", e);
                return;
            }
        };

    println!("[nearsec-router] WebTransport (QUIC/H3) listening on udp://0.0.0.0:4433");

    while let Some(incoming) = endpoint.accept().await {
        tokio::spawn(async move {
            let session = match incoming.await {
                Ok(s) => s,
                Err(_) => return,
            };
            println!("[nearsec-router] WebTransport session established!");
            
            // Loop for Unreliable Datagrams (Inputs & Video Frames)
            loop {
                match session.receive_datagram().await {
                    Ok(datagram) => {
                        // Decode raw binary chunks and route directly to active_viewers / host_tx
                        // completely bypassing Head-of-Line blocking.
                    }
                    Err(e) => {
                        println!("[nearsec-router] WebTransport datagram error: {}", e);
                        break;
                    }
                }
            }
        });
    }
    */
}
