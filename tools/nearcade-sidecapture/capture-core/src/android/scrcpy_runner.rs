use gstreamer_app as gst_app;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::io::Read;
// prelude pulled in via gstreamer-app re-exports

pub fn start_scrcpy(ip_port: &str, appsrc: &gst_app::AppSrc, stop_flag: Arc<AtomicBool>) -> Result<(), String> {
    // Attempt to locate the bundled scrcpy, fallback to system PATH
    let mut bin_path = "scrcpy".to_string();
    
    // In Tauri, resources are typically relative, but since we are running as a sidecar/resource, 
    // we can attempt a few paths. Or we just rely on the user running it properly.
    #[cfg(target_os = "windows")]
    let ext = ".exe";
    #[cfg(not(target_os = "windows"))]
    let ext = "";
    
    let local_paths = [
        format!("./capture-gui/src-tauri/bin/scrcpy/win64/scrcpy{ext}"),
        format!("./capture-gui/src-tauri/bin/scrcpy/linux/scrcpy{ext}"),
        // In a real tauri bundle, the path would be resolved via tauri::api::path::resource_dir, 
        // but for development and CLI we check local paths.
    ];
    
    for path in local_paths {
        if std::path::Path::new(&path).exists() {
            bin_path = path;
            break;
        }
    }

    // Ensure the folder containing scrcpy is in PATH so it finds the bundled adb
    let bin_dir = std::path::Path::new(&bin_path).parent().unwrap().to_string_lossy().to_string();
    let current_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir, current_path);

    let mut cmd = Command::new(&bin_path);
    cmd.env("PATH", new_path);
    cmd.env("SDL_VIDEODRIVER", "dummy"); // Prevent physical window from opening

    if ip_port == "usb" {
        cmd.arg("-d");
    } else if !ip_port.is_empty() {
        cmd.arg("-s").arg(ip_port);
    }

    println!("[scrcpy] Launching: {:?}", cmd);

    #[cfg(target_os = "windows")]
    let record_target = "-".to_string();
    
    #[cfg(not(target_os = "windows"))]
    let fifo_path = format!("/tmp/nearcade_scrcpy_{}.mkv", std::process::id());
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::fs::remove_file(&fifo_path);
        let _ = Command::new("mkfifo").arg(&fifo_path).output();
    }
    #[cfg(not(target_os = "windows"))]
    let record_target = fifo_path.clone();

    #[cfg(target_os = "windows")]
    let mut child = cmd
        .arg("--no-audio")
        .arg("--gamepad=uhid")
        .arg("--no-playback")
        .arg("--max-fps=60")
        .arg("--video-codec=h264")
        .arg("-V")
        .arg("error")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to spawn scrcpy: {}", e))?;

    #[cfg(not(target_os = "windows"))]
    let child = cmd
        .arg("--no-audio")
        .arg("--gamepad=uhid")
        .arg("--no-playback")
        .arg("--max-fps=60")
        .arg("--video-codec=h264")
        .arg("-V")
        .arg("error") // suppress scrcpy logs from polluting stdout MKV stream
        .arg(format!("--record={}", record_target))
        .arg("--record-format=mkv")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit()) // <--- Let user see "Device unauthorized" in the terminal
        .spawn()
        .map_err(|e| format!("Failed to spawn scrcpy: {}", e))?;

    #[cfg(target_os = "windows")]
    let mut pipe: Box<dyn Read + Send> = Box::new(child.stdout.take().unwrap());
    
    #[cfg(not(target_os = "windows"))]
    let mut pipe: Box<dyn Read + Send> = Box::new(
        std::fs::File::open(&fifo_path)
            .map_err(|e| format!("Failed to open FIFO: {}", e))?
    );

    let appsrc_clone = appsrc.clone();
    let child_arc = Arc::new(std::sync::Mutex::new(child));
    let child_arc_clone = Arc::clone(&child_arc);
    let stop_flag_clone = Arc::clone(&stop_flag);
    
    // Watcher thread to kill scrcpy when stop_flag is set
    thread::spawn(move || {
        while !stop_flag_clone.load(Ordering::SeqCst) {
            thread::sleep(std::time::Duration::from_millis(100));
        }
        let mut child = child_arc_clone.lock().unwrap();
        let _ = child.kill();
    });

    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while !stop_flag.load(Ordering::SeqCst) {
            match pipe.read(&mut buffer) {
                Ok(0) => {
                    let _ = appsrc_clone.end_of_stream();
                    break;
                }
                Ok(n) => {
                    let buf = gstreamer::Buffer::from_mut_slice(buffer[..n].to_vec());
                    if appsrc_clone.push_buffer(buf).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    println!("[Capture] scrcpy read error: {}", e);
                    break;
                }
            }
        }
        let _ = child_arc.lock().unwrap().kill();
        #[cfg(not(target_os = "windows"))]
        let _ = std::fs::remove_file(&fifo_path);
    });

    Ok(())
}
