"""tools/gates/arrow-pixels.py — count the next-gate arrow's amber pixels in a cockpit frame.

    python tools/gates/arrow-pixels.py frame.png [x0 y0 x1 y1]

The arrow is the HUD accent (#ffcf7a) lit and emissive, and it comes through
the Anniversary tone curve MEASURED (probe-pixels.py on the 13.6 s frame) at
hue 36-45, saturation 0.15-0.24, value 0.87-0.98 — brighter and far less
saturated than the accent itself, which is why the first guess of "s > 0.4"
counted nothing on a frame the arrow is plainly in. The default box is the
glareshield above the GATES plate in the 1280x720 AB frames. DEV-124's row
cites Classic (flag off) against Anniversary.
"""

from __future__ import annotations

import colorsys
import sys

from PIL import Image

name = sys.argv[1]
x0, y0, x1, y1 = (int(v) for v in sys.argv[2:6]) if len(sys.argv) >= 6 else (560, 400, 720, 500)
im = Image.open(name).convert("RGB")
px = im.load()
n = 0
for y in range(y0, y1):
    for x in range(x0, x1):
        r, g, b = px[x, y]
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if 30 <= h * 360 <= 50 and 0.12 <= s <= 0.35 and v >= 0.85:
            n += 1
print(f"{name}: {n} amber px in ({x0},{y0})..({x1},{y1})")
