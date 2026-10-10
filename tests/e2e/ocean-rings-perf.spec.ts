/**
 * tests/e2e/ocean-rings-perf.spec.ts: DEV-339's measurement, A · rings · A · rings · A.
 *
 *   OCEAN_MISSIONS=int_01_hoverJet OCEAN_DIR=perf-out/dev339-perf E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/ocean-rings-perf.spec.ts --workers 1
 *
 * The plan (docs/plan/OCEAN-PERF.md section 2) says the sea's VERTEX cost is
 * unmeasured: the only reading, `?ocean=8 -> 1` at -0.52 ms an eye, is
 * withdrawn because it was two loads. The rings are a flag with a live switch
 * (`__ff2.oceanRings(on)`), so this is the measurement that replaces it: ONE
 * load, the frame frozen at the mission's 20 s mark (`flyToFreeze`), the drawing
 * buffer at one eye of the worn lap (the size `perf-fill.spec.ts` uses), and the
 * sea alternated plate / rings / plate / rings / plate with the same settle
 * between every reading. A pair is read against the bracket's own drift, not
 * against zero (`perf-protocol.md` section 3a-ter).
 *
 * The arm PROVES ITSELF in a count first, for every reading: the handle's `on`,
 * and the sea's triangles in the frame. An arm that cannot say it fired is not
 * an arm (DEV-232 section 10c). The negative control, `int_02_hoverJet` (alpine,
 * no sea), must report no handle at all, and its "A" and "arm" readings are the
 * instrument's own drift.
 *
 * Counts are contention-proof; every millisecond here is not, so the lease
 * (`tools/agent/gpu.sh`) is held for the run and a reading is quoted with its
 * wall-clock time (`AGENT-NOTES.md` section 1). `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { flyToFreeze } from './fixtures/freeze'
import { expect, type Page, test } from './fixtures/test'

const EYE_PX = Number(process.env.OCEAN_EYE ?? '2516')
const DPR = Number(process.env.OCEAN_DPR ?? '2')
const VIEWPORT = Math.round(EYE_PX / DPR)
const MISSIONS = (
  process.env.OCEAN_MISSIONS ?? 'int_01_hoverJet,adv_02_jumpSeat,hoverJet_kauai_beg,int_02_hoverJet'
).split(',')
const EDITION = process.env.OCEAN_EDITION ?? 'anniversary'
const SNAP_AT = Number(process.env.OCEAN_AT ?? '20')
const OUT_DIR = process.env.OCEAN_DIR ?? 'perf-out/dev339-perf'
const READ_MS = Number(process.env.OCEAN_READ_MS ?? '3000')
const SETTLE_MS = 2_000
const RETRIES = 3

interface Handle {
  wanted: boolean
  on: boolean
  reason: string | null
  triangles: number
  submitted: number
}

const handle = (page: Page, on?: boolean, normals?: 'derived' | 'face'): Promise<Handle | null> =>
  page.evaluate(
    async ([want, mode]) => {
      const w = globalThis as unknown as {
        __ff2?: { oceanRings?: (on?: boolean, normals?: string) => Promise<Handle | null> }
      }
      return (
        (await w.__ff2?.oceanRings?.(
          want as boolean | undefined,
          mode as 'derived' | 'face' | undefined,
        )) ?? null
      )
    },
    [on, normals] as const,
  )

/** The GPU median over a window, or null (never 0.00) when the ring came back empty. */
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

interface Frame {
  calls: number
  triangles: number
  programs: number
  seaCalls: number
  seaTriangles: number
}

/** Draw calls and triangles of the frame, and the sea's own row from the census. */
const frame = (page: Page): Promise<Frame> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          renderer: { info: { render: { calls: number; triangles: number }; programs: unknown[] } }
        }
        census: () => { rows: { group: string; calls: number; triangles: number }[] }
      }
    }
    const i = w.__ff2.render.renderer.info
    const sea = w.__ff2.census().rows.find((r) => r.group === 'world-ocean')
    return {
      calls: i.render.calls,
      triangles: i.render.triangles,
      programs: i.programs.length,
      seaCalls: sea?.calls ?? 0,
      seaTriangles: sea?.triangles ?? 0,
    }
  })

test.use({
  viewport: { width: VIEWPORT, height: VIEWPORT },
  deviceScaleFactor: DPR,
  launchOptions: { args: ['--disable-gpu-vsync'] },
})

