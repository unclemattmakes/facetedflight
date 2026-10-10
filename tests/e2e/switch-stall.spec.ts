/**
 * tests/e2e/switch-stall.spec.ts — how long the main thread is gone when you
 * pick a course. DEV-355.
 *
 * Matt: *"add a vr-comfy loading screen — the app currently freezes."* In a
 * headset a blocked main thread is not a pause. The compositor reprojects the
 * last frame it was given, or SteamVR gives up and drops you into its own grid.
 * So the number that matters is not how long the load takes, it is **the
 * longest stretch in which no frame was produced**, and this spec reports it.
 *
 * ── What it walks ───────────────────────────────────────────────────────
 *
 * The route a player takes, and nothing shorter: the title, the room, the four
 * aimed presses of `board()`, onto `int_01_hoverJet`. Since DEV-281 that last
 * press is the load itself (a bare boot builds no island), so the window this
 * reads opens at the press (`data-switching` appears, synchronously) and closes
 * `SETTLE_MS` after it goes, which covers the fade into the cockpit and the
 * first frames of the world, where a program the warm-up missed would compile.
 * Since DEV-355 the attribute goes at the BLACK of the fade into the cockpit
 * (you are aboard), not when that fade is queued; before it, the two were the
 * same moment, because a frozen thread made the fade-out a single step.
 *
 * ── What it reports, and what it does NOT assert ────────────────────────
 *
 *   - **worst frame**: the longest interval between two `requestAnimationFrame`
 *     callbacks inside the window. Flat, so the page's own loop and this
 *     recorder's run on the same rAF clock; in a session the XR loop replaces
 *     both, and the main thread they are waiting on is the same thread.
 *   - **long tasks**: every `longtask` entry over 50 ms in the window, and their
 *     sum — the time the thread was unavailable in chunks a frame cannot fit in.
 *   - with `SWITCH_TRACE=1`, a Chrome trace of the same walk, and each long task
 *     NAMED by the `src/` call chains its CPU samples fall in. Off by default:
 *     the sampling profiler costs time inside the very tasks being timed, so the
 *     durations in the headline come from a run without it.
 *
 *   - **the build's frames** (DEV-465): where the load was waited out (the
 *     room, or DEV-355's loading scene), and the frame intervals and draw
 *     calls from the press to the world being ready — the cost of drawing the
 *     room AND building the world at once. `SWITCH_EDITION=classic` takes the
 *     loading scene's route (a Classic look's flip needs a black), so one
 *     build can report both.
 *
 * **Every duration here is contention-sensitive** (AGENT-NOTES §1: "never
 * immune"). Nothing is asserted about a millisecond. What is asserted is that
 * the run could answer the question — the observer existed, the window opened
 * and closed, frames were recorded in it, and the mission it asked for is the
 * one that loaded — so an instrument that saw nothing cannot pass as a quiet
 * switch. Run it under the GPU lease, pinned, and say what else held the box.
 *
 *   E2E_PORT=<yours> SWITCH_OUT=<dir> [SWITCH_TRACE=1] \
 *     pnpm exec playwright test tests/e2e/switch-stall.spec.ts --workers 1
 *
 * `@gpu`: a real world and a headed browser, for the reason
 * `docs/testing/TIERS.md` gives.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { board, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { decodeProgramCacheKey, nearestWarmKey } from './fixtures/program-key'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

const OUT_DIR = process.env.SWITCH_OUT ?? 'perf-out/dev-355'
const TRACE = process.env.SWITCH_TRACE === '1'
/** A label for the output files, so a before and an after can sit side by side. */
const LABEL = process.env.SWITCH_LABEL ?? 'run'
/** The look to board under (`?edition=`), or the page's own default when unset. */
const EDITION = process.env.SWITCH_EDITION ?? ''
/** What counts as a long task: the platform's own threshold. */
const LONG_MS = 50
/**
 * How long after `data-switching` goes the window stays open: the 1.0 s
 * mission fade (`LOAD_FADE_SECONDS`) and the first two seconds of the world.
 */
const SETTLE_MS = 3_000

interface LongTask {
  readonly start: number
  readonly duration: number
}

