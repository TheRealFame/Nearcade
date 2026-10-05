/// read_gamepads.rs — Nearcade cross-platform gamepad reader (Rust + gilrs 0.11.x)
///
/// Replaces read_gamepads.py. Uses the `gilrs` crate for Windows/Linux/macOS.
///
/// Output JSON events (stdout):
///   { "type": "ready" }
///   { "type": "gamepad_connected", "index": N, "name": "...", "id": "gilrs_N" }
///   { "type": "gamepad_disconnected", "index": N }
///   { "type": "gamepad_state", "index": N, "state": { "axes": [...], "buttons": [...] } }
///
/// Input JSON commands (stdin):
///   { "type": "rumble", "padIndex": N, "strong": 0.0-1.0, "weak": 0.0-1.0, "duration": ms }
use gilrs::{Axis, Button, Event, EventType, Gilrs};
use gilrs::ff::{BaseEffect, BaseEffectType, EffectBuilder, Replay, Ticks};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Serialize)]
struct ButtonState { pressed: bool, value: f32 }

#[derive(Deserialize)]
#[allow(non_snake_case)]
struct InCmd {
    #[serde(rename = "type")] msg_type: String,
    padIndex: Option<usize>,
    strong:   Option<f32>,
    weak:     Option<f32>,
    duration: Option<u64>,
}

fn emit(v: serde_json::Value) { println!("{}", v); io::stdout().flush().unwrap(); }

fn id_to_usize(id: gilrs::GamepadId) -> usize { id.into() }

/// Map gilrs gamepad to W3C 17-button layout.
fn w3c_buttons(pad: &gilrs::Gamepad) -> Vec<ButtonState> {
    let mut btns: Vec<ButtonState> = (0..17).map(|_| ButtonState { pressed: false, value: 0.0 }).collect();
    let map: &[(Button, usize)] = &[
        (Button::South,0),(Button::East,1),(Button::West,2),(Button::North,3),
        (Button::LeftTrigger,4),(Button::RightTrigger,5),
        (Button::LeftTrigger2,6),(Button::RightTrigger2,7),
        (Button::Select,8),(Button::Start,9),
        (Button::LeftThumb,10),(Button::RightThumb,11),
        (Button::DPadUp,12),(Button::DPadDown,13),(Button::DPadLeft,14),(Button::DPadRight,15),
        (Button::Mode,16),
    ];
    for &(g, idx) in map {
        let pressed = pad.is_pressed(g);
        let value = match g {
            Button::LeftTrigger2  => pad.axis_data(Axis::LeftZ).map_or(0.0, |a| a.value().max(0.0)),
            Button::RightTrigger2 => pad.axis_data(Axis::RightZ).map_or(0.0, |a| a.value().max(0.0)),
            _ => if pressed { 1.0 } else { 0.0 },
        };
        btns[idx] = ButtonState { pressed, value };
    }
    btns
}

/// W3C axes [lx, ly, rx, ry] — gilrs Y is inverted vs W3C.
fn w3c_axes(pad: &gilrs::Gamepad) -> [f32; 4] {
    [
        pad.axis_data(Axis::LeftStickX).map_or(0.0, |a| a.value()),
        pad.axis_data(Axis::LeftStickY).map_or(0.0, |a| -a.value()),
        pad.axis_data(Axis::RightStickX).map_or(0.0, |a| a.value()),
        pad.axis_data(Axis::RightStickY).map_or(0.0, |a| -a.value()),
    ]
}

fn main() {
    let mut gilrs = Gilrs::new().expect("Failed to initialise gilrs");

    // Emit already-connected pads
    for (id, pad) in gilrs.gamepads() {
        let idx = id_to_usize(id);
        emit(json!({ "type":"gamepad_connected","index":idx,"name":pad.name(),"id":format!("gilrs_{idx}") }));
    }
    emit(json!({ "type":"ready","message":"read_gamepads Rust backend ready" }));

    // We share Gilrs in an Arc<Mutex> so the stdin thread can schedule rumble.
    // gilrs is NOT Send in all configs, so the stdin thread sends commands via
    // a channel and the main thread executes them. This keeps gilrs single-threaded.
    let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<InCmd>();

    // stdin reader thread → just parses and forwards commands
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            if let Ok(l) = line {
                if l.trim().is_empty() { continue; }
                if let Ok(cmd) = serde_json::from_str::<InCmd>(&l) {
                    let _ = cmd_tx.send(cmd);
                }
            }
        }
    });

    // Main loop — processes gilrs events AND stdin commands (via channel)
    loop {
        // Handle stdin commands
        while let Ok(cmd) = cmd_rx.try_recv() {
            if cmd.msg_type == "rumble" {
                if let Some(idx) = cmd.padIndex {
                    // Find the gilrs GamepadId
                    let gid: Option<gilrs::GamepadId> = gilrs.gamepads()
                        .find(|(id, _)| id_to_usize(*id) == idx)
                        .map(|(id, _)| id);

                    if let Some(gid) = gid {
                        let strong_mag = ((cmd.strong.unwrap_or(0.5)).clamp(0.0,1.0) * u16::MAX as f32) as u16;
                        let weak_mag   = ((cmd.weak.unwrap_or(0.5)).clamp(0.0,1.0)   * u16::MAX as f32) as u16;
                        let dur_ms     = cmd.duration.unwrap_or(200) as u32;
                        let dur        = Ticks::from_ms(dur_ms);

                        let effect = EffectBuilder::new()
                            .add_effect(BaseEffect {
                                kind: BaseEffectType::Strong { magnitude: strong_mag },
                                scheduling: Replay { play_for: dur, ..Default::default() },
                                ..Default::default()
                            })
                            .add_effect(BaseEffect {
                                kind: BaseEffectType::Weak { magnitude: weak_mag },
                                scheduling: Replay { play_for: dur, ..Default::default() },
                                ..Default::default()
                            })
                            .gamepads(&[gid])
                            .finish(&mut gilrs);

                        if let Ok(eff) = effect {
                            let _ = eff.play();
                            // Drop the effect after duration (stops rumble)
                            let stop_after = Duration::from_millis(dur_ms as u64 + 50);
                            thread::spawn(move || { thread::sleep(stop_after); drop(eff); });
                        }
                    }
                }
            }
        }

        // Handle gilrs events
        while let Some(Event { id, event, .. }) = gilrs.next_event() {
            let idx = id_to_usize(id);
            match event {
                EventType::Connected => {
                    let name = gilrs.gamepad(id).name().to_string();
                    emit(json!({ "type":"gamepad_connected","index":idx,"name":name,"id":format!("gilrs_{idx}") }));
                }
                EventType::Disconnected => {
                    emit(json!({ "type":"gamepad_disconnected","index":idx }));
                }
                _ => {
                    let pad = gilrs.gamepad(id);
                    let axes = w3c_axes(&pad);
                    let btns = w3c_buttons(&pad);
                    emit(json!({ "type":"gamepad_state","index":idx,"state":{"axes":axes,"buttons":btns} }));
                }
            }
        }

        thread::sleep(Duration::from_millis(8)); // ~125 Hz
    }
}
