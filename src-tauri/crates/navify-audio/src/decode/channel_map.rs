//! Channel layouts and the stereo down-/up-mix used by the [`Conformer`](super::Conformer).
//!
//! Down-mix (> 2 channels), following ITU-R BS.775 (Lo/Ro):
//!
//! ```text
//! L = FL + 0.7071·FC + 0.7071·(BL|SL) [+ 0.7071·side/top/rear-centre feeds, see `stereo_gains`]
//! R = FR + 0.7071·FC + 0.7071·(BR|SR)
//! ```
//!
//! LFE is dropped. The matrix is then scaled by `1 / max(Σ|row L|, Σ|row R|)` (only when that sum
//! exceeds 1), so that a full-scale signal on every channel at once cannot exceed ±1.0. For 5.1
//! the scale is `1 / (1 + 2·0.7071) = 0.4142` (−7.66 dB), i.e. FL → L with gain 0.4142 and
//! FC / BL → L with 0.2929. Mono is duplicated to both sides at unity (bit-exact), stereo passes
//! through untouched.

use symphonia::core::audio::{ChannelLabel, Channels, Position};

/// −3 dB.
pub const MINUS_3DB: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// One input channel of a layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Speaker {
    FrontLeft,
    FrontRight,
    FrontCenter,
    Lfe,
    BackLeft,
    BackRight,
    FrontLeftCenter,
    FrontRightCenter,
    BackCenter,
    SideLeft,
    SideRight,
    TopCenter,
    TopFrontLeft,
    TopFrontCenter,
    TopFrontRight,
    TopBackLeft,
    TopBackCenter,
    TopBackRight,
    TopSideLeft,
    TopSideRight,
    BottomFrontCenter,
    BottomFrontLeft,
    BottomFrontRight,
    FrontLeftWide,
    FrontRightWide,
    /// Unlabelled channel (number = index in the stream).
    Discrete(u16),
}

impl Speaker {
    /// (left, right) gain before normalization.
    fn stereo_gains(self) -> (f64, f64) {
        use Speaker::*;
        const K: f64 = MINUS_3DB;
        match self {
            FrontLeft | FrontLeftWide => (1.0, 0.0),
            FrontRight | FrontRightWide => (0.0, 1.0),
            FrontCenter => (K, K),
            Lfe => (0.0, 0.0),
            BackLeft | SideLeft => (K, 0.0),
            BackRight | SideRight => (0.0, K),
            // Constant-power pan at ±22.5° between front and centre.
            FrontLeftCenter => (0.9239, 0.3827),
            FrontRightCenter => (0.3827, 0.9239),
            BackCenter => (0.5, 0.5),
            TopFrontLeft | TopBackLeft | TopSideLeft | BottomFrontLeft => (K, 0.0),
            TopFrontRight | TopBackRight | TopSideRight | BottomFrontRight => (0.0, K),
            TopCenter | TopFrontCenter | TopBackCenter | BottomFrontCenter => (0.5, 0.5),
            Discrete(_) => (0.5, 0.5),
        }
    }

    fn from_position(p: Position) -> Option<Self> {
        use Speaker::*;
        Some(match p {
            Position::FRONT_LEFT => FrontLeft,
            Position::FRONT_RIGHT => FrontRight,
            Position::FRONT_CENTER => FrontCenter,
            Position::LFE1 | Position::LFE2 => Lfe,
            Position::REAR_LEFT => BackLeft,
            Position::REAR_RIGHT => BackRight,
            Position::FRONT_LEFT_CENTER => FrontLeftCenter,
            Position::FRONT_RIGHT_CENTER => FrontRightCenter,
            Position::REAR_CENTER => BackCenter,
            Position::SIDE_LEFT => SideLeft,
            Position::SIDE_RIGHT => SideRight,
            Position::TOP_CENTER => TopCenter,
            Position::TOP_FRONT_LEFT => TopFrontLeft,
            Position::TOP_FRONT_CENTER => TopFrontCenter,
            Position::TOP_FRONT_RIGHT => TopFrontRight,
            Position::TOP_REAR_LEFT => TopBackLeft,
            Position::TOP_REAR_CENTER => TopBackCenter,
            Position::TOP_REAR_RIGHT => TopBackRight,
            Position::TOP_SIDE_LEFT => TopSideLeft,
            Position::TOP_SIDE_RIGHT => TopSideRight,
            Position::BOTTOM_FRONT_CENTER => BottomFrontCenter,
            Position::BOTTOM_FRONT_LEFT => BottomFrontLeft,
            Position::BOTTOM_FRONT_RIGHT => BottomFrontRight,
            Position::FRONT_LEFT_WIDE => FrontLeftWide,
            Position::FRONT_RIGHT_WIDE => FrontRightWide,
            _ => return None,
        })
    }
}

/// The order of channels in the decoder's interleaved output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelLayout {
    speakers: Vec<Speaker>,
}

impl ChannelLayout {
    pub fn new(speakers: Vec<Speaker>) -> Self {
        Self { speakers }
    }

