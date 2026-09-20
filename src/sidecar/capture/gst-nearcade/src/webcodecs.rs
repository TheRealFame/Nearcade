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

/// Keyframe scan over one access unit, Annex-B or AVCC framing.
/// Annex-B: NALs delimited by 00 00 01 / 00 00 00 01 start codes.
/// AVCC: each NAL prefixed by a 4-byte big-endian length (what our pipeline
/// emits after the byte-stream forcing caps; also what decoders want).
/// Keyframe if any NAL is IDR (type 5) or SPS (type 7).
fn is_keyframe(buf: &[u8]) -> bool {
    if buf.len() < 5 {
        return false;
    }
    let annexb = buf[0] == 0
        && buf[1] == 0
        && (buf[2] == 1 || (buf[2] == 0 && buf.get(3) == Some(&1)));
    if annexb {
        return is_keyframe_annexb(buf);
    }
    // AVCC length-prefixed walk with sanity cap (lengths must stay in-bounds).
    let mut i = 0;
    let mut saw_nal = false;
    while i + 4 <= buf.len() {
        let len = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        if len == 0 || len > buf.len() - (i + 4) || len > 8 * 1024 * 1024 {
            break;
        }
        saw_nal = true;
        if i + 4 < buf.len() && matches!(buf[i + 4] & 31, 5 | 7) {
            return true;
        }
        i += 4 + len;
    }
    // Not valid AVCC (or empty) — fall back to an Annex-B scan in case the
    // caps forcing didn't apply and start codes are present after all.
    if !saw_nal {
        return is_keyframe_annexb(buf);
    }
    false
}

/// Annex-B start-code scan (original logic, factored out).
fn is_keyframe_annexb(annexb: &[u8]) -> bool {
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
    // Encoder tail after `videoconvert ! video/x-raw,format=I420`.
    // x264 path is byte-stream native (untouched, proven). VA-API needs a
    // proper upload converter (system-memory I420 does NOT link into VA-API
    // encoders) and must emit AVCC (length-prefixed) access units — avc1
    // decoders reject Annex-B start codes outright.
    let enc_tail = match cfg.encoder.as_str() {
        "vaapi" => match crate::webrtc::vaapi_encoder_fragment(cfg.bitrate / 1000, gop) {
            Some(frag) => format!(
                "{frag} ! h264parse config-interval=-1 \
                 ! video/x-h264,stream-format=avc,alignment=au"
            ),
            None => {
                crate::ipc::error(
                    "no VA-API H264 encoder found (need vah264enc+vapostproc or vaapih264enc+vaapipostproc); cannot honor --encoder vaapi",
                );
                std::process::exit(1);
            }
        },
        _ => "x264enc tune=zerolatency speed-preset=ultrafast byte-stream=true".to_string(),
    };
    let enc = enc_tail;
    let preview = if cfg.with_preview {
        format!("t2. ! {}", crate::preview::branch_desc())
    } else {
        String::new()
    };
    // Single tee: encoded chunks to appsink + optional preview branch.
    // (A second tee leg keeps preview independent of encode backpressure.)
    let desc = format!(
        "{source} ! video/x-raw,width={w},height={h},framerate={f}/1 ! videoconvert ! video/x-raw,format=I420 ! tee name=t ! queue ! videoconvert ! video/x-raw,format=I420 ! {enc} ! appsink name=chunks emit-signals=true max-buffers=8 drop=true sync=false t. ! queue ! videoconvert ! tee name=t2 {preview}",
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
    let (cw, ch) = (cfg.width, cfg.height);
    chunks.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink
                    .pull_sample()
                    .map_err(|_| gst::FlowError::Error)?;
                let buf = sample.buffer().ok_or(gst::FlowError::Error)?;
                let map = buf.map_readable().map_err(|_| gst::FlowError::Error)?;
                let bytes = map.as_slice();
                crate::ipc::h264_chunk(is_keyframe(bytes), cw, ch, bytes);
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
