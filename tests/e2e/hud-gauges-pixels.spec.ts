/**
 * tests/e2e/hud-gauges-pixels.spec.ts — DEV-257. The four continuous readings
 * as geometry, photographed from the seat, and the arm proved to be an arm.
 *
 *   E2E_PORT=<yours> HUD_GAUGES_DIR=perf-out/dev257-for-matt \
 *     HUD_GAUGES_ARMS=off,bar,needle,bar-only,needle-only \
 *     pnpm exec playwright test tests/e2e/hud-gauges-pixels.spec.ts --workers 1 --retries 0
 *
 * ── Two jobs, and they need the same load ────────────────────────────────
 *
 * **1. The pictures.** `?hudGauges=` moves the speed row from a three-digit
 * number to an instrument, and there are two candidate forms. Which one is
 * right is Matt's call (hard rule 9), and `ART_DIRECTION.md`'s own rule is
 * *"photograph the thing, at the same tick, before believing it"* and *"a
 * thing too small, too dark, too fast or off-screen has not been reviewed —
 * it has been rendered."* The title screen's jets flew backwards through a
 * whole session of Matt looking at them because they were four pixels across.
 *
 * **2. The counts.** `__ff2.hud()` reports `rateHz`, `unchanged`, `skipped`
 * and `canvasOps`, and the whole argument for this row is that the first of
 * those collapses to about the clock. Those are COUNTS, never durations —
 * `docs/testing/perf-protocol.md` §3a is explicit that a duration taken while
 * anything else is on the box is not evidence, and §3a-quater's case is worse
 * than that: an unquiet box does not mismeasure the build, it CHANGES it.
 * Counts survive contention, so this spec may take them and may not take a
 * millisecond.
 *
 * ── FROM THE SEAT, because a free camera has no panel in it ─────────────
 *
 * perf-protocol §3f, and Matt's own words reading wave 4's frames: *"it looks
 * like the tests aren't being run from eye-level"*. The panel sits 0.78 m from
 * the eye, 22.6 degrees below the gaze, subtending 28.8 x 10.6 degrees. There
 * is no panel at all in a `?view=cam` frame at 900 m. So this flies the
 * mission, freezes it with `?snap=`, and crops the panel out of a cockpit
 * frame computed from the LIVE transforms.
 *
 * ── The pin, and why a picture needs one ────────────────────────────────
 *
 * DEV-245. `render/quality.ts` measures the frame and drops a tier when the
 * CPU is starved, and a tier drop moves MSAA, the framebuffer scale, the
 * shadow map and the prop LOD — every one of which is in a screenshot. So
 * every load carries `PINNED` and every shot reads the live tier back; a tier
 * that MOVED fails the run rather than quietly producing a different picture.
 *
 * ── The gate, and why it is a BRACKET rather than "the diff is zero" ────
 *
 * The brief for this row asks for a zero pixel diff with the arm down. A
 * strictly zero diff is not reachable and it is worth saying exactly why
 * rather than loosening a number until it passed: `?snap=` freezes the SIM,
 * not the wall clock, so the ocean and the particles keep moving — and the
 * panel's plates are 86 % opaque, so **every pixel of this crop has some
 * world behind it**. `hud-upload-pixels.spec.ts` measured the same thing from
 * the other side: with `?snap=` its quiet mask kept 99.8 % of the crop, i.e.
 * 0.2 % of it moves anyway.
 *
 * So the honest gate is the one that spec already uses in a different shape —
 * a CONTROL. Shoot the arm-down build twice, in two separate loads, and call
 * that the noise floor; then shoot the pre-DEV-257 build once and require the
 * A-versus-baseline difference to be inside it. *"My change is
 * indistinguishable from re-taking the same photograph"* is a claim a number
 * can carry; *"the diff is zero"* is a claim about a still world this game
 * does not have.
 *
 * `HUD_GAUGES_EXPECT=none` is for the baseline half of that bracket: it runs
 * against a tree checked out BEFORE the pin existed, where `__ff2.hud()` has
 * no `gauges` field to assert on. It relaxes an assertion about the HARNESS's
 * knowledge of the build, and changes nothing about the build — the line
 * CLAUDE.md draws is whether the GAME behaves differently, and with the arm
 * down and the pin absent these two URLs are the same URL.
 */
