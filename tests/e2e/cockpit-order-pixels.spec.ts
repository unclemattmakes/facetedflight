/**
 * tests/e2e/cockpit-order-pixels.spec.ts — DEV-246. Drawing the vehicle FIRST
 * moves submission order and nothing else, photographed.
 *
 *   E2E_PORT=<yours> PHOTO_DIR=perf-out/dev246 \
 *     pnpm exec playwright test tests/e2e/cockpit-order-pixels.spec.ts --workers 1 --retries 0
 *
 * ── Why a picture, when the depth argument looks airtight ───────────────
 *
 * Because DEV-241 §6 is the row that says *"and not a pixel moved" was an
 * argument, not an observation* — and this is the same class of change it was
 * written about: the same draws, the same triangles, the same programs, in a
 * different sequence. The argument here is that every mesh the pin moves is
 * opaque, writes depth and depth-tests, so the depth buffer resolves the frame
 * identically whichever order it is filled in; and the one thing that argument
 * cannot cover is a TIE, where two surfaces at the same depth are resolved by
 * who drew last. Ties are what this spec is for.
 *
 * ── The stand is the COCKPIT, and that is the whole point ───────────────
 *
 * `draw-order-pixels.spec.ts` shoots from 4 km up, which is the right stand
 * for the sea and the dome and is exactly the wrong one here: the vehicle is a
 * speck or off-screen, and an arm that cannot reach the frame reads as an arm
 * that changed nothing (the failure mode `xr-vrto3d-trace.spec.ts`'s SOLO
 * comment calls rule 1). So this one flies to `?snap=20` and photographs the
 * frame a player is actually in, with the pilot's body, the seat and the
 * control stick filling the near field — the twenty-one draws DEV-246 moves.
 *
 * A second stand presses **V** for the exterior view, which is the other frame
 * with pinned vehicle geometry in it and the only one where the hull is at ten
 * metres instead of half of one. Held, not tapped: `view-toggle-compile.spec
 * .ts` found that a `press()` can fall entirely between two frames.
 *
 * ── THE TIER IS PINNED, and that is not boilerplate ─────────────────────
 *
 * `render/quality.ts` measures the frame and drops a tier when the CPU is
 * starved, and a tier drop moves MSAA, the framebuffer scale, the shadow map
 * (`shadows.ts:502` turns them off at `low`) and the terrain detail ring
 * (`detail-ring.ts:56` returns null at `low`) — every one of them visible in a
 * screenshot, and the last two visible in a DRAW COUNT. On a box with another
 * session on it that is not a mismeasured build, it is a different one
 * (CLAUDE.md, perf-protocol §3a-quater). So `?adaptive=0&quality=high` is
 * pinned, and the live tier, the pixel ratio, the drawing-buffer size and the
 * context's `antialias` are read at EVERY shot and asserted identical across
 * the whole bracket. A tier that moved fails the run rather than quietly
 * producing a different picture.
 *
 * ── Zero is not on offer, so every arm is bracketed ─────────────────────
 *
 * `?snap=` freezes the SIM and not the frame: the wave and the cloud drift run
 * on RENDER time (`app.ts`'s `setWaveTime(time / 1000)`). Two shots of the same
 * build seconds apart differ. So the shape is **A · arm · A · arm · A**, the
 * quiet mask comes from the WIDEST bracket (first shipped shot against last),
 * and both counts are measured over it so neither is definitional — DEV-241
 * §6b is the record of the version that got that wrong and of the negative
 * control that caught it in one run.
 *
 * ── And there IS a negative control ─────────────────────────────────────
 *
 * `adv_02_jumpSeat`. Its whole group was already the head of the colour pass
 * before DEV-246, so the arm there provably does not move the sequence
 * (`draw-order-cockpit.spec.ts` asserts exactly that) — and it must therefore
 * read like a control. An arm that provably does nothing and produces a
 * non-zero reading tells you the reading is the instrument, which is how
 * DEV-241's first version was caught.
 */
import fs from 'node:fs'
import path from 'node:path'
import { comparePng, decodePng } from '../../tools/perf/png-diff.mjs'
import { flyToFreeze, hold } from './fixtures/freeze'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.PHOTO_DIR ?? 'perf-out/dev246'
const EDITION = process.env.PHOTO_EDITION ?? 'anniversary'

/**
 * `int_01_hoverJet` is the arm: the release mission, and the one where the
 * cockpit interior's twenty-one draws used to land after the whole island.
 * `adv_02_jumpSeat` is the NEGATIVE CONTROL — already first, so the arm cannot
 * move it — and it has only the cockpit stand, because the JumpSeat has no
 * exterior mesh to press V for (`jumpseat-flight.ts`).
 */
