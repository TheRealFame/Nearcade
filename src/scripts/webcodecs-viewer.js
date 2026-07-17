let _wcDecoder = null;
let _wcCanvas = null;
let _wcCtx = null;
let _wcConfigReceived = false;
let _wcInit = false;
let _wcSvcLayer = 0;
let _wcSvcMaxLayers = 1;

// Tier 1 frame prediction: hold-last-blend
let _wcLastFrame = null;
let _wcPredicted = null;
let _wcPredictionTimer = null;

function initWebCodecsViewer(canvasId) {
    _wcCanvas = document.getElementById(canvasId);
    if (!_wcCanvas) {
        _wcCanvas = document.createElement('canvas');
        _wcCanvas.id = canvasId || 'wc-canvas';
        _wcCanvas.style.cssText = 'width:100%;height:100%;object-fit:contain';
        document.body.appendChild(_wcCanvas);
    }
    _wcCtx = _wcCanvas.getContext('2d');

    const init = {
        output: (videoFrame) => {
            _wcCanvas.width = videoFrame.codedWidth;
            _wcCanvas.height = videoFrame.codedHeight;
            _wcCtx.drawImage(videoFrame, 0, 0);
            _wcLastFrame = _wcCtx.getImageData(0, 0, _wcCanvas.width, _wcCanvas.height);
            _wcPredicted = null;
            if (_wcPredictionTimer) {
                clearTimeout(_wcPredictionTimer);
                _wcPredictionTimer = null;
            }
            videoFrame.close();
        },
        error: (e) => console.error('[WebCodecs] Decoder error:', e.message)
    };

    try {
        _wcDecoder = new VideoDecoder(init);
        _wcInit = true;
    } catch (e) {
        console.error('[WebCodecs] Failed to create decoder:', e.message);
        return false;
    }

    return true;
}

function onWcDataChannelMessage(data) {
    if (!_wcDecoder || !_wcInit) return;

    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);

    if (buf[0] === 0x02) {
        const configData = buf.subarray(9);
        try {
            const configStr = new TextDecoder().decode(configData);
            const config = JSON.parse(configStr);
            const codecConfig = {
                codec: config.codec,
                codedWidth: config.codedWidth,
                codedHeight: config.codedHeight,
                description: config.description ? new Uint8Array(config.description) : undefined
            };
            _wcDecoder.configure(codecConfig);
            _wcConfigReceived = true;
            _wcSvcMaxLayers = config.svcTemporalLayers || 1;
        } catch (_) {}
        return;
    }

    if (buf[0] === 0x01) {
        if (!_wcConfigReceived) return;

        const chunkData = buf.subarray(9);
        const chunk = new EncodedVideoChunk({
            type: 'key',
            timestamp: performance.now() * 1000,
            data: chunkData
        });

        try {
            _wcDecoder.decode(chunk);
        } catch (e) {
            console.error('[WebCodecs] Decode error:', e.message);
        }
    }
}

function renderPredictedFrame() {
    if (!_wcCanvas || !_wcCtx || !_wcLastFrame) return;
    if (_wcPredicted) {
        _wcCtx.putImageData(_wcPredicted, 0, 0);
    }
}

function onInputSentForPrediction() {
    if (!_wcLastFrame || _wcPredicted) return;
    _wcPredicted = _wcLastFrame;
    _wcPredictionTimer = setTimeout(() => {
        _wcPredicted = null;
    }, 50);
}

function setSvcLayer(n) {
    _wcSvcLayer = Math.max(0, Math.min(n, _wcSvcMaxLayers - 1));
    if (typeof ws !== 'undefined' && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'svc-layer-preference', layer: _wcSvcLayer }));
    }
}

function requestWcKeyframe() {
    if (typeof ws !== 'undefined' && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'request-keyframe', viewerId: typeof myId !== 'undefined' ? myId : null }));
    }
}

function closeWebCodecs() {
    if (_wcDecoder) {
        _wcDecoder.close();
        _wcDecoder = null;
    }
    _wcInit = false;
    _wcConfigReceived = false;
    _wcLastFrame = null;
    _wcPredicted = null;
    if (_wcPredictionTimer) {
        clearTimeout(_wcPredictionTimer);
        _wcPredictionTimer = null;
    }
}

module.exports = {
    initWebCodecsViewer,
    onWcDataChannelMessage,
    renderPredictedFrame,
    onInputSentForPrediction,
    setSvcLayer,
    requestWcKeyframe,
    closeWebCodecs
};
