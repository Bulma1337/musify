//! One playback session on a renderer: turns the player's commands into renderer calls, watches the
//! device and reports back with the same [`EngineEvent`]s the local engine sends, so the queue stays
//! in Musify and moves on when a track ends.
//!
//! [`SessionCore`] is the state machine (driven with explicit timestamps, tested with a fake
//! renderer); [`Session`] runs it on its own thread.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use musify_audio::api::{
    EngineEvent, ErrorKind, PlaybackState, SourceFormat, SourceLocation, Transition,
};
use musify_audio::source::url_with_time_offset;
use serde::{Deserialize, Serialize};

use crate::gate::NetGate;
use crate::proxy::{Proxy, ProxyResource, ProxySource, ResourceKind, token_of_url};
use crate::renderer::{MediaItem, Renderer, RendererError, RendererStatus, TransportState};
use crate::upnp::protocol_info_for;

/// How often the session wakes up (position updates, heartbeats).
pub const TICK: Duration = Duration::from_millis(250);
/// Devices pass through stopped/paused states while loading or seeking; those are ignored this long.
const SETTLE: Duration = Duration::from_secs(4);
/// Polls right after a load or seek, to pick up the new state quickly.
const FAST_POLL: Duration = Duration::from_millis(500);
/// A track that stops within this distance of its end has finished.
const END_SLACK_MS: u64 = 5_000;
/// Ask the player for the next track this long before the end.
const NEED_NEXT_MS: u64 = 15_000;
/// The device counts as lost after this many failed calls spread over at least `LOST_AFTER`.
const MAX_FAILURES: u32 = 3;
const LOST_AFTER: Duration = Duration::from_secs(4);
/// Another controller's media must be seen this many polls in a row before the session gives up.
const FOREIGN_POLLS: u32 = 3;
const POSITION_EVERY: Duration = Duration::from_millis(200);

/// Playback commands from the player (same JSON shape as the engine's, with the renderer metadata).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RemoteCommand {
    Play {
        track: RemoteTrack,
        start_ms: u64,
        paused: bool,
    },
    SetNext {
        track: Option<RemoteTrack>,
    },
    Pause,
    Resume,
    Stop,
    Seek {
        position_ms: u64,
    },
    SkipToNext,
    SetVolume {
        volume: f64,
    },
}

/// A track for a renderer: where the proxy gets it, and what the device shows.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrack {
    pub id: String,
    pub location: SourceLocation,
    #[serde(default)]
    pub duration_hint_ms: Option<u64>,
    pub remote: RemoteMeta,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMeta {
    /// MIME type of the stream at `location` (original or server transcode).
    pub mime: String,
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub cover: Option<RemoteCover>,
}

/// Cover image URL on the server (may contain credentials, like stream URLs).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCover {
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub allow_insecure_tls: bool,
}

/// Why a session ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EndReason {
    /// The player switched back to this computer.
    Closed,
    /// The device stopped answering.
    Lost { message: String },
    /// Another app took over the device.
    TakenOver,
    /// Network speakers were turned off.
    TurnedOff,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SessionEvent {
    Engine(EngineEvent),
    /// Sent once; the session is over afterwards.
    Ended(EndReason),
}

/// Publishes tracks for the renderer (the LAN proxy in the app, a fake in tests).
pub trait MediaHost: Send {
    /// The item for `track`. `offset_ms > 0` restarts a server transcode at that track position.
    fn publish(&mut self, track: &RemoteTrack, offset_ms: u64) -> Result<MediaItem, String>;
    /// Revokes every published URL except those of `keep`.
    fn retain(&mut self, keep: &[&MediaItem]);
}

/// [`MediaHost`] over the LAN proxy.
pub struct ProxyHost {
    proxy: Proxy,
    /// Add the `contentFeatures.dlna.org` answers DLNA renderers ask for.
    dlna: bool,
}

impl ProxyHost {
    pub fn new(proxy: Proxy, dlna: bool) -> Self {
        Self { proxy, dlna }
    }
}