const MISSIONS = [
  { id: 'int_01_hoverJet', third: true, why: 'the RELEASE mission — the arm' },
  { id: 'adv_02_jumpSeat', third: false, why: 'already first — the NEGATIVE CONTROL' },
] as const

/**
 * Everything a tier drop would move, read in one call.
 *
 * Off `__ff2.render`, and NOT off `__ff2perf`, which would have been the
 * obvious reach and is the one thing this spec must not do: the perf surface
 * exists only under `?perf=1` (`app.ts`'s `PERF_HUD ? createPerfSurface(…) :
 * null`), and `?perf=1` draws a PERF PLATE — pixels, in the frame being
 * photographed. An instrument that adds a rectangle to the picture cannot
 * guard the picture. The first version of this spec reached for it and got
 * `null` on every mission, which is the honest failure and the reason this
 * note exists.
 *
 * `scale` is `ADAPTIVE_STEPS[stepIndex]`, so a controller that stepped shows
 * up here even though the adaptive SETTING itself is behind that surface. The
 * pin is asserted through its consequence rather than through its flag: the
 * rig is identical at every shot in the bracket, or the run fails.
 */
interface Rig {
  readonly quality: string
  readonly scale: number
  readonly pixelRatio: number | null
  readonly antialias: boolean
  readonly width: number
  readonly height: number
}

const rigOf = (page: Page): Promise<Rig | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        render: {
          quality: { report: { quality: string; scale: number; pixelRatio: number | null } }
          renderer: {
            domElement: { width: number; height: number }
            getContext: () => { getContextAttributes: () => { antialias?: boolean } | null }
          }
        }
      }
    }
    const r = w.__ff2?.render
    if (!r) return null
    const q = r.quality.report
    return {
      quality: q.quality,
      scale: q.scale,
      pixelRatio: q.pixelRatio,
      antialias: r.renderer.getContext().getContextAttributes()?.antialias === true,
      width: r.renderer.domElement.width,
      height: r.renderer.domElement.height,
    }
  }) as Promise<Rig | null>

const rigKey = (r: Rig): string =>
  `${r.quality}/scale=${r.scale}/dpr=${r.pixelRatio}/aa=${r.antialias}/${r.width}x${r.height}`

interface SwitchReport {
  which: string
  moved: number
  seen: number
  skipped: number
  on: boolean
}

const setSwitch = (page: Page, on: boolean): Promise<SwitchReport | null> =>
  page.evaluate((o) => {
    const g = globalThis as unknown as {
      __ff2?: { drawOrderSwitch?: (which: string, on?: boolean) => SwitchReport }
    }
    return g.__ff2?.drawOrderSwitch?.('cockpit', o as boolean) ?? null
  }, on)

/** Pixels where `a` and `b` agree on every channel to within 24 levels. */
const stableMask = (a: Buffer, b: Buffer): { keep: Uint8Array; share: number } | null => {
  const x = decodePng(a)
  const y = decodePng(b)
  if (x.w !== y.w || x.h !== y.h) return null
  const n = x.w * x.h
  const keep = new Uint8Array(n)
  let kept = 0
  const rgb = Math.min(3, x.ch, y.ch)
  for (let p = 0; p < n; p++) {
    let same = true
    for (let k = 0; k < rgb; k++) {
      if (Math.abs((x.data[p * x.ch + k] as number) - (y.data[p * y.ch + k] as number)) > 24) {
        same = false
        break
      }
    }
    if (same) {
      keep[p] = 1
      kept++
    }
  }
  return { keep, share: kept / n }
}

/**
 * How many pixels of `mask` moved by more than 24 levels on any channel — a
 * count of PIXELS, not of channel samples (`comparePng`'s `over` is the
 * latter, and saying which is which is DEV-027's rule).
 *
 * Throws on a size mismatch rather than returning 0: an out-of-range read
 * gives `undefined`, `Math.abs(NaN) > 24` is false, and the function would
 * report *"nothing moved"*, which is this spec's PASS. A guard whose failure
 * mode is a pass is not a guard.
 */
const pixelsMoved = (a: Buffer, b: Buffer, mask: Uint8Array): number => {
  const x = decodePng(a)
  const y = decodePng(b)
  if (x.w !== y.w || x.h !== y.h) {
    throw new Error(`cockpit-order-pixels: ${x.w}x${x.h} against ${y.w}x${y.h} — the window moved`)
  }
  let moved = 0
  const rgb = Math.min(3, x.ch, y.ch)
  for (let p = 0; p < x.w * x.h; p++) {
    if (!mask[p]) continue
    for (let k = 0; k < rgb; k++) {
      if (Math.abs((x.data[p * x.ch + k] as number) - (y.data[p * y.ch + k] as number)) > 24) {
        moved++
        break
      }
    }
  }
  return moved
}

