//! Glyphs of the thumbnail buttons, drawn at runtime at the exact icon size of the current DPI.
//! The shapes are the app's lucide icons (heart, skip-back, play, pause, skip-forward; lucide is ISC
//! licensed), painted the way the player bar paints them. Path data is flattened to polylines and
//! rendered from signed distances, which gives clean anti-aliased edges even at 16 px.

type Point = (f64, f64);

/// Lucide's drawing grid.
const GRID: f64 = 24.0;
/// Lucide's stroke width.
const STROKE: f64 = 2.0;
/// Segments per cubic Bézier curve.
const CURVE_STEPS: usize = 16;
/// Largest angle per segment of a flattened arc.
const ARC_STEP: f64 = std::f64::consts::PI / 16.0;

/// Glyph colors on a dark and on a light taskbar.
pub const LIGHT_GLYPH: [u8; 3] = [255, 255, 255];
pub const DARK_GLYPH: [u8; 3] = [28, 28, 28];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Glyph {
    Heart,
    HeartFilled,
    SkipBack,
    Play,
    Pause,
    SkipForward,
}

impl Glyph {
    pub const ALL: [Self; 6] = [
        Self::Heart,
        Self::HeartFilled,
        Self::SkipBack,
        Self::Play,
        Self::Pause,
        Self::SkipForward,
    ];

    pub fn index(self) -> usize {
        self as usize
    }
}

#[derive(Debug, Clone, Copy)]
enum Paint {
    Fill,
    Stroke,
    /// Filled and stroked, like an icon drawn with `fill="currentColor"`.
    FillStroke,
}

const HEART: &str = "M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5";
const PLAY: &str =
    "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z";
/// Lucide's two rects (x 5 and 14, y 3, 5 × 18, rx 1) as paths.
const PAUSE: &str = "M6 3h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM15 3h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z";
const SKIP_BACK: &str =
    "M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z";
const SKIP_BACK_BAR: &str = "M3 20V4";
const SKIP_FORWARD: &str =
    "M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z";
const SKIP_FORWARD_BAR: &str = "M21 4v16";

fn layers(glyph: Glyph) -> &'static [(&'static str, Paint)] {
    match glyph {
        Glyph::Heart => &[(HEART, Paint::Stroke)],
        Glyph::HeartFilled => &[(HEART, Paint::FillStroke)],
        // The player bar draws play and pause filled without a stroke, the skip buttons with one.
        Glyph::Play => &[(PLAY, Paint::Fill)],
        Glyph::Pause => &[(PAUSE, Paint::Fill)],
        Glyph::SkipBack => &[(SKIP_BACK, Paint::FillStroke), (SKIP_BACK_BAR, Paint::Stroke)],
        Glyph::SkipForward => &[
            (SKIP_FORWARD, Paint::FillStroke),
            (SKIP_FORWARD_BAR, Paint::Stroke),
        ],
    }
}

/// Renders a glyph as `size` × `size` RGBA (straight alpha, rows top to bottom) in `color`.
pub fn render(glyph: Glyph, size: u32, color: [u8; 3]) -> Vec<u8> {
    let shapes: Vec<(Vec<Polyline>, Paint)> = layers(glyph)
        .iter()
        .map(|&(d, paint)| (parse_path(d), paint))
        .collect();
    let size = size as usize;
    let units_per_px = GRID / size as f64;
    let mut out = vec![0; size * size * 4];
    for (i, pixel) in out.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let p = (
            ((i % size) as f64 + 0.5) * units_per_px,
            ((i / size) as f64 + 0.5) * units_per_px,
        );
        let distance = shapes
            .iter()
            .map(|(lines, paint)| shape_distance(lines, *paint, p))
            .fold(f64::INFINITY, f64::min);
        let coverage = (0.5 - distance / units_per_px).clamp(0.0, 1.0);
        let alpha = (coverage * 255.0).round() as u8;
        if alpha > 0 {
            *pixel = [color[0], color[1], color[2], alpha];
        }
    }
    out
}

