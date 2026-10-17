//! Loudness normalization: turns ReplayGain values into the linear gain applied per track.

use crate::api::{NormalizationConfig, NormalizationMode, ReplayGainInfo};

/// ReplayGain 2.0 reference loudness.
const REPLAYGAIN_REFERENCE_LUFS: f64 = -18.0;

/// Linear gain for one track. `server` values win over values read from the file's tags.
/// Unknown loudness → 1.0 (no change). `prefer_album` is used by `Auto` mode (album playing in order).
pub fn track_gain(
    config: &NormalizationConfig,
    server: Option<&ReplayGainInfo>,
    tags: Option<&ReplayGainInfo>,
    prefer_album: bool,
) -> f64 {
    let album = match config.mode {
        NormalizationMode::Off => return 1.0,
        NormalizationMode::Track => false,
        NormalizationMode::Album => true,
        NormalizationMode::Auto => prefer_album,
    };

    let pick = |rg: &ReplayGainInfo| -> Option<(f64, Option<f64>)> {
        let (gain, peak) = if album {
            (
                rg.album_gain_db.or(rg.track_gain_db),
                rg.album_peak.or(rg.track_peak),
            )
        } else {
            (
                rg.track_gain_db.or(rg.album_gain_db),
                rg.track_peak.or(rg.album_peak),
            )
        };
        gain.filter(|g| g.is_finite())
            .map(|g| (g, peak.filter(|p| p.is_finite() && *p > 0.0)))
    };

    let Some((gain_db, peak)) = server.and_then(pick).or_else(|| tags.and_then(pick)) else {
        return 1.0;
    };

    let total_db = gain_db + (config.target.lufs() - REPLAYGAIN_REFERENCE_LUFS);
    let mut linear = 10f64.powf(total_db / 20.0);
    if config.prevent_clipping
        && let Some(peak) = peak
    {
        linear = linear.min(1.0 / peak);
    }
    linear
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::LoudnessTarget;

    fn cfg(
        mode: NormalizationMode,
        target: LoudnessTarget,
        prevent_clipping: bool,
    ) -> NormalizationConfig {
        NormalizationConfig {
            mode,
            target,
            prevent_clipping,
            analyze_untagged: false,
        }
    }

    fn rg(track: f64, album: f64, peak: f64) -> ReplayGainInfo {
        ReplayGainInfo {
            track_gain_db: Some(track),
            album_gain_db: Some(album),
            track_peak: Some(peak),
            album_peak: Some(peak),
        }
    }

    #[test]
    fn off_is_unity() {
        let c = cfg(NormalizationMode::Off, LoudnessTarget::Normal, true);
        assert_eq!(track_gain(&c, Some(&rg(-6.0, -5.0, 0.9)), None, false), 1.0);
    }

    #[test]
    fn quiet_target_at_reference_is_minus_one_db() {
        // −19 LUFS target vs −18 reference: −1 dB on top of the track gain of 0 dB.
        let c = cfg(NormalizationMode::Track, LoudnessTarget::Quiet, false);
        let g = track_gain(&c, Some(&rg(0.0, 0.0, 1.0)), None, false);
        assert!((20.0 * g.log10() + 1.0).abs() < 1e-9);
    }

    #[test]
    fn album_mode_uses_album_gain() {
        let c = cfg(NormalizationMode::Album, LoudnessTarget::Normal, false);
        let g = track_gain(&c, Some(&rg(-8.0, -6.0, 0.5)), None, false);
        // −6 dB album gain + 4 dB (−14 vs −18).
        assert!((20.0 * g.log10() + 2.0).abs() < 1e-9);
    }

    #[test]
    fn clipping_prevention_limits_boost_to_peak() {
        let c = cfg(NormalizationMode::Track, LoudnessTarget::Loud, true);
        // +3 dB track gain + 7 dB = +10 dB requested, but the peak 0.8 allows only 1/0.8.
        let g = track_gain(&c, Some(&rg(3.0, 3.0, 0.8)), None, false);
        assert!((g - 1.25).abs() < 1e-12);
    }

    #[test]
    fn server_values_win_over_tags_and_unknown_is_unity() {
        let c = cfg(NormalizationMode::Track, LoudnessTarget::Normal, false);
        let from_tags = track_gain(&c, None, Some(&rg(-4.0, -4.0, 1.0)), false);
        assert!((20.0 * from_tags.log10()).abs() < 1e-9); // −4 + 4 = 0 dB
        let both = track_gain(
            &c,
            Some(&rg(-10.0, -10.0, 1.0)),
            Some(&rg(-4.0, -4.0, 1.0)),
            false,
        );
        assert!((20.0 * both.log10() + 6.0).abs() < 1e-9);
        assert_eq!(track_gain(&c, None, None, false), 1.0);
    }
}
