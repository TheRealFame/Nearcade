use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use vigem_client::{Client, TargetId, Xbox360Wired};
use enigo::{Enigo, Keyboard, Mouse, Coordinate};

#[derive(Serialize)]
#[serde(tag = "type")]
enum OutMessage {
    #[serde(rename = "ready")]
    Ready { message: String },
    #[serde(rename = "log")]
    Log { message: String },
    #[serde(rename = "error")]
    Error { message: String, code: String },
    #[serde(rename = "udp_ready")]
    UdpReady { udp_port: u16 },
}

#[derive(Deserialize, Debug)]
struct InMessage {
    #[serde(rename = "type")]
    msg_type: String,
    viewer_id: Option<String>,
    viewerId: Option<String>,
    mode: Option<String>,
    pad_id: Option<String>,
    slot: Option<u8>,
    key: Option<String>,
    event: Option<String>,
    dx: Option<f64>,
    dy: Option<f64>,
}

fn emit(msg: OutMessage) {
    let json = serde_json::to_string(&msg).unwrap();
    println!("{}", json);
    io::stdout().flush().unwrap();
}

fn log(msg: &str) {
    emit(OutMessage::Log { message: msg.to_string() });
}

fn error(msg: &str, code: &str) {
    emit(OutMessage::Error { message: msg.to_string(), code: code.to_string() });
}

fn main() {
    // Initialize ViGEm Client
    let client = match Client::connect() {
        Ok(c) => c,
        Err(e) => {
            error(&format!("ViGEmBus driver error: {}. Install ViGEmBus: https://github.com/nefarius/ViGEmBus/releases", e), "VIGEMBUS_MISSING");
            std::process::exit(1);
        }
    };
    
    emit(OutMessage::Ready { message: "Windows Rust vigem-client + enigo backend initialized".to_string() });
    
    // Set up UDP socket for binary packets
    let udp_sock = match UdpSocket::bind("127.0.0.1:0") {
        Ok(s) => s,
        Err(e) => {
            error(&format!("Failed to bind UDP socket: {}", e), "UDP_ERROR");
            std::process::exit(1);
        }
    };
    
    let udp_port = udp_sock.local_addr().unwrap().port();
    emit(OutMessage::UdpReady { udp_port });
    
    let state = Arc::new(Mutex::new(AppState {
        client,
        devices: HashMap::new(),
        devices_by_slot: HashMap::new(),
        viewer_modes: HashMap::new(),
        enigo: Enigo::new(&enigo::Settings::default()).unwrap(),
    }));
    
    // Start UDP thread
    let udp_state = state.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            if let Ok((size, _)) = udp_sock.recv_from(&mut buf) {
                if size == 16 && buf[0] == 0x01 {
                    let slot = buf[15];
                    handle_binary_payload(slot, &buf[0..16], &udp_state);
                }
            }
        }
    });
    
    // Process Stdin loop
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        if let Ok(l) = line {
            if l.trim().is_empty() { continue; }
            match serde_json::from_str::<InMessage>(&l) {
                Ok(msg) => handle_json_message(msg, &state),
                Err(e) => {
                    // Ignore decode errors
                }
            }
        }
    }
}

struct AppState {
    client: Client,
    devices: HashMap<String, vigem_client::Xbox360Wired<Client>>,
    devices_by_slot: HashMap<u8, String>, // map slot to pad_id
    viewer_modes: HashMap<String, String>,
    enigo: Enigo,
}

