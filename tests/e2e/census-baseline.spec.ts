/**
 * tests/e2e/census-baseline.spec.ts — the frame draws what it drew. DEV-160 H2.
 *
 * ── The only real GATE in Part 1 ─────────────────────────────────────────
 *
 * `render-census.spec.ts` prints, `bloom-perf.spec.ts` prints, `perf-trace.
 * spec.ts` prints. This one FAILS. What it gates is a MECHANISM and never a
 * millisecond: the frame's draw-call count, and the triangle counts of the
 * groups that are deterministic on a frozen tick.
 *
 * The gap it closes is real and measured. Between DEV-118 and `9aea977`,
 * `int_01` Anniversary went from 270 draw calls to 321 — fifty-one calls, and
 * nothing in the suite noticed, because nothing in the suite had ever counted.
 * Fifty-one calls on a monitor is a rounding error; **in stereo it is a
 * hundred and two submissions** against PORT_PLAN M3's "≤ 120 per eye" exit.
 *
 *   # WRITE the baseline (a decision — see below)
 *   CENSUS_BASELINE_WRITE=1 E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/census-baseline.spec.ts --workers 1
 *   # GATE against it
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/census-baseline.spec.ts --workers 1
 *
 * `@gpu`, hydrated assets, a real compiler. **By hand, before a tag** — the
 * standing pattern is `ride-hitch.spec.ts`'s, and `pnpm e2e` never runs in CI.
 *
 * ── The tick has to MATCH, and the FIRST key I chose was the wrong one ───
 *
 * `?snap=<s>` fires on the first fixed step where mission elapsed >= s. The
 * first version of this file keyed on `__ff2perf.sim().tick` and **it did not
 * work, measured**: the baseline wrote `int_01` at 3380 and three fresh loads
 * of the same build saw 3362, 3360, 3362; `rookie_01` wrote 3350 and saw
 * 3362, 3341, 3343. Both skipped. `sim().tick` counts from BOOT, so it carries
 * the launch ride, whose wall-clock length moves by ~20 ticks between loads.
 * More retries would have bought lottery tickets, not a gate.
 *
 * The MISSION step index is what `?snap=` pins, and `fixtures/freeze.ts`'s
 * `missionTickOf` derives it. The boot tick is still recorded and printed,
 * because its spread is the evidence for all of the above and a future reader
 * should be able to see it rather than take this paragraph's word.
 *
 * **It pins the index to TWO adjacent values, not one**, and that is measured
 * too — this paragraph first said "the same integer on every load" and the
 * very first green run disproved it. `int_01` matched 1640 on one load;
 * `rookie_01` wanted 1641 and saw 1640, 1640, 1641 over three. The residual is
 * one fixed step: `elapsed` reads 20.008 s (1640 x dt) or 20.020 s (1641 x
 * dt), depending on whether the frame that crossed the mark ran one step or
 * two. That is exactly the two-tick bound the brief predicted — the brief had
 * it on the right mechanism and this file had it on the wrong clock.
 *
 * So the retry is doing real work rather than standing by: at ~1/2 a load,
 * `MAX_ATTEMPTS` loads leaves a 2^-N chance of a skip. If it never matches,
 * print what was reached and `test.skip` with the reason. **A printed
 * non-result, not a red** — a gate that goes red for reasons it does not gate
 * is a gate somebody deletes. That branch has already earned its place twice:
 * it is what printed the boot-tick spreads above instead of a bare failure.
 *
 * ── What is gated, and what is only printed ──────────────────────────────
 *
 * The same skipped run answered this too, and more precisely than the plan
 * did. `int_01`'s frame at tick 3362 against its baseline at 3380 — eighteen
 * sim steps apart — differed in **exactly one group**: `clouds`, 9 calls /
 * 12k against 8 / 10k. Props, ocean, chunks (187 both), dressing, rings, sky,
 * hoverjet, turn-indicators, horizon-geo, racers, particle-fx and motes were
 * identical. `rookie_01` at 3343 against 3350 was identical in every group.
 *
 * So the frozen frame is far more deterministic than the brief assumed, and
 * the volatile set is smaller and different:
 *
 * GATED, exact:
 *   * the total `calls` OF THE GATED GROUPS — not `census.calls`, which
 *     includes the volatile ones and would fail on a drifting cloud;
 *   * the SET of groups — one appearing or disappearing with zero calls would
 *     otherwise slip past a total;
 *   * every gated group's `calls`, `world-terrain/chunks` included: a LOD fade
 *     holds two meshes, but it starts on a SIM-driven swap and finishes long
 *     before the census runs 5 s after the freeze. Held 187 and 39 across four
 *     loads at two ticks each.
 *   * `triangles` for the groups whose geometry is instanced or static: the
 *     prop pass, the ocean, the environment dressing, the rings, the sky dome.
 *
 * PRINTED, never gated — `VOLATILE_GROUPS`:
 *   * `clouds`, which is the one that actually moved, and `particle-fx` and
 *     `motes` beside it. All three run on the RENDER clock, and `?snap=`
 *     freezes the sim and not the wall clock (`src/boot/snap.ts` says so).
 *   * `world-terrain/chunks` triangles — gated on calls, printed on triangles,
 *     because a fade that IS in flight changes the count without changing the
 *     draw.
 *   * the overdraw figures, which are a measurement rather than a count.
 *
 * Group names are matched by PREFIX, because the environment is suffixed onto
 * some of them: `world-terrain/props:simonet`, `world-terrain/props:alpine`,
 * `world-terrain/dressing:simonet`, and so on.
 *
 * ── Re-baselining is a DECISION ──────────────────────────────────────────
 *
 * `CENSUS_BASELINE_WRITE=1`, plus a line in the DEV row saying what changed
 * the frame. That is the whole ceremony and it is the point: **a number that
 * updates itself is not a baseline.** Each entry carries the build and the
 * date it was taken on, so a stale one says so.
 *
 * ── DEV-909: every mission, a tier, and an overdraw budget ───────────────
 *
 * Covers every mission a player reaches in Anniversary (derived, see
 * `fixtures/census-missions.ts`; 17 at writing). BEHAVIOUR tier: the default
 * run takes the fast subset (one mission per environment, aircraft and mode),
 * `CENSUS_SWEEP=all` takes all of them (`batch-gate.sh release` sets it, and
 * `batch` names the subset). Wall time on the author's box: 32 to 58 s a
 * mission, 14 to 16 min for all seventeen.
 *
 *   # re-stamp ONE mission, or a list, or `all`; a bare `1` is refused
 *   CENSUS_BASELINE_WRITE=int_01_hoverJet E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/census-baseline.spec.ts --workers 1
 *
 * Shaded overdraw (opaque and total) is gated at 1 %. Four readings of every
 * mission (the write and three repeat sweeps, pinned `adaptive=0&quality=high`,
 * same floor tick) spread by at most 0.25 % (median about 0.1 %, several
 * missions 0.00 %); 1 % is four times the worst, and a layer that matters is
 * ten times that. King-tide's lease was not recorded for the first two sweeps;
 * it was HELD for the third.
 */