interface Recorded {
  readonly tasks: LongTask[]
  readonly frames: number[]
  /**
   * Per frame, beside `frames` (DEV-465): the draw calls three last counted,
   * and where a load is being waited out — `room`, `scene`, or '' for neither.
   * Read at the recorder's own callback, which runs BEFORE the game's in a
   * frame (it was requested first), so each describes the frame before.
   */
  readonly calls: number[]
  readonly where: string[]
  readonly switchStart: number | null
  readonly switchEnd: number | null
  /** When the world said it was ready (`data-terrain-ready`, after the press). */
  readonly readyAt: number | null
  readonly longtaskAvailable: boolean
  /** Every program three holds when the world is ready: the warm-up's work. */
  readonly keysAtEnd: string[] | null
  /** And at the moment of reading, `SETTLE_MS` later. */
  readonly keysNow: string[]
}

/** The slice of the debug handle this reads: three's own program list, and the stage. */
interface ProgramsHandle {
  readonly __ff2?: {
    readonly render: {
      readonly renderer: {
        readonly info: {
          readonly programs: { cacheKey: string }[] | null
          readonly render: { readonly calls: number }
        }
      }
    }
    readonly stage: () => StageLike
  }
}
interface StageLike {
  readonly name: string
  readonly visible: boolean
  readonly getObjectByName: (n: string) => StageLike | undefined
}

/**
 * The three recorders, installed BEFORE any page script runs.
 *
 * `addInitScript` rather than an `evaluate` later, because the press is what
 * starts the work and an observer attached after it would miss the first task.
 * The rAF recorder is the harness doing something EXTRA — its own callback,
 * one `push` a frame — and the game's code path is untouched (CLAUDE.md: the
 * line is whether the GAME behaves differently). The `data-switching` stamps
 * go in as `performance.mark`s too, so a Chrome trace of the same run carries
 * the window on its own clock.
 */
const installRecorders = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    interface Store {
      tasks: { start: number; duration: number }[]
      frames: number[]
      calls: number[]
      where: string[]
      switchStart: number | null
      switchEnd: number | null
      readyAt: number | null
      longtaskAvailable: boolean
      keysAtEnd: string[] | null
    }
    const store: Store = {
      tasks: [],
      frames: [],
      calls: [],
      where: [],
      switchStart: null,
      switchEnd: null,
      readyAt: null,
      longtaskAvailable: true,
      keysAtEnd: null,
    }
    /** DEV-465: where a load is being waited out, read off the live stage. */
    const waitingIn = (): string => {
      const app = (globalThis as unknown as ProgramsHandle).__ff2
      const stage = app?.stage()
      if (stage?.name !== 'menu') return ''
      const scene = stage.getObjectByName('loading-scene')
      if (!scene?.visible) return ''
      if (scene.getObjectByName('loading-dome')?.visible) return 'scene'
      return stage.getObjectByName('hangar')?.visible ? 'room' : ''
    }
    const programKeys = (): string[] | null =>
      (globalThis as unknown as ProgramsHandle).__ff2?.render.renderer.info.programs?.map(
        (p) => p.cacheKey,
      ) ?? null
    ;(globalThis as unknown as { __ff2switch: Store }).__ff2switch = store
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          store.tasks.push({ start: e.startTime, duration: e.duration })
      }).observe({ type: 'longtask', buffered: true })
    } catch {
      // Chromium-only. An empty list must read as "could not see", not "none".
      store.longtaskAvailable = false
    }
    const tick = (t: number): void => {
      store.frames.push(t)
      store.calls.push(
        (globalThis as unknown as ProgramsHandle).__ff2?.render.renderer.info.render.calls ?? -1,
      )
      store.where.push(waitingIn())
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    let unready = false
    const watch = (): void => {
      new MutationObserver(() => {
        const on = document.body.dataset.switching === 'true'
        const now = performance.now()
        if (on && store.switchStart === null) {
          store.switchStart = now
          performance.mark('ff2-switch-start')
        } else if (!on && store.switchStart !== null && store.switchEnd === null) {
          store.switchEnd = now
          performance.mark('ff2-switch-end')
        }
        // The programs, when the WORLD is ready: `buildWorld` sets the
        // attribute after the warm-up and before any frame of the mission, and
        // this observer runs in that same turn. Not at `data-switching` going:
        // that happens inside the frame whose render is the mission's first, and
        // an observer only hears of it after that render has compiled whatever
        // it compiled — the very programs this is here to count.
        // And only once it has been seen NOT ready since the press, so an
        // attribute left over from the world being replaced cannot answer.
        const ready = document.body.dataset.terrainReady === 'true'
        if (store.switchStart !== null && !ready) unready = true
        if (unready && ready && store.keysAtEnd === null) {
          store.keysAtEnd = programKeys()
          store.readyAt = now
        }
      }).observe(document.body, {
        attributes: true,
        attributeFilter: ['data-switching', 'data-terrain-ready'],
      })
    }
    if (document.body) watch()
    else document.addEventListener('DOMContentLoaded', watch)
  })
}

