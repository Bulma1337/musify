//! HTTP client construction (reqwest blocking + rustls/ring), URL helpers and redaction.

use std::sync::Arc;
use std::time::Duration;

use reqwest::blocking::Client;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};

use super::SourceError;
use crate::api::{TimeOffsetParam, TimeOffsetUnit};

pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Applies to waiting for response headers and to every single body read (reqwest blocking).
pub(crate) const READ_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const USER_AGENT: &str = concat!("Navify/", env!("CARGO_PKG_VERSION"));

fn ring_provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Builds the blocking HTTP client used by download threads.
///
/// TLS is rustls with the *ring* provider (passed explicitly, no process-wide default needed).
/// Normal clients verify certificates with the platform verifier (OS trust store); `insecure`
/// clients accept any certificate (self-hosted servers with self-signed certificates).
///
/// Must not be called from inside an async runtime (reqwest blocking restriction).
pub fn build_http_client(insecure: bool) -> Result<Client, SourceError> {
    let provider = ring_provider();
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| SourceError::Network(format!("TLS setup failed: {e}")))?;
    let mut tls = if insecure {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCert { provider }))
            .with_no_client_auth()
    } else {
        let verifier = rustls_platform_verifier::Verifier::new(provider)
            .map_err(|e| SourceError::Network(format!("TLS verifier setup failed: {e}")))?;
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth()
    };
    tls.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    Client::builder()
        .tls_backend_preconfigured(tls)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(READ_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| SourceError::Network(format!("HTTP client setup failed: {}", e.without_url())))
}

/// Accepts every server certificate but still checks handshake signatures (so the connection is
/// at least bound to the presented key). Only used for `allow_insecure_tls` locations.
#[derive(Debug)]
struct AcceptAnyCert {
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// `sha256(cache_key)` as lowercase hex: the only name used on disk.
pub(crate) fn hash_key(cache_key: &str) -> String {
    let digest = Sha256::digest(cache_key.as_bytes());
    let mut s = String::with_capacity(64);
    for b in digest.iter() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Value of the time-offset query parameter for `start_ms`, and the position (ms) the stream will
/// actually start at (seconds are truncated).
pub fn time_offset_value(unit: TimeOffsetUnit, start_ms: u64) -> (u64, u64) {
    match unit {
        TimeOffsetUnit::Seconds => (start_ms / 1000, (start_ms / 1000) * 1000),
        TimeOffsetUnit::Ticks => (start_ms.saturating_mul(10_000), start_ms),
    }
}

/// Returns `url` with the time-offset parameter set (appended, or replaced when already present),
/// plus the effective start position in ms. `None` when the URL cannot be parsed.
pub fn url_with_time_offset(
    url: &str,
    param: &TimeOffsetParam,
    start_ms: u64,
) -> Option<(String, u64)> {
    let (value, effective_ms) = time_offset_value(param.unit, start_ms);
    let mut parsed = reqwest::Url::parse(url).ok()?;
    let value = value.to_string();
    let present = parsed.query_pairs().any(|(k, _)| k == param.param.as_str());
    if present {
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(k, v)| {
                if k == param.param.as_str() {
                    (k.into_owned(), value.clone())
                } else {
                    (k.into_owned(), v.into_owned())
                }
            })
            .collect();
        parsed.query_pairs_mut().clear().extend_pairs(pairs);
    } else {
        parsed.query_pairs_mut().append_pair(&param.param, &value);
    }
    Some((parsed.into(), effective_ms))
}

/// Removes every trace of `url` (full URL, query string, userinfo) from an error message.
pub fn redact(message: &str, url: &str) -> String {
    let mut out = message.replace(url, "<url>");
    if let Ok(parsed) = reqwest::Url::parse(url) {
        let without_fragment = {
            let mut p = parsed.clone();
            p.set_fragment(None);
            String::from(p)
        };
        out = out.replace(&without_fragment, "<url>");
        out = out.replace(parsed.as_str(), "<url>");
        if let Some(q) = parsed.query()
            && !q.is_empty()
        {
            out = out.replace(q, "<redacted>");
        }
        // Individual query values (tokens, salts, api keys) in case only parts of the URL leak.
        for (_, v) in parsed.query_pairs() {
            if v.len() >= 3 {
                out = out.replace(v.as_ref(), "<redacted>");
            }
        }
        if !parsed.username().is_empty() {
            out = out.replace(parsed.username(), "<redacted>");
        }
        if let Some(pw) = parsed.password()
            && !pw.is_empty()
        {
            out = out.replace(pw, "<redacted>");
        }
    }
    out
}

/// Describes a reqwest error without its URL (and with all sources), redacted.
pub fn describe_reqwest(err: reqwest::Error, url: &str) -> String {
    let err = err.without_url();
    let mut s = err.to_string();
    let mut src = std::error::Error::source(&err);
    while let Some(e) = src {
        s.push_str(": ");
        s.push_str(&e.to_string());
        src = e.source();
    }
    redact(&s, url)
}

/// Describes an I/O error (possibly wrapping a reqwest error), redacted.
pub fn describe_io(err: &std::io::Error, url: &str) -> String {
    let mut s = err.to_string();
    let mut src = std::error::Error::source(err);
    while let Some(e) = src {
        s.push_str(": ");
        s.push_str(&e.to_string());
        src = e.source();
    }
    redact(&s, url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_hex_sha256() {
        let h = hash_key("abc");
        assert_eq!(
            h,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn redaction() {
        let url = "https://user:pw@music.example.com/rest/stream?id=1&t=secret&s=salt";
        let msg = format!("failed for {url}: t=secret&s=salt");
        let r = redact(&msg, url);
        assert!(
            !r.contains("secret") && !r.contains("pw") && !r.contains("salt"),
            "{r}"
        );
    }

    #[test]
    fn offset_urls() {
        let p = TimeOffsetParam {
            param: "timeOffset".into(),
            unit: TimeOffsetUnit::Seconds,
        };
        let (u, ms) = url_with_time_offset("http://h/rest/stream?id=1&u=a", &p, 65_500).unwrap();
        assert_eq!(u, "http://h/rest/stream?id=1&u=a&timeOffset=65");
        assert_eq!(ms, 65_000);
        let (u, _) =
            url_with_time_offset("http://h/rest/stream?timeOffset=3&id=1", &p, 10_000).unwrap();
        assert_eq!(u, "http://h/rest/stream?timeOffset=10&id=1");
        let p = TimeOffsetParam {
            param: "StartTimeTicks".into(),
            unit: TimeOffsetUnit::Ticks,
        };
        let (u, ms) = url_with_time_offset("http://h/Audio/x/universal", &p, 1_234).unwrap();
        assert_eq!(u, "http://h/Audio/x/universal?StartTimeTicks=12340000");
        assert_eq!(ms, 1_234);
    }
}
