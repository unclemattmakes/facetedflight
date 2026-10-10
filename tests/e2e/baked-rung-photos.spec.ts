/**
 * tests/e2e/baked-rung-photos.spec.ts — DEV-237's triptych, and DEV-240's
 * fourth frame.
 *
 * Matt has to choose a rung, and the two rungs differ in exactly one thing a
 * number cannot show: **whether the ground still takes shadows.**
 * `ANNIVERSARY.md` §1.5 ranks that second of the eight scale cues and
 * `render/shadows.ts` opens with *"a shadow's LENGTH is a ruler laid on the
 * ground"*, so this is a picture question wearing a millisecond's clothes.
 *
 * Four frames, one camera, one page load:
 *
 *   off      the shipped build — three's physical chain, shadows and all
 *   rung 1   the diffuse baked, the shadow multiply kept per fragment
 *   rung 3   the diffuse baked, everything else gone (DEV-232's measured arm)
 *   split    the diffuse baked APART, and the shadow on the direct half only
 *            (DEV-240)
 *
 * ── And the spec now PRINTS the number rather than leaving it to a tool ───
 *
 * DEV-237's 2.07 and 33.9 were computed afterwards, out of band, by pointing
 * `tools/perf/png-diff.mjs` at the folder. That worked and it hid the
 * comparison from the run that produced it: a reader of the log saw four file
 * paths and had to go and do the arithmetic to find out what the frames said.
 * Each arm's mean absolute difference from `off`, over the whole frame, in
 * levels of 255, is printed beside its path now. It is the same quantity, on
 * the same pixels, in the same units.
 *
 * ── Why ONE load and not three ────────────────────────────────────────────
 *
 * `?view=cam` pins the camera and `__ff2.bakedLight(on, rung)` moves the arm
 * without reloading, so the three frames are the same picture with one thing
 * changed. Three loads would be three terrain generations, three cloud seeds
 * and three ocean phases, and the diff would be about those.
 *
 * ── THE STAND IS AERIAL, AND THAT IS NOT WHERE THE DECISION IS MADE ───────
 *
 * Matt, 2026-09-20, on these very frames: *"it looks like the tests aren't
 * being run from eye-level."* He is right, and `perf-protocol.md` §3f is the
 * rule that came out of it — **if the subject is visible from the seat, the
 * seat is the stand.** The two stands below are free cameras 700–900 m up;
 * `?view=cam` starts no flight, so **there is no ship, no cockpit, no HUD and
 * no seat, and no player ever sees this view.**
 *
 * They are kept, and they are kept for one job: **look-dev**. A free camera
 * holds perfectly still, frames a chosen hillside, and puts the whole island's
 * relief in one picture — which is what made §4's finding legible at all, and
 * what makes the 44 %-of-frame shadow measurable. They are the right
 * instrument for *what does the shader do to a hillside*.
 *
 * They are **not** the frames the rung is chosen on.
 * `baked-rung-seat-photos.spec.ts` (DEV-245) is, and it shoots the same four
 * arms from the pilot's eye with the cockpit and the HUD in the frame, with
 * the moment picked by sweeping mission seconds rather than by taste. Read
 * these for the mechanism; read those for the decision.
 *
 * ── The tier is PINNED, and it was not until DEV-245 ──────────────────────
 *
 * `?adaptive=0&quality=high` (`fixtures/quality-pin.ts`), and every shot reads
 * the tier back. `render/quality.ts` drops a tier on a starved frame and a
 * tier drop moves MSAA, the framebuffer scale, the shadow map and the prop
 * LOD — all four visible in a screenshot. **DEV-237's and DEV-240's frames
 * were shot without this pin.** Their conclusions are rung-against-rung
 * comparisons taken inside one page load, which is the form least exposed to
 * it, but the absence is a fact about those frames and DEV-245's row records
 * it rather than leaving it to be rediscovered.
 *
 * ── WHAT THESE FRAMES FOUND, 2026-09-20 ──────────────────────────────────
 *
 * DEV-232 §4 says rung 1 **"loses only the view-dependent specular"**. It does
 * not, and the frames say so at a glance: on the `island-lit` stand rung 3 sits
 * **2.07 mean levels of 255** from the shipped build — the bake really is
 * lossless for the diffuse — and rung 1 sits **33.9 levels DARKER**.
 *
 * The cause is structural. **three multiplies a shadow into
 * `directLight.color` only**, so a shadowed hillside still receives the light
 * probe's irradiance, which is why shadowed ground in this game is pale rather
 * than black. A bake that has collapsed the direct and the indirect into one
 * vertex colour has nothing left to shadow half of, so `diffuseColor.rgb *
 * shadow` shadows the ambient too. Separated here rather than assumed: with
 * `render.sunHeight` switched off at the uniform, rung 1 moves by **4.2**
 * levels, so ~88 % of the darkening is `getShadow` applied to light three never
 * shadows (`separation/` beside the frames).
 *
 * Both stands are kept because together they say the shape of it: at `massif`
 * the camera is up-sun and most visible ground is lit, so rung 1 reads as a
 * long clean shadow across the flank and looks like the rung the plan
 * described; at `island-lit` the camera is into the sun, the whole face is
 * inside the shadow map, and rung 1 reads as a silhouette. **One stand alone
 * would have sold the wrong answer** — which is CLAUDE.md's agreement lesson,
 * arriving through a camera.
 *
 * ── What is NOT a fair difference, and must be read off these frames ──────
 *
 * The bake is EXACT for the diffuse (`render/baked-light.ts` says why), so
 * off → rung 3 ought to differ only by the shadows and the view-dependent
 * specular. It differs by one more thing, and DEV-232 named it before anyone
 * photographed it: **the illustrative Half-Lambert ramp is not baked.**
 * `render/illustrative.ts` replaces the direct-diffuse line inside
 * `lights_physical_pars_fragment`, which is upstream of this gate's anchor and
 * therefore dead under either rung — so both baked arms draw a plain Lambert
 * where Anniversary draws a Half-Lambert. That is a difference between the arms
 * and NOT part of the proposal; it is bakeable (the ramp has no view term) and
 * simply not done. Anyone reading these frames has to subtract it by eye, and
 * it is the same in rung 1 and rung 3 — so the rung-1-against-rung-3 comparison,
 * which is the one Matt is making, is clean.
 *
 * ── Running it ────────────────────────────────────────────────────────────
 *
 *   E2E_PORT=<n> PHOTO_DIR=perf-out/dev237 \
 *     pnpm exec playwright test tests/e2e/baked-rung-photos.spec.ts --workers 1 --retries 0
 *
 * `PHOTO_DIR` is outside `test-results/` on purpose: Playwright wipes that at
 * the start of every run, so a comparison shot across two runs loses half of
 * itself (CLAUDE.md).
 *
 * Tagged `@gpu`, and `?xr=off` so `isSessionSupported('immersive-vr')` does not
 * start this machine's OpenXR runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import {
  type DrawState,
  drawState,
  drawStateDiff,
  drawStateLine,
  PINNED,
} from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.PHOTO_DIR ?? 'test-results/dev237'
const MISSION = process.env.PHOTO_MISSION ?? 'adv_02_jumpSeat'
const EDITION = process.env.PHOTO_EDITION ?? 'anniversary'

type Vec = readonly [number, number, number]
const triple = (v: Vec) => v.map((n) => n.toFixed(1)).join(',')

/**
 * Where to stand.
 *
 * Chosen by SHOOTING, not by reasoning (CLAUDE.md, DEV-040): five candidate
 * stands were photographed on this mission before these two were kept.
 *
 * What is being photographed is **terrain casting onto terrain** — which on
 * this mission is the only cast shadow there is. `?view=cam` never starts a
 * flight, so there is no ship in the frame; a pad, a ring and a turn indicator
 * are all `'ring'` in `render/shadows.ts`'s table and cast nothing; and
 * Simonet's ONE live landmark (`Spire_B_w_Collision`, the only one of its
 * twenty-nine that survives the liveness walk — DEV-214) stands in open water,
 * so its shadow falls on a sea that keeps every term under either rung. That
 * leaves the island's own relief, which at a **4-degree sun** is the biggest
 * shadow in the game: DEV-115 measured the map darkening **44 % of the frame**
 * on this island at this elevation.
 */
