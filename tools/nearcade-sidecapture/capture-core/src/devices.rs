use serde::{Deserialize, Serialize};

/// A discovered capture device, in a form that's the same shape regardless
/// of which OS found it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CaptureDevice {
    /// Human-readable name, e.g. "Elgato Cam Link 4K" or "Anbernic Capture".
    pub name: String,
    /// The identifier to hand back into `PipelineConfig.device`.
    /// Linux: a path like "/dev/video2".
    /// Windows: the Media Foundation device symbolic link / friendly name
    ///          (resolved by mfvideosrc's device-index or device-path).
    /// macOS: the AVFoundation device unique ID.
    pub id: String,
}

/// Enumerates capture devices for the current OS.
///
/// Linux reads `/sys/class/video4linux` directly (no `v4l2-ctl` subprocess,
/// no text parsing). Windows and macOS enumeration goes through GStreamer's
/// own device monitor API (`gst::DeviceMonitor`), which is the correct,
/// already-cross-platform way to do this rather than hand-rolling
/// Media Foundation / AVFoundation bindings ourselves.
pub fn list_devices() -> Vec<CaptureDevice> {
    let mut devices = {
        #[cfg(target_os = "linux")]
        {
            linux::list()
        }
        #[cfg(not(target_os = "linux"))]
        {
            gst_device_monitor::list()
        }
    };

    // Append Android devices detected via ADB
    devices.extend(adb::list());

    devices
}

mod adb {
    use super::CaptureDevice;
    use std::process::Command;

    pub fn list() -> Vec<CaptureDevice> {
        let mut devices = Vec::new();

        // Resolve adb path
        #[cfg(target_os = "windows")]
        let ext = ".exe";
        #[cfg(not(target_os = "windows"))]
        let ext = "";

        let local_paths = [
            format!("./capture-gui/src-tauri/bin/scrcpy/win64/adb{ext}"),
            format!("./capture-gui/src-tauri/bin/scrcpy/linux/adb{ext}"),
        ];

        let mut adb_path = "adb".to_string();
        for path in local_paths {
            if std::path::Path::new(&path).exists() {
                adb_path = path;
                break;
            }
        }

        let output = match Command::new(&adb_path).arg("devices").output() {
            Ok(o) => o,
            Err(_) => return devices,
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines().skip(1) { // Skip "List of devices attached"
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() == 2 {
                let id = parts[0];
                let state = parts[1];
                let is_unauthorized = state == "unauthorized";
                
                let name = if is_unauthorized {
                    format!("📱 Android ({} - UNAUTHORIZED, Check Phone!)", id)
                } else if id.contains(":") {
                    format!("📱 Android Wi-Fi ({})", id)
                } else {
                    format!("📱 Android USB ({})", id)
                };

                devices.push(CaptureDevice {
                    name,
                    id: format!("android:{}", id),
                });
            }
        }

        devices
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::CaptureDevice;
    use std::fs;
    use std::path::Path;

    pub fn list() -> Vec<CaptureDevice> {
        let mut devices = Vec::new();
        let base = Path::new("/sys/class/video4linux");

        let entries = match fs::read_dir(base) {
            Ok(e) => e,
            Err(_) => return devices,
        };

        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.starts_with("video"))
            .collect();
        // Sort numerically (video2 before video10) rather than lexically.
        names.sort_by_key(|n| {
            n.trim_start_matches("video")
                .parse::<u32>()
                .unwrap_or(u32::MAX)
        });

        for name in names {
            let dev_path = format!("/dev/{name}");
            if !Path::new(&dev_path).exists() {
                continue;
            }

            // Only list devices that actually support video capture
            // (not e.g. a metadata-only node some cameras also expose).
            let caps_path = base.join(&name).join("device").join("interface");
            let friendly = fs::read_to_string(base.join(&name).join("name"))
                .unwrap_or_else(|_| dev_path.clone())
                .trim()
                .to_string();
            let _ = caps_path; // reserved: could filter by capability flags later

            devices.push(CaptureDevice {
                name: friendly,
                id: dev_path,
            });
        }

        devices
    }
}

#[cfg(not(target_os = "linux"))]
mod gst_device_monitor {
    use super::CaptureDevice;
    use gstreamer::prelude::*;

    pub fn list() -> Vec<CaptureDevice> {
        // Requires gstreamer::init() to already have been called by the
        // caller (capture_core::init()).
        let monitor = gstreamer::DeviceMonitor::new();
        let caps = gstreamer::Caps::builder("video/x-raw").build();
        let filter_id = monitor.add_filter(Some("Video/Source"), Some(&caps));

        if monitor.start().is_err() {
            return Vec::new();
        }

        let devices: Vec<CaptureDevice> = monitor
            .devices()
            .iter()
            .map(|d| CaptureDevice {
                name: d.display_name().to_string(),
                // properties() carries the backend-specific identifier
                // (device.path on most backends, or a GUID-style string on
                // Windows/macOS). We fall back to display_name if absent so
                // enumeration never silently drops a device.
                id: d
                    .properties()
                    .and_then(|p| p.get::<String>("device.path").ok())
                    .unwrap_or_else(|| d.display_name().to_string()),
            })
            .collect();

        if let Some(id) = filter_id {
            monitor.remove_filter(id);
        }
        monitor.stop();

        devices
    }
}
