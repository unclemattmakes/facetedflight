/**
 * tests/e2e/eye-buffer.spec.ts: the app-owned eye buffer on the emulated
 * headset. DEV-994 (the buffer), DEV-995 (its MSAA), DEV-997 (the pins).
 *
 * `render/eye-buffer.ts` draws a session's eyes into a target of ours at `s`
 * times the layer and upsamples them into three's XR target. The claims, each
 * on the app's own XR path (IWER, `fixtures/emulated-xr.ts`), none by "the
 * module is installed":
 *
 *  1. **At s = 1 it is three's picture.** `__ff2.eyeBufferProbe()` draws
 *     the live stage three times in ONE XR frame and one JS turn: straight
 *     into the XR target as three does, through the eye buffer, and straight
 *     again (the control), reading the XR target back after each (`?aa=0`,
 *     eye MSAA 0, the single-sampled path all three can take). Nothing should
 *     move inside a turn, and on most runs nothing does: zero pixels in both
 *     the pair and the control. On two of the first six runs one or two pixels
 *     of an eye moved by ONE level, before the control existed to say whether
 *     the direct arm does that to itself; so the tolerance is one level, on
 *     no more pixels than the control moved or `ONE_LEVEL_PIXELS`. A wrong
 *     storage format moved 75 % of an eye by up to 4 levels (the negative arm,
 *     the progress file). The eyes themselves must differ (IPD 63 mm), or
 *     "each eye equals" proves nothing about which eye.
 *  2. **The scale takes.** The same probe at 0.8 differs from three's picture
 *     (the positive control: an arm that ignored `s` would read zero), the
 *     live area is 0.8 of the layer, and the eye cameras' viewports, which the
 *     trace's `vp_w` reads, are the scaled eyes.
 *  3. **With MSAA, three's MSAA picture.** Under the eye buffer three's own XR
 *     target is single-sampled, so the direct arm draws into a TWIN of it at
 *     the eye MSAA (built from the same parameters, drawn and resolved by
 *     three's `render`), and the probe asks the same of 4x (the default on an
 *     antialiased context) and 2x. The samples are read back from GL, not
 *     from the option. A comparison ACROSS loads (off, on, off at a frozen
 *     tick, `?aa=1`) was tried first and dropped: the render clock moves 19k to
 *     72k pixels past 8 between two off loads, and an eye buffer with NO MSAA
 *     sat inside that noise in two runs of three, so it could not see MSAA at
 *     all (`docs/plan/eval-wave/perf-xr-eye-buffer.md`).
 *
 * `@gpu`, pinned (DEV-245). EYE_BUFFER_DIR=<dir> keeps the photographs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EYE_SCALE_FLOOR, EYE_SCALE_STEPS } from '../../src/render/eye-scale'
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { enterVr, loadSettled } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

/** 800 x 720 an eye; the width is EVEN so the halves are equal. */
test.use({ viewport: { width: 1600, height: 720 }, deviceScaleFactor: 1 })

const SNAP_AT = 8
const MISSION = 'rookie_01_hoverJet'
const OUT_DIR = process.env.EYE_BUFFER_DIR ?? ''

/** Pixels of an eye (576,000 here) allowed to move by one level at s=1. See claim 1. */
const ONE_LEVEL_PIXELS = 8

const presenting = (page: Page): Promise<boolean> =>
  page.evaluate(
    () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.render.renderer.xr.isPresenting ?? false,
  )

/**
 * Load, enter VR on the emulated headset, launch, and wait for the frozen tick.
 * `installEmulatedXr` once per page, before the first load: its init scripts
 * run on every navigation after it.
 */