/**
 * The longest HORIZONTAL run of consecutive changed pixels inside the mask.
 *
 * A mean cannot tell a seam from the same number of scattered pixels, and the
 * failure this spec is looking for has a shape: a depth TIE between the
 * cockpit and the world would resolve one way in one arm and the other way in
 * the other, over a whole surface — an EDGE, which is a run the width of the
 * feature. Scatter from the drifting sea is tens of pixels; a surface flipping
 * is hundreds. DEV-241 §6 derived the same statistic for the same reason and
 * measured the worst control run in its own corpus at 81 px of 1280.
 */
const longestRun = (a: Buffer, b: Buffer, mask: Uint8Array): number => {
  const x = decodePng(a)
  const y = decodePng(b)
  if (x.w !== y.w || x.h !== y.h) {
    throw new Error(`cockpit-order-pixels: ${x.w}x${x.h} against ${y.w}x${y.h} — the window moved`)
  }
  const rgb = Math.min(3, x.ch, y.ch)
  let best = 0
  for (let row = 0; row < x.h; row++) {
    let run = 0
    for (let col = 0; col < x.w; col++) {
      const p = row * x.w + col
      let on = false
      if (mask[p] === 1) {
        for (let k = 0; k < rgb; k++) {
          if (Math.abs((x.data[p * x.ch + k] as number) - (y.data[p * y.ch + k] as number)) > 24) {
            on = true
            break
          }
        }
      }
      if (on) {
        run++
        if (run > best) best = run
      } else {
        run = 0
      }
    }
  }
  return best
}

/** A tie flipping spans its surface. A quarter of the frame is DEV-241's bar. */
const SEAM_SHARE_OF_WIDTH = 0.25

