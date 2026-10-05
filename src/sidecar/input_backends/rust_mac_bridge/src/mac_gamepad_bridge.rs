use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use enigo::{Enigo, Keyboard, Mouse, Coordinate, Key as EnigoKey, Button as EnigoButton, Settings};

const DEADZONE: f64 = 0.1;
const MOUSE_SPEED_MULTIPLIER: f64 = 3.0;
const MOUSE_SENSITIVITY: f64 = 2000.0;

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
}

struct AppState {
    enigo: Enigo,
    keys_held: HashSet<EnigoKey>,
    mouse_held: HashSet<EnigoButton>,
    last_update_time: Instant,
}

fn emit(msg: OutMessage) {
    let json = serde_json::to_string(&msg).unwrap();
    println!("{}", json);
    io::stdout().flush().unwrap();
}

fn log(msg: &str) {
    emit(OutMessage::Log { message: msg.to_string() });
}

fn clamp(val: f64, min_val: f64, max_val: f64) -> f64 {
    val.max(min_val).min(max_val)
}

fn apply_deadzone(value: f64) -> f64 {
    if value.abs() < DEADZONE { 0.0 } else { value }
}

fn map_w3c_to_enigo(btn_idx: u8) -> Option<EnigoKey> {
    match btn_idx {
        0 => Some(EnigoKey::Space),
        1 => Some(EnigoKey::Escape),
        2 => Some(EnigoKey::Unicode('r')),
        3 => Some(EnigoKey::Unicode('e')),
        4 => Some(EnigoKey::Shift),
        5 => Some(EnigoKey::Meta),
        8 => Some(EnigoKey::Tab),
        9 => Some(EnigoKey::Return),
        10 => Some(EnigoKey::Unicode('z')),
        11 => Some(EnigoKey::Unicode('c')),
        _ => None,
    }
}

fn apply_key(state: &mut AppState, key: EnigoKey, pressed: bool) {
    if pressed {
        if !state.keys_held.contains(&key) {
            let _ = state.enigo.key(key, enigo::Direction::Press);
            state.keys_held.insert(key);
        }
    } else {
        if state.keys_held.contains(&key) {
            let _ = state.enigo.key(key, enigo::Direction::Release);
            state.keys_held.remove(&key);
        }
    }
}

fn apply_mouse_btn(state: &mut AppState, btn: EnigoButton, pressed: bool) {
    if pressed {
        if !state.mouse_held.contains(&btn) {
            let _ = state.enigo.button(btn, enigo::Direction::Press);
            state.mouse_held.insert(btn);
        }
    } else {
        if state.mouse_held.contains(&btn) {
            let _ = state.enigo.button(btn, enigo::Direction::Release);
            state.mouse_held.remove(&btn);
        }
    }
}

fn handle_binary_payload(payload: &[u8], state_mux: &Arc<Mutex<AppState>>) {
    let mut st = state_mux.lock().unwrap();
    let lx = i16::from_le_bytes([payload[1], payload[2]]);
    let ly = i16::from_le_bytes([payload[3], payload[4]]);
    let rx = i16::from_le_bytes([payload[5], payload[6]]);
    let ry = i16::from_le_bytes([payload[7], payload[8]]);
    let lt = payload[9];
    let rt = payload[10];
    let cpp_btns = u16::from_le_bytes([payload[11], payload[12]]);

    // Buttons
    for i in 0..12 {
        if let Some(key) = map_w3c_to_enigo(i) {
            apply_key(&mut st, key, (cpp_btns & (1 << i)) != 0);
        }
    }

    // Left Stick (WASD)
    let lxf = apply_deadzone(clamp(lx as f64 / 32767.0, -1.0, 1.0));
    let lyf = apply_deadzone(clamp(ly as f64 / 32767.0, -1.0, 1.0));
    apply_key(&mut st, EnigoKey::Unicode('w'), lyf < -DEADZONE);
    apply_key(&mut st, EnigoKey::Unicode('s'), lyf > DEADZONE);
    apply_key(&mut st, EnigoKey::Unicode('a'), lxf < -DEADZONE);
    apply_key(&mut st, EnigoKey::Unicode('d'), lxf > DEADZONE);

    // Triggers (Mouse clicks)
    apply_mouse_btn(&mut st, EnigoButton::Left, (lt as f64 / 255.0) > 0.5);
    apply_mouse_btn(&mut st, EnigoButton::Right, (rt as f64 / 255.0) > 0.5);

    // Right Stick (Mouse Move)
    let rxf = apply_deadzone(clamp(rx as f64 / 32767.0, -1.0, 1.0));
    let ryf = apply_deadzone(clamp(ry as f64 / 32767.0, -1.0, 1.0));
    let now = Instant::now();
    let dt = now.duration_since(st.last_update_time).as_secs_f64();
    if dt > 0.001 {
        let mx = (rxf * MOUSE_SENSITIVITY * dt * MOUSE_SPEED_MULTIPLIER) as i32;
        let my = (ryf * MOUSE_SENSITIVITY * dt * MOUSE_SPEED_MULTIPLIER) as i32;
        if mx != 0 || my != 0 {
            let _ = st.enigo.move_mouse(mx, my, Coordinate::Rel);
        }
        st.last_update_time = now;
    }
}

fn main() {
    log("Loaded macOS rust_mac_bridge (Gamepad-to-KBM proxy)");
    let udp_sock = UdpSocket::bind("127.0.0.1:0").unwrap();
    let udp_port = udp_sock.local_addr().unwrap().port();
    emit(OutMessage::UdpReady { udp_port });

    let state = Arc::new(Mutex::new(AppState {
        enigo: Enigo::new(&Settings::default()).unwrap(),
        keys_held: HashSet::new(),
        mouse_held: HashSet::new(),
        last_update_time: Instant::now(),
    }));

    let udp_state = state.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            if let Ok((size, _)) = udp_sock.recv_from(&mut buf) {
                if size == 16 && buf[0] == 0x01 {
                    handle_binary_payload(&buf[0..16], &udp_state);
                }
            }
        }
    });

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        if let Ok(l) = line {
            if l.trim().is_empty() { continue; }
            if let Ok(msg) = serde_json::from_str::<InMessage>(&l) {
                if msg.msg_type == "destroy_all" || msg.msg_type == "disconnect_viewer" {
                    let mut st = state.lock().unwrap();
                    let held_keys: Vec<_> = st.keys_held.iter().cloned().collect();
                    for k in held_keys {
                        let _ = st.enigo.key(k, enigo::Direction::Release);
                    }
                    st.keys_held.clear();
                    
                    let held_btns: Vec<_> = st.mouse_held.iter().cloned().collect();
                    for b in held_btns {
                        let _ = st.enigo.button(b, enigo::Direction::Release);
                    }
                    st.mouse_held.clear();
                }
            }
        }
    }
}
