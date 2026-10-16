/**
 * Server-independent music model and the interface every server adapter implements.
 *
 * Adapters (Subsonic/OpenSubsonic, Jellyfin) map their wire formats onto these types, so the UI,
 * player and stats never see server-specific shapes. All ids are opaque strings scoped to one server.
 */

export type ServerKind = "subsonic" | "jellyfin";

/** A configured server connection. Secrets (password / token) are stored separately in the OS keyring. */
export interface ServerConfig {
  id: string;
  kind: ServerKind;
  /** User-facing label, e.g. "Navidrome Zuhause". */
  name: string;
  /** Base URL without trailing slash, e.g. "https://music.example.com". */
  url: string;
  username: string;
  /** Jellyfin user id (Subsonic has none). */
  userId?: string;
  /** Reported server software, e.g. "navidrome", "gonic", "jellyfin". */
  serverType?: string;
  serverVersion?: string;
  /** Accept self-signed TLS certificates (home servers). Opt-in per server. */
  allowInsecureTls?: boolean;
  /**
   * Subsonic auth mechanism: "token" (md5 token + salt, default), "password" (legacy `p=enc:` for
   * servers without token support) or "apiKey" (OpenSubsonic `apiKeyAuthentication`).
   */
  authMode?: "token" | "password" | "apiKey";
  /** ISO timestamp when the server was added. */
  addedAt: string;
}

/** What a connected server supports. The UI hides features whose flag is false. */
export interface Capabilities {
  /** Server can return lyrics for a track. */
  lyrics: boolean;
  /** Server lyrics can be time-synced. */
  syncedLyrics: boolean;
  /** Word-level (karaoke) timing is available. */
  wordSyncedLyrics: boolean;
  /** Similar songs / instant mix for autoplay and "Shuffle+". */
  similarTracks: boolean;
  /** Artist biography and images. */
  artistInfo: boolean;
  /** Top tracks per artist. */
  topTracks: boolean;
  /** Play queue can be saved on the server and resumed on other devices. */
  playQueueSync: boolean;
  /** Transcoded streams can start at an offset (needed to seek in non-seekable transcodes). */
  transcodeOffset: boolean;
  /** How playlist reordering is applied on this server. */
  playlistReorder: "replace" | "move" | "removeAdd";
  /** Playlists have a public/private flag. */
  publicPlaylists: boolean;
  /** 1–5 star ratings. */
  ratings: boolean;
  /** Server-side transcoding is available (otherwise only original files can be streamed). */
  transcoding: boolean;
}

/** Opaque reference to an image (album cover, artist picture, playlist mosaic). Resolve via `coverUrl`. */
export type CoverRef = string;

export interface ArtistRef {
  /** Missing when the server only knows the name (e.g. a "feat." credit). */
  id?: string;
  name: string;
}

export interface AlbumRef {
  id: string;
  name: string;
}

export interface ReplayGain {
  /** dB */
  trackGain?: number;
  /** dB */
  albumGain?: number;
  /** Linear peak (1.0 = 0 dBFS). */
  trackPeak?: number;
  /** Linear peak (1.0 = 0 dBFS). */
  albumPeak?: number;
}

/** Technical properties of the original file, used for the quality badge and engine hints. */
export interface AudioFormat {
  /** File suffix/container, e.g. "flac", "mp3", "m4a", "opus". */
  container?: string;
  /** Codec name if known, e.g. "flac", "alac", "aac", "opus". */
  codec?: string;
  /** kbit/s */
  bitRate?: number;
  /** Hz */
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  sizeBytes?: number;
}

export interface Track {
  id: string;
  serverId: string;
  title: string;
  /** Performing artists in display order. */
  artists: ArtistRef[];
  /** Display string as the server provides it ("A feat. B"), falls back to joined artist names. */
  artistLine: string;
  albumArtists: ArtistRef[];
  album?: AlbumRef;
  durationMs: number;
  trackNumber?: number;
  discNumber?: number;
  year?: number;
  genres: string[];
  cover?: CoverRef;
  format: AudioFormat;
  replayGain?: ReplayGain;
  /** undefined = unknown. */
  explicit?: boolean;
  starred: boolean;
  /** ISO timestamp the track was starred/favorited. */
  starredAt?: string;
  playCount?: number;
  /** ISO timestamp of the last play known to the server. */
  lastPlayedAt?: string;
  /** 1–5, undefined = unrated. */
  rating?: number;
  bpm?: number;
  musicBrainzId?: string;
  /** Entry id inside a playlist (Jellyfin needs it to move/remove entries). */
  playlistEntryId?: string;
}

