const os = require('os');
const path = require('path');
const fs = require('fs');

function getConfigDir() {
  const home = os.homedir();
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Nearcade');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Nearcade');
  return path.join(home, '.config', 'Nearcade');
}

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'nearcade.config.json');
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const BUNDLED_CONTROLLERS = path.join(ROOT_DIR, 'config', 'controllers.json');
const USER_CONTROLLERS = path.join(CONFIG_DIR, 'controllers.json');
const LOG_FILE = path.join(CONFIG_DIR, 'latest.log');

const DEFAULT_CONTROLLERS = {
  'Xbox 360 Controller (XInput STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 }, rt: { type: 'btn', idx: 7 }, rsx: 2, rsy: 3
  },
  'Xbox Wireless Controller (STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 }, rt: { type: 'btn', idx: 7 }, rsx: 2, rsy: 3
  },
  'DualSense Wireless Controller (STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 }, rt: { type: 'btn', idx: 7 }, rsx: 2, rsy: 3
  },
  'Wireless Controller (STANDARD GAMEPAD)': {
    lt: { type: 'btn', idx: 6 }, rt: { type: 'btn', idx: 7 }, rsx: 2, rsy: 3
  },
};

let _isNvidiaCache = null;
function isNvidiaLinux() {
  if (process.platform !== 'linux') return false;
  if (_isNvidiaCache !== null) return _isNvidiaCache;
  try {
    if (fs.existsSync('/proc/driver/nvidia')) {
      _isNvidiaCache = true;
      return true;
    }
    const lspciOut = require('child_process').execSync('lspci 2>/dev/null', { encoding: 'utf8' });
    _isNvidiaCache = /nvidia/i.test(lspciOut);
    return _isNvidiaCache;
  } catch (_) {
    _isNvidiaCache = false;
    return false;
  }
}

// On Linux: enable zeroCopy (GPU-Direct Capture) by default for non-NVIDIA GPUs.
// NVIDIA proprietary drivers interact poorly with Chromium's zero-copy DMA path,
// so we disable it there to avoid black-screen capture failures.
function getDefaultZeroCopy() {
  return process.platform === 'linux' && !isNvidiaLinux();
}

const DEFAULTS = {
  encoder: 'gpu', codec: 'h264', preset: 'fast',
  alwaysOnTop: false, w: 1280, h: 800,
  tray: true, rumble: true, discordRPC: true,
  hwDecode: true, fpsUnlock: false, vsyncOff: false, zeroCopy: getDefaultZeroCopy(),
  hidePreviewOnStart: false, captureMic: false,
  ffmpegExperimental: false,
  hostName: '',
  forceXboxOne: false, enableDualShock: false, enableMotion: false,
  defaultInputMode: 'gamepad', hybridInput: false,
  tunnelProvider: null, neverAsk: false, vpsHost: '',
  vpsEnabled: false, vpsUrl: '', vpsMasterKey: '',
  autoHosts: [],
  discordClientId: '1522864642953711776',
  firstRunComplete: false,
  neverBotherSetup: false,
  useSystemAccent: false,
  useNativeTheme: false,
  checkForUpdates: true,
  captureMethod: 'webcodecs',
  gpuPreference: 'auto', // 'auto' | 'integrated' | 'discrete'
  layoutMode: 'auto', // 'auto' | 'default' | 'handheld' | 'portrait'
  configVersion: 4,
};