import fs from 'node:fs'
import path from 'node:path'
import { snapFloorTick } from '../../src/boot/snap'
import { censusMissions, censusSelection } from './fixtures/census-missions'
import { type FrozenSim, flyToFreeze, frozenSim, missionTickOf } from './fixtures/freeze'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const BASELINE_PATH = 'tools/perf/census-baseline.json'
/**
 * `CENSUS_BASELINE_WRITE` names WHAT to write: `all`, or a comma list of
 * mission ids. The old `1` is refused (DEV-909): it restamped every entry the
 * run happened to reach, which is how KR-01 and KR-02 sat red for weeks, since
 * nobody dared re-stamp two missions at the cost of the rest. A write touches
 * only the entries it names, and leaves every other key byte for byte alone.
 */
const WRITE_ENV = process.env.CENSUS_BASELINE_WRITE ?? ''
const WRITE = WRITE_ENV !== ''
const WRITE_IDS: ReadonlySet<string> | 'all' =
  WRITE_ENV === 'all' ? 'all' : new Set(WRITE_ENV.split(',').map((x) => x.trim()))
const SNAP_AT = Number(process.env.CENSUS_BASELINE_AT ?? '20')

/**
 * Loads allowed while hunting for the baseline's mission tick. Each one is a
 * whole flight — ~50 s on `int_01`, ~45 s on `rookie_01`.
 *
 * FIVE, from the measurement in the header rather than from taste: the mission
 * index lands on one of two adjacent values, so a load has about an even
 * chance and five leaves roughly a 3 % skip. Three was the first value here and
 * the first green run needed all three of them on `rookie_01`, which is a 12 %
 * skip rate — high enough that somebody would eventually read a skip as noise
 * and stop looking at it.
 *
 * **If this ever needs raising again, the KEY is wrong, not the count.** That
 * is what happened at `sim().tick`, and the fix was a different number to match
 * on, not more tries at the same one.
 */
