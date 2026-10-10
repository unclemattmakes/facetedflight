/**
 * tests/e2e/perf-trace.spec.ts — a soak, recorded frame by frame. DEV-160 H3.
 *
 * ── The first consumer of `__ff2perf`, on purpose ────────────────────────
 *
 * `__ff2` is `import.meta.env.DEV`-only, so every spec this suite has ever
 * written reads a handle that **does not exist on the URL a headset opens**.
 * `__ff2perf` is the read-only surface that ships, built iff `?perf=1`, and
 * the worn session in VR-PERF §5.8 is going to lean on it entirely. This spec
 * drives it end to end on a flat screen so that the worn session is not the
 * first time anybody has called `trace.start()` — and so that a change which
 * quietly breaks the production surface goes red here rather than in a
 * headset with Matt in it.
 *
 * It is a CAPTURE TOOL with mechanism gates. It prints the summary, writes the
 * summary and the whole CSV somewhere a person can read them, and asserts only
 * things that are true of a recorder that did its job. **No millisecond is
 * asserted** (`docs/testing/perf-protocol.md`: print, don't gate; if you gate,
 * gate a mechanism).
 *
 *   PERF_TRACE_SECONDS=60 PERF_TRACE_DIR=<dir> E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/perf-trace.spec.ts --workers 1
 *
 * Output goes to `PERF_TRACE_DIR ?? 'perf-out'` — NOT `test-results/`, which
 * Playwright wipes at the start of every run, so a trace kept to compare
 * against the next one would lose its first half (the `FOG_SWEEP_DIR` habit).
 * `perf-out/` is gitignored.
 *
 * `@gpu`, hydrated assets, a real compiler, by hand. `pnpm e2e` never runs in
 * CI and this is slow even by its standards: a 60 s recording plus the flight
 * to reach it.
 *
 * ── No `src/` imports, and the reason is not style ───────────────────────
 *
 * `ticksPerSecond` is read back OUT OF THE PAGE rather than imported from
 * `@/sim/constants`. One `src/` import edge from a spec reaches
 * `import.meta.glob` and kills the WHOLE Playwright collection — it reads
 * like a failing suite and it is a collection failure, so read the FIRST line
 * of the output and not the exit code.
 *
 * Reading it back is also the better assertion: the tick identity below then
 * compares the recorder's ticks against the rate the RUNNING GAME reports,
 * not against a constant this file could have got wrong in the same direction
 * (trap 24 — a test that re-derives its expectation the way the code does has
 * not tested the code).
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const MISSION = process.env.PERF_TRACE_MISSION ?? 'int_01_hoverJet'
const EDITION = process.env.PERF_TRACE_EDITION ?? 'anniversary'
const SECONDS = Number(process.env.PERF_TRACE_SECONDS ?? '60')
const OUT_DIR = process.env.PERF_TRACE_DIR ?? 'perf-out'
/**
 * The canvas, and it defaults to ONE WORN EYE for the reason the whole wave-2
 * programme exists.
 *
 * This spec had no `test.use` at all, so it ran at Playwright's default
 * 1280 x 720 = 0.92 Mpx. One worn eye is 2516 x 2516 = **6.33 Mpx**, so every
 * per-fragment cost in a trace taken here was being recorded at **one seventh
 * of its size**, and the loop was vsync-locked on top of that. That is exactly
 * the instrument `VR-PERF-WAVE-2-WORK.md` §10(1) retracted three separate
 * rankings from — *they were not small, they were measured small* — and it is
 * the one defect a capture tool must not have, because a trace is what somebody
 * later reads p95 off.
 *
 * `PERF_TRACE_PX` overrides it (e.g. `1280` to reproduce an old trace).
 */
const TRACE_PX = Number(process.env.PERF_TRACE_PX ?? '2516')
const TRACE_DPR = Number(process.env.PERF_TRACE_DPR ?? '2')

