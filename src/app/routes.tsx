import { createHashRouter } from "react-router";
import { AppShell } from "./layout/AppShell";
import { RouteError } from "./RouteError";

/**
 * Route table. Pages are code-split; each feature folder owns its page component(s).
 * Hash routing keeps deep links working inside the Tauri webview without server rewrites.
 */
export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        lazy: () => import("@/features/home/HomePage").then((m) => ({ Component: m.HomePage })),
      },
      {
        path: "lyrics",
        lazy: () => import("@/features/lyrics/LyricsPage").then((m) => ({ Component: m.LyricsPage })),
      },
      {
        path: "search",
        lazy: () => import("@/features/search/SearchPage").then((m) => ({ Component: m.SearchPage })),
      },
      {
        path: "album/:id",
        lazy: () => import("@/features/album/AlbumPage").then((m) => ({ Component: m.AlbumPage })),
      },
      {
        path: "artist/:id",
        lazy: () => import("@/features/artist/ArtistPage").then((m) => ({ Component: m.ArtistPage })),
      },
      {
        path: "playlist/:id",
        lazy: () => import("@/features/playlist/PlaylistPage").then((m) => ({ Component: m.PlaylistPage })),
      },
      {
        path: "liked",
        lazy: () => import("@/features/liked/LikedPage").then((m) => ({ Component: m.LikedPage })),
      },
      {
        path: "genre/:name",
        lazy: () => import("@/features/genre/GenrePage").then((m) => ({ Component: m.GenrePage })),
      },
      {
        path: "albums/:type",
        lazy: () => import("@/features/browse/AlbumGridPage").then((m) => ({ Component: m.AlbumGridPage })),
      },
    ],
  },
]);
