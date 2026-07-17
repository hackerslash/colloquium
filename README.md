# Haven

A premium, Discord-inspired peer-to-peer desktop app (Windows + macOS + Linux)
for persistent text chat and voice/video rooms. Built with Tauri v2 + React +
TypeScript + Vite. No custom backend — WebRTC signaling goes through the free
PeerJS cloud broker, with a hosted TURN relay for NAT traversal, and all data
lives locally in SQLite.

On Linux, the device identity key is stored via the Secret Service D-Bus API,
so a keyring provider (e.g. GNOME Keyring or KWallet) must be running.

## Download

Installers for Windows, macOS (universal), and Linux (`.deb`, `.rpm`,
`.AppImage`) are published on the
[Releases page](https://github.com/hackerslash/Haven/releases/latest).

## Features

- Persistent text chat and 1:1 / room voice & video calls over WebRTC
- Screen sharing with adjustable quality, up to a link-tested Max mode, plus
  system audio capture on macOS
- Live voice isolation and noise suppression
- Local-first: all data lives in SQLite, no custom backend
- Cross-platform: Windows, macOS (universal), and Linux, including a
  persistent Secret Service-backed identity keychain on Linux

## Prerequisites

- [Node.js](https://nodejs.org/) + [pnpm](https://pnpm.io/)
- [Rust toolchain](https://www.rust-lang.org/tools/install)
- Tauri platform dependencies — see https://tauri.app/start/prerequisites/

## Setup

```sh
pnpm install
pnpm tauri dev
```

If `pnpm install` fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, your
machine has a global pnpm supply-chain policy that blocks recently-published
packages. Our lockfile pins exact, vetted versions, so install once with the
guard relaxed for that command:

```sh
pnpm install --config.minimum-release-age=0
```

The project's `.npmrc` sets `verify-deps-before-run=false`, so subsequent
`pnpm tauri dev` runs won't re-trigger that policy check (a project `.npmrc`
can't relax a *global* security policy directly — pnpm ignores local attempts
to weaken it — so we disable the redundant per-script reinstall check instead).

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
