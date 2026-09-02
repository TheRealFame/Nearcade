// Nearcade — Windows loopback audio capture sidecar
//
// Windows equivalent of sidecar/audio/audio_driver.py's PulseAudio Global
// Mirror. Captures the current default render (output) device via WASAPI
// loopback — the built-in Windows mechanism for "what's currently playing"
// — no VB-Cable, no driver install, no admin rights required.
//
// Loopback mechanism (per Microsoft's documented pattern and this crate's
// examples): open the default RENDER device, then initialize its
// IAudioClient with Direction::Capture. That direction/device mismatch is
// what puts WASAPI into loopback mode under the hood (AUDCLNT_STREAMFLAGS_
// LOOPBACK) — there is no separate boolean flag in this crate version.
//
// Wire contract (must match audio_driver.py exactly, consumed by
// scripts/server.js -> scripts/viewer.js):
//   stdout: raw mono 16-bit signed little-endian PCM @ 48000 Hz, no framing.
//   stderr: freeform diagnostic lines (server.js runs with stdio: 'inherit'
//           on stderr, same as the Python script).
//
// Resolves the default device at startup only, matching audio_driver.py's
// get_default_sink() behavior (server.js kills and respawns this process on
// each "start-audio-fallback" message, so a device change mid-session is
// handled by a restart rather than hot-swapping here).

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use wasapi::{
    initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};

const TARGET_RATE: u32 = 48_000;

fn log(msg: &str) {
    eprintln!("[windows_audio_loopback] {}", msg);
    let _ = io::stderr().flush();
}

/// Downmix interleaved f32 samples from `channels` channels to mono f32.
fn downmix_to_mono_f32(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for frame in 0..frames {
        let base = frame * channels;
        let mut sum = 0.0f32;
        for ch in 0..channels {
            sum += interleaved[base + ch];
        }
        out.push(sum / channels as f32);
    }
    out
}

/// Naive linear-interpolation resampler. Good enough for a live-monitoring
/// audio fallback (not archival quality) — mirrors the tradeoff audio_driver.py
/// already makes by reading fixed-size PyAudio chunks without a proper SRC.
fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = *input.get(idx).unwrap_or(&0.0);
        let b = *input.get(idx + 1).unwrap_or(&a);
        out.push(a + (b - a) * frac);
    }
    out
}

fn f32_to_pcm16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        let v = (clamped * i16::MAX as f32) as i16;
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

/// Reinterpret a raw byte buffer (naturally aligned WASAPI output) as f32
/// samples without pulling in bytemuck for one cast.
fn bytes_as_f32(bytes: &[u8]) -> &[f32] {
    let len = bytes.len() / 4;
    unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const f32, len) }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    initialize_mta().ok()?;

    let enumerator = DeviceEnumerator::new()?;
    // Loopback trick: open the RENDER (output) device, but initialize its
    // client for Capture direction below. This is what puts WASAPI into
    // loopback mode — see module doc comment.
    let device = enumerator.get_default_device(&Direction::Render)?;
    log(&format!(
        "Default render device: {}",
        device.get_friendlyname().unwrap_or_default()
    ));

    let mut audio_client = device.get_iaudioclient()?;

    // Query the device's own mix format — loopback capture must match what
    // the device is actually rendering; WASAPI does not convert for us here.
    let mix_format = audio_client.get_mixformat()?;
    let src_rate = mix_format.get_samplespersec();
    let src_channels = mix_format.get_nchannels() as usize;
    let is_float = matches!(mix_format.get_subformat(), Ok(SampleType::Float));
    log(&format!(
        "Device mix format: {} Hz, {} ch, float={} — resampling to {} Hz mono",
        src_rate, src_channels, is_float, TARGET_RATE
    ));

    let (_def_time, min_time) = audio_client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: false,
        buffer_duration_hns: min_time,
    };

    // Direction::Capture on a Render-direction device = loopback capture.
    audio_client.initialize_client(&mix_format, &Direction::Capture, &mode)?;
    log("Loopback capture stream initialized");

    let h_event = audio_client.set_get_eventhandle()?;
    let capture_client = audio_client.get_audiocaptureclient()?;

    let blockalign = mix_format.get_blockalign() as usize;
    let buffer_frame_count = audio_client.get_buffer_size()? as usize;
    let mut sample_queue: VecDeque<u8> =
        VecDeque::with_capacity(blockalign * (buffer_frame_count * 4 + 4096));

    let running = Arc::new(AtomicBool::new(true));
    {
        let running = running.clone();
        ctrlc_shim::set_handler(move || running.store(false, Ordering::SeqCst));
    }

    audio_client.start_stream()?;
    log("Capture stream started — streaming to stdout");

    let stdout = io::stdout();
    let mut out_lock = stdout.lock();

    // Read in chunks of ~20ms worth of frames to keep latency low while
    // still batching syscalls.
    let chunk_frames = (src_rate as usize / 50).max(1);

    while running.load(Ordering::SeqCst) {
        if h_event.wait_for_event(200).is_err() {
            continue;
        }

        if let Err(e) = capture_client.read_from_device_to_deque(&mut sample_queue) {
            log(&format!("read_from_device_to_deque error: {e}"));
            continue;
        }

        while sample_queue.len() >= blockalign * chunk_frames {
            let mut raw = vec![0u8; blockalign * chunk_frames];
            for byte in raw.iter_mut() {
                *byte = match sample_queue.pop_front() {
                    Some(b) => b,
                    None => break,
                };
            }

            if !is_float {
                log("Unsupported non-float mix format from device — skipping packet");
                continue;
            }

            let interleaved = bytes_as_f32(&raw);
            let mono = downmix_to_mono_f32(interleaved, src_channels);
            let resampled = resample_linear(&mono, src_rate, TARGET_RATE);
            let pcm16 = f32_to_pcm16_bytes(&resampled);

            if out_lock.write_all(&pcm16).is_err() {
                // Downstream (Node) closed the pipe — server.js killed us.
                running.store(false, Ordering::SeqCst);
                break;
            }
            let _ = out_lock.flush();
        }
    }

    log("Stopping capture stream");
    let _ = audio_client.stop_stream();
    Ok(())
}

/// Tiny inline Ctrl+C handler so we don't add the `ctrlc` crate for one
/// signal hook. server.js's audioProc.kill() terminates the process
/// directly on Windows, so this mainly matters for manual/dev invocation.
mod ctrlc_shim {
    use std::sync::Once;
    static INIT: Once = Once::new();
    static mut HANDLER: Option<Box<dyn Fn() + Send + 'static>> = None;

    pub fn set_handler<F: Fn() + Send + 'static>(f: F) {
        unsafe {
            HANDLER = Some(Box::new(f));
        }
        INIT.call_once(|| {
            #[cfg(windows)]
            unsafe {
                windows_console::SetConsoleCtrlHandler(Some(handler), 1);
            }
        });
    }

    #[cfg(windows)]
    extern "system" fn handler(_ctrl_type: u32) -> i32 {
        unsafe {
            if let Some(h) = (&raw const HANDLER).as_ref().and_then(|o| o.as_ref()) {
                h();
            }
        }
        1
    }

    #[cfg(windows)]
    mod windows_console {
        #[link(name = "kernel32")]
        extern "system" {
            pub fn SetConsoleCtrlHandler(
                handler: Option<extern "system" fn(u32) -> i32>,
                add: i32,
            ) -> i32;
        }
    }
}

fn main() {
    if let Err(e) = run() {
        log(&format!("FATAL: {e}"));
        std::process::exit(1);
    }
}
