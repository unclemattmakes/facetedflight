/**
 * tests/e2e/perf-scale.spec.ts — is the frame FILL or DRAW CALLS? Sweep the
 * resolution on one frozen frame and read the slope.
 *
 * `perf-fill.spec.ts` ranks what the frame costs. It cannot say WHY, and the
 * two answers want opposite fixes: fill is cut by samples, pixels and shader
 * ALU, draw calls are cut by merging meshes. Guessing between them is how a
 * perf session spends a day on the wrong half.
 *
 * The separation is one line of arithmetic. On a frozen frame nothing moves,
 * so the only variable is the drawing buffer:
 *
 *     gpu(px) = A + B x megapixels
 *
 * **A** is everything that does not care how many pixels it covers — the
 * per-draw submission, the vertex work, the shadow pass (its own map is a
 * fixed 2048², untouched by the viewport). **B** is fill: fragments, samples,
 * bandwidth, the resolve. Sweep four sizes, fit a line, and the frame's
 * milliseconds are split without a headset and without an opinion.
 *
 * Playwright can only set `deviceScaleFactor` for a whole test, but
 * `setViewportSize` moves mid-test — and that goes through the page's own
 * resize handler into `renderer.setSize`, the path a visitor takes by dragging
 * a window edge. So the sweep is the ordinary resize path, four times.
 *
 * The same sweep runs with one group hidden at a time, which attributes A and
 * B *per group*: a row whose B is large is a fragment problem, a row whose A is
 * large is a draw-call problem. `perf-fill.spec.ts` on this build says the
 * terrain chunks are 10.7 ms of a 16.2 ms frame from **146 draws carrying
 * 146 k triangles** — a thousand triangles a call — and that shape is
 * consistent with either answer until this spec runs.
 *
 *   SCALE_AT=20 SCALE_DIR=perf-out/scale E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/perf-scale.spec.ts --workers 1
 *
 * `@gpu`, hydrated assets, one worker. Prints; gates only that the fit is a
 * fit (see the end).
 */
import fs from 'node:fs'
import path from 'node:path'
import { BUSY_BROWSERS, machineLoad } from '../../tools/perf/measure-queue.mjs'
import { flyToFreeze } from './fixtures/freeze'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

/** Backing-store widths to sweep, in CSS pixels before `deviceScaleFactor`. */
const DPR = Number(process.env.SCALE_DPR ?? '2')
const STEPS = (process.env.SCALE_STEPS ?? '629,1258,1886,2516')
  .split(',')
  .map((s) => Math.round(Number(s) / DPR))
const MISSION = process.env.SCALE_MISSION ?? 'int_01_hoverJet'
const EDITION = process.env.SCALE_EDITION ?? 'anniversary'
const SNAP_AT = Number(process.env.SCALE_AT ?? '20')
const OUT_DIR = process.env.SCALE_DIR ?? 'perf-out/scale'
const READ_MS = Number(process.env.SCALE_READ_MS ?? '3000')
/**
 * Extra query parameters, `a=b&c=d`. For a pin that can only be taken as two
 * LOADS — `?aa=` most of all, because multisampling is a WebGL context
 * attribute and there is no way to flip it on a live context (DEV-165).
 */
const EXTRA = Object.fromEntries(new URLSearchParams(process.env.SCALE_PARAMS ?? ''))
const SETTLE_MS = 1_500

/**
 * The groups to attribute, by `boot/render-census.ts`'s row key.
 *
 * Hand-picked rather than "every census row": the sweep costs four readings a
 * config, and on this frame `perf-fill.spec.ts` already showed that everything
 * outside these three sits inside its own drift.
 */
const GROUPS = (process.env.SCALE_GROUPS ?? 'world-terrain/chunks,particle-fx,world-ocean').split(
  ',',
)
/**
 * Switchable Anniversary systems to sweep as well, `a.b,c.d`. Empty by default
 * — each one costs a whole sweep.
 *
 * They are done HERE and not in `perf-fill.spec.ts` because this is the spec
 * whose readings are demonstrably free of the vsync ceiling: run on the same
 * build, at the same 2516 px, with the same `--disable-gpu-vsync`, the two
 * specs disagree by 16.34 against 6.42 ms, and the only structural difference
 * is that this one RESIZES the drawing buffer before every reading. Until that
 * is understood, the instrument with the empty-stage control and an R2 of
 * 0.999 is the one to believe.
 */
