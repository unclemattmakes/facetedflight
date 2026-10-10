/**
 * tests/e2e/ride-hitch.spec.ts — the lift ride compiles nothing.
 *
 * DEV-117. Matt: *"big hitch near end of elevator ride (when level is
 * un-hidden?)"*. Measured before the fix on `int_01_hoverJet`: the reveal frame
 * took 2,067 and 2,567 ms on two rides while three compiled 19 programs and
 * uploaded 164 geometries — the land's first draw, on a live frame 100 m up the
 * shaft. `render/warm-up.ts` moves that first draw under the loading curtain.
 *
 * ── What is asserted, and why it is not a frame time ─────────────────────
 *
 * A frame-time threshold belongs to a machine (`bloom-perf.spec.ts` says the
 * same). The MECHANISM is machine-independent: from the last metres of the
 * climb, with the land still hidden (rise >= 95 of 106.6; the reveal is at
 * 100.4), to three seconds after release, `renderer.info.programs.length` must
 * not move. A program compiled at the reveal is the bug, at whatever speed this
 * GPU compiles it. The frame times over the WHOLE ride are printed so a run
 * leaves a number behind, and `?ride=0` is NOT passed — the ride is the subject.
 *
 * The window used to start at rise 95, because one program still compiled
 * mid-shaft: the start grid's `start-lightbar` took a new key at rise ~44 on
 * five rides in six, 90-180 ms, left open in DEV-117 §4. DEV-152 found it —
 * `numPointLights`, field #36 of three's cache key, is one HIGHER in the shaft
 * than in flight (Classic 1 vs 0, Anniversary 3 vs 2) because the warm-up hides
 * the launch room to match the FLIGHT, and the launch deck is the one shaft
 * object outside the frustum at the bottom, so it first drew 44 m up under
 * lights nothing had warmed — and fixed it with `warmWorld`'s `shaftLit` pass.
 * So the window now covers the RIDE as well as the reveal.
 *
 * The three things that each broke this on the way to the fix are exactly what
 * the assertion guards: a warm-up compiled against the wrong render target
 * (composer vs canvas), against the wrong point-light count (the launch room's
 * lamp), and against a spot light the title screen left in the scene.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/ride-hitch.spec.ts
 *
 * `@gpu`: a real world and a real compiler.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const MISSION = process.env.RIDE_MISSION ?? 'int_01_hoverJet'
const EDITION = process.env.RIDE_EDITION ?? 'anniversary'

/** Held, not tapped — every confirm is a level read once a frame. */
const hold = (page: Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 0 })

const programs = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2: { render: { renderer: { info: { programs: unknown[] } } } }
        }
      ).__ff2.render.renderer.info.programs.length,
  )

const launch = (page: Page): Promise<{ phase: string; rise: number }> =>
  page.evaluate(() => {
    const l = (
      globalThis as unknown as { __ff2: { launch: () => { phase: string; rise: number } } }
    ).__ff2.launch()
    return { phase: l.phase, rise: l.rise }
  })
const phase = async (page: Page): Promise<string> => (await launch(page)).phase

/**
 * Where the count is taken. DEV-152 moved this from 95 — which existed only to
 * skip the rise-44 compile — down to 5, so the window now covers the whole
 * climb including that one. Not 0: the ride's first frames legitimately draw
 * the shaft and the room for the first time under the room's own lights, and
 * those are a load cost under the curtain rather than a hitch in the clear.
 * Measured clean over seven rides (four Classic, three Anniversary) after the
 * fix, against five compiles in six rides before it.
 */
const LATE_RISE = 5

