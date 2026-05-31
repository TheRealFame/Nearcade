/**
 * Cross-platform audio utility for NearsecTogether
 * Handles platform differences in sound playback:
 * - Linux: Uses play-sound (fallback to aplay)
 * - Windows: Uses play-sound or Windows Media Player (via PowerShell)
 * - macOS: Uses play-sound (fallback to afplay)
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const PLATFORM = process.platform;

/**
 * Play a sound file cross-platform
 * @param {string} filePath - Absolute path to sound file
 * @param {Function} callback - Called when done or on error
 */
function playSound(filePath, callback = () => {}) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[audio] Sound file not found: ${filePath}`);
    callback(new Error('File not found'));
    return;
  }

  console.log(`[audio] Playing: ${path.basename(filePath)} (${PLATFORM})`);

  try {
    // Try play-sound first (installed in package.json)
    const player = require('play-sound')();
    player.play(filePath, (err) => {
      if (err) {
        console.warn(`[audio] play-sound failed: ${err.message}, trying fallback`);
        fallbackPlay(filePath, callback);
      } else {
        callback(null);
      }
    });
  } catch (err) {
    console.warn(`[audio] play-sound not available: ${err.message}, trying fallback`);
    fallbackPlay(filePath, callback);
  }
}

/**
 * Fallback platform-specific audio playback
 */
function fallbackPlay(filePath, callback) {
  const cmd = getFallbackCommand(filePath);
  if (!cmd) {
    const err = new Error(`No audio playback available on ${PLATFORM}`);
    console.error(`[audio] ${err.message}`);
    callback(err);
    return;
  }

  console.log(`[audio] Using fallback: ${cmd.method}`);
  
  if (cmd.method === 'powershell') {
    // Windows PowerShell fallback
    exec(cmd.command, { windowsHide: true }, (err) => {
      if (err) {
        console.warn(`[audio] PowerShell fallback failed: ${err.message}`);
        callback(err);
      } else {
        callback(null);
      }
    });
  } else if (cmd.method === 'spawn') {
    // macOS/Linux spawn fallback
    const proc = spawn(cmd.exe, [filePath], { stdio: 'ignore' });
    proc.on('error', (err) => {
      console.warn(`[audio] ${cmd.exe} failed: ${err.message}`);
      callback(err);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[audio] ${cmd.exe} exited with code ${code}`);
        callback(new Error(`${cmd.exe} exit code ${code}`));
      } else {
        callback(null);
      }
    });
  } else {
    callback(new Error('Unknown fallback method'));
  }
}

/**
 * Get platform-specific fallback command
 */
function getFallbackCommand(filePath) {
  switch (PLATFORM) {
    case 'win32':
      // Windows: Use PowerShell System.Media.SoundPlayer
      // Single quotes must be escaped by doubling them in PowerShell
      const escapedPath = filePath.replace(/'/g, "''");
      return {
        method: 'powershell',
        command: `powershell -Command "(New-Object System.Media.SoundPlayer '${escapedPath}').PlaySync()"`,
      };

    case 'darwin':
      // macOS: Use afplay (built-in, always available)
      if (commandExists('afplay')) {
        return { method: 'spawn', exe: 'afplay' };
      }
      break;

    case 'linux':
    default:
      // Linux: Try aplay -> paplay -> ffplay
      if (commandExists('aplay')) {
        return { method: 'spawn', exe: 'aplay' };
      }
      if (commandExists('paplay')) {
        return { method: 'spawn', exe: 'paplay' };
      }
      if (commandExists('ffplay')) {
        return { method: 'spawn', exe: 'ffplay' };
      }
      break;
  }
  return null;
}

/**
 * Synchronously check if a command exists in PATH
 */
function commandExists(cmd) {
  try {
    const which = require('which');
    which.sync(cmd);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { playSound };