export type ReleaseType = "album" | "single" | "ep" | "compilation" | "live" | "other";

export interface Album {
  id: string;
  serverId: string;
  name: string;
  artists: ArtistRef[];
  artistLine: string;
  year?: number;
  genres: string[];
  cover?: CoverRef;
  trackCount: number;
  durationMs: number;
  /** ISO timestamp the album was added to the server library. */
  addedAt?: string;
  starred: boolean;
  starredAt?: string;
  playCount?: number;
  lastPlayedAt?: string;
  releaseType?: ReleaseType;
}

export interface AlbumDetail extends Album {
  tracks: Track[];
  /** Disc subtitles by disc number, if the server provides them. */
  discTitles?: Record<number, string>;
}

export interface Artist {
  id: string;
  serverId: string;
  name: string;
  cover?: CoverRef;
  albumCount?: number;
  starred: boolean;
  starredAt?: string;
}

export interface ArtistDetail extends Artist {
  /** Albums where this artist is the album artist, newest first. */
  albums: Album[];
}

export interface ArtistInfo {
  /** Plain text or simple HTML from the server (sanitize before rendering). */
  biography?: string;
  /** Large external artist image, if any. */
  imageUrl?: string;
  similarArtists: Artist[];
  externalUrl?: string;
}

export interface Playlist {
  id: string;
  serverId: string;
  name: string;
  comment?: string;
  owner?: string;
  public: boolean;
  trackCount: number;
  durationMs: number;
  cover?: CoverRef;
  createdAt?: string;
  changedAt?: string;
  /** True when the current user cannot edit it (smart playlist, owned by someone else). */
  readOnly: boolean;
}

export interface PlaylistDetail extends Playlist {
  tracks: Track[];
}

export interface Genre {
  name: string;
  trackCount?: number;
  albumCount?: number;
}

export interface SearchResult {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
}

export interface LyricWord {
  startMs: number;
  endMs?: number;
  text: string;
}

export interface LyricLine {
  /** Missing for unsynced lyrics. */
  startMs?: number;
  text: string;
  /** Word timing for karaoke display, if available. */
  words?: LyricWord[];
}

export interface Lyrics {
  synced: boolean;
  lines: LyricLine[];
  /** Applied on top of line times: displayed time = startMs + offsetMs. */
  offsetMs: number;
  /** ISO 639 language code if known. */
  language?: string;
  source: "server" | "local" | "lrclib";
}

export type AlbumListType =
  | "recentlyPlayed"
  | "recentlyAdded"
  | "mostPlayed"
  | "random"
  | "starred"
  | "alphabeticalByName"
  | "alphabeticalByArtist"
  | "highestRated"
  | "byYear"
  | "byGenre";

export interface AlbumListOptions {
  size?: number;
  offset?: number;
  /** Required for "byGenre". */
  genre?: string;
  /** Required for "byYear". */
  fromYear?: number;
  toYear?: number;
}

export interface PageOptions {
  size?: number;
  offset?: number;
}

/** Requested stream/download quality. `maxBitRateKbps` undefined = original file, untouched. */
export interface StreamQuality {
  maxBitRateKbps?: number;
  /** Target codec when transcoding, e.g. "opus", "mp3", "aac". Ignored for original quality. */
  format?: string;
}

/** Everything the native engine/downloader needs to fetch one track. */
export interface StreamSource {
  url: string;
  /** Extra request headers (e.g. Jellyfin Authorization). */
  headers: Record<string, string>;
  /**
   * Stable cache key that never contains credentials: server id + track id + quality.
   * The engine hashes it for cache file names.
   */
  cacheKey: string;
  /** True when the server transcodes (byte ranges may not be seekable). */
  transcoded: boolean;
  /** Expected container if known, e.g. "flac", "mp3". */
  container?: string;
  /** How to restart a transcoded stream at an offset: query parameter template, if supported. */
  timeOffset?: { param: string; unit: "seconds" | "ticks" };
}

export type PlaybackEvent =
  | { type: "start"; trackId: string; positionMs: number }
  | { type: "progress"; trackId: string; positionMs: number; paused: boolean }
  | { type: "stop"; trackId: string; positionMs: number }
  /** A completed listen that should count as a play (after 50 % or 4 minutes). */
  | { type: "scrobble"; trackId: string; playedAt: Date };

export interface SavedPlayQueue {
  trackIds: string[];
  currentId?: string;
  positionMs: number;
  changedAt?: string;
  changedBy?: string;
}

export type StarrableKind = "track" | "album" | "artist";

export interface MusicProvider {
  readonly server: ServerConfig;
  readonly capabilities: Capabilities;

