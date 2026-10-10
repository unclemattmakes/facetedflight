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
 */

import fs from 'node:fs'
import path from 'node:path'
import { snapFloorTick } from '../../src/boot/snap'
import { type FrozenSim, flyToFreeze, frozenSim, missionTickOf } from './fixtures/freeze'
import { knownRed } from './fixtures/known-red'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const BASELINE_PATH = 'tools/perf/census-baseline.json'
const WRITE = process.env.CENSUS_BASELINE_WRITE === '1'
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
 * The runs the baseline covers. Anniversary only: Classic draws a strict
 * subset of the same scene, so a Classic regression that this would catch is
 * one Anniversary catches first — and each row costs three minutes.
 */
const RUNS = [
  { mission: 'int_01_hoverJet', edition: 'anniversary' },
  { mission: 'rookie_01_hoverJet', edition: 'anniversary' },
] as const

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
  readonly overdraw: { issued: number; shaded: number }
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
  build,
  date: new Date().toISOString().slice(0, 10),
})

test.describe('@measure @gpu the census baseline: DEV-160 H2', () => {
  test.setTimeout(900_000)

  for (const run of RUNS) {
    const key = `${run.mission}/${run.edition}@${SNAP_AT}`

    test(`${key}: the frame draws what the baseline says it draws`, async ({ page }) => {
      knownRed('KR-01', key === 'int_01_hoverJet/anniversary@20')
      knownRed('KR-02', key === 'rookie_01_hoverJet/anniversary@20')
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
          await flyToFreeze(page, { ...run, snapAt: SNAP_AT, params: { perf: '1' } })
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
        const all = readBaselines()
        all[key] = entry
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
        await flyToFreeze(page, { ...run, snapAt: SNAP_AT, params: { perf: '1' } })
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
      expect(gatedCallsOf(got.rows), 'draw calls over the gated groups').toBe(want.gatedCalls)

      // The group SET. A new group drawing zero calls, or an old one vanishing
      // while another grew, would both pass a total on its own.
      expect([...rows.keys()].sort(), 'the groups in the frame').toEqual(
        Object.keys(want.groups).sort(),
      )

      // Per-group calls, skipping the three the render clock drives.
      for (const [group, expected] of Object.entries(want.groups)) {
        if (isVolatile(group)) continue
        expect(rows.get(group)?.calls, `${group} calls`).toBe(expected.calls)
      }

      // Triangles only where the geometry cannot move under wall time.
      for (const [group, expected] of Object.entries(want.groups)) {
        if (!gatesTriangles(group)) continue
        expect(rows.get(group)?.triangles, `${group} triangles`).toBe(expected.triangles)
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
