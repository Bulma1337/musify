//! NullOutput: the device-less backend used by engine tests.

mod output_null {
    use std::time::{Duration, Instant};

    use navify_audio::output::OutputStream;
    use navify_audio::output::null::{NullOutput, NullPacing};
    use navify_audio::output::ramp::ramp_frames;
    use rtrb::RingBuffer;

    const RATE: u32 = 48_000;

    fn wait_until(mut cond: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        cond()
    }

    #[test]
    fn collects_exactly_the_pushed_samples_in_order() {
        let (mut p, c) = RingBuffer::new(1 << 15);
        let out = NullOutput::new(c, RATE, NullPacing::Unpaced);
        assert_eq!(out.format().sample_rate, RATE);
        assert_eq!(out.format().channels, 2);
        let pushed: Vec<f64> = (0..50_000).map(|i| (i as f64 * 1.0e-5).sin()).collect();
        let mut rest = &pushed[..];
        while !rest.is_empty() {
            let n = p.slots().min(rest.len()) & !1;
            for &s in &rest[..n] {
                p.push(s).unwrap();
            }
            rest = &rest[n..];
            std::thread::yield_now();
        }
        assert!(wait_until(|| out.samples().len() >= pushed.len()));
        assert_eq!(out.samples(), pushed);
        assert_eq!(out.xruns(), 0);
    }

    #[test]
    fn pause_stops_consumption_and_play_resumes() {
        let ramp = ramp_frames(RATE) as usize;
        let (mut p, c) = RingBuffer::new(1 << 16);
        let mut out = NullOutput::new(c, RATE, NullPacing::Unpaced);
        let recording = out.sample_buffer();
        out.pause();
        let frames = 10_000;
        for _ in 0..frames {
            p.push(0.5).unwrap();
            p.push(0.5).unwrap();
        }
        assert!(wait_until(|| recording.lock().len() >= 2 * ramp));
        std::thread::sleep(Duration::from_millis(50));
        let rec = out.samples();
        assert_eq!(rec.len(), 2 * ramp, "only the fade is consumed");
        assert_eq!(*rec.last().unwrap(), 0.0);
        assert!(
            rec.chunks(2)
                .map(|f| f[0])
                .collect::<Vec<_>>()
                .windows(2)
                .all(|w| w[1] <= w[0])
        );
        assert_eq!(
            p.slots(),
            (1 << 16) - 2 * (frames - ramp),
            "ring untouched while paused"
        );

        out.play();
        assert!(wait_until(|| recording.lock().len() >= 2 * frames));
        let rec = out.take_samples();
        assert_eq!(rec.len(), 2 * frames);
        let resumed = &rec[2 * ramp..];
        assert!(
            resumed[0] > 0.0 && resumed[0] < 0.01,
            "fade-in starts near zero"
        );
        assert!(resumed[2 * ramp..].iter().all(|&s| s == 0.5));
        assert!(out.samples().is_empty());
    }

    #[test]
    fn real_time_pacing_pads_underruns_with_silence() {
        let (mut p, c) = RingBuffer::new(1 << 14);
        for i in 0..200 {
            p.push(i as f64).unwrap();
            p.push(-(i as f64)).unwrap();
        }
        let out: Box<dyn OutputStream> = {
            let null = NullOutput::new(c, RATE, NullPacing::RealTime);
            let rec = null.sample_buffer();
            assert!(wait_until(|| rec.lock().len() >= 2 * 2048));
            let data = rec.lock().clone();
            assert_eq!(&data[..4], &[0.0, -0.0, 1.0, -1.0]);
            assert_eq!(data[2 * 199], 199.0);
            assert!(data[400..].iter().all(|&s| s == 0.0));
            Box::new(null)
        };
        assert_eq!(out.xruns(), 1);
    }
}
