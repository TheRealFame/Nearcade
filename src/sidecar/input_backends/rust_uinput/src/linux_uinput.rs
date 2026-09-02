/// linux_uinput — Nearcade Linux Input Backend (Rust, evdev 0.13.x)
///
/// Replaces linux_uinput.py. Creates virtual evdev devices via /dev/uinput.
/// Runs as a child process of InputOrchestrator.js — communicates over stdin/stdout JSON lines
/// and UDP binary packets for low-latency gamepad state.
///
/// Protocol:
///   IN  JSON (stdin):  allocate_slot | set-input-mode | kbm | flush_neutral | disconnect_viewer | destroy_all
///   IN  UDP  (binary): 16-byte gamepad packet (magic=0x01, lx,ly,rx,ry i16le, lt,rt u8, btns u16le, hx,hy i8, slot u8)
///   OUT JSON (stdout): ready | log | error | udp_ready
///
/// AGENTS.md critical rules enforced here:
///   - Multi-controller isolation: each pad_id gets its own VirtualDevice (never share)
///   - Key-repeat prevention: repeated keydown events for already-held keys are dropped
///   - pkexec escalation: attempted when /dev/uinput is not accessible
use evdev::uinput::VirtualDevice;
use evdev::{AbsInfo, AbsoluteAxisCode, AttributeSet, BusType, InputId, KeyCode, RelativeAxisCode, UinputAbsSetup};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::net::UdpSocket;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

// ─── Wire types ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(tag = "type")]
enum Out {
    #[serde(rename = "ready")]    Ready    { message: String },
    #[serde(rename = "log")]      Log      { message: String },
    #[serde(rename = "error")]    Error    { message: String, code: String },
    #[serde(rename = "udp_ready")] UdpReady { udp_port: u16 },
}

#[derive(Deserialize, Debug)]
#[allow(non_snake_case)]
struct In {
    #[serde(rename = "type")] msg_type: String,
    viewer_id: Option<String>,
    viewerId:  Option<String>,
    mode:      Option<String>,
    pad_id:    Option<String>,
    slot:      Option<u8>,
    profile:   Option<String>,
    // Gamepad fields
    buttons:   Option<Value>,
    axes:      Option<Value>,
    // KBM fields
    event:     Option<String>,
    key:       Option<String>,
    dx:        Option<f64>,
    dy:        Option<f64>,
}

fn emit(msg: Out) { println!("{}", serde_json::to_string(&msg).unwrap()); io::stdout().flush().unwrap(); }
fn log(s: &str)   { emit(Out::Log { message: s.into() }); }

// ─── Privilege check ──────────────────────────────────────────────────────────

fn can_open_uinput() -> bool {
    std::fs::OpenOptions::new().write(true).open("/dev/uinput").is_ok()
}

fn try_pkexec_elevate() -> bool {
    log("Attempting pkexec privilege escalation for /dev/uinput access...");
    match std::env::current_exe().ok().and_then(|exe| Command::new("pkexec").arg(exe).status().ok()) {
        Some(s) if s.success() => true,
        _ => false,
    }
}

// ─── App state ────────────────────────────────────────────────────────────────

struct State {
    /// pad_id → virtual gamepad device
    devices:       HashMap<String, VirtualDevice>,
    /// slot → pad_id (UDP fast-path routing)
    slot_map:      HashMap<u8, String>,
    /// viewer_id → input mode ("gamepad" | "kbm" | "hybrid")
    modes:         HashMap<String, String>,
    /// Shared virtual keyboard+mouse
    kbm:           Option<VirtualDevice>,
    /// KeyCode values of currently-pressed keys (key-repeat prevention)
    held_keys:     HashSet<u16>,
}

// ─── Virtual device builders ──────────────────────────────────────────────────

