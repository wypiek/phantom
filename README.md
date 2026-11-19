# phantom
A very mysterious AI desktop companion.

PHANTOM puts **Noli**, a small pixel creature, on your desktop. He idles, wanders,
dozes off when ignored, and talks back.

- **Talk** by typing in his chatbox, or hold **Left Control** to speak. Speech is recognised locally with Whisper.
- **Hear** replies in a distorted horror voice, spoken sentence by sentence while the answer streams in.
- **Choose a brain**: Claude Code (reuses your login), OpenRouter or Groq. API keys live in your system keychain.
- **Computer help** (opt-in): he can look at your screen, open apps and use the mouse and keyboard, asking first by default.
- **Memory**: conversations and a few facts about you are stored locally, with full controls in Settings.

Built with Tauri 2, React and Rust. Runs on macOS, Windows and Linux.

## Install

Download an installer from [Releases](../../releases) and see [INSTALL.md](INSTALL.md)
for first-launch steps on each platform.

## Develop

```bash
npm ci
npm run tauri dev     # run with hot reload
npm test              # frontend tests
cd src-tauri && cargo test
```

Installers: `npm run installer:mac`, `npm run installer:linux` (Docker), or the
**Build installers** GitHub workflow for every platform at once.
