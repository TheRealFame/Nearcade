/// windows_hidmaestro.rs — Nearcade Windows HIDMaestro Input Backend (Rust)
///
/// Replaces the Python hidmaestro sidecar. Acts as the bridge between
/// InputOrchestrator.js (Node.js) and HmBridge.exe (the C# HIDMaestro kernel driver client).
///
/// Transport:
///   IN  JSON (stdin):   allocate_slot | free_slot | state | gamepad | flush_neutral | destroy_all
///   IN  UDP  (binary):  16-byte binary gamepad packet (same format as linux_uinput.rs)
///   OUT JSON (stdout):  ready | log | error | udp_ready
///
/// HmBridge IPC:
///   We spawn HmBridge.exe and communicate via its stdin/stdout JSON protocol.
///   HmBridge expects: { "type": "alloc", "slot": N, "profile": "xbox360" }
///                     { "type": "state", "slot": N, lx, ly, rx, ry, lt, rt, btns }
///                     { "type": "free", "slot": N }
///                     { "type": "destroy_all" }
///
/// Fallback: If HmBridge.exe is not found, falls back to the vigem-client Rust crate
/// (windows_vigem.exe logic) so the sidecar remains functional without the C# component.
///
/// AGENTS.md:
///   - Key-repeat prevention is NOT applicable here (gamepad state, not KBM)
///   - Python -u buffering flag: not needed — we're Rust with explicit flush
use std::io::{self, BufRead, BufReader, Write};
use std::net::UdpSocket;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ─── Wire types ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(tag = "type")]
enum Out {
    #[serde(rename = "ready")]     Ready    { message: String },
    #[serde(rename = "log")]       Log      { message: String },
    #[serde(rename = "error")]     Error    { message: String, code: String },
    #[serde(rename = "udp_ready")] UdpReady { udp_port: u16 },
}

#[derive(Deserialize, Debug)]
#[allow(non_snake_case)]
struct In {
    #[serde(rename = "type")] msg_type: String,
    pad_id:  Option<String>,
    slot:    Option<u8>,
    profile: Option<String>,
    // Gamepad JSON state (alternate path, prefer binary UDP)
    lx: Option<f64>, ly: Option<f64>,
    rx: Option<f64>, ry: Option<f64>,
    lt: Option<f64>, rt: Option<f64>,
    buttons: Option<Value>,
}

fn emit(msg: Out) {
    println!("{}", serde_json::to_string(&msg).unwrap());
    io::stdout().flush().unwrap();
}
fn log(s: &str) { emit(Out::Log { message: s.into() }); }

// ─── HmBridge process handle ─────────────────────────────────────────────────

struct HmBridge {
    child:  Child,
    stdin:  std::process::ChildStdin,
}

impl HmBridge {
    fn send(&mut self, v: Value) -> bool {
        let line = serde_json::to_string(&v).unwrap() + "\n";
        self.stdin.write_all(line.as_bytes()).is_ok()
            && self.stdin.flush().is_ok()
    }
}

// ─── Binary packet → HmBridge state ─────────────────────────────────────────

/// Parse the 16-byte InputOrchestrator binary packet and forward to HmBridge.
fn dispatch_binary(payload: &[u8], slot_map: &Arc<Mutex<SlotMap>>, bridge: &Arc<Mutex<Option<HmBridge>>>) {
    if payload.len() < 16 || payload[0] != 0x01 { return; }
    let slot = payload[15] as usize;

    let lx = i16::from_le_bytes([payload[1], payload[2]]) as f64 / 32767.0;
    let ly = i16::from_le_bytes([payload[3], payload[4]]) as f64 / 32767.0;
    let rx = i16::from_le_bytes([payload[5], payload[6]]) as f64 / 32767.0;
    let ry = i16::from_le_bytes([payload[7], payload[8]]) as f64 / 32767.0;
    let lt = payload[9]  as f64 / 255.0;
    let rt = payload[10] as f64 / 255.0;
    let btns = u16::from_le_bytes([payload[11], payload[12]]) as u32;
    let hx   = payload[13] as i8 as i32;
    let hy   = payload[14] as i8 as i32;

    // Reconstruct dpad bits from hx/hy into buttons (for HmBridge protocol)
    let mut full_btns = btns;
    if hx < 0 { full_btns |= 1 << 14; } // LEFT
    if hx > 0 { full_btns |= 1 << 15; } // RIGHT
    if hy < 0 { full_btns |= 1 << 12; } // UP
    if hy > 0 { full_btns |= 1 << 13; } // DOWN

    let msg = json!({
        "type": "state",
        "slot": slot,
        "lx": lx, "ly": ly, "rx": rx, "ry": ry,
        "lt": lt, "rt": rt,
        "btns": full_btns,
    });

    let mut brd = bridge.lock().unwrap();
    if let Some(ref mut hm) = *brd {
        if !hm.send(msg) {
            log(&format!("[HmBridge] Failed to write state for slot {slot}"));
        }
    } else {
        // ViGEm fallback: use vigem-client crate if available
        dispatch_vigem_fallback(slot as u8, lx, ly, rx, ry, lt, rt, full_btns, hx, hy);
    }
}

