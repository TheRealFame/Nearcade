//! Single-preview thumbnail branch shared by both modes.
//!
//! Mirrors the throttled Python feed: 480x270 @ 2fps, JPEG q50, plus a 400ms
//! minimum-interval guard so post-stall bursts drain instead of flooding the
//! stdout IPC -> WebSocket -> img.src path.

use gstreamer as gst;
use gstreamer_app as gst_app;
use gst::prelude::*;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// GStreamer launch fragment for the preview branch (ends at appsink).
pub fn branch_desc() -> &'static str {
    "queue max-size-buffers=1 leaky=downstream \
     ! videoconvert \
     ! videoscale ! video/x-raw,width=480,height=270 \
     ! videorate ! video/x-raw,framerate=2/1 \
     ! jpegenc quality=50 \
     ! appsink name=thumb_sink emit-signals=true max-buffers=1 drop=true sync=false"
}

/// Attach the throttled thumbnail emitter to an existing pipeline.
/// Returns true when the appsink was found and wired.
pub fn attach(pipeline: &gst::Pipeline) -> bool {
    let Some(sink_el) = pipeline.by_name("thumb_sink") else {
        return false;
    };
    let Ok(appsink) = sink_el.downcast::<gst_app::AppSink>() else {
        return false;
    };
    appsink.set_property("emit-signals", true);
    let last: Arc<Mutex<Instant>> = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(10)));
    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = match sink.pull_sample() {
                    Ok(s) => s,
                    Err(_) => return Err(gst::FlowError::Error),
                };
                // Throttle guard (drains bursts).
                let now = Instant::now();
                {
                    let mut l = last.lock().unwrap();
                    if now.duration_since(*l) < Duration::from_millis(400) {
                        return Ok(gst::FlowSuccess::Ok);
                    }
                    *l = now;
                }
                let buf = sample.buffer().ok_or(gst::FlowError::Error)?;
                let map = buf.map_readable().map_err(|_| gst::FlowError::Error)?;
                crate::ipc::thumbnail_b64(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    map.as_slice(),
                ));
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    true
}
