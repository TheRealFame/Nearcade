use evdev::uinput::{VirtualDevice, VirtualDeviceBuilder};
use evdev::{AttributeSet, BusType, InputId, Key, RelativeAxisType, AbsoluteAxisType, AbsoluteAxisSetup, UinputAbsSetup};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, Write};
use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
    profile: Option<String>,
    // Gamepad fields
    buttons: Option<Value>,
    axes: Option<Value>,
    lx: Option<f64>,
    ly: Option<f64>,
    rx: Option<f64>,
    ry: Option<f64>,
    lt: Option<f64>,
    rt: Option<f64>,
}

fn emit(msg: OutMessage) {
    let json = serde_json::to_string(&msg).unwrap();
    println!("{}", json);
    io::stdout().flush().unwrap();
}

fn log(msg: &str) {
    emit(OutMessage::Log { message: msg.to_string() });
}

struct AppState {
    devices: HashMap<String, VirtualDevice>,
    devices_by_slot: HashMap<u8, String>,
    viewer_modes: HashMap<String, String>,
    viewer_ctrl_type: HashMap<String, String>,
}

fn make_gamepad(profile: &str) -> Option<VirtualDevice> {
    let mut keys = AttributeSet::<Key>::new();
    keys.insert(Key::BTN_SOUTH);
    keys.insert(Key::BTN_EAST);
    keys.insert(Key::BTN_NORTH);
    keys.insert(Key::BTN_WEST);
    keys.insert(Key::BTN_TL);
    keys.insert(Key::BTN_TR);
    keys.insert(Key::BTN_TL2);
    keys.insert(Key::BTN_TR2);
    keys.insert(Key::BTN_SELECT);
    keys.insert(Key::BTN_START);
    keys.insert(Key::BTN_MODE);
    keys.insert(Key::BTN_THUMBL);
    keys.insert(Key::BTN_THUMBR);
    keys.insert(Key::BTN_DPAD_UP);
    keys.insert(Key::BTN_DPAD_DOWN);
    keys.insert(Key::BTN_DPAD_LEFT);
    keys.insert(Key::BTN_DPAD_RIGHT);

    let mut abs = AttributeSet::<AbsoluteAxisType>::new();
    abs.insert(AbsoluteAxisType::ABS_X);
    abs.insert(AbsoluteAxisType::ABS_Y);
    abs.insert(AbsoluteAxisType::ABS_RX);
    abs.insert(AbsoluteAxisType::ABS_RY);
    abs.insert(AbsoluteAxisType::ABS_Z);
    abs.insert(AbsoluteAxisType::ABS_RZ);
    abs.insert(AbsoluteAxisType::ABS_HAT0X);
    abs.insert(AbsoluteAxisType::ABS_HAT0Y);

    // Setup standard limits matching Xbox360 profiles
    let abs_setup_sticks = AbsoluteAxisSetup::new(AbsoluteAxisType::ABS_X, -32767, 32767, 16, 128);
    
    let builder = VirtualDeviceBuilder::new()
        .unwrap()
        .name(if profile == "ds4" { "Wireless Controller" } else { "Xbox 360 Controller" })
        .input_id(InputId::new(BusType::BUS_USB, 0x045E, 0x028E, 0x0110))
        .with_keys(&keys).unwrap()
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisSetup::new(AbsoluteAxisType::ABS_X, -32767, 32767, 16, 128))).unwrap()
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisSetup::new(AbsoluteAxisType::ABS_Y, -32767, 32767, 16, 128))).unwrap()
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisSetup::new(AbsoluteAxisType::ABS_RX, -32767, 32767, 16, 128))).unwrap()
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisSetup::new(AbsoluteAxisType::ABS_RY, -32767, 32767, 16, 128))).unwrap()
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisSetup::new(AbsoluteAxisType::ABS_Z, 0, 255, 0, 0))).unwrap()
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisSetup::new(AbsoluteAxisType::ABS_RZ, 0, 255, 0, 0))).unwrap()
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisSetup::new(AbsoluteAxisType::ABS_HAT0X, -1, 1, 0, 0))).unwrap()
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisSetup::new(AbsoluteAxisType::ABS_HAT0Y, -1, 1, 0, 0))).unwrap();

    builder.build().ok()
}

fn main() {
    log("Loaded rust_uinput backend (gamepad mapping live)");

    let udp_sock = UdpSocket::bind("127.0.0.1:0").unwrap();
    let udp_port = udp_sock.local_addr().unwrap().port();
    emit(OutMessage::UdpReady { udp_port });

    let state = Arc::new(Mutex::new(AppState {
        devices: HashMap::new(),
        devices_by_slot: HashMap::new(),
        viewer_modes: HashMap::new(),
        viewer_ctrl_type: HashMap::new(),
    }));

    let udp_state = state.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            if let Ok((size, _)) = udp_sock.recv_from(&mut buf) {
                if size == 16 && buf[0] == 0x01 {
                    handle_binary_payload(buf[15], &buf[0..16], &udp_state);
                }
            }
        }
    });

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        if let Ok(l) = line {
            if l.trim().is_empty() { continue; }
            if let Ok(msg) = serde_json::from_str::<InMessage>(&l) {
                handle_json_message(msg, &state);
            }
        }
    }
}

