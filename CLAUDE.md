# Navify – notes for Claude

Spotify-style desktop music player for Subsonic/OpenSubsonic (Navidrome first) and Jellyfin.
Tauri 2 shell, React 19 + TypeScript frontend, native Rust audio engine. Will be open-sourced.

## Priorities

- **Audio quality is the top priority.** f64 DSP, high-quality resampling, gapless, bit-perfect exclusive mode,
  true-peak limiting. Anything that touches the sound path needs a measurement test.
- Fast and lightweight: virtualize long lists, keep the UI thread free, never block the audio threads.
- Spotify-like layout and behaviour, but no Spotify assets, logos or trademarks.

## Layout

- `src/api/` – `MusicProvider` interface and server adapters (`subsonic/`, `jellyfin/`).
- `src/app/` – shell and layout. `src/features/<feature>/` – pages and feature UI.
- `src/player/` – player store, queue, shuffle, IPC to the engine.
- `src/i18n/locales/{de,en}.json` – every UI string goes through i18next; both files must have the same keys.
- `src-tauri/src/audio/` – native engine (see the plan's audio section). Other Rust modules: `downloads/`, `db/`, `lyrics/`, `covers/`.
- `docs/AGENT-MODELS.md` – which model and reasoning effort to use for subagents, and which packages can run in parallel. Follow it.

## Conventions

- Code, identifiers and comments in English. UI text in German and English via i18n.
- Colors only via theme tokens in `src/styles/index.css` (`bg-surface`, `text-subdued`, `bg-accent` …); the accent is switchable.
- Server requests go through `@tauri-apps/plugin-http` (Navidrome sends no CORS headers). Never log or cache URLs that
  contain credentials; cache keys are derived from server id + item id.
- Feature-gate OpenSubsonic features via `getOpenSubsonicExtensions`, not via the server name.
- Rust: `cargo clippy` clean; no allocation or locks in the audio callback or DSP loop.

## Commands

- `npm run dev` – Vite dev server (browser preview, native calls are skipped via `inTauri`).
- `npm run tauri dev` – full app.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run format`.
- `cargo test` / `cargo clippy` inside `src-tauri/`. The Rust toolchain lives in `%USERPROFILE%\.cargo\bin`.

## Git

- Repo: github.com/Bulma1337/navify. One branch + PR per milestone (`m<N>-<topic>`), squash-merge when green.
- The updater private key lives in `%USERPROFILE%\.navify-keys\` and in the repo secrets – never commit it.
