const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROTOCOLS = {
  steam:  'steam://rungameid/',
  heroic: 'heroic://launch/',
  lutris: 'lutris://rungame/',
  epic:   'com.epicgames.launcher://apps/',
  uplay:  'uplay://launch/',
  origin: 'origin://launchgame/',
  bnet:   'battlenet://'
};

const SCHEMES = {
  heroic: 'x-scheme-handler/heroic',
  lutris: 'x-scheme-handler/lutris',
  epic:   'x-scheme-handler/com.epicgames.launcher',
  uplay:  'x-scheme-handler/uplay',
  origin: 'x-scheme-handler/origin',
  bnet:   'x-scheme-handler/battlenet'
};

const LAUNCHERS = [
  { id: 'steam',  label: 'Steam' },
  { id: 'heroic', label: 'Heroic' },
  { id: 'lutris', label: 'Lutris' },
  { id: 'epic',   label: 'Epic' },
  { id: 'uplay',  label: 'Ubisoft' },
  { id: 'origin', label: 'Origin' },
  { id: 'bnet',   label: 'Battle.net' }
];

function tryExec(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 3000, ...opts }).trim(); } catch { return ''; }
}

// Resolve a URL scheme to the handler desktop file's Exec line
// (binary + args) so we can spawn it directly instead of delegating
// to xdg-open, which on KDE routes schemes through KIO workers and
// can pop up sandbox/worker dialogs.
function desktopFileHandler(launcherId) {
  const scheme = SCHEMES[launcherId];
  if (!scheme) return null;
  const desktopFile = tryExec(`xdg-mime query default ${scheme}`);
  if (!desktopFile || desktopFile.includes('/')) return null;
  const candidates = [
    path.join(os.homedir(), '.local', 'share', 'applications', desktopFile),
    '/usr/share/applications/' + desktopFile,
    '/usr/local/share/applications/' + desktopFile
  ];
  for (const fp of candidates) {
    let content;
    try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    const m = content.match(/^Exec=(.*)$/m);
    if (!m) continue;
    const execLine = m[1].replace(/%[UFifcuk%]/g, '').trim();
    if (!execLine) continue;
    // Split respecting double-quoted tokens (e.g. quoted AppImage paths).
    const parts = [];
    const re = /"([^"]*)"|(\S+)/g;
    let mm;
    while ((mm = re.exec(execLine)) !== null) parts.push(mm[1] || mm[2]);
    if (parts.length === 0) continue;
    return { cmd: parts[0], args: parts.slice(1) };
  }
  return null;
}