fn gamepad(profile: &str) -> Option<VirtualDevice> {
    let mut keys = AttributeSet::<KeyCode>::new();
    for kc in [
        KeyCode::BTN_SOUTH, KeyCode::BTN_EAST, KeyCode::BTN_NORTH, KeyCode::BTN_WEST,
        KeyCode::BTN_TL,    KeyCode::BTN_TR,    KeyCode::BTN_TL2,  KeyCode::BTN_TR2,
        KeyCode::BTN_SELECT, KeyCode::BTN_START, KeyCode::BTN_MODE,
        KeyCode::BTN_THUMBL, KeyCode::BTN_THUMBR,
        KeyCode::BTN_DPAD_UP, KeyCode::BTN_DPAD_DOWN, KeyCode::BTN_DPAD_LEFT, KeyCode::BTN_DPAD_RIGHT,
    ] { keys.insert(kc); }

    let s = |v, mn, mx| AbsInfo::new(v, mn, mx, 16, 128, 0);
    let t = |v, mn, mx| AbsInfo::new(v, mn, mx, 0,  0,   0);

    let name = if profile == "ds4" { "Wireless Controller" } else { "Xbox 360 Controller" };
    VirtualDevice::builder().ok()?
        .name(name)
        .input_id(InputId::new(BusType::BUS_USB, 0x045E, 0x028E, 0x110))
        .with_keys(&keys).ok()?
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisCode::ABS_X,     s(0,-32767,32767))).ok()?
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisCode::ABS_Y,     s(0,-32767,32767))).ok()?
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisCode::ABS_RX,    s(0,-32767,32767))).ok()?
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisCode::ABS_RY,    s(0,-32767,32767))).ok()?
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisCode::ABS_Z,     t(0,0,255))).ok()?
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisCode::ABS_RZ,    t(0,0,255))).ok()?
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisCode::ABS_HAT0X, t(0,-1,1))).ok()?
        .with_absolute_axis(&UinputAbsSetup::new(AbsoluteAxisCode::ABS_HAT0Y, t(0,-1,1))).ok()?
        .build().ok()
}

fn kbm_device() -> Option<VirtualDevice> {
    let mut keys = AttributeSet::<KeyCode>::new();
    // KEY_ESC(1)..KEY_MICMUTE(248) full keyboard range
    for code in 1u16..=248 { keys.insert(KeyCode(code)); }
    // Mouse buttons
    keys.insert(KeyCode::BTN_LEFT);
    keys.insert(KeyCode::BTN_RIGHT);
    keys.insert(KeyCode::BTN_MIDDLE);

    let mut rel = AttributeSet::<RelativeAxisCode>::new();
    rel.insert(RelativeAxisCode::REL_X);
    rel.insert(RelativeAxisCode::REL_Y);
    rel.insert(RelativeAxisCode::REL_WHEEL);

    VirtualDevice::builder().ok()?
        .name("ORP Virtual KBM")
        .input_id(InputId::new(BusType::BUS_USB, 0x1234, 0x5678, 0x100))
        .with_keys(&keys).ok()?
        .with_relative_axes(&rel).ok()?
        .build().ok()
}

// ─── InputEvent helpers (InputEvent::new takes raw u16 type_, u16 code, i32 value) ──

/// EV_KEY = 1, EV_REL = 2, EV_ABS = 3, EV_SYN = 0
const EV_KEY: u16 = 1;
const EV_REL: u16 = 2;
const EV_ABS: u16 = 3;

fn key_evt(code: u16, val: i32) -> evdev::InputEvent { evdev::InputEvent::new(EV_KEY, code, val) }
fn abs_evt(code: u16, val: i32) -> evdev::InputEvent { evdev::InputEvent::new(EV_ABS, code, val) }
fn rel_evt(code: u16, val: i32) -> evdev::InputEvent { evdev::InputEvent::new(EV_REL, code, val) }

// ─── Key name → KeyCode ───────────────────────────────────────────────────────

