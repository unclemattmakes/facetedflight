/**
 * tests/e2e/chunk-swap-stall.spec.ts — the ~110 ms frames at a chunk swap.
 *
 * DEV-242. `int_01_hoverJet` has exactly two frames over 40 ms after the 3 s
 * mark, at ~14.95 s and ~22.85 s, each ~110 ms, each with an ordinary GPU and
 * no program change (DEV-239 closed that half). This spec counts them on the
 * FLAT path and says what kind of 110 ms they are.
 *
 * ── The one question this instrument is built to answer ──────────────────
 *
 * The app's own numbers already say where the stall is NOT. On the stalling
 * frame `sim_ms` is 0.7, `render_ms` 2.3 and `frame_ms` 4.0 — **the 110 ms is
 * not inside the animation callback at all**, it is in the gap before it. Three
 * things can take a gap: a long JS TASK, a garbage collection, or the driver.
 *
 * A `longtask` entry is emitted for the first and **not for the other two** —
 * GC and a blocking command-buffer upload both happen between tasks, where no
 * `PerformanceObserver` can see them. So:
 *
 *   two ~110 ms frames + two ~110 ms longtasks  -> it is JS, and the profile
 *                                                  names the function
 *   two ~110 ms frames + NO long longtask       -> it is GC or the driver, and
 *                                                  no amount of splitting the
 *                                                  JS work would have helped
 *
 * That is a real discriminator rather than a measurement, which is why it is
 * worth running on a box where a millisecond would not be: the presence of an
 * entry does not drift with load the way its duration does.
 *
 * ── What is a measurement, and what the protocol allows ──────────────────
 *
 * The COUNT of frames over 40 ms, and their durations. These are main-thread
 * CPU milliseconds on the flat path, which `docs/testing/perf-protocol.md`
 * permits on a quiet box; **no GPU timing is read, asked for or reported here**.
 * Nothing is asserted as a threshold — the count is printed and the mechanism
 * is what fails.
 *
 *   E2E_PORT=<yours> SWAP_OUT=<dir> \
 *     pnpm exec playwright test tests/e2e/chunk-swap-stall.spec.ts --workers 1
 *
 *   SWAP_PROFILE=1   also records a V8 CPU profile over the flight and writes
 *                    a `.cpuprofile` next to the trace. OFF by default: the
 *                    sampling profiler perturbs exactly the GC behaviour one
 *                    of the two candidates is about, so the before/after counts
 *                    are taken without it and the profile is a separate run.
 *
 * `@gpu`: a real world, and a headed browser for the reason
 * `docs/testing/TIERS.md` gives.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2PerfGlobal } from './fixtures/ff2'
import { hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'

const MISSION = process.env.SWAP_MISSION ?? 'int_01_hoverJet'
const EDITION = process.env.SWAP_EDITION ?? 'anniversary'
/** 40 s covers both stalls (~15 s and ~23 s) with room either side. */
const SECONDS = Number(process.env.SWAP_SECONDS ?? '40')
const OUT_DIR = process.env.SWAP_OUT ?? 'perf-out/dev-242'
const PROFILE = process.env.SWAP_PROFILE === '1'
/** A frame this long is the class DEV-242 is about; everything else is noise. */
const LONG_MS = 40
/** The window the stalls live in, used only to say whether one was in it. */
const WINDOW = [10, 40] as const

/**
 * One worn eye, the same reasoning `perf-trace.spec.ts` spells out: a trace
 * taken at Playwright's default 1280x720 records every per-fragment cost at a
 * seventh of its size. It matters less here — this row's stall is not fill —
 * but a capture tool that quietly changes the frame is not one you compare
 * against another run.
 */
const TRACE_PX = Number(process.env.SWAP_PX ?? '2516')
const TRACE_DPR = Number(process.env.SWAP_DPR ?? '2')

test.use({
  viewport: { width: Math.round(TRACE_PX / TRACE_DPR), height: Math.round(TRACE_PX / TRACE_DPR) },
  deviceScaleFactor: TRACE_DPR,
  launchOptions: { args: ['--disable-gpu-vsync'] },
})

interface LongTask {
  readonly start: number
  readonly duration: number
  readonly name: string
  readonly attribution: readonly string[]
}

interface TraceRow {
  readonly elapsed: number
  readonly dt: number
  readonly sim: number
  readonly render: number
  readonly frame: number
  readonly tris: number
  readonly programs: number
  readonly terrPending: number
  readonly terrFading: number
  readonly seaPending: number
  readonly seaFading: number
}

/**
 * The longtask observer, installed BEFORE any page script runs.
 *
 * `addInitScript` rather than an `evaluate` after load, because the first
 * seconds are the loading curtain and a stall there would be missed by an
 * observer that arrived late — and "there were no long tasks" has to mean the
 * whole run or it means nothing. `buffered: true` for the same reason.
 */