impl MediaHost for ProxyHost {
    fn publish(&mut self, track: &RemoteTrack, offset_ms: u64) -> Result<MediaItem, String> {
        let mime = track.remote.mime.clone();
        let (source, seekable, offset_ms) = match &track.location {
            SourceLocation::Local { path } => (ProxySource::File(path.clone()), true, 0),
            SourceLocation::Http {
                url,
                headers,
                transcoded,
                time_offset,
                allow_insecure_tls,
                ..
            } => {
                let (url, offset_ms) = match time_offset {
                    Some(param) if offset_ms > 0 => url_with_time_offset(url, param, offset_ms)
                        .ok_or_else(|| "invalid stream URL".to_string())?,
                    _ => (url.clone(), 0),
                };
                let source = ProxySource::Http {
                    url,
                    headers: headers.clone(),
                    allow_insecure_tls: *allow_insecure_tls,
                };
                (source, !*transcoded, offset_ms)
            }
        };
        let dlna_features = self.dlna.then(|| {
            let info = protocol_info_for(&mime, seekable);
            info.splitn(4, ':').nth(3).unwrap_or_default().to_string()
        });
        let url = self
            .proxy
            .register(
                ResourceKind::Media,
                ProxyResource {
                    source,
                    content_type: mime.clone(),
                    dlna_features,
                },
            )
            .map_err(|e| e.to_string())?;
        let cover_url = match &track.remote.cover {
            Some(cover) => Some(
                self.proxy
                    .register(
                        ResourceKind::Cover,
                        ProxyResource {
                            source: ProxySource::Http {
                                url: cover.url.clone(),
                                headers: cover.headers.clone(),
                                allow_insecure_tls: cover.allow_insecure_tls,
                            },
                            content_type: "image/jpeg".into(),
                            dlna_features: None,
                        },
                    )
                    .map_err(|e| e.to_string())?,
            ),
            None => None,
        };
        Ok(MediaItem {
            url,
            mime,
            title: track.remote.title.clone(),
            artist: track.remote.artist.clone(),
            album: track.remote.album.clone(),
            cover_url,
            duration_ms: track.duration_hint_ms.map(|d| d.saturating_sub(offset_ms)),
            seekable,
        })
    }

    fn retain(&mut self, keep: &[&MediaItem]) {
        let urls: Vec<&str> = keep
            .iter()
            .flat_map(|item| std::iter::once(item.url.as_str()).chain(item.cover_url.as_deref()))
            .collect();
        self.proxy.retain(&urls);
    }
}

/// A published track: the player's track, the renderer's item, and where its stream starts.
#[derive(Clone, Debug)]
struct Published {
    track: RemoteTrack,
    item: MediaItem,
    /// Track position of the stream's start (server transcode restarted with a time offset).
    offset_ms: u64,
}

#[derive(Debug)]
struct Current {
    media: Published,
    duration_ms: Option<u64>,
    /// Last known track position, measured at `measured_at`; it advances while `advancing`.
    position_ms: u64,
    measured_at: Instant,
    advancing: bool,
    /// Time actually played, for the listening history.
    played_ms: u64,
    accounted_at: Instant,
    seen_playing: bool,
    settle_until: Instant,
    buffering: bool,
    need_next_sent: bool,
    foreign_polls: u32,
}

impl Current {
    fn new(media: Published, start_ms: u64, now: Instant) -> Self {
        Self {
            duration_ms: media.track.duration_hint_ms,
            media,
            position_ms: start_ms,
            measured_at: now,
            advancing: false,
            played_ms: 0,
            accounted_at: now,
            seen_playing: false,
            settle_until: now + SETTLE,
            buffering: false,
            need_next_sent: false,
            foreign_polls: 0,
        }
    }

    fn position(&self, now: Instant) -> u64 {
        let mut position = self.position_ms;
        if self.advancing {
            position += now.saturating_duration_since(self.measured_at).as_millis() as u64;
        }
        self.duration_ms.map_or(position, |d| position.min(d))
    }

    /// Adds the time played since the last call.
    fn account(&mut self, now: Instant) {
        if self.advancing {
            self.played_ms += now.saturating_duration_since(self.accounted_at).as_millis() as u64;
        }
        self.accounted_at = now;
    }

