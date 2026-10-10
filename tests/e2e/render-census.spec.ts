/**
 * tests/e2e/render-census.spec.ts — what one cockpit frame costs, and whose it is.
 *
 * DEV-118. Matt: *"investigate how we can improve performance (assuming
 * overdraw and draw calls aren't great)"*. A CAPTURE TOOL in the mould of
 * `bloom-perf.spec.ts`: it prints, it does not gate. For each mission and
 * preset it flies to a `?snap=` mark under the autopilot, lets the recorder's
 * 3 s window fill on the frozen frame, and prints
 *
 *   - `renderer.info` for the frame: calls, triangles, programs, memory;
 *   - the census (`boot/render-census.ts`): calls and triangles BY GROUP, from
 *     three's own render list, and the MEASURED overdraw — mean paints per
 *     pixel for the frame, and for its opaque draws alone;
 *   - on Anniversary, each switchable system turned OFF on that same frozen
 *     frame, one at a time, with the frame-time and draw-call delta it gives
 *     back. One frame, one flag, an exact delta — the lesson `bloom-perf` paid
 *     for: a delta between two flights measures the flights.
 *
 *   CENSUS_DIR=<dir> CENSUS_AT=20 CENSUS_MISSIONS=int_01_hoverJet,rookie_01_hoverJet \
 *     E2E_PORT=<yours> pnpm exec playwright test tests/e2e/render-census.spec.ts --workers 1
 *
 * `@gpu`, hydrated assets, a real compiler.
 *
 * ── ON → OFF → ON, and the bug that put it there (DEV-160) ───────────────
 *
 * This file used to take ONE "all on" GPU reading at the top of the test and
 * subtract each flag's "off" reading from it, thirty seconds to six minutes
 * later. Run on 2026-09-16 at `9aea977`, **all thirteen flags came out
 * negative** — −0.31 to −2.08 ms, i.e. every system in the game apparently
 * gave back negative time when switched off. They did not. `baseGpu` read
 * 14.54 ms and every `offGpu` landed near 16.5, which is one offset wearing
 * thirteen hats: something between the baseline read and the first flag —
 * `scriptMsPerFrame`'s CDP `Performance` domain and `cpuProfile`'s sampling
 * profiler both attach in that gap — raised the frame's cost and left it
 * raised.
 *
 * The irony is exact. The header three paragraphs up already said **a delta
 * between two flights measures the flights**, and this was the same mistake
 * one scale down: *a delta between two MOMENTS measures the moment.* Freezing
 * the sim stops the game moving; it does not stop the browser, the driver or
 * the profiler moving.
 *
 * So each flag is now its own controlled experiment:
 *
 *     on  → reset the GPU ring, read 3 s   (onBefore)
 *     off → settle, read stats, reset, read 3 s   (off)
 *     on  → settle, reset, read 3 s   (onAfter)
 *
 * and the reported cost is **`mean(onBefore, onAfter) − off`**, which is
 * positive when a system costs something — the same sign the column header
 * ("what it gives back") and the old `baseGpu − offGpu` both had. Both
 * on-readings are printed beside it, so a row where the two disagree by more
 * than its own delta is a row saying "the machine drifted under me, do not
 * believe this number". That is the thing the single baseline could not say.
 *
 * The CDP profile and the script-time measurement now run AFTER the flag loop
 * for the same reason: whatever they do to the frame, they do it to nothing
 * that is still being measured.
 */
import fs from 'node:fs'
import path from 'node:path'
import { flyToFreeze } from './fixtures/freeze'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const MISSIONS = (process.env.CENSUS_MISSIONS ?? 'int_01_hoverJet,rookie_01_hoverJet').split(',')
const EDITIONS = (process.env.CENSUS_EDITIONS ?? 'anniversary,classic').split(',')
const SNAP_AT = Number(process.env.CENSUS_AT ?? '20')
const OUT_DIR = process.env.CENSUS_DIR ?? 'test-results/census'

