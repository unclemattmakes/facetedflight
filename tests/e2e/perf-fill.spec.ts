/**
 * tests/e2e/perf-fill.spec.ts — the flat A/B, at the headset's pixel count.
 *
 * VR-PERF-WAVE-2 F8: *"the flat A/B cannot rank the GPU items on a 60 Hz
 * monitor ... one flag clears the noise: shadows at 1.32 ms; the other twelve
 * sit inside a 0.03-0.58 ms drift. The ranking has to be read in the
 * headset."*
 *
 * That finding is true of the frame it was taken on and not of the monitor.
 * `render-census.spec.ts` renders at the Playwright viewport — **1280 x 720,
 * 0.92 megapixels**. Lap 4 was worn at **2516 x 2516 per eye, 6.33
 * megapixels**, two of them. So every per-fragment cost in the game — the
 * water shader, the height fog every material carries, the PCF shadow lookup,
 * every square metre of overdraw — was being ranked at **one seventh of one
 * worn eye**, which is how twelve systems came to sit inside the drift. The
 * monitor was not the problem. The pixel count was.
 *
 * So this spec renders the same frozen frame on the same monitor with the
 * drawing buffer set to **one eye of the worn lap**: a 1258 x 1258 viewport at
 * `deviceScaleFactor` 2, which `quality: high` (pixelRatioCap 2) turns into a
 * 2516 x 2516 backing store. No new code in `src/` and no switch — this is the
 * ordinary resize path, the one a visitor on a 5K display takes.
 *
 * ── What it models, and what it does not ─────────────────────────────────
 *
 * MODELLED: per-fragment cost at the worn resolution — shading, overdraw,
 * bandwidth, the MSAA sample count, the shadow lookup, the resolve. That is
 * where a GPU-bound frame's milliseconds are, and lap 4 says we are GPU-bound
 * (11.7 ms p50 against an 11.1 ms frame).
 *
 * NOT MODELLED, and no flat rig can: the second eye's draw submission, the
 * compositor, the video encoder, and the runtime's own resolve of the
 * projection layer. A number here is **one eye's fragment work**. Doubling it
 * is not the worn frame either — the shadow pass is drawn once for both eyes
 * while the world pass is drawn twice. The rule of thumb this spec earns:
 * **a system that costs nothing here costs nothing worn, and the ORDER is the
 * same.** The magnitudes still want a head.
 *
 * ── Bloom is forced OFF, and that is parity, not tidiness ────────────────
 *
 * `bloom.render()` answers false in a session (`boot/app.ts`: `if
 * (!bloom.render(stage, camera)) renderer.render(...)`), so the worn frame has
 * no composer in it at all. Leaving the flat composer on would put a 2516 x
 * 2516 post chain — which is not in the worn frame — at the top of the ranking
 * and push everything that IS in the worn frame down by its share of the
 * bandwidth. It is measured once, on its own, and then switched off for the
 * ranking.
 *
 * ── Groups, not flags ────────────────────────────────────────────────────
 *
 * `render-census.spec.ts` ranks the thirteen switchable Anniversary systems.
 * Most of the frame is not one of them: the terrain chunks, the ocean, the
 * sky, the cockpit and the props have no flag, and between them they are the
 * frame. So this spec ranks the census's own rows — every top-level group
 * three actually drew — by hiding one at a time. `visible = false` costs a
 * group its draws AND its shadow casting, which is the honest "what does this
 * cost me, all in" question.
 *
 * Hiding is a measurement, not a build: nothing is left hidden, and the ON
 * reading is re-taken after every OFF (`render-census.spec.ts`'s header says
 * why a single baseline lies).
 *
 *   FILL_MISSIONS=int_01_hoverJet FILL_AT=20 FILL_DIR=perf-out/fill \
 *     E2E_PORT=<yours> pnpm exec playwright test tests/e2e/perf-fill.spec.ts --workers 1
 *
 * `@gpu`, hydrated assets, a real compiler, one worker.
 */
import fs from 'node:fs'
import path from 'node:path'
import { flyToFreeze } from './fixtures/freeze'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

/**
 * One eye of the worn lap: 2516 x 2516 (`docs/perf-baseline.md`, lap 4,
 * `nativeScale` 1 on a 2160 panel). Split as viewport x deviceScaleFactor
 * because `quality: high` caps the pixel ratio at 2 and a viewport is what
 * Playwright can set.
 */
const EYE_PX = Number(process.env.FILL_EYE ?? '2516')
const DPR = Number(process.env.FILL_DPR ?? '2')
const VIEWPORT = Math.round(EYE_PX / DPR)

