# NearsecVR SteamVR Driver

This folder contains the source code for the experimental NearsecVR SteamVR C++ driver. 
When compiled and placed into your SteamVR drivers folder, it spawns a virtual VR Headset and controllers in SteamVR that mirror the movements sent by remote viewers connecting to NearsecTogether via a WebXR-compatible browser.

## Requirements

1. **CMake** (v3.10 or higher)
2. **C++14 Compiler** (GCC, Clang, or MSVC)
3. **OpenVR SDK** (from Valve)

## Setup & Compilation

### Step 1: Download the OpenVR SDK
You must download the official OpenVR SDK and place it into this directory.
1. Download or clone the OpenVR SDK from GitHub: `https://github.com/ValveSoftware/openvr`
2. Extract it into this directory so that the path looks like this:
   `src/sidecar/input_backends/experimental/steamvr_driver/openvr/headers/openvr_driver.h`

### Step 2: Build with CMake (Windows)
Open a Developer Command Prompt (e.g. Visual Studio) or use CMake GUI:
```cmd
cd src/sidecar/input_backends/experimental/steamvr_driver/
mkdir build
cd build
cmake ..
cmake --build . --config Release
```

### Step 2: Build with CMake (Linux)
```bash
cd src/sidecar/input_backends/experimental/steamvr_driver/
mkdir build
cd build
cmake ..
make
```

### Step 3: Installation
Once compiled, you will have a shared library file:
- **Windows**: `driver_nearsecvr.dll`
- **Linux**: `driver_nearsecvr.so`

To install it into SteamVR:
1. Navigate to your SteamVR drivers directory (usually `C:\Program Files (x86)\Steam\steamapps\common\SteamVR\drivers\` on Windows, or `~/.local/share/Steam/steamapps/common/SteamVR/drivers/` on Linux).
2. Create a new folder named `nearsecvr`.
3. Inside it, create `bin/win64/` (or `bin/linux64/`).
4. Copy the compiled `.dll` or `.so` into that folder.
5. Create a `driver.vrdrivermanifest` file in the `nearsecvr` folder with the following content:
```json
{
  "name": "nearsecvr",
  "version": "1.0",
  "alwaysActivate": true
}
```
6. Restart SteamVR. The virtual headset should now appear, waiting for UDP packets from `backend_vr.py`!
