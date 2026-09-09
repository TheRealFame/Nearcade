//! gst-nearcade — native GStreamer capture backend (Rust port).
//!
//! Same JSON-over-stdio wire protocol as gstreamer_webrtc.py, so the Node
//! side (CaptureManager.js) cannot tell which backend produced messages.
//!
//! Modes:
//!   --mode webrtc    capture -> H264 encode -> webrtcbin + throttled preview (default)
//!   --mode webcodecs capture -> H264 encode -> appsink h264-chunk messages (+ preview)
//!   --mode list      print PipeWire video nodes as JSON and exit
//!
//! Not yet ported: XDG portal screencast (needs a D-Bus client); pass --node.

mod base;
mod ipc;
mod preview;
mod webcodecs;
mod webrtc;

use gstreamer as gst;

fn usage() -> ! {
    eprintln!(
        "gst-nearcade — native GStreamer capture backend\n\
         \n\
         Usage: gst-nearcade [options]\n\
         \n\
           --mode webrtc|webcodecs|list   pipeline mode (default: webrtc)\n\
           --node ID                      PipeWire node id/serial (else auto-detect)\n\
           --width N --height N           capture size (default 1920x1080)\n\
           --fps N                        framerate (default 30)\n\
           --bitrate N                    bits/sec (default 8000000)\n\
           --encoder x264|vaapi            H264 encoder (default x264)\n\
           --no-preview                   disable the throttled JPEG preview branch\n\
           --test-src                     use videotestsrc instead of PipeWire (headless check)\n\
           --help                         this text"
    );
    std::process::exit(2);
}

struct Args {
    mode: String,
    node: Option<String>,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    encoder: String,
    preview: bool,
    test_src: bool,
}

fn parse_args() -> Args {
    let mut a = Args {
        mode: "webrtc".to_string(),
        node: None,
        width: 1920,
        height: 1080,
        fps: 30,
        bitrate: 8_000_000,
        encoder: "x264".to_string(),
        preview: true,
        test_src: false,
    };
    let mut it = std::env::args().skip(1).peekable();
    let num = |it: &mut std::iter::Peekable<std::iter::Skip<std::env::Args>>, name: &str| -> u32 {
        it.next()
            .unwrap_or_else(|| {
                eprintln!("missing value for {name}");
                std::process::exit(2);
            })
            .parse()
            .unwrap_or_else(|_| {
                eprintln!("bad number for {name}");
                std::process::exit(2);
            })
    };
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--mode" => a.mode = it.next().unwrap_or_else(|| usage()),
            "--node" => a.node = it.next(),
            "--width" => a.width = num(&mut it, "--width"),
            "--height" => a.height = num(&mut it, "--height"),
            "--fps" => a.fps = num(&mut it, "--fps"),
            "--bitrate" => a.bitrate = num(&mut it, "--bitrate"),
            "--encoder" => a.encoder = it.next().unwrap_or_else(|| usage()),
            "--no-preview" => a.preview = false,
            "--test-src" => a.test_src = true,
            "--help" | "-h" => usage(),
            other => {
                eprintln!("unknown flag: {other}");
                usage();
            }
        }
    }
    a
}

fn test_source(_a: &Args) -> String {
    // Bare source: the mode pipelines apply their own caps downstream.
    "videotestsrc is-live=true".to_string()
}

fn main() {
    let args = parse_args();

    if args.mode == "list" {
        let nodes = base::list_nodes();
        let arr: Vec<serde_json::Value> = nodes
            .iter()
            .map(|n| {
                serde_json::json!({"id": n.id, "name": n.name, "class": n.class, "description": n.description})
            })
            .collect();
        ipc::emit(serde_json::json!({"type": "nodes", "nodes": arr}));
        return;
    }

    if let Err(e) = gst::init() {
        ipc::error(format!("GStreamer init failed: {e}"));
        std::process::exit(1);
    }

    // Resolve the capture node (auto-detect like the JS side) unless testing.
    let node = if args.test_src {
        None
    } else if let Some(n) = args.node.clone() {
        Some(n)
    } else {
        match base::find_gamescope_node() {
            Some(n) => {
                ipc::info(format!(
                    "Auto-discovered PipeWire target node: {}",
                    n.name
                ));
                Some(n.id.clone())
            }
            None => {
                ipc::error("No headless PipeWire node found (and portal is not implemented in this build). Pass --node or use --test-src for headless checks.");
                std::process::exit(2);
            }
        }
    };
    let source_override = if args.test_src {
        Some(test_source(&args))
    } else {
        None
    };

    match args.mode.as_str() {
        "webrtc" => webrtc::run(webrtc::Config {
            node,
            width: args.width,
            height: args.height,
            fps: args.fps,
            bitrate: args.bitrate,
            encoder: args.encoder,
            with_preview: args.preview,
            source_override,
        }),
        "webcodecs" => webcodecs::run(webcodecs::Config {
            node,
            width: args.width,
            height: args.height,
            fps: args.fps,
            bitrate: args.bitrate,
            encoder: args.encoder,
            with_preview: args.preview,
            source_override,
        }),
        other => {
            eprintln!("unknown mode: {other}");
            usage();
        }
    }
}
