//! One output pipeline at a fixed sample rate: output stream + mixer thread + analyzer thread.
//! Rebuilt whenever the device, the output mode or (in exclusive mode) the rate changes.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam_channel::Sender;

use super::OutputFactory;
use super::mixer::{Meters, Mixer, MixerEvent, MixerMsg};
use crate::ENGINE_CHANNELS;
use crate::analysis::SpectrumAnalyzer;
use crate::api::{DspConfig, OutputConfig, OutputFormat, SpectrumFrame};
use crate::dsp::DspChain;
use crate::output::{OutputError, OutputEvent, OutputRequest, OutputStream};

/// Output ring size and how full the mixer keeps it.
const OUTPUT_RING_MS: f64 = 200.0;
const OUTPUT_TARGET_FILL_MS: f64 = 50.0;
/// Device buffer requested in exclusive mode.
const EXCLUSIVE_BUFFER_MS: u32 = 20;
const SPECTRUM_BANDS: usize = 96;
const SPECTRUM_INTERVAL: Duration = Duration::from_millis(33);

pub(crate) struct PipelineSettings<'a> {
    pub output: &'a OutputConfig,
    pub exclusive_rate: Option<u32>,
    pub dsp: &'a DspConfig,
    pub volume_gain: f64,
    pub crossfade_frames_ms: u32,
    pub skip_same_album: bool,
}

pub(crate) struct Pipeline {
    pub rate: u32,
    pub format: OutputFormat,
    pub mixer: Sender<MixerMsg>,
    pub meters: Arc<Meters>,
    output: Box<dyn OutputStream>,
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Pipeline {
    pub fn build(
        factory: &mut dyn OutputFactory,
        settings: PipelineSettings<'_>,
        mixer_events: Sender<MixerEvent>,
        output_events: Sender<OutputEvent>,
        spectrum: Sender<SpectrumFrame>,
    ) -> Result<Self, OutputError> {
        let shared_rate = factory.sample_rate(settings.output)?;
        let requested_rate = if settings.output.exclusive { settings.exclusive_rate.unwrap_or(shared_rate) } else { shared_rate };

        let ring_samples = ((f64::from(requested_rate) * OUTPUT_RING_MS / 1000.0) as usize).max(4096) * ENGINE_CHANNELS;
        let (out_tx, out_rx) = rtrb::RingBuffer::<f32>::new(ring_samples);
        let request = OutputRequest {
            exclusive_rate: settings.output.exclusive.then_some(requested_rate),
            buffer_ms: EXCLUSIVE_BUFFER_MS,
        };
        let output = factory.open(settings.output, request, out_rx, output_events)?;
        let format = output.format().clone();
        // The stream decides the final rate (exclusive may have fallen back to shared mode).
        let rate = format.sample_rate;

        let mut chain = DspChain::new(rate);
        chain.set_config(settings.dsp);
        chain.set_volume(settings.volume_gain);

        let (mixer_tx, mixer_rx) = crossbeam_channel::unbounded();
        let (tap_tx, tap_rx) = rtrb::RingBuffer::<f32>::new(rate as usize / 2);
        let meters = Meters::new();
        let stop = Arc::new(AtomicBool::new(false));

        let mixer = Mixer::new(rate, chain, out_tx, tap_tx, meters.clone(), mixer_rx, mixer_events, OUTPUT_TARGET_FILL_MS);
        let crossfade_frames = u64::from(settings.crossfade_frames_ms) * u64::from(rate) / 1000;
        let _ = mixer_tx.send(MixerMsg::Crossfade { frames: crossfade_frames, skip_same_album: settings.skip_same_album });

        let mut threads = Vec::new();
        {
            let stop = stop.clone();
            threads.push(
                std::thread::Builder::new()
                    .name("navify-mixer".into())
                    .spawn(move || mixer.run(stop))
                    .expect("spawn mixer thread"),
            );
        }
        {
            let stop = stop.clone();
            let meters = meters.clone();
            threads.push(
                std::thread::Builder::new()
                    .name("navify-analyzer".into())
                    .spawn(move || run_analyzer(rate, tap_rx, meters, spectrum, stop))
                    .expect("spawn analyzer thread"),
            );
        }

        let mut pipeline = Self { rate, format, mixer: mixer_tx, meters, output, stop, threads };
        pipeline.output.play();
        Ok(pipeline)
    }

    pub fn send(&self, msg: MixerMsg) {
        let _ = self.mixer.send(msg);
    }

    pub fn play(&mut self) {
        self.output.play();
    }

    pub fn pause(&mut self) {
        self.output.pause();
    }

    /// Discards audio already queued for the device (used when seeking while paused).
    pub fn flush(&mut self) {
        self.output.flush();
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

fn run_analyzer(
    rate: u32,
    mut tap: rtrb::Consumer<f32>,
    meters: Arc<Meters>,
    spectrum: Sender<SpectrumFrame>,
    stop: Arc<AtomicBool>,
) {
    let mut analyzer = SpectrumAnalyzer::new(rate, SPECTRUM_BANDS);
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(SPECTRUM_INTERVAL);
        let available = tap.slots();
        if available > 0
            && let Ok(chunk) = tap.read_chunk(available)
        {
            let (a, b) = chunk.as_slices();
            analyzer.push(a);
            analyzer.push(b);
            chunk.commit_all();
        }
        if meters.tap_enabled.load(Ordering::Relaxed) {
            let frame = analyzer.frame(meters.take_peak_db());
            let _ = spectrum.try_send(frame);
        }
    }
}
