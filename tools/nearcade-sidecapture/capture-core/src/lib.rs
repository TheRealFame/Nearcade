//! capture-core
//!
//! Cross-platform capture-card / webcam capture library, built on GStreamer.
//!
//! This crate does three things, and only three things:
//!   1. Enumerate video capture devices per-OS (`devices` module)
//!   2. Build and drive a GStreamer pipeline programmatically, with real
//!      bus-message error reporting instead of stderr-scraping a subprocess
//!      (`pipeline` module)
//!   3. Expose a small, stable `CaptureSession` type that both the CLI and
//!      the GUI drive identically (this file)
//!
//! Nothing in here shells out to `gst-launch-1.0`, `v4l2-ctl`, or any other
//! external process. Everything goes through gstreamer-rs directly, so
//! errors come back as typed Rust values instead of parsed text.

mod devices;
mod error;
mod pipeline;
pub mod android;

pub use devices::{list_devices, CaptureDevice};
pub use error::CaptureError;
pub use pipeline::{PipelineConfig, PipelineEvent, PipelineHandle};

use std::sync::mpsc::Receiver;

/// Initializes GStreamer. Must be called once before anything else in this
/// crate is used. Safe to call multiple times (idempotent).
pub fn init() -> Result<(), CaptureError> {
    #[cfg(target_os = "linux")]
    {
        if std::env::var("GST_PLUGIN_SYSTEM_PATH_1_0").is_err() {
            std::env::set_var(
                "GST_PLUGIN_SYSTEM_PATH_1_0",
                "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
            );
        }
        if std::env::var("GST_PLUGIN_SCANNER").is_err() {
            std::env::set_var(
                "GST_PLUGIN_SCANNER",
                "/usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner",
            );
        }
    }
    gstreamer::init().map_err(CaptureError::GstInit)
}

/// A running (or stopped) capture session. This is the one object both the
/// CLI and the GUI hold onto.
pub struct CaptureSession {
    handle: Option<PipelineHandle>,
}

impl CaptureSession {
    pub fn new() -> Self {
        Self { handle: None }
    }

    /// Starts capture with the given config. Returns a receiver the caller
    /// can poll (or spawn a thread to read) for pipeline events: state
    /// changes, errors, and "no signal" / "signal restored" transitions.
    pub fn start(&mut self, config: PipelineConfig) -> Result<Receiver<PipelineEvent>, CaptureError> {
        if self.handle.is_some() {
            return Err(CaptureError::AlreadyRunning);
        }
        let (handle, rx) = pipeline::PipelineHandle::start(config)?;
        self.handle = Some(handle);
        Ok(rx)
    }

    /// Stops capture cleanly (sends EOS, waits briefly, then tears down).
    pub fn stop(&mut self) -> Result<(), CaptureError> {
        if let Some(handle) = self.handle.take() {
            handle.stop()?;
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.handle.is_some()
    }

    /// Live-adjust brightness. Range is -50..=50 to match the GUI sliders;
    /// internally mapped to whatever the underlying element expects.
    pub fn set_brightness(&self, value: i32) -> Result<(), CaptureError> {
        match &self.handle {
            Some(h) => h.set_brightness(value),
            None => Err(CaptureError::NotRunning),
        }
    }

    pub fn set_contrast(&self, value: i32) -> Result<(), CaptureError> {
        match &self.handle {
            Some(h) => h.set_contrast(value),
            None => Err(CaptureError::NotRunning),
        }
    }

    pub fn set_mirror(&self, enabled: bool) -> Result<(), CaptureError> {
        match &self.handle {
            Some(h) => h.set_mirror(enabled),
            None => Err(CaptureError::NotRunning),
        }
    }
}

impl Default for CaptureSession {
    fn default() -> Self {
        Self::new()
    }
}