const flyFrozen = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/?autopilot=1&mission=${MISSION}&snap=${SNAP_AT}&${PINNED}&${query}`)
  await loadSettled(page, 240_000)
  expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
  await enterVr(page)
  await expect.poll(() => presenting(page), { timeout: 60_000 }).toBe(true)
  // A on the right hand is launch (`input/xr.ts`); the autopilot flies it.
  await page.evaluate(() => {
    const c = (
      globalThis as unknown as {
        __emulatedXR: {
          device: {
            controllers: Record<string, { updateButtonValue: (id: string, v: number) => void }>
          }
        }
      }
    ).__emulatedXR.device.controllers.right
    c?.updateButtonValue('a-button', 1)
    setTimeout(() => c?.updateButtonValue('a-button', 0), 150)
  })
  await expect
    .poll(
      () =>
        page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.mission.elapsed ?? 0),
      { timeout: 120_000, intervals: [500] },
    )
    .toBeGreaterThanOrEqual(SNAP_AT)
  await page.waitForTimeout(2_000)
}

test.describe('@measure @gpu the eye buffer on the emulated headset (DEV-994, DEV-995)', () => {
  test.setTimeout(600_000)

  test('at s=1 each eye is three own picture, inside the control; at 0.8 the scale takes', async ({
    page,
  }) => {
    await installEmulatedXr(page, { ipd: 0.063, fovyDeg: 90 })
    await flyFrozen(page, 'aa=0&eyeBuffer=1&eyeMsaa=0')

    const report = await page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.eyeBuffer())
    expect(report, 'installed under ?eyeBuffer=1').not.toBeNull()
    const live = report as NonNullable<typeof report>
    expect(live.active, 'drawing the session').toBe(true)
    expect(live.frames, 'frames through the eye buffer').toBeGreaterThan(0)
    expect(live.msaa, '?eyeMsaa=0').toBe(0)
    expect(live.xrTargetSamples, "three's XR target is single-sampled under it").toBe(0)
    expect(live.controllerFrames, 'the controller is fed').toBeGreaterThan(0)

    // ── 1. s = 1: zero pixels differ, in either eye ───────────────────────
    const one = await page.evaluate(
      (png) => (globalThis as unknown as Ff2Global).__ff2.eyeBufferProbe({ scale: 1, png }),
      OUT_DIR !== '',
    )
    expect(one, 'the probe ran').not.toBeNull()
    const p1 = one as NonNullable<typeof one>
    const { png: png1, ...n1 } = p1
    console.info(`eye-buffer probe s=1: ${JSON.stringify(n1)}`)
    if (OUT_DIR && png1) {
      fs.mkdirSync(OUT_DIR, { recursive: true })
      for (const [i, url] of png1.entries()) {
        const name = `eye-buffer-probe-s1-${i === 0 ? 'direct' : 'eye-buffer'}.png`
        fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(url.split(',')[1] ?? '', 'base64'))
      }
    }
    expect(p1.eyes, 'two eyes').toHaveLength(2)
    expect(p1.calls.direct, 'the direct arm drew').toBeGreaterThan(10)
    expect(p1.calls.eyeBuffer, 'the eye arm drew the same scene, plus the upsample').toBe(
      p1.calls.direct + 1,
    )
    expect(p1.glError, 'GL raised nothing').toEqual({ direct: 0, eyeBuffer: 0, again: 0 })
    expect(
      p1.parallax?.over8 ?? 0,
      'the two eyes differ: the comparison is not vacuous',
    ).toBeGreaterThan(1_000)
    for (const eye of p1.compare) {
      const control = p1.control[eye.eye]
      expect(eye.maxDiff, `eye ${eye.eye}: the largest difference at s=1`).toBeLessThanOrEqual(1)
      expect(eye.over0, `eye ${eye.eye}: pixels that differ at s=1`).toBeLessThanOrEqual(
        Math.max(control?.over0 ?? 0, ONE_LEVEL_PIXELS),
      )
    }

    // ── 2. s = 0.8: the scale takes ───────────────────────────────────────
    const eight = await page.evaluate(() =>
      (globalThis as unknown as Ff2Global).__ff2.eyeBufferProbe({ scale: 0.8 }),
    )
    const p8 = eight as NonNullable<typeof eight>
    console.info(`eye-buffer probe s=0.8: ${JSON.stringify(p8)}`)
    expect(p8.glError).toEqual({ direct: 0, eyeBuffer: 0, again: 0 })
    for (const eye of p8.compare) {
      expect(eye.over2, `eye ${eye.eye}: 0.8 is not three's picture`).toBeGreaterThan(1_000)
    }
    const pinned = await page.evaluate(() =>
      (globalThis as unknown as Ff2Global).__ff2.eyeBuffer(0.8),
    )
    expect(pinned?.pinned).toBe(0.8)
    await page.waitForTimeout(500)
    const scaled = await page.evaluate(() => {
      const w = globalThis as unknown as Ff2Global
      const xr = w.__ff2.render.renderer.xr
      return {
        report: w.__ff2.eyeBuffer(),
        viewports: xr.getCamera().cameras.map((c) => {
          const v = (c as unknown as { viewport: { x: number; z: number; w: number } }).viewport
          return { x: v.x, z: v.z, w: v.w }
        }),
      }
    })
    console.info(`eye-buffer pinned 0.8: ${JSON.stringify(scaled)}`)
    const layer = scaled.report?.layer as { width: number; height: number }
    const eyeWidth = (p1.eyes[0] as { z: number }).z
    expect(scaled.report?.live, 'the live area is 0.8 of the layer').toEqual({
      width: Math.round(eyeWidth * 0.8) * 2,
      height: Math.round(layer.height * 0.8),
    })
    expect(
      scaled.viewports.map((v) => v.z),
      'each eye camera drew at 0.8 (the trace reads this as vp_w)',
    ).toEqual([Math.round(eyeWidth * 0.8), Math.round(eyeWidth * 0.8)])
    expect(scaled.viewports[1]?.x, 'the right eye sits after the left at the new size').toBe(
      Math.round(eyeWidth * 0.8),
    )
  })

  test('the controller moves the scale the eyes are drawn at (the wiring)', async ({ page }) => {
    // The misses are the harness's: a page rAF callback that burns 25 ms a
    // frame (IWER drives the session from the page's rAF), so every XR frame
    // arrives well past 1.5 display periods and short of a stall. A `?hz=` pin
    // cannot do it here: IWER's session reports its own `frameRate` (90),
    // which outranks the pin. Then the frame loop feeds the controller, the
    // controller walks to its floor, and the eye buffer draws there: the path
    // from the frame's dt to the drawn pixels is the game's own.
    await installEmulatedXr(page, { ipd: 0.063, fovyDeg: 90 })
    await flyFrozen(page, 'aa=0&eyeBuffer=1')
    const before = await page.evaluate(() => {
      const w = globalThis as unknown as Ff2Global
      const q = w.__ff2.render.quality.report
      return { eye: w.__ff2.eyeBuffer(), displayHz: q.displayHz, tierHz: q.tierHz }
    })
    console.info(`eye-buffer controller, before: ${JSON.stringify(before)}`)
    expect(before.eye?.scale, 'full scale before the load').toBe(1)
    await page.evaluate(() => {
      const burn = (): void => {
        const t = performance.now()
        while (performance.now() - t < 25) {
          // the harness's load
        }
        requestAnimationFrame(burn)
      }
      requestAnimationFrame(burn)
    })
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.eyeBuffer()?.scale ?? 1,
          ),
        { timeout: 60_000, intervals: [500] },
      )
      .toBe(EYE_SCALE_FLOOR)
    await page.waitForTimeout(500)
    const r = await page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.eyeBuffer())
    console.info(`eye-buffer controller: ${JSON.stringify(r)}`)
    const report = r as NonNullable<typeof r>
    expect(report.pinned).toBeNull()
    expect(report.changes.length, 'one logged change per step').toBe(EYE_SCALE_STEPS.length - 1)
    expect(report.changes.every((c) => c.reason.length > 0)).toBe(true)
    const layer = report.layer as { width: number; height: number }
    expect(report.live, 'drawn at the floor').toEqual({
      width: Math.round((layer.width / 2) * EYE_SCALE_FLOOR) * 2,
      height: Math.round(layer.height * EYE_SCALE_FLOOR),
    })
  })

  for (const samples of [4, 2] as const) {
    test(`with ${samples}x MSAA in the eye buffer, each eye is three own ${samples}x picture`, async ({
      page,
    }) => {
      await installEmulatedXr(page, { ipd: 0.063, fovyDeg: 90 })
      // 4x is the default on an antialiased context; 2x has to be asked for.
      await flyFrozen(page, `aa=1&eyeBuffer=1${samples === 4 ? '' : `&eyeMsaa=${samples}`}`)
      const r = await page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.eyeBuffer())
      console.info(`eye-buffer ${samples}x: ${JSON.stringify(r)}`)
      expect(r?.active).toBe(true)
      expect(r?.msaa, "the eye target's samples").toBe(samples)
      expect(r?.glSamples, 'as GL built them').toBe(samples)
      expect(r?.xrTargetSamples, "three's XR target, single-sampled under it").toBe(0)
      const probe = await page.evaluate(() =>
        (globalThis as unknown as Ff2Global).__ff2.eyeBufferProbe({ scale: 1 }),
      )
      const p = probe as NonNullable<typeof probe>
      console.info(`eye-buffer probe ${samples}x s=1: ${JSON.stringify(p)}`)
      expect(p.reference, 'the direct arm drew into the MSAA twin').toBe('msaa-twin')
      expect(p.msaa).toBe(samples)
      expect(p.glError).toEqual({ direct: 0, eyeBuffer: 0, again: 0 })
      expect(p.calls.eyeBuffer).toBe(p.calls.direct + 1)
      expect(p.parallax?.over8 ?? 0, 'the two eyes differ').toBeGreaterThan(1_000)
      for (const eye of p.compare) {
        const control = p.control[eye.eye]
        expect(eye.maxDiff, `eye ${eye.eye}: the largest difference`).toBeLessThanOrEqual(1)
        expect(eye.over0, `eye ${eye.eye}: pixels that differ`).toBeLessThanOrEqual(
          Math.max(control?.over0 ?? 0, ONE_LEVEL_PIXELS),
        )
      }
    })
  }
})
