# @nearcade/accent-color

Cross-platform system accent color detection for Node.js.

## Usage

```js
const accent = require('@nearcade/accent-color');

const color = accent.get();
// { hex: '#007aff', rgb: { r: 0, g: 122, b: 255 }, hsl: { h: 211, s: 100, l: 50 } }
```

## API

### `accent.get()`

Returns `null` on unsupported platforms.

### `accent.getAsync()`

Async variant (same as sync for now, reserved for future native addons).

## Platforms

| Platform | Method |
|----------|--------|
| Windows  | Registry `AccentColor` DWORD |
| macOS    | `defaults read -g AppleAccentColor` |
| Linux    | D-Bus portal → GNOME `gsettings` → KDE `kreadconfig5` |
