use thiserror::Error;

/// Every failure mode this crate can produce, as a typed value rather than
/// a parsed error string. The old Python tool guessed at failure causes by
/// substring-matching subprocess stderr (e.g. checking for the literal text
/// "busy"); this enum exists so callers never have to do that again.
#[derive(Debug, Error)]
pub enum CaptureError {
    #[error("failed to initialize GStreamer: {0}")]
    GstInit(#[source] gstreamer::glib::Error),

    #[error("failed to build pipeline: {0}")]
    PipelineBuild(String),

    #[error("failed to set pipeline state: {0}")]
    StateChange(String),

    #[error("device is busy or already in use: {0}")]
    DeviceBusy(String),

    #[error("device not found: {0}")]
    DeviceNotFound(String),

    #[error("element '{0}' is missing — install the matching GStreamer plugin package")]
    MissingElement(String),

    #[error("a capture session is already running")]
    AlreadyRunning,

    #[error("no capture session is running")]
    NotRunning,

    #[error("gstreamer bus error: {0}")]
    Bus(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("failed to launch scrcpy: {0}")]
    ScrcpyFailed(String),
}
