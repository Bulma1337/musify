//! Codec registry and format probe: every symphonia codec enabled in `Cargo.toml`, plus libopus for
//! Opus (Ogg Opus and Opus in Matroska/WebM) behind the `opus` feature.

use std::sync::LazyLock;

use symphonia::core::codecs::registry::CodecRegistry;
use symphonia::core::formats::probe::Probe;

static CODECS: LazyLock<CodecRegistry> = LazyLock::new(|| {
    let mut registry = CodecRegistry::new();
    symphonia::default::register_enabled_codecs(&mut registry);
    #[cfg(feature = "opus")]
    registry.register_audio_decoder::<symphonia_adapter_libopus::OpusDecoder>();
    registry
});

pub(crate) fn codecs() -> &'static CodecRegistry {
    &CODECS
}

/// All enabled container formats and tag readers (ID3v2 / APEv2 in front of or behind the stream).
pub(crate) fn probe() -> &'static Probe {
    symphonia::default::get_probe()
}

/// Whether Opus can be decoded in this build.
pub fn opus_supported() -> bool {
    cfg!(feature = "opus")
}
