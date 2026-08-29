use gilrs::{Gilrs, Event, EventType, Button, Axis};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::thread;
use std::time::Duration;
use std::sync::{Arc, Mutex};

#[derive(Serialize)]
struct ButtonState {
    pressed: bool,
    value: u8,
}

#[derive(Deserialize)]
struct InMessage {
    #[serde(rename = "type")]
    msg_type: String,
    padIndex: Option<usize>,
    strong: Option<f32>,
    weak: Option<f32>,
    duration: Option<u64>,
}

fn emit(msg: serde_json::Value) {
    println!("{}", msg.to_string());
    io::stdout().flush().unwrap();
}

fn w3c_button_mapping(gilrs_pad: &gilrs::Gamepad) -> Vec<ButtonState> {
    let mut btns = vec![
        ButtonState { pressed: false, value: 0 }; 17
    ];
    
    let map = [
        (Button::South, 0),
        (Button::East, 1),
        (Button::West, 2),
        (Button::North, 3),
        (Button::LeftTrigger, 4),
        (Button::RightTrigger, 5),
        (Button::LeftTrigger2, 6),
        (Button::RightTrigger2, 7),
        (Button::Select, 8),
        (Button::Start, 9),
        (Button::LeftThumb, 10),
        (Button::RightThumb, 11),
        (Button::DPadUp, 12),
        (Button::DPadDown, 13),
        (Button::DPadLeft, 14),
        (Button::DPadRight, 15),
        (Button::Mode, 16),
    ];
    
    for (g_btn, w3c_idx) in map {
        let pressed = gilrs_pad.is_pressed(g_btn);
        let mut value = if pressed { 255 } else { 0 };
        
        // Triggers might have axis values
        if g_btn == Button::LeftTrigger2 {
            if let Some(axis) = gilrs_pad.axis_data(Axis::LeftZ) {
                value = (axis.value() * 255.0) as u8;
            }
        }
        if g_btn == Button::RightTrigger2 {
            if let Some(axis) = gilrs_pad.axis_data(Axis::RightZ) {
                value = (axis.value() * 255.0) as u8;
            }
        }
        
        btns[w3c_idx] = ButtonState { pressed, value };
    }
    
    btns
}

fn w3c_axes_mapping(gilrs_pad: &gilrs::Gamepad) -> Vec<i16> {
    let lx = gilrs_pad.axis_data(Axis::LeftStickX).map_or(0.0, |a| a.value());
    let ly = gilrs_pad.axis_data(Axis::LeftStickY).map_or(0.0, |a| a.value());
    let rx = gilrs_pad.axis_data(Axis::RightStickX).map_or(0.0, |a| a.value());
    let ry = gilrs_pad.axis_data(Axis::RightStickY).map_or(0.0, |a| a.value());
    
    // Note: Gilrs Y is up=positive, W3C Y is up=negative (often). The python script negates Y.
    vec![
        (lx * 32767.0) as i16,
        (-ly * 32767.0) as i16,
        (rx * 32767.0) as i16,
        (-ry * 32767.0) as i16,
    ]
}

fn main() {
    let gilrs_mux = Arc::new(Mutex::new(Gilrs::new().unwrap()));
    
    let g_clone = gilrs_mux.clone();
    thread::spawn(move || {
        loop {
            let mut g = g_clone.lock().unwrap();
            while let Some(Event { id, event, time: _ }) = g.next_event() {
                let pad_index = id.into();
                
                match event {
                    EventType::Connected => {
                        let pad = g.gamepad(id);
                        emit(json!({
                            "type": "gamepad_connected",
                            "index": pad_index,
                            "name": pad.name(),
                            "id": format!("gilrs_{}", pad_index)
                        }));
                    },
                    EventType::Disconnected => {
                        emit(json!({
                            "type": "gamepad_disconnected",
                            "index": pad_index
                        }));
                    },
                    _ => {
                        // For any other event, emit full state
                        let pad = g.gamepad(id);
                        let state = json!({
                            "axes": w3c_axes_mapping(&pad),
                            "buttons": w3c_button_mapping(&pad)
                        });
                        emit(json!({
                            "type": "gamepad_state",
                            "index": pad_index,
                            "state": state
                        }));
                    }
                }
            }
            drop(g);
            thread::sleep(Duration::from_millis(8)); // ~125Hz polling for updates
        }
    });

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        if let Ok(l) = line {
            if l.trim().is_empty() { continue; }
            if let Ok(msg) = serde_json::from_str::<InMessage>(&l) {
                if msg.msg_type == "rumble" {
                    if let Some(idx) = msg.padIndex {
                        let mut g = gilrs_mux.lock().unwrap();
                        let mut target_id = None;
                        for (id, _pad) in g.gamepads() {
                            if id.into() == idx {
                                target_id = Some(id);
                                break;
                            }
                        }
                        // Rumble not fully implemented here as gilrs effect creation requires lifetime management
                        // But framework is ready
                    }
                }
            }
        }
    }
}
