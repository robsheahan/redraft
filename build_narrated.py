#!/usr/bin/env python3
"""Build the narrated walkthrough: macOS `say` TTS per segment, video timed to
fit each line, music regenerated to match, mixed with the music ducking under
the voice. Output demo-screenshots/proofready-walkthrough-narrated.mp4 .
Usage: python3 build_narrated.py [VOICE]   (default voice: Karen, en_AU)
"""
import os, sys, subprocess, wave, json
import numpy as np
import build_video as bv
import build_music as bm

VOICE = sys.argv[1] if len(sys.argv) > 1 else "Karen"
RATE = 172
SR = 44100
# ElevenLabs backend (preferred when ELEVEN_API_KEY is set). Key comes from the
# environment only — never hardcode or persist it. Voice id via ELEVEN_VOICE_ID.
ELEVEN_KEY = os.environ.get("ELEVEN_API_KEY")
ELEVEN_VOICE_ID = os.environ.get("ELEVEN_VOICE_ID", "IKne3meq5aSn9XLyUdCD")  # Charlie (AU)
USE_ELEVEN = bool(ELEVEN_KEY)

def tts(text, wav):
    if USE_ELEVEN:
        mp3 = wav[:-4] + ".mp3"
        body = json.dumps({"text": text, "model_id": "eleven_multilingual_v2",
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.8, "style": 0.0, "use_speaker_boost": True}})
        subprocess.run(["curl", "-s", "-X", "POST",
            f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVEN_VOICE_ID}?output_format=mp3_44100_128",
            "-H", f"xi-api-key: {ELEVEN_KEY}", "-H", "Content-Type: application/json",
            "-d", body, "-o", mp3], check=True)
        with open(mp3, "rb") as fh:
            if fh.read(1) == b"{":
                raise SystemExit("ElevenLabs error: " + open(mp3).read()[:400])
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", mp3, "-ar", str(SR), "-ac", "2", wav], check=True)
    else:
        aiff = wav[:-4] + ".aiff"
        subprocess.run(["say", "-v", VOICE, "-r", str(RATE), "-o", aiff, text], check=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", aiff, "-ar", str(SR), "-ac", "2", wav], check=True)
FPS = bv.FPS
F = 12
TMP = "_narr"
os.makedirs(TMP, exist_ok=True)

# (key, lead-in s, tail s, TTS text). Order: title, 5 scenes, end.
SEGS = [
    ("title", 0.7, 0.8,
     "ProofReady gives every student draft the kind of feedback an experienced teacher would write, and turns it into insight for the whole school."),
    ("s0", 0.8, 0.8,
     "Students submit a draft and get feedback in a marker's voice. What they've done well, a check on the key verb, and the one priority to work on next. No marks, no bands."),
    ("s1", 0.8, 0.8,
     "Every point is marked up against their own words, just like a teacher's pen. Strengths, evidence, depth, and task alignment, line by line."),
    ("s2", 0.8, 0.8,
     "It works for mathematics too, checking typed working step by step, and pointing to the exact line where the reasoning breaks down."),
    ("s3", 0.8, 0.8,
     "For the teacher, it adds up to whole class insight. The mark spread, the common gaps worth a lesson, and the strengths to build on."),
    ("s4", 0.8, 0.9,
     "And because every submission feeds a longitudinal profile, you build a picture of each student that compounds over time, and follows them to their next teacher."),
    ("end", 0.6, 1.0,
     "ProofReady. Smarter feedback, better insights."),
]

def read_wav(p):
    w = wave.open(p, 'rb'); n = w.getnframes(); ch = w.getnchannels()
    data = w.readframes(n); w.close()
    a = np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768.0
    return a.reshape(-1, ch) if ch == 2 else np.stack([a, a], axis=1)

# 1) Generate narration audio + measure durations.
print(f"[1/5] TTS narration ({'ElevenLabs '+ELEVEN_VOICE_ID if USE_ELEVEN else 'say '+VOICE})…")
seg_audio, seg_vdur = [], []
for key, lead, tail, text in SEGS:
    wav = f"{TMP}/{key}.wav"
    tts(text, wav)
    a = read_wav(wav)
    seg_audio.append(a); seg_vdur.append(len(a) / SR)

# 2) Segment video durations (fit voice + lead + tail), frame-rounded to match render.
seg_dur = [seg_vdur[i] + SEGS[i][1] + SEGS[i][2] for i in range(len(SEGS))]
def frames_for(i, d):
    return max(2 * F + 1, round(d * FPS)) if SEGS[i][0] in ("title", "end") else round(d * FPS)
seg_frames = [frames_for(i, seg_dur[i]) for i in range(len(SEGS))]
seg_start = []
acc = 0
for fr in seg_frames:
    seg_start.append(acc / FPS); acc += fr
total_sec = acc / FPS
title_dur = seg_frames[0] / FPS
scene_durs = [seg_frames[i] / FPS for i in range(1, 6)]
end_dur = seg_frames[6] / FPS
print(f"      total {total_sec:.1f}s  scenes={[round(x,1) for x in scene_durs]}")

# 3) Build full-length voice track (place each line at its segment start + lead).
print("[2/5] Assembling voice track…")
NV = int(total_sec * SR) + SR
VL = np.zeros(NV); VR = np.zeros(NV)
for i, (key, lead, tail, text) in enumerate(SEGS):
    a = seg_audio[i]; off = int((seg_start[i] + lead) * SR)
    j = min(off + len(a), NV)
    VL[off:j] += a[:j - off, 0]; VR[off:j] += a[:j - off, 1]
peak = max(np.abs(VL).max(), np.abs(VR).max(), 1e-6)
VL = VL / peak * 0.9; VR = VR / peak * 0.9
voice_path = f"{TMP}/voice.wav"
pcm = (np.stack([VL, VR], axis=1) * 32767).astype('<i2')
w = wave.open(voice_path, 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes(pcm.tobytes()); w.close()

# 4) Render the silent video to the narrated timing + matching music.
print("[3/5] Rendering video to narration timing…")
silent = f"{TMP}/silent.mp4"
bv.render(silent, title_dur=title_dur, scene_durs=scene_durs, end_dur=end_dur)
print("[4/5] Regenerating music to length…")
music_path = f"{TMP}/music.wav"
bm.generate(total_sec, music_path)

# 5) Mix: music (faded + ducked under voice) + voice, limit, mux onto video.
print("[5/5] Mixing + muxing…")
fout = max(0.0, total_sec - 2.3)
af = (
    f"[1:a]afade=t=in:st=0:d=1.0,afade=t=out:st={fout:.2f}:d=2.3,volume=0.5[m];"
    f"[2:a]volume=1.7,asplit=2[v1][v2];"
    f"[m][v1]sidechaincompress=threshold=0.03:ratio=9:attack=20:release=330:makeup=1.4[md];"
    f"[md][v2]amix=inputs=2:normalize=0:dropout_transition=0[mix];"
    f"[mix]alimiter=limit=0.97[a]"
)
out = "demo-screenshots/proofready-walkthrough-narrated.mp4"
subprocess.run([
    "ffmpeg", "-loglevel", "error", "-y", "-i", silent, "-i", music_path, "-i", voice_path,
    "-filter_complex", af, "-map", "0:v:0", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out,
], check=True)
# 720p variant
out720 = "demo-screenshots/proofready-walkthrough-narrated-720p.mp4"
subprocess.run([
    "ffmpeg", "-loglevel", "error", "-y", "-i", out, "-vf", "scale=1280:720",
    "-c:v", "libx264", "-preset", "medium", "-crf", "24", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out720,
], check=True)
print(f"\nDONE → {out}  ({total_sec:.0f}s)\n     → {out720}")
