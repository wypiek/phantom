# Installing PHANTOM (Noli)

PHANTOM puts Noli, a small pixel creature, on your desktop. After installing,
launch **PHANTOM** like any other app. Noli appears in the bottom-right corner
and a tray / menu-bar icon gives you Settings and Quit.

## macOS (11 Big Sur or newer)

1. Open `PHANTOM_<version>_aarch64.dmg` (Apple Silicon) or `PHANTOM_<version>_x64.dmg` (Intel).
2. Drag **PHANTOM** onto **Applications**.
3. Open it from Applications or Spotlight.

**"Apple could not verify PHANTOM is free of malware"** (or "can't be opened
because Apple cannot check it") appears for builds that aren't signed with an
Apple Developer ID. Allow it once:

1. Open PHANTOM and click **Done** on the warning.
2. Open **System Settings → Privacy & Security**, scroll down and click
   **Open Anyway** next to the PHANTOM message, then confirm with your password.

On macOS 14 and older, right-click PHANTOM in Applications → **Open** → **Open**
also works.

**"PHANTOM is damaged and can't be opened"** means macOS quarantined a copy whose
signature it couldn't check (for example, an old build, or one copied in a way
that dropped part of the app). Download the latest installer again. If the
message stays, drag PHANTOM to Applications and run this once in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/PHANTOM.app
```

macOS will also ask for:

- **Microphone**, the first time you hold push-to-talk.
- **Screen Recording** and **Accessibility**, only if you let Noli see your screen
  and use the mouse/keyboard (Settings → Computer Control has buttons for both).
- Your **login keychain password**, when PHANTOM first reads a saved API key.
  Click **Always Allow** so it doesn't ask again.

## Windows 10 / 11

1. Run `PHANTOM_<version>_x64-setup.exe`. It installs for your user only (no admin needed).
2. If SmartScreen says "Windows protected your PC", click **More info → Run anyway**
   (the installer isn't code-signed).
3. Launch **PHANTOM** from the Start menu.

The installer fetches Microsoft's WebView2 runtime if your PC doesn't have it.
Windows 11 already includes it.

## Linux (x86-64)

Pick one:

- **AppImage** (any distro): `chmod +x PHANTOM_<version>_amd64.AppImage && ./PHANTOM_<version>_amd64.AppImage`
- **Debian / Ubuntu / Mint**: `sudo apt install ./PHANTOM_<version>_amd64.deb`
- **Fedora / openSUSE**: `sudo dnf install ./PHANTOM-<version>-1.x86_64.rpm`

Then launch **PHANTOM** from your app menu.

Optional extras:

- `espeak-ng` gives Noli a voice.
- `wmctrl` lets him see window titles.
- One of `gnome-screenshot`, `grim` (Wayland), `spectacle` or `scrot` lets him take screenshots.

Transparent windows need a compositor. Most desktops have one; on a bare X11
window manager, run `picom`.

## First launch

A short setup walks you through choosing a brain:

- **Claude Code** reuses your installed `claude` CLI login.
- **OpenRouter** and **Groq** need an API key, which is stored in your system keychain.

It also downloads the local speech model (~140 MB). Everything can be changed
later in Settings.

## Building the installers yourself

Requirements: Node 20+, Rust (stable), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for your OS, plus CMake (for the local Whisper speech engine).

```bash
npm ci
npm run tauri build
```

Installers land in `src-tauri/target/release/bundle/`. Shortcuts that copy
them into `release/`:

| Command | Builds | Runs on |
|---|---|---|
| `npm run installer:mac` | `.dmg` (+ `.app`) | macOS |
| `npm run installer:linux` | `.deb`, `.rpm`, `.AppImage` (x86-64) | any OS with Docker |
| `npm run tauri build` | `-setup.exe` + `.msi` | Windows |

For all of them at once, push the repo to GitHub and run the **Build installers**
workflow (`.github/workflows/release.yml`). It builds macOS (Apple Silicon and
Intel), Windows and Linux. Pushing a tag like `v0.1.0` also creates a draft
release with every installer attached.

## Uninstalling

- **macOS**: quit PHANTOM, then drag it from Applications to the Bin.
- **Windows**: Settings → Apps → PHANTOM → Uninstall.
- **Linux**: `sudo apt remove phantom` / `sudo dnf remove phantom`, or delete the AppImage.

Your settings, conversations and speech models are kept in the app data folder
(Settings → Privacy & Memory → Open folder). Delete that folder to remove everything.