  /** Cheap authenticated request to check that the connection works. */
  ping(): Promise<void>;

  // --- Browsing --------------------------------------------------------------------------------
  getAlbumList(type: AlbumListType, options?: AlbumListOptions): Promise<Album[]>;
  getAlbum(id: string): Promise<AlbumDetail>;
  getArtists(): Promise<Artist[]>;
  getArtist(id: string): Promise<ArtistDetail>;
  getArtistInfo(id: string): Promise<ArtistInfo | null>;
  getTopTracks(artist: ArtistRef, count?: number): Promise<Track[]>;
  getSimilarTracks(trackId: string, count?: number): Promise<Track[]>;
  getRandomTracks(options?: {
    size?: number;
    genre?: string;
    fromYear?: number;
    toYear?: number;
  }): Promise<Track[]>;
  getTrack(id: string): Promise<Track>;
  getGenres(): Promise<Genre[]>;
  getTracksByGenre(genre: string, options?: PageOptions): Promise<Track[]>;
  search(
    query: string,
    limits?: { artists?: number; albums?: number; tracks?: number; offset?: number },
  ): Promise<SearchResult>;

  // --- Favorites (favorite tracks, saved albums, followed artists) ----------------------------
  getStarred(): Promise<{ tracks: Track[]; albums: Album[]; artists: Artist[] }>;
  setStarred(kind: StarrableKind, id: string, starred: boolean): Promise<void>;
  setRating?(trackId: string, rating: number | null): Promise<void>;

  // --- Playlists ---------------------------------------------------------------------------------
  getPlaylists(): Promise<Playlist[]>;
  getPlaylist(id: string): Promise<PlaylistDetail>;
  createPlaylist(name: string, trackIds?: string[]): Promise<Playlist>;
  updatePlaylist(id: string, changes: { name?: string; comment?: string; public?: boolean }): Promise<void>;
  addToPlaylist(id: string, trackIds: string[]): Promise<void>;
  /** Removes entries by their current 0-based positions. */
  removeFromPlaylist(id: string, indices: number[]): Promise<void>;
  /**
   * Applies a new order. `tracks` is the complete playlist in the desired order, as returned by
   * `getPlaylist` (entry ids are needed by servers that move entries individually).
   */
  reorderPlaylist(id: string, tracks: Track[]): Promise<void>;
  deletePlaylist(id: string): Promise<void>;

  // --- Lyrics ------------------------------------------------------------------------------------
  /** Lyrics provided by the server itself; null if none. External sources are handled elsewhere. */
  getLyrics(track: Track): Promise<Lyrics | null>;

  // --- Media ---------------------------------------------------------------------------------------
  getStreamSource(track: Track, quality?: StreamQuality): StreamSource;
  getDownloadSource(track: Track, quality?: StreamQuality): StreamSource;
  /** URL for an image. `size` is the requested edge length in px (servers may round). */
  coverUrl(cover: CoverRef, size?: number): string;

  // --- Reporting ---------------------------------------------------------------------------------
  reportPlayback(event: PlaybackEvent): Promise<void>;

  // --- Cross-device play queue (only if capabilities.playQueueSync) --------------------------------
  savePlayQueue?(queue: SavedPlayQueue): Promise<void>;
  getPlayQueue?(): Promise<SavedPlayQueue | null>;
}

export type ProviderErrorKind =
  "auth" | "network" | "timeout" | "notFound" | "unsupported" | "server" | "invalidResponse";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** HTTP status or server error code, if any. */
  readonly code?: number;

  constructor(kind: ProviderErrorKind, message: string, code?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.kind = kind;
    this.code = code;
  }
}

/** Result of probing a URL before login. */
export interface ServerProbe {
  kind: ServerKind;
  serverType?: string;
  serverVersion?: string;
  /** Normalized base URL that answered. */
  url: string;
}

/** Credentials entered in the login dialog. */
export interface LoginInput {
  url: string;
  username: string;
  password: string;
  name?: string;
}

/** Result of a successful login: the config to persist plus the secret to put in the keyring. */
export interface LoginResult {
  server: ServerConfig;
  /** Subsonic: password or API key. Jellyfin: access token. */
  secret: string;
}

/** Static side of an adapter: probing, login and connecting with a stored secret. */
export interface ProviderFactory {
  kind: ServerKind;
  /** Returns null if the URL does not look like this kind of server. */
  probe(url: string): Promise<ServerProbe | null>;
  login(input: LoginInput, probe: ServerProbe): Promise<LoginResult>;
  /** Creates a ready provider (capabilities discovered) from stored config + secret. */
  connect(server: ServerConfig, secret: string): Promise<MusicProvider>;
}