const FLAGS = (process.env.SCALE_FLAGS ?? '').split(',').filter((f) => f.length > 0)
/**
 * Numeric preset knobs to sweep, `a.b.c=value,d.e=value`. Empty by default.
 *
 * DEV-166's two are the reason this exists: `render.shadows.mapSize` and
 * `render.shadows.castDistance` are numbers in the edition JSON, not enabled
 * flags, and the shadow pass turns out to be **60 % of the frame's whole FIXED
 * term** — the part a resolution sweep cannot see and the part a second eye
 * does not pay twice, because three renders the shadow map once for both.
 */
const KNOBS = (process.env.SCALE_KNOBS ?? '').split(',').filter((k) => k.includes('='))
/**
 * `render/fragment-gates.ts` arms to sweep, and the reason this spec grew a
 * fourth kind of knob.
 *
 * The frame's LARGEST item is the terrain chunks' fill — ~4.3 ms of a worn 11.7
 * (`VR-PERF-WAVE-2-WORK.md` §8) — and until now there was no way to price any
 * part of it here. `?terrainLit=` decides a material CLASS, which is decided
 * when the mesh is built, so its A/B is two loads; and protocol §3a-ter says
 * this laptop cannot compare two loads of a fill-dominated cost, because the
 * GPU throttles inside the three-second reading window. A bracketed A-B-A of
 * one such pair came back 4.82 / 4.27 / 7.05 ms for two arms that were the
 * same build.
 *
 * A `#define` is the one switch that moves on a live page: three hashes
 * `material.defines` into the program cache key, so flipping one fetches a
 * different program and flipping it back fetches the first out of the cache.
 * That puts the terrain's fragment stack on the WITHIN-run protocol — the one
 * with the drift column and the R2 of 0.999.
 *
 *   SCALE_GATES='noPointLights,noIbl,noIbl+noPointLights,unlit'
 *
 * One arm per entry; `+` joins gates inside an arm; `@land`, `@ocean` or
 * `@both` picks which terrain (default `land`, because the island and the sea
 * are separate census rows and an arm thrown on both prices two systems as
 * one).
 */
const GATE_ARMS = (process.env.SCALE_GATES ?? '').split(',').filter((g) => g.length > 0)
/**
 * `SCALE_BATCH=1` — sweep DEV-193's chunk fold as an arm.
 *
 * The one question that spike could not answer about its own result. It
 * collapses the frame from **322 draw calls to 85** and says so with an exact
 * count reproduced on three loads — but §11.12 puts the chunk row's whole FIXED
 * term at ~1.16 ms an eye, and **nobody has ever measured how much of that is
 * draw SUBMISSION rather than vertex work.** Batching attacks only the first.
 * §2's independent 7.7 µs-a-draw derivation says most of it; if that is wrong
 * the win is near zero, and a count cannot tell the difference.
 *
 * `__ff2.chunkBatch(on)` flips on a live page, so this is a within-run A/B on
 * the instrument that works — no cross-run pin, and the arm proves itself for
 * free: **the draw-call count is already carried on every reading**, so a fold
 * that did not happen is visible in the row rather than inferred from a
 * millisecond that did not move.
 */
const BATCH_ARM = process.env.SCALE_BATCH === '1'

/**
 * The GPU median, with the ONE failure mode this rig has, handled.
 *
 * `boot/gpu-timer.ts` drops every query in flight on a `GPU_DISJOINT_EXT` —
 * correct, because their results would be lies — and with the loop unthrottled
 * the GPU is pegged, so clock and power transitions fire often enough that the
 * ring can stay empty for a whole three-second window. The first vsync-off run
 * of this spec read `0.00` at the two LARGEST sizes for exactly that reason,
 * which looks like "free" and means "no samples".
 *
 * So: read the sample COUNT as well as the median, and retry a window that came
 * back empty. Returns null after `RETRIES`, which prints as `n/a` rather than
 * as a zero — an empty ring must never be able to masquerade as a cheap frame.
 */
const RETRIES = 3

