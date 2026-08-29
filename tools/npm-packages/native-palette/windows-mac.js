const os = require('os');

function getWindowsMacTheme() {
  try {
    const { systemPreferences, nativeTheme } = require('electron');
    const isDark = nativeTheme.shouldUseDarkColors;
    
    // Default fallback dictionary
    let colors = {
      bg: isDark ? '#1e1e1e' : '#f0f0f0',
      sidebar: isDark ? '#252526' : '#e0e0e0',
      surface: isDark ? '#2d2d30' : '#ffffff',
      surfaceHover: isDark ? '#3e3e42' : '#f5f5f5',
      text: isDark ? '#d4d4d4' : '#000000',
      muted: isDark ? '#808080' : '#666666',
      muted2: isDark ? '#555555' : '#999999',
      border: isDark ? '#404040' : '#cccccc',
      accent: null
    };

    if (process.platform === 'win32') {
      try {
        colors.bg = systemPreferences.getColor('window').substring(0, 7);
        colors.surface = systemPreferences.getColor('3d-face').substring(0, 7);
        colors.text = systemPreferences.getColor('window-text').substring(0, 7);
        colors.border = systemPreferences.getColor('active-border').substring(0, 7);
        colors.accent = '#' + systemPreferences.getAccentColor().substring(0, 6);
      } catch (e) {}
    } else if (process.platform === 'darwin') {
      try {
        colors.bg = systemPreferences.getColor('window-background').substring(0, 7);
        colors.surface = systemPreferences.getColor('control-background').substring(0, 7);
        colors.text = systemPreferences.getColor('control-text').substring(0, 7);
        colors.accent = '#' + systemPreferences.getAccentColor().substring(0, 6);
      } catch (e) {}
    }

    return colors;
  } catch (e) {
    return null;
  }
}

module.exports = getWindowsMacTheme;