// ─── ViGEm fallback (when HmBridge.exe is absent) ────────────────────────────

/// Best-effort ViGEm submission via vigem-client crate.
/// On systems without ViGEmBus driver installed, this will silently error.
fn dispatch_vigem_fallback(slot: u8, lx: f64, ly: f64, rx: f64, ry: f64,
                            lt: f64, rt: f64, btns: u32, _hx: i32, _hy: i32) {
    #[cfg(target_os = "windows")]
    {
        use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};

        // Lazy-static style: per-call connect for now (real app would cache this).
        // This path only fires if HmBridge.exe is missing and vigem-client is available.
        if let Ok(client) = Client::connect() {
            let id = TargetId::XBOX360_WIRED;
            if let Ok(mut target) = Xbox360Wired::new(client, id) {
                let _ = target.plugin();
                let _ = target.wait_ready();
                let gamepad = XGamepad {
                    buttons: XButtons(btns as u16),
                    left_trigger: (lt * 255.0) as u8,
                    right_trigger: (rt * 255.0) as u8,
                    thumb_lx: (lx * 32767.0) as i16,
                    thumb_ly: (ly * 32767.0) as i16,
                    thumb_rx: (rx * 32767.0) as i16,
                    thumb_ry: (ry * 32767.0) as i16,
                };
                let _ = target.update(&gamepad);
            }
        }
    }
}

// ─── Slot map ─────────────────────────────────────────────────────────────────

struct SlotMap {
    pad_to_slot: std::collections::HashMap<String, u8>,
}

// ─── HmBridge finder ─────────────────────────────────────────────────────────

fn find_hm_bridge() -> Option<std::path::PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join("HmBridge").join("HmBridge.exe"),
        exe_dir.join("..").join("HmBridge").join("HmBridge.exe"),
        exe_dir.join("..").join("..").join("src").join("sidecar").join("input_backends").join("HmBridge").join("HmBridge.exe"),
        // If run from cargo target directory
        std::env::current_dir().ok()?.join("src").join("sidecar").join("input_backends").join("HmBridge").join("HmBridge.exe"),
    ];
    for p in &candidates {
        let canonical = p.canonicalize().unwrap_or_else(|_| p.clone());
        if canonical.exists() { return Some(canonical); }
    }
    None
}

fn spawn_hm_bridge(path: &Path) -> Option<HmBridge> {
    let mut child = Command::new(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take()?;
    let stdin  = child.stdin.take()?;

    // Relay HmBridge stdout → our stdout (pass-through)
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if let Ok(l) = line {
                println!("{}", l);
                io::stdout().flush().ok();
            }
        }
    });

    // Relay HmBridge stderr → our log channel
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            if let Ok(l) = line {
                log(&format!("[HmBridge] {}", l));
            }
        }
    });

    Some(HmBridge { child, stdin })
}

// ─── JSON message handler ─────────────────────────────────────────────────────