const readRecorded = (page: Page): Promise<Recorded> =>
  page.evaluate(() => {
    const s = (globalThis as unknown as { __ff2switch: Recorded }).__ff2switch
    const programs = (globalThis as unknown as ProgramsHandle).__ff2?.render.renderer.info.programs
    return {
      tasks: s.tasks.slice(),
      frames: s.frames.slice(),
      calls: s.calls.slice(),
      where: s.where.slice(),
      switchStart: s.switchStart,
      switchEnd: s.switchEnd,
      readyAt: s.readyAt,
      longtaskAvailable: s.longtaskAvailable,
      keysAtEnd: s.keysAtEnd,
      keysNow: programs?.map((p) => p.cacheKey) ?? [],
    }
  })

// ── the trace half: name each long task by the code its samples fall in ──

interface TraceEvent {
  readonly name: string
  readonly ph: string
  readonly ts: number
  readonly dur?: number
  readonly pid: number
  readonly tid: number
  readonly id?: string
  readonly args?: {
    readonly data?: {
      readonly startTime?: number
      readonly cpuProfile?: {
        readonly nodes?: {
          readonly id: number
          readonly parent?: number
          readonly callFrame: {
            readonly functionName: string
            readonly url?: string
            readonly lineNumber?: number
          }
        }[]
        readonly samples?: number[]
      }
      readonly timeDeltas?: number[]
    }
  }
}

interface NamedTask {
  /** ms after the press, on the trace clock. */
  readonly at: number
  readonly ms: number
  /** `src/` call chains, heaviest first, with the ms of samples under each. */
  readonly chains: { readonly name: string; readonly ms: number }[]
  /** The leaf functions, heaviest first — where a native call (a GL upload, a link) shows. */
  readonly leaves: { readonly name: string; readonly ms: number }[]
}

/** `/src/game/terrain/load-terrain.ts?t=123` → `terrain/load-terrain`. */
const shortFile = (url: string): string => {
  const at = url.indexOf('/src/')
  const tail = at >= 0 ? url.slice(at + 5) : url
  return tail.replace(/\?.*$/, '').replace(/\.ts$/, '')
}

/**
 * Each RunTask over `LONG_MS` in the window, with its CPU samples bucketed.
 *
 * A chain is the `src/` frames of a sample's stack, outermost first, the last
 * four kept — which is enough to read `buildWorld > loadTerrain >
 * generateChunk` and short enough to aggregate. The leaf is kept separately
 * because the expensive thing is often NOT ours: a `linkProgram`, a
 * `texImage2D`, a `(garbage collector)`.
 */
