#!/usr/bin/env python3
"""tools/perf/trace-longest.py - read a ride trace properly. DEV-255/256.

`ride-hitch.spec.ts` prints the longest sixteen slices. That is enough to say
WHERE a cost lives - `[gpu]` versus `[blink]` versus `[v8]` - and it is the
wrong statistic for an A/B, which is a mistake this file exists because of.

── THE MISTAKE, so nobody repeats it ───────────────────────────────────────

**"The longest slice anywhere in the window" is a MAXIMUM over ~4,000 frames.**
On 2026-09-20 two rows of the SAME arm with the SAME pins - `01-L0high-live-a`
and `05-L0high-live-b`, the deliberate bracket - read **27.60 ms** and
**34.05 ms**. A 6.45 ms spread on the control, which is larger than every
between-arm difference the same run produced. The box was not drifting: the
queue's own GPU readings have every row starting 52-55 C at 3-4 % busy, and
row 05 had the CALMEST end state while producing the WORST number.

A maximum moves several milliseconds when one frame is unlucky. **Use `totals`
for anything comparative**, and quote `longest` only for locating a mechanism,
never for sizing one.

── Two modes ───────────────────────────────────────────────────────────────

    python tools/perf/trace-longest.py <trace.json> totals [--cat gpu] [--name SUB]
    python tools/perf/trace-longest.py <trace.json> longest [--top N] [--depth N]

**totals** groups every complete event by name and reports n, the SUM, and the
distribution - a sum over thousands of slices is stable where their maximum is
not. `per_s` normalises by the trace's own wall span, so two runs of different
length are comparable without trimming them to a common window.

**longest** takes the biggest slices and prints what is NESTED INSIDE them, so
a generic `RunTask` wrapper resolves into named work. It also prints how much
of the wrapper its largest child accounts for: **a wrapper its children do not
explain is WAITING**, which is the whole DEV-255 question.

── What counts as "inside" ─────────────────────────────────────────────────

Chrome's JSON trace gives complete events (`ph: 'X'`) a `ts` and a `dur`, per
process (`pid`) and thread (`tid`). B is inside A when they share pid+tid and
B's span is contained in A's. That is a containment test on the timeline, not
a parent pointer - the format has no parent pointer - so a slice that merely
overlaps is excluded rather than guessed at.

These files are ~50 MB each, so parsing a queue's worth is minutes of CPU.
**Never run it while a measurement is running on the same box.**
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path


def load(path: Path) -> list[dict]:
    raw = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    events = raw.get("traceEvents", raw) if isinstance(raw, dict) else raw
    return [e for e in events if e.get("ph") == "X" and isinstance(e.get("dur"), (int, float))]


def cats(e: dict) -> str:
    return str(e.get("cat", ""))


def arg(argv: list[str], flag: str, default: str | None = None) -> str | None:
    return argv[argv.index(flag) + 1] if flag in argv else default


def totals(evs: list[dict], cat_filter: str | None, name_filter: str | None) -> int:
    span_us = max(e["ts"] + e["dur"] for e in evs) - min(e["ts"] for e in evs)
    span_s = span_us / 1e6
    groups: dict[tuple[str, str], list[float]] = defaultdict(list)
    for e in evs:
        c = cats(e)
        n = str(e.get("name"))
        if cat_filter and cat_filter not in c:
            continue
        if name_filter and name_filter.lower() not in n.lower():
            continue
        groups[(n, c)].append(e["dur"] / 1000.0)

    if not groups:
        print("  nothing matched the filters")
        return 1

    rows = sorted(groups.items(), key=lambda kv: -sum(kv[1]))
    print(f"  trace span {span_s:.2f} s; {len(evs)} complete events\n")
    print(
        f"  {'name':<46}{'n':>7}{'sum ms':>10}{'ms/s':>9}"
        f"{'mean':>8}{'p50':>8}{'p95':>8}{'max':>9}"
    )
    for (name, cat), ds in rows[:24]:
        ds_sorted = sorted(ds)
        p95 = ds_sorted[int(len(ds) * 0.95)] if len(ds) >= 20 else ds_sorted[-1]
        print(
            f"  {name[:44]:<46}{len(ds):>7}{sum(ds):>10.1f}{sum(ds) / span_s:>9.2f}"
            f"{statistics.fmean(ds):>8.3f}{statistics.median(ds):>8.3f}{p95:>8.2f}{max(ds):>9.2f}"
        )
    print(
        "\n  READ THE `sum ms` AND `ms/s` COLUMNS for an A/B. `max` is the statistic that\n"
        "  gave two rows of one arm 27.60 and 34.05 on the same box - see this file's header."
    )
    return 0


def longest(evs: list[dict], top_n: int, max_children: int) -> int:
    evs = sorted(evs, key=lambda e: -e["dur"])
    for rank, parent in enumerate(evs[:top_n], 1):
        p_start, p_end = parent["ts"], parent["ts"] + parent["dur"]
        print(
            f"#{rank}  {parent['dur'] / 1000:.2f} ms  {parent.get('name')}  "
            f"[{cats(parent)}]  pid={parent.get('pid')} tid={parent.get('tid')}"
        )
        inside = [
            e
            for e in evs
            if e is not parent
            and e.get("pid") == parent.get("pid")
            and e.get("tid") == parent.get("tid")
            and e["ts"] >= p_start
            and e["ts"] + e["dur"] <= p_end
        ]
        inside.sort(key=lambda e: -e["dur"])
        if not inside:
            print("      (nothing nested on the same thread - this IS the leaf)\n")
            continue
        for e in inside[:max_children]:
            share = 100.0 * e["dur"] / parent["dur"]
            print(f"      {e['dur'] / 1000:8.2f} ms  {share:5.1f}%  {e.get('name')}  [{cats(e)}]")
        deepest = max(e["dur"] for e in inside)
        print(
            f"      -> largest child is {100.0 * deepest / parent['dur']:.1f}% of the wrapper; "
            "the rest is unaccounted, i.e. waiting or unnamed\n"
        )
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = Path(argv[1])
    mode = argv[2] if len(argv) > 2 and not argv[2].startswith("--") else "totals"
    evs = load(path)
    print(f"\n{path.name}: {len(evs)} complete events — mode {mode}\n")
    if not evs:
        print("  no complete events in this trace")
        return 1
    if mode == "longest":
        return longest(evs, int(arg(argv, "--top", "3")), int(arg(argv, "--depth", "12")))
    return totals(evs, arg(argv, "--cat"), arg(argv, "--name"))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