const gpuMs = async (page: Page): Promise<number | null> => {
  const supported = await page.evaluate(() => {
    const g = (
      globalThis as unknown as { __ff2: { gpu: { supported: boolean; enable: () => void } } }
    ).__ff2.gpu
    g.enable()
    return g.supported
  })
  if (!supported) return null
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    await page.evaluate(() =>
      (globalThis as unknown as { __ff2: { gpu: { reset: () => void } } }).__ff2.gpu.reset(),
    )
    await page.waitForTimeout(READ_MS * (attempt + 1))
    const read = await page.evaluate(() =>
      (
        globalThis as unknown as {
          __ff2: { gpu: { stats: () => { medianMs: number; frames: number } } }
        }
      ).__ff2.gpu.stats(),
    )
    // A handful of samples is a median of noise; 30 is a tenth of the ring.
    if (read.frames >= 30) return read.medianMs
  }
  return null
}

const buffer = (page: Page): Promise<{ width: number; height: number; calls: number }> =>
  page.evaluate(() => {
    const r = (
      globalThis as unknown as {
        __ff2: {
          render: {
            renderer: {
              info: { render: { calls: number } }
              getContext: () => WebGL2RenderingContext
            }
          }
        }
      }
    ).__ff2.render.renderer
    const gl = r.getContext()
    return {
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
      calls: r.info.render.calls,
    }
  })

/** The loop's own wall median over the recorder's 3 s window. */
const wallMs = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2: { perf: { stats: () => { p50Ms: number } } } }
      ).__ff2.perf.stats().p50Ms,
  )

const setFlag = async (page: Page, dotted: string, enabled: boolean): Promise<void> => {
  await page.evaluate(
    ([p, on]) => {
      const w = globalThis as unknown as {
        __ff2: { edition: { current: Record<string, unknown>; setPreset: (e: unknown) => void } }
      }
      const e = structuredClone(w.__ff2.edition.current) as Record<string, unknown>
      const [a, b] = (p as string).split('.') as [string, string]
      const block = e[a] as Record<string, unknown>
      block[b] = { ...(block[b] as Record<string, unknown>), enabled: on }
      w.__ff2.edition.setPreset(e)
    },
    [dotted, enabled] as const,
  )
}

/**
 * Set one NUMBER on the live preset, by dotted path, through the Edition page's
 * own setter. Returns what it replaced, so the sweep can put it back exactly.
 */
const setEditionNumber = (page: Page, dotted: string, value: number): Promise<number | null> =>
  page.evaluate(
    ([p, v]) => {
      const w = globalThis as unknown as {
        __ff2: { edition: { current: Record<string, unknown>; setPreset: (e: unknown) => void } }
      }
      const edition = structuredClone(w.__ff2.edition.current) as Record<string, unknown>
      const parts = (p as string).split('.')
      const leaf = parts.pop() as string
      let node = edition as Record<string, unknown>
      for (const part of parts) node = node[part] as Record<string, unknown>
      const previous = typeof node[leaf] === 'number' ? (node[leaf] as number) : null
      node[leaf] = v as number
      w.__ff2.edition.setPreset(edition)
      return previous
    },
    [dotted, value] as const,
  )

/**
 * Throw a fragment-gate arm on the live terrain, and say how many materials
 * moved. Zero is a typo or a stage with no terrain, and the caller gates on it.
 */
const setGates = (
  page: Page,
  gates: readonly string[],
  which: string,
): Promise<{ moved: number; defines: string[] }> =>
  page.evaluate(
    ([g, w]) =>
      (
        globalThis as unknown as {
          __ff2: {
            fragmentGates: (
              gates: readonly string[],
              which: string,
            ) => { moved: number; defines: string[] }
          }
        }
      ).__ff2.fragmentGates(g as string[], w as string),
    [gates, which] as const,
  )

/**
 * The cache key of every program three is currently holding.
 *
 * The mechanism check behind every gate arm, and the one this instrument cannot
 * do without. **A define that never reaches the compiler produces a row that
 * reads "this cut costs nothing"** — which is indistinguishable, from the
 * outside, from a real result, and is the exact shape of the three rankings
 * this month retracted.
 *
 * Counting programs does not prove it: three releases a program the instant its
 * last user re-fetches, so flipping one material's define deletes one key and
 * creates one and the count never moves. The KEY does prove it.
 * `WebGLPrograms.getProgramCacheKey` pushes every name in `material.defines`
 * into the key, and `WebGLProgram` keeps it on the instance — so a live program
 * whose key contains `FF2_NO_IBL` is a program three compiled with that define
 * set, which is the whole claim.
 */
const liveCacheKeys = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2: {
            render: { renderer: { info: { programs?: { cacheKey: string }[] } } }
          }
        }
      ).__ff2.render.renderer.info.programs?.map((p) => String(p.cacheKey)) ?? [],
  )

