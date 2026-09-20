use crate::error::CaptureError;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use serde::{Deserialize, Serialize};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

/// Configuration for a single capture pipeline run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineConfig {
    pub device: String,
    pub width: u32,
    pub height: u32,
    pub framerate: u32,
    pub use_hardware_accel: bool,
    pub mirror: bool,
    pub audio: bool,
    pub upscale_to: Option<(u32, u32)>,
    pub ndi_enabled: bool,
    pub ndi_name: String,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            device: String::new(),
            width: 1280,
            height: 720,
            framerate: 30,
            use_hardware_accel: true,
            mirror: false,
            audio: true,
            upscale_to: None,
            ndi_enabled: false,
            ndi_name: "Nearcade Sidecapture".to_string(),
        }
    }
}

/// Events streamed back from a running pipeline.
#[derive(Debug, Clone)]
pub enum PipelineEvent {
    Started,
    SignalLost,
    SignalRestored,
    Error(String),
    Eos,
    Stopped,
    /// JPEG-encoded frame for the in-app preview.
    Frame(Vec<u8>),
}

/// A live, running pipeline. Dropping without stop() still tears down via Drop.
pub struct PipelineHandle {
    pipeline: gst::Pipeline,
    videobalance: Option<gst::Element>,
    flip: Option<gst::Element>,
    /// Shared stop flag so background threads can be told to exit.
    stop_flag: Arc<AtomicBool>,
    bus_watch_thread: Option<thread::JoinHandle<()>>,
}

