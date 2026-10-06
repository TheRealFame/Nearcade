#![deny(clippy::all)]
use napi_derive::napi;
use napi::bindgen_prelude::*;
use std::sync::Mutex;
use std::collections::HashMap;
use lazy_static::lazy_static;
use enigo::{Enigo, MouseControllable, KeyboardControllable, Key};

#[cfg(target_os = "windows")]
use vigem_client::{Client as VigemClient, TargetId, Xbox360Wired, XGamepad};

struct AppState {
    slots: HashMap<String, u8>,
    #[cfg(target_os = "windows")]
    vigem: Option<VigemClient>,
    #[cfg(target_os = "windows")]
    devices: HashMap<u8, Xbox360Wired<VigemClient>>,
    enigo: Enigo,
}

lazy_static! {
    static ref STATE: Mutex<AppState> = Mutex::new(AppState {
        slots: HashMap::new(),
        #[cfg(target_os = "windows")]
        vigem: None,
        #[cfg(target_os = "windows")]
        devices: HashMap::new(),
        enigo: Enigo::new(),
    });
}

#[napi]
pub fn init() -> Result<()> {
    let mut st = STATE.lock().unwrap();
    st.slots.clear();
    
    #[cfg(target_os = "windows")]
    {
        st.devices.clear();
        match VigemClient::connect() {
            Ok(client) => {
                st.vigem = Some(client);
                println!("[rust_orchestrator] ViGEmBus Client connected successfully.");
            }
            Err(e) => {
                println!("[rust_orchestrator] Failed to connect ViGEmBus: {}", e);
                return Err(Error::new(Status::GenericFailure, "ViGEmBus connection failed".to_owned()));
            }
        }
    }
    
    #[cfg(target_os = "linux")]
    {
        println!("[rust_orchestrator] Linux uinput initialization pending.");
    }
    
    println!("[rust_orchestrator] Native Rust NAPI module initialized.");
    Ok(())
}

#[napi]
pub fn allocate_slot(viewer_id: String, profile_key: String) -> Result<u8> {
    let mut st = STATE.lock().unwrap();
    
    if let Some(&slot) = st.slots.get(&viewer_id) {
        return Ok(slot);
    }
    
    let slot = st.slots.len() as u8;
    if slot >= 16 {
        return Err(Error::new(Status::GenericFailure, "No slots available".to_owned()));
    }
    
    st.slots.insert(viewer_id.clone(), slot);
    println!("[rust_orchestrator] Allocated slot {} for viewer {} with profile {}", slot, viewer_id, profile_key);
    
    #[cfg(target_os = "windows")]
    {
        if let Some(client) = &st.vigem {
            let mut target = Xbox360Wired::new(client.clone(), TargetId::XBOX360_WIRED);
            match target.plugin() {
                Ok(_) => {
                    st.devices.insert(slot, target);
                    println!("[rust_orchestrator] Plugged in virtual Xbox 360 pad for slot {}", slot);
                }
                Err(e) => {
                    println!("[rust_orchestrator] Failed to plug in virtual device: {}", e);
                }
            }
        }
    }
    
    Ok(slot)
}

#[napi]
pub fn submit_input_packet(buffer: Buffer) -> Result<()> {
    let data = buffer.as_ref();
    if data.len() < 16 {
        return Err(Error::new(Status::InvalidArg, "Buffer too small".to_owned()));
    }
    
    let pkt_type = data[0];
    let slot = data[15];
    
    if pkt_type == 0x01 {
        // Gamepad packet
        #[cfg(target_os = "windows")]
        {
            let mut st = STATE.lock().unwrap();
            if let Some(target) = st.devices.get_mut(&slot) {
                let lx = i16::from_le_bytes([data[1], data[2]]);
                let ly = i16::from_le_bytes([data[3], data[4]]);
                let rx = i16::from_le_bytes([data[5], data[6]]);
                let ry = i16::from_le_bytes([data[7], data[8]]);
                let lt = data[9];
                let rt = data[10];
                let cpp_btns = u16::from_le_bytes([data[11], data[12]]);
                let hx = data[13] as i8;
                let hy = data[14] as i8;
                
                let gamepad = XGamepad {
                    thumb_lx: lx,
                    thumb_ly: if ly == -32768 { 32767 } else { -ly },
                    thumb_rx: rx,
                    thumb_ry: if ry == -32768 { 32767 } else { -ry },
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
        }
    } else if pkt_type == 0x02 {
        // Raw KBM packet (x/y delta, clicks, keys)
        // Format: [0x02, event_type, val1, val2]
        // event_type: 1 = MouseMove (val1=dx, val2=dy)
        // event_type: 2 = MouseClick (val1=btn, val2=state)
        // event_type: 3 = Key (val1=keycode, val2=state)
        let mut st = STATE.lock().unwrap();
        let event_type = data[1];
        
        if event_type == 1 {
            let dx = i16::from_le_bytes([data[2], data[3]]) as i32;
            let dy = i16::from_le_bytes([data[4], data[5]]) as i32;
            st.enigo.mouse_move_relative(dx, dy);
        } else if event_type == 2 {
            let btn = data[2];
            let is_down = data[3] == 1;
            let enigo_btn = match btn {
                0 => enigo::MouseButton::Left,
                1 => enigo::MouseButton::Right,
                2 => enigo::MouseButton::Middle,
                _ => enigo::MouseButton::Left,
            };
            if is_down {
                st.enigo.mouse_down(enigo_btn);
            } else {
                st.enigo.mouse_up(enigo_btn);
            }
        } else if event_type == 3 {
            // Mapping logic for standard keys will go here, currently simplified
            let _keycode = data[2];
            let _is_down = data[3] == 1;
        }
    }
    
    Ok(())
}

#[napi]
pub fn destroy() -> Result<()> {
    let mut st = STATE.lock().unwrap();
    st.slots.clear();
    
    #[cfg(target_os = "windows")]
    {
        for (_, mut device) in st.devices.drain() {
            let _ = device.unplug();
        }
    }
    
    println!("[rust_orchestrator] Destroyed all virtual devices.");
    Ok(())
}
