//! mDNS scanning for both pairing and connect services
//! Listens for `_adb-tls-pairing._tcp` and `_adb-tls-connect._tcp`.

use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const PAIRING_SERVICE: &str = "_adb-tls-pairing._tcp.local.";
const CONNECT_SERVICE: &str = "_adb-tls-connect._tcp.local.";

#[derive(Debug, Clone, PartialEq)]
pub enum AdbServiceType {
    Pairing,
    Connect,
}

#[derive(Debug, Clone)]
pub struct AdbDevice {
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub service_type: AdbServiceType,
}

/// A handle to manage background mDNS scanning
pub struct AdbScanner {
    _daemon: ServiceDaemon,
    devices: Arc<Mutex<HashMap<String, AdbDevice>>>,
}

impl AdbScanner {
    /// Starts background discovery for ADB Wireless services.
    /// Works cross-platform (macOS, Windows, Linux) because `mdns-sd` uses pure Rust sockets.
    pub fn new() -> Result<Self, String> {
        let mdns = ServiceDaemon::new().map_err(|e| format!("Failed to start mDNS: {}", e))?;
        
        let devices = Arc::new(Mutex::new(HashMap::new()));
        
        // Browse for both pairing and connect services
        let pairing_receiver = mdns.browse(PAIRING_SERVICE).map_err(|e| e.to_string())?;
        let connect_receiver = mdns.browse(CONNECT_SERVICE).map_err(|e| e.to_string())?;

        let devices_clone_p = devices.clone();
        std::thread::spawn(move || {
            while let Ok(event) = pairing_receiver.recv() {
                Self::handle_event(event, AdbServiceType::Pairing, &devices_clone_p);
            }
        });

        let devices_clone_c = devices.clone();
        std::thread::spawn(move || {
            while let Ok(event) = connect_receiver.recv() {
                Self::handle_event(event, AdbServiceType::Connect, &devices_clone_c);
            }
        });

        Ok(Self {
            _daemon: mdns,
            devices,
        })
    }

    fn handle_event(event: ServiceEvent, service_type: AdbServiceType, map: &Arc<Mutex<HashMap<String, AdbDevice>>>) {
        match event {
            ServiceEvent::ServiceResolved(info) => {
                let name = info.get_fullname().to_string();
                // Get the first IPv4 address
                let ip = info.get_addresses().iter().find(|ip| ip.is_ipv4()).map(|ip| ip.to_string());
                
                if let Some(ip) = ip {
                    let device = AdbDevice {
                        name: name.clone(),
                        ip,
                        port: info.get_port(),
                        service_type,
                    };
                    let mut lock = map.lock().unwrap();
                    lock.insert(name, device);
                }
            }
            ServiceEvent::ServiceRemoved(_service_type_str, fullname) => {
                let mut lock = map.lock().unwrap();
                lock.remove(&fullname);
            }
            _ => {}
        }
    }

    /// Returns a snapshot of currently discovered devices
    pub fn get_devices(&self) -> Vec<AdbDevice> {
        let lock = self.devices.lock().unwrap();
        lock.values().cloned().collect()
    }
}