/**
 * Milliseconds to let the frame settle after a flag flips, before the GPU ring
 * is reset for the next reading.
 *
 * ONE constant, used in both directions. It used to be 4,500 ms after the OFF
 * flip and 1,500 ms after the ON flip, which quietly made the two states
 * incomparable: flipping the bloom back on drops and rebuilds the composer,
 * and 1.5 s is not enough for that to stop showing up in the ring.
 */
const SETTLE_MS = 4_500

interface Stats {
  p50: number
  p95: number
  max: number
  frames: number
  calls: number
  triangles: number
  programs: number
  geometries: number
  textures: number
}

interface Row {
  group: string
  calls: number
  triangles: number
  transparentCalls: number
}

interface CensusOut {
  calls: number
  triangles: number
  rows: Row[]
  overdraw: {
    issued: number
    issuedOpaque: number
    shaded: number
    shadedOpaque: number
    max: number
  }
}

/** Dotted paths of the Anniversary systems that can be flipped on a live frame. */
const FLAGS = [
  'render.shadows',
  'render.sunHeight',
  'render.haze',
  'render.coast',
  'render.clouds',
  'render.bloom',
  'render.illustrative',
  'fx.speedLines',
  'fx.motes',
  'terrain.detailRing',
  'props.birds',
  'cockpit.lighting',
  'cockpit.body',
] as const

const stats = (page: Page): Promise<Stats> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        perf: { stats: () => { p50Ms: number; p95Ms: number; maxMs: number; frames: number } }
        render: {
          renderer: {
            info: {
              render: { calls: number; triangles: number }
              programs: unknown[]
              memory: { geometries: number; textures: number }
            }
          }
        }
      }
    }
    const s = w.__ff2.perf.stats()
    const info = w.__ff2.render.renderer.info
    return {
      p50: s.p50Ms,
      p95: s.p95Ms,
      max: s.maxMs,
      frames: s.frames,
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs.length,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    }
  })

/**
 * The frame's GPU time from the loop's own timer (`boot/gpu-timer.ts`): the
 * ring is reset, three seconds of frozen frames are recorded, and the median
 * is read. A draw issued from here between frames would compete with the loop
 * for the GPU and measure the contention — that was tried, and it ranked bloom
 * as costing six milliseconds of a pass it is not in.
 */
const gpuMs = async (page: Page): Promise<number | null> => {
  const supported = await page.evaluate(() => {
    const g = (
      globalThis as unknown as {
        __ff2: { gpu: { supported: boolean; enable: () => void; reset: () => void } }
      }
    ).__ff2.gpu
    g.enable()
    g.reset()
    return g.supported
  })
  if (!supported) return null
  await page.waitForTimeout(3_000)
  return page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2: { gpu: { stats: () => { medianMs: number } } } }
      ).__ff2.gpu.stats().medianMs,
  )
}

/** Main-thread JS milliseconds per frame over ~3 s, from CDP's Performance domain. */
const scriptMsPerFrame = async (page: Page): Promise<number> => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const read = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics')
    const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0
    return { script: get('ScriptDuration'), task: get('TaskDuration') }
  }
  const frames0 = await page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2: { perf: { stats: () => { frames: number } } } }
      ).__ff2.perf.stats().frames,
  )
  const a = await read()
  await page.waitForTimeout(3_000)
  const b = await read()
  const frames1 = await page.evaluate(() =>
    (
      globalThis as unknown as {
        __ff2: { perf: { stats: () => { frames: number; seconds: number; fps: number } } }
      }
    ).__ff2.perf.stats(),
  )
  await cdp.detach()
  // The recorder's window is 3 s, so its frame count over 3 s IS the frames elapsed.
  const frames = Math.max(1, frames1.frames || frames0)
  return ((b.script - a.script) * 1000) / frames
}

/**
 * Where the main thread's milliseconds go: a 3 s sampling profile of the
 * frozen frame, folded by function SELF time. `scriptMsPerFrame` says how
 * much JS a frame costs; this says whose it is, which is the question a Quest
 * CPU — several times slower than this desktop — will ask first.
 */
