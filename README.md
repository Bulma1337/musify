<p align="center"><img src="src-tauri/icons/musify-logo.svg" width="96" alt="Musify logo"></p>

<h1 align="center">Musify</h1>

<p align="center">A fast, lightweight desktop music player with a familiar streaming-app layout —<br>
for your own <b>Navidrome</b>, <b>Subsonic/OpenSubsonic</b> and <b>Jellyfin</b> servers.</p>

> **Status:** early development. Not ready for daily use yet.

## Planned features

- Familiar three-panel layout: library, main view, now-playing panel, player bar
- Native Rust audio engine: lossless and hi-res playback, true gapless, crossfade, ReplayGain, bit-perfect exclusive mode
- Professional equalizer: 10/31-band graphic and parametric modes, preamp, limiter, bass enhancer, spectrum analyzer, AutoEQ import
- Synced lyrics from your server, local `.lrc` files or LRCLIB
- Offline downloads, playlists with drag-and-drop reordering, shuffle with recommendations, queue, mini player
- Listening stats, automatic playlists and a yearly recap
- Windows installer with automatic updates

## Development

Requirements: Node.js 24+, Rust (stable, MSVC on Windows), and the Tauri 2 prerequisites.

```bash
npm install
npm run tauri dev
```

Checks: `npm run typecheck`, `npm run lint`, `npm test`, and `cargo test` in `src-tauri/`.