const nameTasks = (events: TraceEvent[]): { tasks: NamedTask[]; note: string } => {
  const start = events.find((e) => e.name === 'ff2-switch-start')
  const end = events.find((e) => e.name === 'ff2-switch-end')
  if (!start || !end) return { tasks: [], note: 'the switch marks are not in the trace' }
  const { pid, tid } = start
  const t0 = start.ts
  const t1 = end.ts + SETTLE_MS * 1000

  // The top-level tasks on the page's main thread. Newer Chrome says `RunTask`;
  // the older name is kept so the reader does not go quiet on a version bump.
  const runTasks = events
    .filter(
      (e) =>
        e.pid === pid &&
        e.tid === tid &&
        e.ph === 'X' &&
        (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') &&
        (e.dur ?? 0) > LONG_MS * 1000 &&
        e.ts + (e.dur ?? 0) >= t0 &&
        e.ts <= t1,
    )
    .sort((a, b) => a.ts - b.ts)
  // Drop a task nested inside another: only the outermost is a frame lost.
  const outer = runTasks.filter(
    (e) =>
      !runTasks.some((o) => o !== e && o.ts <= e.ts && o.ts + (o.dur ?? 0) >= e.ts + (e.dur ?? 0)),
  )

  // The CPU profile of the main thread, stitched from its chunks.
  const profileIds = new Set(
    events.filter((e) => e.name === 'Profile' && e.pid === pid && e.tid === tid).map((e) => e.id),
  )
  const nodes = new Map<
    number,
    { parent: number | undefined; name: string; url: string; line: number }
  >()
  const samples: { ts: number; node: number }[] = []
  for (const id of profileIds) {
    const head = events.find((e) => e.name === 'Profile' && e.id === id)
    let ts = head?.args?.data?.startTime ?? 0
    for (const chunk of events.filter((e) => e.name === 'ProfileChunk' && e.id === id)) {
      const data = chunk.args?.data
      for (const n of data?.cpuProfile?.nodes ?? []) {
        // A native frame — `(program)`, `(garbage collector)`, a GL call — can
        // arrive with no `url` at all, not an empty one.
        nodes.set(n.id, {
          parent: n.parent,
          name: n.callFrame.functionName || '(anonymous)',
          url: n.callFrame.url ?? '',
          line: (n.callFrame.lineNumber ?? 0) + 1,
        })
      }
      const ids = data?.cpuProfile?.samples ?? []
      const deltas = data?.timeDeltas ?? []
      for (let i = 0; i < ids.length; i++) {
        ts += deltas[i] ?? 0
        samples.push({ ts, node: ids[i] as number })
      }
    }
  }
  samples.sort((a, b) => a.ts - b.ts)
  const note =
    samples.length === 0
      ? 'no CPU samples on the main thread: the tasks are timed but not named'
      : `${samples.length} CPU samples on the main thread`

  const tasks = outer.map((task) => {
    const from = task.ts
    const to = task.ts + (task.dur ?? 0)
    const inside = samples.filter((s) => s.ts >= from && s.ts <= to)
    const perSample = inside.length > 0 ? (task.dur ?? 0) / 1000 / inside.length : 0
    const chains = new Map<string, number>()
    const leaves = new Map<string, number>()
    for (const s of inside) {
      const stack: string[] = []
      let leaf = ''
      for (let id: number | undefined = s.node; id !== undefined; id = nodes.get(id)?.parent) {
        const n = nodes.get(id)
        if (!n) break
        if (leaf === '') leaf = n.url.includes('/src/') ? `${n.name} (${shortFile(n.url)})` : n.name
        if (n.url.includes('/src/')) {
          const label = `${n.name}@${shortFile(n.url)}:${n.line}`
          if (stack[stack.length - 1] !== label) stack.push(label)
        }
      }
      const chain = stack.length === 0 ? '(no src frame)' : stack.slice(0, 4).reverse().join(' > ')
      chains.set(chain, (chains.get(chain) ?? 0) + perSample)
      leaves.set(leaf, (leaves.get(leaf) ?? 0) + perSample)
    }
    const top = (m: Map<string, number>, n: number): { name: string; ms: number }[] =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([name, ms]) => ({ name, ms: Math.round(ms) }))
    return {
      at: Math.round((from - t0) / 1000),
      ms: Math.round((task.dur ?? 0) / 1000),
      chains: top(chains, 5),
      leaves: top(leaves, 5),
    }
  })
  return { tasks, note }
}