fn handle_binary_payload(slot: u8, payload: &[u8], state_mux: &Arc<Mutex<AppState>>) {
    let mut st = state_mux.lock().unwrap();
    let pad_id = match st.devices_by_slot.get(&slot) {
        Some(id) => id.clone(),
        None => return,
    };
    if let Some(target) = st.devices.get_mut(&pad_id) {
        // Binary unpacking matching struct.unpack('<BhhhhBBHbbB', payload)
        let lx = i16::from_le_bytes([payload[1], payload[2]]);
        let ly = i16::from_le_bytes([payload[3], payload[4]]);
        let rx = i16::from_le_bytes([payload[5], payload[6]]);
        let ry = i16::from_le_bytes([payload[7], payload[8]]);
        let lt = payload[9];
        let rt = payload[10];
        let cpp_btns = u16::from_le_bytes([payload[11], payload[12]]);
        let hx = payload[13] as i32;
        let hy = payload[14] as i32;

        let events = [
            evdev::InputEvent::new(evdev::EventType::KEY, Key::BTN_SOUTH.code(), if (cpp_btns & (1 << 0)) != 0 { 1 } else { 0 }),
            evdev::InputEvent::new(evdev::EventType::KEY, Key::BTN_EAST.code(), if (cpp_btns & (1 << 1)) != 0 { 1 } else { 0 }),
            evdev::InputEvent::new(evdev::EventType::KEY, Key::BTN_NORTH.code(), if (cpp_btns & (1 << 2)) != 0 { 1 } else { 0 }),
            evdev::InputEvent::new(evdev::EventType::KEY, Key::BTN_WEST.code(), if (cpp_btns & (1 << 3)) != 0 { 1 } else { 0 }),
            evdev::InputEvent::new(evdev::EventType::KEY, Key::BTN_TL.code(), if (cpp_btns & (1 << 4)) != 0 { 1 } else { 0 }),
            evdev::InputEvent::new(evdev::EventType::KEY, Key::BTN_TR.code(), if (cpp_btns & (1 << 5)) != 0 { 1 } else { 0 }),
            evdev::InputEvent::new(evdev::EventType::KEY, Key::BTN_SELECT.code(), if (cpp_btns & (1 << 8)) != 0 { 1 } else { 0 }),
            evdev::InputEvent::new(evdev::EventType::KEY, Key::BTN_START.code(), if (cpp_btns & (1 << 9)) != 0 { 1 } else { 0 }),
            evdev::InputEvent::new(evdev::EventType::KEY, Key::BTN_THUMBL.code(), if (cpp_btns & (1 << 10)) != 0 { 1 } else { 0 }),
            evdev::InputEvent::new(evdev::EventType::KEY, Key::BTN_THUMBR.code(), if (cpp_btns & (1 << 11)) != 0 { 1 } else { 0 }),
            
            evdev::InputEvent::new(evdev::EventType::ABSOLUTE, AbsoluteAxisType::ABS_X.0, lx as i32),
            evdev::InputEvent::new(evdev::EventType::ABSOLUTE, AbsoluteAxisType::ABS_Y.0, ly as i32),
            evdev::InputEvent::new(evdev::EventType::ABSOLUTE, AbsoluteAxisType::ABS_RX.0, rx as i32),
            evdev::InputEvent::new(evdev::EventType::ABSOLUTE, AbsoluteAxisType::ABS_RY.0, ry as i32),
            evdev::InputEvent::new(evdev::EventType::ABSOLUTE, AbsoluteAxisType::ABS_Z.0, lt as i32),
            evdev::InputEvent::new(evdev::EventType::ABSOLUTE, AbsoluteAxisType::ABS_RZ.0, rt as i32),
            evdev::InputEvent::new(evdev::EventType::ABSOLUTE, AbsoluteAxisType::ABS_HAT0X.0, hx),
            evdev::InputEvent::new(evdev::EventType::ABSOLUTE, AbsoluteAxisType::ABS_HAT0Y.0, hy),
        ];

        let _ = target.emit(&events);
    }
}

fn handle_json_message(msg: InMessage, state_mux: &Arc<Mutex<AppState>>) {
    let mut st = state_mux.lock().unwrap();
    let vid = msg.viewer_id.clone().or(msg.viewerId.clone()).unwrap_or_default();
    
    match msg.msg_type.as_str() {
        "allocate_slot" => {
            if let (Some(pad), Some(slot)) = (msg.pad_id, msg.slot) {
                if !st.devices.contains_key(&pad) {
                    let profile = msg.profile.unwrap_or_else(|| "xbox360".to_string());
                    if let Some(dev) = make_gamepad(&profile) {
                        st.devices.insert(pad.clone(), dev);
                        st.viewer_ctrl_type.insert(pad.clone(), profile);
                        log(&format!("Created gamepad slot: {}", pad));
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
                st.devices.remove(&k);
            }
            if msg.msg_type == "destroy_all" {
                st.devices.clear();
            }
        },
        _ => {}
    }
}