/// Signed distance from `p` to a painted path (negative inside), in grid units.
fn shape_distance(lines: &[Polyline], paint: Paint, p: Point) -> f64 {
    match paint {
        Paint::Stroke => outline_distance(lines, p, false) - STROKE / 2.0,
        Paint::Fill => fill_distance(lines, p),
        Paint::FillStroke => fill_distance(lines, p) - STROKE / 2.0,
    }
}

/// Distance to the edges; fills close every subpath, strokes only the ones closed with `z`.
fn outline_distance(lines: &[Polyline], p: Point, fill: bool) -> f64 {
    lines
        .iter()
        .flat_map(|line| line.edges(fill || line.closed))
        .map(|(a, b)| segment_distance(p, a, b))
        .fold(f64::INFINITY, f64::min)
}

fn fill_distance(lines: &[Polyline], p: Point) -> f64 {
    // Even-odd rule: enough for these shapes, whose subpaths never overlap.
    let crossings = lines
        .iter()
        .flat_map(|line| line.edges(true))
        .filter(|&(a, b)| (a.1 > p.1) != (b.1 > p.1) && p.0 < a.0 + (b.0 - a.0) * (p.1 - a.1) / (b.1 - a.1))
        .count();
    let distance = outline_distance(lines, p, true);
    if crossings % 2 == 1 { -distance } else { distance }
}

fn segment_distance(p: Point, a: Point, b: Point) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let length2 = dx * dx + dy * dy;
    let t = if length2 > 0.0 {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / length2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (p.0 - a.0 - t * dx).hypot(p.1 - a.1 - t * dy)
}

/// A subpath flattened to straight segments.
#[derive(Debug)]
struct Polyline {
    points: Vec<Point>,
    closed: bool,
}

impl Polyline {
    fn edges(&self, close: bool) -> impl Iterator<Item = (Point, Point)> + '_ {
        let closing = match (close, self.points.first(), self.points.last()) {
            (true, Some(&first), Some(&last)) if self.points.len() > 2 => Some((last, first)),
            _ => None,
        };
        self.points.windows(2).map(|w| (w[0], w[1])).chain(closing)
    }
}

/// Parses SVG path data (M, L, H, V, C, A, Z, absolute and relative) into polylines. Stops at the
/// first malformed token; the paths are constants checked by the tests.
fn parse_path(d: &str) -> Vec<Polyline> {
    let mut parser = PathParser {
        tokens: Tokens {
            s: d.as_bytes(),
            i: 0,
            last: None,
        },
        lines: Vec::new(),
        current: Vec::new(),
        pos: (0.0, 0.0),
        start: (0.0, 0.0),
    };
    while parser.segment().is_some() {}
    parser.finish(false);
    parser.lines
}

struct PathParser<'a> {
    tokens: Tokens<'a>,
    lines: Vec<Polyline>,
    current: Vec<Point>,
    pos: Point,
    start: Point,
}