fn key_from_name(name: &str) -> Option<KeyCode> {
    match name {
        "BTN_LEFT"        => Some(KeyCode::BTN_LEFT),
        "BTN_RIGHT"       => Some(KeyCode::BTN_RIGHT),
        "BTN_MIDDLE"      => Some(KeyCode::BTN_MIDDLE),
        "KEY_ESC"         => Some(KeyCode::KEY_ESC),
        "KEY_ENTER"       => Some(KeyCode::KEY_ENTER),
        "KEY_SPACE"       => Some(KeyCode::KEY_SPACE),
        "KEY_BACKSPACE"   => Some(KeyCode::KEY_BACKSPACE),
        "KEY_TAB"         => Some(KeyCode::KEY_TAB),
        "KEY_LEFTSHIFT" | "KEY_SHIFT" => Some(KeyCode::KEY_LEFTSHIFT),
        "KEY_RIGHTSHIFT"  => Some(KeyCode::KEY_RIGHTSHIFT),
        "KEY_LEFTCTRL" | "KEY_CTRL"   => Some(KeyCode::KEY_LEFTCTRL),
        "KEY_RIGHTCTRL"   => Some(KeyCode::KEY_RIGHTCTRL),
        "KEY_LEFTALT" | "KEY_ALT"     => Some(KeyCode::KEY_LEFTALT),
        "KEY_RIGHTALT"    => Some(KeyCode::KEY_RIGHTALT),
        "KEY_UP"          => Some(KeyCode::KEY_UP),
        "KEY_DOWN"        => Some(KeyCode::KEY_DOWN),
        "KEY_LEFT"        => Some(KeyCode::KEY_LEFT),
        "KEY_RIGHT"       => Some(KeyCode::KEY_RIGHT),
        "KEY_A" => Some(KeyCode::KEY_A), "KEY_B" => Some(KeyCode::KEY_B),
        "KEY_C" => Some(KeyCode::KEY_C), "KEY_D" => Some(KeyCode::KEY_D),
        "KEY_E" => Some(KeyCode::KEY_E), "KEY_F" => Some(KeyCode::KEY_F),
        "KEY_G" => Some(KeyCode::KEY_G), "KEY_H" => Some(KeyCode::KEY_H),
        "KEY_I" => Some(KeyCode::KEY_I), "KEY_J" => Some(KeyCode::KEY_J),
        "KEY_K" => Some(KeyCode::KEY_K), "KEY_L" => Some(KeyCode::KEY_L),
        "KEY_M" => Some(KeyCode::KEY_M), "KEY_N" => Some(KeyCode::KEY_N),
        "KEY_O" => Some(KeyCode::KEY_O), "KEY_P" => Some(KeyCode::KEY_P),
        "KEY_Q" => Some(KeyCode::KEY_Q), "KEY_R" => Some(KeyCode::KEY_R),
        "KEY_S" => Some(KeyCode::KEY_S), "KEY_T" => Some(KeyCode::KEY_T),
        "KEY_U" => Some(KeyCode::KEY_U), "KEY_V" => Some(KeyCode::KEY_V),
        "KEY_W" => Some(KeyCode::KEY_W), "KEY_X" => Some(KeyCode::KEY_X),
        "KEY_Y" => Some(KeyCode::KEY_Y), "KEY_Z" => Some(KeyCode::KEY_Z),
        "KEY_1" => Some(KeyCode::KEY_1), "KEY_2" => Some(KeyCode::KEY_2),
        "KEY_3" => Some(KeyCode::KEY_3), "KEY_4" => Some(KeyCode::KEY_4),
        "KEY_5" => Some(KeyCode::KEY_5), "KEY_6" => Some(KeyCode::KEY_6),
        "KEY_7" => Some(KeyCode::KEY_7), "KEY_8" => Some(KeyCode::KEY_8),
        "KEY_9" => Some(KeyCode::KEY_9), "KEY_0" => Some(KeyCode::KEY_0),
        "KEY_F1"  => Some(KeyCode::KEY_F1),  "KEY_F2"  => Some(KeyCode::KEY_F2),
        "KEY_F3"  => Some(KeyCode::KEY_F3),  "KEY_F4"  => Some(KeyCode::KEY_F4),
        "KEY_F5"  => Some(KeyCode::KEY_F5),  "KEY_F6"  => Some(KeyCode::KEY_F6),
        "KEY_F7"  => Some(KeyCode::KEY_F7),  "KEY_F8"  => Some(KeyCode::KEY_F8),
        "KEY_F9"  => Some(KeyCode::KEY_F9),  "KEY_F10" => Some(KeyCode::KEY_F10),
        "KEY_F11" => Some(KeyCode::KEY_F11), "KEY_F12" => Some(KeyCode::KEY_F12),
        _ => None,
    }
}