    fn set_position(&mut self, position_ms: u64, advancing: bool, now: Instant) {
        self.account(now);
        self.position_ms = position_ms;
        self.measured_at = now;
        self.advancing = advancing;
    }

    /// Freezes the extrapolated position (pause, stop).
    fn halt(&mut self, now: Instant) {
        let position = self.position(now);
        self.set_position(position, false, now);
    }
}

/// True when a URL the device reports is the published `item` (devices may rewrite the host).
fn same_media(reported: &str, item: &MediaItem) -> bool {
    token_of_url(&item.url).is_some_and(|token| reported.contains(token))
}

fn remote_format() -> SourceFormat {
    // The device decodes; the quality badge shows the track's own format instead.
    SourceFormat {
        codec: String::new(),
        sample_rate: 0,
        bits_per_sample: None,
        channels: 2,
        bitrate_kbps: None,
        lossless: false,
        float: false,
    }
}

pub struct SessionCore {
    renderer: Box<dyn Renderer>,
    host: Box<dyn MediaHost>,
    current: Option<Current>,
    /// The track the player wants after the current one.
    next: Option<RemoteTrack>,
    /// `next`, published and handed to the device with `set_next`.
    next_on_device: Option<Published>,
    can_set_next: bool,
    want_playing: bool,
    last_poll: Option<Instant>,
    last_position_event: Option<Instant>,
    failures: u32,
    first_failure: Option<Instant>,
    ended: bool,
    events: Vec<SessionEvent>,
}

impl SessionCore {
    pub fn new(renderer: Box<dyn Renderer>, host: Box<dyn MediaHost>) -> Self {
        Self {
            renderer,
            host,
            current: None,
            next: None,
            next_on_device: None,
            can_set_next: true,
            want_playing: false,
            last_poll: None,
            last_position_event: None,
            failures: 0,
            first_failure: None,
            ended: false,
            events: Vec::new(),
        }
    }

    pub fn is_ended(&self) -> bool {
        self.ended
    }

    /// Events since the last call.
    pub fn take_events(&mut self) -> Vec<SessionEvent> {
        std::mem::take(&mut self.events)
    }

    fn emit(&mut self, event: EngineEvent) {
        self.events.push(SessionEvent::Engine(event));
    }

    fn emit_state(&mut self, state: PlaybackState) {
        self.emit(EngineEvent::StateChanged { state });
    }

    fn current_id(&self) -> Option<String> {
        self.current.as_ref().map(|c| c.media.track.id.clone())
    }

    pub fn handle(&mut self, command: RemoteCommand, now: Instant) {
        if self.ended {
            return;
        }
        let result = match command {
            RemoteCommand::Play {
                track,
                start_ms,
                paused,
            } => self.play(track, start_ms, !paused, Transition::Manual, now),
            RemoteCommand::SetNext { track } => self.set_next(track),
            RemoteCommand::Pause => self.pause(now),
            RemoteCommand::Resume => self.resume(now),
            RemoteCommand::Stop => self.stop(now),
            RemoteCommand::Seek { position_ms } => self.seek(position_ms, now),
            RemoteCommand::SkipToNext => match self.next.take() {
                Some(next) => self.play(next, 0, true, Transition::Manual, now),
                None => Ok(()),
            },
            RemoteCommand::SetVolume { volume } => {
                match self.renderer.set_volume(volume.clamp(0.0, 1.0)) {
                    Err(RendererError::Unsupported | RendererError::Rejected(_)) => Ok(()),
                    other => other,
                }
            }
        };
        if let Err(e) = result {
            self.on_error(e, now);
        }
    }

    /// Housekeeping every [`TICK`]: keep the connection alive, poll the device, report the position.
    pub fn tick(&mut self, now: Instant) {
        if self.ended {
            return;
        }
        if let Err(e) = self.renderer.tick() {
            self.on_error(e, now);
            if self.ended {
                return;
            }
        }
        let Some(current) = &self.current else { return };
        let interval = if now < current.settle_until {
            FAST_POLL
        } else {
            self.renderer.poll_interval()
        };
        if self
            .last_poll
            .is_none_or(|t| now.saturating_duration_since(t) >= interval)
        {
            self.last_poll = Some(now);
            match self.renderer.status() {
                Ok(status) => self.apply_status(status, now),
                Err(e) => self.on_error(e, now),
            }
        }
        self.report_position(now, false);
    }

