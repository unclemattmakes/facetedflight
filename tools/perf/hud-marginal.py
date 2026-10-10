#!/usr/bin/env python3
"""tools/perf/hud-marginal.py - the HUD's MARGINAL cost per load. DEV-255.

`docs/plan/HUD-REDESIGN.md` §3 asks one question:

    H: the HUD's cost is a SYNCHRONISATION with work already queued in the GPU
    process, so it scales with how much GPU work the frame has queued ahead of
    it - not with the panel's pixels, bytes or draw calls.

The alternative is "the raster is intrinsically expensive". Both explain every
reading taken before this, which is the situation DEVIATIONS.md's agreement
lesson says has not been tested. They disagree on ONE thing: what happens to
the panel's marginal cost when the FRAME gets cheaper and the PANEL does not
change at all.

    H               -> the margin FALLS as the load falls
    the alternative -> the margin is flat

── READ THE TRACE SLICE, NOT `dt` ──────────────────────────────────────────

**This box presents at 180 Hz and Chrome honours it**, so `dt` is quantised to
5.55 ms: over 3,969 frames of `perf-out/reveal-2026-09-20/rookie01-ticks.csv`,
3,961 are exactly one interval and the mean deviation from a multiple of 5.55
is 0.066 ms. Consequences, both load-bearing for this script:

  * the steady-state margin reads **0.00 ms** flat - p50 5.60 and p95 5.70 on
    BOTH arms of a real live/freeze pair - because the frame has ~3.5 ms of
    slack and a 2 ms cost hides in it entirely. That is the instrument, not
    the panel. The worn 2.1 ms figure came from the VRto3D rig, which is gone.
  * "27.7 versus 11.1" at the release is **five dropped intervals versus two**,
    not a continuous pair.

So the headline column here is **the longest `[gpu]`-category slice** out of
`ride-hitch.spec.ts`'s `RIDE_PROFILE=1` trace, which is continuous. `dt` is
reported beside it, in intervals as well as milliseconds, so its resolution is
visible rather than implied.

`RIDE_PROFILE=1` now lifts the cap itself (DEV-255), because `ride-hitch.spec.ts`
was the one perf-bearing spec without `--disable-gpu-vsync` while five others had
it and `perf-protocol.md` §3b(a) had required it since 2026-09-17. So a row taken
with `RIDE_PROFILE=1` after that fix has continuous `dt`; every row in
`perf-out/reveal-2026-09-20/` predates it and does not.

── Usage ────────────────────────────────────────────────────────────────────

    python tools/perf/hud-marginal.py <queue-out-dir> [--csv-dir <dir>]

`<queue-out-dir>` is `QUEUE_DIR` from the run: one `<row-name>/run.log` per
row. `--csv-dir` defaults to `perf-out/dev255` and holds `<row-name>.csv`.

Row names must encode the arm as `NN-<load>-<cadence>[-<repeat>]`, e.g.
`01-L0-high-live-a`; `live` and `freeze` are the cadences and everything
between the index and the cadence is the load. Repeats are averaged only AFTER
their spread is printed - a bracket whose halves disagree is the run telling
you the box moved under it.
"""

from __future__ import annotations

import csv
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

CADENCES = ("live", "freeze")
REFRESH_MS = 5.55

# `       26.75 ms  RasterDecoderImpl::DoEndRasterCHROMIUM::Flush  [gpu]`
SLICE = re.compile(r"^\s*([0-9]+\.[0-9]+) ms\s+(\S.*?)\s+\[([^\]]+)\]\s*$")


def split_name(stem: str) -> tuple[str, str, str] | None:
    parts = stem.split("-")
    for i, part in enumerate(parts):
        if part in CADENCES:
            return ("-".join(parts[1:i]), part, "-".join(parts[i + 1 :]) or "-")
    return None


