const fs = require('fs');
const { execSync } = require('child_process');

/**
 * Check if a system library is present on the filesystem
 * @param {string} libraryName - The library name to check (e.g., 'libasound.so.2')
 * @returns {boolean} - true if library is found, false otherwise
 */
function isLibraryPresent(libraryName) {
  try {
    // First try ldconfig (most reliable on Linux)
    execSync(`ldconfig -p | grep -q ${libraryName}`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    // Fallback: check common library paths
    const paths = [
      '/usr/lib/',
      '/usr/lib/x86_64-linux-gnu/',
      '/usr/lib/aarch64-linux-gnu/',
      '/usr/lib/arm-linux-gnueabihf/',
      '/lib/',
      '/lib/x86_64-linux-gnu/',
      '/lib/aarch64-linux-gnu/',
      '/lib/arm-linux-gnueabihf/',
    ];
    
    for (const path of paths) {
      if (fs.existsSync(path + libraryName)) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Check for required system dependencies
 * Returns true if all dependencies are present, false otherwise
 */
function checkSystemDependencies() {
  const platform = process.platform;
  
  // Only check dependencies on Linux - macOS and Windows have system libraries built-in
  if (platform !== 'linux') {
    return true;
  }
  
  const required = [
    'libasound.so.2',      // ALSA audio (critical for audio capture)
    'libdbus-1.so.3',      // D-Bus IPC (needed for desktop integration)
    'libnss3.so',          // Network Security Services (TLS/SSL)
    'libgbm.so.1',         // Generic Buffer Management (GPU acceleration)
    'libxshmfence.so.1',   // Shared Memory Fence (GPU sync)
  ];
  
  const missing = [];
  
  for (const lib of required) {
    if (!isLibraryPresent(lib)) {
      missing.push(lib);
    }
  }
  
  if (missing.length > 0) {
    printDependencyError(missing);
    return false;
  }
  
  return true;
}

/**
 * Print formatted error message for missing dependencies
 * @param {string[]} missingLibs - Array of missing library names
 */
function printDependencyError(missingLibs) {
  const errorLines = [];
  
  errorLines.push('');
  errorLines.push('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
  errorLines.push('┃  ❌ Nearcade Failed to Launch                                                ┃');
  errorLines.push('┃                                                                              ┃');
  
  for (const lib of missingLibs) {
    errorLines.push(`┃  Missing system dependency: ${lib.padEnd(40)} ┃`);
    errorLines.push('┃                                                                              ┃');
  }
  
  errorLines.push('┃  Install on Debian/Ubuntu: sudo apt-get install \\                          ┃');
  if (missingLibs.includes('libasound.so.2')) {
    errorLines.push('┃    libasound2                                                                ┃');
  }
  if (missingLibs.includes('libdbus-1.so.3')) {
    errorLines.push('┃    libdbus-1-3                                                               ┃');
  }
  if (missingLibs.includes('libnss3.so')) {
    errorLines.push('┃    libnss3                                                                   ┃');
  }
  if (missingLibs.includes('libgbm.so.1')) {
    errorLines.push('┃    libgbm1                                                                   ┃');
  }
  if (missingLibs.includes('libxshmfence.so.1')) {
    errorLines.push('┃    libxshmfence1                                                             ┃');
  }
  
  errorLines.push('┃                                                                              ┃');
  errorLines.push('┃  Install on Fedora:        sudo dnf install \\                              ┃');
  if (missingLibs.includes('libasound.so.2')) {
    errorLines.push('┃    alsa-lib                                                                  ┃');
  }
  if (missingLibs.includes('libdbus-1.so.3')) {
    errorLines.push('┃    dbus-libs                                                                 ┃');
  }
  if (missingLibs.includes('libnss3.so')) {
    errorLines.push('┃    nss                                                                       ┃');
  }
  if (missingLibs.includes('libgbm.so.1')) {
    errorLines.push('┃    libgbm                                                                    ┃');
  }
  if (missingLibs.includes('libxshmfence.so.1')) {
    errorLines.push('┃    libxshmfence                                                              ┃');
  }
  
  errorLines.push('┃                                                                              ┃');
  errorLines.push('┃  Install on Arch:          sudo pacman -S \\                                ┃');
  if (missingLibs.includes('libasound.so.2')) {
    errorLines.push('┃    alsa-lib                                                                  ┃');
  }
  if (missingLibs.includes('libdbus-1.so.3')) {
    errorLines.push('┃    dbus                                                                      ┃');
  }
  if (missingLibs.includes('libnss3.so')) {
    errorLines.push('┃    nss                                                                       ┃');
  }
  if (missingLibs.includes('libgbm.so.1')) {
    errorLines.push('┃    libgbm                                                                    ┃');
  }
  if (missingLibs.includes('libxshmfence.so.1')) {
    errorLines.push('┃    xshmfence                                                                 ┃');
  }
  
  errorLines.push('┃                                                                              ┃');
  errorLines.push('┃  For more help: https://nearcade.app/docs/linux-dependencies                 ┃');
  errorLines.push('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
  errorLines.push('');
  
  // Print with ANSI color codes for emphasis
  const red = '\x1b[31m';
  const reset = '\x1b[0m';
  
  console.error(red + errorLines.join('\n') + reset);
}

/**
 * Probe GPU acceleration capabilities and log warnings if issues detected
 */
function probeGPUAcceleration() {
  if (process.platform !== 'linux') {
    return;
  }
  
  try {
    // Check for VA-API hardware video encoding support
    try {
      const vainfoOutput = execSync('vainfo 2>/dev/null', { stdio: 'pipe' }).toString();
      if (!vainfoOutput.includes('VAProfile')) {
        console.warn('\n[electron] ⚠ Hardware video acceleration not detected');
        console.warn('  VA-API check failed - hardware H264 encoding may be unavailable');
        console.warn('  This is not fatal but may affect streaming quality\n');
      }
    } catch (e) {
      console.warn('\n[electron] ⚠ Hardware video acceleration not detected');
      console.warn('  vainfo command not found or failed - hardware H264 encoding may be unavailable');
      console.warn('  This is not fatal but may affect streaming quality\n');
    }
    
    // Check GBM availability (critical for Wayland)
    try {
      fs.accessSync('/dev/dri/renderD128', fs.constants.R_OK);
    } catch (e) {
      console.warn('\n[electron] ⚠ No GPU render node found');
      console.warn('  /dev/dri/renderD128 is not readable - GPU acceleration may fail');
      console.warn('  Try: sudo chmod 666 /dev/dri/renderD128 (temporary fix)\n');
    }
  } catch (e) {
    console.warn('\n[electron] ⚠ GPU probe failed:', e.message, '\n');
  }
}

module.exports = {
  checkSystemDependencies,
  probeGPUAcceleration,
};
