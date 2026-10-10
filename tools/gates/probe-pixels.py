"""tools/gates/probe-pixels.py — print HSV of pixels in a region, to set thresholds by measurement.

    python tools/gates/probe-pixels.py frame.png x0 y0 x1 y1 [step]
"""

from __future__ import annotations

import colorsys
import sys

from PIL import Image

name, x0, y0, x1, y1 = sys.argv[1], *map(int, sys.argv[2:6])
step = int(sys.argv[6]) if len(sys.argv) > 6 else 4
im = Image.open(name).convert("RGB")
px = im.load()
for y in range(y0, y1, step):
    row = []
    for x in range(x0, x1, step):
        r, g, b = px[x, y]
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        row.append(f"{int(h * 360):3d}/{s:.2f}/{v:.2f}")
    print(f"y{y:4d}: " + "  ".join(row))
