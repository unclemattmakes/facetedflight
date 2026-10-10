/**
 * The LOD pop, measured — DEV-130.
 *
 * Matt: *"the terrain lod-popping is very noticeable — i'd like to smooth that
 * out."* Before anything is smoothed this spec puts a number on it, and after,
 * the same number says what the smoothing bought.
 *
 * ── How a pop is isolated from everything else that moves ────────────────
 *
 * A per-frame pixel difference during flight is mostly the flight. So the
 * camera does not fly. It stands at a `?view=cam` viewpoint (placed once at
 * boot and never touched by the loop), and the LOD ladder is worked by the
 * HYSTERESIS 2016 built into it: a chunk whose footprint is between
 * `0.97 * D` and `1.03 * D` from the eye is stable at EITHER level, and which
 * one it holds depends on where the eye has been. So:
 *
 *   1. settle, shoot the home frame;
 *   2. step the eye `nudge` metres along the look bearing — TOWARD the
 *      hillside — for exactly one render loop, long enough for `updateLod` to
 *      post requests for every chunk the step carried across the band and not
 *      long enough for the worker to answer;
 *   3. step back to the home pose and shoot a burst as the replies land.
 *
 * The nudge is deliberately LARGER than the hysteresis band, so most of the
 * chunks it moved are re-selected at home and walk straight back: a burst
 * therefore holds TWO swaps of the same chunks, fine then coarse, both at the
 * home pose — which is a stronger sample than the one or two chunks a
 * band-sized nudge parks on the far side of the hysteresis, and the same shape
 * a flight produces (a chunk crossing a band each way). Every frame in a burst
 * is the SAME pose, so consecutive frames differ by the swaps and by nothing
 * else — the sea's wave phase excepted, which runs on wall time and is measured
 * by the control below. Then the eye steps AWAY and back for the coarse side.
 *
 * ── The number ───────────────────────────────────────────────────────────
 *
 * For each consecutive pair in a burst: the fraction of viewport pixels whose
 * largest channel moved by more than `CHANGED` (of 255), and the mean absolute
 * change. **The pop score is the largest single-step change in the burst.** A
 * one-frame swap spends the whole difference in one step; a fade spreads it,
 * and the largest step shrinks in proportion — that is what "smoother" means in
 * pixels. The burst's END frame against its START frame says how much changed
 * in total, which the fade must NOT reduce (it is the same geometry arriving).
 *
 * Shots are written to `LOD_POP_DIR` (never `test-results/`, which Playwright
 * wipes), one JSON of numbers per edition beside them. Tagged `@gpu`.
 *
 *   LOD_POP_DIR=<dir> E2E_PORT=<yours> pnpm exec playwright test tests/e2e/lod-pop.spec.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'

const OUT_DIR = process.env.LOD_POP_DIR ?? 'test-results/lod-pop'
const EDITIONS = (process.env.LOD_POP_EDITIONS ?? 'classic,anniversary').split(',')
const MISSION = 'int_01_hoverJet'
/** Channel delta, of 255, above which a pixel counts as changed. */
const CHANGED = 10
/** Burst length and spacing. 2016 authored a 1 s transition; two of them, plus slack. */
const BURST_SHOTS = 22
const BURST_GAP_MS = 100

/**
 * Two stands on `island-lit`'s hillside (the look point is a lit face at
 * 338 m), each with the eye placed so the look point sits EXACTLY on the band
 * being measured: 1,000 m out for the 1,024 m LOD 0/1 band, 320 m out for the
 * detail ring. The hillside around the look point then fills the middle of the
 * frame at band distance, which is where a swap is seen from the seat.
 */
const STANDS = {
  band1024: { eye: [1196, 500, -795], look: [522, 338, -1533], nudge: 250 },
  ring320: { eye: [738, 488, -1297], look: [522, 338, -1533], nudge: 60 },
} as const

interface Frame {
  readonly name: string
  readonly t: number
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
  readonly channels: number
}

interface StepDiff {
  readonly from: string
  readonly to: string
  readonly dt: number
  /** Fraction of pixels whose largest channel delta exceeds CHANGED. */
  readonly changed: number
  /** Mean absolute delta over all channels, of 255. */
  readonly mean: number
}

const diff = (a: Frame, b: Frame): StepDiff => {
  const n = a.width * a.height
  let changed = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const o = i * a.channels
    let maxD = 0
    for (let c = 0; c < 3; c++) {
      const d = Math.abs((a.data[o + c] as number) - (b.data[o + c] as number))
      sum += d
      if (d > maxD) maxD = d
    }
    if (maxD > CHANGED) changed++
  }
  return { from: a.name, to: b.name, dt: b.t - a.t, changed: changed / n, mean: sum / (n * 3) }
}

const settle = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __ff2?: { terrain: () => { terrain: { pending: number; detailPending: number } } | null }
      }
      const t = w.__ff2?.terrain?.()
      return !!t && t.terrain.pending === 0 && t.terrain.detailPending === 0
    },
    undefined,
    { timeout: 60_000 },
  )
}

/** Two render loops from now, so `updateLod` has run at least once. */
const twoFrames = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )

const setEye = (page: Page, eye: readonly number[]): Promise<void> =>
  page.evaluate(
    ([x, y, z]) => {
      const w = globalThis as unknown as {
        __ff2?: { render: { camera: { position: { set(x: number, y: number, z: number): void } } } }
      }
      w.__ff2?.render.camera.position.set(x as number, y as number, z as number)
    },
    eye as unknown as number[],
  )

/** Chunks per LOD, live. Read before and after a nudge, the difference is the swap. */
const lodLive = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: { terrain: () => { terrain: { lodLive: Record<string, number> } } | null }
    }
    return w.__ff2?.terrain?.()?.terrain.lodLive ?? {}
  })

