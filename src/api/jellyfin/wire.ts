/**
 * Jellyfin wire types (subset of the 12.x OpenAPI schemas that Musify reads).
 * Property names follow the server's PascalCase JSON. Everything is optional because servers and
 * plugins omit null fields.
 */

export interface WireNameId {
  Name?: string | null;
  Id?: string;
}

export interface WireUserData {
  PlayCount?: number;
  IsFavorite?: boolean;
  /** ISO timestamp. */
  LastPlayedDate?: string | null;
  Played?: boolean;
  Rating?: number | null;
}

export interface WireMediaStream {
  Type?: string;
  Codec?: string | null;
  /** bit/s */
  BitRate?: number | null;
  BitDepth?: number | null;
  Channels?: number | null;
  SampleRate?: number | null;
}

export interface WireMediaSource {
  Id?: string;
  Container?: string | null;
  Size?: number | null;
  /** bit/s, whole file. */
  Bitrate?: number | null;
  MediaStreams?: WireMediaStream[];
}

/** BaseItemDto – used for Audio, MusicAlbum, MusicArtist, Playlist and MusicGenre items. */
export interface WireItem {
  Id: string;
  Name?: string | null;
  Type?: string;
  Container?: string | null;
  MediaSources?: WireMediaSource[];
  RunTimeTicks?: number | null;
  ProductionYear?: number | null;
  IndexNumber?: number | null;
  ParentIndexNumber?: number | null;
  Genres?: string[] | null;
  /** Display names of the performing artists (parallel to `ArtistItems`). */
  Artists?: string[] | null;
  ArtistItems?: WireNameId[] | null;
  AlbumArtist?: string | null;
  AlbumArtists?: WireNameId[] | null;
  Album?: string | null;
  AlbumId?: string | null;
  AlbumPrimaryImageTag?: string | null;
  ImageTags?: Record<string, string> | null;
  UserData?: WireUserData | null;
  DateCreated?: string | null;
  Overview?: string | null;
  ChildCount?: number | null;
  SongCount?: number | null;
  AlbumCount?: number | null;
  /** dB */
  NormalizationGain?: number | null;
  AlbumNormalizationGain?: number | null;
  ProviderIds?: Record<string, string> | null;
  ExternalUrls?: { Name?: string; Url?: string }[] | null;
  /** Only present on items inside a playlist. */
  PlaylistItemId?: string | null;
  CanDelete?: boolean | null;
}

export interface WireQueryResult {
  Items?: WireItem[];
  TotalRecordCount?: number;
  StartIndex?: number;
}

export interface WirePublicInfo {
  ServerName?: string;
  Version?: string;
  ProductName?: string;
  Id?: string;
}

export interface WireAuthResult {
  AccessToken?: string | null;
  User?: { Id?: string; Name?: string | null } | null;
}

export interface WirePlaylistDto {
  OpenAccess?: boolean;
  Shares?: { UserId?: string; CanEdit?: boolean }[];
  ItemIds?: string[];
}

export interface WireLyricCue {
  Position?: number;
  EndPosition?: number;
  /** ticks */
  Start?: number;
  /** ticks */
  End?: number | null;
}

export interface WireLyricLine {
  Text?: string | null;
  /** ticks; null for unsynced lines. */
  Start?: number | null;
  Cues?: WireLyricCue[] | null;
}

export interface WireLyricDto {
  Metadata?: { Offset?: number | null; IsSynced?: boolean | null } | null;
  Lyrics?: WireLyricLine[] | null;
}
