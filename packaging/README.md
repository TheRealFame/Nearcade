# Nearcade Packaging

Packaging files for distribution across package managers.

Each has auto-update built in — after initial submission, new versions
are picked up automatically from GitHub releases.

## AUR (`aur/`)

Push to `aur.archlinux.org/nearcade.git`:
```
git clone ssh://aur@aur.archlinux.org/nearcade.git
cp packaging/aur/{PKGBUILD,.SRCINFO} nearcade/
cd nearcade && git add . && git commit -m "v3.0.3" && git push
```
Updates are detected via `pkgver()` in the PKGBUILD. Run `makepkg --verifysource` to check latest version.

## Scoop (`scoop/`)

Submit to https://github.com/ScoopInstaller/Extras via PR, or host in your own bucket.
Auto-update via `checkver.github` + `autoupdate` fields.

## Winget (`winget/`)

Submit to https://github.com/microsoft/winget-pkgs via PR.
Winget bot auto-detects new GitHub release tags and creates a PR automatically.

**Before submitting:** Replace `UPDATE_ME_WITH_ACTUAL_SHA256` in the installer manifest
with the actual SHA256 of the release `.exe`.

## Homebrew (`homebrew/`)

Submit to https://github.com/Homebrew/homebrew-cask via PR.
Auto-update via `livecheck` with `strategy :github_latest`.

**Before submitting:** Replace `UPDATE_ME_WITH_DMG_SHA256` in the cask formula
with the actual SHA256 of the release `.dmg`.

## Snap (`snap/`)

Publish via Snapcraft dashboard at https://snapcraft.io or CLI:
```
snapcraft login
snapcraft upload --release=stable packaging/snap/snapcraft.yaml
```
Snaps auto-update via snapd's infrastructure.
