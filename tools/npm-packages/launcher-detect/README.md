# @nearcade/launcher-detect

Detect installed game launchers (Steam, Heroic, Lutris) and launch games via their protocol URLs — cross-platform (Linux, Windows, macOS).

## Usage

```js
const { detect, detectGames, launch } = require('@nearcade/launcher-detect');

// Available launchers
const launchers = detect();
// { steam: true, heroic: true, lutris: false }

// Installed games from all launchers
const games = detectGames();
// [{ id: '730', name: 'Counter-Strike 2', launcher: 'steam', lastPlayed: ... }, ...]

// Launch a game
launch({ launcher: 'steam', gameId: '730' });
```

## Watching a launched game

`launch()` is fire-and-forget: `steam steam://launch/<id>` hands the URI to the
already-running Steam client and exits immediately, long before the game exists.
To know when the game actually starts (and when it exits), watch the *game*
instead of the launcher:

```js
const { steamAppIdOf, pidsForGame, watchGame } = require('@nearcade/launcher-detect');

// What AppID is this command asking for? (null when it isn't a Steam hand-off)
const appId = steamAppIdOf('steam steam://launch/2011600');   // '2011600'

// Currently live PIDs carrying that AppID (Linux; [] elsewhere)
const pids = pidsForGame(appId);                              // [12345, 12350]

const watcher = watchGame(appId, {
  pollMs: 2000,             // how often to check
  graceMs: 5000,            // consecutive misses before `onGone` (re-exec tolerance)
  startTimeoutMs: 60000,    // 0 disables; fires once if the game never appears
  onAppear(id, pids) { /* focus it, route audio, ... */ },
  onGone(id, { neverSeen }) { /* tear the session down */ },
  onStartTimeout(id) { /* slow/failed launch — keep the session up */ }
});
watcher.stop();
```

`watchGame` picks a backend automatically:

| Source       | Platform | Signal |
|--------------|----------|--------|
| `proc`       | Linux    | `SteamAppId=` / `SteamGameId=` in `/proc/<pid>/environ` |
| `steam-log`  | all      | `logs/gameprocess_log.txt` (`adding PID` / `no longer tracking` / `Remove … from running list`) |

Force one with `watchGame(appId, { source: 'proc' | 'steam-log' })`. Also
exported: `steamLogPath()` and `steamLogRunningAppIds()` (portable "is it up"
probe for platforms without `/proc`).

## Supported Launchers

| Launcher | Detection Method |
|----------|-----------------|
| Steam    | `libraryfolders.vdf` → `.acf` files |
| Heroic   | `legendaryLibrary.json` / `gogLibrary.json` / `sideloadLibrary.json` |
| Lutris   | `pga.db` (SQLite) |

This package uses artificial intelligence large language models for code generation and structure planning.
