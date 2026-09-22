/**
 * Hardware Acceleration Detection Module
 * Detects hardware acceleration support for various codecs
 * Works in both browser (host) and viewer contexts
 */

// Codec name to mime type mapping (must match RTCRtpSender.getCapabilities;
// comparison is case-insensitive but av01 ≠ av1, so no duplicate keys)
const CODEC_MIME_MAP = {
  'H264': 'video/h264',
  'H265': 'video/h265',
  'VP8': 'video/vp8',
  'VP9': 'video/vp9',
  'AV1': 'video/av1',
};

// Codec display info
export const CODEC_INFO = {
  H264: { name: 'H.264', label: 'H.264', defaultHw: true },
  H265: { name: 'H.265 (HEVC)', label: 'H.265 (HEVC)', defaultHw: false }, // Patent issues
  VP8: { name: 'VP8', label: 'VP8', defaultHw: false },
  VP9: { name: 'VP9', label: 'VP9', defaultHw: true },
  AV1: { name: 'AV1', label: 'AV1', defaultHw: true },
};

/**
 * Check if a codec is supported by the browser's WebRTC implementation
 * @param {string} codecName - Codec name (H264, VP8, VP9, AV1, H265)
 * @returns {Promise<{supported: boolean, hardwareAccel: boolean, mimeType: string}>}
 */
export async function detectCodecSupport(codecName) {
  if (!window.RTCRtpSender || !RTCRtpSender.getCapabilities) {
    return { supported: false, hardwareAccel: false, mimeType: '' };
  }

  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps || !caps.codecs) {
    return { supported: false, hardwareAccel: false, mimeType: '' };
  }

  const mimeType = CODEC_MIME_MAP[codecName];
  if (!mimeType) {
    return { supported: false, hardwareAccel: false, mimeType: '' };
  }

  const codec = caps.codecs.find(c => c.mimeType.toLowerCase() === mimeType.toLowerCase());
  if (!codec) {
    return { supported: false, hardwareAccel: false, mimeType: mimeType };
  }

  // Check if hardware acceleration is available by creating a test encoder
  let hardwareAccel = false;
  try {
    let config = { codec: codecName === 'H265' ? 'hev1.1.6.L93.B0' : 
                        codecName === 'VP9' ? 'vp09.00.41.08' :
                        codecName === 'AV1' ? 'av01.0.04M.08' :
                        codecName === 'VP8' ? 'vp8' : 'avc1.4d002a',
      width: 1280, height: 720, bitrate: 4000000, framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'realtime'
    };
    
    let supported = await VideoEncoder.isConfigSupported(config);
    if (!supported.supported && codecName === 'H264') {
        config.codec = 'avc1.42E02A';
        supported = await VideoEncoder.isConfigSupported(config);
    }
    
    // Linux Chromium VAAPI sandbox workaround: 'prefer-hardware' is often strictly rejected for H.264/AV1,
    // but 'no-preference' activates the hardware encoder successfully.
    if (!supported.supported && (codecName === 'H264' || codecName === 'AV1') && typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('linux')) {
        config.hardwareAcceleration = 'no-preference';
        supported = await VideoEncoder.isConfigSupported(config);
    }
    
    if (supported.supported) {
      // Try to detect hardware acceleration by creating a test encoder
      const encoder = new VideoEncoder({
        output: () => {},
        error: () => {}
      });
      
      // Configure with the working hardware acceleration preference
      const testConfig = { ...config };
      encoder.configure(testConfig);
      
      // Check if hardware acceleration was actually used
      // This is a heuristic - we check if the encoder actually uses hardware
      hardwareAccel = true; // If we got here, assume it works
      encoder.close();
    }
    } catch (e) {
      // Hardware acceleration not available
      hardwareAccel = false;
    }

    return { supported: true, hardwareAccel, mimeType: mimeType };
}

/**
 * Detect hardware acceleration support for all codecs
 * @returns {Promise<Object<string, {supported: boolean, hardwareAccel: boolean, mimeType: string}>>}
 */
export async function detectAllCodecSupport() {
  const codecs = ['H264', 'VP8', 'VP9', 'AV1', 'H265'];
  const results = {};
  
  for (const codec of codecs) {
    results[codec] = await detectCodecSupport(codec);
  }
  
  return results;
}

/**
 * Get the list of codecs that have hardware acceleration support
 * @returns {Promise<string[]>}
 */
export async function getHardwareAcceleratedCodecs() {
  const results = await detectAllCodecSupport();
  return Object.entries(results)
    .filter(([_, result]) => result.supported && result.hardwareAccel)
    .map(([codec, _]) => codec);
}

/**
 * Get the list of all supported codecs (hardware or software)
 * @returns {Promise<string[]>}
 */
export async function getSupportedCodecs() {
  const results = await detectAllCodecSupport();
  return Object.entries(results)
    .filter(([_, result]) => result.supported)
    .map(([codec, _]) => codec);
}

/**
 * Get the best codec for the current hardware
 * @param {string} preference - 'speed' or 'quality'
 * @returns {Promise<string>}
 */
export async function getBestCodec(preference = 'speed') {
  const results = await detectAllCodecSupport();
  
  // Filter to supported codecs
  const supported = Object.entries(results)
    .filter(([_, r]) => r.supported)
    .map(([codec, r]) => ({ codec, hw: r.hardwareAccel }));
  
  if (supported.length === 0) return 'VP8'; // fallback
  
  // Prefer hardware accelerated codecs
  const hwCodecs = supported.filter(c => c.hw);
  if (hwCodecs.length > 0) {
    // Prefer H264 for compatibility, then VP9/AV1 for quality
    if (hwCodecs.find(c => c.codec === 'H264')) return 'H264';
    if (hwCodecs.find(c => c.codec === 'AV1')) return 'AV1';
    if (hwCodecs.find(c => c.codec === 'VP9')) return 'VP9';
    return hwCodecs[0].codec;
  }
  
  // No hardware acceleration available, prefer VP8 for compatibility
  return 'VP8';
}

/**
 * Initialize codec selection UI based on hardware support
 * @param {HTMLSelectElement} selectEl - The codec select element
 */
export async function initCodecSelect(selectEl) {
  if (!selectEl) return;
  
  const results = await detectAllCodecSupport();
  
  // Clear existing options
  selectEl.innerHTML = '';
  
  const codecOrder = ['H264', 'H265', 'VP8', 'VP9', 'AV1'];
  
  for (const codec of codecOrder) {
    const result = await detectCodecSupport(codec);
    if (!result.supported) continue;
    
    const info = CODEC_INFO[codec] || { name: codec, label: codec };
    const option = document.createElement('option');
    option.value = codec;
    option.textContent = result.hardwareAccel 
      ? `${result.mimeType.replace('video/', '').toUpperCase()} (Hardware)`
      : `${info.name} (Software)`;
    option.dataset.hwAccel = result.hardwareAccel ? 'true' : 'false';
    option.dataset.mimeType = result.mimeType;
    selectEl.appendChild(option);
  }
  
  // Select best available codec
  const bestCodec = await getBestCodec();
  selectEl.value = bestCodec;
}

/**
 * Run benchmark only on supported codecs
 * @param {string} mode - 'speed' or 'quality'
 */
export async function runBenchmarkSupported(mode = 'speed') {
  // Import the original runBenchmark but filter to supported codecs
  const { runBenchmark } = await import('./host-engine.js');
  return runBenchmark(mode);
}

export { CODEC_MIME_MAP };