// ─── UDP binary packet handler (fast-path gamepad state) ─────────────────────

fn handle_udp(payload: &[u8], st: &Arc<Mutex<State>>) {
    if payload.len() < 16 || payload[0] != 0x01 { return; }
    let slot = payload[15];
    let mut g = st.lock().unwrap();
    let pad_id = match g.slot_map.get(&slot) { Some(id) => id.clone(), None => return };
    let dev = match g.devices.get_mut(&pad_id) { Some(d) => d, None => return };

    let lx = i16::from_le_bytes([payload[1], payload[2]]);
    let ly = i16::from_le_bytes([payload[3], payload[4]]);
    let rx = i16::from_le_bytes([payload[5], payload[6]]);
    let ry = i16::from_le_bytes([payload[7], payload[8]]);
    let lt = payload[9] as i32;
    let rt = payload[10] as i32;
    let btns = u16::from_le_bytes([payload[11], payload[12]]);
    let hx   = payload[13] as i8 as i32;
    let hy   = payload[14] as i8 as i32;

    macro_rules! btn { ($mask:expr, $code:expr) => { key_evt($code.0, if btns & $mask != 0 { 1 } else { 0 }) }; }

    let _ = dev.emit(&[
        btn!(1<<0,  KeyCode::BTN_SOUTH),
        btn!(1<<1,  KeyCode::BTN_EAST),
        btn!(1<<2,  KeyCode::BTN_NORTH),
        btn!(1<<3,  KeyCode::BTN_WEST),
        btn!(1<<4,  KeyCode::BTN_TL),
        btn!(1<<5,  KeyCode::BTN_TR),
        btn!(1<<8,  KeyCode::BTN_SELECT),
        btn!(1<<9,  KeyCode::BTN_START),
        btn!(1<<10, KeyCode::BTN_THUMBL),
        btn!(1<<11, KeyCode::BTN_THUMBR),
        abs_evt(AbsoluteAxisCode::ABS_X.0,     lx as i32),
        abs_evt(AbsoluteAxisCode::ABS_Y.0,     ly as i32),
        abs_evt(AbsoluteAxisCode::ABS_RX.0,    rx as i32),
        abs_evt(AbsoluteAxisCode::ABS_RY.0,    ry as i32),
        abs_evt(AbsoluteAxisCode::ABS_Z.0,     lt),
        abs_evt(AbsoluteAxisCode::ABS_RZ.0,    rt),
        abs_evt(AbsoluteAxisCode::ABS_HAT0X.0, hx),
        abs_evt(AbsoluteAxisCode::ABS_HAT0Y.0, hy),
    ]);
}

// ─── JSON message handler ─────────────────────────────────────────────────────

