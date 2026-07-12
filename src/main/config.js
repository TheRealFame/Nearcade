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

const DEFAULTS = {
  encoder: 'gpu', codec: 'h264', preset: 'fast',
  alwaysOnTop: false, w: 1280, h: 800,
  tray: true, rumble: true, discordRPC: true,
  hwDecode: true, fpsUnlock: false, vsyncOff: false, zeroCopy: false,
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
  checkForUpdates: true,
};

function loadSettings() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
    const seed = Object.assign({}, DEFAULTS);
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

function saveSettings(s) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error('saveSettings:', e.message); }
}

module.exports = {
  getConfigDir, CONFIG_DIR, CONFIG_FILE, ROOT_DIR,
  BUNDLED_CONTROLLERS, USER_CONTROLLERS, LOG_FILE,
  DEFAULT_CONTROLLERS, DEFAULTS,
  loadSettings, loadControllers, saveSettings,
};
