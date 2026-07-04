# NearsecTogether: High-Performance Decoding Architecture Roadmap

This document outlines the strategic plan for migrating NearsecTogether's video rendering pipeline away from standard browser `<video>` decoding algorithms and towards esports-grade, low-latency decoding architectures.

## The Bottleneck: Standard WebRTC
Currently, the client uses standard WebRTC which is heavily optimized for video conferencing, not cloud gaming. The HTML5 `<video autoplay>` tag operates as a "black box," injecting unavoidable latency through built-in jitter buffers, lip-syncing algorithms, and compositor buffering. 

We have maxed out standard WebRTC performance using `playoutDelayHint = 0` and unlocking framerates. To achieve sub-1ms rendering, we must divorce WebRTC's **networking** (which is excellent) from its **decoding**.

Below are the two proposed paths to achieve this.

---

## Phase 1: Javascript WebCodecs + WebGL (Zero-Copy Pipeline)
This approach keeps the entire client within the Node.js/Javascript ecosystem while bypassing the standard `<video>` tag limits.

### Architecture
1. **WebRTC Insertable Streams:** Also known as the Breakout Box API. We intercept the raw Encoded Video Chunks (e.g., H.264 NAL units) from the WebRTC `RTCRtpReceiver` *before* they enter the browser's black-box decoder.
2. **WebCodecs API:** We feed these raw encoded chunks directly into a `VideoDecoder` instance. This API wraps the OS's native hardware decoder (NVDEC, DXVA2, VA-API).
3. **WebGL/WebGPU Rendering (Zero-Copy):** Instead of using a standard Canvas 2D (`drawImage`), which forces the browser to copy frames between GPU and CPU memory, we pass the decoded `VideoFrame` directly into a WebGL texture (`gl.texImage2D`).

### Pros & Cons
*   **Pros:** Requires no native C++ code; maintains cross-platform compatibility out of the box; dramatically reduces jitter buffer latency.
*   **Cons:** Still bound to the Chromium compositor loop and garbage collection spikes.

---

## Phase 2: The "Holy Grail" Native Node.js Addon (Bare-Metal API)
This is the architecture utilized by industry leaders like Parsec and Moonlight. It leverages Electron's Node.js backend to completely bypass the Chromium browser engine for video rendering.

### Architecture
1. **Raw Network Extraction:** We stream the raw H.264/H.265 chunks either via WebRTC Insertable Streams or entirely separate custom UDP sockets.
2. **Native C++/Rust Addon:** The data is piped into a custom Node.js Addon via N-API (or NAPI-RS).
3. **Hardware Decoder APIs:** The addon passes the chunks directly to bare-metal hardware decoders:
    *   **Windows:** DXVA2 / D3D11VA
    *   **Linux:** VA-API / VDPAU
    *   **macOS:** VideoToolbox
    *   **NVIDIA (Cross-platform):** NVDEC / CUVID
4. **Direct Overlay Rendering:** The native code renders the decoded frame directly to an OpenGL/Vulkan/DirectX surface that is superimposed *over* the Electron window. Chromium's DOM and Javascript engine are completely bypassed.

### Pros & Cons
*   **Pros:** Absolute lowest latency possible (sub-1ms decode); true zero-copy; completely immune to browser performance spikes and GC pauses.
*   **Cons:** Extremely complex to implement and maintain; requires writing and compiling native C++ code for each target operating system (Windows, Linux, macOS).

---

## Conclusion
For immediate development, **Phase 1 (WebCodecs + WebGL)** is the recommended next step. It utilizes existing foundation code in `viewer.js` and provides a massive performance leap without the maintainability overhead of native C++ hardware integration. Phase 2 should remain a long-term goal for subsequent major versions.
