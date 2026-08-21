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

## Supported Launchers

| Launcher | Detection Method |
|----------|-----------------|
| Steam    | `libraryfolders.vdf` → `.acf` files |
| Heroic   | `legendaryLibrary.json` / `gogLibrary.json` / `sideloadLibrary.json` |
| Lutris   | `pga.db` (SQLite) |

This package uses artificial intelligence large language models for code generation and structure planning.