impl PipelineHandle {
    pub fn start(config: PipelineConfig) -> Result<(Self, Receiver<PipelineEvent>), CaptureError> {
        if config.device.is_empty() {
            return Err(CaptureError::DeviceNotFound("no device specified".into()));
        }

        let pipeline = gst::Pipeline::builder().name("capture-pipeline").build();
        let is_android = config.device.starts_with("android:");
        println!("[Capture] Building pipeline for device: {}", config.device);
        println!("[Capture] Target resolution: {}x{} @ {}fps (Upscale: {:?}, HW Accel: {}, Audio: {})",
            config.width, config.height, config.framerate, config.upscale_to, config.use_hardware_accel, config.audio
        );

        // ---- Source element ----
        let src = if is_android {
            make_element("appsrc", "src")?
        } else {
            build_platform_src(&config)?
        };

        // ---- Caps filter ----
        let capsfilter = if !is_android {
            let cf = make_element("capsfilter", "capsfilter")?;
            let caps = gst::Caps::builder_full()
                .structure(
                    gst::Structure::builder("video/x-raw")
                        .field("width", config.width as i32)
                        .field("height", config.height as i32)
                        .field("framerate", gst::Fraction::new(config.framerate as i32, 1))
                        .build(),
                )
                .structure(
                    gst::Structure::builder("image/jpeg")
                        .field("width", config.width as i32)
                        .field("height", config.height as i32)
                        .field("framerate", gst::Fraction::new(config.framerate as i32, 1))
                        .build(),
                )
                .structure(
                    gst::Structure::builder("video/x-h264")
                        .field("width", config.width as i32)
                        .field("height", config.height as i32)
                        .build(),
                )
                .build();
            cf.set_property("caps", &caps);
            Some(cf)
        } else {
            None
        };

        // ---- Decode stage ----
        let decodebin = make_element("decodebin", "decode")?;

        // ---- Convert / scale ----
        let convert = make_element("videoconvert", "convert")?;
        let scale = make_element("videoscale", "scale")?;

        // ---- Optional upscale ----
        let upscale_capsfilter = if let Some((w, h)) = config.upscale_to {
            let el = make_element("capsfilter", "upscale_caps")?;
            let upscale_caps = gst::Caps::builder("video/x-raw")
                .field("width", w as i32)
                .field("height", h as i32)
                .build();
            el.set_property("caps", &upscale_caps);
            Some(el)
        } else {
            None
        };

        // ---- Mirror ----
        let flip = make_element("videoflip", "flip")?;
        flip.set_property_from_str("method", if config.mirror { "horizontal-flip" } else { "none" });

        // ---- Brightness / contrast ----
        let videobalance = make_element("videobalance", "balance")?;

    // ---- Optional VA-API postproc removed. Hardware decoding is handled automatically by decodebin when available.

        // ---- Sink stage: tee -> appsink (preview JPEG) + optional NDI ----
        let tee = make_element("tee", "tee")?;
        let preview_queue = make_element("queue", "preview_queue")?;
        let preview_convert = make_element("videoconvert", "preview_convert")?;
        let jpegenc = make_element("jpegenc", "jpegenc")?;
        jpegenc.set_property("quality", 75i32);
        let appsink = gst::ElementFactory::make("appsink")
            .name("appsink")
            .build()
            .map_err(|_| CaptureError::MissingElement("appsink".into()))?;
        appsink.set_property("sync", false);
        appsink.set_property("max-buffers", 2u32);
        appsink.set_property("drop", true);

        let ndi_elements = if config.ndi_enabled {
            let ndi_queue = make_element("queue", "ndi_queue")?;
            let ndi_convert = make_element("videoconvert", "ndi_convert")?;
            let ndisink = gst::ElementFactory::make("ndisink")
                .name("ndisink")
                .build()
                .map_err(|_| {
                    CaptureError::MissingElement(
                        "ndisink (requires gst-plugins-bad with NDI SDK)".into(),
                    )
                })?;
            ndisink.set_property("ndi-name", &config.ndi_name);
            Some((ndi_queue, ndi_convert, ndisink))
        } else {
            None
        };

        // ---- Add elements to pipeline ----
        if let Some(ref cf) = capsfilter {
            pipeline
                .add_many([&src, cf, &decodebin])
                .map_err(|e| CaptureError::PipelineBuild(e.to_string()))?;
        } else {
            pipeline
                .add_many([&src, &decodebin])
                .map_err(|e| CaptureError::PipelineBuild(e.to_string()))?;
        }

        let mut post_decode: Vec<&gst::Element> = vec![&convert, &scale];
        if let Some(ref uc) = upscale_capsfilter {
            post_decode.push(uc);
        }
        post_decode.push(&videobalance);
        post_decode.push(&flip);
        post_decode.push(&tee);
        pipeline
            .add_many(&post_decode)
            .map_err(|e| CaptureError::PipelineBuild(e.to_string()))?;
        pipeline
            .add_many([&preview_queue, &preview_convert, &jpegenc, &appsink])
            .map_err(|e| CaptureError::PipelineBuild(e.to_string()))?;

        if let Some((ref nq, ref nc, ref ns)) = ndi_elements {
            pipeline
                .add_many([nq, nc, ns])
                .map_err(|e| CaptureError::PipelineBuild(e.to_string()))?;
        }

        // ---- Link static parts ----
        if let Some(ref cf) = capsfilter {
            gst::Element::link_many([&src, cf, &decodebin])
                .map_err(|e| CaptureError::PipelineBuild(format!("src->decode: {e}")))?;
        } else {
            gst::Element::link_many([&src, &decodebin])
                .map_err(|e| CaptureError::PipelineBuild(format!("src->decode: {e}")))?;
        }

        // Link post-decode chain
        for window in post_decode.windows(2) {
            window[0]
                .link(window[1])
                .map_err(|e| CaptureError::PipelineBuild(format!("post-decode link: {e}")))?;
        }

        // Tee -> preview branch
        let tee_preview_pad = tee
            .request_pad_simple("src_%u")
            .ok_or_else(|| CaptureError::PipelineBuild("tee: no pad".into()))?;
        let preview_sink_pad = preview_queue
            .static_pad("sink")
            .ok_or_else(|| CaptureError::PipelineBuild("preview_queue no sink".into()))?;
        tee_preview_pad
            .link(&preview_sink_pad)
            .map_err(|e| CaptureError::PipelineBuild(format!("tee->preview: {e}")))?;

        gst::Element::link_many([&preview_queue, &preview_convert, &jpegenc, &appsink])
            .map_err(|e| CaptureError::PipelineBuild(format!("preview chain: {e}")))?;

        // Tee -> NDI branch
        if let Some((ref nq, ref nc, ref ns)) = ndi_elements {
            let tee_ndi_pad = tee
                .request_pad_simple("src_%u")
                .ok_or_else(|| CaptureError::PipelineBuild("tee: no ndi pad".into()))?;
            let ndi_sink_pad = nq
                .static_pad("sink")
                .ok_or_else(|| CaptureError::PipelineBuild("ndi_queue no sink".into()))?;
            tee_ndi_pad
                .link(&ndi_sink_pad)
                .map_err(|e| CaptureError::PipelineBuild(format!("tee->ndi: {e}")))?;
            gst::Element::link_many([nq, nc, ns])
                .map_err(|e| CaptureError::PipelineBuild(format!("ndi chain: {e}")))?;
        }

        // ---- decodebin dynamic pad -> convert ----
        let convert_clone = convert.clone();
        decodebin.connect_pad_added(move |_dec, src_pad| {
            let caps = src_pad.current_caps().unwrap_or_else(gst::Caps::new_any);
            let name = caps.structure(0).map(|s| s.name().to_string()).unwrap_or_default();
            if !name.starts_with("video/") {
                return; // skip audio pads
            }
            if let Some(sink_pad) = convert_clone.static_pad("sink") {
                if !sink_pad.is_linked() {
                    let _ = src_pad.link(&sink_pad);
                }
            }
        });

        // ---- Optional audio branch ----
        if config.audio {
            if let Ok(audiosrc) = gst::ElementFactory::make(default_audio_src_name())
                .name("audiosrc")
                .build()
            {
                if let (Ok(aconvert), Ok(aresample), Ok(asink)) = (
                    make_element("audioconvert", "aconvert"),
                    make_element("audioresample", "aresample"),
                    make_element("autoaudiosink", "asink"),
                ) {
                    if pipeline.add_many([&audiosrc, &aconvert, &aresample, &asink]).is_ok() {
                        let _ = gst::Element::link_many([&audiosrc, &aconvert, &aresample, &asink]);
                    }
                }
            }
        }

        // ---- Bus & channels ----
        let bus = pipeline.bus().expect("pipeline always has a bus");
        let (tx, rx): (Sender<PipelineEvent>, Receiver<PipelineEvent>) = channel();
        let stop_flag = Arc::new(AtomicBool::new(false));

        // ---- If android: start scrcpy feeding appsrc ----
        if is_android {
            let ip_port = config.device.trim_start_matches("android:").to_string();
            let appsrc_typed = src
                .clone()
                .dynamic_cast::<gst_app::AppSrc>()
                .map_err(|_| CaptureError::PipelineBuild("appsrc cast failed".into()))?;
            
            appsrc_typed.set_is_live(true);

            let running_flag = Arc::clone(&stop_flag);
            crate::android::scrcpy_runner::start_scrcpy(&ip_port, &appsrc_typed, running_flag)
                .map_err(CaptureError::ScrcpyFailed)?;
        }

        // ---- Appsink frame callback ----
        let appsink_typed = appsink
            .clone()
            .dynamic_cast::<gst_app::AppSink>()
            .map_err(|_| CaptureError::PipelineBuild("appsink cast failed".into()))?;
        let tx_frames = tx.clone();
        appsink_typed.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = match sink.pull_sample() {
                        Ok(s) => s,
                        Err(_) => return Err(gst::FlowError::Eos),
                    };
                    let buffer = match sample.buffer() {
                        Some(b) => b,
                        None => return Ok(gst::FlowSuccess::Ok),
                    };
                    let map = match buffer.map_readable() {
                        Ok(m) => m,
                        Err(_) => return Ok(gst::FlowSuccess::Ok),
                    };
                    let _ = tx_frames.send(PipelineEvent::Frame(map.as_slice().to_vec()));
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );

