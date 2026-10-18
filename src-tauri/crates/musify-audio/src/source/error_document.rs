//! Servers that answer a stream request with an error document instead of audio.
//!
//! Subsonic servers (Navidrome included) report errors with HTTP 200 and a JSON or XML body, for
//! example when a track no longer exists on the server ("data not found", code 70). Such a body
//! must never be cached, downloaded or decoded as audio.

use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Longest server message passed on (it ends up in a toast).
const MAX_MESSAGE: usize = 160;

/// True for content types that are documents, never audio.
pub fn is_document_type(content_type: &str) -> bool {
    let media = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(
        media.as_str(),
        "application/json" | "application/xml" | "text/xml" | "text/html"
    )
}

/// True when `head` (the first bytes of a body) is a JSON, XML or HTML document. No audio container
/// starts like this (they start with a magic number such as `fLaC`, `ID3`, `OggS` or an MPEG sync).
pub fn looks_like_document(head: &[u8]) -> bool {
    let head = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
    let start = head
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(head.len());
    let head = &head[start..];
    let starts = |prefix: &[u8]| {
        head.len() >= prefix.len() && head[..prefix.len()].eq_ignore_ascii_case(prefix)
    };
    (head.first() == Some(&b'{')
        && head[1..].iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'"'))
        || starts(b"<?xml")
        || starts(b"<subsonic-response")
        || starts(b"<!doctype html")
        || starts(b"<html")
}

/// True when the file at `path` starts like a document (an error body cached by older versions).
pub fn file_is_document(path: &Path) -> bool {
    let mut head = [0u8; 64];
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => filled += n,
        }
    }
    looks_like_document(&head[..filled])
}

/// The error message of a server's error document: the Subsonic `error` element (JSON or XML),
/// otherwise a generic text. Short, single-line and free of markup.
pub fn server_message(body: &[u8]) -> String {
    let message = json_message(body)
        .or_else(|| xml_message(body))
        .unwrap_or_else(|| "the server sent no audio".to_owned());
    let clean: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let clean = clean.trim();
    match clean.char_indices().nth(MAX_MESSAGE) {
        Some((cut, _)) => format!("{}…", &clean[..cut]),
        None => clean.to_owned(),
    }
}

/// Reads up to 64 KiB of an error body and returns its message.
pub fn read_server_message(body: &mut impl Read) -> String {
    let mut buf = Vec::new();
    let _ = body.take(64 * 1024).read_to_end(&mut buf);
    server_message(&buf)
}

fn json_message(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let error = value
        .get("subsonic-response")
        .and_then(|r| r.get("error"))
        .or_else(|| value.get("error"))?;
    let text = error
        .get("message")
        .and_then(|m| m.as_str())
        .or_else(|| error.as_str())?;
    Some(match error.get("code").and_then(|c| c.as_i64()) {
        Some(code) => format!("{text} (code {code})"),
        None => text.to_owned(),
    })
}

fn xml_message(body: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?;
    let element = &text[text.find("<error")?..];
    let element = &element[..element.find('>').unwrap_or(element.len())];
    let attribute = |name: &str| {
        let start = element.find(&format!("{name}=\""))? + name.len() + 2;
        let len = element[start..].find('"')?;
        Some(unescape(&element[start..start + len]))
    };
    let message = attribute("message")?;
    Some(match attribute("code") {
        Some(code) => format!("{message} (code {code})"),
        None => message,
    })
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAVIDROME_JSON: &[u8] = br#"{"subsonic-response":{"status":"failed","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2","openSubsonic":true,"error":{"code":70,"message":"data not found"}}}"#;
    const SUBSONIC_XML: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="1.16.1"><error code="70" message="Song &quot;x&quot; not found"/></subsonic-response>"#;

    #[test]
    fn document_types() {
        assert!(is_document_type("application/json"));
        assert!(is_document_type("text/xml; charset=utf-8"));
        assert!(is_document_type("Application/XML"));
        assert!(is_document_type("text/html"));
        for audio in [
            "audio/flac",
            "audio/mpeg",
            "application/octet-stream",
            "audio/mp4",
            "",
        ] {
            assert!(!is_document_type(audio), "{audio}");
        }
    }

    #[test]
    fn sniffs_documents_but_never_audio() {
        assert!(looks_like_document(NAVIDROME_JSON));
        assert!(looks_like_document(SUBSONIC_XML));
        assert!(looks_like_document(
            b"\xEF\xBB\xBF  \n<subsonic-response status=\"failed\">"
        ));
        assert!(looks_like_document(b"<!DOCTYPE html><html>"));
        assert!(looks_like_document(b"{ \"error\": \"nope\" }"));
        let audio: [&[u8]; 8] = [
            b"fLaC\0\0\0\x22",
            b"ID3\x04\0\0\0\0",
            b"OggS\0\x02",
            b"RIFF\x24\0\0\0WAVE",
            b"\0\0\0\x20ftypM4A ",
            b"\xFF\xFB\x90\x64",
            b"\x1A\x45\xDF\xA3",
            b"FORM\0\0\0\0AIFF",
        ];
        for head in audio {
            assert!(!looks_like_document(head), "{head:?}");
        }
        assert!(!looks_like_document(b""));
        assert!(!looks_like_document(b"{\x01\x02"));
    }

    #[test]
    fn subsonic_messages() {
        assert_eq!(server_message(NAVIDROME_JSON), "data not found (code 70)");
        assert_eq!(
            server_message(SUBSONIC_XML),
            "Song \"x\" not found (code 70)"
        );
        assert_eq!(
            server_message(br#"{"error":"Item not found"}"#),
            "Item not found"
        );
        assert_eq!(
            server_message(b"<html>Bad Gateway</html>"),
            "the server sent no audio"
        );
        let long = format!(r#"{{"error":"{}\nend"}}"#, "x".repeat(400));
        let message = server_message(long.as_bytes());
        assert_eq!(message.chars().count(), MAX_MESSAGE + 1);
        assert!(!message.contains('\n'));
    }
}
