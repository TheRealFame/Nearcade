// #9: Host-side WebCodecs + DataChannel video transport
// Alternative video path: encodes frames with WebCodecs VideoEncoder and sends
// encoded NAL units over the unordered DataChannel. Bypasses the WebRTC media
// pipeline's jitter buffer entirely. The viewer decodes with WebCodecs VideoDecoder.

let _wcEncoder = null;
let _wcDataChannels = new Set();
let _wcForceKeyframe = false;
let _wcStreaming = false;
let _wcFrameSource = null; // { getFrame() -> { data: Buffer, width, height } }

function initWebCodecsStream(frameSource) {
    _wcFrameSource = frameSource;
    _wcStreaming = true;

    const codecStr = _selectCodec();
    if (!codecStr) {
        console.error('[WebCodecs] No compatible codec found');
        return false;
    }

    const init = {
        output: (chunk, metadata) => {
            // Send encoded chunk to all connected viewers via DataChannel
            const buf = new Uint8Array(chunk.byteLength + 1);
            buf[0] = metadata.decoderConfig ? 0x02 : 0x01; // 0x01=frame, 0x02=config
            chunk.copyTo(buf.subarray(1));
            for (const dc of _wcDataChannels) {
                try {
                    if (dc.readyState === 'open') dc.send(buf.buffer);
                } catch (_) {}
            }
        },
        error: (e) => console.error('[WebCodecs] Encoder error:', e.message)
    };

    const config = {
        codec: codecStr,
        width: _wcFrameSource.width || 1920,
        height: _wcFrameSource.height || 1080,
        bitrate: 8_000_000,
        framerate: 60,
        latencyMode: 'realtime',
        hardwareAcceleration: 'prefer-hardware'
    };

    try {
        _wcEncoder = new VideoEncoder(init);
        _wcEncoder.configure(config);
    } catch (e) {
        console.error('[WebCodecs] Failed to create encoder:', e.message);
        return false;
    }

    _startCaptureLoop();
    return true;
}

function _selectCodec() {
    // Try H264 (baseline) first, fall back to VP9
    for (const c of [
        'avc1.42002A', // H264 Constrained Baseline
        'avc1.42E01F', // H264 Constrained Baseline (alt)
        'vp09.00.10.08', // VP9
        'vp8', // VP8
    ]) {
        if (VideoEncoder.isConfigSupported({ codec: c }).supported) return c;
    }
    return null;
}

function _startCaptureLoop() {
    if (!_wcStreaming) return;

    async function processFrames() {
        if (!_wcEncoder || _wcEncoder.state !== 'configured') return;

        const frame = _wcFrameSource.getFrame();
        if (frame) {
            const videoFrame = new VideoFrame(frame.data, {
                format: 'BGRA',
                codedWidth: _wcFrameSource.width,
                codedHeight: _wcFrameSource.height,
                timestamp: performance.now() * 1000
            });

            const keyFrame = _wcForceKeyframe;
            _wcForceKeyframe = false;

            try {
                _wcEncoder.encode(videoFrame, { keyFrame });
            } catch (e) {
                console.error('[WebCodecs] Encode error:', e.message);
            }
            videoFrame.close();
        }

        requestAnimationFrame(processFrames);
    }

    // Force keyframe every 500ms
    setInterval(() => { _wcForceKeyframe = true; }, 500);

    requestAnimationFrame(processFrames);
}

function addViewerDataChannel(dc) {
    _wcDataChannels.add(dc);
    dc.addEventListener('close', () => _wcDataChannels.delete(dc));
}

function removeViewerDataChannel(dc) {
    _wcDataChannels.delete(dc);
}

function forceKeyframe() {
    _wcForceKeyframe = true;
}

function stopStreaming() {
    _wcStreaming = false;
    _wcDataChannels.clear();
    if (_wcEncoder) {
        _wcEncoder.close();
        _wcEncoder = null;
    }
}

module.exports = {
    initWebCodecsStream,
    addViewerDataChannel,
    removeViewerDataChannel,
    forceKeyframe,
    stopStreaming
};
