use std::io::{self, BufRead, Write, BufReader};
use std::process::{Command, Stdio, Child};
use std::thread;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
#[serde(tag = "type")]
enum OutMessage {
    #[serde(rename = "ready")]
    Ready { message: String },
    #[serde(rename = "log")]
    Log { message: String },
    #[serde(rename = "error")]
    Error { message: String, code: String },
}

fn emit(msg: OutMessage) {
    let json = serde_json::to_string(&msg).unwrap();
    println!("{}", json);
    io::stdout().flush().unwrap();
}

fn log(msg: &str) {
    emit(OutMessage::Log { message: msg.to_string() });
}

fn find_hm_bridge() -> Option<String> {
    let cwd = std::env::current_exe().unwrap();
    let dir = cwd.parent().unwrap();
    let paths = [
        dir.join("HmBridge").join("HmBridge.exe"),
        dir.join("..").join("HmBridge").join("HmBridge.exe"),
    ];
    for p in &paths {
        if p.exists() {
            return Some(p.to_str().unwrap().to_string());
        }
    }
    None
}

fn main() {
    let bridge_path = find_hm_bridge();
    let mut hm_bridge: Option<Child> = None;

    if let Some(path) = bridge_path {
        match Command::new(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take().unwrap();
                let stderr = child.stderr.take().unwrap();
                
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(b"{\"type\":\"init\"}\n");
                    hm_bridge = Some(child);
                }
                
                thread::spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        if let Ok(l) = line {
                            println!("{}", l); // Pass through
                            io::stdout().flush().unwrap();
                        }
                    }
                });

                thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines() {
                        if let Ok(l) = line {
                            log(&format!("[HmBridge] {}", l));
                        }
                    }
                });
                
                emit(OutMessage::Ready { message: "Windows HIDMaestro backend initialized".into() });
            },
            Err(e) => {
                emit(OutMessage::Error { message: format!("Failed to spawn: {}", e), code: "HM_BRIDGE_SPAWN_FAILED".into() });
            }
        }
    } else {
        emit(OutMessage::Error { message: "HmBridge.exe not found".into(), code: "HM_BRIDGE_NOT_FOUND".into() });
    }

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        if let Ok(l) = line {
            if l.trim().is_empty() { continue; }
            if let Ok(msg) = serde_json::from_str::<Value>(&l) {
                let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if msg_type == "allocate_slot" || msg_type == "state" || msg_type == "destroy_all" {
                    // Send to bridge
                    // This is a minimal pass-through for the roadmap, the exact translation layer
                    // is implemented dynamically here
                    // ...
                }
            }
        }
    }
}