fn handle_binary_payload(slot: u8, payload: &[u8], state_mux: &Arc<Mutex<AppState>>) {
    let mut st = state_mux.lock().unwrap();
    
    let pad_id = match st.devices_by_slot.get(&slot) {
        Some(id) => id.clone(),
        None => return,
    };
    
    let target = match st.devices.get_mut(&pad_id) {
        Some(t) => t,
        None => return,
    };
    
    // Magic: 0 (1 byte)
    // lx: 1..3
    // ly: 3..5
    // rx: 5..7
    // ry: 7..9
    // lt: 9
    // rt: 10
    // cppBtns: 11..13
    // hx: 13
    // hy: 14
    
    let lx = i16::from_le_bytes([payload[1], payload[2]]);
    let ly = i16::from_le_bytes([payload[3], payload[4]]);
    let rx = i16::from_le_bytes([payload[5], payload[6]]);
    let ry = i16::from_le_bytes([payload[7], payload[8]]);
    let lt = payload[9];
    let rt = payload[10];
    let cpp_btns = u16::from_le_bytes([payload[11], payload[12]]);
    let hx = payload[13] as i8;
    let hy = payload[14] as i8;
    
    let mut gamepad = vigem_client::XGamepad {
        thumb_lx: lx,
        thumb_ly: -ly,
        thumb_rx: rx,
        thumb_ry: -ry,
        left_trigger: lt,
        right_trigger: rt,
        buttons: vigem_client::XButtons!(
            UP: hy == -1,
            DOWN: hy == 1,
            LEFT: hx == -1,
            RIGHT: hx == 1,
            START: (cpp_btns & (1 << 9)) != 0,
            BACK: (cpp_btns & (1 << 8)) != 0,
            LEFT_THUMB: (cpp_btns & (1 << 10)) != 0,
            RIGHT_THUMB: (cpp_btns & (1 << 11)) != 0,
            LEFT_SHOULDER: (cpp_btns & (1 << 4)) != 0,
            RIGHT_SHOULDER: (cpp_btns & (1 << 5)) != 0,
            A: (cpp_btns & (1 << 0)) != 0,
            B: (cpp_btns & (1 << 1)) != 0,
            X: (cpp_btns & (1 << 2)) != 0,
            Y: (cpp_btns & (1 << 3)) != 0
        )
    };
    
    let _ = target.request_update(gamepad);
}

fn handle_json_message(msg: InMessage, state_mux: &Arc<Mutex<AppState>>) {
    let mut st = state_mux.lock().unwrap();
    let vid = msg.viewer_id.or(msg.viewerId).unwrap_or_default();
    
    match msg.msg_type.as_str() {
        "set-input-mode" => {
            if let Some(m) = msg.mode {
                st.viewer_modes.insert(vid, m);
            }
        },
        "allocate_slot" => {
            if let (Some(pad), Some(slot)) = (msg.pad_id, msg.slot) {
                if !st.devices.contains_key(&pad) {
                    let mut target = Xbox360Wired::new(st.client.clone(), TargetId::XBOX360_WIRED);
                    match target.plugin() {
                        Ok(_) => {
                            st.devices.insert(pad.clone(), target);
                            log(&format!("Created virtual gamepad for slot: {}", pad));
                        }
                        Err(e) => {
                            error(&format!("Failed to create gamepad: {}", e), "VIGEMBUS_CREATE_FAILED");
                            return;
                        }
                    }
                }
                st.devices_by_slot.insert(slot, pad);
            }
        },
        "free_slot" => {
            if let Some(slot) = msg.slot {
                st.devices_by_slot.remove(&slot);
            }
        },
        "flush_neutral" | "disconnect_viewer" | "destroy_all" => {
            let keys: Vec<String> = st.devices.keys().filter(|k| k.starts_with(&vid) || **k == vid).cloned().collect();
            for k in keys {
                if let Some(mut t) = st.devices.remove(&k) {
                    let _ = t.request_update(vigem_client::XGamepad::default());
                    let _ = t.unplug();
                }
            }
            if msg.msg_type == "destroy_all" {
                st.devices.clear();
            }
        },
        "kbm" | "keyboard" => {
            // handle KBM injection with Enigo
            let mode = st.viewer_modes.get(&vid).map(|s| s.as_str()).unwrap_or("gamepad");
            if mode != "kbm" && mode != "hybrid" && mode != "kbm_emulated" { return; }
            
            if msg.event.as_deref() == Some("mousemove") {
                if let (Some(dx), Some(dy)) = (msg.dx, msg.dy) {
                    st.enigo.move_mouse(dx as i32, dy as i32, Coordinate::Rel).unwrap();
                }
            }
            // For full keystroke mappings we would need enigo mapping (similarly implemented)
        }
        _ => {}
    }
}
