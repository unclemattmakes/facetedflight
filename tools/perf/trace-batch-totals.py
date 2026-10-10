"""tools/perf/trace-batch-totals.py - the A/B statistic across a whole queue. DEV-255.

Batch the distributional statistic across every trace in a queue output dir.

One 50 MB parse per row. Reports, per arm:
  raster_ms  - total time in RasterDecoderImpl::DoEndRasterCHROMIUM* slices
  gpu_ms     - total time in ANY [gpu]-category slice
  raster_n   - how many raster slices
  per_s      - raster_ms normalised by the trace's own wall span, so runs of
               different length compare without trimming to a common window
A SUM over thousands of slices is stable where their maximum is not: the same
arm gave 27.60 / 34.05 / 28.43 on its maximum in this very queue.
"""

import json
import statistics
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "perf-out/hud")
ROWS = sorted(ROOT.glob("*.trace.json"))

print(f"{'row':<24}{'span s':>8}{'raster_n':>10}{'raster_ms':>11}{'per_s':>9}"
      f"{'gpu_ms':>10}{'r_p50':>8}{'r_max':>8}")
for p in ROWS:
    try:
        raw = json.loads(p.read_text(encoding="utf-8", errors="replace"))
    except Exception as e:  # noqa: BLE001
        print(f"{p.stem:<24}  PARSE FAILED: {e}")
        continue
    evs = raw.get("traceEvents", raw) if isinstance(raw, dict) else raw
    xs = [e for e in evs if e.get("ph") == "X" and isinstance(e.get("dur"), (int, float))]
    if not xs:
        print(f"{p.stem:<24}  no complete events")
        continue
    span = (max(e["ts"] + e["dur"] for e in xs) - min(e["ts"] for e in xs)) / 1e6
    raster = [e["dur"] / 1000 for e in xs if "DoEndRasterCHROMIUM" in str(e.get("name"))]
    gpu = [e["dur"] / 1000 for e in xs if "gpu" in str(e.get("cat", "")).split(",")]
    name = p.stem.replace(".trace", "")
    print(
        f"{name:<24}{span:>8.1f}{len(raster):>10}{sum(raster):>11.1f}"
        f"{(sum(raster) / span if span else 0):>9.2f}{sum(gpu):>10.1f}"
        f"{(statistics.median(raster) if raster else 0):>8.3f}"
        f"{(max(raster) if raster else 0):>8.2f}"
    )
    sys.stdout.flush()