def parse_log(path: Path) -> dict[str, object]:
    """Longest slice overall and longest `[gpu]` slice, from the printed table."""
    best_any: tuple[float, str] | None = None
    best_gpu: tuple[float, str] | None = None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = SLICE.match(line)
        if not m:
            continue
        dur, name, cats = float(m.group(1)), m.group(2), m.group(3)
        if best_any is None or dur > best_any[0]:
            best_any = (dur, name)
        if "gpu" in cats.split(",") and (best_gpu is None or dur > best_gpu[0]):
            best_gpu = (dur, name)
    return {
        "top_any_ms": best_any[0] if best_any else None,
        "top_any": best_any[1] if best_any else None,
        "top_gpu_ms": best_gpu[0] if best_gpu else None,
        "top_gpu": best_gpu[1] if best_gpu else None,
    }


def parse_csv(path: Path) -> dict[str, object]:
    """The release spike and the post-release steady state.

    The release is located by ASKING THE OBJECT - the first frame whose `phase`
    is `flying` - never by a threshold anyone typed. HUD-REWORK.md §3's trap 1
    is exactly that mistake: the reveal was located at a constant 100.4 while
    `revealRiseFor` returns 101.84, and the window reported the event as free.
    """
    rows = list(csv.DictReader(path.open(newline="", encoding="utf-8")))
    if not rows or "phase" not in rows[0]:
        return {"frames": len(rows), "release_i": None}
    rel = next((i for i, r in enumerate(rows) if r.get("phase") == "flying"), None)
    dt = [float(r["dt_ms"]) for r in rows if r.get("dt_ms")]
    out: dict[str, object] = {"frames": len(dt), "release_i": rel}
    if rel is None:
        return out
    # The spike is not reliably ON the first flying frame - in the DEV-249 data
    # it is three frames later - so take the worst of a small window after it.
    window = dt[rel : rel + 12]
    steady = dt[rel + 12 :]
    out["release_worst"] = max(window) if window else None
    out["steady_n"] = len(steady)
    out["steady_p50"] = statistics.median(steady) if steady else None
    out["steady_p95"] = sorted(steady)[int(len(steady) * 0.95)] if len(steady) >= 20 else None
    # Is dt quantised? If it is, every margin read off it is worthless below
    # one interval, and the reader has to be told rather than left to assume.
    live = [x for x in dt if x > 3]
    out["quantised"] = (
        statistics.fmean(abs(x - round(x / REFRESH_MS) * REFRESH_MS) for x in live) < 0.3
        if live
        else None
    )
    return out