test.describe('@measure @gpu DEV-355: the main thread across a course switch', () => {
  test.setTimeout(600_000)

  test('int_01_hoverJet from the room: worst frame and long tasks, reported', async ({
    page,
    browser,
  }) => {
    await installRecorders(page)
    const logs: string[] = []
    page.on('console', (m) => logs.push(m.text()))

    await page.goto(`/?xr=off&${PINNED}${EDITION ? `&edition=${EDITION}` : ''}`)
    await firstPress(page)
    await bootReady(page, 240_000)
    await dropFocus(page)
    await page.waitForTimeout(1_500)

    // Title -> the room.
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar

    fs.mkdirSync(OUT_DIR, { recursive: true })
    const stem = `int_01_hoverJet-${EDITION || 'default'}-${LABEL}${TRACE ? '-traced' : ''}`
    const tracePath = path.join(OUT_DIR, `${stem}.trace.json`)
    if (TRACE) {
      await browser.startTracing(page, {
        path: tracePath,
        categories: [
          'devtools.timeline',
          'disabled-by-default-devtools.timeline',
          'toplevel',
          'blink.user_timing',
          'v8.execute',
          'disabled-by-default-v8.cpu_profiler',
        ],
      })
    }

    // The walk, and the load it ends in. `board` waits for the mission world.
    await board(page, INT_01_HOVERJET, 1_000)
    // And the window's tail: the fade into the cockpit and the world's first
    // frames, which is where a program the warm-up missed would show.
    await page.waitForTimeout(SETTLE_MS + 500)

    if (TRACE) await browser.stopTracing()
    const rec = await readRecorded(page)

    // ── the mechanisms, asserted before any number is printed ──────────────
    expect(rec.longtaskAvailable, 'longtask is unavailable, so this run measures nothing').toBe(
      true,
    )
    expect(rec.switchStart, 'the press never set data-switching').not.toBeNull()
    expect(rec.switchEnd, 'the switch never finished').not.toBeNull()
    expect(
      logs.some((l) => l.includes('now flying int_01_hoverJet')),
      'the switch landed on the mission it asked for',
    ).toBe(true)
    expect(
      await page.evaluate(() => document.body.dataset.terrainError ?? null),
      'the world built',
    ).toBeNull()

    const from = rec.switchStart as number
    const to = (rec.switchEnd as number) + SETTLE_MS
    const frames = rec.frames.filter((t) => t >= from && t <= to)
    expect(frames.length, 'frames were recorded inside the window').toBeGreaterThan(5)
    // An interval that STRADDLES the press belongs to it too: the first frame
    // after the press is the one the press delayed.
    const before = rec.frames.filter((t) => t < from).pop()
    const stamps = before === undefined ? frames : [before, ...frames]
    const gaps = stamps
      .slice(1)
      .map((t, i) => ({ at: stamps[i] as number, ms: t - (stamps[i] as number) }))
    const worst = gaps.reduce((a, b) => (b.ms > a.ms ? b : a), { at: from, ms: 0 })
    const longTasks = rec.tasks.filter(
      (t) => t.duration > LONG_MS && t.start + t.duration >= from && t.start <= to,
    )
    const blocked = longTasks.reduce((a, t) => a + t.duration, 0)
    const overBudget = gaps.filter((g) => g.ms > LONG_MS)

    // ── the build's own frames (DEV-465) ──────────────────────────────────
    //
    // From the press to the world being ready: every interval, and the draw
    // calls, while the room (or the scene) is drawn AND the world is built. A
    // percentile of intervals is a duration, so contention-sensitive like the
    // rest; the draw calls are a count of a frame, and are not.
    const readyAt = rec.readyAt ?? to
    const buildIdx = rec.frames
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t >= from && t <= readyAt)
      .map(({ i }) => i)
    const buildGaps = buildIdx
      .slice(1)
      .map((i, k) => (rec.frames[i] as number) - (rec.frames[buildIdx[k] as number] as number))
      .sort((a, b) => a - b)
    const pct = (p: number): number =>
      buildGaps.length === 0
        ? Number.NaN
        : (buildGaps[Math.min(buildGaps.length - 1, Math.floor(p * buildGaps.length))] as number)
    const buildCalls = buildIdx
      .map((i) => rec.calls[i] as number)
      .filter((c) => c >= 0)
      .sort((a, b) => a - b)
    const waitedIn = [...new Set(buildIdx.map((i) => rec.where[i]).filter((w) => w))]

    // ── the programs three built AFTER the warm-up said it was done ─────────
    //
    // A compile is the one long task that can land on a frame the player SEES,
    // because it happens on first draw. Each late key is set beside the warm
    // key it is nearest to, and the fields that separate them are the
    // mechanism: `numPointLights 2 -> 3` is a light the warm did not have in
    // the scene, `outputColorSpace` is the wrong render target (DEV-239).
    expect(rec.keysAtEnd, 'the program list was readable when the world was ready').not.toBeNull()
    const warmKeys = rec.keysAtEnd as string[]
    const warmSet = new Set(warmKeys)
    const lateKeys = rec.keysNow.filter((k) => !warmSet.has(k))
    const lateWhy = new Map<string, number>()
    for (const key of lateKeys) {
      const decoded = decodeProgramCacheKey(key)
      const near = nearestWarmKey(decoded, warmKeys)
      // WHAT it is, as far as a key can say: the shader and the module tags.
      // The tag is three's `onBeforeCompile.toString()` and then one `|token`
      // per `tagProgramCacheKey`; the tokens are the names.
      const tokens = (decoded.tag.match(/\|[a-z][a-z0-9-]*(?=\||$)/g) ?? []).map((t) => t.slice(1))
      const what = `${decoded.shaderId ?? 'custom'} [${tokens.join('+') || 'untagged'}]`
      const why =
        near === null
          ? `${what}: no warm key at all`
          : `${what}: ${near.sameMaterial ? 'same material' : 'nearest other material'}, ${
              near.differences.map((d) => `${d.field} ${d.theirs} -> ${d.mine}`).join(', ') ||
              '(identical fields)'
            }`
      lateWhy.set(why, (lateWhy.get(why) ?? 0) + 1)
    }

    const named =
      TRACE && fs.existsSync(tracePath)
        ? nameTasks(
            (JSON.parse(fs.readFileSync(tracePath, 'utf8')) as { traceEvents: TraceEvent[] })
              .traceEvents,
          )
        : null

    const report = {
      mission: 'int_01_hoverJet',
      label: LABEL,
      edition: EDITION || 'default',
      traced: TRACE,
      waitedIn,
      build: {
        ms: Math.round(readyAt - from),
        frames: buildIdx.length,
        intervalP50Ms: Math.round(pct(0.5) * 10) / 10,
        intervalP95Ms: Math.round(pct(0.95) * 10) / 10,
        intervalMaxMs: Math.round(pct(1) * 10) / 10,
        callsMedian: buildCalls[Math.floor(buildCalls.length / 2)] ?? null,
        callsMax: buildCalls[buildCalls.length - 1] ?? null,
      },
      switchMs: Math.round((rec.switchEnd as number) - from),
      windowMs: Math.round(to - from),
      worstFrameMs: Math.round(worst.ms),
      worstFrameAtMs: Math.round(worst.at - from),
      framesInWindow: frames.length,
      framesOver50: overBudget.length,
      longTasks: longTasks.map((t) => ({
        at: Math.round(t.start - from),
        ms: Math.round(t.duration),
      })),
      longTaskCount: longTasks.length,
      blockedMs: Math.round(blocked),
      programsWarm: warmKeys.length,
      programsLate: lateKeys.length,
      programsLateWhy: Object.fromEntries(lateWhy),
      named,
    }
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.json`), JSON.stringify(report, null, 1))

    console.info(
      [
        `\nDEV-355 — int_01_hoverJet, flat, ${PINNED}, ${LABEL}${TRACE ? ' (TRACED: durations inflated)' : ''}`,
        `  press -> aboard ${report.switchMs} ms; window ${report.windowMs} ms, ${frames.length} frames`,
        `  waited out in: ${waitedIn.join(' then ') || '(nothing recorded)'} (edition ${report.edition})`,
        `  build (press -> world ready, ${report.build.ms} ms, ${report.build.frames} frames): ` +
          `interval p50 ${report.build.intervalP50Ms} · p95 ${report.build.intervalP95Ms} · ` +
          `max ${report.build.intervalMaxMs} ms; draw calls median ${report.build.callsMedian}, ` +
          `max ${report.build.callsMax}`,
        `  WORST FRAME ${report.worstFrameMs} ms, at +${report.worstFrameAtMs} ms`,
        `  frames over ${LONG_MS} ms: ${overBudget.length}`,
        `  long tasks: ${longTasks.length}, ${report.blockedMs} ms blocked in total`,
        ...report.longTasks.map(
          (t) => `    +${String(t.at).padStart(6)} ms  ${String(t.ms).padStart(5)} ms`,
        ),
        `  programs: ${warmKeys.length} when the world was ready, ${lateKeys.length} built after it`,
        ...[...lateWhy.entries()].map(([why, n]) => `    ${String(n).padStart(4)} x ${why}`),
        ...(named
          ? [
              `  named (${named.note}):`,
              ...named.tasks.flatMap((t) => [
                `    +${String(t.at).padStart(6)} ms  ${String(t.ms).padStart(5)} ms`,
                ...t.chains.map((c) => `        ${String(c.ms).padStart(5)} ms  ${c.name}`),
                `        leaves: ${t.leaves.map((l) => `${l.name} ${l.ms}`).join(' · ')}`,
              ]),
            ]
          : []),
        `  written to ${path.resolve(OUT_DIR)}`,
        '',
      ].join('\n'),
    )
  })
})