test.use({
  viewport: { width: Math.round(TRACE_PX / TRACE_DPR), height: Math.round(TRACE_PX / TRACE_DPR) },
  deviceScaleFactor: TRACE_DPR,
  // vsync off, same as `perf-scale.spec.ts`. `setAnimationLoop` is rAF, rAF is
  // vsync-locked, and a GPU timer query brackets the whole submission — so on a
  // 60 Hz monitor a throttled loop puts its own idle INSIDE the bracket and
  // every reading comes back as the refresh rate wearing a GPU timer's clothes.
  // A hitch is still a hitch: it shows as a spike in the JS and GPU columns
  // rather than as a missed vsync.
  launchOptions: { args: ['--disable-gpu-vsync'] },
})

interface Stat {
  readonly p50: number
  readonly p95: number
  readonly max: number
}

interface Worst {
  readonly index: number
  readonly dtMs: number
  readonly elapsedSeconds: number
  readonly shipX: number
  readonly shipZ: number
  readonly calls: number
  readonly triangles: number
  readonly programs: number
}

interface Summary {
  readonly status: string
  readonly frames: number
  readonly seconds: number
  readonly fps: number
  readonly budgetMs: number
  readonly budgetSource: string
  readonly overflowed: boolean
  readonly dt: Stat
  readonly sim: Stat
  readonly render: Stat
  readonly frame: Stat
  readonly gpu: Stat
  readonly gpuFrames: number
  readonly hitches: number
  readonly hitchFraction: number
  readonly tierFrames: number
  readonly tierFraction: number
  readonly ticks: { zero: number; one: number; two: number; threePlus: number }
  readonly worst: readonly Worst[]
}

const traceStatus = (page: Page): Promise<string> =>
  page.evaluate(() =>
    (
      globalThis as unknown as { __ff2perf: { trace: { status: () => string } } }
    ).__ff2perf.trace.status(),
  )

const traceSummary = (page: Page): Promise<Summary> =>
  page.evaluate(() =>
    (
      globalThis as unknown as { __ff2perf: { trace: { summary: () => Summary } } }
    ).__ff2perf.trace.summary(),
  )

const traceDump = (page: Page): Promise<string> =>
  page.evaluate(() =>
    (
      globalThis as unknown as { __ff2perf: { trace: { dump: () => string } } }
    ).__ff2perf.trace.dump(),
  )

const ticksPerSecond = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2perf: { sim: () => { ticksPerSecond: number } } }
      ).__ff2perf.sim().ticksPerSecond,
  )

const ms = (n: number): string => n.toFixed(2).padStart(7)

