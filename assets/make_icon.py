"""Regenerate assets/icon.ico (the people mark from frontend/app/icon.svg). Needs Pillow."""

import math
from pathlib import Path

from PIL import Image, ImageDraw

SS = 4                      # supersampling factor for smooth edges
SIZE = 256 * SS
K = SIZE / 64               # icon.svg uses a 64x64 viewBox

# Violet -> indigo diagonal gradient, masked to a rounded square.
stops = [(0.0, (139, 92, 246)), (0.55, (109, 91, 240)), (1.0, (91, 108, 240))]


def colour(t):
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1)) + (255,)
    return stops[-1][1] + (255,)


row = [colour(i / (2 * (SIZE - 1))) for i in range(2 * SIZE)]
gradient = Image.new("RGBA", (SIZE, SIZE))
gradient.putdata([row[x + y] for y in range(SIZE) for x in range(SIZE)])
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle((2 * K, 2 * K, 62 * K, 62 * K), radius=15 * K, fill=255)
image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
image.paste(gradient, (0, 0), mask)

overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(overlay)


def pt(x, y):
    """Mark coordinates (translate(14 14) scale(2)) to pixels."""
    return (14 + 2 * x) * K, (14 + 2 * y) * K


def dot(cx, cy, r, fill):
    x, y = pt(cx, cy)
    draw.ellipse((x - 2 * r * K, y - 2 * r * K, x + 2 * r * K, y + 2 * r * K), fill=fill)


def arc(start, end, r, width, fill):
    """Minor arc between two points, bulging upwards (like the svg's shoulder paths)."""
    (x1, y1), (x2, y2) = start, end
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    d = math.hypot(x2 - x1, y2 - y1)
    h = math.sqrt(max(r * r - (d / 2) ** 2, 0))
    nx, ny = -(y2 - y1) / d, (x2 - x1) / d
    cx, cy = (mx + nx * h, my + ny * h)
    if cy < min(y1, y2):            # pick the centre below the chord
        cx, cy = mx - nx * h, my - ny * h
    a1 = math.degrees(math.atan2(y1 - cy, x1 - cx))
    a2 = math.degrees(math.atan2(y2 - cy, x2 - cx))
    lo, hi = sorted((a1, a2))
    if math.sin(math.radians((lo + hi) / 2)) > 0:   # that span runs below the centre; take the upper one
        lo, hi = hi, lo + 360
    px, py = pt(cx, cy)
    w = round(2 * width * K)
    R = 2 * r * K + w / 2           # PIL strokes inwards from the box; centre the stroke on the radius
    draw.arc((px - R, py - R, px + R, py + R), lo, hi, fill=fill, width=w)
    for x, y in (start, end):       # round line caps
        dot(x, y, width / 2, fill)


faint, white = (255, 255, 255, 153), (255, 255, 255, 255)
dot(4, 6.6, 1.9, faint)
dot(14, 6.6, 1.9, faint)
arc((0.8, 13.6), (6.4, 11.2), 3.3, 1.5, faint)
arc((11.6, 11.2), (17.2, 13.6), 3.3, 1.5, faint)
dot(9, 5.4, 2.6, white)
arc((4.6, 15.6), (13.4, 15.6), 4.4, 1.8, white)

image = Image.alpha_composite(image, overlay).resize((256, 256), Image.LANCZOS)
target = Path(__file__).with_name("icon.ico")
image.save(target, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f"wrote {target}")