const STANDS: { readonly name: string; readonly eye: Vec; readonly look: Vec }[] = [
  {
    // Up-sun and high, looking down the shadows' length across the massif's
    // flank, with two jump pads on the ground for scale.
    name: 'massif',
    eye: [200, 900, -2100],
    look: [700, 300, -1300],
  },
  {
    // DEV-115's own stand, kept because it is the one another row's numbers
    // were taken on — the massif with the sun across it.
    name: 'island-lit',
    eye: [1100, 700, -900],
    look: [522, 338, -1533],
  },
]

const ONLY = (process.env.PHOTO_STANDS ?? '').split(',').filter((s) => s.length > 0)

/** The rungs this spec shoots. DEV-240's is a NAME, not the next integer. */
type Rung = 1 | 3 | 'split'

interface Report {
  wanted: boolean
  on: boolean
  rung: Rung
  liveRung: Rung | null
  defines: string[]
  baked: number
  materials: number
  refusals: number
  /** DEV-240: what the split rung's second attribute costs, measured. */
  vertices: number
  directBytes: number
}

/** The arm, through the route a within-run A-B-A uses. */
const setArm = (page: Page, on: boolean, rung?: Rung): Promise<Report> =>
  page.evaluate(
    ({ on, rung }) => {
      const w = globalThis as unknown as {
        __ff2: { bakedLight: (on?: boolean, rung?: Rung) => unknown }
      }
      return w.__ff2.bakedLight(on, rung) as Report
    },
    { on, rung },
  )

