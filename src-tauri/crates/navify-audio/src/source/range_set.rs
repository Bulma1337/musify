//! Sorted set of disjoint, half-open byte ranges (`start..end`) describing which parts of a cache
//! entry are downloaded.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RangeSet {
    /// Sorted, non-overlapping, non-adjacent (merged) `[start, end)` ranges.
    ranges: Vec<(u64, u64)>,
}

impl RangeSet {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.ranges.is_empty()
    }

    pub(crate) fn ranges(&self) -> &[(u64, u64)] {
        &self.ranges
    }

    pub(crate) fn clear(&mut self) {
        self.ranges.clear();
    }

    /// Total number of bytes covered.
    pub(crate) fn covered_bytes(&self) -> u64 {
        self.ranges.iter().map(|(s, e)| e - s).sum()
    }

    /// Adds `[start, end)`, merging with overlapping or adjacent ranges.
    pub(crate) fn insert(&mut self, start: u64, end: u64) {
        if start >= end {
            return;
        }
        // First range whose end >= start (could merge), last range whose start <= end.
        let lo = self.ranges.partition_point(|&(_, e)| e < start);
        let hi = self.ranges.partition_point(|&(s, _)| s <= end);
        if lo >= hi {
            self.ranges.insert(lo, (start, end));
            return;
        }
        let new_start = start.min(self.ranges[lo].0);
        let new_end = end.max(self.ranges[hi - 1].1);
        self.ranges.splice(lo..hi, std::iter::once((new_start, new_end)));
    }

    /// Index of the range containing `pos`, if any.
    fn find(&self, pos: u64) -> Option<usize> {
        let i = self.ranges.partition_point(|&(_, e)| e <= pos);
        (i < self.ranges.len() && self.ranges[i].0 <= pos).then_some(i)
    }

    pub(crate) fn contains(&self, pos: u64) -> bool {
        self.find(pos).is_some()
    }

    /// End of the downloaded run that contains `pos`, or `pos` itself when `pos` is missing.
    pub(crate) fn contiguous_end_from(&self, pos: u64) -> u64 {
        self.find(pos).map_or(pos, |i| self.ranges[i].1)
    }

    /// True when `[start, end)` is fully downloaded.
    pub(crate) fn covers(&self, start: u64, end: u64) -> bool {
        start >= end || self.contiguous_end_from(start) >= end
    }

    /// First missing byte at or after `pos`, bounded by `total` (None = everything up to `total` is
    /// present). With an unknown total there is always a gap.
    pub(crate) fn first_gap_from(&self, pos: u64, total: Option<u64>) -> Option<u64> {
        let gap = self.contiguous_end_from(pos);
        match total {
            Some(t) if gap >= t => None,
            _ => Some(gap),
        }
    }

    /// The missing sub-ranges of `[start, end)`.
    pub(crate) fn missing_within(&self, start: u64, end: u64) -> Vec<(u64, u64)> {
        let mut out = Vec::new();
        let mut cur = start;
        let mut i = self.ranges.partition_point(|&(_, e)| e <= start);
        while cur < end {
            match self.ranges.get(i) {
                Some(&(s, e)) if s < end => {
                    if s > cur {
                        out.push((cur, s));
                    }
                    cur = cur.max(e);
                    i += 1;
                }
                _ => {
                    out.push((cur, end));
                    break;
                }
            }
        }
        out
    }

    /// Drops everything at or beyond `limit`.
    pub(crate) fn truncate(&mut self, limit: u64) {
        self.ranges.retain(|&(s, _)| s < limit);
        if let Some(last) = self.ranges.last_mut() {
            last.1 = last.1.min(limit);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_merges() {
        let mut r = RangeSet::new();
        r.insert(10, 20);
        r.insert(30, 40);
        assert_eq!(r.ranges(), &[(10, 20), (30, 40)]);
        r.insert(20, 30);
        assert_eq!(r.ranges(), &[(10, 40)]);
        r.insert(0, 5);
        r.insert(50, 60);
        r.insert(3, 55);
        assert_eq!(r.ranges(), &[(0, 60)]);
        r.insert(70, 70);
        assert_eq!(r.ranges(), &[(0, 60)]);
        assert_eq!(r.covered_bytes(), 60);
    }

    #[test]
    fn queries() {
        let mut r = RangeSet::new();
        r.insert(0, 100);
        r.insert(200, 300);
        assert!(r.contains(0) && r.contains(99) && !r.contains(100) && r.contains(250));
        assert_eq!(r.contiguous_end_from(50), 100);
        assert_eq!(r.contiguous_end_from(150), 150);
        assert_eq!(r.first_gap_from(0, Some(300)), Some(100));
        assert_eq!(r.first_gap_from(200, Some(300)), None);
        assert_eq!(r.first_gap_from(200, None), Some(300));
        assert!(r.covers(10, 90) && !r.covers(10, 150));
        assert_eq!(r.missing_within(50, 350), vec![(100, 200), (300, 350)]);
        assert_eq!(r.missing_within(0, 100), vec![]);
        assert_eq!(r.missing_within(120, 130), vec![(120, 130)]);
        r.truncate(250);
        assert_eq!(r.ranges(), &[(0, 100), (200, 250)]);
        r.truncate(150);
        assert_eq!(r.ranges(), &[(0, 100)]);
    }

    #[test]
    fn random_against_bitmap() {
        let mut seed = 0x1234_5678_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut r = RangeSet::new();
        let mut bits = vec![false; 500];
        for _ in 0..400 {
            let a = next() % 500;
            let b = (a + next() % 40).min(500);
            r.insert(a, b);
            for x in a..b {
                bits[x as usize] = true;
            }
            for p in 0..500u64 {
                assert_eq!(r.contains(p), bits[p as usize]);
            }
        }
        assert_eq!(r.covered_bytes(), bits.iter().filter(|b| **b).count() as u64);
    }
}