const observeLongTasks = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const store: LongTaskRecord[] = []
    interface LongTaskRecord {
      start: number
      duration: number
      name: string
      attribution: string[]
    }
    ;(globalThis as unknown as { __ff2longtask: LongTaskRecord[] }).__ff2longtask = store
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEntry & {
            attribution?: { name: string; containerType?: string }[]
          }
          store.push({
            start: e.startTime,
            duration: e.duration,
            name: e.name,
            attribution: (e.attribution ?? []).map(
              (a) => `${a.name}${a.containerType ? `/${a.containerType}` : ''}`,
            ),
          })
        }
      }).observe({ type: 'longtask', buffered: true })
    } catch {
      // `longtask` is Chromium-only. A browser without it leaves the array
      // empty, and the test says "unavailable" rather than "none" — those are
      // very different answers and a silent empty array conflates them.
      ;(globalThis as unknown as { __ff2longtaskUnavailable: boolean }).__ff2longtaskUnavailable =
        true
    }
  })
}

const readLongTasks = (page: Page): Promise<{ tasks: LongTask[]; available: boolean }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2longtask?: LongTask[]
      __ff2longtaskUnavailable?: boolean
    }
    return { tasks: w.__ff2longtask ?? [], available: !w.__ff2longtaskUnavailable }
  })

const traceStatus = (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as unknown as Ff2PerfGlobal).__ff2perf.trace.status())

const traceDump = (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as unknown as Ff2PerfGlobal).__ff2perf.trace.dump())

/** The CSV the recorder dumps: a JSON header line, then a CSV with its own header. */
const parseTrace = (dump: string): TraceRow[] => {
  const lines = dump.split('\n').filter((l) => l.trim().length > 0)
  const header = JSON.parse(lines[0] as string) as { columns: string[] }
  const names = (lines[1] as string).split(',')
  // Read the order out of the dump rather than hard-coding offsets. The column
  // list is a wire format and `perf-trace.ts` says in its own comment that a
  // reader which hard-codes `row[12]` is the one that breaks silently.
  expect(names).toEqual(header.columns)
  const at = (row: string[], name: string): number => Number(row[names.indexOf(name)])
  return lines.slice(2).map((line) => {
    const row = line.split(',')
    return {
      elapsed: at(row, 'elapsed_s'),
      dt: at(row, 'dt_ms'),
      sim: at(row, 'sim_ms'),
      render: at(row, 'render_ms'),
      frame: at(row, 'frame_ms'),
      tris: at(row, 'tris'),
      programs: at(row, 'programs'),
      terrPending: at(row, 'terr_pending'),
      terrFading: at(row, 'terr_fading'),
      seaPending: at(row, 'sea_pending'),
      seaFading: at(row, 'sea_fading'),
    }
  })
}