const MISSIONS = (process.env.FILL_MISSIONS ?? 'int_01_hoverJet').split(',')
const EDITION = process.env.FILL_EDITION ?? 'anniversary'
const SNAP_AT = Number(process.env.FILL_AT ?? '20')
const OUT_DIR = process.env.FILL_DIR ?? 'perf-out/fill'
/** Milliseconds of frozen frames per GPU reading. Three seconds is `render-census.spec.ts`'s. */
const READ_MS = Number(process.env.FILL_READ_MS ?? '3000')
/** Let the frame settle after a visibility flip before the ring is reset. */
const SETTLE_MS = 1_500

interface Row {
  group: string
  calls: number
  triangles: number
  transparentCalls: number
}

/**
 * The GPU median, with the two failure modes this rig has, handled.
 *
 * **The ceiling.** rAF is vsync-locked and a `TIME_ELAPSED` query brackets the
 * whole submission, so on a throttled loop the GPU's own elapsed time spans the
 * idle inside the bracket. The first run of this spec read 16.1–16.4 ms for
 * every system on a 60 Hz monitor — 1/61 Hz wearing a GPU timer's clothes — and
 * every row whose OFF reading stayed near it said "not measured", not "free".
 * `test.use({ launchOptions })` below takes the ceiling off.
 *
 * **The empty ring.** `boot/gpu-timer.ts` drops every query in flight on a
 * `GPU_DISJOINT_EXT`, which is correct and, on a busy GPU, frequent. A window
 * that comes back with no samples must read `n/a`, never `0.00`.
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
    if (read.frames >= 30) return read.medianMs
  }
  return null
}

interface Info {
  calls: number
  triangles: number
  programs: number
  width: number
  height: number
  samples: number
}

const info = (page: Page): Promise<Info> =>
  page.evaluate(() => {
    const r = (
      globalThis as unknown as {
        __ff2: {
          render: {
            renderer: {
              info: { render: { calls: number; triangles: number }; programs: unknown[] }
              getContext: () => WebGL2RenderingContext
            }
          }
        }
      }
    ).__ff2.render.renderer
    // The GL context's own drawing buffer, not `getDrawingBufferSize` — that
    // one writes into a `Vector2` and a plain object has no `.set`.
    const gl = r.getContext()
    return {
      calls: r.info.render.calls,
      triangles: r.info.render.triangles,
      programs: r.info.programs.length,
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
      samples: gl.getParameter(gl.SAMPLES) as number,
    }
  })

const census = (page: Page): Promise<{ calls: number; triangles: number; rows: Row[] }> =>
  page.evaluate(() => {
    const c = (
      globalThis as unknown as {
        __ff2: { census: () => { calls: number; triangles: number; rows: Row[] } }
      }
    ).__ff2.census()
    return { calls: c.calls, triangles: c.triangles, rows: c.rows }
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

/**
 * Show or hide a census row's group on the live stage.
 *
 * The row key is `rowKey()`'s (`boot/render-census.ts`): a top-level scene
 * child's name, or `world-terrain/<second level>` for the land, whose props
 * and chunks hang under one group and are separate answers. Returns how many
 * objects it moved, so a row that matched nothing is visible as a zero rather
 * than as a suspiciously cheap system.
 */
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

/**
 * The switchable Anniversary systems, as `render-census.spec.ts`'s `FLAGS`.
 *
 * Ranked here as well as by group because the two questions differ: a group is
 * "what do these draws cost", a flag is "what does this SYSTEM cost", and some
 * systems are not a group at all. `cockpit.lighting` is the sharp case — it is
 * two `PointLight`s inside the mission scene, so its cost is not its own draws
 * but two extra `RE_Direct_Physical` evaluations on every lit fragment in the
 * frame. Nothing that hides a group can see that.
 *
 * `render.bloom` is absent: it is measured on its own above and then held off,
 * because a session never draws it.
 */
const FLAGS = [
  'cockpit.lighting',
  'render.shadows',
  'render.illustrative',
  'render.haze',
  'terrain.detailRing',
  'render.clouds',
  'render.coast',
  'fx.motes',
  'fx.speedLines',
  'render.sunHeight',
  'cockpit.body',
  'props.birds',
] as const