const MAX_ATTEMPTS = 5

/**
 * The runs the baseline covers: every mission a player reaches in Anniversary
 * (`fixtures/census-missions.ts`, derived from content), all of them when
 * `CENSUS_SWEEP=all` (the release gate sets it) and the fast subset otherwise.
 * When a write names missions, those are the runs, whatever the sweep says.
 * Anniversary only: Classic draws a strict subset of the same scene, so a
 * Classic regression that this would catch is one Anniversary catches first.
 */
const ALL = censusMissions()
const RUNS = (
  WRITE && WRITE_IDS !== 'all'
    ? ALL.filter((m) => WRITE_IDS.has(m.id))
    : censusSelection(WRITE && WRITE_IDS === 'all' ? 'all' : process.env.CENSUS_SWEEP, ALL)
).map((m) => ({ mission: m.id, edition: 'anniversary' }))

/**
 * The pin, and the reason it is here (DEV-909): overdraw is immune to a
 * starved box only if the quality tier cannot move under it. `render/quality.ts`
 * walks the pixel count and drops a tier on a starved frame, and a frame at a
 * different pixel count shades a different amount.
 */
const PIN = { adaptive: '0', quality: 'high' } as const

/**
 * Relative tolerance on the two SHADED overdraw figures (opaque and total).
 * Taken from repeat runs, not from taste: the spread is in the DEV-909 section
 * of the header, and the budget is that spread with headroom, so a real
 * regression in what the GPU shades is red and a render-clock cloud is not.
 */
const OVERDRAW_TOLERANCE = 0.01

/**
 * The culling edge (DEV-909). The two HoverJet missions with racers drew one
 * chunk call more or fewer (212 against 213) and 0.3 % different prop
 * triangles (466,671 against 468,017) on two loads of one build at one floor
 * tick: a chunk or a prop sitting on the frustum edge, because the camera
 * rides the render clock and the racers' own LOD/cull do too. So the groups a
 * frustum cull decides get one call and 1 % of triangles of slack; every other
 * group, the group SET and the overdraw budget stay as tight as before. The
 * regressions this exists for are fifty draws, not one.
 */
const CULL_EDGE_GROUPS = ['world-terrain/chunks', 'world-terrain/props'] as const
const CULL_EDGE_CALLS = 1
const CULL_EDGE_TRIANGLES = 0.01
const isCullEdge = (group: string): boolean => CULL_EDGE_GROUPS.some((g) => group.startsWith(g))

/**
 * Groups whose triangle count is a property of the SCENE rather than of the
 * moment. Prefixes — two of them carry the environment as a suffix.
 */
const DETERMINISTIC_TRIANGLES = [
  'world-terrain/props',
  'world-ocean',
  'world-terrain/dressing',
  'rings',
  'sky-dome',
] as const

/**
 * Groups driven by the RENDER clock, which `?snap=` does not freeze. Printed,
 * never gated — neither calls nor triangles.
 *
 * `clouds` is here because it was MEASURED moving (9 calls / 12k against 8 /
 * 10k, eighteen sim steps apart on one build); the other two are here because
 * they are the same kind of thing and it would be odd to wait for each to
 * prove it. Everything not listed is gated on calls.
 */
const VOLATILE_GROUPS = ['clouds', 'particle-fx', 'motes'] as const

interface Row {
  readonly group: string
  readonly calls: number
  readonly triangles: number
  readonly transparentCalls: number
}

interface Census {
  readonly calls: number
  readonly triangles: number
  readonly programs: number
  readonly rows: readonly Row[]
  readonly overdraw: { issued: number; shaded: number; shadedOpaque: number }
}

