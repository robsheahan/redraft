#!/usr/bin/env python3
"""Re-render the narrated walkthrough at a higher resolution WITHOUT touching the
audio. Reproduces the exact narrated timing from the already-generated voice
segments in _narr/ (no TTS, no API key), renders the silent video at the target
resolution via build_video, then muxes the existing mixed audio lifted straight
from the deployed demo-screenshots/walkthrough.mp4 (voice + music untouched).

Usage: python3 build_hires.py [4k|3k|1440]   (default 4k)
Output: demo-screenshots/walkthrough-<preset>.mp4
"""
import os, sys, wave, subprocess
import build_video as bv

PRESETS = {            # scale x 1920x1080  ->  canvas      crf
    "4k":   (2.0,                                      21),   # 3840x2160 (screenshots upscaled ~1.37x)
    "3k":   (2800 / 1920,                              19),   # ~2800x1574, native-crisp ceiling
    "1440": (2560 / 1920,                              19),   # 2560x1440, downscaled-crisp
}
preset = sys.argv[1] if len(sys.argv) > 1 else "4k"
scale, crf = PRESETS[preset]

FPS = bv.FPS
F = 12
TMP = "_narr"
AUDIO_SRC = "demo-screenshots/walkthrough.mp4"   # existing mixed audio (voice + music)
OUT = f"demo-screenshots/walkthrough-{preset}.mp4"

# Same segment order + lead/tail as build_narrated.SEGS (timing inputs).
SEGS = [("title", 0.7, 0.8), ("s0", 0.8, 0.8), ("s1", 0.8, 0.8), ("s2", 0.8, 0.8),
        ("s3", 0.8, 0.8), ("s4", 0.8, 0.9), ("end", 0.6, 1.0)]

def wav_dur(p):
    w = wave.open(p, "rb"); d = w.getnframes() / w.getframerate(); w.close()
    return d

# 1) Reproduce the narrated per-segment timing from the existing voice wavs.
seg_dur = [wav_dur(f"{TMP}/{k}.wav") + lead + tail for k, lead, tail in SEGS]
def frames_for(i, d):
    return max(2 * F + 1, round(d * FPS)) if SEGS[i][0] in ("title", "end") else round(d * FPS)
seg_frames = [frames_for(i, seg_dur[i]) for i in range(len(SEGS))]
title_dur = seg_frames[0] / FPS
scene_durs = [seg_frames[i] / FPS for i in range(1, 6)]
end_dur = seg_frames[6] / FPS
total = sum(seg_frames) / FPS

# 2) Render the silent video at the target resolution.
w, h = bv.set_scale(scale)
print(f"[1/2] Rendering {preset} ({w}x{h}, crf {crf}) to narrated timing — total {total:.1f}s …")
silent = f"{TMP}/silent-{preset}.mp4"
bv.render(silent, title_dur=title_dur, scene_durs=scene_durs, end_dur=end_dur, crf=crf)

# 3) Mux the existing mixed audio (untouched) onto the new hi-res video.
print(f"[2/2] Muxing existing audio from {AUDIO_SRC} …")
subprocess.run([
    "ffmpeg", "-loglevel", "error", "-y", "-i", silent, "-i", AUDIO_SRC,
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "copy",
    "-shortest", "-movflags", "+faststart", OUT,
], check=True)
sz = os.path.getsize(OUT) / 1e6
print(f"\nDONE -> {OUT}  ({w}x{h}, {sz:.1f} MB)")
