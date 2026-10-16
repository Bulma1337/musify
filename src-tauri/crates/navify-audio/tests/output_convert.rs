//! f32 → device format conversion: exactness, clipping, dither policy.

mod output_convert {
    use navify_audio::output::convert::{
        Encoder, SampleEncoding, Tpdf, f32_to_i16_dithered, f32_to_i24, f32_to_i32,
    };

    const S24: f32 = 8_388_608.0;

    /// Every 24-bit value at a coprime stride plus the edges.
    fn i24_values() -> impl Iterator<Item = i32> {
        let edges = [
            -(1 << 23),
            -(1 << 23) + 1,
            -1,
            0,
            1,
            (1 << 23) - 2,
            (1 << 23) - 1,
        ];
        (-(1 << 23)..(1 << 23)).step_by(997).chain(edges)
    }

    #[test]
    fn i24_and_i32_are_exact_for_24_bit_content() {
        for k in i24_values() {
            let x = k as f32 / S24;
            assert_eq!(f32_to_i24(x), k, "i24 {k}");
            assert_eq!(f32_to_i32(x), k << 8, "i32 {k}");
        }
    }

    #[test]
    fn encoders_write_exact_24_bit_layouts() {
        let ks: Vec<i32> = i24_values().collect();
        let src: Vec<f32> = ks.iter().map(|&k| k as f32 / S24).collect();
        let check = |enc: SampleEncoding, expect: &dyn Fn(i32) -> Vec<u8>| {
            let bps = enc.bytes_per_sample();
            let mut dst = vec![0u8; src.len() * bps];
            Encoder::new(enc).encode(&src, &mut dst);
            for (i, &k) in ks.iter().enumerate() {
                assert_eq!(
                    &dst[i * bps..(i + 1) * bps],
                    expect(k).as_slice(),
                    "{enc:?} {k}"
                );
            }
        };
        check(SampleEncoding::I24In32High, &|k| {
            (k << 8).to_ne_bytes().to_vec()
        });
        check(SampleEncoding::I24In32Low, &|k| k.to_ne_bytes().to_vec());
        check(SampleEncoding::I32, &|k| (k << 8).to_ne_bytes().to_vec());
        check(SampleEncoding::I24Packed, &|k| {
            k.to_le_bytes()[..3].to_vec()
        });
        check(SampleEncoding::F32, &|k| {
            (k as f32 / S24).to_ne_bytes().to_vec()
        });
    }

    #[test]
    fn i16_is_exact_for_16_bit_content() {
        let mut dither = Tpdf::default();
        let mut src = Vec::new();
        for k in i16::MIN..=i16::MAX {
            let x = f32::from(k) / 32_768.0;
            assert_eq!(f32_to_i16_dithered(x, &mut dither), k);
            src.push(x);
        }
        let mut dst = vec![0u8; src.len() * 2];
        Encoder::new(SampleEncoding::I16).encode(&src, &mut dst);
        for (i, k) in (i16::MIN..=i16::MAX).enumerate() {
            assert_eq!(i16::from_ne_bytes([dst[2 * i], dst[2 * i + 1]]), k);
        }
    }

    #[test]
    fn out_of_range_values_clip() {
        assert_eq!(f32_to_i24(1.0), (1 << 23) - 1);
        assert_eq!(f32_to_i24(1.5), (1 << 23) - 1);
        assert_eq!(f32_to_i24(-1.0), -(1 << 23));
        assert_eq!(f32_to_i24(-7.0), -(1 << 23));
        assert_eq!(f32_to_i24(f32::INFINITY), (1 << 23) - 1);
        assert_eq!(f32_to_i24(f32::NAN), 0);
        assert_eq!(f32_to_i32(1.0), i32::MAX);
        assert_eq!(f32_to_i32(-1.0), i32::MIN);
        assert_eq!(f32_to_i32(-3.0), i32::MIN);
        assert_eq!(f32_to_i32(f32::NAN), 0);
        let mut d = Tpdf::default();
        assert_eq!(f32_to_i16_dithered(1.0, &mut d), i16::MAX);
        assert_eq!(f32_to_i16_dithered(2.0, &mut d), i16::MAX);
        assert_eq!(f32_to_i16_dithered(-1.5, &mut d), i16::MIN);
        assert_eq!(f32_to_i16_dithered(f32::NAN, &mut d), 0);
    }

    #[test]
    fn dither_only_when_reducing_to_16_bit_or_less() {
        assert!(SampleEncoding::I16.needs_dither());
        assert!(SampleEncoding::U8.needs_dither());
        for enc in [
            SampleEncoding::I24In32High,
            SampleEncoding::I24Packed,
            SampleEncoding::I32,
            SampleEncoding::F32,
        ] {
            assert!(!enc.needs_dither(), "{enc:?}");
        }

        // Off the 16-bit grid: TPDF dither → values spread over neighbours, mean preserved.
        let x = 0.300_007_f32;
        let target = f64::from(x) * 32_768.0;
        let mut d = Tpdf::new(12345);
        let outs: Vec<i16> = (0..20_000)
            .map(|_| f32_to_i16_dithered(x, &mut d))
            .collect();
        let min = *outs.iter().min().unwrap();
        let max = *outs.iter().max().unwrap();
        assert!(max > min, "16-bit output must be dithered");
        assert!(f64::from(min) >= target.floor() - 1.0 && f64::from(max) <= target.ceil() + 1.0);
        let mean = outs.iter().map(|&v| f64::from(v)).sum::<f64>() / outs.len() as f64;
        assert!((mean - target).abs() < 0.05, "mean {mean} vs {target}");

        // 24/32-bit: deterministic rounding, no dither, even for content finer than 24 bit.
        let fine = [x, 1.0e-9, -0.123_456_79, 0.999_999_9];
        for enc in [
            SampleEncoding::I24In32High,
            SampleEncoding::I24Packed,
            SampleEncoding::I32,
        ] {
            let mut a = vec![0u8; fine.len() * enc.bytes_per_sample()];
            let mut b = a.clone();
            let mut e = Encoder::new(enc);
            for _ in 0..100 {
                e.encode(&fine, &mut a);
            }
            Encoder::new(enc).encode(&fine, &mut b);
            assert_eq!(a, b, "{enc:?} must not dither");
        }
        assert_eq!(
            f32_to_i24(x),
            (f64::from(x) * f64::from(S24)).round() as i32
        );

        // Digital silence stays digital silence.
        let mut dst = vec![0xAAu8; 2 * 64];
        Encoder::new(SampleEncoding::I16).encode(&[0.0; 64], &mut dst);
        assert!(dst.iter().all(|&b| b == 0));
    }

    #[test]
    fn unsigned_formats_are_offset() {
        let mut dst = [0u8; 2];
        Encoder::new(SampleEncoding::U16).encode(&[0.0], &mut dst);
        assert_eq!(u16::from_ne_bytes(dst), 0x8000);
        let mut dst = [0u8; 1];
        Encoder::new(SampleEncoding::U8).encode(&[0.0], &mut dst);
        assert_eq!(dst[0], 0x80);
        let mut dst = [0u8; 4];
        Encoder::new(SampleEncoding::U24In32Low).encode(&[-1.0], &mut dst);
        assert_eq!(u32::from_ne_bytes(dst), 0);
    }
}