const fmt = (n: number, d = 2): string => n.toFixed(d)
const k = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(0)}k`

// ── vsync OFF, and it is the difference between a ranking and a ceiling ────
//
// Top-level because Playwright refuses `launchOptions` inside a `describe`.
// `--disable-gpu-vsync` alone: uncapping the loop as well pegs the GPU, and a
// pegged GPU changes clocks, which fires `GPU_DISJOINT_EXT`, which empties the
// timer's ring. See `gpuMs` above and `tests/e2e/perf-scale.spec.ts`.
test.use({
  viewport: { width: VIEWPORT, height: VIEWPORT },
  deviceScaleFactor: DPR,
  launchOptions: { args: ['--disable-gpu-vsync'] },
})

test.describe('@measure @gpu perf fill: one eye of the worn frame, flat', () => {
  test.setTimeout(1_800_000)

  for (const mission of MISSIONS) {
    test(`${mission} ${EDITION} at ${SNAP_AT} s, ${EYE_PX}px square`, async ({ page }) => {
      await flyToFreeze(page, {
        mission,
        edition: EDITION,
        snapAt: SNAP_AT,
        // The adaptive controller multiplies the flat pixel ratio, so a hitch
        // during the load would quietly re-take the whole ranking at 0.6 of
        // the pixels the header claims — DEV-178's bug, one display along.
        params: { adaptive: '0', quality: 'high' },
      })

      // ── a resize before the first reading, on a HYPOTHESIS ────────────
      //
      // The fact, measured on a quiet machine: on the SAME build, at the SAME
      // 2516 px, with the same `--disable-gpu-vsync`, this spec read 16.34 ms
      // while `perf-scale.spec.ts` read 6.38. Both were internally consistent
      // — this one's A/B drift column was 0.01-0.17 ms and the sweep fitted at
      // R2 0.999 — so it is not noise, it is two instruments disagreeing about
      // one frame.
      //
      // Which is right is not a matter of opinion: the sweep's numbers
      // reproduce worn lap 4 to within 2 % (`VR-PERF-WAVE-2-WORK.md` §4) and
      // this one's would imply a worn frame of ~35 ms against a measured 11.7.
      //
      // The only structural difference is that the sweep RESIZES the drawing
      // buffer before every reading, so this bounces once before the first.
      // **That is a hypothesis and it is not yet confirmed**: the two runs that
      // would have confirmed it were taken while six agents shared this GPU and
      // are void (see the header of `docs/testing/perf-protocol.md` §3b on a
      // quiet machine). The bounce is harmless either way and stays until the
      // re-measure; if it turns out not to be the cause, this comment is the
      // record of what was actually known.
      await page.setViewportSize({ width: Math.round(VIEWPORT / 2), height: VIEWPORT })
      await page.waitForTimeout(SETTLE_MS)
      await page.setViewportSize({ width: VIEWPORT, height: VIEWPORT })
      await page.waitForTimeout(SETTLE_MS)

      const lines: string[] = []
      const opening = await info(page)
      // The reading is worthless if the buffer is not the size the header
      // claims: fail loudly rather than print a 1280 x 720 ranking under a
      // 2516-square title. And the bounce has to have landed us back here.
      expect(opening.width).toBe(EYE_PX)
      expect(opening.height).toBe(EYE_PX)

      // Bloom first, on its own, then off for everything below — it is not in
      // the worn frame (see the header).
      const bloomOn = await gpuMs(page)
      await setFlag(page, 'render.bloom', false)
      await page.waitForTimeout(SETTLE_MS)
      const bloomOff = await gpuMs(page)

      const base = await info(page)
      const c = await census(page)
      const post = bloomOn !== null && bloomOff !== null ? `${fmt(bloomOn - bloomOff)} ms` : 'n/a'
      lines.push(
        `\nperf-fill — ${mission} ${EDITION}, frozen at ${SNAP_AT} s` +
          `\n  buffer: ${base.width} x ${base.height} = ${((base.width * base.height) / 1e6).toFixed(2)} Mpx, ${base.samples}x MSAA` +
          `\n          (worn lap 4: 2516 x 2516 per eye, 6.33 Mpx, 4x — docs/perf-baseline.md)` +
          `\n  gpu   : ${bloomOff === null ? 'n/a' : `${fmt(bloomOff)} ms`} median per frame, composer OFF — the worn path` +
          `\n          ${bloomOn === null ? 'n/a' : `${fmt(bloomOn)} ms`} with the flat composer on: ${post} of post a session never draws` +
          `\n  info  : ${base.calls} calls  ${k(base.triangles)} tris  ${base.programs} programs` +
          `\n  list  : ${c.calls} calls  ${k(c.triangles)} tris in the world pass`,
      )
      lines.push(
        '  each GROUP hidden on this frozen frame — its draws and its shadow casting:',
        `    ${'group'.padEnd(26)} ${'cost'.padStart(8)}  ${'on'.padStart(6)} ${'off'.padStart(6)} ${'on'.padStart(6)} ${'drift'.padStart(6)}  ${'calls'.padStart(5)} ${'tris'.padStart(8)}  n`,
      )

      const results: Record<string, unknown> = {}
      for (const row of c.rows) {
        const onBefore = await gpuMs(page)
        const infoOn = await info(page)
        const moved = await setGroupVisible(page, row.group, false)
        await page.waitForTimeout(SETTLE_MS)
        const off = await gpuMs(page)
        const infoOff = await info(page)
        await setGroupVisible(page, row.group, true)
        await page.waitForTimeout(SETTLE_MS)
        const onAfter = await gpuMs(page)

        const onMean = onBefore !== null && onAfter !== null ? (onBefore + onAfter) / 2 : null
        const cost = onMean !== null && off !== null ? onMean - off : null
        const drift = onBefore !== null && onAfter !== null ? Math.abs(onAfter - onBefore) : null
        results[row.group] = {
          cost,
          onBefore,
          off,
          onAfter,
          drift,
          moved,
          calls: infoOn.calls - infoOff.calls,
          triangles: infoOn.triangles - infoOff.triangles,
          censusCalls: row.calls,
          censusTriangles: row.triangles,
        }
        const suspect = cost !== null && drift !== null && drift > Math.abs(cost) ? ' <- drift' : ''
        lines.push(
          `    ${row.group.padEnd(26)} ${cost === null ? '     n/a' : `${fmt(cost).padStart(5)} ms`}  ` +
            `${fmt(onBefore ?? 0).padStart(6)} ${fmt(off ?? 0).padStart(6)} ${fmt(onAfter ?? 0).padStart(6)} ${fmt(drift ?? 0).padStart(6)}  ` +
            `${String(infoOn.calls - infoOff.calls).padStart(5)} ${k(infoOn.triangles - infoOff.triangles).padStart(8)}  ${moved}${suspect}`,
        )
      }

      // ── the switchable systems, same protocol ─────────────────────────
      lines.push(
        '  each Anniversary SYSTEM off on this frozen frame (bloom stays off throughout):',
        `    ${'flag'.padEnd(26)} ${'cost'.padStart(8)}  ${'on'.padStart(6)} ${'off'.padStart(6)} ${'on'.padStart(6)} ${'drift'.padStart(6)}  ${'calls'.padStart(5)} ${'tris'.padStart(8)}`,
      )
      const flagResults: Record<string, unknown> = {}
      for (const flag of FLAGS) {
        const onBefore = await gpuMs(page)
        const infoOn = await info(page)
        await setFlag(page, flag, false)
        await page.waitForTimeout(SETTLE_MS)
        const off = await gpuMs(page)
        const infoOff = await info(page)
        await setFlag(page, flag, true)
        await page.waitForTimeout(SETTLE_MS)
        const onAfter = await gpuMs(page)

        const onMean = onBefore !== null && onAfter !== null ? (onBefore + onAfter) / 2 : null
        const cost = onMean !== null && off !== null ? onMean - off : null
        const drift = onBefore !== null && onAfter !== null ? Math.abs(onAfter - onBefore) : null
        flagResults[flag] = {
          cost,
          onBefore,
          off,
          onAfter,
          drift,
          calls: infoOn.calls - infoOff.calls,
          triangles: infoOn.triangles - infoOff.triangles,
          programs: infoOff.programs - infoOn.programs,
        }
        const suspect = cost !== null && drift !== null && drift > Math.abs(cost) ? ' <- drift' : ''
        lines.push(
          `    ${flag.padEnd(26)} ${cost === null ? '     n/a' : `${fmt(cost).padStart(5)} ms`}  ` +
            `${fmt(onBefore ?? 0).padStart(6)} ${fmt(off ?? 0).padStart(6)} ${fmt(onAfter ?? 0).padStart(6)} ${fmt(drift ?? 0).padStart(6)}  ` +
            `${String(infoOn.calls - infoOff.calls).padStart(5)} ${k(infoOn.triangles - infoOff.triangles).padStart(8)}${suspect}`,
        )
      }
      results._flags = flagResults

      await setFlag(page, 'render.bloom', true)
      console.info(`${lines.join('\n')}\n`)
      fs.mkdirSync(OUT_DIR, { recursive: true })
      fs.writeFileSync(
        path.join(OUT_DIR, `${mission}-${EDITION}-${EYE_PX}px.json`),
        JSON.stringify(
          {
            mission,
            edition: EDITION,
            snapAt: SNAP_AT,
            buffer: base,
            bloomOn,
            bloomOff,
            census: c,
            groups: results,
          },
          null,
          1,
        ),
      )
      fs.writeFileSync(
        path.join(OUT_DIR, `${mission}-${EDITION}-${EYE_PX}px.txt`),
        lines.join('\n'),
      )
    })
  }
})
