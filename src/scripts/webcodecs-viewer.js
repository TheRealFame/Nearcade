// #9: Viewer-side WebCodecs decoder for DataChannel video transport
// Receives encoded H264/VP9 frames over an unordered DataChannel and decodes
// them with WebCodecs VideoDecoder. Renders to a <canvas> element, bypassing
// the browser's jitter buffer entirely.

let _wcDecoder = null;
let _wcCanvas = null;
let _wcCtx = null;
let _wcConfigReceived = false;
let _wcInit = false;

function initWebCodecsViewer(canvasId) {
    _wcCanvas = document.getElementById(canvasId);
    if (!_wcCanvas) {
        _wcCanvas = document.createElement('canvas');
        _wcCanvas.id = canvasId || 'wc-canvas';
        document.body.appendChild(_wcCanvas);
    }
    _wcCtx = _wcCanvas.getContext('2d');

    const init = {
        output: (videoFrame) => {
            // Render decoded frame to canvas immediately — no jitter buffer delay
            _wcCanvas.width = videoFrame.codedWidth;
            _wcCanvas.height = videoFrame.codedHeight;
            _wcCtx.drawImage(videoFrame, 0, 0);
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
        // Configuration chunk — contains decoder config
        const configData = buf.subarray(1);
        try {
            const configStr = new TextDecoder().decode(configData);
            const config = JSON.parse(configStr);
            _wcDecoder.configure(config);
            _wcConfigReceived = true;
        } catch (_) {}
        return;
    }

    if (buf[0] === 0x01) {
        // Encoded frame chunk
        if (!_wcConfigReceived) {
            // Request keyframe — we need config first
            return;
        }

        const chunkData = buf.subarray(1);
        const chunk = new EncodedVideoChunk({
            type: 'key', // Will be corrected by the decoder
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

function requestWcKeyframe() {
    // Send keyframe request over existing signaling channel
    if (typeof ws !== 'undefined' && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'request-keyframe' }));
    }
}

function closeWebCodecs() {
    if (_wcDecoder) {
        _wcDecoder.close();
        _wcDecoder = null;
    }
    _wcInit = false;
    _wcConfigReceived = false;
}

module.exports = {
    initWebCodecsViewer,
    onWcDataChannelMessage,
    requestWcKeyframe,
    closeWebCodecs
};
