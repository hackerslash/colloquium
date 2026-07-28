# Colloquium

A premium, Discord-inspired peer-to-peer desktop app for persistent text chat
and voice/video rooms — Windows and macOS. Built with Tauri v2 + React
+ TypeScript + Vite. No custom backend: WebRTC signaling goes through the free
PeerJS cloud broker with a hosted TURN relay for NAT traversal, and all data
lives locally in SQLite.

## Quickstart

Download the latest installer from the
[Releases page](https://github.com/hackerslash/colloquium/releases/latest).

**macOS**
1. Move `Colloquium.app` into `/Applications`.
2. Run this once (the build isn't notarized, so without it Screen
   Recording/Camera/Mic permissions won't persist across relaunches):
   ```sh
   curl -fsSL https://raw.githubusercontent.com/hackerslash/colloquium/main/scripts/fix-macos-permissions.sh | bash
   ```
3. Open Colloquium and grant permissions when prompted.

**Windows**
Run the downloaded `.exe`/`.msi` installer, then launch Colloquium from the Start
menu.

## Features

- Persistent text chat and 1:1 / room voice & video calls over WebRTC
- Screen sharing with adjustable quality, up to a link-tested Max mode, plus
  system audio capture on macOS
- Live voice isolation and noise suppression
- Local-first: all data lives in SQLite, no custom backend

## Development

Prerequisites: [Node.js](https://nodejs.org/) + [pnpm](https://pnpm.io/),
[Rust](https://www.rust-lang.org/tools/install), and the
[Tauri platform dependencies](https://tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev
```

Watch party needs `ffmpeg`/`ffprobe`, but **you do not install them** — they are
bundled sidecars, and `pnpm tauri dev` provisions them automatically before the
first build. Once checksums are published in `scripts/ffmpeg-manifest.json` this
is a download; until then the first run compiles a minimal LGPL build from
source, which takes around ten minutes and only ever happens once. To do it
ahead of time, run `pnpm ffmpeg`. See [THIRD-PARTY.md](THIRD-PARTY.md).

If `pnpm install` fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, your
machine has a global pnpm supply-chain policy that blocks recently-published
packages. The lockfile pins exact, vetted versions, so install once with the
guard relaxed:

```sh
pnpm install --config.minimum-release-age=0
```

(The project's `.npmrc` disables the redundant per-script reinstall check, so
subsequent `pnpm tauri dev` runs won't re-trigger this.)

**IDE setup**: [VS Code](https://code.visualstudio.com/) +
[Tauri extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) +
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
