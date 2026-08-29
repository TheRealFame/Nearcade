# Nearcade Rust Sidecar Transition Roadmap

This document serves as a checklist and architecture plan for transitioning all Python virtual input sidecars to native Rust binaries to eliminate `9009` path errors, PyInstaller bloat, and Windows Defender false positives.

## Core Strategy
Because `InputOrchestrator.js` explicitly looks for native `.exe` or `.bin` files inside the `src/sidecar/input_backends/bin/` folder before falling back to `.py` scripts, we can incrementally replace the Python sidecars **one at a time**. If the Rust binary exists, it runs; if not, it safely falls back to the Python version.

---

### Phase 1: Windows (In Progress)
- [x] **Scaffold `windows_vigem` in Rust** (using `vigem-client` and `enigo`).
- [x] Create standardized JSON parsing (`stdin`) and UDP binary handling matching the Python protocol.
- [ ] Test the `windows_vigem.exe` binary natively on a Windows machine to verify virtual gamepad injection via ViGEmBus.
- [ ] Test KBM (Keyboard/Mouse) injection via `enigo` on Windows.
- [ ] **Port `windows_hidmaestro`** to Rust, writing the FFI struct definitions to pass input data to the HIDMaestro kernel driver natively.

### Phase 2: Linux 
- [ ] **Port `linux_uinput`** to Rust.
  - Utilize the Rust `evdev` crate to create `uinput` virtual devices.
  - Replicate absolute/relative mouse, Xbox 360, DualShock 4, and standard Keyboard definitions.
  - Replicate the `pkexec`/`sudo` capability checking present in the Python script.
- [ ] Test Linux virtual devices using `npm test` and `bin/verify.js` headless suite.

### Phase 3: Local Gamepad Reading (Cross-Platform)
- [ ] **Port `read_gamepads`** to Rust.
  - Utilize the `gilrs` (Game Input Library for Rust) crate.
  - Streamline local controller detection on Windows/Mac/Linux.
  - Ensure hot-plugging events emit the exact same JSON format back to the host UI.

### Phase 4: macOS
- [ ] **Port `mac_gamepad_bridge` & `mac_stub`** to Rust.
  - Utilize the `core-foundation` and `objc2` crates to interface with macOS's native `IOKit` / `VirtualHIDManager`.
  - Handle tricky MacOS sandbox permissions properly to inject virtual hardware securely.

---

### Phase 5: CI/CD Pipeline Architecture
- [x] **Establish a dedicated GitHub Actions Workflow** (`build-rust-sidecars.yml`).
  - This workflow isolates the compilation of Rust sidecars. 
  - Checks if files within `src/sidecar/input_backends/rust_*` have been modified.
  - Uses `cargo-xwin` (or matrix OS builds) to compile Linux `.bin`, macOS `.bin`, and Windows `.exe` targets natively.
  - Caches the build outputs to dramatically speed up `release.yml`.
- [ ] Deprecate and remove Nuitka build steps from `release.yml` once all sidecars reach stability parity.

## Transition Stability Guarantee
During this transition, **do not delete the Python files immediately.**
If a Rust driver is found to be unstable (e.g. causes kernel panics, fails to inject properly), you can simply delete the `.exe`/`.bin` file from the `bin/` directory, and `InputOrchestrator.js` will immediately and seamlessly fallback to the stable Python equivalent.