    /// Stops playback on the device and ends the session (switching back to this computer).
    pub fn close(&mut self, now: Instant) {
        if self.ended {
            return;
        }
        self.finish_current(now, false);
        self.renderer.close();
        self.host.retain(&[]);
        self.end(EndReason::Closed);
    }

    /// Ends the session without talking to the device (network speakers turned off).
    pub fn abandon(&mut self, now: Instant, reason: EndReason) {
        if self.ended {
            return;
        }
        self.finish_current(now, false);
        self.host.retain(&[]);
        self.end(reason);
    }

    fn end(&mut self, reason: EndReason) {
        if !self.ended {
            self.ended = true;
            self.events.push(SessionEvent::Ended(reason));
        }
    }

    fn on_error(&mut self, error: RendererError, now: Instant) {
        match error {
            RendererError::Connection(message) => {
                self.failures += 1;
                let first = *self.first_failure.get_or_insert(now);
                if self.failures >= MAX_FAILURES && now.saturating_duration_since(first) >= LOST_AFTER {
                    self.finish_current(now, false);
                    self.host.retain(&[]);
                    self.end(EndReason::Lost { message });
                }
            }
            RendererError::TakenOver => {
                self.finish_current(now, false);
                self.host.retain(&[]);
                self.end(EndReason::TakenOver);
            }
            RendererError::Rejected(message) => {
                let id = self.current_id();
                self.emit(EngineEvent::Error {
                    id,
                    kind: ErrorKind::Other,
                    message,
                    recoverable: true,
                });
            }
            RendererError::Unsupported => {}
        }
    }

    /// Keeps the proxy URLs of the current and the preloaded track only.
    fn retain_published(&mut self) {
        let keep: Vec<&MediaItem> = self
            .current
            .iter()
            .map(|c| &c.media.item)
            .chain(self.next_on_device.iter().map(|p| &p.item))
            .collect();
        self.host.retain(&keep);
    }

    fn publish(&mut self, track: RemoteTrack, start_ms: u64) -> Result<(Published, u64), String> {
        // A server transcode can't seek by bytes: restart it at the position instead.
        let restart = matches!(
            &track.location,
            SourceLocation::Http { transcoded: true, time_offset: Some(_), .. }
        ) && start_ms > 0;
        let offset = if restart { start_ms } else { 0 };
        let item = self.host.publish(&track, offset)?;
        let offset_ms = if restart {
            track
                .duration_hint_ms
                .zip(item.duration_ms)
                .map_or(offset, |(total, rest)| total.saturating_sub(rest))
        } else {
            0
        };
        let device_start = start_ms.saturating_sub(offset_ms);
        Ok((
            Published {
                track,
                item,
                offset_ms,
            },
            device_start,
        ))
    }

    fn play(
        &mut self,
        track: RemoteTrack,
        start_ms: u64,
        play: bool,
        transition: Transition,
        now: Instant,
    ) -> Result<(), RendererError> {
        self.finish_current(now, false);
        if self.next.as_ref().is_some_and(|n| n.id == track.id) {
            self.next = None;
        }
        self.next_on_device = None;
        let id = track.id.clone();
        let (media, device_start) = match self.publish(track, start_ms) {
            Ok(published) => published,
            Err(message) => {
                self.emit(EngineEvent::Error {
                    id: Some(id),
                    kind: ErrorKind::Io,
                    message,
                    recoverable: false,
                });
                self.emit_state(PlaybackState::Stopped);
                return Ok(());
            }
        };
        if let Err(e) = self.renderer.load(&media.item, device_start, play) {
            return match e {
                RendererError::Rejected(message) => {
                    // The device can't play this one: report it and continue like the engine does.
                    self.emit(EngineEvent::Error {
                        id: Some(id),
                        kind: ErrorKind::UnsupportedFormat,
                        message,
                        recoverable: false,
                    });
                    self.after_track(now);
                    Ok(())
                }
                other => Err(other),
            };
        }
        let duration_ms = media.track.duration_hint_ms;
        self.current = Some(Current::new(media, start_ms, now));
        self.want_playing = play;
        self.last_poll = None;
        self.emit(EngineEvent::TrackStarted {
            id: id.clone(),
            transition,
            duration_ms,
            format: remote_format(),
        });
        self.emit_state(if play {
            PlaybackState::Playing
        } else {
            PlaybackState::Paused
        });
        self.report_position(now, true);
        self.retain_published();
        self.push_next_to_device();
        Ok(())
    }

