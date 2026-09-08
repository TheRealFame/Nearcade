//! WebCodecs mode: capture -> H264 encode -> appsink, emitting one
//! `h264-chunk` IPC message per access unit (base64 Annex-B).
//!
//! This feeds the same downstream transport the browser WebCodecs pipeline
//! uses, but with GStreamer (optionally VA-API) doing the encoding.

use gstreamer as gst;
use gstreamer::glib;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;


pub struct Config {
    pub node: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub encoder: String,
    pub with_preview: bool,
    pub source_override: Option<String>,
}

/// Annex-B scan: keyframe if the buffer holds an IDR (type 5) or SPS (type 7).
fn is_keyframe(annexb: &[u8]) -> bool {
    let mut i = 0;
    while i + 4 < annexb.len() {
        let sc4 = i + 4 <= annexb.len()
            && annexb[i] == 0
            && annexb[i + 1] == 0
            && annexb[i + 2] == 0
            && annexb[i + 3] == 1;
        let sc3 =
            annexb[i] == 0 && annexb[i + 1] == 0 && annexb[i + 2] == 1;
        if sc4 || sc3 {
            let h = i + if sc4 { 4 } else { 3 };
            if h < annexb.len() {
                match annexb[h] & 31 {
                    5 | 7 => return true,
                    _ => {}
                }
            }
            i = h + 1;
        } else {
            i += 1;
        }
    }
    false
}

pub fn run(cfg: Config) {
    let source = if let Some(src) = &cfg.source_override {
        src.clone()
    } else if let Some(node) = &cfg.node {
        crate::ipc::info(format!("Headless PipeWire capture: node {node}"));
        crate::base::source_for_node(node)
    } else {
        crate::ipc::error(
            "Portal capture is not implemented in the Rust backend yet; pass --node.",
        );
        std::process::exit(1);
    };

    let gop = cfg.fps * 2;
    let enc = match cfg.encoder.as_str() {
        "vaapi" => format!(
            "vaapih264enc bitrate={} keyframe-period={gop} ! h264parse",
            cfg.bitrate / 1000
        ),
        _ => "x264enc tune=zerolatency speed-preset=ultrafast byte-stream=true".to_string(),
    };
    let preview = if cfg.with_preview {
        format!("t2. ! {}", crate::preview::branch_desc())
    } else {
        String::new()
    };
    // Single tee: encoded chunks to appsink + optional preview branch.
    // (A second tee leg keeps preview independent of encode backpressure.)
    let desc = format!(
        "{source} ! video/x-raw,width={w},height={h},framerate={f}/1 ! videoconvert ! tee name=t ! queue ! videoconvert ! {enc} ! appsink name=chunks emit-signals=true max-buffers=8 drop=true sync=false t. ! queue ! videoconvert ! tee name=t2 {preview}",
        w = cfg.width,
        h = cfg.height,
        f = cfg.fps
    );

    let pipeline = gst::parse::launch(&desc)
        .map_err(|e| {
            crate::ipc::error(format!("Pipeline parse error: {e}"));
            std::process::exit(1);
        })
        .unwrap()
        .downcast::<gst::Pipeline>()
        .expect("launch did not produce a pipeline");

    let chunks = pipeline
        .by_name("chunks")
        .expect("no chunks appsink")
        .downcast::<gst_app::AppSink>()
        .expect("chunks is not an appsink");
    chunks.set_property("emit-signals", true);
    chunks.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(|sink| {
                let sample = sink
                    .pull_sample()
                    .map_err(|_| gst::FlowError::Error)?;
                let buf = sample.buffer().ok_or(gst::FlowError::Error)?;
                let map = buf.map_readable().map_err(|_| gst::FlowError::Error)?;
                let bytes = map.as_slice();
                crate::ipc::h264_chunk(is_keyframe(bytes), bytes);
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    if cfg.with_preview && !crate::preview::attach(&pipeline) {
        crate::ipc::error("preview appsink not found; continuing without thumbnails");
    }

    let bus = pipeline.bus().expect("no bus");
    let main_loop = gstreamer::glib::MainLoop::new(None, false);
    let ml = main_loop.clone();
    let _watch = bus
        .add_watch(move |_bus, msg| {
            use gstreamer::MessageView;
            match msg.view() {
                MessageView::Error(e) => {
                    crate::ipc::error(format!(
                        "GStreamer bus error from {:?}: {} ({:?})",
                        e.src().map(|s| s.path_string()),
                        e.error(),
                        e.debug()
                    ));
                    ml.quit();
                    glib::ControlFlow::Break
                }
                MessageView::Eos(_) => {
                    crate::ipc::info("Encoder stream ended");
                    ml.quit();
                    glib::ControlFlow::Break
                }
                _ => glib::ControlFlow::Continue,
            }
        })
        .expect("bus watch failed");

    if pipeline.set_state(gst::State::Playing).is_err() {
        crate::ipc::error("Pipeline failed to start (PLAYING state failed).");
        std::process::exit(1);
    }
    main_loop.run();
    let _ = pipeline.set_state(gst::State::Null);
}