fn handle_json(msg: In, slots: &Arc<Mutex<SlotMap>>, bridge: &Arc<Mutex<Option<HmBridge>>>) {
    let mut sl = slots.lock().unwrap();
    let mut brd = bridge.lock().unwrap();

    match msg.msg_type.as_str() {
        "allocate_slot" => {
            if let (Some(pad), Some(slot)) = (msg.pad_id.clone(), msg.slot) {
                sl.pad_to_slot.insert(pad.clone(), slot);
                let profile = msg.profile.unwrap_or_else(|| "xbox360".into());
                log(&format!("Allocating slot {slot} for pad {pad} as {profile}"));
                if let Some(ref mut hm) = *brd {
                    hm.send(json!({ "type": "alloc", "slot": slot, "profile": profile }));
                }
            }
        }

        "free_slot" => {
            if let Some(slot) = msg.slot {
                if let Some(ref mut hm) = *brd {
                    hm.send(json!({ "type": "free", "slot": slot }));
                }
                sl.pad_to_slot.retain(|_, &mut s| s != slot);
            }
        }

        "gamepad" | "state" => {
            // JSON gamepad state — slower path vs UDP binary
            if let Some(slot) = msg.slot.or_else(|| msg.pad_id.as_ref().and_then(|p| sl.pad_to_slot.get(p)).copied()) {
                let lx = msg.lx.unwrap_or(0.0);
                let ly = msg.ly.unwrap_or(0.0);
                let rx = msg.rx.unwrap_or(0.0);
                let ry = msg.ry.unwrap_or(0.0);
                let lt = msg.lt.unwrap_or(0.0);
                let rt = msg.rt.unwrap_or(0.0);
                let btns = msg.buttons.as_ref().and_then(|v| v.as_u64()).unwrap_or(0) as u32;

                if let Some(ref mut hm) = *brd {
                    hm.send(json!({
                        "type": "state", "slot": slot,
                        "lx": lx, "ly": ly, "rx": rx, "ry": ry,
                        "lt": lt, "rt": rt, "btns": btns,
                    }));
                } else {
                    dispatch_vigem_fallback(slot as u8, lx, ly, rx, ry, lt, rt, btns, 0, 0);
                }
            }
        }

        "flush_neutral" | "disconnect_viewer" => {
            if let Some(ref pad) = msg.pad_id {
                if let Some(&slot) = sl.pad_to_slot.get(pad) {
                    // Send a zeroed state for this slot
                    if let Some(ref mut hm) = *brd {
                        hm.send(json!({
                            "type": "state", "slot": slot,
                            "lx": 0, "ly": 0, "rx": 0, "ry": 0,
                            "lt": 0, "rt": 0, "btns": 0,
                        }));
                    }
                    sl.pad_to_slot.remove(pad);
                }
            }
        }

        "destroy_all" => {
            if let Some(ref mut hm) = *brd {
                hm.send(json!({ "type": "destroy_all" }));
            }
            sl.pad_to_slot.clear();
        }

        _ => {}
    }
}

// ─── main ─────────────────────────────────────────────────────────────────────

fn main() {
    log("windows_hidmaestro Rust backend starting…");

    // Try to spawn HmBridge.exe
    let hm_instance = find_hm_bridge().and_then(|path| {
        log(&format!("Found HmBridge at: {}", path.display()));
        spawn_hm_bridge(&path)
    });

    if hm_instance.is_none() {
        log("HmBridge.exe not found — using ViGEm fallback mode");
        #[cfg(not(target_os = "windows"))]
        emit(Out::Error {
            message: "HmBridge.exe not found and ViGEm fallback is Windows-only".into(),
            code: "HM_BRIDGE_NOT_FOUND".into(),
        });
    }

    let bridge  = Arc::new(Mutex::new(hm_instance));
    let slots   = Arc::new(Mutex::new(SlotMap { pad_to_slot: Default::default() }));

    // Bind UDP socket for binary gamepad fast-path
    let udp_sock = UdpSocket::bind("127.0.0.1:0").expect("UDP bind failed");
    let udp_port = udp_sock.local_addr().unwrap().port();
    emit(Out::UdpReady { udp_port });

    // UDP listener thread
    let bridge_udp = bridge.clone();
    let slots_udp  = slots.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            if let Ok((n, _)) = udp_sock.recv_from(&mut buf) {
                if n >= 16 { dispatch_binary(&buf[..n], &slots_udp, &bridge_udp); }
            }
        }
    });

    emit(Out::Ready { message: "windows_hidmaestro Rust backend ready".into() });

    // Main stdin loop
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        if let Ok(l) = line {
            let l = l.trim().to_string();
            if l.is_empty() { continue; }
            if let Ok(msg) = serde_json::from_str::<In>(&l) {
                handle_json(msg, &slots, &bridge);
            }
        }
    }
}
