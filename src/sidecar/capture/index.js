const os = require('os');
const path = require('path');

function create() {
    const platform = os.platform();
    let capturer = null;

    switch (platform) {
        case 'win32': {
            try {
                capturer = require('./build/Release/capture_win');
                console.log('[capture] Loaded DXGI Desktop Duplication (Windows)');
            } catch (e) {
                console.warn('[capture] Failed to load DXGI addon:', e.message);
                return null;
            }
            break;
        }
        case 'linux': {
            try {
                capturer = require('./build/Release/capture_linux');
                console.log('[capture] Loaded KMS/DRM capture (Linux)');
            } catch (e) {
                console.warn('[capture] KMS/DRM capture unavailable:', e.message);
                return null;
            }
            break;
        }
        case 'android': {
            try {
                capturer = require('./capture-android');
                console.log('[capture] Loaded MediaProjection capture (Android)');
            } catch (e) {
                console.warn('[capture] Android capture unavailable:', e.message);
                return null;
            }
            break;
        }
        default:
            console.warn('[capture] Unsupported platform:', platform);
            return null;
    }

    return capturer;
}

const instance = create();
module.exports = instance;
