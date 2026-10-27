/**
 * Subsonic / OpenSubsonic JSON wire types (`f=json`). Everything except the envelope status is optional:
 * servers differ in which fields they fill, and OpenSubsonic additions are absent on legacy servers.
 */

export interface WireError {
  code: number;
  message?: string;
}

export interface WireEnvelopeBody {
  status: "ok" | "failed";
  version?: string;
  type?: string;
  serverVersion?: string;
  openSubsonic?: boolean;
  error?: WireError;
}

export interface WireEnvelope {
  "subsonic-response"?: WireEnvelopeBody;
}

export interface WireItemArtist {
  id?: string;
  name: string;
}

export interface WireReplayGain {
  trackGain?: number;
  albumGain?: number;
  trackPeak?: number;
  albumPeak?: number;
}

export interface WireChild {
  id: string;
  title?: string;
  artist?: string;
  artistId?: string;
  artists?: WireItemArtist[];
  displayArtist?: string;
  albumArtists?: WireItemArtist[];
  displayAlbumArtist?: string;
  album?: string;
  albumId?: string;
  /** Seconds. */
  duration?: number;
  track?: number;
  discNumber?: number;
  year?: number;
  genre?: string;
  genres?: { name: string }[];
  coverArt?: string;
  suffix?: string;
  contentType?: string;
  bitRate?: number;
  samplingRate?: number;
  bitDepth?: number;
  channelCount?: number;
  size?: number;
  replayGain?: WireReplayGain;
  explicitStatus?: string;
  starred?: string;
  playCount?: number;
  played?: string;
  userRating?: number;
  bpm?: number;
  musicBrainzId?: string;
}

export interface WireAlbum {
  id: string;
  name?: string;
  title?: string;
  artist?: string;
  artistId?: string;
  artists?: WireItemArtist[];
  displayArtist?: string;
  year?: number;
  genre?: string;
  genres?: { name: string }[];
  coverArt?: string;
  songCount?: number;
  /** Seconds. */
  duration?: number;
  created?: string;
  starred?: string;
  playCount?: number;
  played?: string;
  releaseTypes?: string[];
  isCompilation?: boolean;
  discTitles?: { disc: number; title?: string; name?: string }[];
  song?: WireChild[];
}

export interface WireArtist {
  id: string;
  name?: string;
  coverArt?: string;
  albumCount?: number;
  starred?: string;
  album?: WireAlbum[];
  /** OpenSubsonic: how the artist is credited ("artist", "albumartist", "composer", …). */
  roles?: string[];
}

export interface WirePlaylist {
  id: string;
  name?: string;
  comment?: string;
  owner?: string;
  public?: boolean;
  readonly?: boolean;
  songCount?: number;
  duration?: number;
  coverArt?: string;
  created?: string;
  changed?: string;
  entry?: WireChild[];
}

export interface WireCueLine {
  /** Index of the line this cue belongs to (top-level `cueLine` only). */
  index?: number;
  start: number;
  end?: number;
  value: string;
}

export interface WireStructuredLyrics {
  lang?: string;
  synced?: boolean;
  /** Milliseconds. */
  offset?: number;
  line?: { start?: number; value?: string; cueLine?: WireCueLine[] }[];
  cueLine?: WireCueLine[];
}

export interface WireExtension {
  name: string;
  versions?: number[];
}

export interface WireSearchResult3 {
  artist?: WireArtist[];
  album?: WireAlbum[];
  song?: WireChild[];
}

export interface WirePlayQueue {
  entry?: WireChild[];
  current?: string;
  position?: number;
  changed?: string;
  changedBy?: string;
}

/** Response bodies per endpoint (merged with the envelope fields by the client). */
export interface WireBodies {
  albumList2?: { album?: WireAlbum[] };
  album?: WireAlbum;
  artists?: { index?: { artist?: WireArtist[] }[] };
  artist?: WireArtist;
  artistInfo2?: {
    biography?: string;
    largeImageUrl?: string;
    lastFmUrl?: string;
    similarArtist?: WireArtist[];
  };
  topSongs?: { song?: WireChild[] };
  similarSongs2?: { song?: WireChild[] };
  randomSongs?: { song?: WireChild[] };
  song?: WireChild;
  genres?: { genre?: { value: string; songCount?: number; albumCount?: number }[] };
  songsByGenre?: { song?: WireChild[] };
  searchResult3?: WireSearchResult3;
  starred2?: WireSearchResult3;
  playlists?: { playlist?: WirePlaylist[] };
  playlist?: WirePlaylist;
  lyricsList?: { structuredLyrics?: WireStructuredLyrics[] };
  lyrics?: { value?: string; artist?: string; title?: string };
  openSubsonicExtensions?: WireExtension[];
  playQueue?: WirePlayQueue;
}
