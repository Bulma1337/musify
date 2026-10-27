//! Callback logic without a device: pause/play ramp, channel mapping, underruns.

mod output_render {
    use musify_audio::output::ramp::{Control, ramp_frames};
    use musify_audio::output::render::{Renderer, map_stereo, map_stereo_frame};
    use rtrb::RingBuffer;

    const RATE: u32 = 48_000;

    fn push_frames(p: &mut rtrb::Producer<f64>, frames: usize, l: f64, r: f64) {
        for _ in 0..frames {
            p.push(l).unwrap();
            p.push(r).unwrap();
        }
    }

    #[test]
    fn channel_mapping_1_2_6_8() {
        let mut mono = [9.0];
        map_stereo_frame(0.5, -0.25, &mut mono);
        assert_eq!(mono, [0.125]);

        let mut st = [9.0; 2];
        map_stereo_frame(0.5, -0.25, &mut st);
        assert_eq!(st, [0.5, -0.25]);

        for ch in [6usize, 8] {
            let mut out = vec![9.0; ch];
            map_stereo_frame(0.5, -0.25, &mut out);
            assert_eq!(&out[..2], &[0.5, -0.25]);
            assert!(
                out[2..].iter().all(|&s| s == 0.0),
                "{ch} ch: extra channels silent"
            );
        }

        // Interleaved buffers, and the same through the renderer for a 6-channel device.
        let stereo = [0.1, 0.2, 0.3, 0.4];
        let mut out = vec![9.0; 12];
        map_stereo(&stereo, 6, &mut out);
        assert_eq!(
            out,
            vec![0.1, 0.2, 0.0, 0.0, 0.0, 0.0, 0.3, 0.4, 0.0, 0.0, 0.0, 0.0]
        );

        let (mut p, mut c) = RingBuffer::new(64);
        for s in stereo {
            p.push(s).unwrap();
        }
        let mut r = Renderer::new(6, RATE, Control::new());
        let mut out = vec![9.0; 12];
        r.render(&mut c, &mut out);
        assert_eq!(
            out,
            vec![0.1, 0.2, 0.0, 0.0, 0.0, 0.0, 0.3, 0.4, 0.0, 0.0, 0.0, 0.0]
        );

        let (mut p, mut c) = RingBuffer::new(64);
        for s in stereo {
            p.push(s).unwrap();
        }
        let mut r = Renderer::new(1, RATE, Control::new());
        let mut out = vec![9.0; 2];
        r.render(&mut c, &mut out);
        assert_eq!(out, vec![(0.1f64 + 0.2) * 0.5, (0.3f64 + 0.4) * 0.5]);
    }

    #[test]
    fn pause_fades_to_exact_zero_and_play_fades_in() {
        let ramp = ramp_frames(RATE) as usize;
        assert_eq!(ramp, 240, "5 ms at 48 kHz");
        let (mut p, mut c) = RingBuffer::new(1 << 16);
        push_frames(&mut p, 10_000, 0.5, -0.5);
        let control = Control::new();
        let mut r = Renderer::new(2, RATE, control.clone());

        // Playing: unity, bit-exact.
        let mut out = vec![0.0; 2 * 64];
        r.render(&mut c, &mut out);
        assert!(out.chunks(2).all(|f| f == [0.5, -0.5]));
        let before = c.slots();

        // Pause: monotonic fade to exactly zero within ~5 ms, then silence and no consumption.
        control.set_paused(true);
        let mut out = vec![9.0; 2 * 512];
        r.render(&mut c, &mut out);
        let left: Vec<f64> = out.chunks(2).map(|f| f[0]).collect();
        assert!(left.windows(2).all(|w| w[1] <= w[0]), "monotonic");
        let first_zero = left.iter().position(|&s| s == 0.0).expect("reaches zero");
        assert!(first_zero <= ramp, "zero after {first_zero} frames");
        assert!(left[first_zero..].iter().all(|&s| s == 0.0));
        assert!(out.chunks(2).all(|f| f[1] == -f[0]));
        assert_eq!(before - c.slots(), 2 * ramp, "consumes only the fade");

        let consumed_at_pause = c.slots();
        r.render(&mut c, &mut out);
        assert!(out.iter().all(|&s| s == 0.0));
        assert_eq!(c.slots(), consumed_at_pause, "paused: ring untouched");
        assert_eq!(control.xruns(), 0);

        // Play: monotonic fade-in from near zero back to exact unity.
        control.set_paused(false);
        let mut out = vec![9.0; 2 * 512];
        r.render(&mut c, &mut out);
        let left: Vec<f64> = out.chunks(2).map(|f| f[0]).collect();
        assert!(left[0] > 0.0 && left[0] < 0.01);
        assert!(left.windows(2).all(|w| w[1] >= w[0]), "monotonic");
        assert!(
            left[ramp - 1..].iter().all(|&s| s == 0.5),
            "unity after the ramp"
        );
        assert_eq!(consumed_at_pause - c.slots(), 2 * 512);
    }

