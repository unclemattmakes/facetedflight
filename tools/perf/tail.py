#!/usr/bin/env python
"""tools/perf/tail.py — characterise the GPU TAIL of a 13-mission VRto3D trace set.

READS (never writes, never touches):
  <run>/<mission>/<mission>-anniversary-<N>s-vrto3d.trace.csv   line 1 JSON header,
                                                               line 2 CSV header, then rows
  <run>/<mission>/<mission>-anniversary-<N>s-vrto3d.summary.json
  <census>/<mission>-anniversary-20s.json                       (optional, --census)

WRITES (only under --out):
  tail-metrics.json   every number below, per mission, machine readable
  tail-table.md       the per-mission table in the doc's shape
  tail-report.txt     the long-form print: the run's agreement with its own
                      summary.json, the tail table, the 1 s smoothed view, the
                      residual, the variance decomposition, the regime, the
                      hitch recount, the GPU stalls, the MID-FLIGHT STALLS
                      paired with the `programs` rise that preceded them, every
                      Spearman row, and the full census matrix
  <mission>-timeline.png   gpu_ms against elapsed_s, tail frames marked
  <mission>-map.png        top-down (ship_x, ship_z) coloured by gpu_ms
  runlengths.png           tail run-length CCDF, all missions
  spearman.png             gpu_ms rank-correlation heatmap, mission x column
  regime.png               GPU p95 vs frame p95 vs dt p95, all missions
  gap-decomposition.png    where the p95-p50 gap's excess mass sits

PERCENTILE DEFINITION — reproduced from the app, not from a library default.
`src/boot/perf-trace.ts:statOf` sorts the column and calls
`src/boot/perf-recorder.ts:percentile`, which is linear interpolation at
`pos = q * (n - 1)`. numpy's default method ('linear') is the same statistic, so
`np.percentile` is used directly; `--verify` asserts the agreement against the
summary.json the app itself wrote.

GPU STATS ARE OVER `gpu_fresh == 1` ROWS ONLY (the app does the same: `statOf`
is called with freshOnly=True for the gpu column and False for dt/sim/render/
frame). A non-fresh row repeats the previous GPU value and is not a measurement.

  python tools/perf/tail.py --run <dir> --out <dir> [--census <dir>] [--verify]

Defaults: --run perf-out/truesize  --census perf-out/census-all
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

# ── the thirteen, in WAVE-3 section 10.2's order (worst GPU p95 first) ────────
ORDER = [
    'int_02_hoverJet', 'rookie_01_hoverJet', 'adv_01_hoverJet', 'rookie_02_hoverJet',
    'hoverJet_kauai_beg', 'rookie_01_jumpSeat', 'int_01_hoverJet', 'adv_02_hoverJet',
    'int_02_jumpSeat', 'rookie_02_jumpSeat', 'int_01_jumpSeat', 'adv_01_jumpSeat',
    'adv_02_jumpSeat',
]
ENV = {
    'int_02_hoverJet': 'alpine', 'rookie_01_hoverJet': 'alpine', 'adv_01_hoverJet': 'desert',
    'rookie_02_hoverJet': 'desert', 'hoverJet_kauai_beg': 'kauai',
    'rookie_01_jumpSeat': 'alpine', 'int_01_hoverJet': 'simonet', 'adv_02_hoverJet': 'simonet',
    'int_02_jumpSeat': 'alpine', 'rookie_02_jumpSeat': 'desert', 'int_01_jumpSeat': 'simonet',
    'adv_01_jumpSeat': 'desert', 'adv_02_jumpSeat': 'simonet',
}
# WAVE-3 section 10.2, for --verify only. Never used as an input to anything.
WAVE3_10_2 = {
    'int_02_hoverJet': (8.11, 10.14), 'rookie_01_hoverJet': (7.97, 9.70),
    'adv_01_hoverJet': (7.92, 9.69), 'rookie_02_hoverJet': (7.73, 9.38),
    'hoverJet_kauai_beg': (7.75, 9.27), 'rookie_01_jumpSeat': (6.48, 9.20),
    'int_01_hoverJet': (6.71, 8.81), 'adv_02_hoverJet': (6.62, 8.72),
    'int_02_jumpSeat': (6.65, 8.70), 'rookie_02_jumpSeat': (5.47, 8.52),
    'int_01_jumpSeat': (4.95, 8.06), 'adv_01_jumpSeat': (5.22, 7.94),
    'adv_02_jumpSeat': (4.65, 7.85),
}
PRED_COLS = ['tris', 'calls', 'programs', 'terr_pending', 'terr_detail', 'terr_fading',
             'sea_pending', 'sea_fading', 'pieces', 'dt_ms', 'frame_ms', 'render_ms']
PASS_MS = 0.7 * 11.111  # WAVE-3 section 10.2's pass rule, 7.78 ms
HITCH_BUDGETS = 2       # src/boot/perf-trace.ts:178 — a hitch is dt > 2 x the frame's own tier
SMOOTH_S = 1.0          # the window the "is there a sustained SECTION" question is asked over
CELL_M = 256.0          # the cell the "is it one REGION" question is asked over


# ── loading ──────────────────────────────────────────────────────────────────
def load_trace(path):
    """line 1 JSON header, line 2 CSV header, then rows. Returns (header, dict-of-arrays)."""
    with open(path) as f:
        header = json.loads(f.readline())
        cols = f.readline().strip().split(',')
        rows = np.genfromtxt(f, delimiter=',', dtype=np.float64)
    assert cols == header['columns'], f'{path}: CSV header disagrees with the JSON header'
    return header, {c: rows[:, i] for i, c in enumerate(cols)}


def find_runs(run_dir):
    out = {}
    for m in ORDER:
        d = os.path.join(run_dir, m)
        if not os.path.isdir(d):
            continue
        csvs = [f for f in os.listdir(d) if f.endswith('.trace.csv')]
        if not csvs:
            continue
        stem = csvs[0][: -len('.trace.csv')]
        out[m] = (os.path.join(d, stem + '.trace.csv'),
                  os.path.join(d, stem + '.summary.json'))
    return out


def find_arms(run_dir):
    """A FLOOR-SWEEP layout: `<dir>/<NN-arm-name>/<mission>-...-vrto3d.trace.csv`.

    One mission, many arms, the directory name carrying the arm rather than the
    mission — which is what `tools/perf/floor-sweep.mjs` writes. Sorted by the
    numeric prefix so `15-baseline` follows `02-empty-stage` rather than
    preceding it, because the bracket only reads as a bracket in order.
    """
    out = {}
    for name in sorted(os.listdir(run_dir)):
        d = os.path.join(run_dir, name)
        if not os.path.isdir(d):
            continue
        csvs = [f for f in os.listdir(d) if f.endswith('.trace.csv')]
        if not csvs:
            continue
        stem = csvs[0][: -len('.trace.csv')]
        out[name] = (os.path.join(d, stem + '.trace.csv'),
                     os.path.join(d, stem + '.summary.json'))
    return out


# ── statistics, each one saying what it is OF ────────────────────────────────
def pct(a, q):
    """The app's percentile: sorted, linear interpolation at q*(n-1). numpy's default."""
    return float(np.percentile(a, q * 100.0))


def runs_of(mask):
    """Maximal runs of True in `mask`. Returns [(start, length), ...]."""
    if mask.size == 0:
        return []
    d = np.diff(mask.astype(np.int8))
    starts = list(np.flatnonzero(d == 1) + 1)
    ends = list(np.flatnonzero(d == -1) + 1)
    if mask[0]:
        starts.insert(0, 0)
    if mask[-1]:
        ends.append(mask.size)
    return [(s, e - s) for s, e in zip(starts, ends)]


def lag1(x):
    """Pearson lag-1 autocorrelation of x, over the sequence as given."""
    if x.size < 3:
        return float('nan')
    a, b = x[:-1], x[1:]
    a = a - a.mean()
    b = b - b.mean()
    den = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / den) if den > 0 else float('nan')


def moving_mean(x, w):
    """Centred moving mean of width w samples, edges shrunk rather than padded."""
    if w < 2 or x.size < w:
        return x.copy()
    c = np.concatenate(([0.0], np.cumsum(x, dtype=np.float64)))
    n = x.size
    lo = np.maximum(np.arange(n) - w // 2, 0)
    hi = np.minimum(np.arange(n) + w // 2 + 1, n)
    return (c[hi] - c[lo]) / (hi - lo)


def eta2_groups(values, keys):
    """Share of the variance of `values` that sits BETWEEN groups (one-way eta^2).

    Groups with fewer than 10 samples are dropped, so a single frame in a cell
    of its own cannot manufacture "explained" variance.
    """
    uk, inv, cnt = np.unique(keys, return_inverse=True, return_counts=True)
    big = cnt >= 10
    keep = big[inv]
    if keep.sum() < 50 or big.sum() < 2:
        return float('nan'), 0
    v, iv = values[keep], inv[keep]
    uk2, iv2 = np.unique(iv, return_inverse=True)
    gm = np.bincount(iv2, weights=v) / np.bincount(iv2)
    between = float((((gm[iv2] - v.mean()) ** 2).sum()))
    total = float(((v - v.mean()) ** 2).sum())
    return (between / total if total > 0 else float('nan')), int(uk2.size)


def spearman(x, y):
    """Spearman rho, ties averaged. Returns nan when either side is constant."""
    if x.size < 3:
        return float('nan')
    from scipy.stats import rankdata
    rx, ry = rankdata(x), rankdata(y)
    if rx.std() == 0 or ry.std() == 0:
        return float('nan')
    return float(np.corrcoef(rx, ry)[0, 1])


def analyse(mission, csv_path, summary_path):
    header, t = load_trace(csv_path)
    summary = json.load(open(summary_path))

    fresh = t['gpu_fresh'] == 1
    gpu = t['gpu_ms'][fresh]                      # the GPU sample sequence
    n_all, n_fresh = t['dt_ms'].size, int(fresh.sum())

    p50, p95, p90, p98 = (pct(gpu, q) for q in (0.50, 0.95, 0.90, 0.98))
    gap = p95 - p50

    # ── 1. sustained or spiky ────────────────────────────────────────────────
    over = gpu > p95
    rl = runs_of(over)
    lengths = np.array([L for _, L in rl], dtype=int) if rl else np.zeros(0, dtype=int)
    tail_n = int(over.sum())
    in_long = int(lengths[lengths >= 10].sum()) if lengths.size else 0
    in_iso = int(lengths[lengths <= 2].sum()) if lengths.size else 0

    # excess mass above the median, and who owns it
    excess = np.maximum(gpu - p50, 0.0)
    E = float(excess.sum())
    top2 = float(excess[gpu > p98].sum()) / E if E > 0 else float('nan')
    band9095 = float(excess[(gpu > p90) & (gpu <= p95)].sum()) / E if E > 0 else float('nan')
    above95 = float(excess[gpu > p95].sum()) / E if E > 0 else float('nan')

    # counterfactual: delete every run of >= 10 consecutive over-p95 frames
    keep = np.ones(gpu.size, dtype=bool)
    for s, L in rl:
        if L >= 10:
            keep[s:s + L] = False
    sustained_p95 = pct(gpu[keep], 0.95) if keep.sum() > 2 else float('nan')
    # and the mirror: delete the isolated spikes instead
    keep_iso = np.ones(gpu.size, dtype=bool)
    for s, L in rl:
        if L <= 2:
            keep_iso[s:s + L] = False
    despiked_p95 = pct(gpu[keep_iso], 0.95) if keep_iso.sum() > 2 else float('nan')

    # ── 1b. the same question at a SECOND timescale ──────────────────────────
    # "spiky" at the frame is not the same claim as "no expensive section". The
    # section question is asked of a 1 s moving mean of the same column: if the
    # cost really has slow structure, the smoothed series keeps its spread; if
    # the spread is per-frame jitter, smoothing flattens it.
    fps_est = n_all / max(summary['seconds'], 1e-9)
    w = max(int(round(SMOOTH_S * fps_est * (n_fresh / n_all))), 3)
    sm_gpu = moving_mean(gpu, w)
    sm_p50, sm_p95 = pct(sm_gpu, 0.50), pct(sm_gpu, 0.95)
    slow_share = float(sm_gpu.var() / gpu.var()) if gpu.var() > 0 else float('nan')
    # runs of the SMOOTHED series over the RAW p95 — an expensive section, if any
    sm_over = sm_gpu > p95
    sm_runs = runs_of(sm_over)
    sm_lengths = np.array([L for _, L in sm_runs], dtype=int) if sm_runs else np.zeros(0, int)

    # the fast half, on its own: gpu_ms minus its own 1 s mean
    resid = gpu - sm_gpu
    resid_sd = float(resid.std())
    resid_skew = float(((resid / resid_sd) ** 3).mean()) if resid_sd > 0 else float('nan')
    resid_lag1 = lag1(resid)
    resid_p = {q: pct(resid, q) for q in (0.05, 0.50, 0.95, 0.99)}
    resid_vs_dt = spearman(resid, t['dt_ms'][fresh])

    # autocorrelation out to ~3 s, so "how long does a disturbance last" is answered
    acf = []
    gc = gpu - gpu.mean()
    den = float((gc * gc).sum())
    for k in (1, 2, 3, 5, 10, 20, 40, 75, 150, 225):
        acf.append(float((gc[:-k] * gc[k:]).sum() / den) if den > 0 and k < gc.size else float('nan'))
    acf = dict(zip(('1', '2', '3', '5', '10', '20', '40', '75', '150', '225'), acf))

    # ── 2. where ─────────────────────────────────────────────────────────────
    el = t['elapsed_s'][fresh]
    x, z = t['ship_x'][fresh], t['ship_z'][fresh]
    finite = np.isfinite(x) & np.isfinite(z)
    first10 = float((el[over] <= 10.0).mean()) if tail_n else float('nan')
    first10_base = float((el <= 10.0).mean())

    # spatial concentration: 128 m cells, share of tail frames in the cells that
    # hold the top 10 % of tail frames, against the same cells' share of ALL frames
    lift = float('nan')
    cells_top = 0
    if finite.sum() > 10 and tail_n > 10:
        cs = 128.0
        key_all = (np.floor(x[finite] / cs).astype(np.int64) * 100003
                   + np.floor(z[finite] / cs).astype(np.int64))
        key_tail = key_all[over[finite]]
        uk, cnt = np.unique(key_tail, return_counts=True)
        idx = np.argsort(-cnt)
        take, acc = [], 0
        for i in idx:
            take.append(uk[i])
            acc += cnt[i]
            if acc >= 0.5 * key_tail.size:
                break
        cells_top = len(take)
        sel = np.isin(key_all, np.array(take))
        share_tail = float(np.isin(key_tail, np.array(take)).mean())
        share_all = float(sel.mean())
        lift = share_tail / share_all if share_all > 0 else float('nan')

    # variance decomposition: how much of gpu_ms is PLACE, and how much is TIME
    eta_place, n_cells = float('nan'), 0
    if finite.sum() > 100:
        key = (np.floor(x[finite] / CELL_M).astype(np.int64) * 100003
               + np.floor(z[finite] / CELL_M).astype(np.int64))
        eta_place, n_cells = eta2_groups(gpu[finite], key)
    eta_time, n_bins = eta2_groups(gpu, np.floor(el / SMOOTH_S).astype(np.int64))

    # ── programs: a rise mid-flight is a compile ─────────────────────────────
    prog = t['programs']
    rose = np.zeros(n_all, dtype=bool)
    rose[1:] = np.diff(prog) > 0
    prog_rows = dict(
        n=int(rose.sum()),
        gpu_ms=[float(v) for v in t['gpu_ms'][rose]],
        dt_ms=[float(v) for v in t['dt_ms'][rose]],
        elapsed_s=[float(v) for v in t['elapsed_s'][rose]],
        d=[int(v) for v in np.diff(prog)[np.diff(prog) > 0]],
    )

    # ── mid-flight stalls, paired with the nearest PRECEDING program rise ────
    #
    # `summary().worst` prints the program COUNT on the stalling row, and three's
    # `programs.length` rises when the program object is created while the driver
    # defers the link to the first draw — so a deferred-link stall lands ~10
    # frames after the count moved and the worst-frame line cannot see it. That
    # is why the lag is computed here rather than the count read there.
    rise_at = t['elapsed_s'][1:][np.diff(prog) > 0]
    rise_d = np.diff(prog)[np.diff(prog) > 0]
    big = np.flatnonzero((t['dt_ms'] > 60) & (t['elapsed_s'] > 3))
    midflight = []
    for i in big:
        before = rise_at <= t['elapsed_s'][i]
        midflight.append(dict(
            elapsed_s=float(t['elapsed_s'][i]), dt_ms=float(t['dt_ms'][i]),
            gpu_ms=float(t['gpu_ms'][i]), fresh=int(t['gpu_fresh'][i]),
            riseAt=float(rise_at[before][-1]) if before.any() else None,
            riseD=int(rise_d[before][-1]) if before.any() else 0,
            lagMs=float((t['elapsed_s'][i] - rise_at[before][-1]) * 1000)
            if before.any() else None))

    # ── Spearman, over fresh rows ────────────────────────────────────────────
    rho = {c: spearman(gpu, t[c][fresh]) for c in PRED_COLS if c in t}

    # ── 3. GPU or CPU ────────────────────────────────────────────────────────
    dt, fr, rn, sm = t['dt_ms'], t['frame_ms'], t['render_ms'], t['sim_ms']
    tier = t['tier_ms']
    stats = dict(
        dt=dict(p50=pct(dt, .5), p95=pct(dt, .95), max=float(dt.max())),
        frame=dict(p50=pct(fr, .5), p95=pct(fr, .95), max=float(fr.max())),
        render=dict(p50=pct(rn, .5), p95=pct(rn, .95), max=float(rn.max())),
        sim=dict(p50=pct(sm, .5), p95=pct(sm, .95), max=float(sm.max())),
        gpu=dict(p50=p50, p95=p95, p90=p90, p98=p98, max=float(gpu.max())),
    )
    # the app's own hitch rule, reproduced: dt > (row tier, else header budget) x HITCH_BUDGETS
    thresh = np.where(tier > 0, tier, summary['budgetMs']) * HITCH_BUDGETS
    my_hitches = int((dt > thresh).sum())

    # genuine GPU STALLS — a fresh row half again over the mission's own p95 —
    # named individually, because "is the tail stalls?" deserves a list and not
    # a percentage. And the GPU time ON the five worst dt frames, which is the
    # other half of the same question asked from the frame-time end.
    stall = gpu > 1.5 * p95
    stalls = [dict(elapsed_s=float(e), gpu_ms=float(g), dt_ms=float(d))
              for e, g, d in zip(el[stall], gpu[stall], t['dt_ms'][fresh][stall])]
    worst_dt_idx = np.argsort(-t['dt_ms'])[:5]
    worst_gpu = [dict(elapsed_s=float(t['elapsed_s'][i]), dt_ms=float(t['dt_ms'][i]),
                      gpu_ms=float(t['gpu_ms'][i]), fresh=int(t['gpu_fresh'][i]))
                 for i in worst_dt_idx]

    # does the GPU tail coincide with the dt tail?
    dt_fresh = dt[fresh]
    dt_p95 = pct(dt_fresh, 0.95)
    co = float((dt_fresh[over] > dt_p95).mean()) if tail_n else float('nan')

    return dict(
        mission=mission, env=ENV.get(mission, '?'),
        startedAt=header.get('startedAt'), version=header.get('version'),
        frames=n_all, freshFrames=n_fresh, freshFraction=n_fresh / n_all,
        seconds=summary['seconds'], fps=summary['fps'],
        budgetMs=summary['budgetMs'], budgetSource=summary['budgetSource'],
        summaryGpu=summary['gpu'], summaryGpuFrames=summary['gpuFrames'],
        summaryHitches=summary['hitches'], summaryWorst=summary['worst'],
        stats=stats, gap=gap,
        tailFrames=tail_n,
        tailRuns=len(rl), tailRunMax=int(lengths.max()) if lengths.size else 0,
        tailRunMean=float(lengths.mean()) if lengths.size else 0.0,
        fracInRuns10=in_long / tail_n if tail_n else float('nan'),
        fracIsolated=in_iso / tail_n if tail_n else float('nan'),
        lag1=lag1(gpu),
        excessTop2=top2, excessBand9095=band9095, excessAbove95=above95,
        sustainedP95=sustained_p95, despikedP95=despiked_p95,
        tailFirst10=first10, baseFirst10=first10_base,
        spatialLift=lift, spatialCells=cells_top,
        programs=prog_rows, spearman=rho,
        myHitches=my_hitches, dtP95=dt_p95, tailAlsoDtTail=co,
        overPass=p95 - PASS_MS,
        smoothWindow=w, smoothP50=sm_p50, smoothP95=sm_p95,
        smoothGap=sm_p95 - sm_p50, slowShare=slow_share,
        smoothOverFrames=int(sm_over.sum()),
        smoothRunMax=int(sm_lengths.max()) if sm_lengths.size else 0,
        gpuStalls=stalls, worstDtFrames=worst_gpu, midflightStalls=midflight,
        residSd=resid_sd, residSkew=resid_skew, residLag1=resid_lag1,
        residP=resid_p, residVsDt=resid_vs_dt,
        acf=acf, etaPlace=eta_place, placeCells=n_cells, etaTime=eta_time, timeBins=n_bins,
        fracOver90HzBudget=float((gpu > 11.111).mean()),
        fracOverPass=float((gpu > PASS_MS).mean()),
        medianTris=float(np.median(t['tris'])), medianCalls=float(np.median(t['calls'])),
        _arrays=dict(gpu=gpu, el=el, x=x, z=z, over=over, lengths=lengths,
                     dt=dt, fr=fr, elapsed_all=t['elapsed_s'], smooth=sm_gpu),
    )


# ── plots ────────────────────────────────────────────────────────────────────
def plots(res, out):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    for m, r in res.items():
        a = r['_arrays']
        fig, ax = plt.subplots(figsize=(9, 3.2), dpi=110)
        ax.plot(a['el'], a['gpu'], lw=0.4, color='#88aacc', label='gpu_ms (fresh rows)')
        ax.plot(a['el'], a['smooth'], lw=1.4, color='#332288', zorder=4,
                label=f"1 s moving mean (max {a['smooth'].max():.2f})")
        ax.scatter(a['el'][a['over']], a['gpu'][a['over']], s=4, color='#cc3311',
                   zorder=3, label=f"over p95 ({r['tailFrames']} frames)")
        ax.axhline(r['stats']['gpu']['p95'], color='#cc3311', lw=0.8, ls='--',
                   label=f"p95 {r['stats']['gpu']['p95']:.2f}")
        ax.axhline(r['stats']['gpu']['p50'], color='#000000', lw=0.8, ls=':',
                   label=f"p50 {r['stats']['gpu']['p50']:.2f}")
        ax.axhline(PASS_MS, color='#009988', lw=0.8, label=f'pass {PASS_MS:.2f}')
        ax.set_xlabel('elapsed_s (sim seconds)')
        ax.set_ylabel('gpu_ms')
        ax.set_title(f"{m} ({r['env']}) — GPU along the run, {r['startedAt']}", fontsize=9)
        ax.legend(fontsize=6, ncol=5, loc='upper center')
        ax.set_ylim(0, min(np.nanmax(a['gpu']) * 1.05, r['stats']['gpu']['p95'] * 2.6))
        fig.tight_layout()
        fig.savefig(os.path.join(out, f'{m}-timeline.png'))
        plt.close(fig)

        ok = np.isfinite(a['x']) & np.isfinite(a['z'])
        fig, ax = plt.subplots(figsize=(5.2, 4.6), dpi=110)
        # coloured by the 1 s mean, because the raw column's per-frame jitter is
        # three times any place effect and drowns it; the tail frames go on top
        # as dots, which is the "is it one region" question asked directly.
        lo, hi = pct(a['smooth'], 0.02), pct(a['smooth'], 0.98)
        sc = ax.scatter(a['x'][ok], a['z'][ok], c=a['smooth'][ok], s=5, cmap='viridis',
                        vmin=lo, vmax=hi)
        ax.scatter(a['x'][ok & a['over']], a['z'][ok & a['over']], s=3.5,
                   color='#cc3311', lw=0)
        ax.set_aspect('equal')
        ax.set_xlabel('ship_x (sim space, m)')
        ax.set_ylabel('ship_z (sim space, m)')
        ax.set_title(f'{m} — 1 s mean gpu_ms by place;\nover-p95 frames in red '
                     f"(place explains {r['etaPlace']:.0%} of the variance)", fontsize=9)
        fig.colorbar(sc, ax=ax, label='gpu_ms, 1 s mean')
        fig.tight_layout()
        fig.savefig(os.path.join(out, f'{m}-map.png'))
        plt.close(fig)

    # where the TAIL FRAMES sit, by the length of the run they belong to
    names = [m for m in ORDER if m in res]
    buckets = [(1, 1, '1 frame (isolated)'), (2, 2, '2'), (3, 4, '3-4'),
               (5, 9, '5-9'), (10, 10 ** 9, '10 or more')]
    share = np.zeros((len(names), len(buckets)))
    for i, m in enumerate(names):
        L = res[m]['_arrays']['lengths']
        tot = float(L.sum()) if L.size else 1.0
        for j, (a, b, _) in enumerate(buckets):
            share[i, j] = float(L[(L >= a) & (L <= b)].sum()) / tot
    idx = np.arange(len(names))
    fig, ax = plt.subplots(figsize=(8.6, 4.4), dpi=110)
    left = np.zeros(len(names))
    for j, (_, _, lab) in enumerate(buckets):
        ax.barh(idx, share[:, j], 0.62, left=left, label=lab)
        left += share[:, j]
    ax.set_yticks(idx)
    ax.set_yticklabels([f'{m} ({res[m]["env"]})' for m in names], fontsize=7)
    ax.invert_yaxis()
    ax.set_xlim(0, 1)
    ax.set_xlabel('share of the mission\'s over-p95 frames, by the length of the run it is in')
    ax.set_title('The tail is isolated frames, not sections — no mission puts 7 % of its '
                 'tail in a run of 10', fontsize=10)
    ax.legend(fontsize=7, ncol=5, loc='lower center')
    fig.tight_layout()
    fig.savefig(os.path.join(out, 'runlengths.png'))
    plt.close(fig)

    # Spearman heatmap
    cols = [c for c in PRED_COLS if c in next(iter(res.values()))['spearman']]
    M = np.array([[res[m]['spearman'].get(c, np.nan) for c in cols]
                  for m in ORDER if m in res])
    fig, ax = plt.subplots(figsize=(9.5, 5.2), dpi=110)
    im = ax.imshow(M, cmap='RdBu_r', vmin=-1, vmax=1, aspect='auto')
    ax.set_xticks(range(len(cols)))
    ax.set_xticklabels(cols, rotation=45, ha='right', fontsize=7)
    names = [m for m in ORDER if m in res]
    ax.set_yticks(range(len(names)))
    ax.set_yticklabels([f'{m} ({res[m]["env"]})' for m in names], fontsize=7)
    for i in range(M.shape[0]):
        for j in range(M.shape[1]):
            if np.isfinite(M[i, j]):
                ax.text(j, i, f'{M[i, j]:+.2f}', ha='center', va='center', fontsize=5.5)
    fig.colorbar(im, ax=ax, label='Spearman rho with gpu_ms (fresh rows)')
    ax.set_title('What predicts gpu_ms within a run', fontsize=10)
    fig.tight_layout()
    fig.savefig(os.path.join(out, 'spearman.png'))
    plt.close(fig)

    # regime
    names = [m for m in ORDER if m in res]
    idx = np.arange(len(names))
    fig, ax = plt.subplots(figsize=(8.6, 4.4), dpi=110)
    ax.barh(idx - 0.26, [res[m]['stats']['gpu']['p95'] for m in names], 0.25, label='gpu p95')
    ax.barh(idx, [res[m]['stats']['frame']['p95'] for m in names], 0.25, label='frame p95 (main thread)')
    ax.barh(idx + 0.26, [res[m]['stats']['dt']['p95'] for m in names], 0.25, label='dt p95')
    ax.axvline(PASS_MS, color='#009988', lw=1.0, label=f'pass {PASS_MS:.2f} ms')
    ax.axvline(11.111, color='k', ls='--', lw=0.8, label='90 Hz budget 11.11 ms')
    ax.set_yticks(idx)
    ax.set_yticklabels([f'{m} ({res[m]["env"]})' for m in names], fontsize=7)
    ax.invert_yaxis()
    ax.set_xlabel('ms')
    ax.set_title('GPU, main thread and the frame — which pole is which', fontsize=10)
    ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(out, 'regime.png'))
    plt.close(fig)

    # gap decomposition
    fig, ax = plt.subplots(figsize=(8.6, 4.4), dpi=110)
    top2 = np.array([res[m]['excessTop2'] for m in names])
    band = np.array([res[m]['excessBand9095'] for m in names])
    rest = 1 - top2 - band
    ax.barh(idx, top2, 0.6, label='top 2 % of frames (> p98)')
    ax.barh(idx, band, 0.6, left=top2, label='the 90th-95th band')
    ax.barh(idx, rest, 0.6, left=top2 + band, label='everything else above p50')
    ax.set_yticks(idx)
    ax.set_yticklabels([f'{m} ({res[m]["env"]})' for m in names], fontsize=7)
    ax.invert_yaxis()
    ax.set_xlabel('share of the total excess mass above that mission\'s own GPU p50')
    ax.set_title('Who owns the excess above the median', fontsize=10)
    ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(os.path.join(out, 'gap-decomposition.png'))
    plt.close(fig)


# ── census ───────────────────────────────────────────────────────────────────
def census(census_dir, out_lines):
    files = sorted(f for f in os.listdir(census_dir) if f.endswith('.json'))
    out = {}
    for f in files:
        j = json.load(open(os.path.join(census_dir, f)))
        m = j['mission']
        rows = j['census']['rows']
        out[m] = dict(
            baseTriangles=j['base']['triangles'], baseCalls=j['base']['calls'],
            censusTriangles=j['census']['triangles'], censusCalls=j['census']['calls'],
            shadowTriangles=j['base']['triangles'] - j['census']['triangles'],
            gpuMs=j.get('gpuMs'),
            overdraw=j['census'].get('overdraw', {}),
            rows={r['group']: dict(calls=r['calls'], triangles=r['triangles']) for r in rows},
        )
    groups = sorted({g for c in out.values() for g in c['rows']},
                    key=lambda g: -max(c['rows'].get(g, {'triangles': 0})['triangles']
                                       for c in out.values()))
    out_lines.append('\n=== CENSUS, every group, TRIANGLES (perf-out/census-all, 20 s snapshot) ===')
    out_lines.append(f"{'group':34s} " + ' '.join(f'{m[:11]:>12s}' for m in ORDER if m in out))
    for g in groups:
        out_lines.append(f'{g:34s} ' + ' '.join(
            f"{out[m]['rows'].get(g, {'triangles': 0})['triangles']:12,d}"
            for m in ORDER if m in out))
    out_lines.append(f"{'--- census total':34s} " + ' '.join(
        f"{out[m]['censusTriangles']:12,d}" for m in ORDER if m in out))
    out_lines.append(f"{'--- base (incl. shadow pass)':34s} " + ' '.join(
        f"{out[m]['baseTriangles']:12,d}" for m in ORDER if m in out))
    out_lines.append(f"{'--- shadow-only (base - census)':34s} " + ' '.join(
        f"{out[m]['shadowTriangles']:12,d}" for m in ORDER if m in out))
    out_lines.append(f"{'--- census CALLS':34s} " + ' '.join(
        f"{out[m]['censusCalls']:12,d}" for m in ORDER if m in out))
    out_lines.append(f"{'--- overdraw shadedOpaque':34s} " + ' '.join(
        f"{out[m]['overdraw'].get('shadedOpaque', float('nan')):12.2f}"
        for m in ORDER if m in out))
    out_lines.append(f"{'--- overdraw issuedOpaque':34s} " + ' '.join(
        f"{out[m]['overdraw'].get('issuedOpaque', float('nan')):12.2f}"
        for m in ORDER if m in out))

    out_lines.append('\n=== CENSUS (perf-out/census-all, 20 s snapshot) ===')
    out_lines.append(f"{'mission':24s} {'base tris':>11s} {'census tris':>12s} "
                     f"{'shadow tris':>12s} {'calls':>6s}   top groups by triangles")
    for m in ORDER:
        if m not in out:
            continue
        c = out[m]
        top = sorted(c['rows'].items(), key=lambda kv: -kv[1]['triangles'])[:4]
        desc = '  '.join(f"{g}={v['triangles'] / 1e6:.2f}M/{v['calls']}c" for g, v in top)
        out_lines.append(f"{m:24s} {c['baseTriangles']:11,d} {c['censusTriangles']:12,d} "
                         f"{c['shadowTriangles']:12,d} {c['baseCalls']:6d}   {desc}")
    return out


# ── main ─────────────────────────────────────────────────────────────────────
def spread(r):
    """The robust two-sided jitter: residual p95 minus residual p05, ms.

    Preferred to the sd everywhere in the arm tables, because several arms carry
    ONE colossal frame (skew 21-48) and the sd is then a statement about that
    frame. `03-no-sky` reads sd 1.97 against a baseline 1.16 and a SPREAD
    identical to the baseline's — the sd is the outlier, not the arm.
    """
    return r['residP'][0.95] - r['residP'][0.05]


def arm_kind(name):
    """SOLO — the stage was emptied and at most one group put back (`empty-stage`,
    `only-*`). COMPOSITE — the whole scene, with at most one group taken away.

    A naming rule, stated rather than inferred, and it is the variable the arms
    turn out to separate on. Note it classifies `floor-sweep`'s broken
    `02-empty-stage` as solo, which is right for the wrong reason: that arm's
    hide failed and it drew the residue island, i.e. one thing rather than none.
    """
    n = name.split('-', 1)[-1]
    return 'solo' if n.startswith('only-') or n == 'empty-stage' else 'composite'


def arms_report(sweeps, out, no_plots):
    """The residual method over a floor-sweep's arms. `sweeps` is [(label, res), ...].

    The question it exists to answer: a frame that draws NOTHING — DEV-231's
    verified empty stage — either carries the same per-frame residual as a full
    scene, in which case the disturbance is the timer or the compositor, or it
    does not, in which case the residual belongs to the work.
    """
    lines = []
    for label, res in sweeps:
        lines.append(f'\n=== FLOOR SWEEP {label} — {len(res)} arms ===')
        lines.append(f"{'arm':20s} {'kind':10s} {'gpu p50':>8s} {'gpu p95':>8s} {'gap':>6s} "
                     f"{'resid sd':>9s} {'SPREAD':>7s} {'skew':>6s} {'lag-1':>6s} "
                     f"{'rho dt':>7s} {'sm p95':>7s} {'fresh':>7s}")
        for a, r in res.items():
            g = r['stats']['gpu']
            lines.append(f"{a:20s} {arm_kind(a):10s} {g['p50']:8.2f} {g['p95']:8.2f} "
                         f"{r['gap']:6.2f} {r['residSd']:9.2f} {spread(r):7.2f} "
                         f"{r['residSkew']:6.2f} {r['residLag1']:6.2f} {r['residVsDt']:7.2f} "
                         f"{r['smoothP95']:7.2f} {r['freshFrames']:7d}")
        lines.append('  SPREAD is the residual p95 minus its p05 — the robust two-sided '
                     'jitter, which `sd` overstates wherever `skew` is large (one frame).')
        for kind in ('composite', 'solo'):
            sel = {a: r for a, r in res.items() if arm_kind(a) == kind}
            if not sel:
                continue
            p50 = np.array([r['stats']['gpu']['p50'] for r in sel.values()])
            sp = np.array([spread(r) for r in sel.values()])
            lines.append(f"  {kind:10s} n={len(sel):2d}  gpu p50 {p50.min():.2f}-{p50.max():.2f} "
                         f"({p50.max() / max(p50.min(), 1e-9):.1f}x)  "
                         f"SPREAD {sp.min():.2f}-{sp.max():.2f} "
                         f"({sp.max() / max(sp.min(), 1e-9):.1f}x)")
        p50 = np.array([r['stats']['gpu']['p50'] for r in res.values()])
        sp = np.array([spread(r) for r in res.values()])
        if p50.size > 2:
            rho = float(np.corrcoef(p50, sp)[0, 1])
            b, a = np.polyfit(p50, sp, 1)
            lines.append(f"  ALL arms together: rho(p50, SPREAD) = {rho:+.3f}, "
                         f"least squares {a:.3f} + {b:.3f} x p50 — but the two kinds are "
                         f"disjoint clusters, so a single line through them is a bad model.")

    text = '\n'.join(lines)
    print(text)
    with open(os.path.join(out, 'tail-arms-report.txt'), 'w') as f:
        f.write(text + '\n')

    md = ['| sweep | arm | kind | gpu p50 | gpu p95 | gap | resid sd | resid spread | lag-1 |',
          '|---|---|---|---|---|---|---|---|---|']
    for label, res in sweeps:
        for a, r in res.items():
            g = r['stats']['gpu']
            md.append(f"| {label} | {a} | {arm_kind(a)} | {g['p50']:.2f} | {g['p95']:.2f} | "
                      f"{r['gap']:.2f} | {r['residSd']:.2f} | {spread(r):.2f} | "
                      f"{r['residLag1']:+.2f} |")
    with open(os.path.join(out, 'tail-arms.md'), 'w') as f:
        f.write('\n'.join(md) + '\n')

    with open(os.path.join(out, 'tail-arms.json'), 'w') as f:
        json.dump({label: {a: {k: v for k, v in r.items() if k != '_arrays'}
                           for a, r in res.items()} for label, res in sweeps},
                  f, indent=1, default=float)

    if no_plots:
        return
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(8.2, 5.0), dpi=110)
    colour = {'composite': '#cc3311', 'solo': '#0077bb'}
    for (label, res), mk in zip(sweeps, ['o', '^']):
        for kind in ('composite', 'solo'):
            sel = {a: r for a, r in res.items() if arm_kind(a) == kind}
            if not sel:
                continue
            p50 = np.array([r['stats']['gpu']['p50'] for r in sel.values()])
            sp = np.array([spread(r) for r in sel.values()])
            ax.scatter(p50, sp, s=40, marker=mk, color=colour[kind],
                       label=f'{label} · {kind}')
            for a, x, y in zip(sel.keys(), p50, sp):
                ax.annotate(a.split('-', 1)[-1], (x, y), fontsize=5.5,
                            xytext=(3, 3), textcoords='offset points')
    ax.set_xlabel("that arm's GPU p50 (ms)")
    ax.set_ylabel('per-frame jitter: residual p95 − p05 (ms)')
    ax.set_title('A frame that draws NOTHING does not carry the jitter — and the jitter\n'
                 'does not scale with the work either. Two clusters, not one line.',
                 fontsize=10)
    ax.legend(fontsize=7)
    ax.set_xlim(left=0)
    ax.set_ylim(bottom=0)
    ax.grid(alpha=0.2)
    fig.tight_layout()
    fig.savefig(os.path.join(out, 'arms-residual.png'))
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', default=os.path.join('perf-out', 'truesize'))
    ap.add_argument('--out', default=os.path.join('perf-out', 'tail-analysis'))
    ap.add_argument('--census', default=os.path.join('perf-out', 'census-all'))
    ap.add_argument('--verify', action='store_true',
                    help='assert the CSV-derived stats match the app-written summary.json')
    ap.add_argument('--no-plots', action='store_true')
    ap.add_argument('--arms', action='append', default=None, metavar='DIR',
                    help='a FLOOR-SWEEP directory (<dir>/<NN-arm>/*.trace.csv). Repeatable. '
                         'Runs the residual method per arm instead of the 13-mission report.')
    args = ap.parse_args()

    if args.arms:
        os.makedirs(args.out, exist_ok=True)
        sweeps = []
        for d in args.arms:
            found = find_arms(d)
            if not found:
                sys.exit(f'no traces under {d}')
            sweeps.append((os.path.basename(os.path.normpath(d)),
                           {a: analyse(a, c, s) for a, (c, s) in found.items()}))
        arms_report(sweeps, args.out, args.no_plots)
        print(f'\nwritten to {args.out}')
        return

    os.makedirs(args.out, exist_ok=True)
    found = find_runs(args.run)
    if not found:
        sys.exit(f'no traces under {args.run}')

    res, lines = {}, []
    for m, (csvp, sump) in found.items():
        res[m] = analyse(m, csvp, sump)

    # ── verification: the CSV is rounded to 2 dp, the summary is not ─────────
    lines.append(f'=== RUN {args.run} — {len(res)} missions ===')
    lines.append(f"{'mission':24s} {'csv p50':>8s} {'sum p50':>8s} {'csv p95':>8s} "
                 f"{'sum p95':>8s} {'10.2 p50':>9s} {'10.2 p95':>9s}  started")
    worst_d = 0.0
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        s = r['summaryGpu']
        d = max(abs(r['stats']['gpu']['p50'] - s['p50']), abs(r['stats']['gpu']['p95'] - s['p95']))
        worst_d = max(worst_d, d)
        w = WAVE3_10_2.get(m, (float('nan'), float('nan')))
        lines.append(f"{m:24s} {r['stats']['gpu']['p50']:8.3f} {s['p50']:8.3f} "
                     f"{r['stats']['gpu']['p95']:8.3f} {s['p95']:8.3f} {w[0]:9.2f} {w[1]:9.2f}  "
                     f"{r['startedAt']}")
    lines.append(f'worst CSV-vs-summary disagreement on any p50/p95: {worst_d:.4f} ms '
                 f'(the CSV writes gpu_ms to 2 dp; the summary does not round)')
    if args.verify and worst_d > 0.02:
        sys.exit(f'CSV and summary disagree by {worst_d:.4f} ms')

    # ── the table ────────────────────────────────────────────────────────────
    lines.append('\n=== PER-MISSION TAIL TABLE ===')
    hdr = (f"{'mission':22s} {'env':8s} {'p50':>6s} {'p95':>6s} {'gap':>6s} {'tail':>5s} "
           f"{'runs':>5s} {'>=10':>6s} {'<=2':>6s} {'lag1':>6s} {'sustP95':>8s} "
           f"{'dtP95':>7s} {'frP95':>6s} {'regime':>8s}  top predictor")
    lines.append(hdr)
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        g = r['stats']['gpu']
        rho = {k: v for k, v in r['spearman'].items()
               if k not in ('dt_ms', 'frame_ms', 'render_ms') and np.isfinite(v)}
        top = max(rho.items(), key=lambda kv: abs(kv[1])) if rho else ('-', float('nan'))
        lines.append(
            f"{m:22s} {r['env']:8s} {g['p50']:6.2f} {g['p95']:6.2f} {r['gap']:6.2f} "
            f"{r['tailFrames']:5d} {r['tailRuns']:5d} {r['fracInRuns10']:6.1%} "
            f"{r['fracIsolated']:6.1%} {r['lag1']:6.2f} {r['sustainedP95']:8.2f} "
            f"{r['stats']['dt']['p95']:7.2f} {r['stats']['frame']['p95']:6.2f} "
            f"{regime(r):>8s}  {top[0]} {top[1]:+.2f}")

    # ── the same question at a second timescale ──────────────────────────────
    lines.append('\n=== SUSTAINED SECTION? the same column, smoothed over 1 s ===')
    lines.append(f"{'mission':22s} {'raw gap':>8s} {'sm p50':>7s} {'sm p95':>7s} {'sm gap':>7s} "
                 f"{'slow var share':>15s} {'sm frames > raw p95':>20s} {'longest':>8s} "
                 f"{'acf(1)':>7s} {'acf(10)':>8s} {'acf(75)':>8s}")
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        lines.append(f"{m:22s} {r['gap']:8.2f} {r['smoothP50']:7.2f} {r['smoothP95']:7.2f} "
                     f"{r['smoothGap']:7.2f} {r['slowShare']:15.1%} "
                     f"{r['smoothOverFrames']:20d} {r['smoothRunMax']:8d} "
                     f"{r['acf']['1']:7.2f} {r['acf']['10']:8.2f} {r['acf']['75']:8.2f}")

    lines.append('\n=== THE FAST HALF ALONE: gpu_ms minus its own 1 s mean ===')
    lines.append(f"{'mission':22s} {'sd':>6s} {'skew':>6s} {'lag-1':>6s} {'p05':>7s} {'p95':>6s} "
                 f"{'p99':>6s} {'rho with dt_ms':>15s} {'raw p95':>8s} {'smoothed p95':>13s} "
                 f"{'jitter in p95':>14s}")
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        lines.append(f"{m:22s} {r['residSd']:6.2f} {r['residSkew']:6.2f} {r['residLag1']:6.2f} "
                     f"{r['residP'][0.05]:7.2f} {r['residP'][0.95]:6.2f} {r['residP'][0.99]:6.2f} "
                     f"{r['residVsDt']:15.2f} {r['stats']['gpu']['p95']:8.2f} "
                     f"{r['smoothP95']:13.2f} {r['stats']['gpu']['p95'] - r['smoothP95']:14.2f}")

    lines.append('\n=== VARIANCE OF gpu_ms: is it PLACE, is it TIME, or is it neither? ===')
    lines.append(f"{'mission':22s} {'eta2 place (256 m cells)':>25s} {'cells':>6s} "
                 f"{'eta2 time (1 s bins)':>21s} {'bins':>5s} {'residual':>9s}")
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        lines.append(f"{m:22s} {r['etaPlace']:25.1%} {r['placeCells']:6d} "
                     f"{r['etaTime']:21.1%} {r['timeBins']:5d} {1 - r['etaTime']:9.1%}")

    lines.append('\n=== REGIME (perf-protocol section 4) ===')
    lines.append(f"{'mission':22s} {'gpu p50':>8s} {'gpu p95':>8s} {'frame p95':>10s} "
                 f"{'dt p50':>7s} {'dt p95':>7s} {'fps':>6s} {'gpu > 11.11':>12s} "
                 f"{'gpu > pass':>11s} {'regime':>10s}")
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        g, s = r['stats']['gpu'], r['stats']
        lines.append(f"{m:22s} {g['p50']:8.2f} {g['p95']:8.2f} {s['frame']['p95']:10.2f} "
                     f"{s['dt']['p50']:7.2f} {s['dt']['p95']:7.2f} {r['fps']:6.1f} "
                     f"{r['fracOver90HzBudget']:12.2%} {r['fracOverPass']:11.1%} "
                     f"{regime(r):>10s}")

    # ── where ────────────────────────────────────────────────────────────────
    lines.append('\n=== WHERE THE TAIL IS ===')
    lines.append(f"{'mission':22s} {'tail in first 10 s':>19s} {'(all frames)':>13s} "
                 f"{'spatial lift':>13s} {'cells':>6s} {'prog rises':>11s} "
                 f"{'also dt-tail':>13s}")
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        lines.append(f"{m:22s} {r['tailFirst10']:19.1%} {r['baseFirst10']:13.1%} "
                     f"{r['spatialLift']:13.2f} {r['spatialCells']:6d} "
                     f"{r['programs']['n']:11d} {r['tailAlsoDtTail']:13.1%}")

    lines.append('\n=== EXCESS MASS ABOVE THE MISSION\'S OWN GPU p50 ===')
    lines.append(f"{'mission':22s} {'> p98 (top 2 %)':>16s} {'p90-p95 band':>14s} "
                 f"{'> p95 total':>12s} {'p98-p95':>8s} {'p95-p90':>8s}")
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        g = r['stats']['gpu']
        lines.append(f"{m:22s} {r['excessTop2']:16.1%} {r['excessBand9095']:14.1%} "
                     f"{r['excessAbove95']:12.1%} {g['p98'] - g['p95']:8.2f} "
                     f"{g['p95'] - g['p90']:8.2f}")

    lines.append('\n=== HITCHES: the app\'s count against the same rule recomputed ===')
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        w = r['summaryWorst'][0] if r['summaryWorst'] else {}
        lines.append(f"{m:22s} summary {r['summaryHitches']:4d}  recomputed {r['myHitches']:4d}  "
                     f"worst dt {w.get('dtMs', float('nan')):8.1f} ms at "
                     f"{w.get('elapsedSeconds', float('nan')):6.2f} s, "
                     f"programs {w.get('programs', -1)}")

    lines.append('\n=== IS THE TAIL STALLS? fresh rows above 1.5 x the mission\'s own GPU p95 ===')
    for m in ORDER:
        if m not in res:
            continue
        s = res[m]['gpuStalls']
        det = '; '.join(f"{v['elapsed_s']:.2f}s gpu {v['gpu_ms']:.1f} dt {v['dt_ms']:.1f}"
                        for v in s[:6])
        lines.append(f"{m:22s} {len(s):3d} of {res[m]['freshFrames']:5d} fresh  {det}")

    lines.append('\n=== ... AND FROM THE OTHER END: the GPU time on the five worst dt frames ===')
    for m in ORDER:
        if m not in res:
            continue
        det = '; '.join(f"dt {v['dt_ms']:.0f} at {v['elapsed_s']:.2f}s -> gpu {v['gpu_ms']:.1f}"
                        f"{'' if v['fresh'] else ' (stale)'}"
                        for v in res[m]['worstDtFrames'])
        lines.append(f'{m:22s} {det}')

    lines.append('\n=== MID-FLIGHT STALLS (dt > 60 ms after 3 s) and the rise that PRECEDED them ===')
    any_mid = False
    for m in ORDER:
        if m not in res:
            continue
        for v in res[m]['midflightStalls']:
            any_mid = True
            lag = ('none in the trace' if v['lagMs'] is None
                   else f"+{v['riseD']} at {v['riseAt']:.2f}s, {v['lagMs']:.0f} ms earlier")
            lines.append(f"{m:22s} {v['elapsed_s']:7.2f}s  dt {v['dt_ms']:6.1f}  "
                         f"gpu {v['gpu_ms']:5.1f}{'' if v['fresh'] else '*'}  {lag}")
    if not any_mid:
        lines.append('  (none in this run)')

    lines.append('\n=== PROGRAM RISES (a compile candidate), per mission ===')
    for m in ORDER:
        if m not in res:
            continue
        p = res[m]['programs']
        if p['n'] == 0:
            lines.append(f'{m:22s} none')
            continue
        det = '; '.join(f"+{d} at {e:.2f}s gpu {g:.2f} dt {t:.1f}"
                        for d, e, g, t in zip(p['d'], p['elapsed_s'], p['gpu_ms'], p['dt_ms']))
        lines.append(f"{m:22s} {p['n']:3d}  {det}")

    # ── Spearman, pooled ─────────────────────────────────────────────────────
    lines.append('\n=== SPEARMAN rho(gpu_ms, column) over fresh rows ===')
    cols = PRED_COLS
    lines.append(f"{'mission':22s} " + ' '.join(f'{c:>13s}' for c in cols))
    for m in ORDER:
        if m not in res:
            continue
        lines.append(f'{m:22s} ' + ' '.join(
            f"{res[m]['spearman'].get(c, float('nan')):13.2f}" for c in cols))
    lines.append(f"{'MEAN across 13':22s} " + ' '.join(
        f"{np.nanmean([res[m]['spearman'].get(c, np.nan) for m in res]):13.2f}" for c in cols))

    lines.append('\n=== WHAT THE FLYING TRACE ITSELF SAYS ABOUT SCENE SIZE ===')
    lines.append(f"{'mission':22s} {'env':8s} {'median tris':>12s} {'median calls':>13s} "
                 f"{'gpu p50':>8s} {'gpu p95':>8s} {'us per 1k tris (p50)':>21s}")
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        lines.append(f"{m:22s} {r['env']:8s} {r['medianTris']:12,.0f} {r['medianCalls']:13,.0f} "
                     f"{r['stats']['gpu']['p50']:8.2f} {r['stats']['gpu']['p95']:8.2f} "
                     f"{1000 * r['stats']['gpu']['p50'] / (r['medianTris'] / 1000):21.2f}")

    cen = None
    if os.path.isdir(args.census):
        cen = census(args.census, lines)

    text = '\n'.join(lines)
    print(text)
    with open(os.path.join(args.out, 'tail-report.txt'), 'w') as f:
        f.write(text + '\n')

    # markdown table for the doc
    md = ['| mission | env | p50 | p95 | gap | tail frames | in runs >= 10 | sustained p95 '
          '| top predictor | regime |', '|---|---|---|---|---|---|---|---|---|---|']
    for m in ORDER:
        if m not in res:
            continue
        r = res[m]
        g = r['stats']['gpu']
        rho = {k: v for k, v in r['spearman'].items()
               if k not in ('dt_ms', 'frame_ms', 'render_ms') and np.isfinite(v)}
        top = max(rho.items(), key=lambda kv: abs(kv[1])) if rho else ('-', float('nan'))
        md.append(f"| {m} | {r['env']} | {g['p50']:.2f} | {g['p95']:.2f} | {r['gap']:.2f} | "
                  f"{r['tailFrames']} | {r['fracInRuns10']:.0%} | {r['sustainedP95']:.2f} | "
                  f"{top[0]} {top[1]:+.2f} | {regime(r)} |")
    with open(os.path.join(args.out, 'tail-table.md'), 'w') as f:
        f.write('\n'.join(md) + '\n')

    out_json = {m: {k: v for k, v in r.items() if k != '_arrays'} for m, r in res.items()}
    if cen:
        out_json['_census'] = cen
    with open(os.path.join(args.out, 'tail-metrics.json'), 'w') as f:
        json.dump(out_json, f, indent=1, default=float)

    if not args.no_plots:
        plots(res, args.out)
    print(f'\nwritten to {args.out}')


def regime(r):
    """perf-protocol section 4's table, as a rule rather than a feeling.

    COMPOSITOR — dt p50 sits well above BOTH poles (> 1.25 x the larger of gpu
                 p95 and frame p95): the frame is being paced by something that
                 is neither the GPU nor the main thread.
    GPU        — gpu p95 >= frame p95 and dt p50 <= 1.25 x gpu p95.
    CPU        — frame p95 > gpu p95 and dt p50 <= 1.25 x frame p95.

    The second word is which POLE is longer regardless of the pacing, because
    that is what decides the worn 90 Hz question the pass rule asks.
    """
    g, f, d = r['stats']['gpu']['p95'], r['stats']['frame']['p95'], r['stats']['dt']['p50']
    pole = 'GPU' if g >= f else 'CPU'
    if d > 1.25 * max(g, f):
        return f'comp/{pole}'
    return pole


if __name__ == '__main__':
    main()
