// Local replacement for @nearcade/native-palette
// Provides native theme/accent colors using Electron's native APIs

const { nativeTheme, systemPreferences } = require('electron');

/**
 * Get theme colors from the OS
 * Returns: { accent, bg, surface, surfaceHover, text, muted, muted2, border }
 */
function getThemeColors() {
    try {
        // Get accent color
        let accent = '#c084fc'; // default purple
        
        if (process.platform === 'win32' || process.platform === 'darwin') {
            if (typeof systemPreferences.getAccentColor === 'function') {
                const color = systemPreferences.getAccentColor();
                if (color) {
                    // systemPreferences.getAccentColor returns RGB hex like "aabbcc"
                    accent = '#' + color.slice(0, 6);
                }
            }
        } else if (process.platform === 'linux') {
            // The GNOME accent-color key is only meaningful on stock Adwaita;
            // on Yaru/Windows-11/custom themes it sits at its default ('blue')
            // while the visible theme uses something else entirely. Gating on
            // the theme name keeps us honest instead of painting wrong colors.
            const found = linuxAccentColor();
            if (found) accent = found;
        }
        
        // Determine if dark mode
        const isDark = nativeTheme.shouldUseDarkColors;
        
        // Base theme colors
        const theme = {
            accent,
            isDark,
        };
        
        if (isDark) {
            theme.bg = '#0d0d0d';
            theme.surface = '#18181b';
            theme.surfaceHover = '#27272a';
            theme.text = '#fafafa';
            theme.muted = '#71717a';
            theme.muted2 = '#52525b';
            theme.border = '#3f3f46';
        } else {
            theme.bg = '#fafafa';
            theme.surface = '#ffffff';
            theme.surfaceHover = '#f4f4f5';
            theme.text = '#18181b';
            theme.muted = '#71717a';
            theme.muted2 = '#a1a1aa';
            theme.border = '#e4e4e7';
        }
        
        return theme;
    } catch (e) {
        console.error('[native-palette] Error getting theme colors:', e);
        return null;
    }
}

// Linux accent via desktop settings. The ACTIVE desktop goes first
// (XDG_CURRENT_DESKTOP / XDG_SESSION_DESKTOP); the other stack is fallback.
// Blind order once painted the wrong color, so: detect, then probe in order.
// Returns '#rrggbb' or null (caller keeps the default purple).
function linuxAccentColor() {
    let execSync = null;
    try {
        execSync = require('child_process').execSync;
    } catch (_) { return null; }
    const run = (cmd) => {
        try {
            return execSync(cmd, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch (_) { return ''; }
    };
    const de = ((process.env.XDG_CURRENT_DESKTOP || '') + ' ' + (process.env.XDG_SESSION_DESKTOP || '')).toLowerCase();
    const isKde = /(^|[:;])kde|plasma/.test(de);
    const gnomeReader = () => {
        // Honored ONLY on stock Adwaita — Yaru/Windows-11/custom themes
        // leave accent-color at its default while showing their own accent.
        const gtkTheme = run('gsettings get org.gnome.desktop.interface gtk-theme').replace(/'/g, '');
        if (!/^Adwaita/i.test(gtkTheme)) return null;
        const gnomeNames = {
            blue: '#3584e4', teal: '#2190a4', green: '#3a944a', yellow: '#c88800',
            orange: '#ed5b00', red: '#e62d42', pink: '#d56199', purple: '#9141ac',
            slate: '#6e7f96',
        };
        const g = run('gsettings get org.gnome.desktop.interface accent-color').replace(/'/g, '').trim();
        return (g && gnomeNames[g]) || null;
    };
    const kdeReader = () => {
        // KDE Plasma 5/6: "R,G,B". Keys are case-sensitive and the canonical
        // Plasma 6 key is `AccentColor` (capital A) — reading lowercase
        // `accentColor` returns empty and the app wrongly falls back to purple.
        const k = run('kreadconfig6 --group General --key AccentColor').trim()
            || run('kreadconfig6 --group General --key accentColor').trim()
            || run('kreadconfig5 --group General --key AccentColor').trim()
            || run('kreadconfig5 --group General --key accentColor').trim();
        const km = k.match(/^(\d{1,3}),(\d{1,3}),(\d{1,3})$/);
        if (!km) return null;
        const hx = (n) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
        return '#' + hx(km[1]) + hx(km[2]) + hx(km[3]);
    };
    const portalReader = () => {
        // freedesktop portal accent-color (0..1 rgb triple in variant output).
        // Absent on older portal versions (then this just yields null).
        const out = run('gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method org.freedesktop.portal.Settings.Read org.freedesktop.portal.Settings accent-color');
        const nums = [...out.matchAll(/double\s+([0-9.]+)/g)].map((m) => parseFloat(m[1]));
        if (nums.length >= 3 && nums.slice(0, 3).every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
            const hx = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
            return '#' + hx(nums[0]) + hx(nums[1]) + hx(nums[2]);
        }
        return null;
    };
    const readers = isKde
        ? [kdeReader, gnomeReader, portalReader]
        : [gnomeReader, kdeReader, portalReader];
    for (const read of readers) {
        try {
            const c = read();
            if (c) return c;
        } catch (_) {}
    }
    return null;
}

module.exports = { getThemeColors };