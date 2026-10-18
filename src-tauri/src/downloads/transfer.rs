//! Downloads one file over HTTP into a `.part` file, resuming with `Range` when possible.
//!
//! The request URL and headers carry credentials: they are only held in memory and never logged;
//! every error message goes through the redaction helpers of `musify-audio`.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use musify_audio::source::{
    BlockingClient, BlockingResponse, describe_io, describe_reqwest, is_document_type,
    looks_like_document, read_server_message, server_message,
};
use serde::Deserialize;

/// Where to fetch a file. Kept in memory only.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub allow_insecure_tls: bool,
}

// Never print the URL or header values.
impl std::fmt::Debug for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Source")
            .field("url", &"<redacted>")
            .field("headers", &self.headers.len())
            .field("allow_insecure_tls", &self.allow_insecure_tls)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum TransferError {
    Cancelled,
    /// The server answered with an error status.
    Http(u16),
    /// The server sent an error document instead of the file (e.g. the track is gone).
    Server(String),
    Network(String),
    Io(String),
    /// The connection ended before all announced bytes arrived.
    Incomplete,
}

impl TransferError {
    /// Whether trying again can help. Client errors (bad credentials, missing file) will not.
    pub fn retryable(&self) -> bool {
        match self {
            TransferError::Cancelled => false,
            TransferError::Http(code) => *code >= 500 || matches!(*code, 408 | 425 | 429),
            TransferError::Network(_) | TransferError::Incomplete => true,
            TransferError::Server(_) | TransferError::Io(_) => false,
        }
    }

    pub fn message(&self) -> String {
        match self {
            TransferError::Cancelled => "cancelled".into(),
            TransferError::Http(code) => format!("HTTP status {code}"),
            TransferError::Server(m) | TransferError::Network(m) | TransferError::Io(m) => {
                m.clone()
            }
            TransferError::Incomplete => "connection closed before the file was complete".into(),
        }
    }
}

/// What the server told us about the finished file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Fetched {
    pub bytes: u64,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
}

const CHUNK: usize = 64 * 1024;

fn header(resp: &BlockingResponse, name: &str) -> Option<String> {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

/// `bytes <start>-<end>/<total>` → (start, total).
fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let total = total.trim().parse::<u64>().ok();
    if range.trim() == "*" {
        return Some((u64::MAX, total));
    }
    let (start, _end) = range.split_once('-')?;
    Some((start.trim().parse().ok()?, total))
}

/// Downloads `source` into `part`. A non-empty `part` is continued when the server honors `Range`;
/// a plain `200` answer restarts the file. `progress(done, total)` is called as data arrives.
///
/// Returns when every announced byte is on disk. The caller moves the file into place.
pub fn fetch_to_part(
    client: &BlockingClient,
    source: &Source,
    part: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, Option<u64>),
) -> Result<Fetched, TransferError> {
    let existing = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let url = source.url.as_str();

    let mut request = client.get(url);
    for (name, value) in &source.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    if existing > 0 {
        request = request.header("Range", format!("bytes={existing}-"));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(TransferError::Cancelled);
    }
    let response = request
        .send()
        .map_err(|e| TransferError::Network(describe_reqwest(e, url)))?;

    let status = response.status().as_u16();
    let content_type = header(&response, "content-type");
    let content_disposition = header(&response, "content-disposition");
    let content_range = header(&response, "content-range").and_then(|v| parse_content_range(&v));
    // Subsonic servers report errors (e.g. a track that is gone) with 200 and a JSON/XML body.
    if matches!(status, 200 | 206) && content_type.as_deref().is_some_and(is_document_type) {
        let mut response = response;
        return Err(TransferError::Server(read_server_message(&mut response)));
    }

    // Where the body starts in the final file, and the final size if announced.
    let (offset, total) = match status {
        206 => match content_range {
            Some((start, total)) if start == existing => (
                existing,
                total.or(response.content_length().map(|l| l + existing)),
            ),
            // A range we did not ask for: start over.
            _ => {
                let _ = fs::remove_file(part);
                return Err(TransferError::Incomplete);
            }
        },
        200 => (0, response.content_length()),
        416 => {
            // The server says our range starts at or beyond the end. If that is exactly the end, the
            // file was complete already; otherwise the partial file is junk.
            if let Some((_, Some(total))) = content_range
                && total == existing
            {
                progress(existing, Some(total));
                return Ok(Fetched {
                    bytes: existing,
                    content_type,
                    content_disposition,
                });
            }
            let _ = fs::remove_file(part);
            return Err(TransferError::Incomplete);
        }
        code => return Err(TransferError::Http(code)),
    };

    let mut file = if offset > 0 {
        OpenOptions::new().append(true).open(part)
    } else {
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(part)
    }
    .map_err(|e| TransferError::Io(format!("cannot write the download: {e}")))?;

    let mut response = response;
    let mut done = offset;
    let mut buf = vec![0u8; CHUNK];
    progress(done, total);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(TransferError::Cancelled);
        }
        let n = match response.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(TransferError::Network(describe_io(&e, url))),
        };
        if done == 0 && looks_like_document(&buf[..n]) {
            // An error document sent as audio: never keep it as the file.
            drop(file);
            let _ = fs::remove_file(part);
            return Err(TransferError::Server(server_message(&buf[..n])));
        }
        file.write_all(&buf[..n])
            .map_err(|e| TransferError::Io(format!("cannot write the download: {e}")))?;
        done += n as u64;
        progress(done, total);
    }
    file.flush()
        .map_err(|e| TransferError::Io(format!("cannot write the download: {e}")))?;
    drop(file);

    if let Some(total) = total
        && done != total
    {
        return Err(TransferError::Incomplete);
    }
    Ok(Fetched {
        bytes: done,
        content_type,
        content_disposition,
    })
}