        // ---- Start pipeline ----
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|_| CaptureError::StateChange("could not request Playing state".into()))?;

        let (result, _current, _pending) = pipeline.state(gst::ClockTime::from_seconds(8));
        if result.is_err() {
            // Check bus for errors to see why it failed!
            if let Some(msg) = pipeline.bus().unwrap().pop_filtered(&[gst::MessageType::Error]) {
                if let gst::MessageView::Error(err_msg) = msg.view() {
                    println!("[Capture] Pipeline error: {}", err_msg.error());
                }
            }
            let _ = pipeline.set_state(gst::State::Null);
            return Err(CaptureError::StateChange(
                "timed out waiting for device to start (busy, disconnected, or unsupported format)".into(),
            ));
        }

        // ---- Bus watch thread ----
        let tx_bus = tx.clone();
        let bus_watch_thread = thread::spawn(move || {
            watch_bus(&bus, tx_bus);
        });

        let _ = tx.send(PipelineEvent::Started);

        Ok((
            Self {
                pipeline,
                videobalance: Some(videobalance),
                flip: Some(flip),
                stop_flag,
                bus_watch_thread: Some(bus_watch_thread),
            },
            rx,
        ))
    }

    /// Stops the pipeline. `set_state(Null)` runs synchronously so the capture
    /// device is released before this returns — otherwise a rapid stop→start
    /// hits "device busy". Only the bus-thread join is deferred to a background
    /// thread so the Tauri IPC thread isn't held for long.
    pub fn stop(mut self) -> Result<(), CaptureError> {
        println!("[Capture] Stopping pipeline...");
        self.stop_flag.store(true, Ordering::SeqCst);
        // Flush bus first so iter_timed() exits immediately
        if let Some(bus) = self.pipeline.bus() {
            bus.set_flushing(true);
        }
        // Set NULL synchronously and wait for confirmation — this is what
        // actually releases the /dev/videoX file descriptor.
        let _ = self.pipeline.set_state(gst::State::Null);
        let _ = self.pipeline.state(gst::ClockTime::from_seconds(5));
        
        println!("[Capture] Pipeline destroyed, hardware released.");
        // Join bus watch thread in background so IPC thread isn't held
        if let Some(handle) = self.bus_watch_thread.take() {
            thread::spawn(move || { let _ = handle.join(); });
        }
        Ok(())
    }

    pub fn set_brightness(&self, value: i32) -> Result<(), CaptureError> {
        match &self.videobalance {
            Some(el) => {
                el.set_property("brightness", value as f64 / 50.0);
                Ok(())
            }
            None => Err(CaptureError::NotRunning),
        }
    }

    pub fn set_contrast(&self, value: i32) -> Result<(), CaptureError> {
        match &self.videobalance {
            Some(el) => {
                el.set_property("contrast", 1.0 + (value as f64 / 50.0));
                Ok(())
            }
            None => Err(CaptureError::NotRunning),
        }
    }

    pub fn set_mirror(&self, enabled: bool) -> Result<(), CaptureError> {
        match &self.flip {
            Some(el) => {
                el.set_property_from_str("method", if enabled { "horizontal-flip" } else { "none" });
                Ok(())
            }
            None => Err(CaptureError::NotRunning),
        }
    }
}

