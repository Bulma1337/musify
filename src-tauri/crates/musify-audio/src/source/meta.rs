//! Cache entry metadata (`<hash>.meta`): a small line-based text file, written atomically via a
//! temporary file + rename. A file without the trailing `end` line (half-written) or with any
//! malformed line is rejected and the entry treated as invalid.
//!
//! ```text
//! musify-cache 1
//! total 4194304          (or "?")
//! seekable 1             (1, 0 or "?")
//! complete 0
//! access 1760000000000   (unix ms)
//! ranges 0-524288 4000000-4194304
//! end
//! ```
//!
//! No URL, host or cache key is ever stored.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use super::range_set::RangeSet;

const MAGIC: &str = "musify-cache 1";

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Meta {
    pub total_len: Option<u64>,
    pub seekable: Option<bool>,
    pub complete: bool,
    pub last_access: u64,
    pub ranges: RangeSet,
}

impl Meta {
    pub(crate) fn serialize(&self) -> String {
        let mut s = String::with_capacity(128);
        s.push_str(MAGIC);
        s.push('\n');
        match self.total_len {
            Some(t) => s.push_str(&format!("total {t}\n")),
            None => s.push_str("total ?\n"),
        }
        s.push_str(match self.seekable {
            Some(true) => "seekable 1\n",
            Some(false) => "seekable 0\n",
            None => "seekable ?\n",
        });
        s.push_str(if self.complete {
            "complete 1\n"
        } else {
            "complete 0\n"
        });
        s.push_str(&format!("access {}\n", self.last_access));
        s.push_str("ranges");
        for (a, b) in self.ranges.ranges() {
            s.push_str(&format!(" {a}-{b}"));
        }
        s.push_str("\nend\n");
        s
    }

    pub(crate) fn parse(text: &str) -> Option<Meta> {
        let mut lines = text.lines();
        if lines.next()? != MAGIC {
            return None;
        }
        let mut meta = Meta::default();
        let total = lines.next()?.strip_prefix("total ")?;
        meta.total_len = if total == "?" {
            None
        } else {
            Some(total.parse().ok()?)
        };
        meta.seekable = match lines.next()?.strip_prefix("seekable ")? {
            "1" => Some(true),
            "0" => Some(false),
            "?" => None,
            _ => return None,
        };
        meta.complete = match lines.next()?.strip_prefix("complete ")? {
            "1" => true,
            "0" => false,
            _ => return None,
        };
        meta.last_access = lines.next()?.strip_prefix("access ")?.parse().ok()?;
        let ranges = lines.next()?.strip_prefix("ranges")?;
        let mut prev_end = 0u64;
        for part in ranges.split_whitespace() {
            let (a, b) = part.split_once('-')?;
            let (a, b): (u64, u64) = (a.parse().ok()?, b.parse().ok()?);
            if a >= b || a < prev_end {
                return None;
            }
            if let Some(t) = meta.total_len
                && b > t
            {
                return None;
            }
            prev_end = b;
            meta.ranges.insert(a, b);
        }
        if lines.next()? != "end" {
            return None;
        }
        if meta.complete {
            let t = meta.total_len?;
            if !meta.ranges.covers(0, t) {
                return None;
            }
        }
        Some(meta)
    }

    pub(crate) fn load(path: &Path) -> Option<Meta> {
        let text = fs::read_to_string(path).ok()?;
        Meta::parse(&text)
    }

    /// Atomic write: `<path>.tmp` then rename over `path`.
    pub(crate) fn store(&self, path: &Path) -> io::Result<()> {
        let tmp = path.with_extension("meta.tmp");
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(self.serialize().as_bytes())?;
            f.sync_data()?;
        }
        fs::rename(&tmp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let mut m = Meta {
            total_len: Some(1000),
            seekable: Some(true),
            complete: false,
            last_access: 42,
            ranges: RangeSet::new(),
        };
        m.ranges.insert(0, 100);
        m.ranges.insert(900, 1000);
        assert_eq!(Meta::parse(&m.serialize()), Some(m.clone()));
        m.total_len = None;
        m.seekable = None;
        assert_eq!(Meta::parse(&m.serialize()), Some(m.clone()));
        let empty = Meta::default();
        assert_eq!(Meta::parse(&empty.serialize()), Some(empty));
    }

    #[test]
    fn rejects_broken() {
        let mut m = Meta {
            total_len: Some(10),
            seekable: Some(true),
            complete: true,
            last_access: 1,
            ranges: RangeSet::new(),
        };
        m.ranges.insert(0, 10);
        let s = m.serialize();
        assert!(Meta::parse(&s).is_some());
        // Half-written: missing "end".
        assert!(Meta::parse(&s[..s.len() - 4]).is_none());
        assert!(Meta::parse("garbage").is_none());
        assert!(Meta::parse("").is_none());
        // Complete without full coverage.
        let bad = s.replace("ranges 0-10", "ranges 0-5");
        assert!(Meta::parse(&bad).is_none());
        // Range beyond total.
        let bad = s
            .replace("ranges 0-10", "ranges 0-20")
            .replace("complete 1", "complete 0");
        assert!(Meta::parse(&bad).is_none());
    }
}
