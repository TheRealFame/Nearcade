const path = require('path');
const fs = require('fs');

const FRAME_FILE = '/tmp/nearcade-drm-frame.raw';
let cap = null;

try {
  cap = require(path.join(__dirname, 'build/Release/capture_linux'));
} catch (e) {
  process.send({ type: 'error', message: 'Failed to load capture addon: ' + e.message });
  process.exit(1);
}

try {
  const result = cap.startCapture(0);
  if (!result) {
    process.send({ type: 'error', message: 'startCapture returned no result' });
    process.exit(1);
  }
  process.send({ type: 'ready', width: result.width, height: result.height });
} catch (e) {
  process.send({ type: 'error', message: e.message || String(e) });
  process.exit(1);
}

process.on('message', msg => {
  if (!cap) return;
  if (msg.type === 'get-frame') {
    try {
      const buf = cap.getFrame();
      if (buf && buf.byteLength > 0) {
        fs.writeFileSync(FRAME_FILE, buf);
        process.send({ type: 'frame', path: FRAME_FILE, size: buf.byteLength, reqId: msg.reqId });
      } else {
        process.send({ type: 'frame', data: null, reqId: msg.reqId });
      }
    } catch (e) {
      process.send({ type: 'frame', data: null, error: e.message, reqId: msg.reqId });
    }
  } else if (msg.type === 'stop') {
    try { cap.stopCapture(); } catch {}
    try { fs.unlinkSync(FRAME_FILE); } catch {}
    cap = null;
    process.exit(0);
  }
});