/** Fold or unfold DEV-193's chunk batches on the live page; returns its report. */
const setChunkBatch = (page: Page, on: boolean): Promise<unknown> =>
  page.evaluate(
    (want) =>
      (
        globalThis as unknown as { __ff2: { chunkBatch: (on?: boolean) => unknown } }
      ).__ff2.chunkBatch(want as boolean),
    on,
  )

/** `perf-fill.spec.ts`'s, unchanged — hide a census row's group on the live stage. */
const setGroupVisible = (page: Page, group: string, visible: boolean): Promise<number> =>
  page.evaluate(
    ([key, want]) => {
      const w = globalThis as unknown as {
        __ff2: { stage: () => { children: { name: string; type: string; visible: boolean }[] } }
      }
      const stage = w.__ff2.stage()
      const parts = (key as string).split('/')
      const top = parts[0]
      const second = parts[1]
      const chunkName = /^chunk_-?\d+_-?\d+$/
      let moved = 0
      // `*` is the control: every top-level child at once, so a size can be
      // read with nothing in the scene.
      if (top === '*') {
        for (const child of stage.children) {
          child.visible = want as boolean
          moved++
        }
        return moved
      }
      for (const child of stage.children) {
        if ((child.name || child.type) !== top) continue
        if (second === undefined) {
          child.visible = want as boolean
          moved++
          continue
        }
        const group = child as unknown as {
          children: { name: string; type: string; visible: boolean }[]
        }
        for (const g of group.children) {
          const name = chunkName.test(g.name) ? 'chunks' : g.name || g.type
          if (name !== second) continue
          g.visible = want as boolean
          moved++
        }
      }
      return moved
    },
    [group, visible] as const,
  )

interface Point {
  readonly mpx: number
  readonly gpu: number
  /** The loop's wall median at that size — the vsync tell, side by side. */
  readonly wall: number
  readonly width: number
  readonly calls: number
  /**
   * Independent Chrome BROWSERS alive at this reading, `null` if unknown.
   *
   * ── The hole this closes, which cost a whole conclusion ─────────────────
   *
   * `measure-queue.mjs` counts browsers BEFORE a row and never again, so a peer
   * session that starts driving headed Chrome *during* a four-minute row is
   * invisible to it. On 2026-09-17 that happened twice inside nine minutes: a
   * composition row finished at 15:41:25 against a peer's 15:40–15:42 window
   * (its last two sweeps broke, and nothing else did), and a `?pointLights=keep`
   * row ran 15:42–15:45:52 against their 15:43–15:45 and 15:45–15:46 windows
   * and came back with five of six rows unreadable.
   *
   * The damage was not the lost rows. It was the CONCLUSION: the working notes
   * briefly said *"the instrument is now the blocker, not the frame"*, which is
   * a hardware argument, when the truth was **not measured** — a four-minute
   * run on a quiet box away. The peer volunteered their own log mtimes and the
   * overlap was exact.
   *
   * So the count travels with every reading and prints beside every row.
   * Per-sweep, because that is the resolution at which the contamination
   * actually arrives.
   */
  readonly browsers: number | null
  /**
   * `node.exe` count and total CPU load at this reading.
   *
   * Browsers alone are not enough, and the hole was found by a peer within the
   * hour: **a sibling running `pnpm check` is node and tsc with ZERO Chrome**,
   * and a renderer starved of CPU produces a frame pinned by a fixed non-GPU
   * term that stops responding to resolution — which is precisely §11.11's
   * cliff signature. The probe meant to defend the measurement could not tell
   * the finding from the contaminant that most resembles it.
   *
   * PRINTED, not gated. There is no defensible bar for either yet, and
   * inventing one would be a number with no provenance. What a reader wants is
   * the RANGE across a row: `node 2-9` says a sibling arrived mid-row, which is
   * the resolution the contamination actually arrives at.
   */
  readonly nodes: number | null
  readonly cpu: number | null
}