function detect() {
  const platform = os.platform();
  const found = [];

  if (platform === 'linux') {
    const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
    const checks = [
      { id: 'steam',  scheme: 'x-scheme-handler/steam',  match: /steam/i },
      { id: 'heroic', scheme: 'x-scheme-handler/heroic', match: /heroic|hgl/i },
      { id: 'lutris', scheme: 'x-scheme-handler/lutris', match: /lutris/i },
      { id: 'epic',   scheme: 'x-scheme-handler/com.epicgames.launcher', match: /epic|legendary/i },
      { id: 'uplay',  scheme: 'x-scheme-handler/uplay',  match: /ubisoft|uplay/i },
      { id: 'origin', scheme: 'x-scheme-handler/origin', match: /origin/i },
      { id: 'bnet',   scheme: 'x-scheme-handler/battlenet', match: /blizzard|battlenet|battle/i }
    ];
    for (const c of checks) {
      const desktopFile = tryExec(`xdg-mime query default ${c.scheme}`);
      if (desktopFile && c.match.test(desktopFile)) found.push(c.id);
    }
    const flatpaks = tryExec('flatpak list --columns=application');
    if (!found.includes('heroic') && flatpaks.includes('com.heroicgameslauncher')) found.push('heroic');
    if (!found.includes('lutris') && flatpaks.includes('net.lutris.Lutris')) found.push('lutris');
  } else if (platform === 'win32') {
    const seen = new Set();
    const regChecks = [
      { id: 'steam',  key: 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam' },
      { id: 'steam',  key: 'HKCU\\Software\\Valve\\Steam' },
      { id: 'epic',   key: 'HKCU\\Software\\Epic Games\\Unreal Engine' },
      { id: 'epic',   key: 'HKLM\\SOFTWARE\\EpicGames' },
      { id: 'uplay',  key: 'HKCU\\Software\\Ubisoft\\Launcher' },
      { id: 'origin', key: 'HKCU\\Software\\Origin' },
      { id: 'bnet',   key: 'HKCU\\Software\\Blizzard Entertainment\\Battle.net' },
      { id: 'heroic', key: 'HKCU\\Software\\HeroicGamesLauncher' }
    ];
    for (const c of regChecks) {
      if (tryExec(`reg query "${c.key}" /ve 2>nul`)) seen.add(c.id);
    }
    const schemeChecks = [
      { scheme: 'steam',  id: 'steam' },
      { scheme: 'heroic', id: 'heroic' },
      { scheme: 'com.epicgames.launcher', id: 'epic' },
      { scheme: 'uplay',  id: 'uplay' },
      { scheme: 'origin', id: 'origin' },
      { scheme: 'battlenet', id: 'bnet' }
    ];
    for (const c of schemeChecks) {
      if (!seen.has(c.id) && tryExec(`reg query "HKCU\\Software\\Classes\\${c.scheme}\\shell\\open\\command" /ve 2>nul`)) seen.add(c.id);
    }
    found.push(...seen);
  } else if (platform === 'darwin') {
    const apps = [
      { id: 'steam',  name: 'Steam.app' },
      { id: 'epic',   name: 'Epic Games Launcher.app' },
      { id: 'heroic', name: 'Heroic.app' },
      { id: 'uplay',  name: 'Ubisoft Connect.app' },
      { id: 'origin', name: 'Origin.app' },
      { id: 'bnet',   name: 'Battle.net.app' }
    ];
    for (const a of apps) {
      if (fs.existsSync(path.join('/Applications', a.name)) ||
          fs.existsSync(path.join(os.homedir(), 'Applications', a.name))) {
        found.push(a.id);
      }
    }
    const schemeChecks = ['steam', 'heroic', 'com.epicgames.launcher', 'uplay', 'origin', 'battlenet'];
    for (const scheme of schemeChecks) {
      if (!found.includes(scheme === 'com.epicgames.launcher' ? 'epic' : scheme)) {
        const out = tryExec(
          `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump 2>/dev/null | grep -i "${scheme}"`
        );
        if (out) {
          const id = scheme === 'com.epicgames.launcher' ? 'epic' : scheme;
          if (!found.includes(id)) found.push(id);
        }
      }
    }
  }

  return found;
}

function buildUrl(launcherId, gameId) {
  const proto = PROTOCOLS[launcherId];
  if (!proto) throw new Error(`Unknown launcher: ${launcherId}`);
  return proto + String(gameId);
}

function launch(launcherId, gameId) {
  // Fix for js/command-line-injection (CodeQL)
  // Ensure gameId only contains safe alphanumeric characters, dashes, dots, and underscores.
  if (!/^[a-zA-Z0-9\-_\.]+$/.test(String(gameId))) {
    throw new Error('Invalid gameId format: unsafe characters detected');
  }

  const url = buildUrl(launcherId, gameId);
  const platform = os.platform();
  const { execFileSync, spawn } = require('child_process');

  try {
    if (platform === 'win32') {
      // Still using tryExec (which uses execSync) because Windows 'start' is a cmd-builtin.
      // The gameId is now strictly sanitized above, so injection is impossible.
      tryExec(`start /low "" "${url}"`);
    } else if (platform === 'darwin') {
      execFileSync('open', [url], { timeout: 3000 });
    } else {
      if (launcherId === 'steam') {
        const runtimeDir = process.env.XDG_RUNTIME_DIR || '/run/user/' + os.userInfo().uid;
        const baseMounts = process.env.STEAM_COMPAT_MOUNTS ? process.env.STEAM_COMPAT_MOUNTS + ':' : '';
        const env = Object.assign({}, process.env, {
          // Append (never clobber) Steam's own mount list; the wivrn IPC
          // socket dir must be visible inside the game's pressure-vessel container.
          STEAM_COMPAT_MOUNTS: baseMounts + runtimeDir + '/wivrn',
          PRESSURE_VESSEL_IMPORT_OPENXR_1_RUNTIMES: '1',
          LIBVA_DRIVER_NAME: 'dummy',
          // Point the containerized OpenXR loader straight at the wivrn runtime.
          XR_RUNTIME_JSON: path.join(os.homedir(), '.local', 'share', 'openxr', '1', 'active_runtime.json')
        });
        spawn('steam', ['-applaunch', gameId], { detached: true, stdio: 'ignore', env }).unref();
      } else {
        // Launch known launchers directly instead of xdg-open. On KDE,
        // xdg-open routes custom URL schemes through KIO workers, which can
        // pop up sandbox/worker dialogs or fail silently when the launcher
        // app is not running. Direct spawn keeps the flow popup-free.
        const flatpaks = tryExec('flatpak list --columns=application');
        let cmd = null, args = null;
        if (launcherId === 'heroic') {
          if (tryExec('command -v heroic')) { cmd = 'heroic'; args = [url]; }
          else if (flatpaks.includes('com.heroicgameslauncher')) { cmd = 'flatpak'; args = ['run', 'com.heroicgameslauncher', url]; }
        } else if (launcherId === 'lutris') {
          if (tryExec('command -v lutris')) { cmd = 'lutris'; args = [url]; }
          else if (flatpaks.includes('net.lutris.Lutris')) { cmd = 'flatpak'; args = ['run', 'net.lutris.Lutris', url]; }
        } else if (launcherId === 'epic') {
          if (tryExec('command -v legendary')) { cmd = 'legendary'; args = ['launch', String(gameId)]; }
        }
        if (cmd) {
          spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
        } else {
          // Exotic install (AppImage, snap, wrapper script) — run the
          // registered scheme handler directly, still bypassing xdg-open/KIO.
          const handler = desktopFileHandler(launcherId);
          if (handler) {
            spawn(handler.cmd, handler.args.concat([url]), { detached: true, stdio: 'ignore' }).unref();
          } else {
            execFileSync('xdg-open', [url], { timeout: 3000 });
          }
        }
      }
    }
  } catch (e) {
    console.error('[launcher-detect] launch failed:', e.message);
  }
}

function protectSelf(pid) {
  pid = pid || process.pid;
  try {
    if (os.platform() === 'linux') {
      fs.writeFileSync('/proc/' + pid + '/oom_score_adj', '-500');
      tryExec('renice -n -5 -p ' + pid);
    } else if (os.platform() === 'darwin') {
      tryExec('renice -n -5 -p ' + pid);
    } else if (os.platform() === 'win32') {
      tryExec('wmic process where processid=' + pid + ' CALL setpriority 32768');
    }
  } catch {}
}

// ── Steam game detection via .acf files ──
function detectGames() {
  try {
  const platform = os.platform();
  const games = [];

  const steamDirs = [];
  if (platform === 'linux') {
    const candidates = [
      path.join(os.homedir(), '.steam', 'steam', 'steamapps'),
      path.join(os.homedir(), '.local', 'share', 'Steam', 'steamapps'),
      '/usr/share/steam/steamapps',
      path.join(os.homedir(), '.steam', 'steam', 'SteamApps'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p) && !steamDirs.includes(p)) steamDirs.push(p);
    }
    // Read libraryfolders.vdf for additional Steam libraries
    const vdfCandidates = [
      path.join(os.homedir(), '.steam', 'steam', 'steamapps', 'libraryfolders.vdf'),
      path.join(os.homedir(), '.local', 'share', 'Steam', 'steamapps', 'libraryfolders.vdf'),
    ];
    for (const vdf of vdfCandidates) {
      if (!fs.existsSync(vdf)) continue;
      const raw = fs.readFileSync(vdf, 'utf8');
      const m = raw.match(/"path"\s+"([^"]+)"/g);
      if (m) {
        for (const line of m) {
          const libPath = line.match(/"path"\s+"([^"]+)"/)[1];
          const appsDir = path.join(libPath, 'steamapps');
          if (fs.existsSync(appsDir) && !steamDirs.includes(appsDir)) steamDirs.push(appsDir);
        }
      }
    }
  } else if (platform === 'win32') {
    const candidates = [
      path.join('C:\\Program Files (x86)\\Steam', 'steamapps'),
      path.join(process.env.LOCALAPPDATA || '', 'Steam', 'steamapps'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) steamDirs.push(p);
    }
    const regOut = tryExec('reg query "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath 2>nul');
    if (regOut) {
      const installPath = regOut.match(/InstallPath\s+REG_SZ\s+(.+)/i);
      if (installPath) {
        const p = path.join(installPath[1].trim(), 'steamapps');
        if (fs.existsSync(p) && !steamDirs.includes(p)) steamDirs.push(p);
      }
    }
  } else if (platform === 'darwin') {
    const macPath = path.join(os.homedir(), 'Library', 'Application Support', 'Steam', 'steamapps');
    if (fs.existsSync(macPath)) steamDirs.push(macPath);
  }

  // Parse .acf files for game info
  const seenIds = new Set();
  for (const appsDir of steamDirs) {
    let files;
    try { files = fs.readdirSync(appsDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.acf')) continue;
      const fp = path.join(appsDir, f);
      let raw;
      try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      const appid = raw.match(/"appid"\s+"(\d+)"/);
      const name = raw.match(/"name"\s+"((?:[^"\\]|\\.)*)"/);
      const lastPlayed = raw.match(/"LastPlayed"\s+"(\d+)"/);
      if (appid && name && !seenIds.has(appid[1])) {
        seenIds.add(appid[1]);
        games.push({
          id: appid[1],
          name: name[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
          launcher: 'steam',
          lastPlayed: lastPlayed ? parseInt(lastPlayed[1], 10) : 0,
        });
      }
    }
  }

  // Heroes Games Launcher (Heroic) — parse config store
  if (platform === 'linux' || platform === 'darwin') {
    const heroicDirs = [];

    // Native install → check where heroic binary lives
    const heroicBin = tryExec('which heroic 2>/dev/null');
    const heroicFlatpak = tryExec('flatpak info com.heroicgameslauncher 2>/dev/null');
    const heroicSnap = tryExec('snap list heroic 2>/dev/null');

    if (heroicBin) {
      heroicDirs.push(path.join(os.homedir(), '.config', 'heroic'));
    }
    if (heroicFlatpak) {
      heroicDirs.push(path.join(os.homedir(), '.var', 'app', 'com.heroicgameslauncher', 'config', 'heroic'));
    }
    if (heroicSnap) {
      heroicDirs.push(path.join(os.homedir(), 'snap', 'heroic', 'current', '.config', 'heroic'));
    }
    // Fallback: still check default paths in case which/flatpak/snap silently fail
    const fallbackPaths = [
      path.join(os.homedir(), '.config', 'heroic'),
      path.join(os.homedir(), '.var', 'app', 'com.heroicgameslauncher', 'config', 'heroic'),
      path.join(os.homedir(), 'snap', 'heroic', 'current', '.config', 'heroic'),
    ];
    for (const fp of fallbackPaths) {
      if (!heroicDirs.includes(fp)) heroicDirs.push(fp);
    }

    for (const hDir of heroicDirs) {
      const librarySources = [
        { file: path.join(hDir, 'store_cache', 'legendary_library.json'),  key: 'library' },
        { file: path.join(hDir, 'store_cache', 'gog_library.json'),        key: 'games'   },
        { file: path.join(hDir, 'store_cache', 'nile_library.json'),       key: 'library'  },
        { file: path.join(hDir, 'sideload_apps', 'library.json'),          key: 'games'    },
      ];
      for (const src of librarySources) {
        if (!fs.existsSync(src.file)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(src.file, 'utf8'));
          const list = data[src.key];
          if (list) {
            for (const app of list) {
              if (app.app_name && app.title && !seenIds.has('heroic_' + app.app_name) && app.is_installed !== false) {
                seenIds.add('heroic_' + app.app_name);
                games.push({
                  id: app.app_name,
                  name: app.title,
                  launcher: 'heroic',
                  lastPlayed: app.last_played ? parseInt(app.last_played) * 1000 : 0,
                  artCover: app.art_cover || '',
                });
              }
            }
          }
        } catch {}
      }
    }
  }

  // Lutris — parse YAML/JSON library
  if (platform === 'linux') {
    const lutrisDirs = [
      path.join(os.homedir(), '.config', 'lutris'),
      path.join(os.homedir(), '.var', 'app', 'net.lutris.Lutris', 'config', 'lutris'),
      path.join(os.homedir(), '.var', 'app', 'net.lutris.Lutris', 'data', 'lutris'),
    ];
    for (const lDir of lutrisDirs) {
      const pgaDb = path.join(lDir, 'pga.db');
      if (fs.existsSync(pgaDb)) {
        try {
          const out = tryExec(`sqlite3 "${pgaDb}" "SELECT slug, name, installed FROM games WHERE installed=1" 2>/dev/null`);
          if (out) {
            for (const line of out.split('\n')) {
              const [slug, ...rest] = line.split('|');
              const name = rest.join('|');
              if (slug && name && !seenIds.has('lutris_' + slug)) {
                seenIds.add('lutris_' + slug);
                games.push({ id: slug, name, launcher: 'lutris', lastPlayed: 0 });
              }
            }
          }
        } catch {}
      }
    }
  }

  return games;
  } catch (e) {
    console.error('[detectGames]', e.message);
    return [];
  }
}

