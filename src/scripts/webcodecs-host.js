let _wcEncoder = null;
let _wcDataChannels = new Set();
let _wcForceKeyframe = false;
let _wcStreaming = false;
let _wcFrameSource = null;
let _wcSvcLayers = 1;
let _wcSvcEnabled = false;

async function initWebCodecsStream(frameSource, svcLayers) {
    _wcFrameSource = frameSource;
    _wcStreaming = true;
    _wcSvcLayers = svcLayers || 1;
    _wcSvcEnabled = _wcSvcLayers > 1;

    const codecStr = await _selectCodec();
    if (!codecStr) {
        console.error('[WebCodecs] No compatible codec found');
        return false;
    }

    const init = {
        output: (chunk, metadata) => {
            const buf = new Uint8Array(chunk.byteLength + 9);
            buf[0] = metadata.decoderConfig ? 0x02 : 0x01;
            new DataView(buf.buffer).setFloat64(1, chunk.timestamp, true);
            chunk.copyTo(buf.subarray(9));

            if (metadata.decoderConfig) {
                const configMsg = {
                    codec: metadata.decoderConfig.codec,
                    codedWidth: metadata.decoderConfig.codedWidth || (_wcFrameSource?.width || 1920),
                    codedHeight: metadata.decoderConfig.codedHeight || (_wcFrameSource?.height || 1080),
                    description: metadata.decoderConfig.description
                        ? Array.from(new Uint8Array(metadata.decoderConfig.description))
                        : null,
                    svcTemporalLayers: _wcSvcLayers
                };
                _broadcastJson({ type: 'webcodecs-config', ...configMsg });
            }

            for (const dc of _wcDataChannels) {
                try { if (dc.readyState === 'open') dc.send(buf.buffer); } catch (_) {}
            }
        },
        error: (e) => console.error('[WebCodecs] Encoder error:', e.message)
    };

    const config = {
        codec: codecStr,
        width: _wcFrameSource?.width || 1920,
        height: _wcFrameSource?.height || 1080,
        bitrate: 8_000_000,
        framerate: 60,
        latencyMode: 'realtime',
        hardwareAcceleration: 'prefer-hardware'
    };

    if (_wcSvcEnabled && (codecStr.startsWith('vp09') || codecStr.startsWith('av01'))) {
        config.scalabilityMode = `L1T${Math.min(_wcSvcLayers, 3)}`;
    }

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

async function _selectCodec() {
    for (const c of [
        'avc1.42002A',
        'avc1.42E01F',
        'vp8',
        'vp09.00.10.08',
        'av01.0.04M.08',
    ]) {
        try {
            const support = await VideoEncoder.isConfigSupported({ codec: c });
            if (support?.supported) return c;
        } catch (_) {}
    }
    return null;
}

function _broadcastJson(msg) {
    const str = JSON.stringify(msg);
    for (const dc of _wcDataChannels) {
        try { if (dc.readyState === 'open') dc.send(str); } catch (_) {}
    }
}

function _startCaptureLoop() {
    if (!_wcStreaming) return;

    async function processFrames() {
        if (!_wcEncoder || _wcEncoder.state !== 'configured') return;

        const frame = _wcFrameSource?.getFrame?.();
        if (frame) {
            const videoFrame = new VideoFrame(frame.data, {
                format: 'BGRA',
                codedWidth: _wcFrameSource.width,
                codedHeight: _wcFrameSource.height,
                timestamp: performance.now() * 1000
            });

            try {
                _wcEncoder.encode(videoFrame, { keyFrame: _wcForceKeyframe });
                _wcForceKeyframe = false;
            } catch (e) {
                console.error('[WebCodecs] Encode error:', e.message);
            }
            videoFrame.close();
        }

        requestAnimationFrame(processFrames);
    }

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

function updateSvcLayers(n) {
    _wcSvcLayers = Math.max(1, Math.min(n, 3));
    _wcSvcEnabled = _wcSvcLayers > 1;
    if (_wcEncoder && _wcEncoder.state === 'configured' && _wcSvcEnabled) {
        try {
            _wcEncoder.configure({ ..._wcEncoder._lastConfig, scalabilityMode: `L1T${_wcSvcLayers}` });
        } catch (_) {}
    }
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
    updateSvcLayers,
    stopStreaming
};
