//! Adapter from the engine's [`ByteSource`] to symphonia's `MediaSource`.

use std::io::{self, Read, Seek, SeekFrom};

use symphonia::core::io::MediaSource;

use crate::source::ByteSource;

pub(crate) struct ByteSourceMedia {
    inner: Box<dyn ByteSource>,
    seekable: bool,
    len: Option<u64>,
}

impl ByteSourceMedia {
    pub(crate) fn new(inner: Box<dyn ByteSource>) -> Self {
        // Both queries may be expensive (see `MediaSource`); symphonia calls them repeatedly.
        let seekable = inner.is_seekable();
        let len = inner.byte_len();
        Self {
            inner,
            seekable,
            len,
        }
    }
}

impl Read for ByteSourceMedia {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Seek for ByteSourceMedia {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl MediaSource for ByteSourceMedia {
    fn is_seekable(&self) -> bool {
        self.seekable
    }

    fn byte_len(&self) -> Option<u64> {
        self.len
    }
}
