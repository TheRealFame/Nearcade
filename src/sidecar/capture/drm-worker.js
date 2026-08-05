const path = require('path');
const { parentPort } = require('worker_threads');

let cap = null;

try {
  cap = require(path.join(__dirname, 'build/Release/capture_linux'));
} catch (e) {
  parentPort.postMessage({ type: 'error', message: 'Failed to load capture addon: ' + e.message });
  process.exit(1);
}

try {
  const result = cap.startCapture(0);
  if (!result) {
    parentPort.postMessage({ type: 'error', message: 'startCapture returned no result' });
    process.exit(1);
  }
  parentPort.postMessage({ type: 'ready', width: result.width, height: result.height });
} catch (e) {
  parentPort.postMessage({ type: 'error', message: e.message || String(e) });
  process.exit(1);
}

parentPort.on('message', msg => {
  if (!cap) return;
  if (msg.type === 'get-frame') {
    try {
      const buf = cap.getFrame();
      if (buf && buf.byteLength > 0) {
        // Zero-copy: transfer the underlying ArrayBuffer to the main thread
        parentPort.postMessage({ type: 'frame', buf, reqId: msg.reqId }, [buf.buffer]);
      } else {
        parentPort.postMessage({ type: 'frame', data: null, reqId: msg.reqId });
      }
    } catch (e) {
      parentPort.postMessage({ type: 'frame', data: null, error: e.message, reqId: msg.reqId });
    }
  } else if (msg.type === 'stop') {
    try { cap.stopCapture(); } catch {}
    cap = null;
    process.exit(0);
  }
});