module.exports = { detect, detectGames, launch, buildUrl, PROTOCOLS, LAUNCHERS, protectSelf, resolveVrInfo };

// ── Steam VR capability detection via official store API ──
const https = require('https');
const VR_CACHE_PATH = path.join(os.homedir(), '.cache', 'Nearcade', 'steam-vr-cache.json');
const VR_SUCCESS_TTL = 7 * 24 * 3600 * 1000;
const VR_FAIL_TTL = 60 * 60 * 1000;

function loadVrCache() {
  try { return JSON.parse(fs.readFileSync(VR_CACHE_PATH, 'utf8')); } catch { return {}; }
}

function saveVrCache(cache) {
  try {
    fs.mkdirSync(path.dirname(VR_CACHE_PATH), { recursive: true });
    const tmp = VR_CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, VR_CACHE_PATH);
  } catch {}
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Nearcade/3.0 (+https://github.com/TheRealFame/Nearcade)' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} resolve(null); });
  });
}

function vrFromCategories(categories) {
  if (!Array.isArray(categories)) return null;
  let supported = false;
  for (const c of categories) {
    const desc = String(c.description || '');
    if (desc === 'VR Only') return 'only';
    if (desc === 'VR Supported' || desc.indexOf('VR Support') !== -1) supported = true;
  }
  return supported ? 'supported' : null;
}