    /// Conventional layout for a bare channel count (WAVE / FLAC / Vorbis default orders, which
    /// symphonia normalizes to this canonical order): 1 = mono (centre), 2 = L R, 3 = L R C,
    /// 4 = L R BL BR, 5 = L R C BL BR, 6 = 5.1 (L R C LFE BL BR), 7 = 6.1 (… BC SL SR),
    /// 8 = 7.1 (L R C LFE BL BR SL SR); anything else is discrete.
    pub fn default_for(channels: usize) -> Self {
        use Speaker::*;
        let speakers = match channels {
            1 => vec![FrontCenter],
            2 => vec![FrontLeft, FrontRight],
            3 => vec![FrontLeft, FrontRight, FrontCenter],
            4 => vec![FrontLeft, FrontRight, BackLeft, BackRight],
            5 => vec![FrontLeft, FrontRight, FrontCenter, BackLeft, BackRight],
            6 => vec![FrontLeft, FrontRight, FrontCenter, Lfe, BackLeft, BackRight],
            7 => vec![FrontLeft, FrontRight, FrontCenter, Lfe, BackCenter, SideLeft, SideRight],
            8 => vec![FrontLeft, FrontRight, FrontCenter, Lfe, BackLeft, BackRight, SideLeft, SideRight],
            n => (0..n).map(|i| Discrete(i as u16)).collect(),
        };
        Self { speakers }
    }

    pub(crate) fn from_symphonia(channels: &Channels) -> Self {
        match channels {
            Channels::Positioned(mask) => {
                let speakers: Vec<Speaker> = mask
                    .iter()
                    .enumerate()
                    .map(|(i, p)| Speaker::from_position(p).unwrap_or(Speaker::Discrete(i as u16)))
                    .collect();
                Self { speakers }
            }
            Channels::Custom(labels) => {
                let speakers = labels
                    .iter()
                    .enumerate()
                    .map(|(i, l)| match l {
                        ChannelLabel::Positioned(p) => {
                            Speaker::from_position(*p).unwrap_or(Speaker::Discrete(i as u16))
                        }
                        _ => Speaker::Discrete(i as u16),
                    })
                    .collect();
                Self { speakers }
            }
            other => Self::default_for(other.count()),
        }
    }

    pub fn channels(&self) -> usize {
        self.speakers.len()
    }

    pub fn speakers(&self) -> &[Speaker] {
        &self.speakers
    }

    /// The stereo mix to apply for this layout.
    pub fn stereo_mix(&self) -> StereoMix {
        match self.speakers.as_slice() {
            [_] => StereoMix::DualMono,
            [Speaker::FrontLeft, Speaker::FrontRight] => StereoMix::Passthrough,
            [] => StereoMix::Matrix(Vec::new()),
            _ => StereoMix::Matrix(self.downmix_matrix()),
        }
    }

    /// Per input channel (left, right) gains, normalized so that a full-scale input cannot clip.
    pub fn downmix_matrix(&self) -> Vec<(f64, f64)> {
        let all_discrete = self.speakers.iter().all(|s| matches!(s, Speaker::Discrete(_)));
        let mut m: Vec<(f64, f64)> = if all_discrete {
            // Unknown layout: treat as the conventional layout for that count.
            ChannelLayout::default_for(self.speakers.len())
                .speakers
                .iter()
                .map(|s| s.stereo_gains())
                .collect()
        } else {
            self.speakers.iter().map(|s| s.stereo_gains()).collect()
        };
        let sum_l: f64 = m.iter().map(|g| g.0.abs()).sum();
        let sum_r: f64 = m.iter().map(|g| g.1.abs()).sum();
        let peak = sum_l.max(sum_r);
        if peak > 1.0 {
            let scale = 1.0 / peak;
            for g in &mut m {
                g.0 *= scale;
                g.1 *= scale;
            }
        }
        m
    }
}

/// How the conformer gets from the source layout to stereo.
#[derive(Clone, Debug, PartialEq)]
pub enum StereoMix {
    /// Already L/R stereo: samples are copied unchanged.
    Passthrough,
    /// One channel: copied to both sides unchanged.
    DualMono,
    /// (left, right) gain per input channel.
    Matrix(Vec<(f64, f64)>),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_one_matrix_is_bs775_and_cannot_clip() {
        let m = ChannelLayout::default_for(6).downmix_matrix();
        let s = 1.0 / (1.0 + 2.0 * MINUS_3DB);
        let expect = [(s, 0.0), (0.0, s), (MINUS_3DB * s, MINUS_3DB * s), (0.0, 0.0), (MINUS_3DB * s, 0.0), (0.0, MINUS_3DB * s)];
        for (a, b) in m.iter().zip(expect) {
            assert!((a.0 - b.0).abs() < 1e-15 && (a.1 - b.1).abs() < 1e-15, "{m:?}");
        }
        let sum_l: f64 = m.iter().map(|g| g.0).sum();
        assert!((sum_l - 1.0).abs() < 1e-12);
    }

    #[test]
    fn mixes() {
        assert_eq!(ChannelLayout::default_for(1).stereo_mix(), StereoMix::DualMono);
        assert_eq!(ChannelLayout::default_for(2).stereo_mix(), StereoMix::Passthrough);
        assert!(matches!(ChannelLayout::default_for(8).stereo_mix(), StereoMix::Matrix(_)));
    }

    #[test]
    fn symphonia_positions_map_in_canonical_order() {
        let mask = Position::FRONT_LEFT
            | Position::FRONT_RIGHT
            | Position::FRONT_CENTER
            | Position::LFE1
            | Position::SIDE_LEFT
            | Position::SIDE_RIGHT;
        let l = ChannelLayout::from_symphonia(&Channels::Positioned(mask));
        assert_eq!(
            l.speakers(),
            &[Speaker::FrontLeft, Speaker::FrontRight, Speaker::FrontCenter, Speaker::Lfe, Speaker::SideLeft, Speaker::SideRight]
        );
    }
}