import fs from 'node:fs'
import path from 'node:path'
import { comparePng } from '../../tools/perf/png-diff.mjs'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import {
  type DrawState,
  drawState,
  drawStateDiff,
  drawStateLine,
  PINNED,
} from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

const OUT = process.env.HUD_GAUGES_DIR ?? 'perf-out/dev257'
const MISSION = process.env.HUD_GAUGES_MISSION ?? 'int_01_hoverJet'
const EDITION = process.env.HUD_GAUGES_EDITION ?? 'anniversary'
/**
 * The arms to shoot, in order. Duplicates are fine and are what the control
 * half of the bracket uses.
 *
 * **The DEFAULT is deliberately small — three arms at one mark.** This spec is
 * a tool that gets pointed at a question, but it is `@gpu`-tagged and `@gpu`
 * is only filtered out under `E2E_SKIP_GPU=1`, so whatever is here runs in an
 * ordinary `pnpm e2e`. The full five-arm, two-mark set is ~5 minutes and is
 * one env var away (see the header); the default is the part worth having as
 * a REGRESSION — that the pin still reaches the panel, that each form still
 * draws quads, and that the tier held. `hud-upload-pixels.spec.ts` is the
 * house scale for a photo spec and it is one test.
 */
const ARMS = (process.env.HUD_GAUGES_ARMS ?? 'off,bar,needle')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
/**
 * The mission seconds to freeze at, so the gauges are photographed across a
 * RANGE rather than at one lucky reading.
 *
 * 6 s is just off the elevator — slow, meters near empty, which is the state
 * DEV-154 exists about: an empty gauge that draws nothing is that bug coming
 * back. 25 s is mid-course at speed with gates banked. The readings each shot
 * actually reached are printed beside it, because *which* state a frame caught
 * is not something to infer from the mark afterwards.
 */
const MARKS = (process.env.HUD_GAUGES_AT ?? '25')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n))
/** `none` where the build under test predates the pin — see the header. */
const EXPECT = process.env.HUD_GAUGES_EXPECT ?? 'arm'
/**
 * The redraw cadence to run under. Unset is the SHIPPED one (DEV-248's 10 Hz
 * budget), which is what the frames want because it is what Matt will fly.
 *
 * **`live` is what the COUNTS want, and the first smoke run is why this
 * parameter exists.** Under the budget the panel repainted at 6.49 Hz with the
 * arm up — and it would repaint at about the same rate with the arm down,
 * because `HUD_REDRAW_DEFAULT` caps it at 10 either way. The budget is a
 * CEILING, so it hides the very thing this row changes. Under `live` the
 * signature is the only gate, and `rateHz` is then the repaint rate the panel
 * actually wants — which is the number §5.3 predicts collapses to the clock.
 *
 * `skipped` is the tell under the budget and `rateHz` is the tell under
 * `live`, so both are worth taking and neither replaces the other.
 */
const REDRAW = process.env.HUD_GAUGES_REDRAW ?? ''

/** One worn eye, the way `hud-upload-pixels.spec.ts` takes it (DEV-244). */
const EYE_PX = Number(process.env.HUD_GAUGES_PX ?? '2016')
const DPR = 2
test.use({
  viewport: { width: Math.round(EYE_PX / DPR), height: Math.round(EYE_PX / DPR) },
  deviceScaleFactor: DPR,
})

interface Clip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The panel's screen rect in CSS pixels, from the LIVE transforms.
 *
 * Lifted from `hud-upload-pixels.spec.ts`'s `panelMetrics` and cut down to the
 * clip, with its two traps kept because they are both real here:
 *
 *  · `matrixWorld` is only recomputed inside `render()` and this runs between
 *    frames — the same staleness CLAUDE.md records for `grip.matrixWorld` in
 *    an XR callback. Both matrices are refreshed by hand.
 *  · **`camera.position` is LOCAL in the cockpit** (trap 18): the head inside
 *    the rig, which is the origin until you lean. Nothing here reads it; the
 *    projection goes through `matrixWorldInverse`, which is the world-space
 *    quantity.
 *
 * The pad is deliberately generous: the gauges are CHILDREN of the panel and
 * live inside its plane, so the panel's own rect contains them — but a future
 * bezel (DEV-258) would not be, and a crop that silently excluded the thing
 * being judged is the failure this whole file exists to avoid.
 */
