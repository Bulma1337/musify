# Regenerates the decode test fixtures (requires ffmpeg >= 6 on PATH).
#
#   pwsh -File generate.ps1
#
# Everything is synthetic (aevalsrc), deterministic and short, so the committed set stays small.
# The gapless sets split one continuous signal at a sample position that is not a multiple of any
# codec frame size (1152 / 1024 / 960 / 576 / 4096), then encode each part separately.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function ff {
    & ffmpeg -hide_banner -loglevel error -y @args
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed: $args" }
}

# ---------------------------------------------------------------------------------------------
# Gapless source, 44.1 kHz stereo 16-bit, 1.5 s = 66150 frames, split at 29399.
# L: 440 Hz tone + linear chirp 200 Hz -> 4700 Hz, R: 660 Hz + 1234 Hz.
# ---------------------------------------------------------------------------------------------
$sig44 = "aevalsrc='0.3*sin(2*PI*440*t)+0.2*sin(2*PI*(200+1500*t)*t)|0.3*sin(2*PI*660*t)+0.15*sin(2*PI*1234*t)':s=44100:d=1.5"
ff -f lavfi -i $sig44 -acodec pcm_s16le gapless_src.wav

$split44 = 29399
ff -i gapless_src.wav -af "atrim=end_sample=$split44" -acodec pcm_s16le _p1.wav
ff -i gapless_src.wav -af "atrim=start_sample=$split44,asetpts=N/SR/TB" -acodec pcm_s16le _p2.wav

# Opus only supports 48 kHz natively: separate 48 kHz source, 72000 frames, split at 31999.
$sig48 = $sig44 -replace "s=44100", "s=48000"
ff -f lavfi -i $sig48 -acodec pcm_s16le _src48.wav
$split48 = 31999
ff -i _src48.wav -af "atrim=end_sample=$split48" -acodec pcm_s16le _p1_48.wav
ff -i _src48.wav -af "atrim=start_sample=$split48,asetpts=N/SR/TB" -acodec pcm_s16le _p2_48.wav

$rg = @(
    "-metadata", "REPLAYGAIN_TRACK_GAIN=-6.50 dB",
    "-metadata", "REPLAYGAIN_TRACK_PEAK=0.501",
    "-metadata", "REPLAYGAIN_ALBUM_GAIN=-7.25 dB",
    "-metadata", "REPLAYGAIN_ALBUM_PEAK=0.602"
)

foreach ($part in @(@("gapless_src.wav", "full"), @("_p1.wav", "p1"), @("_p2.wav", "p2"))) {
    $in = $part[0]; $name = $part[1]
    ff -i $in -acodec flac @rg "gapless_$name.flac"
    ff -i $in -acodec alac "gapless_$name.alac.m4a"
    ff -i $in -acodec libmp3lame -ab 128k @rg "gapless_$name.mp3"
    ff -i $in -acodec aac -ab 128k "gapless_$name.aac.m4a"
    ff -i $in -acodec libvorbis -aq 4 "gapless_$name.ogg"
}
foreach ($part in @(@("_src48.wav", "full"), @("_p1_48.wav", "p1"), @("_p2_48.wav", "p2"))) {
    $in = $part[0]; $name = $part[1]
    # R128_TRACK_GAIN -2560 = -10 dB re -23 LUFS = -5 dB ReplayGain; album 256 = +6 dB ReplayGain.
    ff -i $in -acodec libopus -ab 96k -metadata R128_TRACK_GAIN=-2560 -metadata R128_ALBUM_GAIN=256 "gapless_$name.opus"
}

# ---------------------------------------------------------------------------------------------
# Format fixtures
# ---------------------------------------------------------------------------------------------
# 24-bit / 96 kHz FLAC, 0.5 s.
ff -f lavfi -i "aevalsrc='0.5*sin(2*PI*1000*t)|0.25*sin(2*PI*3000*t)':s=96000:d=0.5" -acodec flac -sample_fmt s32 -bits_per_raw_sample 24 flac24_96k.flac
# 24-bit WAV, 48 kHz, 0.5 s.
ff -f lavfi -i "aevalsrc='0.5*sin(2*PI*1000*t)|-0.5*sin(2*PI*1000*t)':s=48000:d=0.5" -acodec pcm_s24le wav24_48k.wav
# Mono FLAC, 44.1 kHz, 0.5 s.
ff -f lavfi -i "aevalsrc='0.5*sin(2*PI*500*t)':s=44100:d=0.5" -acodec flac mono.flac
# 5.1 FLAC, 48 kHz, 0.5 s: FL 300 Hz, FR 500 Hz, FC 700 Hz, LFE 60 Hz, BL 1100 Hz, BR 1300 Hz.
ff -f lavfi -i "aevalsrc='0.5*sin(2*PI*300*t)|0.5*sin(2*PI*500*t)|0.5*sin(2*PI*700*t)|0.5*sin(2*PI*60*t)|0.5*sin(2*PI*1100*t)|0.5*sin(2*PI*1300*t)':s=48000:d=0.5:c=5.1" -acodec flac surround51.flac

# ---------------------------------------------------------------------------------------------
# Broken input
# ---------------------------------------------------------------------------------------------
# Truncated FLAC: first 55 % of the file (cut in the middle of a frame).
$bytes = [System.IO.File]::ReadAllBytes("$PSScriptRoot\gapless_full.flac")
[System.IO.File]::WriteAllBytes("$PSScriptRoot\truncated.flac", $bytes[0..([int]($bytes.Length * 0.55))])
# MP3 with a 600-byte run of garbage in the middle (isolated corrupt frames).
$bytes = [System.IO.File]::ReadAllBytes("$PSScriptRoot\gapless_full.mp3")
$rng = [System.Random]::new(1234)
$mid = [int]($bytes.Length / 2)
for ($i = 0; $i -lt 600; $i++) { $bytes[$mid + $i] = [byte]$rng.Next(0, 256) }
[System.IO.File]::WriteAllBytes("$PSScriptRoot\corrupt.mp3", $bytes)
# Pure garbage with an .mp3 extension.
$garbage = New-Object byte[] 4096
$rng.NextBytes($garbage)
[System.IO.File]::WriteAllBytes("$PSScriptRoot\garbage.mp3", $garbage)

Remove-Item _*.wav
Get-ChildItem | Where-Object { $_.Name -ne "generate.ps1" } | Measure-Object -Property Length -Sum |
    ForEach-Object { "fixtures: {0} files, {1:N0} bytes" -f $_.Count, $_.Sum }