/** Least squares through `gpu = a + b * mpx`. Two points or more. */
const fitLine = (points: readonly Point[]): { a: number; b: number; r2: number } => {
  const n = points.length
  const mx = points.reduce((s, p) => s + p.mpx, 0) / n
  const my = points.reduce((s, p) => s + p.gpu, 0) / n
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.mpx - mx) * (p.gpu - my)
    den += (p.mpx - mx) ** 2
  }
  const b = den === 0 ? 0 : num / den
  const a = my - b * mx
  let ss = 0
  let st = 0
  for (const p of points) {
    ss += (p.gpu - (a + b * p.mpx)) ** 2
    st += (p.gpu - my) ** 2
  }
  return { a, b, r2: st === 0 ? 1 : 1 - ss / st }
}

const fmt = (n: number, d = 2): string => n.toFixed(d)

test.use({
  viewport: {
    width: STEPS[STEPS.length - 1] as number,
    height: STEPS[STEPS.length - 1] as number,
  },
  deviceScaleFactor: DPR,
  // ── vsync OFF, and this is the whole reason the first run said nothing ──
  //
  // The first pass of this spec read 16.47 / 16.14 / 15.63 / 16.31 ms over a
  // SIXTEENFOLD range of pixels, and 16.3 ms is 1 / 61 Hz on a 60 Hz monitor.
  // `setAnimationLoop` is rAF, rAF is vsync-locked, and a GPU timer query
  // brackets the whole submission: when the loop is throttled the GPU's own
  // TIME_ELAPSED spans the idle inside the bracket as well as the work. So
  // every reading was the refresh rate wearing a GPU timer's clothes.
  //
  // Unthrottling the loop is a HARNESS setting — two Chrome flags, no change
  // to the build, nothing the game can see (CLAUDE.md's line is whether the
  // GAME behaves differently). It is also what every GPU measurement in this
  // repo should have had: `docs/testing/perf-protocol.md` §3 now says so.
  //
  // `--disable-frame-rate-limit` as well only when SCALE_UNCAP=1. Uncapping the
  // loop pegs the GPU, and a pegged GPU changes clocks — which fires
  // `GPU_DISJOINT_EXT`, which drops every query in flight. The first run with
  // both flags read 0.00 ms at the two largest sizes because the ring never
  // filled. Unlocking vsync alone is enough to take the ceiling off the timer.
  launchOptions: {
    args: [
      '--disable-gpu-vsync',
      ...(process.env.SCALE_UNCAP === '1' ? ['--disable-frame-rate-limit'] : []),
    ],
  },
})