test.describe('@measure @gpu the per-frame trace: DEV-160 H3', () => {
  test.setTimeout(600_000)

  test(`${MISSION} ${EDITION}: ${SECONDS} s recorded through __ff2perf`, async ({ page }) => {
    await page.goto(
      `/?perf=1&autopilot=1&xr=off&mission=${MISSION}&edition=${EDITION}&trace=${SECONDS}`,
    )
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    await hold(page, 'Enter')

    // THE point of this spec, asserted before anything else: the production
    // surface is there. It is built iff `?perf=1` and attached OUTSIDE
    // `main.ts`'s `import.meta.env.DEV` block — so if this is `undefined`,
    // either the flag did not take or the deployed build has nothing readable
    // in it, which is gap 3 all over again.
    expect(
      await page.evaluate(() => typeof (globalThis as Record<string, unknown>).__ff2perf),
      '__ff2perf is missing: either ?perf=1 did not take, or the surface is not attached',
    ).toBe('object')

    // The recorder arms itself from a STATE — on the mission screen, with a
    // flight, once the launch has let go — and not from an event. So poll for
    // it rather than assuming the keypress started it.
    await expect
      .poll(() => traceStatus(page), { timeout: 120_000, intervals: [500] })
      .toBe('recording')
    await expect
      .poll(() => traceStatus(page), { timeout: 300_000, intervals: [2_000] })
      .toBe('done')

    const summary = await traceSummary(page)
    const dump = await traceDump(page)
    const perSecond = await ticksPerSecond(page)

    fs.mkdirSync(OUT_DIR, { recursive: true })
    const stem = `${MISSION}-${EDITION}-${SECONDS}s`
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.summary.json`), JSON.stringify(summary, null, 1))
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.trace.csv`), dump)

    const totalTicks = summary.ticks.one + 2 * summary.ticks.two + 3 * summary.ticks.threePlus
    console.info(
      [
        `\nDEV-160 trace — ${MISSION} ${EDITION}, ${SECONDS} s requested`,
        `  frames ${summary.frames} over ${summary.seconds.toFixed(1)} s = ${summary.fps.toFixed(1)} fps${summary.overflowed ? '   OVERFLOWED: the buffer filled and recording stopped early' : ''}`,
        `  budget ${summary.budgetMs.toFixed(2)} ms from ${summary.budgetSource}`,
        `  dt     p50 ${ms(summary.dt.p50)}  p95 ${ms(summary.dt.p95)}  max ${ms(summary.dt.max)} ms`,
        `  sim    p50 ${ms(summary.sim.p50)}  p95 ${ms(summary.sim.p95)}  max ${ms(summary.sim.max)} ms`,
        `  render p50 ${ms(summary.render.p50)}  p95 ${ms(summary.render.p95)}  max ${ms(summary.render.max)} ms`,
        `  frame  p50 ${ms(summary.frame.p50)}  p95 ${ms(summary.frame.p95)}  max ${ms(summary.frame.max)} ms`,
        `  gpu    p50 ${ms(summary.gpu.p50)}  p95 ${ms(summary.gpu.p95)}  max ${ms(summary.gpu.max)} ms over ${summary.gpuFrames} fresh queries${summary.gpuFrames === 0 ? '  (no timer query landed)' : ''}`,
        `  hitch  ${summary.hitches} frames over 2x the TIER = ${(100 * summary.hitchFraction).toFixed(2)} %  ·  tier ${summary.tierFrames} frames the display never showed = ${(100 * summary.tierFraction).toFixed(2)} %`,
        `  ticks/frame  0:${summary.ticks.zero}  1:${summary.ticks.one}  2:${summary.ticks.two}  3+:${summary.ticks.threePlus}   (>= ${totalTicks} ticks at ${perSecond.toFixed(3)} Hz)`,
        `  ticks vs wall: ${(summary.seconds * perSecond).toFixed(0)} expected over ${summary.seconds.toFixed(2)} s — a shortfall here is the SIM falling behind, which a frame over 250 ms really does (MAX_CATCHUP_SECONDS). Printed, not gated.`,
        '  worst five frames by dt:',
        ...summary.worst.map(
          (w) =>
            `    #${String(w.index).padStart(5)}  ${w.elapsedSeconds.toFixed(2).padStart(7)} s  ${w.dtMs.toFixed(2).padStart(7)} ms  at (${w.shipX.toFixed(0)}, ${w.shipZ.toFixed(0)})  ${w.calls} calls  ${(w.triangles / 1e6).toFixed(2)}M tris  ${w.programs} programs`,
        ),
        `  written to ${path.resolve(OUT_DIR)}`,
      ].join('\n') + '\n',
    )

    // ── MECHANISMS ONLY ──────────────────────────────────────────────────
    //
    // Not one millisecond is asserted. What IS asserted is that a recorder
    // which did its job could not have produced this.
    expect(summary.status).toBe('done')
    expect(summary.frames, 'a trace with no frames is a measurement of nothing').toBeGreaterThan(
      100,
    )
    for (const [name, s] of [
      ['dt', summary.dt],
      ['sim', summary.sim],
      ['render', summary.render],
      ['frame', summary.frame],
    ] as const) {
      for (const [field, v] of Object.entries(s)) {
        expect(Number.isFinite(v), `${name}.${field} is ${v}`).toBe(true)
      }
    }

    // ── the histogram summarises its OWN rows ───────────────────────────
    //
    // This used to compare `totalTicks` against `summary.seconds * perSecond`
    // — the wall clock — and it went red on a busy machine while the recorder
    // was behaving perfectly. `sim/integrator.ts`'s `MAX_CATCHUP_SECONDS` is
    // 0.25, so at 81.967 Hz a frame runs at most twenty steps and **any frame
    // over 250 ms loses ticks the sim can never make up**. On a contended box
    // that really happens, the sim really has fallen behind, and the assertion
    // reported correct behaviour as a failure.
    //
    // Widening the bound would have been calibrating a threshold to one
    // machine's contention, which is what §0 of `docs/testing/perf-protocol.md`
    // exists to forbid — and the same shape as the blind spot §3a-bis is about.
    //
    // So the gate becomes an INTERNAL IDENTITY between two views of one
    // dataset. The `ticks` column holds the exact count per frame; the
    // histogram is a lossy view of those same rows, losing only the
    // multiplicity above three. So, with no wall clock in it and true at any
    // frame rate on any machine:
    //
    //     totalTicks  <=  sum(ticks column)  <=  totalTicks + 17 * threePlus
    //
    // The lower bound is the histogram's floor; the upper is the catch-up cap,
    // since a `threePlus` frame contributes at most twenty against the three
    // it was counted as. Strictly stronger than the wall-clock version,
    // because it tests the recorder's actual contract. And it is best run on a
    // BUSY box, where the buckets are interesting.
    //
    // The wall-clock comparison survives as a printed line: print, don't gate.
    expect(perSecond, 'the page reports a sane fixed rate').toBeGreaterThan(80)
    const dumpLines = dump.split(String.fromCharCode(10))
    const dumpRows = dumpLines.slice(2).filter((line) => line.length > 0)
    const tickColumn = (
      JSON.parse(dumpLines[0] as string) as { columns: string[] }
    ).columns.indexOf('ticks')
    expect(tickColumn, 'the trace still has a per-frame tick column').toBeGreaterThanOrEqual(0)
    const sumTicks = dumpRows.reduce(
      (n, line) => n + Number((line.split(',')[tickColumn] as string) || 0),
      0,
    )
    expect(
      sumTicks,
      `${sumTicks} ticks in the column against ${totalTicks} the histogram can account for`,
    ).toBeGreaterThanOrEqual(totalTicks)
    expect(
      sumTicks,
      'and the 3+ bucket cannot hide more than the catch-up cap allows',
    ).toBeLessThanOrEqual(totalTicks + 17 * summary.ticks.threePlus)

    // Every frame ran the sim at least once, or the ones that did not are the
    // handful `?snap=`/pause would explain — and neither is in play here.
    expect(summary.ticks.zero, 'frames that stepped no sim at all').toBeLessThan(summary.frames / 2)

    // ── the dump's shape ─────────────────────────────────────────────────
    //
    // TWO header lines, not one: the JSON metadata line, then a CSV
    // column-name line, then one row per frame. This assertion said `frames +
    // 1` on its first run and read 3583 against 3582 — **the spec was wrong and
    // the recorder was right.** I had written the shape from the plan's prose
    // ("one JSON header line then CSV rows") instead of from `dump()`'s output,
    // which is the belief-written-twice mistake this repo has a whole lesson
    // about. Left in the comment because the next person to add a column will
    // be reading this line to find out what to expect.
    const lines = dump.trim().split('\n')
    expect(lines.length, 'a JSON header, a CSV column line, then one row per frame').toBe(
      summary.frames + 2,
    )

    const header = JSON.parse(lines[0] as string) as { columns?: unknown[]; frames?: number }
    expect(Array.isArray(header.columns), 'the header names its columns').toBe(true)
    const columns = header.columns as string[]

    // The two headers agree with each other. `COLUMNS` is called a wire format
    // in `perf-trace.ts`, and this is what makes that true: a reader taking the
    // order from the CSV line and a reader taking it from the JSON cannot end
    // up transposing two columns against one another.
    expect(lines[1], 'the CSV column line names the same columns, in order').toBe(columns.join(','))

    // And the header's own frame count agrees with `summary()` — two readers of
    // one recorder, which is the cheapest cross-check available here.
    expect(header.frames, 'the header frame count').toBe(summary.frames)

    // Every data row is that wide. First, middle and last rather than all
    // 3,500: a truncated write shows at the end, a malformed one at the start.
    for (const i of [2, Math.floor((lines.length + 2) / 2), lines.length - 1]) {
      expect((lines[i] as string).split(',').length, `row ${i} width`).toBe(columns.length)
    }
  })
})
