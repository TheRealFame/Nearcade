const io = require('./src/sidecar/input_backends/InputOrchestrator.js');
io.init();

const msg = {
    type: 'gamepad',
    viewerId: 'v1',
    pad_id: 'v1_0',
    lx: 32767, ly: -32767, rx: 0, ry: 0,
    lt: 255, rt: 0, buttons: 1
};
io.send(msg);

setTimeout(() => {
    console.log("Shutting down");
}, 2000);
