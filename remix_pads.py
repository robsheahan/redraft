#!/usr/bin/env python3
"""Swap the walkthrough's music to the new synth pads WITHOUT re-rendering video
or regenerating narration. Regenerates the pad track to length, ducks it under
the existing assembled voice track (_narr/voice.wav), and muxes onto the already
-rendered silent 4K video. Also writes a short standalone pad preview.

Usage: python3 remix_pads.py [SILENT_VIDEO] [OUT]
"""
import sys, subprocess
import build_music as bm

SILENT = sys.argv[1] if len(sys.argv) > 1 else "_narr/silent-4k.mp4"
OUT = sys.argv[2] if len(sys.argv) > 2 else "demo-screenshots/walkthrough-4k.mp4"
VOICE = "_narr/voice.wav"
MUSIC = "_narr/music-pads.wav"
PREVIEW = "_narr/pads-preview.mp3"

def dur(p):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", p], capture_output=True, text=True).stdout.strip()
    return float(out)

total = dur(SILENT)
print(f"video {total:.2f}s — generating pads…")
bm.generate(total, MUSIC)

# Same mix chain as build_narrated: music faded + ducked under voice, then limited.
fout = max(0.0, total - 2.3)
af = (
    f"[1:a]afade=t=in:st=0:d=1.2,afade=t=out:st={fout:.2f}:d=2.3,volume=0.55[m];"
    f"[2:a]volume=1.7,asplit=2[v1][v2];"
    f"[m][v1]sidechaincompress=threshold=0.03:ratio=9:attack=20:release=330:makeup=1.4[md];"
    f"[md][v2]amix=inputs=2:normalize=0:dropout_transition=0[mix];"
    f"[mix]alimiter=limit=0.97[a]"
)
print(f"muxing pads + voice onto {SILENT} -> {OUT}")
subprocess.run([
    "ffmpeg", "-loglevel", "error", "-y", "-i", SILENT, "-i", MUSIC, "-i", VOICE,
    "-filter_complex", af, "-map", "0:v:0", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart", OUT,
], check=True)

# Standalone 24s pad-only preview (music as-generated, no ducking) to audition.
subprocess.run([
    "ffmpeg", "-loglevel", "error", "-y", "-t", "24", "-i", MUSIC,
    "-c:a", "libmp3lame", "-b:a", "192k", PREVIEW,
], check=True)
print(f"DONE -> {OUT}\n     -> {PREVIEW} (pad-only audition)")
