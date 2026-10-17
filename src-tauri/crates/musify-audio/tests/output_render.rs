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
}