impl PathParser<'_> {
    /// Reads one command (or one repetition of the previous one).
    fn segment(&mut self) -> Option<()> {
        let command = match self.tokens.command() {
            Some(c) => c,
            None if self.tokens.at_number() => self.tokens.last?,
            None => return None,
        };
        let relative = command.is_ascii_lowercase();
        let base = if relative { self.pos } else { (0.0, 0.0) };
        let t = &mut self.tokens;
        match command.to_ascii_uppercase() {
            b'M' => {
                let p = t.point(base)?;
                // Further coordinate pairs after a move are lines.
                t.last = Some(if relative { b'l' } else { b'L' });
                self.finish(false);
                self.current.push(p);
                self.start = p;
                self.pos = p;
            }
            b'L' => {
                let p = t.point(base)?;
                self.line_to(p);
            }
            b'H' => {
                let x = t.number()? + base.0;
                self.line_to((x, self.pos.1));
            }
            b'V' => {
                let y = t.number()? + base.1;
                self.line_to((self.pos.0, y));
            }
            b'C' => {
                let (c1, c2, p) = (t.point(base)?, t.point(base)?, t.point(base)?);
                let p0 = self.pos;
                for step in 1..=CURVE_STEPS {
                    let s = step as f64 / CURVE_STEPS as f64;
                    let u = 1.0 - s;
                    let w = [u * u * u, 3.0 * u * u * s, 3.0 * u * s * s, s * s * s];
                    self.current.push((
                        w[0] * p0.0 + w[1] * c1.0 + w[2] * c2.0 + w[3] * p.0,
                        w[0] * p0.1 + w[1] * c1.1 + w[2] * c2.1 + w[3] * p.1,
                    ));
                }
                self.pos = p;
            }
            b'A' => {
                let (rx, ry, rotation) = (t.number()?, t.number()?, t.number()?);
                let (large, sweep) = (t.flag()?, t.flag()?);
                let p = t.point(base)?;
                let points = arc(self.pos, p, rx, ry, rotation.to_radians(), large, sweep);
                self.current.extend(points);
                self.pos = p;
            }
            b'Z' => {
                // `z` takes no numbers, so a number right after it is malformed.
                t.last = None;
                self.finish(true);
                self.pos = self.start;
            }
            _ => return None,
        }
        Some(())
    }

    fn line_to(&mut self, p: Point) {
        self.current.push(p);
        self.pos = p;
    }

    fn finish(&mut self, closed: bool) {
        if self.current.len() > 1 {
            self.lines.push(Polyline {
                points: std::mem::take(&mut self.current),
                closed,
            });
        } else {
            self.current.clear();
        }
    }
}

/// Points of an elliptical arc after `from`, up to and including `to` (SVG endpoint
/// parameterization, converted to center form as in the SVG spec, appendix F.6.5).
fn arc(from: Point, to: Point, rx: f64, ry: f64, phi: f64, large: bool, sweep: bool) -> Vec<Point> {
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if from == to {
        return Vec::new();
    }
    if rx == 0.0 || ry == 0.0 {
        return vec![to];
    }
    let (sin, cos) = phi.sin_cos();
    let (hx, hy) = ((from.0 - to.0) / 2.0, (from.1 - to.1) / 2.0);
    let x1 = cos * hx + sin * hy;
    let y1 = -sin * hx + cos * hy;
    // Radii too small for the distance are scaled up until the arc fits.
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lambda > 1.0 {
        rx *= lambda.sqrt();
        ry *= lambda.sqrt();
    }
    let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let sign = if large == sweep { -1.0 } else { 1.0 };
    let coefficient = sign * (numerator / denominator).max(0.0).sqrt();
    let cx1 = coefficient * rx * y1 / ry;
    let cy1 = -coefficient * ry * x1 / rx;
    let center = (
        cos * cx1 - sin * cy1 + (from.0 + to.0) / 2.0,
        sin * cx1 + cos * cy1 + (from.1 + to.1) / 2.0,
    );
    let start = ((y1 - cy1) / ry).atan2((x1 - cx1) / rx);
    let end = ((-y1 - cy1) / ry).atan2((-x1 - cx1) / rx);
    let mut delta = end - start;
    if sweep && delta < 0.0 {
        delta += std::f64::consts::TAU;
    } else if !sweep && delta > 0.0 {
        delta -= std::f64::consts::TAU;
    }
    let steps = ((delta.abs() / ARC_STEP).ceil() as usize).max(1);
    let mut points: Vec<Point> = (1..steps)
        .map(|step| {
            let theta = start + delta * step as f64 / steps as f64;
            let (s, c) = theta.sin_cos();
            (
                center.0 + rx * c * cos - ry * s * sin,
                center.1 + rx * c * sin + ry * s * cos,
            )
        })
        .collect();
    // The exact end point, so following relative commands start where the path data says.
    points.push(to);
    points
}