/// Downloads a small file (cover image) into memory, at most `limit` bytes.
pub fn fetch_small(
    client: &BlockingClient,
    source: &Source,
    limit: u64,
) -> Result<(Vec<u8>, Option<String>), TransferError> {
    let url = source.url.as_str();
    let mut request = client.get(url);
    for (name, value) in &source.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let response = request
        .send()
        .map_err(|e| TransferError::Network(describe_reqwest(e, url)))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(TransferError::Http(status));
    }
    let content_type = header(&response, "content-type");
    let mut body = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut body)
        .map_err(|e| TransferError::Network(describe_io(&e, url)))?;
    if body.len() as u64 > limit {
        return Err(TransferError::Io("image too large".into()));
    }
    Ok((body, content_type))
}

/// File extension for a response: `hint` (container the frontend knows) first, then the
/// `Content-Disposition` file name, then the MIME type.
pub fn extension_for(hint: Option<&str>, fetched: &Fetched) -> Option<String> {
    let usable = |e: &str| {
        let e = e.trim().trim_start_matches('.').to_lowercase();
        (!e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric())).then_some(e)
    };
    if let Some(ext) = hint.and_then(usable) {
        return Some(match ext.as_str() {
            "aac" | "mp4" | "alac" => "m4a".to_string(),
            "oga" => "ogg".to_string(),
            other => other.to_string(),
        });
    }
    if let Some(disposition) = &fetched.content_disposition
        && let Some(name) = disposition
            .split(';')
            .filter_map(|p| p.trim().strip_prefix("filename="))
            .next()
        && let Some((_, ext)) = name.trim_matches('"').rsplit_once('.')
        && let Some(ext) = usable(ext)
    {
        return Some(ext);
    }
    let mime = fetched
        .content_type
        .as_deref()?
        .split(';')
        .next()?
        .trim()
        .to_lowercase();
    let ext = match mime.as_str() {
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" | "application/ogg" => "ogg",
        "audio/opus" => "opus",
        "audio/mp4" | "audio/x-m4a" | "audio/aac" | "audio/m4a" => "m4a",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/aiff" | "audio/x-aiff" => "aiff",
        "audio/webm" => "webm",
        _ => return None,
    };
    Some(ext.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_parsing() {
        assert_eq!(
            parse_content_range("bytes 100-199/200"),
            Some((100, Some(200)))
        );
        assert_eq!(parse_content_range("bytes 0-9/*"), Some((0, None)));
        assert_eq!(
            parse_content_range("bytes */200"),
            Some((u64::MAX, Some(200)))
        );
        assert_eq!(parse_content_range("items 1-2/3"), None);
    }

    #[test]
    fn retry_policy_by_error() {
        assert!(TransferError::Http(503).retryable());
        assert!(TransferError::Http(429).retryable());
        assert!(!TransferError::Http(404).retryable());
        assert!(!TransferError::Http(401).retryable());
        assert!(TransferError::Network("x".into()).retryable());
        assert!(TransferError::Incomplete.retryable());
        assert!(!TransferError::Cancelled.retryable());
        assert!(!TransferError::Io("disk full".into()).retryable());
    }

    #[test]
    fn extension_prefers_the_hint() {
        let fetched = Fetched {
            content_type: Some("audio/mpeg".into()),
            ..Default::default()
        };
        assert_eq!(
            extension_for(Some("FLAC"), &fetched).as_deref(),
            Some("flac")
        );
        assert_eq!(extension_for(Some("aac"), &fetched).as_deref(), Some("m4a"));
        assert_eq!(extension_for(None, &fetched).as_deref(), Some("mp3"));
        assert_eq!(
            extension_for(Some("../x"), &fetched).as_deref(),
            Some("mp3")
        );
        let named = Fetched {
            content_disposition: Some("attachment; filename=\"a b.OPUS\"".into()),
            ..Default::default()
        };
        assert_eq!(extension_for(None, &named).as_deref(), Some("opus"));
        assert_eq!(extension_for(None, &Fetched::default()), None);
    }

    #[test]
    fn source_debug_hides_the_url() {
        let source = Source {
            url: "https://h/rest/stream?t=secret".into(),
            headers: vec![("Authorization".into(), "MediaBrowser Token=secret".into())],
            allow_insecure_tls: false,
        };
        let text = format!("{source:?}");
        assert!(
            !text.contains("secret") && !text.contains("https"),
            "{text}"
        );
    }
}