const cpuProfile = async (page: Page, top = 12): Promise<string[]> => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
  await cdp.send('Profiler.start')
  await page.waitForTimeout(3_000)
  const { profile } = await cdp.send('Profiler.stop')
  await cdp.detach()
  const self = new Map<string, number>()
  const byId = new Map<number, (typeof profile.nodes)[number]>()
  for (const n of profile.nodes) byId.set(n.id, n)
  const deltas = profile.timeDeltas ?? []
  const samples = profile.samples ?? []
  let total = 0
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i] as number)
    const dt = (deltas[i] ?? 0) / 1000
    total += dt
    if (!n) continue
    const f = n.callFrame
    const url = f.url ? f.url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '') : ''
    const key = `${f.functionName || '(anonymous)'} ${url}${url ? `:${f.lineNumber + 1}` : ''}`
    self.set(key, (self.get(key) ?? 0) + dt)
  }
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, ms]) => `${((100 * ms) / Math.max(1, total)).toFixed(1).padStart(5)}%  ${k}`)
}

const census = (page: Page): Promise<CensusOut> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2: { census: () => CensusOut } }
    const c = w.__ff2.census()
    return { calls: c.calls, triangles: c.triangles, rows: c.rows, overdraw: c.overdraw }
  })

/** Flip one dotted flag on the live preset through the Edition page's own path. */
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