test.describe('@measure @gpu DEV-242: the chunk-swap stall, counted and classified', () => {
  test.setTimeout(600_000)

  test(`${MISSION}: frames over ${LONG_MS} ms, and whether they are JS`, async ({ page }) => {
    await observeLongTasks(page)

    const cdp = PROFILE ? await page.context().newCDPSession(page) : null
    if (cdp) {
      await cdp.send('Profiler.enable')
      // 500 us. The default is 1,000; a ~110 ms event is ~220 samples either
      // way, and the finer rate costs nothing on a 40 s run.
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
    }

    // `oceanRings=0`: the event this spec is about is a sea CHUNK crossing a LOD
    // band (DEV-242). Since DEV-339 Anniversary's sea is rings, which have no
    // chunks, so the plate is asked for by name; Classic still ships it.
    await page.goto(
      `/?perf=1&autopilot=1&xr=off&mission=${MISSION}&edition=${EDITION}&trace=${SECONDS}&oceanRings=0`,
    )
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    await hold(page, 'Enter')

    expect(
      await page.evaluate(() => typeof (globalThis as Record<string, unknown>).__ff2perf),
      '__ff2perf is missing: either ?perf=1 did not take, or the surface is not attached',
    ).toBe('object')

    // The recorder arms from a STATE, not an event — see `perf-trace.spec.ts`.
    await expect
      .poll(() => traceStatus(page), { timeout: 120_000, intervals: [500] })
      .toBe('recording')
    if (cdp) await cdp.send('Profiler.start')
    await expect
      .poll(() => traceStatus(page), { timeout: 300_000, intervals: [2_000] })
      .toBe('done')

    const dump = await traceDump(page)
    const rows = parseTrace(dump)
    const { tasks, available } = await readLongTasks(page)

    let profileJson: string | null = null
    if (cdp) {
      const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown }
      profileJson = JSON.stringify(profile)
    }

    fs.mkdirSync(OUT_DIR, { recursive: true })
    const stem = `${MISSION}-${EDITION}-${SECONDS}s`
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.trace.csv`), dump)
    fs.writeFileSync(
      path.join(OUT_DIR, `${stem}.longtasks.json`),
      JSON.stringify({ available, tasks }, null, 1),
    )
    if (profileJson) {
      fs.writeFileSync(path.join(OUT_DIR, `${stem}.cpuprofile`), profileJson)
    }

    // ── the two lists, side by side ──────────────────────────────────────
    //
    // A long FRAME is an interval the player lost. A long TASK is JS running.
    // Printing both counts, unjoined, is the whole discriminator: they do not
    // share a time origin (the trace is mission seconds, `longtask` is
    // `performance.now()`), and they do not need to — what separates the two
    // candidates is whether the second list has anything in it at all.
    // `prev` is the ARRIVAL frame — the one that uploads the chunk — and
    // `before` is the frame before THAT, so the deltas below are the arrival's
    // own step and not the stall's. Getting this wrong is the bug §1 of
    // DEV-242 is about, one level down: the first version printed
    // `r.tris - prev.tris`, which is the change across the STALL (≈ 0, and it
    // read −1,220) rather than across the arrival (+147,968, one ocean chunk).
    // A difference is only an instrument if it is the difference of the right
    // pair.
    const longFrames = rows
      .map((r, i) => ({ r, prev: rows[i - 1], before: rows[i - 2] }))
      .filter(({ r }) => r.dt > LONG_MS && r.elapsed > 3)
    const longTasks = tasks.filter((t) => t.duration > LONG_MS)

    const inWindow = (t: number): boolean => t >= WINDOW[0] && t <= WINDOW[1]

    console.info(
      [
        `\nDEV-242 — ${MISSION} ${EDITION}, flat, ${SECONDS} s, ${rows.length} frames`,
        `  frames over ${LONG_MS} ms after 3 s: ${longFrames.length}`,
        ...longFrames.map(({ r, prev, before }) =>
          [
            `    ${r.elapsed.toFixed(2).padStart(7)} s  dt ${r.dt.toFixed(1).padStart(7)} ms`,
            `frame ${r.frame.toFixed(1).padStart(5)}  render ${r.render.toFixed(1).padStart(5)}`,
            `programs ${r.programs}`,
            prev && before
              ? `| arrival frame ${prev.elapsed.toFixed(2)} s: render ${prev.render.toFixed(1)} ms,` +
                ` dtris ${prev.tris - before.tris >= 0 ? '+' : ''}${(prev.tris - before.tris).toFixed(0)},` +
                ` terrF ${before.terrFading}->${prev.terrFading},` +
                ` seaP ${before.seaPending}->${prev.seaPending},` +
                ` seaF ${before.seaFading}->${prev.seaFading}`
              : '',
            inWindow(r.elapsed) ? ' [in window]' : '',
          ].join('  '),
        ),
        available
          ? `  longtasks over ${LONG_MS} ms in the whole run: ${longTasks.length}`
          : '  longtasks: UNAVAILABLE in this browser — the classification is not answered',
        ...longTasks.map(
          (t) =>
            `    +${(t.start / 1000).toFixed(2)} s  ${t.duration.toFixed(1)} ms  ${t.name}  ${t.attribution.join(' ') || '(no attribution)'}`,
        ),
        available && longFrames.length > 0 && longTasks.length === 0
          ? '  => the long frames are NOT long JS tasks: GC or the driver, between tasks.'
          : '',
        available && longFrames.length > 0 && longTasks.length > 0
          ? '  => there is long JS. Run again with SWAP_PROFILE=1 and read the .cpuprofile.'
          : '',
        `  written to ${path.resolve(OUT_DIR)}`,
      ]
        .filter((l) => l !== '')
        .join('\n') + '\n',
    )

    // ── MECHANISMS ONLY ──────────────────────────────────────────────────
    //
    // Not one millisecond is asserted. What is asserted is that a run which
    // could not answer the question does not pass quietly as one that did.
    expect(rows.length, 'a trace with no frames is a measurement of nothing').toBeGreaterThan(100)
    expect(
      rows.some((r) => r.elapsed > WINDOW[1] - 5),
      `the flight never reached ${WINDOW[1] - 5} s, so the ~15 s and ~23 s stalls were not both in range`,
    ).toBe(true)
    expect(
      rows.some((r) => r.seaFading > 0),
      'no sea chunk ever crossed a LOD band in this run: the event DEV-242 is about did not happen, ' +
        'so a count of zero long frames would mean nothing',
    ).toBe(true)
    expect(available, 'longtask is unavailable, so this run classifies nothing').toBe(true)
  })
})