    #[test]
    fn underrun_plays_partial_data_then_silence_and_counts_once() {
        let (mut p, mut c) = RingBuffer::new(4096);
        let control = Control::new();
        let mut r = Renderer::new(2, RATE, control.clone());
        let mut out = vec![9.0; 2 * 256];

        // Not started yet: silence without xrun.
        r.render(&mut c, &mut out);
        assert!(out.iter().all(|&s| s == 0.0));
        assert_eq!(control.xruns(), 0);

        push_frames(&mut p, 100, 0.25, 0.75);
        r.render(&mut c, &mut out);
        assert!(out[..200].chunks(2).all(|f| f == [0.25, 0.75]));
        assert!(out[200..].iter().all(|&s| s == 0.0));
        assert_eq!(control.xruns(), 1);

        // Still starved: same episode.
        r.render(&mut c, &mut out);
        assert!(out.iter().all(|&s| s == 0.0));
        assert_eq!(control.xruns(), 1);

        // Recovered, then a new shortfall.
        push_frames(&mut p, 300, 0.25, 0.75);
        r.render(&mut c, &mut out);
        assert!(out.chunks(2).all(|f| f == [0.25, 0.75]));
        assert_eq!(control.xruns(), 1);
        r.render(&mut c, &mut out);
        assert!(out[..88].chunks(2).all(|f| f == [0.25, 0.75]));
        assert!(out[88..].iter().all(|&s| s == 0.0));
        assert_eq!(control.xruns(), 2);
    }

    /// Left channel of every frame of `out`.
    fn left(out: &[f64]) -> Vec<f64> {
        out.chunks(2).map(|f| f[0]).collect()
    }

    #[test]
    fn cut_fades_out_the_queued_audio_and_goes_on_with_what_follows_it() {
        let ramp = ramp_frames(RATE) as usize;
        let (mut p, mut c) = RingBuffer::new(2 * 8192);
        let control = Control::new();
        let mut r = Renderer::new(2, RATE, control.clone());
        let mut out = vec![9.0; 2 * 128];
        // Old track playing, then 50 ms of it queued (what the mixer keeps ahead).
        push_frames(&mut p, 128, 1.0, -1.0);
        r.render(&mut c, &mut out);
        push_frames(&mut p, 2400, 1.0, -1.0);
        // Manual switch: cut after everything written so far; the new track follows.
        control.request_cut(2 * (128 + 2400));
        push_frames(&mut p, 4000, 0.25, -0.25);

        // Small callbacks, so that the fade runs across several of them.
        let mut heard = Vec::new();
        for _ in 0..8 {
            let mut out = vec![9.0; 2 * 100];
            r.render(&mut c, &mut out);
            assert!(out.chunks(2).all(|f| f[1] == -f[0]));
            heard.extend(left(&out));
        }
        // Exactly one ramp of the old track, falling smoothly to zero (no click), then the new one.
        let old = &heard[..ramp];
        assert!(old.windows(2).all(|w| w[1] <= w[0]), "monotonic fade");
        assert!(
            old[0] < 1.0 && old[0] > 0.99,
            "starts at full level: {}",
            old[0]
        );
        assert_eq!(old[ramp - 1], 0.0, "ends at zero");
        let max_step = old.windows(2).map(|w| w[0] - w[1]).fold(0.0, f64::max);
        assert!(max_step < 2.0 / ramp as f64, "fade step {max_step}");
        assert!(
            heard[ramp..].iter().all(|&s| s == 0.25),
            "new audio right after the fade"
        );
        assert_eq!(control.xruns(), 0, "dropping the queue is no underrun");
    }

    #[test]
    fn cut_while_paused_drops_the_old_audio_without_playing_it() {
        let (mut p, mut c) = RingBuffer::new(2 * 8192);
        let control = Control::new();
        let mut r = Renderer::new(2, RATE, control.clone());
        push_frames(&mut p, 3000, 1.0, 1.0);
        let mut out = vec![9.0; 2 * 512];
        r.render(&mut c, &mut out);
        control.set_paused(true);
        r.render(&mut c, &mut out);
        r.render(&mut c, &mut out);
        assert!(out.iter().all(|&s| s == 0.0));

        // A new track chosen while paused: the queued rest of the old one must never be heard.
        control.request_cut(2 * 3000);
        push_frames(&mut p, 2000, 0.25, 0.25);
        r.render(&mut c, &mut out);
        assert!(out.iter().all(|&s| s == 0.0), "still paused");
        control.set_paused(false);
        let mut heard = Vec::new();
        for _ in 0..3 {
            r.render(&mut c, &mut out);
            heard.extend(left(&out));
        }
        assert!(heard.iter().all(|&s| s <= 0.25), "old audio after resume");
        assert!(
            heard[ramp_frames(RATE) as usize..1000]
                .iter()
                .all(|&s| s == 0.25)
        );
    }

    #[test]
    fn cut_positions_count_audio_dropped_by_a_flush() {
        let (mut p, mut c) = RingBuffer::new(2 * 8192);
        let control = Control::new();
        let mut r = Renderer::new(2, RATE, control.clone());
        push_frames(&mut p, 1000, 1.0, 1.0);
        control.request_flush();
        let mut out = vec![9.0; 2 * 256];
        r.render(&mut c, &mut out);
        assert!(out.iter().all(|&s| s == 0.0), "flushed");
        // Positions go on after the flushed samples: a cut at the end of new audio A keeps A's
        // fade and then plays B.
        push_frames(&mut p, 600, 0.5, 0.5);
        control.request_cut(2 * 1600);
        push_frames(&mut p, 600, 0.25, 0.25);
        let mut out = vec![9.0; 2 * 1024];
        r.render(&mut c, &mut out);
        let heard = left(&out);
        let ramp = ramp_frames(RATE) as usize;
        assert!(heard[0] > 0.49 && heard[ramp - 1] == 0.0, "A fades out");
        assert!(heard[ramp..ramp + 600].iter().all(|&s| s == 0.25), "then B");
    }
}