// Resolves `vr: 'only' | 'supported' | null` for every Steam game on disk
// (and refreshes names for ones missing them). Results come from
// store.steampowered.com/api/appdetails (official, category-based — so
// VR-mod games like Valheim are correctly NOT flagged) and are cached in
// ~/.cache/Nearcade/steam-vr-cache.json (7d; failed fetches retried after 1h).
async function resolveVrInfo(games) {
  if (!Array.isArray(games)) return games;
  const now = Date.now();
  const cache = loadVrCache();
  const pending = [];
  for (const g of games) {
    if (g.launcher !== 'steam') continue;
    const entry = cache[g.id];
    if (entry) {
      const ttl = entry.failed ? VR_FAIL_TTL : VR_SUCCESS_TTL;
      if (now - entry.ts < ttl) { g.vr = entry.vr; continue; }
    }
    pending.push(g);
  }
  const pool = async (game) => {
    const url = 'https://store.steampowered.com/api/appdetails?cc=us&l=english&appids=' + game.id;
    const data = await fetchJson(url, 12000);
    const app = data && data[game.id] && data[game.id].data ? data[game.id].data : null;
    const vr = app ? vrFromCategories(app.categories) : null;
    cache[game.id] = { ts: Date.now(), vr, failed: !app };
    game.vr = vr;
    if (app && app.name && (!game.name || game.name === game.id)) game.name = app.name;
  };
  for (let i = 0; i < pending.length; i += 5) {
    await Promise.all(pending.slice(i, i + 5).map(pool));
    saveVrCache(cache);
  }
  return games;
}
