// #7: Main Process DataChannel — standalone input channel via node-datachannel
// Runs alongside the renderer's media PeerConnection. Viewer input flows directly
// to InputOrchestrator without touching the renderer or local WebSocket.

const EventEmitter = require('events');

let _nodeDc = null;
let _inputDriver = null;
let _initialized = false;
const events = new EventEmitter();

function init(inputDriver) {
    if (_initialized) return;
    _inputDriver = inputDriver;

    try {
        const nodeDataChannel = require('node-datachannel');
        nodeDataChannel.initLogger('Error');

        // Create a PeerConnection for the input DataChannel
        const pc = nodeDataChannel.PeerConnection('NearcadeInput', {
            iceServers: [
                'stun:stun.l.google.com:19302',
                'stun:stun.cloudflare.com:3478'
            ]
        });

        // Create the input DataChannel (unordered, unreliable — same as renderer)
        _nodeDc = pc.createDataChannel('input', {
            unordered: true,
            maxRetransmits: 0
        });

        _nodeDc.onMessage((data) => {
            if (!_inputDriver) return;
            try {
                // Try parsing as JSON
                const msg = JSON.parse(data);
                if (_inputDriver.send) _inputDriver.send(msg);
            } catch {
                // Binary: forward via sendBinary
                if (_inputDriver.sendBinary && typeof data === 'string') {
                    const buf = Buffer.from(data, 'binary');
                    _inputDriver.sendBinary('main', new Uint8Array(buf));
                }
            }
        });

        _nodeDc.onOpen(() => {
            console.log('[main-dc] DataChannel open');
            events.emit('open');
        });

        _nodeDc.onClose(() => {
            console.log('[main-dc] DataChannel closed');
            events.emit('close');
        });

        // Generate offer and propagate to renderer via events
        pc.createOffer().then((offer) => {
            events.emit('offer', offer);
        });

        // Store for setting remote answer
        pc.setRemoteDescription = pc.setRemoteDescription.bind(pc);
        _nodeDc._pc = pc;

        _initialized = true;
        console.log('[main-dc] Initialized node-datachannel input channel');
    } catch (e) {
        console.warn('[main-dc] node-datachannel unavailable, falling back to renderer DataChannel:', e.message);
        _initialized = false;
    }
}

function setRemoteAnswer(sdp) {
    if (_nodeDc && _nodeDc._pc) {
        try { _nodeDc._pc.setRemoteDescription(sdp); } catch (e) {
            console.error('[main-dc] setRemoteDescription error:', e.message);
        }
    }
}

function isAvailable() {
    return _initialized && _nodeDc !== null;
}

module.exports = { init, setRemoteAnswer, isAvailable, events };