def fmt(v: object, width: int = 9, places: int = 2) -> str:
    if v is None:
        return "-".rjust(width)
    if isinstance(v, float):
        return f"{v:.{places}f}".rjust(width)
    return str(v).rjust(width)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    qdir = Path(argv[1])
    csv_dir = Path(argv[argv.index("--csv-dir") + 1]) if "--csv-dir" in argv else Path("perf-out/dev255")

    rows: list[dict[str, object]] = []
    for log in sorted(qdir.glob("*/run.log")):
        name = log.parent.name
        parsed = split_name(name)
        rec: dict[str, object] = {"name": name}
        rec.update(parse_log(log))
        cpath = csv_dir / f"{name}.csv"
        if cpath.exists():
            rec.update(parse_csv(cpath))
        else:
            rec["frames"] = None
        if parsed:
            rec["load"], rec["cadence"], rec["repeat"] = parsed
        rows.append(rec)

    if not rows:
        print(f"no <row>/run.log under {qdir}")
        return 1

    print(f"\n{len(rows)} row(s) under {qdir}; CSVs from {csv_dir}\n")
    print("PER ROW")
    print(f"  {'row':<26}{'top [gpu]':>11}{'top any':>10}{'rel worst':>11}{'p50':>8}{'p95':>8}  slice")
    quant = 0
    for r in rows:
        if r.get("quantised"):
            quant += 1
        print(
            f"  {str(r['name']):<26}{fmt(r.get('top_gpu_ms'), 11)}{fmt(r.get('top_any_ms'), 10)}"
            f"{fmt(r.get('release_worst'), 11)}{fmt(r.get('steady_p50'), 8)}"
            f"{fmt(r.get('steady_p95'), 8)}  {str(r.get('top_gpu') or r.get('top_any') or '')[:44]}"
        )
    if quant:
        print(
            f"\n  !! {quant}/{len(rows)} row(s) have dt QUANTISED to ~{REFRESH_MS} ms (vsync).\n"
            "     Every `rel worst`, `p50` and `p95` above is therefore a COUNT OF DROPPED\n"
            "     INTERVALS, not a duration, and nothing below one interval can appear in\n"
            "     them at all. READ THE `top [gpu]` COLUMN INSTEAD - it is continuous.\n"
            "     And do NOT assume --disable-gpu-vsync fixes this: DEV-255 verified\n"
            "     from the live process command line that the flag WAS on the browser\n"
            "     while dt stayed quantised. rAF is paced by the compositor, and only\n"
            "     the GPU TIMER path is freed by that flag alone (perf-protocol 3b(a))."
        )
    print()

    by_arm: dict[tuple[str, str], list[dict[str, object]]] = defaultdict(list)
    for r in rows:
        if "load" in r:
            by_arm[(str(r["load"]), str(r["cadence"]))].append(r)

    print("BRACKET SPREAD (repeats of one arm; wide = the box moved under the run)")
    shaky = 0
    for (load, cadence), runs in sorted(by_arm.items()):
        vals = [r["top_gpu_ms"] for r in runs if r.get("top_gpu_ms") is not None]
        if len(vals) < 2:
            continue
        spread = max(vals) - min(vals)  # type: ignore[type-var]
        wide = spread > 3.0  # type: ignore[operator]
        shaky += 1 if wide else 0
        print(
            f"  {load:<16}{cadence:<8}n={len(vals)}  top[gpu] spread {spread:.2f} ms"
            f"{'  <-- WIDE' if wide else ''}"
        )
    if shaky:
        print(f"  {shaky} arm(s) WIDE - read these before believing any margin below.")
    print()

    print("THE MARGIN - live minus freeze, per load")
    print(f"  {'load':<16}{'top [gpu]':>12}{'rel worst':>12}{'steady p50':>12}")
    margins: list[tuple[str, float]] = []
    for load in sorted({l for (l, _c) in by_arm}):

        def mean_of(cadence: str, key: str) -> float | None:
            vals = [r[key] for r in by_arm.get((load, cadence), []) if r.get(key) is not None]
            return statistics.fmean(vals) if vals else None  # type: ignore[arg-type]

        def margin(key: str) -> float | None:
            a, b = mean_of("live", key), mean_of("freeze", key)
            return None if a is None or b is None else a - b

        mg, mr, ms = margin("top_gpu_ms"), margin("release_worst"), margin("steady_p50")
        if mg is not None:
            margins.append((load, mg))
        print(f"  {load:<16}{fmt(mg, 12)}{fmt(mr, 12)}{fmt(ms, 12)}")
    print()

    if len(margins) >= 2:
        lo = min(m for _l, m in margins)
        hi = max(m for _l, m in margins)
        print("READ IT LIKE THIS")
        print(f"  The [gpu] margin ranges {lo:.2f} .. {hi:.2f} ms across {len(margins)} loads.")
        print("  H predicts it FALLS with the load. The alternative predicts it is FLAT.")
        print("  A freeze arm with NO [gpu] slice at all reads as a missing value, not a zero;")
        print("  check the per-row table before reading a margin that involves one.")
    elif by_arm:
        print("NO [gpu] MARGIN COULD BE FORMED, and that is itself a reading.")
        print("  A freeze arm with no [gpu] slice in its top sixteen is the expected result -")
        print("  it means freezing the panel took the GPU process out of the trace's top rows")
        print("  entirely. Compare the `top any` column instead, and say so when you quote it.")
    else:
        print("No row name encoded an arm. Names must contain 'live' or 'freeze'.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
