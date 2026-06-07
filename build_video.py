#!/usr/bin/env python3
"""Render an MP4 walkthrough from the full-page ProofReady screenshots.
Generates scroll frames + captions + title/end cards and pipes them to ffmpeg.
Outputs demo-screenshots/proofready-walkthrough.mp4 . Nothing here deploys.

Resolution is parametric: the canvas defaults to 1920x1080, but call
`set_scale(f)` (or set env WALK_SCALE) to render at a multiple of that. Every
pixel constant below is expressed through S() so the layout scales cleanly;
SCALE=1 reproduces the original 1080p output exactly. The scene screenshots are
2800px wide, so up to ~1.46x (2800-wide / "3K") is native-crisp and higher is a
mild upscale of the screenshot content (captions/cards stay vector-crisp).
"""
import subprocess, math, os
from PIL import Image, ImageDraw, ImageFont

FPS = 30
SCALE = float(os.environ.get("WALK_SCALE", "1"))

def _even(n):
    n = round(n)
    return n - (n % 2)  # x264 yuv420p needs even dimensions

W = _even(1920 * SCALE)
H = _even(1080 * SCALE)

def S(x):
    """Scale a 1080p-space pixel constant to the current canvas."""
    return round(x * SCALE)

CREAM = (250, 247, 242)
INK = (31, 41, 55)
ORANGE = (237, 118, 21)
BODY = (231, 226, 219)
SUBGRAY = (107, 114, 128)
DARK = (17, 12, 9)

D = "demo-screenshots"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
def fb(sz): return ImageFont.truetype(BOLD, sz)
def fr(sz): return ImageFont.truetype(REG, sz)

SCENES = [
    ("full/essay-feedback.png",  "STUDENT FEEDBACK",     "Feedback in a marker's voice",
     "Every draft comes back with holistic feedback, a key-term check and a clear top priority — calibrated to NESA standards, never a mark or band."),
    ("full/essay-annotated.png", "INLINE ANNOTATION",    "Marked up like a teacher's pen",
     "Comments anchored to the student's own words — strengths, evidence, depth and task alignment, line by line."),
    ("full/maths.png",           "MATHEMATICS",          "Line-by-line maths diagnosis",
     "Typed working is checked step by step — correct lines, thin reasoning, and the exact line where it breaks down."),
    ("full/insights-cohort.png", "CLASS INSIGHTS",       "Whole-class insight at a glance",
     "Mark distribution on the NESA scale, plus the patterns worth a lesson — common gaps, stretch goals and what's working."),
    ("full/insights-student.png","LONGITUDINAL PROFILE", "A picture that compounds over time",
     "Every submission feeds a per-student profile — report-ready, and shareable with any teacher who inherits the student."),
]

CREAM_IMG = Image.new("RGB", (W, H), CREAM)

def set_scale(scale):
    """Re-render at `scale` x 1920x1080. Recomputes the canvas globals."""
    global SCALE, W, H, CREAM_IMG
    SCALE = float(scale)
    W = _even(1920 * SCALE)
    H = _even(1080 * SCALE)
    CREAM_IMG = Image.new("RGB", (W, H), CREAM)
    return W, H