test.describe('@measure @gpu perf scale: fill or draw calls, from the slope', () => {
  test.setTimeout(1_800_000)

  test(`${MISSION} ${EDITION} at ${SNAP_AT} s`, async ({ page }) => {
    await flyToFreeze(page, {
      mission: MISSION,
      edition: EDITION,
      snapAt: SNAP_AT,
      params: { adaptive: '0', quality: 'high', ...EXTRA },
    })
    // The composer is not in a worn frame (`bloom.render()` answers false in a
    // session), and at 2516² it would be the biggest fill term in the sweep.
    await setFlag(page, 'render.bloom', false)
    await page.waitForTimeout(SETTLE_MS)

    const lines: string[] = []
    /**
     * Sweep the sizes, re-applying `hidden` after every resize.
     *
     * Re-applied because a resize is the one event that can undo it: the first
     * run hid 256 chunks, resized, and read a frame that cost exactly what the
     * unhidden one did. Whether the resize restores them or the reading was
     * vsync all along, asserting the state after each resize is what turns a
     * flat line into evidence — so `stillHidden` is printed and gated.
     */
    const sweep = async (label: string, hidden: readonly string[] = []): Promise<Point[]> => {
      const points: Point[] = []
      for (const css of STEPS) {
        await page.setViewportSize({ width: css, height: css })
        await page.waitForTimeout(SETTLE_MS)
        for (const group of hidden) await setGroupVisible(page, group, false)
        const b = await buffer(page)
        const gpu = await gpuMs(page)
        const wall = await wallMs(page)
        if (gpu === null) continue
        points.push({
          mpx: (b.width * b.height) / 1e6,
          gpu,
          wall,
          width: b.width,
          calls: b.calls,
          ...(() => {
            const load = machineLoad()
            return { browsers: load.chrome, nodes: load.node, cpu: load.cpu }
          })(),
        })
      }
      const fit = fitLine(points)
      // A row whose R2 is low is NOT a row with a wide error bar — it is a row
      // that did not measure a line, and on this instrument that has one known
      // cause: a reading that came back at the REFRESH RATE rather than at the
      // GPU's own time. The first `unlit` sweep read 15.67 ms at 630 px against
      // a 16.70 ms wall and 2.79 at 1260 px, which fits nothing. Say so in the
      // table, beside the number, rather than leaving it to be noticed.
      const suspect = fit.r2 < 0.95 ? '   <<< NOT A FIT — do not read this row' : ''
      // One extra browser during ONE sweep is enough to void that sweep, so the
      // busiest reading in the row is the one worth printing, not the average.
      const busiest = points.reduce((m, p) => Math.max(m, p.browsers ?? 0), 0)
      const span = (pick: (p: Point) => number | null): string => {
        const seen = points.map(pick).filter((v): v is number => v !== null)
        if (seen.length === 0) return '?'
        const lo = Math.min(...seen)
        const hi = Math.max(...seen)
        return lo === hi ? `${lo}` : `${lo}-${hi}`
      }
      const load = `  [chrome ${span((p) => p.browsers)} · node ${span((p) => p.nodes)} · cpu ${span((p) => p.cpu)}%]`
      // `BUSY_BROWSERS` is the QUEUE RUNNER's bar, checked before Playwright is
      // launched. This sample is taken from inside the browser Playwright then
      // launched, so the sweeping browser counts itself: the bar here is one
      // higher, and the first version flagged every row of a clean run.
      const bar = BUSY_BROWSERS + 1
      const shared = busiest > bar ? `   <<< ${busiest} BROWSERS — shared GPU, §3a` : ''
      lines.push(
        `  ${label.padEnd(26)} ${points.map((p) => `${p.width}px ${fmt(p.gpu)}/${fmt(p.wall)}ms ${p.calls}c`).join('  ')}` +
          `\n    ${''.padEnd(26)} fixed ${fmt(fit.a)} ms + ${fmt(fit.b)} ms/Mpx  (R2 ${fmt(fit.r2, 3)}); at 6.33 Mpx = ${fmt(fit.a + fit.b * 6.33)} ms, ${fmt((100 * fit.a) / (fit.a + fit.b * 6.33), 0)} % fixed${load}${suspect}${shared}`,
      )
      return points
    }

    lines.push(
      `\nperf-scale — ${MISSION} ${EDITION}, frozen at ${SNAP_AT} s, DPR ${DPR}, vsync OFF` +
        (Object.keys(EXTRA).length > 0 ? `, ${new URLSearchParams(EXTRA).toString()}` : '') +
        '\n  per size: gpu / wall median ms, and draw calls. Then the line through the gpu points:',
    )
    // One throwaway reading at the smallest size before ANY row is taken.
    //
    // Four runs in, the first `everything on` sweep has twice come back at the
    // REFRESH RATE at 630 px and nowhere else — 15.74 and 16.27 ms against a
    // 16.70 ms wall, fitting a line at R² 0.32 — while every later row in the
    // same run fitted at 0.99. The page has just been loaded, frozen and
    // settled at the LARGEST viewport, and the sweep's first act is to shrink
    // it fourfold; whatever that costs, it was landing inside the first
    // reading. The arm loop already pays this three seconds and stopped having
    // the problem, so the first sweep gets it too.
    await page.setViewportSize({ width: STEPS[0] as number, height: STEPS[0] as number })
    await page.waitForTimeout(SETTLE_MS)
    await gpuMs(page)
    const all = await sweep('everything on')
    const results: Record<string, Point[]> = { all }
    // The control that says whether the timer is measuring anything at all: an
    // empty stage must cost near nothing at every size. If THIS reads 16 ms,
    // no other row on the page means what it says.
    results._empty = await sweep('EMPTY STAGE (control)', ['*'])
    await setGroupVisible(page, '*', true)
    for (const group of GROUPS) {
      results[group] = await sweep(`without ${group}`, [group])
      await setGroupVisible(page, group, true)
      await page.waitForTimeout(SETTLE_MS)
    }
    for (const flag of FLAGS) {
      await setFlag(page, flag, false)
      await page.waitForTimeout(SETTLE_MS)
      results[flag] = await sweep(`without ${flag}`)
      await setFlag(page, flag, true)
      await page.waitForTimeout(SETTLE_MS)
    }
    const knobLabels: string[] = []
    for (const knob of KNOBS) {
      const [dotted, raw] = knob.split('=') as [string, string]
      const previous = await setEditionNumber(page, dotted, Number(raw))
      await page.waitForTimeout(SETTLE_MS)
      const label = `${dotted} ${previous} -> ${raw}`
      knobLabels.push(label)
      results[label] = await sweep(label)
      if (previous !== null) await setEditionNumber(page, dotted, previous)
      await page.waitForTimeout(SETTLE_MS)
    }

    // ── `render/fragment-gates.ts` arms — the terrain's fragment stack ───
    //
    // Each arm is applied, PROVED, swept, and taken off again. The proof is not
    // optional and it is not a formality: an arm whose define never reached the
    // compiler renders identically to the baseline and reports its cut as free.
    const gateLabels: string[] = []
    const gateProof: { label: string; moved: number; keys: string[]; defines: string[] }[] = []
    for (const arm of GATE_ARMS) {
      const [spec, which] = arm.split('@') as [string, string?]
      const target = which ?? 'land'
      const gates = spec.split('+')
      // ── each arm gets its OWN baseline, read immediately before it ────────
      //
      // §3a-ter's option 2, and the data asked for it. Across four runs the
      // FIXED term has drifted by up to 2 ms between the first `everything on`
      // and the last — 1.84 -> 3.84 inside four minutes on one occasion — while
      // the fill slope held to 0.05. An arm compared against a baseline taken
      // eight sweeps earlier is therefore a comparison of two machine states as
      // much as of two shaders, which is the whole disease §3a-ter describes,
      // arriving inside one page session instead of across two.
      //
      // Adjacent baselines cost one sweep each and make every arm a local A–B
      // pair. The run-wide bracket stays as well: it is what says how far the
      // floor moved overall, and a reader who sees a big bracket and small
      // local gaps now knows the difference matters.
      const near = await sweep(`  baseline for ${spec}`)
      results[`near ${spec}`] = near
      // The DEFINE NAMES come back from the page rather than being spelled a
      // second time here — trap 24: a test that re-derives its expectation the
      // way the code does has not tested the code.
      const { moved, defines } = await setGates(page, gates, target)
      await page.waitForTimeout(SETTLE_MS)
      // One throwaway reading before the sweep starts. Flipping a define makes
      // three fetch a new program, and the first window after that is the one
      // paying for the compile, the pipeline flush and whatever clock step the
      // change in load provokes. Three seconds against a row that cannot be
      // read is a trade worth taking every time.
      await page.setViewportSize({ width: STEPS[0] as number, height: STEPS[0] as number })
      await page.waitForTimeout(SETTLE_MS)
      await gpuMs(page)
      const keys = await liveCacheKeys(page)
      const label = `gate ${spec}${target === 'land' ? '' : `@${target}`}`
      gateLabels.push(label)
      gateProof.push({ label, moved, keys, defines })
      results[label] = await sweep(label)
      await setGates(page, [], target)
      await page.waitForTimeout(SETTLE_MS)
    }
    if (gateProof.length > 0) {
      lines.push('', '  gate arms — the mechanism, before any millisecond is believed:')
      for (const p of gateProof) {
        const seen = p.defines.filter((d) => p.keys.some((k) => k.includes(d)))
        lines.push(
          `    ${p.label.padEnd(26)} ${p.moved} material(s) moved; ` +
            `${seen.length}/${p.defines.length} define(s) in a live program key`,
        )
      }
    }

    // ── DEV-193's chunk fold, with its own adjacent baseline ─────────────
    if (BATCH_ARM) {
      const near = await sweep('  baseline for chunkBatch')
      results['near chunkBatch'] = near
      await setChunkBatch(page, true)
      await page.waitForTimeout(SETTLE_MS)
      // The same throwaway reading every other arm change gets: folding builds
      // six new programs, and the first window after that pays for them.
      await page.setViewportSize({ width: STEPS[0] as number, height: STEPS[0] as number })
      await page.waitForTimeout(SETTLE_MS)
      await gpuMs(page)
      results['gate chunkBatch'] = await sweep('gate chunkBatch')
      gateLabels.push('gate chunkBatch')
      await setChunkBatch(page, false)
      await page.waitForTimeout(SETTLE_MS)
      const folded = results['gate chunkBatch'] as Point[]
      const before = near[near.length - 1] as Point
      const after = folded[folded.length - 1] as Point
      lines.push(
        '',
        `  chunk fold: draw calls ${before.calls} -> ${after.calls} at ${after.width}px` +
          ' — the arm proving itself, in a count rather than a millisecond',
      )
    }

    // ── the bracket, and it is not optional ──────────────────────────────
    //
    // The same configuration, read again, LAST. Everything above is a
    // difference against `all`, and a difference is only evidence if the
    // machine under it did not move — which on this laptop it does: 25 minutes
    // of back-to-back rendering took the GPU from a 3090 MHz boost to 1567 at
    // 64 °C, and a queue that did not check came out ordered by WHEN its rows
    // ran (perf-protocol §3a). One row at the end says how far the floor
    // drifted while the arms were being taken, in the units the arms are in.
    const again = await sweep('everything on (AGAIN — the bracket)')
    results._again = again

    // ── what each group costs, split ────────────────────────────────────
    const fitAll = fitLine(all)
    lines.push(
      '',
      '  each group, by difference (all minus without):',
      `    ${'group'.padEnd(26)} ${'fixed ms'.padStart(9)} ${'ms/Mpx'.padStart(8)}  at 6.33 Mpx`,
    )
    for (const group of [...GROUPS, ...FLAGS, ...knobLabels, ...gateLabels]) {
      const without = fitLine(results[group] as Point[])
      // A gate arm is differenced against the baseline taken IMMEDIATELY before
      // it, not against the run's first row. See the arm loop for why: the
      // fixed term has drifted 2 ms inside a four-minute run, so a difference
      // across eight sweeps carries the machine as well as the shader.
      const spec = group.startsWith('gate ') ? (group.slice(5).split('@')[0] as string) : null
      const local = spec ? (results[`near ${spec}`] as Point[] | undefined) : undefined
      const base = local ? fitLine(local) : fitAll
      const a = base.a - without.a
      const b = base.b - without.b
      lines.push(
        `    ${group.padEnd(26)} ${fmt(a).padStart(9)} ${fmt(b).padStart(8)}  ${fmt(a + b * 6.33)} ms` +
          (local ? '  (vs its OWN adjacent baseline)' : ''),
      )
    }

    // The bracket, spelled out in the units every row above is in.
    const fitAgain = fitLine(again)
    const first = fitLine(all)
    lines.push(
      '',
      `  BRACKET: 'everything on' read first ${fmt(first.a + first.b * 6.33)} ms, read last ` +
        `${fmt(fitAgain.a + fitAgain.b * 6.33)} ms at 6.33 Mpx ` +
        `(fixed ${fmt(first.a)} -> ${fmt(fitAgain.a)}, fill ${fmt(first.b)} -> ${fmt(fitAgain.b)} ms/Mpx).`,
      '  Any arm smaller than that gap is not a result.',
    )

    await setFlag(page, 'render.bloom', true)
    console.info(`${lines.join('\n')}\n`)
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(OUT_DIR, `${MISSION}-${EDITION}-scale.json`),
      JSON.stringify(
        { mission: MISSION, edition: EDITION, snapAt: SNAP_AT, steps: STEPS, results },
        null,
        1,
      ),
    )
    fs.writeFileSync(path.join(OUT_DIR, `${MISSION}-${EDITION}-scale.txt`), lines.join('\n'))

    // Gates on the MECHANISM, never on a millisecond (VR-PERF §0).
    //
    // The sizes really changed, and — the one that matters — **an empty stage
    // is far cheaper than a full one at the same size**. That is the control
    // the first run of this spec did not have: when every reading came back at
    // 16.3 ms there was nothing on the page able to say whether the frame was
    // flat or the clock was. Half the full frame is a deliberately loose bar;
    // it fails only when the timer has stopped measuring the scene.
    expect(all.length).toBe(STEPS.length)
    expect(new Set(all.map((p) => p.width)).size).toBe(STEPS.length)
    const biggest = (points: readonly Point[]): number =>
      points.reduce((best, p) => (p.mpx > best.mpx ? p : best), points[0] as Point).gpu
    expect(biggest(results._empty as Point[])).toBeLessThan(biggest(all) * 0.5)
    // And every gate arm really reached the compiler. A define that does not is
    // a row reading "this cut is free", which looks exactly like a finding.
    for (const p of gateProof) {
      expect(p.moved, `${p.label}: no terrain material moved`).toBeGreaterThan(0)
      for (const define of p.defines) {
        expect(
          p.keys.some((k) => k.includes(define)),
          `${p.label}: no live program's cache key contains ${define} — the define never reached ` +
            'three, so this arm measured the baseline twice',
        ).toBe(true)
      }
    }
  })
})