const panelClip = (page: import('@playwright/test').Page): Promise<Clip | null> =>
  page.evaluate(() => {
    interface V3 {
      x: number
      y: number
      z: number
    }
    interface Cam {
      position: V3
      matrixWorld: unknown
      matrixWorldInverse: { copy: (m: unknown) => { invert: () => unknown } }
      updateMatrixWorld: (force?: boolean) => void
    }
    interface Mesh {
      matrixWorld: unknown
      updateWorldMatrix: (parents: boolean, children: boolean) => void
      geometry?: { parameters?: { width: number; height: number } }
    }
    const w = globalThis as unknown as {
      __ff2?: {
        render: { scene: { getObjectByName: (n: string) => Mesh | undefined }; camera: Cam }
      }
    }
    const render = w.__ff2?.render
    const panel = render?.scene.getObjectByName('hud')
    const canvas = document.getElementById('viewport') as HTMLCanvasElement | null
    if (!render || !panel || !canvas) return null
    const size = panel.geometry?.parameters
    if (!size) return null

    const camera = render.camera
    panel.updateWorldMatrix(true, false)
    camera.updateMatrixWorld(true)
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()

    const V = camera.position.constructor as new (
      x: number,
      y: number,
      z: number,
    ) => {
      x: number
      y: number
      applyMatrix4: (m: unknown) => void
      project: (c: Cam) => void
    }
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    const toScreen = (lx: number, ly: number) => {
      const v = new V(lx, ly, 0)
      v.applyMatrix4(panel.matrixWorld)
      v.project(camera)
      return { x: (v.x * 0.5 + 0.5) * cssW, y: (1 - (v.y * 0.5 + 0.5)) * cssH }
    }
    const hw = size.width / 2
    const hh = size.height / 2
    const corners = [toScreen(-hw, hh), toScreen(hw, hh), toScreen(-hw, -hh), toScreen(hw, -hh)]
    const xs = corners.map((c) => c.x)
    const ys = corners.map((c) => c.y)
    const pad = 18
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad))
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad))
    const x1 = Math.min(cssW, Math.ceil(Math.max(...xs) + pad))
    const y1 = Math.min(cssH, Math.ceil(Math.max(...ys) + pad))
    const box = canvas.getBoundingClientRect()
    return {
      x: box.x + x0,
      y: box.y + y0,
      width: Math.max(1, x1 - x0),
      height: Math.max(1, y1 - y0),
    }
  })

interface HudProbe {
  gauges?: string
  gaugeQuads?: number
  cadence: string
  repaints: number
  seconds: number
  rateHz: number
  unchanged: number
  skipped: number
  canvasOps: { total: number; texts: number; measures: number }
}

const hudReport = (page: import('@playwright/test').Page): Promise<HudProbe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2?: { hud: () => unknown } }
    return (w.__ff2?.hud() ?? null) as never
  })

/** Speed and the three meter states, so a frame says which state it caught. */
const flightState = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    // `__ff2.flight` is a FUNCTION returning the live flight (`app.ts:10455`),
    // and the body's velocity hangs off the jet — the shape `flat-fov.spec.ts`
    // already reads.
    const w = globalThis as unknown as {
      __ff2?: {
        mission?: { elapsed?: number }
        flight?: () => {
          jet?: { body?: { velocity?: { x: number; y: number; z: number } } }
        } | null
      }
    }
    const v = w.__ff2?.flight?.()?.jet?.body?.velocity
    return {
      elapsed: w.__ff2?.mission?.elapsed ?? 0,
      speed: v ? Math.hypot(v.x, v.y, v.z) : Number.NaN,
    }
  })

