//! JSON line protocol over stdout — byte-identical message shapes to
//! gstreamer_webrtc.py so CaptureManager.js needs no changes.
//!
//! A single BufWriter + one write_all per message keeps IPC cheap; base64
//! payloads dominate anyway, so no extra framing is attempted here.

use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Mutex, OnceLock};

static OUT: OnceLock<Mutex<std::io::BufWriter<std::io::Stdout>>> = OnceLock::new();

fn out() -> &'static Mutex<std::io::BufWriter<std::io::Stdout>> {
    OUT.get_or_init(|| {
        Mutex::new(std::io::BufWriter::with_capacity(
            256 * 1024,
            std::io::stdout(),
        ))
    })
}

/// Emit one JSON object as a single line. Flushes every call so Node's
/// readline side never stalls on a half-written message.
pub fn emit(v: Value) {
    let mut line = serde_json::to_vec(&v).unwrap_or_else(|_| b"{}".to_vec());
    line.push(b'\n');
    if let Ok(mut w) = out().lock() {
        let _ = w.write_all(&line);
        let _ = w.flush();
    }
}

pub fn info(msg: impl Into<String>) {
    emit(json!({"type": "info", "message": msg.into()}));
}

pub fn error(msg: impl Into<String>) {
    emit(json!({"type": "error", "message": msg.into()}));
}

pub fn thumbnail_b64(b64: String) {
    emit(json!({"type": "thumbnail", "data": b64}));
}

pub fn sdp_offer(sdp: &str) {
    emit(json!({"type": "sdp", "sdp": sdp}));
}

pub fn ice(mlineindex: u32, candidate: &str) {
    emit(json!({"type": "ice", "sdpMLineIndex": mlineindex, "candidate": candidate}));
}

/// H264 Annex-B chunk for the WebCodecs transport path. Width/height ride
/// along so the host can build the decoder config without parsing SPS.
pub fn h264_chunk(keyframe: bool, width: u32, height: u32, annexb: &[u8]) {
    emit(
        json!({"type": "h264-chunk", "keyframe": keyframe, "width": width, "height": height, "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, annexb)}),
    );
}