test.describe('@gpu DEV-246 — the cockpit pin moves no pixel', () => {
  test.setTimeout(900_000)

  for (const mission of MISSIONS) {
    test(`${mission.id}: the arm against its own control`, async ({ page }, testInfo) => {
      const problems = watchPageErrors(page)
      fs.mkdirSync(OUT, { recursive: true })
      const verdicts: {
        stand: string
        mean: number
        controlMean: number
        moved: number
        movedControl: number
        runPair: number
        runControl: number
        verdict: string
      }[] = []

      // The real cockpit, not `?view=cam`: the whole question is whether the
      // near field changed, and `?view=cam` puts the camera where the vehicle
      // is not. The tier pins go in as query parameters so they are in force
      // from the first frame rather than applied after one.
      await flyToFreeze(page, {
        mission: mission.id,
        edition: EDITION,
        snapAt: 20,
        params: { adaptive: '0', quality: 'high' },
      })

      const rig0 = await rigOf(page)
      expect(
        rig0,
        'no __ff2perf.quality() / __ff2.render.renderer to read the tier from',
      ).not.toBeNull()
      const wanted = rigKey(rig0 as Rig)
      console.info(`\n  ${mission.id} — ${mission.why}\n  rig ${wanted}`)
      expect(
        (rig0 as Rig).quality,
        '?quality=high did not reach the runtime — every shot below would be at whatever ' +
          'tier the controller happened to pick, and a tier moves MSAA, the framebuffer ' +
          'scale, the shadow map and the detail ring',
      ).toBe('high')
      // `?adaptive=0`'s CONSEQUENCE. The setting itself lives behind `?perf=1`
      // and reading it would put a plate in the picture; what a photograph
      // needs is that the resolution held, and that is `scale`.
      expect(
        (rig0 as Rig).scale,
        'the adaptive controller has already stepped the resolution down — ?adaptive=0 did ' +
          'not reach the runtime, and the shots below would be taken at a moving pixel count',
      ).toBe(1)

      const stands = mission.third ? (['cockpit', 'third-person'] as const) : (['cockpit'] as const)

      for (const stand of stands) {
        if (stand === 'third-person') {
          // V is the flat binding, HELD for 200 ms — `view-toggle-compile
          // .spec.ts` found that a tap can fall between two frames. The toggle
          // fades (0.12 s out, 0.25 s in), so the wait is not padding.
          await hold(page, 'v')
          await page.waitForTimeout(3_000)
        }

        const shoot = async (label: string): Promise<Buffer> => {
          // The rig, at every single shot. A tier that moved mid-bracket would
          // change MSAA and the framebuffer scale, and the resulting diff
          // would be attributed to the arm.
          const rig = await rigOf(page)
          expect(
            rig ? rigKey(rig) : 'none',
            `the render rig moved before the ${label} shot on the ${stand} stand — the tier ` +
              'controller dropped a step, so this comparison is between two builds and not ' +
              'between two orders',
          ).toBe(wanted)
          const shot = await page.locator('#viewport').screenshot()
          const file = path.join(OUT, `${mission.id}-${stand}-${label}.png`)
          fs.writeFileSync(file, shot)
          await testInfo.attach(`${mission.id}-${stand}-${label}.png`, {
            body: shot,
            contentType: 'image/png',
          })
          return shot
        }

        // A0 — the shipped frame, ASSERTED rather than assumed: a page already
        // armed would make every number below a comparison between two arms.
        const on = await setSwitch(page, true)
        expect(on?.on, 'the cockpit default is not in force on the A frame').toBe(true)
        expect(
          on?.seen,
          'ARM DID NOT FIRE: the cockpit switch owns no mesh on this stand, so it could not ' +
            'have changed the picture and a clean result here means nothing',
        ).toBeGreaterThan(0)
        await page.waitForTimeout(1_200)

        const a0 = await shoot('A0-shipped')
        await page.waitForTimeout(1_800)
        const a1 = await shoot('A1-shipped')

        const off = await setSwitch(page, false)
        expect(off?.on).toBe(false)
        expect(off?.moved, 'the OFF arm moved no mesh, so it was already off').toBeGreaterThan(0)
        await page.waitForTimeout(1_800)
        const armed = await shoot('cockpit-late')

        await setSwitch(page, true)
        await page.waitForTimeout(1_800)
        const a2 = await shoot('A2-shipped')

        // The mask from the WIDEST bracket, and both counts taken over it, so
        // neither is definitional (DEV-241 §6b).
        const mask = stableMask(a0, a2)
        expect(mask, 'the shipped shots are different sizes — the window moved').not.toBeNull()
        const keep = mask?.keep as Uint8Array
        const pair = comparePng(a1, armed)
        const control = comparePng(a0, a1)
        const movedPair = pixelsMoved(a1, armed, keep)
        const movedControl = pixelsMoved(a0, a1, keep)
        const runPair = longestRun(a1, armed, keep)
        const runControl = longestRun(a0, a1, keep)
        const width = decodePng(a0).w
        const seam = runPair > width * SEAM_SHARE_OF_WIDTH
        const verdict = seam
          ? 'SEAM'
          : pair && control && pair.mean > control.mean * 1.5
            ? 'DIFFERS'
            : 'inside the noise'
        console.info(
          `  ${stand}: quiet mask ${(100 * (mask?.share ?? 0)).toFixed(1)} % of the frame\n` +
            `    cockpit LATE (${off?.moved}/${off?.seen} moved, ${off?.skipped} skipped): ` +
            `mean ${pair?.mean.toFixed(2)} vs control ${control?.mean.toFixed(2)}` +
            `  ·  quiet px ${movedPair} vs ${movedControl}` +
            `  ·  run ${runPair} vs ${runControl} of ${width}  ·  ${verdict}`,
        )
        // A mask that kept almost nothing would let the arm pass whatever it
        // did. That is a real answer about the stand, so it fails loudly
        // rather than reading as a clean result.
        expect(
          mask?.share ?? 0,
          'two same-build frames agree on less than a fifth of this stand — there is nothing ' +
            'quiet enough here to judge an arm against',
        ).toBeGreaterThan(0.2)
        verdicts.push({
          stand,
          mean: pair?.mean ?? Number.NaN,
          controlMean: control?.mean ?? Number.NaN,
          moved: movedPair,
          movedControl,
          runPair,
          runControl,
          verdict,
        })
      }

      // Every stand printed BEFORE anything is judged. DEV-241's first run
      // threw inside the loop and never reached the stand the change was
      // aimed at.
      const bad = verdicts.filter((v) => v.verdict !== 'inside the noise')
      expect(
        bad.map(
          (v) =>
            `${mission.id}/${v.stand}: ${v.verdict} — mean ${v.mean.toFixed(2)} vs ` +
            `${v.controlMean.toFixed(2)}, longest run ${v.runPair} vs ${v.runControl}`,
        ),
        'the cockpit pin moved the frame further than two runs of the same build move it, or ' +
          'drew a LINE where the control draws scatter. Submission order is the only thing ' +
          'this switch changes and every mesh it moves is opaque, depth-writing and ' +
          'depth-testing — so a difference is a depth TIE nobody accounted for, and the ' +
          'picture is the thing to look at before the ledger row.',
      ).toEqual([])

      expect(problems.list(), 'page errors').toEqual([])
    })
  }
})