/**
 * Mean absolute difference between two PNGs, over every colour channel of
 * every pixel, in levels of 255 — the quantity DEV-237's row quotes.
 *
 * Whole-frame and not masked, deliberately, because that is what the 2.07 and
 * the 33.9 already on record are and a number is only worth printing beside
 * them if it is the same number. (`tools/perf/png-diff.mjs --mask` is the
 * sharper instrument where the subject is a small part of the frame; here the
 * land fills most of both stands.)
 */
const meanLevels = (a: Buffer, b: Buffer): number => {
  const x = decodePngBuffer(a, 'a')
  const y = decodePngBuffer(b, 'b')
  if (x.width !== y.width || x.height !== y.height) {
    throw new Error(`frames differ in size: ${x.width}x${x.height} vs ${y.width}x${y.height}`)
  }
  let sum = 0
  const n = x.width * x.height
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(
        (x.data[i * x.channels + c] as number) - (y.data[i * y.channels + c] as number),
      )
    }
  }
  return sum / (n * 3)
}

test.describe('@measure @gpu DEV-237: off / rung 1 / rung 3', () => {
  test.setTimeout(900_000)

  for (const stand of STANDS) {
    test(`${stand.name}: four frames, one camera`, async ({ page }, testInfo) => {
      if (ONLY.length > 0 && !ONLY.includes(stand.name)) test.skip()
      const problems = watchPageErrors(page)
      fs.mkdirSync(OUT, { recursive: true })

      await page.goto(
        `/?xr=off&ride=0&mission=${MISSION}&edition=${EDITION}&${PINNED}` +
          `&view=cam&eye=${triple(stand.eye)}&look=${triple(stand.look)}`,
      )
      await firstPress(page)
      await missionReady(page, 240_000)
      // Long enough for the ocean's bob and the clouds to be in the same place
      // for all four frames — they are, because the sim keeps running and the
      // four shots are seconds apart, which is the one thing a same-load
      // comparison cannot pin. It does not matter here: nothing this row is
      // about is in the sky or on the water.
      await page.waitForTimeout(3_000)

      /** The OFF frame, kept so every arm's difference is against one image. */
      let reference: Buffer | null = null

      /**
       * What tier each shot was taken on — DEV-245.
       *
       * The pin is in the URL; this is the proof it held. Collected here and
       * asserted after every arm has been shot, so a drift says WHICH shot and
       * WHAT moved instead of ending the run on the second frame.
       */
      const tiers: { label: string; state: DrawState }[] = []

      const shoot = async (label: string, want: Rung | null, report: Report) => {
        // The arm reached the terrain's materials, or this is not a frame of
        // what it says it is. DEV-232's first A/B recorded sixty seconds for an
        // arm whose define never landed.
        if (want === null) {
          expect(report.on, 'the OFF arm is baked').toBe(false)
          expect(report.defines, 'the OFF arm carries a define').toEqual([])
        } else {
          expect(report.on, `${label} did not reach the terrain`).toBe(true)
          expect(report.liveRung, `${label} is carrying another rung`).toBe(want)
          expect(report.baked, `${label} baked no chunk`).toBeGreaterThan(0)
        }
        expect(report.refusals, 'the bake was offered a geometry it could not use').toBe(0)
        // A settle: `needsUpdate` drops the program reference, so the first
        // frame after an arm moves is the compile.
        await page.waitForTimeout(1_500)
        tiers.push({ label, state: await drawState(page) })
        const shot = await page.locator('#viewport').screenshot()
        const file = path.join(OUT, `${stand.name}-${label}.png`)
        fs.writeFileSync(file, shot)
        await testInfo.attach(`${stand.name}-${label}.png`, {
          body: shot,
          contentType: 'image/png',
        })
        if (reference === null) reference = shot
        // Mean absolute difference from the shipped build, in levels of 255 —
        // the same quantity DEV-237's 2.07 and 33.9 are, so the four rows of
        // this log can be read against that row without doing arithmetic.
        const delta = meanLevels(reference, shot)
        // DEV-240's price, from the geometry rather than from an estimate. Zero
        // at every rung but `split`, where the second attribute is live.
        const vram = report.directBytes / (1024 * 1024)
        console.info(
          `  ${stand.name}/${label.padEnd(6)} on=${String(report.on).padEnd(5)} ` +
            `live=${String(report.liveRung).padEnd(5)} baked=${String(report.baked).padStart(4)} ` +
            `vs off=${delta.toFixed(2).padStart(6)} levels  ` +
            `+${vram.toFixed(1)} MB (${report.vertices} verts) ` +
            `defines=[${report.defines.join(', ')}] -> ${file}`,
        )
        return delta
      }

      await shoot('off', null, await setArm(page, false))
      const rung1Delta = await shoot('rung1', 1, await setArm(page, true, 1))
      await shoot('rung3', 3, await setArm(page, true, 3))
      const splitDelta = await shoot('split', 'split', await setArm(page, true, 'split'))
      // ...and back, so the run leaves the page as it found it and a reader of
      // the log can see the bracket closed.
      const back = await setArm(page, false)
      expect(back.defines, 'the OFF arm did not come back').toEqual([])
      expect(back.directBytes, 'the split rung left its attribute behind').toBe(0)

      // ── DID THE PIN HOLD? DEV-245 ────────────────────────────────────
      //
      // Before the four deltas above are believed. A tier drop moves MSAA, the
      // framebuffer scale, the shadow map and the prop LOD, so a run where it
      // moved has photographed two builds. This spec ran WITHOUT the pin for
      // DEV-237's and DEV-240's frames; their conclusions rest on
      // rung-against-rung comparisons taken inside one page load and I do not
      // believe they move, but nothing in either row knows the pin was absent,
      // and the ledger says so.
      const baseTier = tiers[0] as { label: string; state: DrawState }
      console.info(`  ${stand.name} ${drawStateLine(baseTier.state)}  (at ${baseTier.label})`)
      expect(
        tiers.slice(1).flatMap(({ label, state }) => {
          const moved = drawStateDiff(baseTier.state, state)
          return moved.length > 0 ? [`${baseTier.label} -> ${label}: ${moved.join(', ')}`] : []
        }),
        'the quality tier MOVED between two shots of this stand, so the frames are of two ' +
          'different builds and the deltas above are not about the rung ' +
          '(CLAUDE.md §3a-quater: an unquiet box does not mismeasure the build, it CHANGES it)',
      ).toEqual([])

      // The one assertion, and it is the whole of DEV-240: the split rung sits
      // NEARER the shipped picture than rung 1 does. Not a threshold — a
      // comparison between two frames of this same run, which is the only form
      // that cannot be voided by the clouds having moved. Rung 1 sits 33.9
      // levels out at `island-lit` because it shadows the ambient too; the
      // split rung is built to sit where rung 3 sits. If it ever came back on
      // the wrong side of rung 1, the split is not doing what its name says.
      expect(
        splitDelta,
        'the split rung is further from the shipped build than rung 1 ' +
          `(${splitDelta.toFixed(2)} vs ${rung1Delta.toFixed(2)} levels)`,
      ).toBeLessThan(rung1Delta)

      // A split or rung-1 shader that failed to compile lands here, and nowhere
      // else: a three program that does not link logs and draws the material
      // black.
      expect(problems.list(), 'page errors — a failed shader compile lands here').toEqual([])
    })
  }
})