test.describe('@gpu DEV-257 — the continuous readings as geometry', () => {
  test.setTimeout(600_000)

  for (const arm of ARMS) {
    for (const at of MARKS) {
      test(`${arm} at ${at} s`, async ({ page }, testInfo) => {
        const errors = watchPageErrors(page)
        // `?hudGauges=` is omitted entirely for the baseline half, because the
        // tree it runs against has no such parameter and a URL carrying one it
        // ignores would be a different URL for no reason.
        const gaugeParam = EXPECT === 'none' ? '' : `&hudGauges=${arm}`
        const redrawParam = REDRAW ? `&hudRedraw=${REDRAW}` : ''
        // `PINNED` is `adaptive=0&quality=high` and it is on EVERY load in
        // this file, deliberately and without a helper that can be forgotten
        // (DEV-245). A tier drop moves MSAA, the framebuffer scale, the shadow
        // map and the prop LOD, so an unpinned frame is a photograph of a
        // different build — and the arm-down diff below would come back
        // non-zero for a reason that has nothing to do with this row.
        const url =
          `/?xr=off&ride=0&mission=${MISSION}&edition=${EDITION}&autopilot=1` +
          `&snap=${at}${gaugeParam}${redrawParam}&${PINNED}`
        await page.goto(url)
        await firstPress(page)
        await missionReady(page, 240_000)
        await focusCanvas(page)
        // Held, not tapped — `pause.spec.ts` says why, and the launch prompt
        // is a hold.
        await page.keyboard.down('Enter')
        await page.waitForTimeout(200)
        await page.keyboard.up('Enter')

        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const w = globalThis as unknown as { __ff2?: { snap: () => { frozen: boolean } } }
                return w.__ff2?.snap().frozen ?? false
              }),
            { timeout: 240_000, intervals: [250] },
          )
          .toBe(true)
        // The render settles on the frozen state; the waves and the particles
        // run on wall time and a frame or two after the freeze is fine.
        await page.waitForTimeout(1_500)

        const before: DrawState = await drawState(page)
        const report = await hudReport(page)
        expect(report, 'no flight, so no panel to photograph').not.toBeNull()
        const flight = await flightState(page)
        expect(flight.elapsed, 'the snap fired before the ship was flying').toBeGreaterThanOrEqual(
          at,
        )

        // ── The arm reached the panel, or the frame is of the wrong build ──
        //
        // DEV-232 and DEV-237's discipline: the probe reports the LIVE state
        // rather than echoing the intent, so a pin that never arrived reads as
        // a disagreement instead of as a pass. A photo run that silently shot
        // five copies of the same arm is the failure mode this catches, and it
        // is invisible in the pictures precisely when the arm does nothing.
        if (EXPECT === 'none') {
          expect(
            report?.gauges,
            'HUD_GAUGES_EXPECT=none is for a tree that PREDATES the pin — this one has it',
          ).toBeUndefined()
        } else {
          expect(report?.gauges, `?hudGauges=${arm} did not reach the panel`).toBe(arm)
          // And the geometry is actually being drawn. `gaugeQuads: 0` under a
          // non-`off` arm is an arm that never fired, which is the same
          // refusal `skipped: 0` offers for the cadence.
          if (arm === 'off') expect(report?.gaugeQuads).toBe(0)
          else expect(report?.gaugeQuads ?? 0, `${arm} drew no quads`).toBeGreaterThan(0)
        }

        const clip = await panelClip(page)
        expect(clip, 'the panel is not on screen — is the camera in the cockpit?').not.toBeNull()
        const crop = await page.screenshot({ clip: clip as Clip })
        const wide = await page.locator('#viewport').screenshot()
        const after: DrawState = await drawState(page)

        fs.mkdirSync(OUT, { recursive: true })
        const stem = `${arm}-${at}s`
        fs.writeFileSync(path.join(OUT, `${stem}-panel.png`), crop)
        fs.writeFileSync(path.join(OUT, `${stem}-wide.png`), wide)

        // ── The counts, written beside the picture ─────────────────────────
        //
        // The evidence for the row. `rateHz` is repaints per second over the
        // PANEL's whole life — which starts under the loading curtain and
        // includes the banner and the lift — so it is quoted with `seconds`
        // beside it, exactly as `CanvasPanelReport` asks.
        const line =
          `${stem}\n` +
          `  url          ${url}\n` +
          `  gauges       ${report?.gauges ?? '(pre-DEV-257 build)'}` +
          `  quads ${report?.gaugeQuads ?? 0}\n` +
          `  cadence      ${report?.cadence}\n` +
          `  repaints     ${report?.repaints} over ${report?.seconds.toFixed(2)} s` +
          `  = ${report?.rateHz.toFixed(3)} Hz\n` +
          `  unchanged    ${report?.unchanged}   skipped ${report?.skipped}\n` +
          `  canvasOps    ${report?.canvasOps.total} (${report?.canvasOps.texts} text, ` +
          `${report?.canvasOps.measures} measure)\n` +
          `  flight       ${flight.speed.toFixed(1)} m/s at ${flight.elapsed.toFixed(2)} s\n` +
          `  crop         ${clip?.width}x${clip?.height} css\n` +
          `  ${drawStateLine(before)}\n`
        fs.appendFileSync(path.join(OUT, 'counts.txt'), line)
        testInfo.annotations.push({ type: 'counts', description: line })
        // eslint-disable-next-line no-console
        console.info(line)

        // DEV-245. A tier that moved between the two reads of one shot means
        // MSAA or the framebuffer scale changed under the camera, and the
        // picture is of two builds.
        expect(
          drawStateDiff(before, after),
          'the quality tier MOVED while this frame was being taken',
        ).toEqual([])
        expect(errors.list(), 'the page logged an error while being photographed').toEqual([])
      })
    }
  }
})

