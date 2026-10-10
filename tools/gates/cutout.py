"""tools/gates/cutout.py — ART_DIRECTION pillar 1's black cut-out, applied to the gates.

    "Silhouette at speed. ... Test: reduce the frame to black cut-outs; is the
    gate still a gate?"

Takes a screenshot and keeps ONLY the gate frames: every pixel whose colour is
a saturated green (a ring), a saturated orange (the 2016 finish) or a bright
near-white / near-black cell (the Anniversary banner's chequer) goes black;
everything else goes white. What is left is the outline the eye reads at
500 m, with the colour taken away — so the question "is the finish a
different SHAPE from a ring, or only a different colour?" has to be answered
by the shape.

    python tools/gates/cutout.py in.png out.png [--report]

`--report` prints the black pixel count and the bounding box of each
connected blob over 40 px, largest first: a number to put in the ledger
instead of "it looks distinct".

Not a test. A tool for a person judging a frame; DEV-123's row cites what it
printed.
"""

from __future__ import annotations

import colorsys
import sys
from collections import deque

from PIL import Image


def is_gate_colour(r: int, g: int, b: int) -> bool:
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    hue = h * 360
    # A ring: the green frame (0.325, 1, 0.059 in sRGB) and its lit studs.
    if s > 0.35 and v > 0.45 and 80 <= hue <= 160:
        return True
    # The finish: orange (1, 0.62, 0.15) — and its warm glow.
    if s > 0.45 and v > 0.5 and 15 <= hue <= 45:
        return True
    return False


def is_banner_cell(r: int, g: int, b: int) -> bool:
    # The chequer, MEASURED on the 500 m Anniversary frame (probe-pixels.py):
    # light cells come through the haze at s 0.02 / v 0.94, dark cells at
    # s 0.13-0.19 / v 0.35-0.47, and the sky between them at s 0.04-0.09 /
    # v 0.62-0.80. A pure black (v < 0.07) was the first guess and matched
    # nothing — DEV-082's aerial perspective lifts every dark thing at 500 m.
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return (s <= 0.06 and v >= 0.90) or (s <= 0.20 and v <= 0.50)


def cutout(src: str, dst: str, banner: bool = False) -> Image.Image:
    # `banner` is OFF by default: the measured chequer rule above also admits
    # the pale clouds under a 4-degree sun (a 23,000 px blob across the top of
    # the 500 m frame), so the band's contribution to the silhouette is judged
    # from the frame itself. Pass `--banner` to see what the rule catches.
    im = Image.open(src).convert("RGB")
    w, h = im.size
    out = Image.new("L", (w, h), 255)
    px = im.load()
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if is_gate_colour(r, g, b) or (banner and is_banner_cell(r, g, b)):
                op[x, y] = 0
    out.save(dst)
    return out


def blobs(im: Image.Image, min_px: int = 40) -> list[tuple[int, tuple[int, int, int, int]]]:
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    found: list[tuple[int, tuple[int, int, int, int]]] = []
    for y0 in range(h):
        for x0 in range(w):
            if px[x0, y0] != 0 or seen[y0 * w + x0]:
                continue
            q = deque([(x0, y0)])
            seen[y0 * w + x0] = 1
            n = 0
            minx = maxx = x0
            miny = maxy = y0
            while q:
                x, y = q.popleft()
                n += 1
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and px[nx, ny] == 0:
                        seen[ny * w + nx] = 1
                        q.append((nx, ny))
            if n >= min_px:
                found.append((n, (minx, miny, maxx, maxy)))
    found.sort(reverse=True)
    return found


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        sys.exit(2)
    result = cutout(args[0], args[1], banner="--banner" in sys.argv)
    if "--report" in sys.argv:
        black = sum(1 for v in result.getdata() if v == 0)
        print(f"{args[0]}: {black} black px of {result.size[0] * result.size[1]}")
        for n, (x0, y0, x1, y1) in blobs(result)[:6]:
            print(f"  blob {n:6d} px  bbox x {x0}..{x1} ({x1 - x0 + 1} wide)  y {y0}..{y1} ({y1 - y0 + 1} tall)")