test.describe('@measure @gpu DEV-339: A · rings · A, one load', () => {
  test.setTimeout(1_800_000)

  for (const mission of MISSIONS) {
    test(`${mission} ${EDITION} at ${SNAP_AT} s`, async ({ page }) => {
      await flyToFreeze(page, {
        mission,
        edition: EDITION,
        snapAt: SNAP_AT,
        params: { adaptive: '0', quality: 'high' },
      })
      await page.setViewportSize({ width: Math.round(VIEWPORT / 2), height: VIEWPORT })
      await page.waitForTimeout(SETTLE_MS)
      await page.setViewportSize({ width: VIEWPORT, height: VIEWPORT })
      await page.waitForTimeout(SETTLE_MS)

      const first = await handle(page)
      const rows: string[] = []
      const out: Record<string, unknown>[] = []
      if (first === null) {
        // The negative control: alpine. The arms must reach nothing.
        const a = await gpuMs(page)
        const b = await gpuMs(page)
        console.info(
          `\n  ${mission}: no sea. instrument drift ${a?.toFixed(2)} vs ${b?.toFixed(2)} ms`,
        )
        expect(await handle(page, true), 'a world with no sea must not report rings').toBeNull()
        return
      }
      // The preset may ship the rings on: the plate is then built here, outside the bracket.
      if (first.on) await handle(page, false)
      // Build the rings and the program once, outside the bracket.
      const built = await handle(page, true)
      expect(built?.reason).toBeNull()
      await page.waitForTimeout(SETTLE_MS * 2)
      // DEV-340's arm, built and compiled outside the bracket as well.
      await handle(page, true, 'face')
      await page.waitForTimeout(SETTLE_MS * 2)
      await handle(page, false, 'derived')
      await page.waitForTimeout(SETTLE_MS)

      const arms = ['plate', 'rings', 'face', 'plate', 'rings', 'face', 'plate'] as const
      const stamp = new Date().toLocaleTimeString('en-GB')
      for (const [i, arm] of arms.entries()) {
        const h = await handle(
          page,
          arm !== 'plate',
          arm === 'face' ? 'face' : arm === 'rings' ? 'derived' : undefined,
        )
        expect(h?.on, `the ${arm} arm did not fire`).toBe(arm !== 'plate')
        await page.waitForTimeout(SETTLE_MS)
        const f = await frame(page)
        const ms = await gpuMs(page)
        const line =
          `${mission} #${i} ${arm.padEnd(5)} gpu ${ms === null ? 'n/a' : ms.toFixed(2)} ms · ` +
          `frame ${f.calls} calls / ${f.triangles.toLocaleString('en-US')} tris · ` +
          `sea ${f.seaCalls} calls / ${f.seaTriangles.toLocaleString('en-US')} tris · ` +
          `${f.programs} programs · handle tris ${h?.triangles.toLocaleString('en-US')}`
        rows.push(line)
        out.push({ mission, i, arm, ms, ...f, handleTriangles: h?.triangles })
        console.info(`  ${line}`)
      }
      const get = (i: number): number => (out[i]?.ms as number | null) ?? Number.NaN
      const aMean = (get(0) + get(3) + get(6)) / 3
      const rMean = (get(1) + get(4)) / 2
      const fMean = (get(2) + get(5)) / 2
      const drift = Math.max(
        Math.abs(get(0) - get(3)),
        Math.abs(get(3) - get(6)),
        Math.abs(get(1) - get(4)),
        Math.abs(get(2) - get(5)),
      )
      console.info(
        `  ${mission}: plate ${aMean.toFixed(2)} ms · rings ${rMean.toFixed(2)} ms · ` +
          `rings+face ${fMean.toFixed(2)} ms · rings - plate ${(rMean - aMean).toFixed(2)} ms · ` +
          `face - rings ${(fMean - rMean).toFixed(2)} ms · bracket drift ${drift.toFixed(2)} ms · at ${stamp}`,
      )
      fs.mkdirSync(OUT_DIR, { recursive: true })
      fs.writeFileSync(
        path.join(OUT_DIR, `${mission}.json`),
        `${JSON.stringify({ mission, edition: EDITION, snapAt: SNAP_AT, eyePx: EYE_PX, stamp, aMean, rMean, fMean, drift, rows: out }, null, 2)}\n`,
      )
      // The counts are the arm's proof: the sea's triangles fell by an order of
      // magnitude when (and only when) the rings drew.
      const plate = out[0] as { seaTriangles: number }
      const ring = out[1] as { seaTriangles: number }
      expect(ring.seaTriangles, 'the rings drew as many triangles as the plate').toBeLessThan(
        plate.seaTriangles / 4,
      )
    })
  }
})
