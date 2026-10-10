"""tools/gates/gate-pixels.py — how many pixels of a frame are gate-green.

    python tools/gates/gate-pixels.py a.png b.png ...

The number behind DEV-122's before / 1 s / 3 s frames: a gate that is up is
thousands of green pixels from beside it; a gate that is gone is none. The
hue window is the ring frame's and studs' (sRGB (0.325, 1, 0.059) lit), and
is the same one `cutout.py` uses for a ring.
"""

from __future__ import annotations

import colorsys
import sys

from PIL import Image

for name in sys.argv[1:]:
    im = Image.open(name).convert("RGB")
    n = 0
    for r, g, b in im.getdata():
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s > 0.35 and v > 0.45 and 80 <= h * 360 <= 160:
            n += 1
    print(f"{name}: {n} gate-green px")