interface Entry {
  readonly mission: string
  readonly edition: string
  readonly snapAt: number
  /** The MISSION step index — what is matched. Deterministic; see the header. */
  readonly missionTick: number
  /** Steps since BOOT. Recorded and printed, never matched: the ride is in it. */
  readonly bootTick: number
  /** Mission seconds at the freeze, for reading `missionTick` back by eye. */
  readonly elapsed: number
  /** `calls` summed over the GATED groups only. */
  readonly gatedCalls: number
  /** `census.calls`, volatile groups included. Recorded for context, not gated. */
  readonly totalCalls: number
  readonly triangles: number
  readonly groups: Record<string, { calls: number; triangles: number }>
  /** SHADED overdraw at the frozen frame, pinned: the figures the budget gates. */
  readonly overdraw: { readonly shaded: number; readonly shadedOpaque: number }
  readonly build: string
  readonly date: string
}

const readBaselines = (): Record<string, Entry> =>
  fs.existsSync(BASELINE_PATH)
    ? (JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Record<string, Entry>)
    : {}

const census = (page: Page): Promise<Census> =>
  page.evaluate(() =>
    (globalThis as unknown as { __ff2perf: { census: () => Census } }).__ff2perf.census(),
  )

const isVolatile = (group: string): boolean =>
  VOLATILE_GROUPS.some((v) => group === v || group.startsWith(`${v}:`))

/** Draw calls over the gated groups only — the number the gate compares. */
const gatedCallsOf = (rows: readonly Row[]): number =>
  rows.reduce((n, r) => (isVolatile(r.group) ? n : n + r.calls), 0)

const buildVersion = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2perf: { version: () => { version: string } } }
      ).__ff2perf.version().version,
  )

