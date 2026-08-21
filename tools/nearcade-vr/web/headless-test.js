const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');

console.log("Starting server.js...");
const server = spawn('node', ['server.js'], { cwd: '/home/fame/Documents/Nearcade' });
server.stdout.on('data', d => console.log(d.toString().trim()));
server.stderr.on('data', d => console.log(d.toString().trim()));

setTimeout(() => {
    console.log("Connecting dummy HTTP client to /stream...");
    const req = http.get('http://localhost:8080/stream', (res) => {
        console.log("HTTP connected. Waiting 3 seconds for bridge and socket...");
        // consume stream so it doesn't stall
        res.on('data', () => {});
        
        setTimeout(() => {
            if (fs.existsSync('/run/user/1000/wivrn/comp_ipc')) {
                console.log("Socket EXISTS!");
                console.log("Running hello_xr...");
                try {
                    const out = execSync('/tmp/openxr-sdk/build/src/tests/hello_xr/hello_xr -g Vulkan', { timeout: 2000 });
                    console.log("hello_xr output:", out.toString());
                } catch (e) {
                    console.log("hello_xr error/timeout (this is expected if it connects and waits):", e.message);
                }
            } else {
                console.log("Socket does NOT exist!");
            }
            server.kill();
            process.exit(0);
        }, 3000);
    });
}, 3000);
