# UI guide

How pages and components in Navify are built. Read this before adding a page.

## Building blocks

| Need                                               | Use                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Server data                                        | hooks in `src/api/queries.ts` (`useAlbum`, `useArtist`, `usePlaylist`, …)                     |
| The connected server                               | `useProvider()` from `src/api/session.ts`                                                     |
| Colored header with big cover, title, play button  | `components/media/PageHeader.tsx`                                                             |
| Track table (virtualized, selection, context menu) | `components/media/TrackList.tsx`                                                              |
| Album/playlist/artist card with hover play button  | `components/media/MediaCard.tsx`                                                              |
| One row of cards with "Alle anzeigen"              | `Shelf` in `components/media/Shelf.tsx`; full grid: `CardGrid`                                |
| Cover image                                        | `components/media/Cover.tsx` (never build cover URLs by hand)                                 |
| Play / pause a context                             | `playOrToggle(context, loader)` + `loaders` from `src/player/actions.ts`                      |
| "Is this album playing?"                           | `useIsContextPlaying(type, id)`                                                               |
| Buttons, switches, text fields, sliders            | `components/ui/*`                                                                             |
| Feedback after an action                           | `toast()` / `toastError()` from `components/ui/toast.ts`                                      |
| Durations and dates                                | `formatDuration`, `formatLongDuration`, `formatDate`, `formatRelativeDate` in `lib/format.ts` |
| Errors from the server                             | `describeError(t, error)` from `src/api/errors.ts`                                            |

## Rules

- **Text**: every string goes through i18next. Feature strings live in `src/features/<feature>/locales/de.json` and
  `en.json`, each file with one top-level key named after the feature (`{ "album": { … } }`). German and English must
  have the same keys (a test enforces it). Shared strings (`common.*`, `menu.*`, `track.*`, `player.*`) are in
  `src/i18n/locales`.
- **Colors**: only theme tokens (`bg-surface`, `bg-elevated`, `bg-highlight`, `text-subdued`, `text-accent`,
  `bg-accent` …). No hard-coded hex colors except data-driven ones (cover colors).
- **Layout**: pages render inside the main scroll container; don't add another scroll container. Use `px-6` page
  padding. Section titles: `text-2xl font-bold tracking-tight`.
- **States**: show a `Spinner` while loading, `describeError` on errors, and a friendly empty state when there is
  no data.
- **Performance**: long track lists always use `TrackList` (virtualized). Don't fetch per row.
- **Accessibility**: icon-only buttons need `aria-label` (`IconButton` takes `label`). Links are real `<Link>`s.
- **Tests**: page tests use `renderPage(<Page />, { path: "/album/:id", url: "/album/al1" })` from
  `src/test/renderPage.tsx`, which provides the in-memory fake server from `src/test/fakeProvider.ts`. Tests run in
  English (`navigator.language` in jsdom), so match text with English strings or regexes.
