use capture_core::{list_devices, CaptureSession, PipelineConfig, PipelineEvent};
use clap::{Parser, Subcommand};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Parser)]
#[command(
    name = "nearcade-sidecapture",
    about = "Cross-platform capture-card / webcam capture — CLI",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scan for Android ADB Wireless devices.

    AndroidScan,

    /// List available capture devices.
    List {
        /// Output as JSON instead of a human-readable table.
        #[arg(long)]
        json: bool,
    },
    /// Start capturing from a device and display it, blocking until
    /// Ctrl+C or the source stream ends.
    Start {
        /// Device id, as printed by `list` (e.g. /dev/video2 on Linux).
        #[arg(long)]
        device: String,
        #[arg(long, default_value_t = 1280)]
        width: u32,
        #[arg(long, default_value_t = 720)]
        height: u32,
        #[arg(long, default_value_t = 30)]
        fps: u32,
        #[arg(long, default_value_t = true)]
        hw_accel: bool,
        #[arg(long, default_value_t = false)]
        mirror: bool,
        #[arg(long, default_value_t = true)]
        audio: bool,
        /// Optional upscale target width. Must be paired with
        /// --upscale-height. Independent of --width/--height, which
        /// describe what's requested from the capture device itself.
        #[arg(long)]
        upscale_width: Option<u32>,
        #[arg(long)]
        upscale_height: Option<u32>,
        /// Also send the feed out over NDI (requires ndisink; see README's
        /// build notes — this needs a GStreamer build with gst-plugins-bad
        /// and NDI SDK support, which our documented from-source build
        /// disables by default).
        #[arg(long, default_value_t = false)]
        ndi: bool,
        #[arg(long, default_value = "Nearcade Sidecapture")]
        ndi_name: String,
        /// Stream raw MJPEG frames to stdout (useful for piping into ffmpeg)
        #[arg(long, default_value_t = false)]
        stdout: bool,
    },
}

fn main() {
    let cli = Cli::parse();
    if let Err(e) = capture_core::init() {
        eprintln!("failed to initialize capture backend: {e}");
        std::process::exit(1);
    }

    match cli.command {
        Command::List { json } => cmd_list(json),
        Command::AndroidScan => cmd_android_scan(),

        Command::Start {
            device,
            width,
            height,
            fps,
            hw_accel,
            mirror,
            audio,
            upscale_width,
            upscale_height,
            ndi,
            ndi_name,
            stdout,
        } => cmd_start(PipelineConfig {
            device,
            width,
            height,
            framerate: fps,
            use_hardware_accel: hw_accel,
            mirror,
            audio,
            ndi_enabled: ndi,
            ndi_name,
            upscale_to: match (upscale_width, upscale_height) {
                (Some(w), Some(h)) => Some((w, h)),
                _ => None,
            },
        }, stdout),
    }
}

fn cmd_list(json: bool) {
    let devices = list_devices();
    if json {
        println!("{}", serde_json::to_string_pretty(&devices).unwrap());
        return;
    }
    if devices.is_empty() {
        println!("No capture devices found.");
        return;
    }
    println!("{:<28} {}", "DEVICE ID", "NAME");
    for d in devices {
        println!("{:<28} {}", d.id, d.name);
    }
}

fn cmd_start(config: PipelineConfig, use_stdout: bool) {
    let mut session = CaptureSession::new();
    let rx = match session.start(config) {
        Ok(rx) => rx,
        Err(e) => {
            eprintln!("failed to start capture: {e}");
            std::process::exit(1);
        }
    };

    let running = Arc::new(AtomicBool::new(true));
    let running_ctrlc = running.clone();
    ctrlc::set_handler(move || {
        running_ctrlc.store(false, Ordering::SeqCst);
    })
    .expect("failed to set Ctrl+C handler");

    if !use_stdout {
        println!("Capturing. Press Ctrl+C to stop.");
    }

    use std::io::Write;
    let mut stdout = std::io::stdout();

    while running.load(Ordering::SeqCst) {
        match rx.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(PipelineEvent::Started) => { if !use_stdout { println!("[capture] started"); } },
            Ok(PipelineEvent::SignalLost) => { if !use_stdout { println!("[capture] signal lost"); } },
            Ok(PipelineEvent::SignalRestored) => { if !use_stdout { println!("[capture] signal restored"); } },
            Ok(PipelineEvent::Error(e)) => {
                eprintln!("[capture] error: {e}");
                break;
            }
            Ok(PipelineEvent::Eos) => {
                if !use_stdout { println!("[capture] end of stream"); }
                break;
            }
            Ok(PipelineEvent::Stopped) => break,
            Ok(PipelineEvent::Frame(bytes)) => {
                if use_stdout {
                    let _ = stdout.write_all(&bytes);
                    let _ = stdout.flush();
                }
            }
            Err(_) => continue, // timeout, just re-check `running`
        }
    }

    if let Err(e) = session.stop() {
        eprintln!("error while stopping: {e}");
    }
    if !use_stdout {
        println!("Stopped.");
    }
}

fn cmd_android_scan() {
    println!("Scanning for Android Wireless Debugging services (mDNS)...");
    let scanner = match capture_core::android::discovery::AdbScanner::new() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Failed to start scanner: {}", e);
            return;
        }
    };
    
    // Scan for a few seconds
    for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let devices = scanner.get_devices();
        if !devices.is_empty() {
            println!("Found {} device(s):", devices.len());
            for dev in devices {
                println!("- {} (IP: {}, Port: {}, Type: {:?})", dev.name, dev.ip, dev.port, dev.service_type);
            }
        }
    }
    println!("Scan finished.");
}