function loadSettings() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const defaultZeroCopy = getDefaultZeroCopy();
    if (fs.existsSync(CONFIG_FILE)) {
      let parsed = {};
      try { parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch (_) {}
      const merged = Object.assign({}, DEFAULTS, parsed);

      let needsSave = false;
      // Migration for 3.0.7 Windows capture regression recovery:
      // In 3.0.7, Windows installs were written with "gpuPreference": "integrated",
      // "zeroCopy": true, "fpsUnlock": true, "vsyncOff": true by default.
      // If updating from 3.0.7 or earlier on Windows without an explicit configVersion >= 4,
      // recover to safe defaults ('auto' for gpuPreference, false for optimizations).
      if (process.platform === 'win32') {
        if (!parsed.configVersion || parsed.configVersion < 4) {
          if (parsed.gpuPreference === 'integrated') {
            console.log('[config] Windows 3.0.7 migration: Resetting gpuPreference from "integrated" to "auto" to prevent DXGI_ERROR_UNSUPPORTED on hybrid laptops.');
            merged.gpuPreference = 'auto';
            needsSave = true;
          }
          if (parsed.zeroCopy === true) { merged.zeroCopy = false; needsSave = true; }
          if (parsed.fpsUnlock === true) { merged.fpsUnlock = false; needsSave = true; }
          if (parsed.vsyncOff === true) { merged.vsyncOff = false; needsSave = true; }
          merged.configVersion = 4;
          needsSave = true;
        }
      }

      // Only auto-apply zeroCopy default for users who haven't explicitly set it yet
      if (parsed.zeroCopy === undefined) {
        merged.zeroCopy = defaultZeroCopy;
        needsSave = true;
      }

      if (needsSave) {
        try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2)); } catch (_) {}
      }

      return merged;
    }
    const seed = Object.assign({}, DEFAULTS, { zeroCopy: defaultZeroCopy });

    // Log zeroCopy default reasoning on first run (Linux only)
    if (process.platform === 'linux') {
      if (defaultZeroCopy) {
        console.log('[Setup] Non-NVIDIA GPU detected. GPU-Direct Capture (zeroCopy) enabled by default.');
      } else {
        console.log('[Setup] NVIDIA GPU detected. GPU-Direct Capture (zeroCopy) disabled by default for compatibility.');
      }
    }

    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(seed, null, 2)); } catch (_) { }
    return seed;
  } catch (_) { }
  return Object.assign({}, DEFAULTS);
}

function loadControllers() {
  let bundled = {};
  let user = {};
  try {
    if (fs.existsSync(BUNDLED_CONTROLLERS)) {
      bundled = JSON.parse(fs.readFileSync(BUNDLED_CONTROLLERS, 'utf8'));
    }
  } catch (_) { }
  try {
    if (!fs.existsSync(USER_CONTROLLERS)) {
      if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
      const seed = Object.keys(bundled).length ? bundled : DEFAULT_CONTROLLERS;
      fs.writeFileSync(USER_CONTROLLERS, JSON.stringify(seed, null, 2));
      return seed;
    }
    user = JSON.parse(fs.readFileSync(USER_CONTROLLERS, 'utf8'));
  } catch (_) {
    user = {};
  }
  return Object.assign({}, DEFAULT_CONTROLLERS, bundled, user);
}

 let _saveTimer = null;
 function saveSettings(s) {
   if (_saveTimer) clearTimeout(_saveTimer);
   _saveTimer = setTimeout(() => {
     _saveTimer = null;
     try {
       if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
       let current = {};
       if (fs.existsSync(CONFIG_FILE)) {
         try { current = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
       }
       const merged = Object.assign(current, s);
       fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
     } catch (e) { console.error('saveSettings:', e.message); }
   }, 250);
 }

 function saveSettingsSync(s) {
   if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
   try {
     if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
     let current = {};
     if (fs.existsSync(CONFIG_FILE)) {
       try { current = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
     }
     const merged = Object.assign(current, s);
     fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
   } catch (e) { console.error('saveSettingsSync:', e.message); }
 }

module.exports = {
  getConfigDir, CONFIG_DIR, CONFIG_FILE, ROOT_DIR,
  BUNDLED_CONTROLLERS, USER_CONTROLLERS, LOG_FILE,
  DEFAULT_CONTROLLERS, DEFAULTS,
  loadSettings, loadControllers, saveSettings, saveSettingsSync,
};
