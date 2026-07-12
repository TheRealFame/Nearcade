# API and System Setup

## Manual Startup
If you are developing or troubleshooting, you may want to run the components manually instead of using the compiled executable. Nearsec requires two separate processes to run simultaneously. These are the Python Input Driver and the Node.js Web Server.

### Manual Setup on Linux
Linux requires root privileges to inject virtual controllers directly into the kernel via uinput.

Terminal 1 for the Input Driver:
```bash
cd Nearcade
pip3 install -r bin/requirements-linux.txt
sudo python3 src/sidecar/input_driver.py
```

Terminal 2 for the Web Server:
```bash
cd Nearcade
npm install
npm run electron
```

### Manual Setup on Windows
Windows requires the ViGEmBus driver to emulate controllers. 
1. Download and install the ViGEmBus Driver.
2. Ensure you have Python 3 and Node 18 or newer installed.

Terminal 1 for the Input Driver:
```powershell
cd Nearcade
pip install -r bin/requirements-windows.txt
python src/sidecar/input_driver.py
```

Terminal 2 for the Web Server:
```powershell
cd Nearcade
npm install
npm run electron
```

## Environment Configuration
To prevent hardcoding sensitive tokens, Nearsec relies on an environment file located in your root directory. 

Create a file named .env and populate it with your specific keys.
```ini
CF_TOKEN=your_cloudflare_tunnel_token
CUSTOM_URL=[https://play.yourdomain.com](https://play.yourdomain.com)
PORT=3000
```

## Internal Express API Endpoints
The Nearsec Node server exposes local HTTP POST endpoints to control the backend dynamically.

Audio Routing via /api/force-route
* Payload: { "nodeProperty": "target_node_id" }
* Action: Forces PipeWire to dynamically link the specific target node into the NearsecVirtualCapture sink.

Process Management via /api/restart-game
* Action: Restarts the capture sequence.

This project uses artificial intelligence large language models for code generation and structure planning.
