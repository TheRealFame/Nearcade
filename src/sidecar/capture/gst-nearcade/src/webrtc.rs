//! WebRTC mode: capture -> tee -> (HW/SW H264 encode -> WebRTC) + (preview).
//! Mirrors gstreamer_webrtc.py 1:1 on the wire (same IPC shapes), so the
//! Node side cannot tell which backend produced the messages.
//!
//! NOTE: gstreamer-webrtc 0.25 ships no Rust wrapper for the webrtcbin
//! element itself, so all access is dynamic (emit_by_name + connect).

use gstreamer as gst;
use gstreamer::glib;
use gstreamer::prelude::*;
use gstreamer_webrtc as webrtc;

use crate::base;

const STUN: &str = "stun://stun.l.google.com:19302";

/// Encoder element fragment. Default is x264 (parity with the Python
/// backend); --encoder vaapi selects VA-API hardware encoding.
pub fn encoder_desc(encoder: &str, bitrate_kbps: u32, gop: u32) -> String {
    match encoder {
        "vaapi" => format!(
            "vaapih264enc bitrate={bitrate_kbps} keyframe-period={gop} ! h264parse"
        ),
        _ => "x264enc tune=zerolatency speed-preset=ultrafast byte-stream=true".to_string(),
    }
}

enum Signal {
    Answer(String),
    Ice(u32, String),
}

pub struct Config {
    pub node: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub encoder: String,
    pub with_preview: bool,
    /// Test hook: replace the capture source (e.g. videotestsrc).
    pub source_override: Option<String>,
}

fn source_element(cfg: &Config) -> String {
    if let Some(src) = &cfg.source_override {
        return src.clone();
    }
    if let Some(node) = &cfg.node {
        crate::ipc::info(format!("Headless PipeWire capture: node {node}"));
        return base::source_for_node(node);
    }
    // Portal path lives in the Python backend for now.
    crate::ipc::error(
        "Portal capture is not implemented in the Rust backend yet; pass --node or keep the Python backend for portal fallback.",
    );
    std::process::exit(1);
}