const fmt = (n: number, d = 1): string => n.toFixed(d)
const k = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(0)}k`

test.describe('@measure @gpu render census: DEV-118', () => {
  test.setTimeout(900_000)

  for (const mission of MISSIONS) {
    for (const edition of EDITIONS) {
      test(`${mission} ${edition} at ${SNAP_AT} s`, async ({ page }) => {
        await flyToFreeze(page, { mission, edition, snapAt: SNAP_AT })
        const base = await stats(page)
        const c = await census(page)
        const baseGpu = await gpuMs(page)
        expect(base.frames).toBeGreaterThan(5)
        expect(c.calls).toBeGreaterThan(0)

        const lines: string[] = []
        lines.push(
          `\nDEV-118 census — ${mission} ${edition}, frozen at ${SNAP_AT} s` +
            `\n  frame: p50 ${fmt(base.p50, 2)} ms  p95 ${fmt(base.p95, 2)} ms  max ${fmt(base.max, 2)} ms over ${base.frames} frames` +
            `\n  gpu  : ${baseGpu === null ? 'n/a (no timer query)' : `${fmt(baseGpu, 2)} ms`} median per frame (the whole frame: shadow pass, world, bloom, UI)` +
            `\n  info : ${base.calls} calls  ${k(base.triangles)} tris  ${base.programs} programs  ${base.geometries} geometries  ${base.textures} textures` +
            `\n  list : ${c.calls} calls  ${k(c.triangles)} tris in the world pass (info also counts the shadow pass and post passes)` +
            `\n  overdraw: issued ${fmt(c.overdraw.issued, 2)}x (opaque ${fmt(c.overdraw.issuedOpaque, 2)}x), shaded after depth ${fmt(c.overdraw.shaded, 2)}x (opaque ${fmt(c.overdraw.shadedOpaque, 2)}x), max ${c.overdraw.max}`,
        )
        lines.push('  by group (calls / tris / transparent calls):')
        for (const r of c.rows) {
          lines.push(
            `    ${r.group.padEnd(28)} ${String(r.calls).padStart(4)}  ${k(r.triangles).padStart(8)}  ${r.transparentCalls}`,
          )
        }

        // ── each system OFF, on → off → on ─────────────────────────────
        //
        // See the file header for why this is three readings and not two. The
        // flag loop runs BEFORE the CDP measurements below, so nothing a
        // profiler does to the frame lands inside a measured window.
        const deltas: Record<
          string,
          {
            gpu: number | null
            gpuOnBefore: number | null
            gpuOnAfter: number | null
            gpuDrift: number | null
            p95: number
            calls: number
            triangles: number
          }
        > = {}
        if (edition === 'anniversary') {
          lines.push(
            '  each system OFF on this frozen frame (what it gives back, against the two ON readings either side):',
            `    ${'flag'.padEnd(22)} ${'cost'.padStart(9)}   ${'on'.padStart(6)} ${'off'.padStart(6)} ${'on'.padStart(6)}  ${'drift'.padStart(6)}   wall p95   calls      tris`,
          )
          for (const flag of FLAGS) {
            // ON, immediately before — not a reading taken minutes ago.
            const onBefore = await gpuMs(page)
            const statsOnBefore = await stats(page)

            await setFlag(page, flag, false)
            await page.waitForTimeout(SETTLE_MS)
            const off = await stats(page)
            const offGpu = await gpuMs(page)

            await setFlag(page, flag, true)
            await page.waitForTimeout(SETTLE_MS)
            const onAfter = await gpuMs(page)

            const onMean = onBefore !== null && onAfter !== null ? (onBefore + onAfter) / 2 : null
            // POSITIVE means the system costs that much: the same sign the
            // column header has always had.
            const gpu = onMean !== null && offGpu !== null ? onMean - offGpu : null
            // How far the two ON readings moved under us. A drift larger than
            // the delta is the row telling you not to believe it.
            const gpuDrift =
              onBefore !== null && onAfter !== null ? Math.abs(onAfter - onBefore) : null
            deltas[flag] = {
              gpu,
              gpuOnBefore: onBefore,
              gpuOnAfter: onAfter,
              gpuDrift,
              // Wall time and the counts come off the ON reading immediately
              // before, for the same reason the GPU number does.
              p95: statsOnBefore.p95 - off.p95,
              calls: statsOnBefore.calls - off.calls,
              triangles: statsOnBefore.triangles - off.triangles,
            }
            const suspect =
              gpu !== null && gpuDrift !== null && gpuDrift > Math.abs(gpu)
                ? ' <- drift > delta'
                : ''
            lines.push(
              `    ${flag.padEnd(22)} ${gpu === null ? '      n/a' : `${fmt(gpu, 2).padStart(6)} ms`}   ` +
                `${onBefore === null ? '   n/a' : fmt(onBefore, 2).padStart(6)} ${offGpu === null ? '   n/a' : fmt(offGpu, 2).padStart(6)} ${onAfter === null ? '   n/a' : fmt(onAfter, 2).padStart(6)}  ` +
                `${gpuDrift === null ? '   n/a' : fmt(gpuDrift, 2).padStart(6)}   ` +
                `${fmt(statsOnBefore.p95 - off.p95, 2).padStart(6)} ms  ${String(statsOnBefore.calls - off.calls).padStart(4)}  ${k(statsOnBefore.triangles - off.triangles).padStart(8)}${suspect}`,
            )
          }
        }

        // LAST, both of them: attaching CDP's Performance domain and its
        // sampling profiler changes what a frame costs, and the whole reason
        // this file was rewritten is that those changes leaked into the flag
        // deltas above.
        const script = await scriptMsPerFrame(page)
        const profile = await cpuProfile(page)
        lines.push(
          `  main-thread JS ${fmt(script, 2)} ms/frame`,
          '  main-thread self time, 3 s sampled on the frozen frame:',
        )
        for (const l of profile) lines.push(`    ${l}`)

        console.info(`${lines.join('\n')}\n`)
        fs.mkdirSync(OUT_DIR, { recursive: true })
        fs.writeFileSync(
          path.join(OUT_DIR, `${mission}-${edition}-${SNAP_AT}s.json`),
          JSON.stringify(
            {
              mission,
              edition,
              snapAt: SNAP_AT,
              base,
              gpuMs: baseGpu,
              scriptMsPerFrame: script,
              census: c,
              deltas,
            },
            null,
            1,
          ),
        )
      })
    }
  }
})
