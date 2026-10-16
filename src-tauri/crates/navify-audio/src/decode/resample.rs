//! Stereo f64 sample-rate conversion with delay compensation (rubato 5).
//!
//! Primary engine: rubato's synchronous FFT resampler (`Fft`), i.e. an exact fixed-ratio
//! band-limited resampler. Its anti-aliasing filter is a windowed sinc (Blackman-Harris², DC gain
//! normalized to 1) whose length equals the FFT block on the input side; the block is chosen so
//! that the *shorter* side is at least [`MIN_FILTER_LEN`] samples (44.1→48 kHz: 2058 taps, 96→48:
//! 4096 taps). The cutoff is placed by rubato so the stop band starts at the lower Nyquist.
//!
//! Rate pairs whose minimal block would be huge (rates with a tiny GCD, e.g. 44 099 Hz) fall back to
//! rubato's asynchronous sinc resampler (256 taps, 256× oversampling, cubic interpolation,
//! Blackman-Harris²).
//!
//! Delay compensation: the first `output_delay()` output frames (the filter's group delay, exactly
//! half an output block for the FFT resampler) are dropped, so output frame 0 is aligned with input
//! frame 0; at the end, silence is fed until exactly `round(in_frames · dst / src)` frames came out.

use rubato::audioadapter_buffers::direct::SequentialSliceOfVecs;
use rubato::{
    Async, Fft, FixedAsync, FixedSync, Indexing, Resampler, SincInterpolationParameters,
    SincInterpolationType, WindowFunction,
};

/// Minimum filter / FFT block length (taps) on the shorter side of the conversion.
pub const MIN_FILTER_LEN: usize = 2048;
/// Above this block size the FFT resampler gets too large and the async sinc resampler is used.
const MAX_FFT_BLOCK: usize = 1 << 16;

pub(crate) struct StereoResampler {
    inner: Box<dyn Resampler<f64>>,
    src_rate: u32,
    dst_rate: u32,
    /// Pending input, planar L/R; `in_pos` frames at the front are already consumed.
    input: [Vec<f64>; 2],
    in_pos: usize,
    output: Vec<Vec<f64>>,
    /// Output frames still to drop (filter delay).
    skip: usize,
    in_total: u64,
    out_total: u64,
}

/// Which rubato resampler is in use and its filter length (for reporting).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResamplerKind {
    Fft { block_in: usize, block_out: usize },
    AsyncSinc { taps: usize },
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

impl StereoResampler {
    pub(crate) fn new(src_rate: u32, dst_rate: u32) -> Self {
        assert!(src_rate > 0 && dst_rate > 0 && src_rate != dst_rate);
        let g = gcd(u64::from(src_rate), u64::from(dst_rate));
        let min_in = (u64::from(src_rate) / g) as usize;
        let min_out = (u64::from(dst_rate) / g) as usize;
        let k = MIN_FILTER_LEN.div_ceil(min_in.min(min_out)).max(1);
        let inner: Box<dyn Resampler<f64>> = if k * min_in.max(min_out) <= MAX_FFT_BLOCK {
            match Fft::<f64>::new_custom(
                src_rate as usize,
                dst_rate as usize,
                k * min_in,
                1,
                2,
                WindowFunction::BlackmanHarris2,
                FixedSync::Both,
            ) {
                Ok(r) => Box::new(r),
                Err(e) => {
                    log::warn!("FFT resampler unavailable ({e}), using async sinc");
                    Self::async_sinc(src_rate, dst_rate)
                }
            }
        } else {
            Self::async_sinc(src_rate, dst_rate)
        };
        let out_max = inner.output_frames_max();
        let skip = inner.output_delay();
        Self {
            inner,
            src_rate,
            dst_rate,
            input: [Vec::with_capacity(8192), Vec::with_capacity(8192)],
            in_pos: 0,
            output: vec![vec![0.0; out_max]; 2],
            skip,
            in_total: 0,
            out_total: 0,
        }
    }