const lodSummary = (a: Record<string, number>, b: Record<string, number>): string => {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return keys.map((k) => `LOD ${k}: ${a[k] ?? 0} -> ${b[k] ?? 0}`).join(', ')
}

const shoot = async (page: Page, dir: string, name: string): Promise<Frame> => {
  const png = await page.locator('#viewport').screenshot()
  fs.writeFileSync(path.join(dir, `${name}.png`), png)
  const img = decodePngBuffer(png, name)
  return {
    name,
    t: Date.now(),
    width: img.width,
    height: img.height,
    data: img.data as Uint8Array,
    channels: img.channels,
  }
}

/**
 * Step the eye out along `dir` for one loop, step back, and photograph the
 * replies landing. Returns the burst, home frame first.
 */
const nudgeAndBurst = async (
  page: Page,
  dir: string,
  tag: string,
  home: readonly number[],
  offset: readonly number[],
): Promise<Frame[]> => {
  const frames: Frame[] = [await shoot(page, dir, `${tag}-00-home`)]
  const before = await lodLive(page)
  const [hx, hy, hz] = home as [number, number, number]
  const [ox, oz] = offset as [number, number]
  await setEye(page, [hx + ox, hy, hz + oz])
  await twoFrames(page)
  await setEye(page, home)
  await twoFrames(page)
  for (let i = 1; i <= BURST_SHOTS; i++) {
    frames.push(await shoot(page, dir, `${tag}-${String(i).padStart(2, '0')}`))
    await page.waitForTimeout(BURST_GAP_MS)
  }
  // How many chunks the nudge actually moved is part of the record: a stand
  // where the band holds no visible chunk would measure a perfectly smooth
  // nothing.
  console.info(`${tag}: ${lodSummary(before, await lodLive(page))}`)
  return frames
}

const report = (frames: Frame[]): { steps: StepDiff[]; total: StepDiff; pop: StepDiff } => {
  const steps: StepDiff[] = []
  for (let i = 1; i < frames.length; i++) {
    steps.push(diff(frames[i - 1] as Frame, frames[i] as Frame))
  }
  const total = diff(frames[0] as Frame, frames[frames.length - 1] as Frame)
  const pop = steps.reduce((a, b) => (b.changed > a.changed ? b : a))
  return { steps, total, pop }
}

test.describe('@measure @gpu terrain LOD pop', () => {
  test.setTimeout(600_000)

  for (const edition of EDITIONS) {
    test(`measures the swap at the band and the ring — ${edition}`, async ({ page }) => {
      const dir = path.join(OUT_DIR, edition)
      fs.mkdirSync(dir, { recursive: true })
      const results: Record<string, unknown> = { edition, mission: MISSION, changedAbove: CHANGED }

      for (const [standName, stand] of Object.entries(STANDS)) {
        const eye = stand.eye.join(',')
        const look = stand.look.join(',')
        await page.goto(
          `/?view=cam&xr=off&ride=0&eye=${eye}&look=${look}&edition=${edition}&mission=${MISSION}`,
        )
        // The landing card covers the canvas, and the curtain under it stays
        // down until the card is dismissed (DEV-107). Same two lines every
        // viewpoint spec runs.
        await firstPress(page)
        await missionReady(page, 120_000)
        await settle(page)
        // The ring fills in over the first frames of flight (DEV-085), and the
        // stand's own chunks may still be walking from the spawn's LOD to the
        // eye's. Let all of it land before the home frame.
        await page.waitForTimeout(2_500)
        await settle(page)

        // The look bearing, horizontal, unit length.
        const bx = stand.look[0] - stand.eye[0]
        const bz = stand.look[2] - stand.eye[2]
        const len = Math.hypot(bx, bz)
        const away = [(-bx / len) * stand.nudge, (-bz / len) * stand.nudge]
        const toward = [(bx / len) * stand.nudge, (bz / len) * stand.nudge]

        // CONTROL: a burst with no nudge at all. Whatever this measures is the
        // sea's wave phase and the frame-to-frame noise floor, and every real
        // score is read against it.
        const control: Frame[] = [await shoot(page, dir, `${standName}-control-00`)]
        for (let i = 1; i <= 4; i++) {
          await page.waitForTimeout(BURST_GAP_MS)
          control.push(await shoot(page, dir, `${standName}-control-${i}`))
        }
        const controlReport = report(control)

        // TOWARD first: the band's chunks arrive from the spawn's coarse LODs
        // and the hysteresis parks them on the coarse side, so the first swap
        // the player would see approaching this hillside is coarse -> fine.
        const fine = await nudgeAndBurst(page, dir, `${standName}-fine`, stand.eye, toward)
        await settle(page)
        const coarse = await nudgeAndBurst(page, dir, `${standName}-coarse`, stand.eye, away)
        await settle(page)

        const fineReport = report(fine)
        const coarseReport = report(coarse)
        results[standName] = {
          control: { pop: controlReport.pop, total: controlReport.total },
          fine: fineReport,
          coarse: coarseReport,
        }
        const fmt = (d: StepDiff) =>
          `${(100 * d.changed).toFixed(2)}% px, mean ${d.mean.toFixed(2)}/255`
        console.info(
          `[${edition}] ${standName}: control max step ${fmt(controlReport.pop)} | ` +
            `FINE pop ${fmt(fineReport.pop)} (total ${fmt(fineReport.total)}) | ` +
            `COARSE pop ${fmt(coarseReport.pop)} (total ${fmt(coarseReport.total)})`,
        )
      }

      fs.writeFileSync(path.join(dir, 'lod-pop.json'), JSON.stringify(results, null, 2))
      // A capture tool with one assertion: the frames were of a world.
      expect(Object.keys(results)).toContain('band1024')
    })
  }
})