    /// The current track is over (finished or failed): play the next one, or stop.
    fn after_track(&mut self, now: Instant) {
        match self.next.take() {
            Some(next) => {
                if let Err(e) = self.play(next, 0, true, Transition::Gapless, now) {
                    self.on_error(e, now);
                }
            }
            None => {
                self.current = None;
                self.next_on_device = None;
                self.want_playing = false;
                self.host.retain(&[]);
                self.emit_state(PlaybackState::Stopped);
            }
        }
    }

    /// Reports the end of the current track (listening history) and forgets it.
    fn finish_current(&mut self, now: Instant, completed: bool) {
        if let Some(mut current) = self.current.take() {
            current.account(now);
            self.emit(EngineEvent::TrackEnded {
                id: current.media.track.id,
                played_ms: current.played_ms,
                completed,
            });
        }
    }

    fn set_next(&mut self, track: Option<RemoteTrack>) -> Result<(), RendererError> {
        if self.next == track {
            return Ok(());
        }
        self.next = track;
        if self.next_on_device.take().is_some() {
            match self.renderer.set_next(None) {
                Err(RendererError::Connection(m)) => return Err(RendererError::Connection(m)),
                _ => {}
            }
            self.retain_published();
        }
        self.push_next_to_device();
        Ok(())
    }

    /// Hands the next track to devices that can move on by themselves.
    fn push_next_to_device(&mut self) {
        if !self.can_set_next || self.current.is_none() || self.next_on_device.is_some() {
            return;
        }
        let Some(next) = self.next.clone() else { return };
        let Ok((published, _)) = self.publish(next, 0) else {
            return;
        };
        match self.renderer.set_next(Some(&published.item)) {
            Ok(()) => self.next_on_device = Some(published),
            Err(RendererError::Unsupported) => self.can_set_next = false,
            Err(e) => log::debug!("network speakers: preloading the next track failed: {e}"),
        }
        self.retain_published();
    }

    fn pause(&mut self, now: Instant) -> Result<(), RendererError> {
        let Some(current) = self.current.as_mut() else { return Ok(()) };
        current.halt(now);
        current.settle_until = now + SETTLE;
        self.want_playing = false;
        self.emit_state(PlaybackState::Paused);
        self.report_position(now, true);
        self.renderer.pause()
    }

    fn resume(&mut self, now: Instant) -> Result<(), RendererError> {
        let Some(current) = self.current.as_mut() else { return Ok(()) };
        current.settle_until = now + SETTLE;
        self.want_playing = true;
        self.last_poll = None;
        self.emit_state(PlaybackState::Playing);
        self.renderer.play()
    }

    fn stop(&mut self, now: Instant) -> Result<(), RendererError> {
        let had_track = self.current.is_some();
        self.finish_current(now, false);
        self.next = None;
        self.next_on_device = None;
        self.want_playing = false;
        self.host.retain(&[]);
        self.emit_state(PlaybackState::Stopped);
        if had_track {
            match self.renderer.stop() {
                Err(RendererError::Connection(m)) => return Err(RendererError::Connection(m)),
                _ => {}
            }
        }
        Ok(())
    }

