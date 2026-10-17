<p align="center"><img src="src-tauri/icons/musify-logo.svg" width="96" alt="Musify logo"></p>

<h1 align="center">Musify</h1>

<p align="center">A fast, lightweight desktop music player with a familiar streaming-app layout —<br>
for your own <b>Navidrome</b>, <b>Subsonic/OpenSubsonic</b> and <b>Jellyfin</b> servers.</p>

> **Status:** early. The first versions are for testing; expect rough edges.

## Features

- **Familiar layout**: library, main view, now-playing panel and player bar; full-screen player and a miniplayer.
- **Native audio engine** (Rust, 64-bit float processing): lossless and hi-res playback up to 32 bit / 768 kHz, sample-exact gapless playback, equal-power crossfade, ReplayGain / loudness normalization, true-peak limiter.
- **Exclusive mode** (Windows WASAPI): each track at its native sample rate and bit depth, bit-perfect when no processing is active; best-rate fallback when the device can't do the native rate.
- **Equalizer**: 10- and 31-band graphic EQ that follows its sliders within half a decibel, parametric EQ, preamp with automatic headroom, Deep Bass, presets, AutoEQ import, live spectrum.
- **Synced lyrics** from your server, `.lrc` files next to downloads, or LRCLIB (can be switched off).
- **Downloads and offline mode**: albums, playlists and favorites, resumable downloads, offline library.
- **Queue and playlists**: drag and drop, shuffle and Shuffle+ with recommendations, autoplay; continue where you left off, also from another device (Subsonic play queue).
- **Statistics** with automatic playlists and a yearly **Rückblick** (recap) with its own colors every year.
- **System integration**: media keys and the Windows media overlay, tray icon, start with Windows, notifications.
- German and English.

## Install

Download `Musify_<version>_x64-setup.exe` from the [releases](https://github.com/Bulma1337/musify/releases) and run it (no admin rights needed). Musify updates itself.

The installer is not code-signed yet, so Windows SmartScreen may warn the first time ("More info" → "Run anyway").

## Supported servers

- **Navidrome** (recommended) and other **Subsonic/OpenSubsonic** servers such as Gonic, Airsonic-Advanced, Ampache or LMS. OpenSubsonic extensions (synced lyrics, transcode offsets, …) are used when the server announces them.
- **Jellyfin** 10.10 or newer.

Credentials are kept in the operating system's credential store, never in settings files.

## Building from source

Requirements:

- Node.js 24+
- Rust (stable; on Windows the MSVC toolchain)
- Windows: Visual Studio Build Tools with the C++ workload and CMake (for the Opus decoder), WebView2 (preinstalled on Windows 11)
- The [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

```bash
npm install
npm run tauri dev      # full app
npm run tauri build    # installer in src-tauri/target/release/bundle
```

`npm run dev` starts only the web UI in a browser (native features such as playback through the engine, downloads and exclusive mode are not available there).

Checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run format:check`, and in `src-tauri/`: `cargo clippy --all-targets -- -D warnings` and `cargo test`.

## Project layout

- `src/` — React + TypeScript UI: `api/` (server adapters), `app/` (shell), `features/` (pages), `player/` (queue and engine bridge)
- `src-tauri/` — the Tauri app: downloads, database, statistics, media controls, tray
- `src-tauri/crates/musify-audio/` — the audio engine: decoding, resampling, DSP, mixing, outputs
- `docs/` — brand and UI guidelines

## Contributing

Issues and pull requests are welcome. Please keep audio changes covered by measurement tests and run the checks above before opening a pull request.
