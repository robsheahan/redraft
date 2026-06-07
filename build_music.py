#!/usr/bin/env python3
"""Synthesize an original, royalty-free CALM SYNTH-PAD backing track for the
ProofReady walkthrough — sustained, chorused pad chords over a gentle
I-V-vi-IV progression in C, slow attack + long release so each chord blends
into the next, a soft sub-root for warmth, light stereo width. No arpeggio,
no drums. Original, no licensing. Writes demo-screenshots/music.wav.
"""
import numpy as np, wave

SR = 44100
CHORD_DUR = 4.0            # seconds each chord is struck (slow, calm)
TAIL = 1.9                 # release overlap into the next chord

def midi(n): return 440.0 * 2 ** ((n - 69) / 12)

def pad_env(t, a, dur, r):
    """Raised-cosine attack + release — smooth, clickless pad shape."""
    env = np.ones_like(t)
    am = t < a
    env[am] = 0.5 - 0.5 * np.cos(np.pi * t[am] / a)
    rs = dur - r
    rm = t > rs
    env[rm] = 0.5 - 0.5 * np.cos(np.pi * np.clip((dur - t[rm]) / r, 0, 1))
    return env

def pad_voice(f, dur, amp, detune=7.0, bright=1.0):
    """One sustained pad note: 3 detuned sines (chorus) + a little soft harmonic
    warmth, kept mellow (low high-harmonic content = lowpassed character)."""
    n = int(dur * SR)
    t = np.linspace(0, dur, n, endpoint=False)
    sig = np.zeros(n)
    for c in (-detune, 0.0, detune):        # chorused detune stack
        sig += np.sin(2 * np.pi * f * 2 ** (c / 1200.0) * t)
    sig /= 3.0
    sig += 0.20 * bright * np.sin(2 * np.pi * 2 * f * t)   # gentle warmth
    sig += 0.06 * bright * np.sin(2 * np.pi * 3 * f * t)
    a = min(1.1, dur * 0.4)
    r = min(1.7, dur * 0.5)
    lfo = 1.0 + 0.05 * np.sin(2 * np.pi * 0.10 * t + (f % 7))  # slow breathing
    return sig * pad_env(t, a, dur, r) * lfo * amp

# I-V-vi-IV in C, with a low root for the sub. (triad voiced mid-register.)
PROG = [
    ([60, 64, 67], 48),  # C   (root C3)
    ([55, 59, 62], 43),  # G   (root G2)
    ([57, 60, 64], 45),  # Am  (root A2)
    ([53, 57, 60], 41),  # F   (root F2)
]

def generate(total, path="demo-screenshots/music.wav"):
    N = int(total * SR)
    L = np.zeros(N); R = np.zeros(N)

    def add(sig, start, pan=0.0):
        i = int(start * SR); j = min(i + len(sig), N)
        if i >= N: return
        s = sig[:j - i]
        gl = np.cos((pan + 1) / 2 * np.pi / 2); gr = np.sin((pan + 1) / 2 * np.pi / 2)
        L[i:j] += s * gl; R[i:j] += s * gr

    num = int(np.ceil(total / CHORD_DUR)) + 1
    for k in range(num):
        st = k * CHORD_DUR
        if st >= total: break
        notes, root = PROG[k % len(PROG)]
        dur = CHORD_DUR + TAIL
        triad = [midi(n) for n in notes]
        # centred triad pad
        add(sum(pad_voice(f, dur, 0.10) for f in triad), st, pan=0.0)
        # widening voices: detuned copies panned out, softer
        add(sum(pad_voice(f * 2 ** (-6 / 1200), dur, 0.05) for f in triad), st, pan=-0.6)
        add(sum(pad_voice(f * 2 ** (6 / 1200), dur, 0.05) for f in triad), st, pan=0.6)
        # soft, dark sub-root for body
        add(pad_voice(midi(root), dur, 0.09, detune=4.0, bright=0.35), st, pan=0.0)

    peak = max(np.abs(L).max(), np.abs(R).max(), 1e-6)
    stereo = np.stack([L, R], axis=1) / peak * 0.60
    pcm = (stereo * 32767).astype('<i2')
    w = wave.open(path, 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(pcm.tobytes()); w.close()
    print("wrote", path, f"synth pads, {total:.1f}s")

if __name__ == "__main__":
    generate(48.0)
