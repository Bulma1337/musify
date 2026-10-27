# Musify – notes for Claude

Desktop music player with a familiar three-panel streaming layout for Subsonic/OpenSubsonic (Navidrome first) and Jellyfin.
Tauri 2 shell, React 19 + TypeScript frontend, native Rust audio engine. Source-available under the Musify License
(`LICENSE`, 2.0): free private and commercial use; changing and sharing it (also changed versions) only free of charge; no selling. Dependencies must stay permissive
(MIT/Apache/BSD/ISC/Zlib, MPL-2.0 unmodified, OFL fonts); no GPL/LGPL.

## Priorities

- **Audio quality is the top priority.** f64 DSP, high-quality resampling, gapless, bit-perfect exclusive mode,
  true-peak limiting. Anything that touches the sound path needs a measurement test.
- Fast and lightweight: virtualize long lists, keep the UI thread free, never block the audio threads.
- Familiar layout, but an independent identity: follow docs/BRAND.md (no third-party names, logos, colors, fonts or copied UI texts).

## Layout

- `src/api/` – `MusicProvider` interface and server adapters (`subsonic/`, `jellyfin/`).
- `src/app/` – shell and layout. `src/features/<feature>/` – pages and feature UI.
- `src/player/` – player store, queue, shuffle, IPC to the engine.
- `src/i18n/locales/{de,en}.json` – every UI string goes through i18next; both files must have the same keys.
- `src/i18n/locales/extra/<code>.json` – 25 more languages, one merged file each (shape of `node scripts/i18n.mjs export`).
  New or changed texts need every language; `src/i18n/extraLocales.test.ts` checks keys, placeholders and plurals.
- `src-tauri/src/audio/` – native engine (see the plan's audio section). Other Rust modules: `downloads/`, `db/`, `lyrics/`, `covers/`.
- `docs/AGENT-MODELS.md` – which model and reasoning effort to use for subagents, and which packages can run in parallel. Follow it.

## Conventions

- Code, identifiers and comments in English. UI text in German and English via i18n. German UI text uses plain
  generic forms without gender characters ("Künstler", "Ersteller" — never "Künstler*innen").

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

- Repo: github.com/Bulma1337/musify. One branch + PR per milestone (`m<N>-<topic>`), squash-merge when green.
- The updater private key lives in `%USERPROFILE%\.navify-keys\` (folder name from before the rename to Musify) and in the repo secrets – never commit it.

## Stay inside the project folder

The user runs with bypass permissions, which only cover `C:\Users\PC\Documents\Navify`. Every access outside it,
direct writes into `.git/`, **and any shell command containing `cd` / `Set-Location` / `Push-Location` or an
`$env:…=` assignment** triggers a confirmation dialog. So:

- Never change directory in a command. Use absolute paths: `git -C <path>`, `cargo … --manifest-path <path>`,
  `npm --prefix <path>`, absolute file arguments. The shell's working directory is already the project root.
- Git worktrees go to `.worktrees/<name>` (ignored), never to sibling folders.
- Local test servers live in `devservers/` (ignored; start with `devservers/start-all.ps1`, credentials in
  `devservers/test-servers.json`). Screenshots and other dev output go to `.dev/` (`node scripts/screenshots.mjs`).
- Cargo builds use the default cargo home (no env changes). To read a crate's source, use the read-only copy in
  `.dev/cargo-home/registry/src` (refresh with `cargo fetch` and `CARGO_HOME` set via the tool environment only if
  versions change), never `%USERPROFILE%\.cargo`.
- No temp files in `%TEMP%`; use `.dev/` or a crate's `target/`. Use git commands, not file edits, for anything in `.git/`.
- Subagent briefs must repeat these rules.
