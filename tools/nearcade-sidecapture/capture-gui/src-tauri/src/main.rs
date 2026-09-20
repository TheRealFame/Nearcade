// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use capture_core::{CaptureDevice, CaptureSession, PipelineConfig, PipelineEvent};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, State};

struct AppState {
    session: Mutex<CaptureSession>,
    latest_frame: Mutex<Option<String>>,
}

#[derive(Serialize)]
struct DeviceList {
    devices: Vec<CaptureDevice>,
}

#[tauri::command]
fn log_error(msg: String) {
    eprintln!("JS ERROR: {}", msg);
}

#[tauri::command]
fn list_devices() -> DeviceList {
    DeviceList {
        devices: capture_core::list_devices(),
    }
}
#[tauri::command]
fn get_latest_frame(state: tauri::State<AppState>) -> Option<String> {
    state.latest_frame.lock().ok()?.take()
}

#[tauri::command]
fn start_capture(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    config: PipelineConfig,
) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|_| "session lock poisoned".to_string())?;
    let rx = session.start(config).map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    std::thread::spawn(move || {
        use tauri::Manager;
        for event in rx {
            match event {
                PipelineEvent::Frame(bytes) => {
                    let encoded = base64_encode(&bytes);
                    let data_url = format!("data:image/jpeg;base64,{encoded}");
                    if let Some(state_mutex) = app_handle.try_state::<AppState>() {
                        if let Ok(mut frame_lock) = state_mutex.latest_frame.lock() {
                            *frame_lock = Some(data_url);
                            let _ = app_handle.emit("capture-frame-ready", String::new());
                        }
                    }
                }
                other => {
                    let (event_name, payload): (&str, String) = match other {
                        PipelineEvent::Started => ("capture-started", String::new()),
                        PipelineEvent::SignalLost => ("capture-signal-lost", String::new()),
                        PipelineEvent::SignalRestored => ("capture-signal-restored", String::new()),
                        PipelineEvent::Error(msg) => ("capture-error", msg),
                        PipelineEvent::Eos => ("capture-eos", String::new()),
                        PipelineEvent::Stopped => ("capture-stopped", String::new()),
                        PipelineEvent::Frame(_) => unreachable!(),
                    };
                    println!("Emitting event: {}", event_name);
                    let _ = app_handle.emit(event_name, payload);
                }
            }
        }
    });

    Ok(())
}

/// Minimal base64 encoder (standard alphabet, with padding) so we don't
/// need to pull in an extra crate just for this one call site.
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);

        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(b2 & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[tauri::command]
fn stop_capture(state: State<AppState>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|_| "session lock poisoned".to_string())?;
    session.stop().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_brightness(state: State<AppState>, value: i32) -> Result<(), String> {
    let session = state.session.lock().map_err(|_| "session lock poisoned".to_string())?;
    session.set_brightness(value).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_contrast(state: State<AppState>, value: i32) -> Result<(), String> {
    let session = state.session.lock().map_err(|_| "session lock poisoned".to_string())?;
    session.set_contrast(value).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_mirror(state: State<AppState>, enabled: bool) -> Result<(), String> {
    let session = state.session.lock().map_err(|_| "session lock poisoned".to_string())?;
    session.set_mirror(enabled).map_err(|e| e.to_string())
}

fn main() {
    // Initialize GStreamer once, before any window or command can touch it.
    if let Err(e) = capture_core::init() {
        eprintln!("fatal: failed to initialize capture backend: {e}");
        std::process::exit(1);
    }

    tauri::Builder::default()
        .manage(AppState {
            session: Mutex::new(CaptureSession::new()),
            latest_frame: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            log_error,
            get_latest_frame,
            start_capture,
            stop_capture,
            set_brightness,
            set_contrast,
            set_mirror,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nearcade Sidecapture");
}