// ── DEV-255: take the vsync ceiling off WHEN PROFILING, and only then ──────
//
// `docs/testing/perf-protocol.md` §3b(a) has said since 2026-09-17 that a flat
// GPU reading needs this, and `perf-fill`, `perf-scale`, `perf-trace`,
// `ocean-shaft` and `chunk-swap-stall` all set it. **This spec did not, and
// this spec is the one that produced DEV-249's frame times.**
//
// What that cost: every `dt` in `perf-out/reveal-2026-09-20/` is quantised to
// this box's 5.55 ms refresh — 3,961 of 3,969 frames are exactly one interval
// and the mean deviation from a multiple of 5.55 ms is **0.066**. So the
// famous "27.7 versus 11.1" is **five dropped intervals versus two**, and the
// HUD's steady-state cost reads as exactly **0.00** (p50 5.60, p95 5.70 on
// BOTH arms of a live/freeze pair) because the frame has ~3.5 ms of slack for
// a 2 ms cost to hide in. The trace slice was never affected — a 26.75 ms
// `DoEndRasterCHROMIUM::Flush` is not a multiple of anything — which is why
// the mechanism was still found. The DURATIONS were the casualty.
//
// **Gated on `RIDE_PROFILE`, not on by default**, because the DEV-117 GUARD is
// an assertion about `programs.length` and has no business changing its
// browser flags; only the measuring configuration needs the ceiling gone.
//
// **`--disable-gpu-vsync` ALONE.** `perf-scale.spec.ts` pays for this lesson
// in its own comment: uncapping the loop as well pegs the GPU, a pegged GPU
// changes clocks, that fires `GPU_DISJOINT_EXT`, and every timer query in
// flight is dropped — so the largest readings come back `0.00`, which looks
// like free and means no samples.
test.use({
  launchOptions: { args: process.env.RIDE_PROFILE === '1' ? ['--disable-gpu-vsync'] : [] },
})