fn handle_json(msg: In, st: &Arc<Mutex<State>>) {
    let mut g = st.lock().unwrap();
    let vid = msg.viewer_id.or(msg.viewerId).unwrap_or_default();

    match msg.msg_type.as_str() {
        "set-input-mode" => {
            if let Some(m) = msg.mode { g.modes.insert(vid, m); }
        }

        "allocate_slot" => {
            if let (Some(pad), Some(slot)) = (msg.pad_id, msg.slot) {
                if !g.devices.contains_key(&pad) {
                    let profile = msg.profile.unwrap_or_else(|| "xbox360".into());
                    match gamepad(&profile) {
                        Some(dev) => { g.devices.insert(pad.clone(), dev); log(&format!("Created gamepad slot {slot}: {pad}")); }
                        None      => { emit(Out::Error { message: format!("Failed to create uinput gamepad (slot {slot})"), code: "UINPUT_CREATE_FAILED".into() }); return; }
                    }
                }
                g.slot_map.insert(slot, pad);
            }
        }

        "free_slot" => { if let Some(s) = msg.slot { g.slot_map.remove(&s); } }

        "kbm" | "keyboard" => {
            let mode = g.modes.get(&vid).cloned().unwrap_or_else(|| "gamepad".into());
            if !matches!(mode.as_str(), "kbm" | "hybrid" | "kbm_emulated") { return; }

            // Lazily create shared KBM device
            if g.kbm.is_none() {
                match kbm_device() {
                    Some(dev) => { g.kbm = Some(dev); log("Created virtual KBM device"); }
                    None      => { emit(Out::Error { message: "Failed to create KBM device".into(), code: "KBM_CREATE_FAILED".into() }); return; }
                }
            }

            let event = msg.event.as_deref().unwrap_or("").to_string();
            let opt_kc = msg.key.as_deref().and_then(key_from_name);
            let dx = msg.dx.unwrap_or(0.0) as i32;
            let dy = msg.dy.unwrap_or(0.0) as i32;

            match event.as_str() {
                "mousemove" => {
                    if dx != 0 || dy != 0 {
                        if let Some(kbm) = g.kbm.as_mut() {
                            let _ = kbm.emit(&[rel_evt(RelativeAxisCode::REL_X.0, dx), rel_evt(RelativeAxisCode::REL_Y.0, dy)]);
                        }
                    }
                }
                "keydown" | "mousedown" => {
                    if let Some(kc) = opt_kc {
                        // AGENTS.md: must completely ignore OS key-repeats
                        let already_held = g.held_keys.contains(&kc.0);
                        if !already_held {
                            g.held_keys.insert(kc.0);
                            if let Some(kbm) = g.kbm.as_mut() {
                                let _ = kbm.emit(&[key_evt(kc.0, 1)]);
                            }
                        }
                    }
                }
                "keyup" | "mouseup" => {
                    if let Some(kc) = opt_kc {
                        g.held_keys.remove(&kc.0);
                        if let Some(kbm) = g.kbm.as_mut() {
                            let _ = kbm.emit(&[key_evt(kc.0, 0)]);
                        }
                    }
                }
                _ => {}
            }
        }

        "flush_neutral" | "disconnect_viewer" => {
            // Remove devices belonging to this viewer
            g.devices.retain(|k, _| !k.starts_with(&vid));
            g.slot_map.retain(|_, v| !v.starts_with(&vid));
            // Release all held keys
            let codes: Vec<u16> = g.held_keys.iter().copied().collect();
            if !codes.is_empty() {
                if let Some(kbm) = g.kbm.as_mut() {
                    let evts: Vec<_> = codes.iter().map(|&c| key_evt(c, 0)).collect();
                    let _ = kbm.emit(&evts);
                }
                g.held_keys.clear();
            }
        }

        "destroy_all" => {
            g.devices.clear();
            g.slot_map.clear();
            let codes: Vec<u16> = g.held_keys.iter().copied().collect();
            if !codes.is_empty() {
                if let Some(kbm) = g.kbm.as_mut() {
                    let evts: Vec<_> = codes.iter().map(|&c| key_evt(c, 0)).collect();
                    let _ = kbm.emit(&evts);
                }
                g.held_keys.clear();
            }
        }

        _ => {}
    }
}

// ─── main ─────────────────────────────────────────────────────────────────────

fn main() {
    if !can_open_uinput() {
        if try_pkexec_elevate() { return; }
        emit(Out::Error {
            message: "Cannot access /dev/uinput. Add user to 'input' group or run with pkexec/sudo.".into(),
            code: "UINPUT_PERMISSION_DENIED".into(),
        });
        std::process::exit(1);
    }

    log("linux_uinput Rust backend loaded (gamepad + KBM, evdev 0.13.x)");

    let sock = UdpSocket::bind("127.0.0.1:0").expect("UDP bind failed");
    let port = sock.local_addr().unwrap().port();
    emit(Out::UdpReady { udp_port: port });

    let state = Arc::new(Mutex::new(State {
        devices: HashMap::new(),
        slot_map: HashMap::new(),
        modes: HashMap::new(),
        kbm: None,
        held_keys: HashSet::new(),
    }));

    // UDP listener thread
    let st2 = state.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            if let Ok((n, _)) = sock.recv_from(&mut buf) {
                if n >= 16 { handle_udp(&buf[..n], &st2); }
            }
        }
    });

    emit(Out::Ready { message: "linux_uinput Rust backend ready".into() });

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        if let Ok(l) = line {
            let l = l.trim().to_string();
            if l.is_empty() { continue; }
            if let Ok(msg) = serde_json::from_str::<In>(&l) {
                handle_json(msg, &state);
            }
        }
    }
}
