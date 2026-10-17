//! Real-time safety: `process`, `set_volume` and `reset` never touch the allocator, with every stage
//! active and while parameters glide / structures crossfade. Any allocation aborts this test binary
//! (debug builds; run with `cargo test`).

use assert_no_alloc::{AllocDisabler, assert_no_alloc};
use musify_audio::api::{
    BassEnhancerConfig, DspConfig, EqConfig, EqMode, FilterKind, GraphicBands, ParametricFilter,
    StereoConfig,
};
use musify_audio::dsp::{DspChain, volume_to_gain};

#[global_allocator]
static A: AllocDisabler = AllocDisabler;

fn full_config(bands: GraphicBands, gain: f64) -> DspConfig {
    DspConfig {
        eq: EqConfig {
            enabled: true,
            preamp_db: -2.0,
            auto_headroom: true,
            mode: EqMode::Graphic {
                bands,
                gains_db: (0..31)
                    .map(|i| if i % 3 == 0 { gain } else { -gain / 2.0 })
                    .collect(),
            },
        },
        bass: BassEnhancerConfig {
            enabled: true,
            boost_db: 8.0,
            frequency_hz: 90.0,
            harmonics: 0.6,
        },
        stereo: StereoConfig {
            width: 1.4,
            mono: false,
            balance: 0.2,
        },
        loudness_compensation: true,
        limiter: true,
    }
}

fn process_some(chain: &mut DspChain, buf: &mut [f64], blocks: usize, volume: Option<f64>) {
    assert_no_alloc(|| {
        if let Some(v) = volume {
            chain.set_volume(v);
        }
        for k in 0..blocks {
            // Loud, odd-sized blocks so the limiter works and chunk boundaries are crossed.
            let n = [480usize, 7, 333, 1024][k % 4];
            let block = &mut buf[..2 * n];
            for (i, s) in block.iter_mut().enumerate() {
                *s = 1.5 * ((k * 1031 + i) as f64 * 0.013).sin();
            }
            block[3] = f64::NAN;
            chain.process(block);
        }
    });
}

#[test]
fn dsp_process_never_allocates() {
    for fs in [44_100u32, 192_000] {
        let mut chain = DspChain::new(fs);
        let mut buf = vec![0.0; 2 * 1024];
        // Bypass path.
        process_some(&mut chain, &mut buf, 8, Some(1.0));
        // Everything on (structural crossfade from bypass, all glides running).
        chain.set_config(&full_config(GraphicBands::Ten, 6.0));
        process_some(&mut chain, &mut buf, 40, Some(volume_to_gain(0.6)));
        // Parameter glide (same structure) while the volume moves.
        chain.set_config(&full_config(GraphicBands::Ten, -4.0));
        process_some(&mut chain, &mut buf, 40, Some(volume_to_gain(0.3)));
        // Two structural changes in a row: one fades, one waits as pending; banks retire on the
        // audio thread without being dropped there.
        chain.set_config(&full_config(GraphicBands::ThirtyOne, 3.0));
        process_some(&mut chain, &mut buf, 3, None);
        let mut para = full_config(GraphicBands::Ten, 0.0);
        para.eq.mode = EqMode::Parametric {
            filters: vec![
                ParametricFilter {
                    enabled: true,
                    kind: FilterKind::HighPass,
                    freq_hz: 30.0,
                    gain_db: 0.0,
                    q: 0.7,
                },
                ParametricFilter {
                    enabled: true,
                    kind: FilterKind::Peaking,
                    freq_hz: 2500.0,
                    gain_db: 5.0,
                    q: 2.0,
                },
            ],
        };
        chain.set_config(&para);
        process_some(&mut chain, &mut buf, 200, Some(1.0));
        // Limiter off (fade out) and reset on the audio thread.
        para.limiter = false;
        chain.set_config(&para);
        process_some(&mut chain, &mut buf, 100, None);
        assert_no_alloc(|| chain.reset());
        process_some(&mut chain, &mut buf, 10, None);
        assert_no_alloc(|| {
            let _ = chain.take_peak_db();
            let _ = chain.latency_frames();
        });
    }
}