    fn seek(&mut self, position_ms: u64, now: Instant) -> Result<(), RendererError> {
        let Some(current) = self.current.as_ref() else { return Ok(()) };
        let position_ms = current.duration_ms.map_or(position_ms, |d| position_ms.min(d));
        let restart = !current.media.item.seekable
            && matches!(
                &current.media.track.location,
                SourceLocation::Http { time_offset: Some(_), .. }
            );
        if restart {
            // Restart the transcode at the new position; the player keeps the same track.
            let track = current.media.track.clone();
            let (media, device_start) = match self.publish(track, position_ms) {
                Ok(published) => published,
                Err(message) => return Err(RendererError::Rejected(message)),
            };
            self.renderer.load(&media.item, device_start, self.want_playing)?;
            let current = self.current.as_mut().expect("checked above");
            current.media = media;
            current.seen_playing = false;
            self.next_on_device = None;
            self.retain_published();
            self.push_next_to_device();
        } else {
            let offset = current.media.offset_ms;
            self.renderer.seek(position_ms.saturating_sub(offset))?;
        }
        let current = self.current.as_mut().expect("checked above");
        current.set_position(position_ms, false, now);
        current.settle_until = now + SETTLE;
        current.need_next_sent = false;
        self.last_poll = None;
        self.report_position(now, true);
        Ok(())
    }

    fn apply_status(&mut self, status: RendererStatus, now: Instant) {
        self.failures = 0;
        self.first_failure = None;
        let Some(current) = self.current.as_mut() else { return };

        if let Some(url) = status.current_url.as_deref().filter(|u| !u.is_empty()) {
            let ours = same_media(url, &current.media.item);
            let preloaded = self
                .next_on_device
                .as_ref()
                .is_some_and(|p| same_media(url, &p.item));
            if preloaded && !ours {
                self.moved_on_by_itself(status, now);
                return;
            }
            if ours {
                current.foreign_polls = 0;
            } else if now >= current.settle_until {
                current.foreign_polls += 1;
                if current.foreign_polls >= FOREIGN_POLLS {
                    self.on_error(RendererError::TakenOver, now);
                    return;
                }
            }
        }

        let settled = now >= current.settle_until;
        let offset = current.media.offset_ms;
        if let Some(duration) = status.duration_ms.filter(|d| *d > 0) {
            current.duration_ms = Some(duration + offset);
        }
        let reported = status.position_ms.map(|p| p + offset);
        match status.state {
            TransportState::Playing => {
                current.seen_playing = true;
                let position = reported.unwrap_or_else(|| current.position(now));
                current.set_position(position, true, now);
                let was_buffering = std::mem::replace(&mut current.buffering, false);
                if was_buffering {
                    self.emit(EngineEvent::Buffering { active: false });
                }
                if !self.want_playing && settled {
                    // Started on the device itself.
                    self.want_playing = true;
                    self.emit_state(PlaybackState::Playing);
                }
            }
            TransportState::Paused => {
                let position = reported.unwrap_or_else(|| current.position(now));
                current.set_position(position, false, now);
                let was_buffering = std::mem::replace(&mut current.buffering, false);
                let paused_on_device = self.want_playing && settled && current.seen_playing;
                if was_buffering {
                    self.emit(EngineEvent::Buffering { active: false });
                }
                if paused_on_device {
                    self.want_playing = false;
                    self.emit_state(PlaybackState::Paused);
                }
            }
            TransportState::Buffering => {
                let position = reported.unwrap_or_else(|| current.position(now));
                current.set_position(position, false, now);
                if !current.buffering && self.want_playing {
                    current.buffering = true;
                    self.emit(EngineEvent::Buffering { active: true });
                }
            }
            TransportState::Finished => {
                if current.seen_playing || settled {
                    current.halt(now);
                    self.finish_current(now, true);
                    self.after_track(now);
                }
            }
            TransportState::Failed => {
                if current.seen_playing || settled {
                    current.halt(now);
                    let id = Some(current.media.track.id.clone());
                    self.emit(EngineEvent::Error {
                        id,
                        kind: ErrorKind::Decode,
                        message: "the device could not play the track".into(),
                        recoverable: false,
                    });
                    self.finish_current(now, false);
                    self.after_track(now);
                }
            }
            TransportState::Stopped => {
                current.halt(now);
                if settled && current.seen_playing && self.want_playing {
                    let near_end = current
                        .duration_ms
                        .is_none_or(|d| current.position_ms + END_SLACK_MS >= d);
                    if near_end {
                        self.finish_current(now, true);
                        self.after_track(now);
                    } else {
                        // Stopped on the device: treat like a pause, the player can resume.
                        self.want_playing = false;
                        self.emit_state(PlaybackState::Paused);
                    }
                }
            }
        }
    }