struct Tokens<'a> {
    s: &'a [u8],
    i: usize,
    /// The command whose arguments repeat when numbers follow without a new letter.
    last: Option<u8>,
}

impl Tokens<'_> {
    fn skip_separators(&mut self) {
        while self
            .s
            .get(self.i)
            .is_some_and(|c| c.is_ascii_whitespace() || *c == b',')
        {
            self.i += 1;
        }
    }

    fn command(&mut self) -> Option<u8> {
        self.skip_separators();
        let c = *self.s.get(self.i)?;
        if !c.is_ascii_alphabetic() {
            return None;
        }
        self.i += 1;
        self.last = Some(c);
        Some(c)
    }

    fn at_number(&mut self) -> bool {
        self.skip_separators();
        self.s
            .get(self.i)
            .is_some_and(|c| c.is_ascii_digit() || matches!(c, b'-' | b'+' | b'.'))
    }

    /// A number; a sign or a second decimal point starts the next one (`9.591-3.676.56`).
    fn number(&mut self) -> Option<f64> {
        if !self.at_number() {
            return None;
        }
        let start = self.i;
        if matches!(self.s.get(self.i), Some(b'-' | b'+')) {
            self.i += 1;
        }
        let mut dot = false;
        while let Some(&c) = self.s.get(self.i) {
            if c.is_ascii_digit() {
                self.i += 1;
            } else if c == b'.' && !dot {
                dot = true;
                self.i += 1;
            } else {
                break;
            }
        }
        std::str::from_utf8(&self.s[start..self.i]).ok()?.parse().ok()
    }

    /// An arc flag: a single `0` or `1`, possibly without a separator after it.
    fn flag(&mut self) -> Option<bool> {
        self.skip_separators();
        let flag = match self.s.get(self.i)? {
            b'0' => false,
            b'1' => true,
            _ => return None,
        };
        self.i += 1;
        Some(flag)
    }

    fn point(&mut self, base: Point) -> Option<Point> {
        Some((self.number()? + base.0, self.number()? + base.1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Point, b: Point) -> bool {
        (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6
    }

    fn alpha(rgba: &[u8], size: u32, x: u32, y: u32) -> u8 {
        rgba[((y * size + x) * 4 + 3) as usize]
    }

    #[test]
    fn parses_lines_and_closes() {
        let lines = parse_path("M1 2h3v4H1z");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].closed);
        assert_eq!(lines[0].points, vec![(1.0, 2.0), (4.0, 2.0), (4.0, 6.0), (1.0, 6.0)]);
    }

    #[test]
    fn parses_compact_numbers_and_repeated_commands() {
        // `-` and a second `.` start new numbers; numbers without a letter repeat the command.
        let lines = parse_path("M0 0l1-1.5.5 2 1 1");
        assert_eq!(
            lines[0].points,
            vec![(0.0, 0.0), (1.0, -1.5), (1.5, 0.5), (2.5, 1.5)]
        );
        let lines = parse_path("M0 0 1 1V3");
        assert_eq!(lines[0].points, vec![(0.0, 0.0), (1.0, 1.0), (1.0, 3.0)]);
    }

    #[test]
    fn flattens_arcs_on_the_circle() {
        // Half circle from (0, 0) to (10, 0); sweep 1 goes through the top in screen coordinates.
        let lines = parse_path("M0 0A5 5 0 0 1 10 0");
        let points = &lines[0].points;
        assert!(close(*points.last().unwrap(), (10.0, 0.0)));
        for p in points {
            assert!(((p.0 - 5.0).hypot(p.1) - 5.0).abs() < 1e-9);
        }
        assert!(points.iter().any(|p| close(*p, (5.0, -5.0))));
        let lines = parse_path("M0 0A5 5 0 0 0 10 0");
        assert!(lines[0].points.iter().all(|p| p.1 >= -1e-9));
    }

    #[test]
    fn every_path_parses_completely() {
        // The heart ends where it starts; relative arcs and curves land on lucide's coordinates.
        let heart = parse_path(HEART);
        assert_eq!(heart.len(), 1);
        assert!(close(heart[0].points[0], (2.0, 9.5)));
        assert!(close(*heart[0].points.last().unwrap(), (2.0, 9.5)));
        let play = parse_path(PLAY);
        assert!(play[0].closed && close(*play[0].points.last().unwrap(), (5.0, 19.0)));
        let pause = parse_path(PAUSE);
        assert_eq!(pause.len(), 2);
        assert!(close(*pause[1].points.last().unwrap(), (15.0, 3.0)));
        for d in [SKIP_BACK, SKIP_FORWARD] {
            let lines = parse_path(d);
            assert_eq!(lines.len(), 1);
            assert!(lines[0].closed);
        }
        assert_eq!(parse_path(SKIP_BACK_BAR)[0].points, vec![(3.0, 20.0), (3.0, 4.0)]);
        assert_eq!(parse_path(SKIP_FORWARD_BAR)[0].points, vec![(21.0, 4.0), (21.0, 20.0)]);
    }

    #[test]
    fn renders_glyphs_in_the_color_with_transparent_corners() {
        for size in [16, 20, 24, 32, 48] {
            for glyph in Glyph::ALL {
                let rgba = render(glyph, size, LIGHT_GLYPH);
                assert_eq!(rgba.len(), (size * size * 4) as usize);
                assert_eq!(alpha(&rgba, size, 0, 0), 0, "{glyph:?} at {size}");
                assert_eq!(alpha(&rgba, size, size - 1, size - 1), 0, "{glyph:?} at {size}");
                // Even the thin heart outline covers a good part of the icon.
                let pixels = rgba.as_chunks::<4>().0;
                let coverage: f64 = pixels.iter().map(|p| p[3] as f64 / 255.0).sum();
                assert!(coverage > (size * size) as f64 / 20.0, "{glyph:?} at {size}");
                assert!(pixels.iter().filter(|p| p[3] > 0).all(|p| p[..3] == LIGHT_GLYPH));
            }
        }
    }

    #[test]
    fn shapes_match_the_icons() {
        let size = 24;
        let play = render(Glyph::Play, size, DARK_GLYPH);
        assert_eq!(alpha(&play, size, 11, 11), 255);
        assert_eq!(alpha(&play, size, 21, 3), 0);
        let pause = render(Glyph::Pause, size, DARK_GLYPH);
        assert_eq!(alpha(&pause, size, 7, 11), 255);
        assert_eq!(alpha(&pause, size, 11, 11), 0, "gap between the bars");
        assert_eq!(alpha(&pause, size, 16, 11), 255);
        // The heart's middle is empty as an outline and full when filled.
        let outline = render(Glyph::Heart, size, DARK_GLYPH);
        let filled = render(Glyph::HeartFilled, size, DARK_GLYPH);
        assert_eq!(alpha(&outline, size, 11, 12), 0);
        assert_eq!(alpha(&filled, size, 11, 12), 255);
        assert_eq!(alpha(&outline, size, 2, 9), 255, "left edge of the outline");
        // Skip buttons (two pixels per grid unit): bar on the outer side, a gap, the triangle.
        let size = 48;
        let back = render(Glyph::SkipBack, size, DARK_GLYPH);
        assert_eq!(alpha(&back, size, 5, 23), 255);
        assert_eq!(alpha(&back, size, 10, 23), 0);
        assert_eq!(alpha(&back, size, 30, 23), 255);
        let forward = render(Glyph::SkipForward, size, DARK_GLYPH);
        for y in 0..size {
            for x in 0..size {
                let (a, b) = (alpha(&forward, size, x, y), alpha(&back, size, size - 1 - x, y));
                assert!(a.abs_diff(b) <= 1, "skip-forward mirrors skip-back at {x},{y}");
            }
        }
    }
}