def wrap(draw, text, font, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= maxw: cur = t
        else: lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def draw_spaced(draw, xy, text, font, fill, spacing):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + spacing

def caption_overlay(kicker, title, body):
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    # bottom gradient
    gh = S(430)
    for i in range(gh):
        a = int(238 * (i / gh) ** 1.2)
        d.line([(0, H - gh + i), (W, H - gh + i)], fill=(DARK[0], DARK[1], DARK[2], a))
    mx = S(120)
    f_k, f_t, f_b = fb(S(23)), fb(S(53)), fr(S(31))
    body_lines = wrap(d, body, f_b, S(1180))
    # layout from bottom up
    by = H - S(70) - len(body_lines) * S(42)
    ty = by - S(74)
    ky = ty - S(40)
    draw_spaced(d, (mx, ky), kicker, f_k, ORANGE, S(4))
    d.text((mx, ty), title, font=f_t, fill=(255, 255, 255))
    yy = by
    for ln in body_lines:
        d.text((mx, yy), ln, font=f_b, fill=BODY)
        yy += S(42)
    return ov

def title_frame():
    im = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(im)
    banner = Image.open(os.path.join(D, "proofreadybanner.png")).convert("RGBA")
    bw = S(600)
    banner = banner.resize((bw, round(banner.height * bw / banner.width)))
    block_h = banner.height + S(40) + S(70) + S(16) + S(40)
    top = (H - block_h) // 2
    im.paste(banner, ((W - bw) // 2, top), banner)
    f_tag, f_sub = fb(S(60)), fr(S(34))
    tag = "Smarter feedback, better insights."
    sub = "NESA-aligned formative feedback for every student draft."
    ty = top + banner.height + S(46)
    d.text(((W - d.textlength(tag, font=f_tag)) // 2, ty), tag, font=f_tag, fill=INK)
    sy = ty + S(84)
    d.text(((W - d.textlength(sub, font=f_sub)) // 2, sy), sub, font=f_sub, fill=SUBGRAY)
    return im

def end_frame():
    im = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(im)
    f_big, f_sub, f_url = fb(S(66)), fr(S(32)), fb(S(32))
    p, r = "Proof", "Ready"
    wp = d.textlength(p, font=f_big); wr = d.textlength(r, font=f_big)
    x0 = (W - (wp + wr)) // 2
    cy = H // 2 - S(90)
    d.text((x0, cy), p, font=f_big, fill=INK)
    d.text((x0 + wp, cy), r, font=f_big, fill=ORANGE)
    sub = "Feedback in a marker's voice  ·  Insight that compounds over time."
    d.text(((W - d.textlength(sub, font=f_sub)) // 2, cy + S(100)), sub, font=f_sub, fill=SUBGRAY)
    url = "proofready.app"
    d.text(((W - d.textlength(url, font=f_url)) // 2, cy + S(168)), url, font=f_url, fill=ORANGE)
    return im

def smoothstep(t): return t * t * (3 - 2 * t)

def fade(frame, i, total, F):
    if i < F: return Image.blend(CREAM_IMG, frame, (i + 1) / (F + 1))
    if i >= total - F: return Image.blend(CREAM_IMG, frame, (total - i) / (F + 1))
    return frame

def emit_card(sink, base, hold=None, F=12, dur=None):
    if dur is not None:
        total = max(2 * F + 1, round(dur * FPS)); hold = total - 2 * F
    else:
        total = F + hold + F
    for i in range(total):
        sink(fade(base, i, total, F))

def emit_scene(sink, path, kicker, title, body, dur=None):
    img = Image.open(os.path.join(D, path)).convert("RGB")
    img = img.resize((W, round(img.height * W / img.width)))
    dist = max(0, img.height - H)
    cap = caption_overlay(kicker, title, body)
    F = 11
    if dur is not None:
        total = round(dur * FPS)
        hold_top = min(30, max(10, int(0.75 * FPS)))
        hold_bot = min(28, max(8, int(0.7 * FPS)))
        scroll = max(40, total - hold_top - hold_bot)
    else:
        hold_top, hold_bot = 28, 26
        scroll = max(90, min(205, int(dist / 5.5)))
    ys = [0] * hold_top
    for k in range(scroll):
        t = smoothstep(k / max(1, scroll - 1))
        ys.append(round(dist * t))
    ys += [dist] * hold_bot
    total = len(ys)
    for i, y in enumerate(ys):
        win = img.crop((0, y, W, y + H)).convert("RGBA")
        frame = Image.alpha_composite(win, cap).convert("RGB")
        sink(fade(frame, i, total, F))

def render(out_path, title_dur=None, scene_durs=None, end_dur=None, crf=19):
    """Render the walkthrough to out_path. If durations are given (seconds),
    each segment is timed to fit (used by the narrated build); otherwise the
    default auto-paced timings are used."""
    proc = subprocess.Popen([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{W}x{H}",
        "-framerate", str(FPS), "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path,
    ], stdin=subprocess.PIPE)
    n = [0]
    def sink(frame):
        proc.stdin.write(frame.tobytes()); n[0] += 1
    if title_dur is not None:
        emit_card(sink, title_frame(), dur=title_dur)
    else:
        emit_card(sink, title_frame(), hold=66)
    for idx, (path, k, t, b) in enumerate(SCENES):
        emit_scene(sink, path, k, t, b, dur=(scene_durs[idx] if scene_durs else None))
    if end_dur is not None:
        emit_card(sink, end_frame(), dur=end_dur)
    else:
        emit_card(sink, end_frame(), hold=84)
    proc.stdin.close(); proc.wait()
    print(f"frames={n[0]} duration={n[0]/FPS:.1f}s {W}x{H} -> {out_path}")
    return n[0] / FPS

if __name__ == "__main__":
    render(os.path.join(D, "proofready-walkthrough.mp4"))