impl Drop for PipelineHandle {
    fn drop(&mut self) {
        if let Some(bus) = self.pipeline.bus() {
            bus.set_flushing(true);
        }
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

// ---- Platform-specific source builder ----

#[cfg(target_os = "linux")]
fn build_platform_src(config: &PipelineConfig) -> Result<gst::Element, CaptureError> {
    let src = make_element("v4l2src", "src")?;
    src.set_property("device", &config.device);
    Ok(src)
}

#[cfg(target_os = "windows")]
fn build_platform_src(config: &PipelineConfig) -> Result<gst::Element, CaptureError> {
    let src = make_element("mfvideosrc", "src")?;
    src.set_property("device-path", &config.device);
    Ok(src)
}

#[cfg(target_os = "macos")]
fn build_platform_src(config: &PipelineConfig) -> Result<gst::Element, CaptureError> {
    let src = make_element("avfvideosrc", "src")?;
    let idx: i32 = config.device.parse().unwrap_or(0);
    src.set_property("device-index", idx);
    Ok(src)
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn build_platform_src(_config: &PipelineConfig) -> Result<gst::Element, CaptureError> {
    Err(CaptureError::MissingElement("no video src for this platform".into()))
}

// ---- Helpers ----

fn make_element(factory_name: &str, element_name: &str) -> Result<gst::Element, CaptureError> {
    gst::ElementFactory::make(factory_name)
        .name(element_name)
        .build()
        .map_err(|_| CaptureError::MissingElement(factory_name.to_string()))
}

#[cfg(target_os = "linux")]
fn default_audio_src_name() -> &'static str { "pulsesrc" }
#[cfg(target_os = "windows")]
fn default_audio_src_name() -> &'static str { "wasapisrc" }
#[cfg(target_os = "macos")]
fn default_audio_src_name() -> &'static str { "osxaudiosrc" }
#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn default_audio_src_name() -> &'static str { "autoaudiosrc" }

fn watch_bus(bus: &gst::Bus, tx: Sender<PipelineEvent>) {
    use gst::MessageView;
    for msg in bus.iter_timed(gst::ClockTime::NONE) {
        match msg.view() {
            MessageView::Eos(_) => {
                let _ = tx.send(PipelineEvent::Eos);
                break;
            }
            MessageView::Error(err) => {
                let text = err.error().to_string();
                println!("[Capture] Bus Error: {}", text);
                let is_busy = text.to_lowercase().contains("busy")
                    || text.to_lowercase().contains("already in use");
                if is_busy {
                    let _ = tx.send(PipelineEvent::Error("Device is busy or already in use by another app".into()));
                } else {
                    let _ = tx.send(PipelineEvent::Error(text));
                }
                break;
            }
            MessageView::Element(el) => {
                if let Some(s) = el.structure() {
                    let name = s.name();
                    if name.contains("signal") || name.contains("no-signal") {
                        let _ = tx.send(if name.contains("no") {
                            PipelineEvent::SignalLost
                        } else {
                            PipelineEvent::SignalRestored
                        });
                    }
                }
            }
            _ => {}
        }
    }
    let _ = tx.send(PipelineEvent::Stopped);
}