    /// The device went on to the preloaded track by itself (gapless).
    fn moved_on_by_itself(&mut self, status: RendererStatus, now: Instant) {
        let Some(media) = self.next_on_device.take() else { return };
        self.finish_current(now, true);
        self.next = None;
        let id = media.track.id.clone();
        let duration_ms = media.track.duration_hint_ms;
        let mut current = Current::new(media, status.position_ms.unwrap_or(0), now);
        current.seen_playing = status.state == TransportState::Playing;
        current.advancing = current.seen_playing;
        current.settle_until = now;
        self.current = Some(current);
        self.emit(EngineEvent::TrackStarted {
            id,
            transition: Transition::Gapless,
            duration_ms,
            format: remote_format(),
        });
        self.report_position(now, true);
        self.retain_published();
    }

    fn report_position(&mut self, now: Instant, force: bool) {
        let Some(current) = &self.current else { return };
        if !force
            && (!current.advancing
                || self
                    .last_position_event
                    .is_some_and(|t| now.saturating_duration_since(t) < POSITION_EVERY))
        {
            return;
        }
        let id = current.media.track.id.clone();
        let position_ms = current.position(now);
        let duration_ms = current.duration_ms;
        let ask_for_next = self.next.is_none()
            && !current.need_next_sent
            && duration_ms.is_some_and(|d| position_ms + NEED_NEXT_MS >= d);
        self.last_position_event = Some(now);
        self.emit(EngineEvent::Position {
            id: id.clone(),
            position_ms,
            duration_ms,
            buffered_ms: None,
        });
        if ask_for_next {
            if let Some(current) = self.current.as_mut() {
                current.need_next_sent = true;
            }
            self.emit(EngineEvent::NeedNext { id });
        }
    }
}

enum Control {
    Command(RemoteCommand),
    Close,
}

/// A [`SessionCore`] on its own thread.
pub struct Session {
    tx: Sender<Control>,
    done: Receiver<()>,
    finished: Arc<AtomicBool>,
}

impl Session {
    /// Runs the session until it is closed, the device is lost, or the gate closes. `sink` gets every
    /// event on the session thread.
    pub fn start(
        renderer: Box<dyn Renderer>,
        host: Box<dyn MediaHost>,
        gate: Arc<NetGate>,
        sink: Box<dyn Fn(SessionEvent) + Send>,
    ) -> std::io::Result<Session> {
        let (tx, rx) = crossbeam_channel::unbounded();
        let (done_tx, done) = crossbeam_channel::bounded(1);
        let finished = Arc::new(AtomicBool::new(false));
        let thread_finished = finished.clone();
        let generation = gate.generation();
        std::thread::Builder::new()
            .name("musify-cast-session".into())
            .spawn(move || {
                let mut core = SessionCore::new(renderer, host);
                loop {
                    match rx.recv_timeout(TICK) {
                        Ok(Control::Command(command)) => core.handle(command, Instant::now()),
                        Ok(Control::Close) | Err(RecvTimeoutError::Disconnected) => {
                            core.close(Instant::now());
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                    if !gate.is_open() || gate.generation() != generation {
                        core.abandon(Instant::now(), EndReason::TurnedOff);
                    }
                    core.tick(Instant::now());
                    for event in core.take_events() {
                        sink(event);
                    }
                    if core.is_ended() {
                        break;
                    }
                }
                drop(core);
                thread_finished.store(true, Ordering::SeqCst);
                let _ = done_tx.send(());
            })?;
        Ok(Session { tx, done, finished })
    }

    pub fn send(&self, command: RemoteCommand) {
        let _ = self.tx.send(Control::Command(command));
    }

    /// Stops playback on the device and waits up to `timeout` for the session to end.
    pub fn close(self, timeout: Duration) {
        let _ = self.tx.send(Control::Close);
        let _ = self.done.recv_timeout(timeout);
    }

    /// True once the session thread has finished.
    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