const k = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(0)}k`

const gatesTriangles = (group: string): boolean =>
  !isVolatile(group) && DETERMINISTIC_TRIANGLES.some((p) => group.startsWith(p))

const table = (c: Census, sim: FrozenSim | null): string =>
  [
    `  mission tick ${sim ? missionTickOf(sim) : '?'} (elapsed ${sim ? sim.elapsed.toFixed(3) : '?'} s, boot tick ${sim ? sim.tick : '?'})`,
    `  ${gatedCallsOf(c.rows)} gated calls of ${c.calls} · ${k(c.triangles)} tris · ${c.programs} programs`,
    `  shaded overdraw ${c.overdraw.shaded.toFixed(4)} total, ${c.overdraw.shadedOpaque.toFixed(4)} opaque`,
    `    ${'group'.padEnd(32)} ${'calls'.padStart(5)} ${'tris'.padStart(9)}   gated`,
    ...c.rows.map(
      (r) =>
        `    ${r.group.padEnd(32)} ${String(r.calls).padStart(5)} ${k(r.triangles).padStart(9)}   ` +
        (isVolatile(r.group)
          ? '— (render clock)'
          : `calls${gatesTriangles(r.group) ? ' + tris' : ''}`),
    ),
  ].join('\n')

const entryFrom = (
  run: { mission: string; edition: string },
  sim: FrozenSim,
  c: Census,
  build: string,
): Entry => ({
  ...run,
  snapAt: SNAP_AT,
  missionTick: missionTickOf(sim),
  bootTick: sim.tick,
  elapsed: sim.elapsed,
  gatedCalls: gatedCallsOf(c.rows),
  totalCalls: c.calls,
  triangles: c.triangles,
  groups: Object.fromEntries(
    c.rows.map((r) => [r.group, { calls: r.calls, triangles: r.triangles }]),
  ),
  overdraw: { shaded: c.overdraw.shaded, shadedOpaque: c.overdraw.shadedOpaque },
  build,
  date: new Date().toISOString().slice(0, 10),
})

test.describe('@gpu the census baseline: DEV-160 H2, DEV-909', () => {
  test.setTimeout(900_000)

  test('a baseline write names the missions it writes', () => {
    // The old `CENSUS_BASELINE_WRITE=1` restamped whatever the run reached. A
    // write that names nothing it knows is a typo, and silently writing
    // nothing would read as a re-stamp that worked.
    if (!WRITE) return
    const known = new Set(ALL.map((m) => m.id))
    const unknown = WRITE_IDS === 'all' ? [] : [...WRITE_IDS].filter((id) => !known.has(id))
    expect(
      unknown,
      'CENSUS_BASELINE_WRITE takes `all` or a comma list of mission ids, not 1; these are not missions',
    ).toEqual([])
  })

  for (const run of RUNS) {
    const key = `${run.mission}/${run.edition}@${SNAP_AT}`

    test(`${key}: the frame draws what the baseline says it draws`, async ({ page }) => {
      const baseline = readBaselines()[key]

      // ── the WRITE path ───────────────────────────────────────────────
      if (WRITE) {
        // ── the tick a baseline is ALLOWED to key on ───────────────────
        //
        // `snapFloorTick` is the first step at or past the mark, and the only
        // landing the clamp guarantees; the frame may carry the sim ONE step
        // further, and which it does is decided by frame duration. An entry
        // written on that second tick is keyed to a frame time, so it stops
        // being reachable on the first build that gets faster — and the gate
        // path SKIPS rather than fails, so it reads as a pass for ever.
        //
        // That is not hypothetical: `rookie_01` was written at 1641 against a
        // floor of 1640, and DEV-184 and DEV-192 made it unreachable. So the
        // writer retries for the floor and REFUSES to store anything else. The
        // retry is the gate path's, for the reason its own comment gives.
        const floor = snapFloorTick(SNAP_AT)
        let sim: FrozenSim | null = null
        const reached: string[] = []
        for (let attempt = 0; attempt < MAX_ATTEMPTS && sim === null; attempt++) {
          await flyToFreeze(page, { ...run, snapAt: SNAP_AT, params: { perf: '1', ...PIN } })
          const s = await frozenSim(page)
          expect(
            s,
            '__ff2perf.sim() came back null — is ?perf=1 taking, and is the surface attached?',
          ).not.toBeNull()
          reached.push(String(missionTickOf(s as FrozenSim)))
          if (missionTickOf(s as FrozenSim) === floor) sim = s
        }
        // A hard FAIL, not a skip: a write that cannot produce a valid entry
        // must not leave the old one in place while looking like it worked.
        expect(
          sim,
          `never landed on mission tick ${floor} = ceil(${SNAP_AT} / dt) over ${MAX_ATTEMPTS} ` +
            `loads — saw ${reached.join(', ')}. The baseline may only key on that floor; a ` +
            `higher tick is an overshoot keyed to this machine's frame time.`,
        ).not.toBeNull()
        const c = await census(page)
        const entry = entryFrom(run, sim as FrozenSim, c, await buildVersion(page))
        // Read AGAIN here, not at the top of the test: a long write run is a
        // sequence of these, and each must replace only its own key in the file
        // as it stands now. Keys are kept sorted so a one-mission write is a
        // one-block diff.
        const current = readBaselines()
        current[key] = entry
        const all = Object.fromEntries(
          Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
        )
        fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
        // Two-space indent and a trailing newline, because the file is TRACKED
        // and `pnpm lint` formats it. A generator whose output its own repo
        // then reformats makes every re-baseline a two-commit affair.
        fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(all, null, 2)}\n`)
        console.info(
          `\nDEV-160 census baseline WRITTEN — ${key}\n  build ${entry.build}, ${entry.date}\n${table(c, sim)}\n`,
        )
        return
      }

      // ── the GATE path ────────────────────────────────────────────────
      test.skip(
        baseline === undefined,
        `no baseline for ${key} — write one with CENSUS_BASELINE_WRITE=1`,
      )
      const want = baseline as Entry

      let got: Census | null = null
      let sim: FrozenSim | null = null
      const seen: string[] = []
      for (let attempt = 0; attempt < MAX_ATTEMPTS && got === null; attempt++) {
        await flyToFreeze(page, { ...run, snapAt: SNAP_AT, params: { perf: '1', ...PIN } })
        sim = await frozenSim(page)
        if (sim !== null) seen.push(`${missionTickOf(sim)} (boot ${sim.tick})`)
        if (sim !== null && missionTickOf(sim) === want.missionTick) got = await census(page)
      }

      if (got === null) {
        // A printed NON-RESULT: the harness failed to REACH the frame, which is
        // a different finding from the frame having changed. This branch is the
        // one that caught the boot-tick mistake — see the header.
        const reached = await census(page)
        console.info(
          `\nDEV-160 census baseline SKIPPED — ${key}\n` +
            `  wanted mission tick ${want.missionTick} (baseline: build ${want.build}, ${want.date})\n` +
            `  saw ${seen.join(' · ')} over ${MAX_ATTEMPTS} loads\n` +
            `  the frame that WAS reached:\n${table(reached, sim)}\n`,
        )
        test.skip(true, `never landed on mission tick ${want.missionTick} — saw ${seen.join(', ')}`)
        return
      }

      const rows = new Map(got.rows.map((r) => [r.group, r]))
      console.info(
        `\nDEV-160 census baseline — ${key}\n` +
          `  baseline: build ${want.build}, ${want.date}, mission tick ${want.missionTick}` +
          ` (reached in ${seen.length} load${seen.length === 1 ? '' : 's'}: ${seen.join(' · ')})\n` +
          `${table(got, sim)}\n`,
      )

      // The total first: it is the number a reviewer reads, and the one that
      // moved by 51 between DEV-118 and this branch with nothing noticing.
      // GATED groups only — a cloud that drifted must not fail a draw gate.
      expect(
        Math.abs(gatedCallsOf(got.rows) - want.gatedCalls),
        `draw calls over the gated groups: ${gatedCallsOf(got.rows)} against ${want.gatedCalls}`,
      ).toBeLessThanOrEqual(CULL_EDGE_CALLS)

      // The group SET. A new group drawing zero calls, or an old one vanishing
      // while another grew, would both pass a total on its own.
      expect([...rows.keys()].sort(), 'the groups in the frame').toEqual(
        Object.keys(want.groups).sort(),
      )

      // Per-group calls, skipping the three the render clock drives.
      for (const [group, expected] of Object.entries(want.groups)) {
        if (isVolatile(group)) continue
        expect(
          Math.abs((rows.get(group)?.calls ?? -999) - expected.calls),
          `${group} calls: ${rows.get(group)?.calls} against ${expected.calls}`,
        ).toBeLessThanOrEqual(isCullEdge(group) ? CULL_EDGE_CALLS : 0)
      }

      // Triangles only where the geometry cannot move under wall time.
      for (const [group, expected] of Object.entries(want.groups)) {
        if (!gatesTriangles(group)) continue
        expect(
          Math.abs((rows.get(group)?.triangles ?? 0) - expected.triangles) /
            Math.max(1, expected.triangles),
          `${group} triangles: ${rows.get(group)?.triangles} against ${expected.triangles}`,
        ).toBeLessThanOrEqual(isCullEdge(group) ? CULL_EDGE_TRIANGLES : 0)
      }

      // ── the overdraw budget (DEV-909) ──────────────────────────────────
      //
      // SHADED, because that is what the GPU pays for: fragments that reached
      // a shader after early-Z, in three's own draw order. Opaque and total
      // both, because a transparent layer (cloud, particle, wing trail) moves
      // the total and not the opaque figure, and one budget would hide which.
      // Pinned `adaptive=0&quality=high` at the same mission tick, so the pixel
      // count and the scene are the baseline's. ISSUED is printed, not gated:
      // it ignores the depth test, so it is a property of the geometry the
      // draw-call gate already counts.
      console.info(
        `CENSUS-OD ${key} shaded=${got.overdraw.shaded.toFixed(5)} ` +
          `shadedOpaque=${got.overdraw.shadedOpaque.toFixed(5)} issued=${got.overdraw.issued.toFixed(5)}`,
      )
      expect(
        want.overdraw,
        `${key} has no overdraw budget: the entry predates DEV-909, re-stamp it`,
      ).toBeDefined()
      for (const field of ['shadedOpaque', 'shaded'] as const) {
        const base = want.overdraw[field]
        const now = got.overdraw[field]
        expect(
          Math.abs(now - base) / base,
          `${field} overdraw ${now.toFixed(4)} against the budget ${base.toFixed(4)} ` +
            `(tolerance ${OVERDRAW_TOLERANCE * 100} %). More is the GPU shading more; less is a ` +
            `real saving, and the baseline should be re-stamped on purpose to bank it.`,
        ).toBeLessThanOrEqual(OVERDRAW_TOLERANCE)
      }

      // The volatile groups are not silently dropped: they are asserted to be
      // PRESENT and drawing something, so a regression that deleted the clouds
      // outright still fails here rather than being waved through as drift.
      for (const group of Object.keys(want.groups)) {
        if (!isVolatile(group)) continue
        expect(rows.get(group)?.calls, `${group} is still drawn`).toBeGreaterThan(0)
      }
    })
  }
})