test.describe('@measure @gpu the lift ride compiles nothing: DEV-117', () => {
  test.setTimeout(420_000)

  test(`${MISSION} ${EDITION}: programs constant from the shaft to the release`, async ({
    page,
  }) => {
    const pageLines: string[] = []
    page.on('console', (m) => {
      // `ride:` as well as `warm-up:` — DEV-249's `?rideHide=bore` prints how
      // many chunks it selected, and a run that selected ZERO looks identical
      // in every number here to one that selected the right few. The first
      // bore run dropped that line on the floor for exactly this reason.
      if (m.text().includes('warm-up:') || m.text().startsWith('ride:')) pageLines.push(m.text())
    })
    // `RIDE_PINS` is EMPTY by default, on purpose. This spec's assertion is
    // "the ride compiles nothing", and a guard that pins the quality tier is
    // a guard on a build nobody loads — `quality=` moves MSAA, which moves
    // what compiles. A MILLISECOND is a different question and protocol §3f
    // pins it, so a measuring run passes `RIDE_PINS=adaptive=0&quality=high`
    // and the guard keeps testing the default. Both are the real player
    // build; neither is a test-only branch.
    const pins = process.env.RIDE_PINS ? `&${process.env.RIDE_PINS}` : ''
    await page.goto(`/?mission=${MISSION}&xr=off&title=0&menu=0&edition=${EDITION}${pins}`)
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    // The first live frames in the shaft compile the ROOM's own variants (its
    // lamp is a third point light); those are under the curtain and are not
    // the subject. Let them settle before the count is taken.
    await page.waitForTimeout(2_000)
    expect(await phase(page), 'waiting at the bottom of the shaft').toBe('waiting')

    // A frame logger beside the game's own loop: rAF timestamps are frame
    // starts, so a long frame shows as the delta of the one after it.
    //
    // The RISE is sampled beside the delta, and that is not decoration.
    // DEV-117's assertion is a program count over the whole window, which
    // answers "did anything compile" and cannot answer "what did the reveal
    // frame COST" — the two are different questions and only the first has
    // ever been asked here. Matt, 2026-09-20, worn: *"the app gets locked to
    // 45 Hz just after the elevator reaches the top, when the terrain is
    // unhidden."* A compositor latches on a STEP, so the size of the step is
    // the quantity, and locating it needs the rise on the same row as the
    // delta. Cheap: `__ff2.launch()` is a field read.
    // The reveal is located by the LAND'S OWN `visible` FLAG, never by a rise
    // threshold. `revealRiseFor` is 100.4 on six rigs and **101.84 on
    // `rookie_01`**, so a hard-coded 100.4 puts the window up to 16 frames
    // early on exactly the mission this was first run against — which is what
    // the first version of this did, and it reported the reveal as free while
    // looking at the frames before it. Ask the object.
    await page.evaluate(() => {
      const g = globalThis as unknown as {
        __ride: number[]
        __rideRise: number[]
        __rideVis: number[]
        __ridePhase: string[]
        __rideInfo: string[]
        __rideRender: number[]
        __ff2: {
          launch: () => { rise: number; phase: string }
          terrain: () => { terrain: { group: { visible: boolean } } } | null
          perfSurface?: { sim: () => { tick: number } }
          render: {
            renderer: {
              render: (...a: unknown[]) => unknown
              info: {
                memory: { geometries: number; textures: number }
                render: { calls: number; triangles: number }
                programs: unknown[]
              }
            }
          }
        }
      }
      g.__ride = []
      g.__rideRise = []
      g.__rideVis = []
      g.__ridePhase = []
      g.__rideInfo = []
      g.__rideRender = []
      // Time spent INSIDE `renderer.render` this frame, so a spike can be
      // split into draw-submission and everything else. A 27.8 ms frame whose
      // render is 5 ms is CPU outside the renderer; one whose render is 27 ms
      // is the draw or an upload inside it. Wrapping from the page needs no
      // app support and no build flag — the harness is doing something extra,
      // the GAME is unchanged (CLAUDE.md's line).
      let renderMs = 0
      try {
        const r = g.__ff2.render.renderer
        const orig = r.render.bind(r)
        r.render = (...a: unknown[]) => {
          const t0 = performance.now()
          const out = orig(...a)
          renderMs += performance.now() - t0
          return out
        }
      } catch {
        /* no renderer yet */
      }
      let last = performance.now()
      const tick = (t: number) => {
        g.__ride.push(t - last)
        let rise = -1
        let vis = -1
        let ph = '?'
        // `renderer.info` on the same row as the delta. A spike with a
        // GEOMETRY or TEXTURE step under it is an upload; one with a CALLS
        // or TRIANGLES step is a draw; one with neither is CPU. That is the
        // whole attribution, and it costs four field reads.
        let info = '0,0,0,0,0'
        try {
          const l = g.__ff2.launch()
          rise = l.rise
          ph = l.phase
          vis = g.__ff2.terrain()?.terrain.group.visible ? 1 : 0
          const inf = g.__ff2.render.renderer.info
          // TICKS per frame, appended last, and read off `__ff2perf` — a
          // SEPARATE global from `__ff2`, and one that only exists under
          // `?perf=1`. The first version read `__ff2.perfSurface`, which is
          // neither, so every row was the -1 sentinel; differencing a
          // constant sentinel gave a clean-looking "0 ticks per frame" and
          // that is the third probe in this file to fail by returning
          // nothing. **A sentinel survives a difference and stops looking
          // like a sentinel**, so the reader below refuses the column rather
          // than differencing it.
          const perf = (globalThis as unknown as { __ff2perf?: { sim: () => { tick: number } } })
            .__ff2perf
          const tick = perf ? perf.sim().tick : -1
          info = `${inf.memory.geometries},${inf.memory.textures},${inf.render.calls},${inf.render.triangles},${inf.programs.length},${tick}`
        } catch {
          /* before the world exists */
        }
        g.__rideRise.push(rise)
        g.__rideVis.push(vis)
        g.__ridePhase.push(ph)
        g.__rideInfo.push(info)
        g.__rideRender.push(renderMs)
        renderMs = 0
        last = t
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await hold(page, 'Enter')
    await expect
      .poll(async () => (await launch(page)).rise, { timeout: 60_000, intervals: [100] })
      .toBeGreaterThanOrEqual(LATE_RISE)
    const before = await programs(page)
    expect(await phase(page), 'still on the lift, land still hidden').toBe('rising')

    // ── RIDE_PROFILE=1 — who spends the release's 25.7 ms? ───────────────
    //
    // DEV-249 split the release frame and found 27.7 ms of which only 2.00 is
    // inside `renderer.render`. That says it is JavaScript and says nothing
    // about WHICH, and no flag in this build turns the candidates off one at
    // a time. A CPU profile names them, needs no change to `src/`, and is
    // armed on the COUNTDOWN so the window is a few seconds rather than the
    // whole ride — 25 ms inside a 15 s profile is 0.17 % and would not
    // separate from the noise.
    //
    // The profile's own overhead inflates every number in it, so read the
    // RANKING and not the milliseconds; the magnitude is the unprofiled run's
    // to give.
    let profileT0: number | null = null
    let releaseAtMs: number | null = null
    type TraceEvent = { name: string; ph: string; ts: number; dur?: number; cat?: string }
    const traceEvents: TraceEvent[] = []
    const profiling = process.env.RIDE_PROFILE === '1'
    const cdp = profiling ? await page.context().newCDPSession(page) : null
    if (cdp) {
      await expect
        .poll(() => phase(page), { timeout: 60_000, intervals: [100] })
        .toMatch(/countdown|flying/)
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
      await cdp.send('Profiler.start')
      // The CPU profile says the release frame is DIFFUSE and that its largest
      // single item is `(garbage collector)`. A collector is a consequence, so
      // the question it raises — WHAT ALLOCATES — needs the heap sampler,
      // which attributes bytes to the stack that asked for them. Reading the
      // code instead has already produced two wrong answers in this row, both
      // naming the motes: `ensureCapacity` runs from `setSpec` at world build,
      // not at the release. 16 KiB catches a few-hundred-KB one-off without
      // drowning the run.
      await cdp.send('HeapProfiler.enable')
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384 })
      // ── And a TRACE, because the CPU profile cannot name this one ───────
      //
      // The release's 25.7 ms is not drawing, not a compile, not allocation
      // and not the sim — each ruled out with a number. A CPU profile buckets
      // what is left as `(program)`, which is V8 saying "native code, no JS
      // frame". The timeline categories DO name it: a GPU stall, a style or
      // layout pass, a decode, a font rasterisation and a major GC are five
      // different events here and one bucket there.
      cdp.on('Tracing.dataCollected', (e) => {
        const ev = e as { value?: unknown[] }
        for (const v of ev.value ?? []) traceEvents.push(v as TraceEvent)
      })
      await cdp.send('Tracing.start', {
        transferMode: 'ReportEvents',
        traceConfig: {
          includedCategories: [
            'devtools.timeline',
            'disabled-by-default-devtools.timeline',
            'disabled-by-default-v8.gc',
            'v8',
            'blink',
            'gpu',
          ],
        },
      })
      profileT0 = Date.now()
    }

    await expect.poll(() => phase(page), { timeout: 60_000, intervals: [250] }).toBe('flying')
    // Where the RELEASE sits inside the profile. Without it the busiest
    // window is not attributable: the first run put the spike at +190 ms,
    // which is both "just after the release" and "just after
    // `Profiler.start`", and those are different findings.
    if (profileT0 !== null) releaseAtMs = Date.now() - profileT0
    await page.waitForTimeout(3_000)

    if (cdp) {
      // ── The TRACE, read first: the longest events, full stop ───────────
      //
      // No sampling and no bucket. Every slice here is a real begin/end pair
      // with a name, so the answer is whichever named thing is 20-odd ms long
      // near the release. If nothing is, that is also an answer: the time is
      // between events rather than inside one, which points outside the
      // renderer process entirely.
      const traceDone = new Promise<void>((resolve) => {
        cdp.once('Tracing.tracingComplete', () => resolve())
      })
      await cdp.send('Tracing.end')
      await traceDone
      const complete = traceEvents.filter((e) => e.ph === 'X' && (e.dur ?? 0) > 0)
      const longest = [...complete].sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0)).slice(0, 16)
      console.info(
        [
          '',
          `DEV-249 trace — ${traceEvents.length} events, ${complete.length} with a duration.`,
          '  The LONGEST complete slices anywhere in the window. A CPU profile',
          '  buckets native work as `(program)`; these are named.',
          ...longest.map(
            (e) =>
              `    ${((e.dur ?? 0) / 1000).toFixed(2).padStart(8)} ms  ${e.name}  [${e.cat ?? ''}]`,
          ),
          '',
        ].join('\n'),
      )
      if (process.env.RIDE_TRACE_JSON) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(process.env.RIDE_TRACE_JSON, JSON.stringify(traceEvents))
      }
      // Heap next: `Profiler.stop` is itself a long pause, and whatever it
      // allocates would otherwise land in the heap profile on top of the
      // release.
      type HeapNode = {
        callFrame: { functionName: string; url: string; lineNumber: number }
        selfSize: number
        children?: HeapNode[]
      }
      const heap = (await cdp.send('HeapProfiler.getSamplingProfile')) as {
        profile: { head: HeapNode }
      }
      await cdp.send('HeapProfiler.stopSampling')
      const heapRows: [string, number][] = []
      const walkHeap = (n: HeapNode): void => {
        if (n.selfSize > 0) {
          const file = n.callFrame.url.split('/').pop() ?? ''
          const fn = n.callFrame.functionName || '(anonymous)'
          heapRows.push([`${fn}  ${file}:${n.callFrame.lineNumber + 1}`, n.selfSize])
        }
        for (const c of n.children ?? []) walkHeap(c)
      }
      walkHeap(heap.profile.head)
      const heapTotal = heapRows.reduce((a, r) => a + r[1], 0)
      const heapTop = [...heapRows].sort((a, b) => b[1] - a[1]).slice(0, 14)
      console.info(
        [
          '',
          `DEV-249 heap over the same window — ${(heapTotal / 1024 / 1024).toFixed(1)} MB sampled.`,
          '  Bytes by the stack that ASKED for them. The window covers the countdown,',
          '  the release and 3 s of flight, so a steady-state allocator ranks high too.',
          '  Read it for what is UNIQUE to the release, not for the top row.',
          ...heapTop.map(([n, b]) => `    ${(b / 1024).toFixed(0).padStart(8)} KB  ${n}`),
          '',
        ].join('\n'),
      )
      const { profile } = (await cdp.send('Profiler.stop')) as {
        profile: {
          nodes: {
            id: number
            callFrame: { functionName: string; url: string; lineNumber: number }
          }[]
          samples?: number[]
          timeDeltas?: number[]
        }
      }
      const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]))
      const samples = profile.samples ?? []
      const deltasUs = profile.timeDeltas ?? []
      const label = (id: number): string => {
        const cf = byId.get(id)
        if (!cf) return '(unknown)'
        const file = cf.url.split('/').pop() ?? ''
        return `${cf.functionName || '(anonymous)'}  ${file}:${cf.lineNumber + 1}`
      }
      const at: number[] = []
      let tEnd = 0
      for (let i = 0; i < samples.length; i++) {
        tEnd += Math.max(deltasUs[i] ?? 0, 0) / 1000
        at.push(tEnd)
      }
      const rank = (from: number, to: number, n: number): [string, number][] => {
        const self = new Map<string, number>()
        for (let i = 0; i < samples.length; i++) {
          const ts = at[i] ?? 0
          if (ts < from || ts > to) continue
          const name = label(samples[i] as number)
          self.set(name, (self.get(name) ?? 0) + Math.max(deltasUs[i] ?? 0, 0) / 1000)
        }
        return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      }
      // ── Find the spike rather than averaging over it ────────────────────
      //
      // The first version of this ranked the WHOLE window, and what came back
      // was the steady state — three's per-draw program lookup and the
      // particle update, over six seconds of flight. That is §3h in
      // miniature: a statistic over a period containing one outlier describes
      // the period, not the outlier. The release is ONE frame, so the window
      // that matters is the ~30 ms holding the most BUSY time, and the
      // ranking inside it is the answer.
      const WINDOW_MS = 30
      // Search only AROUND THE RELEASE, never the whole profile. `Profiler.start`
      // itself costs a long sample gap, it lands within a few hundred ms of the
      // release here, and a search over everything cannot tell the two apart.
      // `releaseAtMs` is measured by the poll above; the ±700 ms is slop for the
      // 250 ms poll interval and the round trip.
      const lo = releaseAtMs === null ? 0 : Math.max(releaseAtMs - 700, 0)
      const hi = releaseAtMs === null ? Number.POSITIVE_INFINITY : releaseAtMs + 700
      let bestAt = 0
      let bestBusy = -1
      for (let i = 0; i < samples.length; i++) {
        const from = at[i] ?? 0
        if (from < lo || from > hi) continue
        let busy = 0
        for (let j = i; j < samples.length && (at[j] ?? 0) <= from + WINDOW_MS; j++) {
          if (!label(samples[j] as number).startsWith('(idle)')) {
            busy += Math.max(deltasUs[j] ?? 0, 0) / 1000
          }
        }
        if (busy > bestBusy) {
          bestBusy = busy
          bestAt = from
        }
      }
      if (process.env.RIDE_PROFILE_JSON) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(process.env.RIDE_PROFILE_JSON, JSON.stringify(profile))
      }
      const fmt = (rows: [string, number][], dp: number): string =>
        rows.map(([n, ms]) => `    ${ms.toFixed(dp).padStart(7)}  ${n}`).join('\n')
      console.info(
        `\nDEV-249 release profile — ${MISSION} ${EDITION}, ${samples.length} samples over ${tEnd.toFixed(0)} ms.\n` +
          '  SELF time, ms, highest first. The RANKING is the finding; the profiler\n' +
          '  inflates every absolute number here.\n' +
          `  The release is at +${releaseAtMs ?? -1} ms and the search is that window ±700 ms.\n` +
          `\n  THE BUSIEST ${WINDOW_MS} ms — at +${bestAt.toFixed(0)} ms, ${bestBusy.toFixed(1)} ms of it busy. THIS IS THE SPIKE:\n` +
          `${fmt(rank(bestAt, bestAt + WINDOW_MS, 12), 2)}\n` +
          '\n  THE WHOLE WINDOW, for contrast — this is the steady state:\n' +
          `${fmt(rank(0, tEnd, 12), 1)}\n`,
      )
    }

    const after = await programs(page)
    const { deltas, rises, vis, phases, infos, renders } = (await page.evaluate(() => {
      const g = globalThis as unknown as {
        __ride: number[]
        __rideRise: number[]
        __rideVis: number[]
        __ridePhase: string[]
        __rideInfo: string[]
        __rideRender: number[]
      }
      return {
        renders: g.__rideRender,
        deltas: g.__ride,
        rises: g.__rideRise,
        vis: g.__rideVis,
        phases: g.__ridePhase,
        infos: g.__rideInfo,
      }
    })) as {
      renders: number[]
      deltas: number[]
      rises: number[]
      vis: number[]
      phases: string[]
      infos: string[]
    }
    // Every row, so a question nobody thought of at the time does not need
    // another ride to answer it. `RIDE_CSV=<path>` opts in.
    if (process.env.RIDE_CSV) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(
        process.env.RIDE_CSV,
        `i,dt_ms,render_ms,rise,land_visible,phase,geometries,textures,calls,triangles,programs,tick\n${deltas
          .map(
            (d, i) =>
              `${i},${d.toFixed(2)},${(renders[i] ?? -1).toFixed(2)},${(rises[i] ?? -1).toFixed(2)},${vis[i] ?? -1},${phases[i] ?? '?'},${infos[i] ?? ''}`,
          )
          .join('\n')}\n`,
      )
    }
    const sorted = [...deltas].slice(5).sort((a, b) => a - b)
    const max = sorted[sorted.length - 1] ?? 0
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0

    // ── The reveal frame, isolated ───────────────────────────────────────
    //
    // The first frame on which the LAND GROUP IS VISIBLE and the ride had
    // started. An rAF delta names the frame AFTER the one that did the work
    // (§5c), so the window is printed either side and the reader is told
    // which.
    // Two modes, two ground truths. Under `?rideHide=all` the land GROUP goes
    // visible and that is the event. Under DEV-249's `?rideHide=bore` — which
    // is what SHIPS since `07bf549`, and this comment said the opposite until
    // DEV-266 — the group is visible the whole ride and only a few
    // chunks toggle, so the group flag is 1 from the first frame and locating
    // by it puts the window at rise 1.0 — which is what the first bore run
    // reported, and it read as "no reveal" rather than as "wrong locator".
    // So: the group's 0→1 edge when there is one, and otherwise the largest
    // single-frame rise in the TRIANGLE count, which is the event in both.
    const tris = infos.map((s_) => Number(s_?.split(',')[3] ?? 0))
    const byGroup = vis.findIndex(
      (v, i) => v === 1 && (rises[i] ?? -1) > 1 && (vis[i - 1] ?? 1) === 0,
    )
    let byTris = -1
    let bestStep = 0
    for (let i = 1; i < tris.length; i++) {
      const step = (tris[i] ?? 0) - (tris[i - 1] ?? 0)
      if (step > bestStep && (rises[i] ?? -1) > 1) {
        bestStep = step
        byTris = i
      }
    }
    const revealAt = byGroup >= 0 ? byGroup : byTris

    // The tick column, refused rather than differenced when it is absent.
    // `__ff2perf` only exists under `?perf=1`, so a run without it records
    // the -1 sentinel on every row — and `-1 minus -1` is `0`, which reads as
    // "the sim ran no ticks" instead of "nobody asked the sim anything".
    const ticks = infos.map((s_) => Number(s_?.split(',')[5] ?? -1))
    const ticksReal = ticks.some((t_) => t_ >= 0)
    const tickNote = ticksReal
      ? (() => {
          let worstTicks = 0
          let worstAt = -1
          for (let i = 1; i < ticks.length; i++) {
            const step = (ticks[i] ?? 0) - (ticks[i - 1] ?? 0)
            if (step > worstTicks) {
              worstTicks = step
              worstAt = i
            }
          }
          return `  TICKS: most in one frame ${worstTicks} at i=${worstAt} (dt ${(deltas[worstAt] ?? 0).toFixed(1)} ms)`
        })()
      : '  TICKS: NOT MEASURED — `__ff2perf` is absent, so add `perf=1` to RIDE_PINS.'
    const around = (i: number, before_: number, after_: number): string =>
      i < 0
        ? '(the land was never hidden — no ride on this mission?)'
        : deltas
            .slice(Math.max(0, i - before_), i + after_)
            .map((d, k) => {
              const idx = Math.max(0, i - before_) + k
              const mark = idx === revealAt ? '*' : ' '
              return `${mark}${(rises[idx] ?? -1).toFixed(1)}m:${d.toFixed(1)}`
            })
            .join('  ')
    const rideOnly = deltas.filter((_, i) => (rises[i] ?? -1) > 5 && vis[i] === 0)
    const rideSorted = [...rideOnly].sort((a, b) => a - b)
    const ridePct = (p: number): number => rideSorted[Math.floor(rideSorted.length * p)] ?? 0
    const worstNear =
      revealAt < 0 ? 0 : Math.max(...deltas.slice(Math.max(0, revealAt - 2), revealAt + 20), 0)
    console.info(
      `\nDEV-117 ride — ${MISSION} ${EDITION}: ${deltas.length} frames from the shaft to release+3 s, ` +
        `max ${max.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms; programs at rise ${LATE_RISE} -> release+3 s: ${before} -> ${after}\n` +
        `  THE RIDE ALONE (rise > 5, land GROUP hidden): ${rideOnly.length} frames` +
        (rideOnly.length === 0
          ? ' — zero is CORRECT under\n' +
            '    `?rideHide=bore`, where the group never hides and only the bore chunks\n' +
            '    toggle. Compare the ride against a control run, not against this line.\n'
          : `, p50 ${ridePct(0.5).toFixed(1)} ms, p95 ${ridePct(0.95).toFixed(1)} ms\n`) +
        `  THE REVEAL (* = the land group's 0->1 edge, or the biggest triangle step where\n` +
        `  there is none; an rAF delta names the frame AFTER the work):\n` +
        `    ${around(revealAt, 6, 24)}\n` +
        `  worst frame within that window: ${worstNear.toFixed(1)} ms\n` +
        `${tickNote}\n` +
        `  ${pageLines.join('\n  ')}\n`,
    )
    expect(pageLines.length, 'the warm-up ran at world build').toBeGreaterThan(0)
    expect(after, 'no program was compiled at the reveal or the release').toBe(before)
  })
})