    fn async_sinc(src_rate: u32, dst_rate: u32) -> Box<dyn Resampler<f64>> {
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: None,
            oversampling_factor: 256,
            interpolation: SincInterpolationType::Cubic,
            window: WindowFunction::BlackmanHarris2,
        };
        let ratio = f64::from(dst_rate) / f64::from(src_rate);
        Box::new(
            Async::<f64>::new_sinc(ratio, 1.0, &params, 1024, 2, FixedAsync::Input)
                .expect("valid async sinc parameters"),
        )
    }

    pub(crate) fn kind(&self) -> ResamplerKind {
        if self.inner.is_adjustable() {
            ResamplerKind::AsyncSinc { taps: 256 }
        } else {
            ResamplerKind::Fft {
                block_in: self.inner.input_frames_max(),
                block_out: self.inner.output_frames_max(),
            }
        }
    }

    /// Output frames for `in_frames` input frames (rounded to nearest).
    fn expected_out(&self, in_frames: u64) -> u64 {
        let num = u128::from(in_frames) * u128::from(self.dst_rate);
        let den = u128::from(self.src_rate);
        ((num + den / 2) / den) as u64
    }

    /// Appends planar stereo input frames.
    pub(crate) fn push_frame(&mut self, l: f64, r: f64) {
        self.input[0].push(l);
        self.input[1].push(r);
    }

    /// Runs every complete chunk and appends interleaved output to `out`.
    pub(crate) fn run(&mut self, out: &mut Vec<f64>) {
        loop {
            let need = self.inner.input_frames_next();
            let avail = self.input[0].len() - self.in_pos;
            if avail < need {
                break;
            }
            let indexing = Indexing::new().input_offset(self.in_pos);
            let (n_in, n_out) = self.process_chunk(Some(&indexing));
            self.in_pos += n_in;
            self.in_total += n_in as u64;
            self.emit(n_out, u64::MAX, out);
        }
        // Compact the consumed prefix once it dominates the buffer.
        if self.in_pos > 0 && self.in_pos * 2 >= self.input[0].len() {
            for ch in &mut self.input {
                ch.drain(..self.in_pos);
            }
            self.in_pos = 0;
        }
    }

    fn process_chunk(&mut self, indexing: Option<&Indexing>) -> (usize, usize) {
        let frames_in = self.input[0].len();
        let frames_out = self.output[0].len();
        let input =
            SequentialSliceOfVecs::new(&self.input[..], 2, frames_in).expect("input buffer shape");
        let mut output = SequentialSliceOfVecs::new_mut(&mut self.output[..], 2, frames_out)
            .expect("output buffer shape");
        match self
            .inner
            .process_into_buffer(&input, &mut output, indexing)
        {
            Ok(r) => r,
            Err(e) => {
                // Only possible on buffer-size bugs; never panic in the audio path.
                log::error!("resampler error: {e}");
                (
                    indexing
                        .and_then(|i| i.partial_len)
                        .unwrap_or(self.inner.input_frames_next()),
                    0,
                )
            }
        }
    }

    fn emit(&mut self, n_out: usize, limit: u64, out: &mut Vec<f64>) {
        let mut start = 0;
        if self.skip > 0 {
            start = self.skip.min(n_out);
            self.skip -= start;
        }
        let room = limit.saturating_sub(self.out_total);
        let end = (start + room.min((n_out - start) as u64) as usize).min(n_out);
        out.reserve((end - start) * 2);
        let (l, r) = (&self.output[0], &self.output[1]);
        for i in start..end {
            out.push(l[i]);
            out.push(r[i]);
        }
        self.out_total += (end - start) as u64;
    }

    /// Feeds the remaining input plus silence and appends exactly the missing tail, so that the
    /// total output is `round(in_frames · dst / src)`. The resampler is reset afterwards.
    pub(crate) fn flush(&mut self, out: &mut Vec<f64>) {
        let remaining = self.input[0].len() - self.in_pos;
        self.in_total += remaining as u64;
        let expected = self.expected_out(self.in_total);
        let mut partial = remaining;
        let mut guard = 0;
        while self.out_total < expected && guard < 64 {
            let indexing = Indexing::new()
                .input_offset(self.in_pos)
                .partial_len(partial);
            let (_, n_out) = self.process_chunk(Some(&indexing));
            self.in_pos += partial;
            partial = 0;
            self.emit(n_out, expected, out);
            guard += 1;
        }
        self.reset();
    }

    pub(crate) fn reset(&mut self) {
        self.inner.reset();
        for ch in &mut self.input {
            ch.clear();
        }
        self.in_pos = 0;
        self.skip = self.inner.output_delay();
        self.in_total = 0;
        self.out_total = 0;
    }
}
