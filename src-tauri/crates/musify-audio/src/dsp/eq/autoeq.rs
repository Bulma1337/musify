//! AutoEQ / Equalizer APO `ParametricEQ.txt` import.
//!
//! Accepted lines (case-insensitive, any whitespace, CRLF or LF, `#` starts a comment):
//!
//! ```text
//! Preamp: -6.2 dB
//! Filter 1: ON PK Fc 105 Hz Gain -2.3 dB Q 0.70
//! Filter 2: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70
//! Filter 3: OFF HP Fc 20 Hz
//! Filter: ON PK Fc 1000 Hz Gain 3 dB BW Oct 1.0
//! ```
//!
//! Types: `PK`/`PEQ` (peaking), `LS`/`LSC`/`LSQ` (low shelf), `HS`/`HSC`/`HSQ` (high shelf),
//! `LP`/`LPQ`, `HP`/`HPQ`, `NO` (notch). Shelves are RBJ shelves with Q at `Fc` (AutoEQ's own
//! definition). Missing Q defaults to 1/√2 (Butterworth) for shelves and pass filters and to 30 for
//! notches; missing Gain is only allowed for pass/notch filters. Several `Preamp` lines add up (as
//! in Equalizer APO). Other directives (`Device:`, `Channel:`, `Include:` …) are ignored.

use crate::api::{EqConfig, EqMode, FilterKind, ParametricFilter};
use crate::dsp::AutoEqError;
use crate::dsp::biquad::BUTTERWORTH_Q;

const DEFAULT_NOTCH_Q: f64 = 30.0;

fn err(line_no: usize, msg: impl std::fmt::Display) -> AutoEqError {
    AutoEqError(format!("line {line_no}: {msg}"))
}

fn parse_num(tok: Option<&str>, line_no: usize, what: &str) -> Result<f64, AutoEqError> {
    let t = tok.ok_or_else(|| err(line_no, format!("missing value for {what}")))?;
    let v: f64 = t
        .replace(',', ".")
        .parse()
        .map_err(|_| err(line_no, format!("invalid {what} `{t}`")))?;
    if v.is_finite() {
        Ok(v)
    } else {
        Err(err(line_no, format!("invalid {what} `{t}`")))
    }
}

fn kind_of(t: &str) -> Option<FilterKind> {
    Some(match t {
        "PK" | "PEQ" => FilterKind::Peaking,
        "LS" | "LSC" | "LSQ" => FilterKind::LowShelf,
        "HS" | "HSC" | "HSQ" => FilterKind::HighShelf,
        "LP" | "LPQ" => FilterKind::LowPass,
        "HP" | "HPQ" => FilterKind::HighPass,
        "NO" => FilterKind::Notch,
        _ => return None,
    })
}

/// Q of a peaking filter with the given bandwidth in octaves.
fn bw_oct_to_q(bw: f64) -> f64 {
    let p = 2f64.powf(bw);
    p.sqrt() / (p - 1.0)
}

pub fn parse(text: &str) -> Result<EqConfig, AutoEqError> {
    let mut preamp_db = 0.0;
    let mut saw_preamp = false;
    let mut filters = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line_no = i + 1;
        let line = raw
            .split('#')
            .next()
            .unwrap_or("")
            .trim()
            .trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        let Some((head, rest)) = line.split_once(':') else {
            continue;
        };
        let head = head.trim().to_ascii_uppercase();
        if head == "PREAMP" {
            let mut toks = rest.split_whitespace();
            preamp_db += parse_num(toks.next(), line_no, "preamp")?;
            saw_preamp = true;
        } else if head == "FILTER"
            || head
                .strip_prefix("FILTER")
                .is_some_and(|n| n.trim().chars().all(|c| c.is_ascii_digit()))
        {
            filters.push(parse_filter(rest, line_no)?);
        }
    }
    if filters.is_empty() && !saw_preamp {
        return Err(AutoEqError("no `Preamp:` or `Filter:` lines found".into()));
    }
    Ok(EqConfig {
        enabled: true,
        preamp_db,
        auto_headroom: false,
        mode: EqMode::Parametric { filters },
    })
}

fn parse_filter(rest: &str, line_no: usize) -> Result<ParametricFilter, AutoEqError> {
    let toks: Vec<String> = rest
        .split_whitespace()
        .map(|t| t.to_ascii_uppercase())
        .collect();
    let mut it = toks.iter().map(String::as_str).peekable();
    let enabled = match it.next() {
        Some("ON") => true,
        Some("OFF") => false,
        Some(t) => return Err(err(line_no, format!("expected ON/OFF, found `{t}`"))),
        None => return Err(err(line_no, "empty filter")),
    };
    let kind_tok = it
        .next()
        .ok_or_else(|| err(line_no, "missing filter type"))?;
    let kind = kind_of(kind_tok)
        .ok_or_else(|| err(line_no, format!("unsupported filter type `{kind_tok}`")))?;
    let (mut fc, mut gain, mut q) = (None, None, None);
    while let Some(t) = it.next() {
        match t {
            "FC" => fc = Some(parse_num(it.next(), line_no, "Fc")?),
            "GAIN" => gain = Some(parse_num(it.next(), line_no, "Gain")?),
            "Q" => q = Some(parse_num(it.next(), line_no, "Q")?),
            "BW" => {
                if it.peek() == Some(&"OCT") {
                    it.next();
                }
                q = Some(bw_oct_to_q(parse_num(it.next(), line_no, "BW")?));
            }
            "HZ" | "DB" => {}
            _ => {} // unknown words (units, future extensions) are ignored
        }
    }
    let freq_hz = fc.ok_or_else(|| err(line_no, "missing Fc"))?;
    if freq_hz <= 0.0 {
        return Err(err(line_no, "Fc must be positive"));
    }
    let needs_gain = matches!(
        kind,
        FilterKind::Peaking | FilterKind::LowShelf | FilterKind::HighShelf
    );
    let gain_db = match (gain, needs_gain) {
        (Some(g), _) => g,
        (None, false) => 0.0,
        (None, true) => return Err(err(line_no, "missing Gain")),
    };
    let q = match q {
        Some(q) if q > 0.0 => q,
        Some(_) => return Err(err(line_no, "Q must be positive")),
        None if kind == FilterKind::Peaking => return Err(err(line_no, "missing Q")),
        None if kind == FilterKind::Notch => DEFAULT_NOTCH_Q,
        None => BUTTERWORTH_Q,
    };
    Ok(ParametricFilter {
        enabled,
        kind,
        freq_hz,
        gain_db,
        q,
    })
}
