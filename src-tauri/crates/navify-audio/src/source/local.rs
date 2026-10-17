//! Plain file sources: local files and fully cached entries (no network, local-file speed).

use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use super::ByteSource;

const BUF_SIZE: usize = 64 * 1024;

/// A buffered, seekable file. `_guard` keeps whatever must outlive the reader alive (for cache
/// entries: the open-entry reference that protects the file from eviction).
pub(crate) struct FileSource {
    reader: BufReader<File>,
    len: u64,
    _guard: Option<Box<dyn Send + Sync>>,
}

impl FileSource {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        Ok(Self {
            reader: BufReader::with_capacity(BUF_SIZE, file),
            len,
            _guard: None,
        })
    }

    pub(crate) fn with_guard(mut self, guard: Box<dyn Send + Sync>) -> Self {
        self._guard = Some(guard);
        self
    }
}

impl Read for FileSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.reader.read(buf)
    }
}

impl Seek for FileSource {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        // BufReader::seek discards the buffer; seek_relative keeps it for short hops.
        if let SeekFrom::Current(off) = pos {
            self.reader.seek_relative(off)?;
            return self.reader.stream_position();
        }
        self.reader.seek(pos)
    }
}

impl ByteSource for FileSource {
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }

    fn is_seekable(&self) -> bool {
        true
    }
}
