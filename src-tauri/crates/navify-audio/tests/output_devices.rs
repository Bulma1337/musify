//! Device enumeration (safe: queries only) and `#[ignore]`d tests that open a real device.
//!
//! The ignored tests never use exclusive mode and only ever output digital silence:
//! `cargo test -p navify-audio --test output_devices -- --ignored --nocapture`

mod output_devices {
    use std::collections::HashSet;
    use std::str::FromStr;
    use std::time::Duration;

    use navify_audio::api::OutputConfig;
    use navify_audio::output::{self, OutputRequest};
    use rtrb::RingBuffer;

    #[test]
    fn list_devices_returns_well_formed_ids() {
        let devices = output::list_devices();
        let mut seen = HashSet::new();
        for d in &devices {
            assert!(!d.id.is_empty());
            assert!(seen.insert(d.id.clone()), "duplicate id {}", d.id);
            let parsed = cpal::DeviceId::from_str(&d.id).expect("id parses as a cpal DeviceId");
            assert_eq!(parsed.to_string(), d.id, "id round-trips");
            assert!(!d.name.is_empty());
        }
        let defaults = devices.iter().filter(|d| d.is_default).count();
        assert!(defaults <= 1);
        if defaults == 1 {
            assert!(devices[0].is_default, "default device first");
        }
        // Lookup by id resolves (or the device vanished in between).
        if let Some(d) = devices.first() {
            let config = OutputConfig { device_id: Some(d.id.clone()), exclusive: false };
            if let Ok(rate) = output::device_sample_rate(&config) {
                assert!(rate > 0);
            }
        }
        let unknown = OutputConfig { device_id: Some("wasapi:does-not-exist".into()), exclusive: false };
        assert!(matches!(output::device_sample_rate(&unknown), Err(output::OutputError::DeviceNotFound(_))));
    }

    #[test]
    #[ignore = "opens the default output device (shared mode, digital silence)"]
    fn open_default_shared_with_silence() {
        let config = OutputConfig::default();
        let rate = output::device_sample_rate(&config).expect("default device");
        let (mut producer, consumer) = RingBuffer::new(1 << 16);
        while producer.push(0.0f32).is_ok() {}
        let (tx, rx) = crossbeam_channel::unbounded();
        let request = OutputRequest { exclusive_rate: None, buffer_ms: 50 };
        let stream = output::open(&config, request, consumer, tx).expect("open shared");
        let format = stream.format().clone();
        println!("{format:?}");
        assert_eq!(format.sample_rate, rate);
        assert!(format.channels >= 1);
        assert!(!format.exclusive);
        assert!(!format.bit_perfect);
        std::thread::sleep(Duration::from_millis(300));
        assert!(producer.slots() > 0, "the device consumed the ring");
        drop(stream);
        println!("events: {:?}, xruns ok", rx.try_iter().collect::<Vec<_>>());
    }

    #[test]
    #[ignore = "queries the drivers for exclusive-mode support (nothing is opened)"]
    fn exclusive_probe_without_opening() {
        for d in output::list_devices() {
            println!(
                "{}{} | {} Hz | {} ch | exclusive: {} | {}",
                if d.is_default { "* " } else { "  " },
                d.name,
                d.default_sample_rate,
                d.max_channels,
                d.supports_exclusive,
                d.id
            );
            if !cfg!(windows) {
                assert!(!d.supports_exclusive);
            }
        }
    }
}