pub fn run(cfg: Config) {
    let source = source_element(&cfg);
    let gop = cfg.fps * 2;
    let enc = encoder_desc(&cfg.encoder, cfg.bitrate / 1000, gop);
    let preview = if cfg.with_preview {
        format!("t. ! queue max-size-buffers=1 leaky=downstream ! {}", crate::preview::branch_desc())
    } else {
        String::new()
    };
    let desc = format!(
        "webrtcbin name=sendrecv bundle-policy=max-bundle stun-server={STUN} \
         {source} ! video/x-raw ! videoconvert ! video/x-raw,format=I420 ! tee name=t \
         t. ! queue max-size-time=500000000 leaky=downstream \
         ! videoconvert ! {enc} \
         ! rtph264pay config-interval=-1 aggregate-mode=zero-latency \
         ! application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000 \
         ! sendrecv. \
         {preview} \
         pulsesrc ! audio/x-raw,rate=48000,channels=1 \
         ! audioconvert ! audioresample ! opusenc bitrate=128000 ! rtpopuspay \
         ! application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000 \
         ! queue max-size-time=500000000 leaky=downstream ! sendrecv."
    );

    let pipeline = gst::parse::launch(&desc)
        .map_err(|e| {
            crate::ipc::error(format!("Pipeline parse error: {e}"));
            std::process::exit(1);
        })
        .unwrap()
        .downcast::<gst::Pipeline>()
        .expect("launch did not produce a pipeline");

    let webrtcbin: gst::Element = pipeline.by_name("sendrecv").expect("no webrtcbin");
    webrtcbin.set_property("stun-server", STUN);

    // Offer flow.
    webrtcbin
        .connect("on-negotiation-needed", false, move |args| {
            let bin = args[0]
                .get::<gst::Element>()
                .expect("on-negotiation-needed self");
            crate::ipc::info("WebRTC negotiation needed — creating offer");
            let opts = gst::Structure::new_empty("webrtcbin-create-offer");
            let bin2 = bin.clone();
            let promise = gst::Promise::with_change_func(move |reply| {
                let sref = match reply {
                    Ok(Some(r)) => r,
                    Ok(None) => {
                        crate::ipc::error("create-offer reply empty");
                        return;
                    }
                    Err(e) => {
                        crate::ipc::error(format!("create-offer failed: {e:?}"));
                        return;
                    }
                };
                let offer = match sref.get::<webrtc::WebRTCSessionDescription>("offer") {
                    Ok(o) => o,
                    Err(e) => {
                        crate::ipc::error(format!("offer missing in reply: {e:?}"));
                        return;
                    }
                };
                bin2.emit_by_name::<()>("set-local-description", &[&offer, &gst::Promise::new()]);
                match offer.sdp().as_text() {
                    Ok(text) => crate::ipc::sdp_offer(&text),
                    Err(e) => crate::ipc::error(format!("offer has no SDP text: {e:?}")),
                }
                crate::ipc::info("SDP offer sent to server");
            });
            bin.emit_by_name::<()>("create-offer", &[&opts, &promise]);
            None
        });

    // Local ICE out.
    webrtcbin
        .connect("on-ice-candidate", false, move |args| {
            let mline: u32 = args.get(1).and_then(|v| v.get::<u32>().ok()).unwrap_or(0);
            let cand: String = args
                .get(2)
                .and_then(|v| v.get::<String>().ok())
                .unwrap_or_default();
            if !cand.is_empty() {
                crate::ipc::ice(mline, &cand);
            }
            None
        });

    // Remote signaling in (stdin thread -> futures channel -> main context).
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<Signal>();
    let wb2 = webrtcbin.clone();
    glib::MainContext::default().spawn_local(async move {
        use futures::StreamExt;
        while let Some(sig) = rx.next().await {
            match sig {
                Signal::Answer(sdp_text) => {
                    match gstreamer_sdp::SDPMessage::parse_buffer(sdp_text.as_bytes()) {
                        Ok(msg) => {
                            let answer = webrtc::WebRTCSessionDescription::new(
                                webrtc::WebRTCSDPType::Answer,
                                msg,
                            );
                            wb2.emit_by_name::<()>(
                                "set-remote-description",
                                &[&answer, &gst::Promise::new()],
                            );
                            crate::ipc::info("Remote SDP answer applied");
                        }
                        Err(_) => crate::ipc::error("Failed to parse SDP answer"),
                    }
                }
                Signal::Ice(mline, cand) => {
                    wb2.emit_by_name::<()>("add-ice-candidate", &[&mline, &cand]);
                }
            }
        }
    });

    std::thread::spawn(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let t = line.trim();
            if t.is_empty() || !t.starts_with('{') {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(t) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match v.get("type").and_then(|x| x.as_str()) {
                Some("answer") => {
                    let s = match v.get("sdp") {
                        Some(serde_json::Value::String(s)) => s.clone(),
                        Some(o) => o
                            .get("sdp")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string(),
                        None => String::new(),
                    };
                    if !s.is_empty() {
                        let _ = tx.unbounded_send(Signal::Answer(s));
                    }
                }
                Some("ice-viewer") => {
                    let (cand, mline) = match v.get("candidate") {
                        Some(serde_json::Value::String(s)) => (
                            s.clone(),
                            v.get("sdpMLineIndex").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
                        ),
                        Some(o) => (
                            o.get("candidate").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            o.get("sdpMLineIndex").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
                        ),
                        None => (String::new(), 0),
                    };
                    if !cand.is_empty() {
                        let _ = tx.unbounded_send(Signal::Ice(mline, cand));
                    }
                }
                _ => {}
            }
        }
    });

    if cfg.with_preview && !crate::preview::attach(&pipeline) {
        crate::ipc::error("preview appsink not found; continuing without thumbnails");
    }

    // Bus errors end the run loudly (parity with the Python bus listener).
    let bus = pipeline.bus().expect("no bus");
    let main_loop = glib::MainLoop::new(None, false);
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
                MessageView::StateChanged(s) => {
                    if let Some(src) = msg.src() {
                        let name = src.name();
                        if name == "sendrecv" || name == "pipeline" {
                            crate::ipc::info(format!(
                                "Pipeline state: {:?} -> {:?}",
                                s.old(),
                                s.current()
                            ));
                        }
                    }
                    glib::ControlFlow::Continue
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