/**
 * The bracket, run as a separate step once the three photo runs exist.
 *
 *   HUD_GAUGES_GATE=1 HUD_GAUGES_A=perf-out/dev257-for-matt \
 *     HUD_GAUGES_A2=perf-out/dev257-noise HUD_GAUGES_B=perf-out/dev257-baseline \
 *     pnpm exec playwright test tests/e2e/hud-gauges-pixels.spec.ts -g "the arm is invisible"
 *
 * It takes no screenshots of its own — it reads the three the runs above
 * wrote. Separate because the baseline half needs a DIFFERENT CHECKOUT served,
 * which is not something a spec can arrange for itself.
 */
test.describe('@gpu DEV-257 — the arm is invisible with the flag down', () => {
  test.skip(process.env.HUD_GAUGES_GATE !== '1', 'set HUD_GAUGES_GATE=1 — see the header')

  test('the arm is invisible: A vs baseline is inside the A vs A noise floor', () => {
    const A = process.env.HUD_GAUGES_A ?? 'perf-out/dev257-for-matt'
    const A2 = process.env.HUD_GAUGES_A2 ?? 'perf-out/dev257-noise'
    const B = process.env.HUD_GAUGES_B ?? 'perf-out/dev257-baseline'
    // Inside the `it`, never above it: a `describe` body runs during
    // COLLECTION, and disk work up there throws where the files are absent —
    // which is CI, and only CI (CLAUDE.md, `describe.skipIf`).
    const marks = MARKS.map((at) => `off-${at}s-panel.png`)
    const lines: string[] = []
    for (const name of marks) {
      const a = fs.readFileSync(path.join(A, name))
      const a2 = fs.readFileSync(path.join(A2, name))
      const b = fs.readFileSync(path.join(B, name))
      const noise = comparePng(a, a2)
      const arm = comparePng(a, b)
      expect(noise, `${name}: the two control crops are different sizes`).not.toBeNull()
      expect(arm, `${name}: the arm and baseline crops are different sizes`).not.toBeNull()
      const n = noise as { mean: number; max: number; over: number }
      const g = arm as { mean: number; max: number; over: number }
      lines.push(
        `${name}\n  A vs A'  mean ${n.mean.toFixed(4)} max ${n.max} over24 ${(100 * n.over).toFixed(3)} %\n` +
          `  A vs B   mean ${g.mean.toFixed(4)} max ${g.max} over24 ${(100 * g.over).toFixed(3)} %`,
      )
      // The claim: taking the shot on the DEV-257 build with the arm down is
      // no more different from the pre-DEV-257 build than re-taking the same
      // shot is from itself. A margin of 1.5 on the mean and 1.5 on the
      // over-24 share, because the noise floor is itself one sample.
      expect(
        g.mean,
        `${name}: the arm-down build differs from the baseline by more than the noise`,
      ).toBeLessThanOrEqual(Math.max(n.mean * 1.5, n.mean + 0.5))
      expect(g.over, `${name}: too many pixels differ by more than 24 levels`).toBeLessThanOrEqual(
        Math.max(n.over * 1.5, n.over + 0.002),
      )
    }
    // eslint-disable-next-line no-console
    console.info(lines.join('\n'))
    fs.writeFileSync(path.join(A, 'gate.txt'), `${lines.join('\n')}\n`)
  })
})
