/**
 * tests/e2e/baked-rung-seat-photos.spec.ts — DEV-245. The same four rungs as
 * `baked-rung-photos.spec.ts`, photographed **from the pilot's eye**.
 *
 *   E2E_PORT=<yours> SEAT_PHOTO_DIR=perf-out/dev245 \
 *     SEAT_PHOTO_MISSION=adv_02_jumpSeat SEAT_PHOTO_AT=15,30,45 \
 *     pnpm exec playwright test tests/e2e/baked-rung-seat-photos.spec.ts \
 *       --workers 1 --retries 0
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * Matt, 2026-09-20, looking at wave 4's baked-light frames: *"it looks like the
 * tests aren't being run from eye-level."* He is right, and
 * `perf-protocol.md` §3f is the rule that came out of it: anything producing a
 * picture names its stand, and **if the subject is visible from the seat, the
 * seat is the stand.** `baked-rung-photos.spec.ts` shoots from `?view=cam`
 * free cameras 700–900 m up; `?view=cam` starts no flight, so there is no ship,
 * no cockpit, no HUD and no seat, and **a player never sees that view**.
 *
 * The cost side of the decision is settled and is not this spec's business:
 * VR-PERF-WAVE-4 §3.5 queue C has rung 3 at −0.70 / −0.97 ms and rung `split`
 * at −0.50 / −0.61 on `adv_02_jumpSeat`, and **both at nothing on the release
 * mission**, whose own arms sit inside their bracket. So the rung is now a
 * LOOK decision, and a look decision is made on frames that look like the game.
 *
 * ── The stand, and the three switches that make it one ───────────────────
 *
 * `?mission=<id>&autopilot=1` — the cockpit, flown by the same code a player
 * flies, which is `scoring-feedback-photos.spec.ts`'s and
 * `hud-upload-pixels.spec.ts`'s recipe. The eye is inside the canopy, the
 * ship's own body is in the near field, the HUD is a third of a metre away and
 * the horizon is where a flying human put it.
 *
 * `?snap=<s>` — the game's own freeze (`boot/snap.ts`: the same
 * `stepFixed`-with-zero-wall-time the pause menu uses, with no pause plate), so
 * all four arms are one world state seen from one camera. **It does not hold
 * everything**: the ocean's wave phase, the gate particles and the cockpit's
 * own render-clock motion run on wall time by design, which is exactly why
 * there is a control arm below.
 *
 * `?adaptive=0&quality=high` — **the tier, pinned, and then proved.** See
 * `fixtures/quality-pin.ts`: `render/quality.ts` drops a tier when the box is
 * starved, a tier drop moves MSAA, the framebuffer scale, the shadow map and
 * the prop LOD, and **all four are in a screenshot**. No screenshot spec in
 * this project carried the pin before DEV-245. Every shot here reads back the
 * tier, the sample count and the drawing buffer, and the run FAILS if any of
 * them moved between two arms — a run that drifted has photographed two builds
 * and none of its numbers mean anything.
 *
 * **NOT `?perf=1`.** §3f ties that switch to a MILLISECOND, and this produces a
 * PICTURE: the perf plate is a panel no player has on screen, it would occlude
 * part of the frame and it would put its own churning digits into every
 * statistic below. The briefing that commissioned this spec suggested `perf=1`;
 * this is the one thing in it that is deliberately not done, and the reason is
 * that a frame with an instrument in it is not a frame of the game. It is also
 * why the tier is read through `__ff2.render.quality.report` rather than
 * `__ff2perf`, which only exists under that switch — the same object, one
 * level down, with nothing added to the frame.
 *
 * ── The moment is SWEPT, not chosen ──────────────────────────────────────
 *
 * `SEAT_PHOTO_AT` is a LIST of mission seconds and each one is its own test on
 * its own page load, so the sweep and the shoot are the same run: every second
 * produces the four frames AND the numbers, and choosing the moment is reading
 * a table instead of trusting a guess. DEV-040 is the precedent — *when the
 * question is which way does this face, SWEEP IT* — and DEV-237 §4 is the cost
 * of not doing it, where five up-sun stands in a row would have sold a
 * confident, well-illustrated, wrong recommendation.
 *
 * What the sweep is looking for is named rather than eyeballed, because the two
 * things that separate the rungs are known:
 *
 *   (a) **the terrain's own cast shadow**, which rung 3 deletes outright;
 *   (b) **how a sunlit face reads INTO the sun**, where DEV-237's rung 1
 *       collapses to a silhouette because `diffuseColor.rgb * shadow` shadows
 *       the probe's irradiance as well as the sun's.
 *
 * Both are functions of where the nose is pointing relative to a sun **4° above
 * the horizon**, so every row prints `sunDeg` — the angle between the eye's
 * view direction and the direction to the sun, read off the LIVE directional
 * light and not off the level JSON (the sun is per-MISSION, CLAUDE.md). Small
 * is into the sun; large is up-sun with the light behind you.
 *
 * ── Five arms, and the fifth one is the whole of the reading ─────────────
 *
 *   off      the shipped build
 *   rung 1   the diffuse baked, the shadow multiply kept per fragment
 *   rung 3   the diffuse baked, everything else gone (DEV-232's measured arm)
 *   split    the diffuse baked APART, shadow on the direct half only (DEV-240)
 *   off      AGAIN — the CONTROL
 *
 * The sim is frozen and the render clock is not, so a pair of `off` frames
 * taken minutes apart is the noise floor of this whole measurement: the wave,
 * the particles, the tone-mapper's response to them. **Every statistic below is
 * printed for the control as well as for the arms, on the same pixels**, and an
 * arm is only distinguishable from the shipped build where it beats its own
 * run's control. Nothing is compared against a threshold typed in this file.
 *
 * ── What is reported, and why a mean alone would be wrong ────────────────
 *
 * Per arm, against the FIRST `off` frame:
 *
 *   mean      whole-frame mean absolute difference in levels of 255 — the
 *             quantity DEV-237's 2.07 / 33.9 and DEV-240's 0.97 / 2.97 are, so
 *             a seat row can be read straight against an aerial one
 *   moved     share of PIXELS past 24 levels on any channel (`maskFrom`)
 *   where     the mean over just those pixels: how strong the change is where
 *             it happens, as opposed to averaged over the sky
 *   blob      **the spatial statistic** — the largest 4-connected component of
 *             the moved mask, as a share of the frame (`blobStats`, DEV-245).
 *             DEV-241's trap has a second half: a mean cannot tell a seam from
 *             scattered noise, and neither can a moved share. A shadow that
 *             vanished down one flank and a drifting cloud that moved one pixel
 *             in a hundred are the same mean and the opposite finding.
 *
 * and then all four again **over a land mask**, because from the seat the land
 * is a minority of the frame and a whole-frame mean charges a terrain change
 * the noise of a sky and a sea that no rung touches (DEV-182, and
 * `png-diff.mjs`'s `--mask=` header).
 *
 * ── The land mask is DERIVED FROM A RENDER, and shot LAST ────────────────
 *
 * Not drawn by hand and not a rectangle: the terrain chunk meshes
 * (`chunk_x_z`, and `chunks_batch_N` after the fold) are made invisible and the
 * frame is shot again, so the mask is the pixels the baked surface actually
 * covers at this pose. That is `--mask=`'s own discipline — point it at a
 * render that changes ONLY the subject — and it has the same two properties
 * that header states: it is a LOWER BOUND on the subject's extent, and it
 * contains nothing that is not the subject.
 *
 * It is shot **after every arm**, and the visibility is put back and a further
 * frame taken to prove it came back, so nothing in the comparison can have been
 * taken through an instrument. DEV-241's mistake is the one being avoided: a
 * mask built from the frames it is then used to judge is definitional. This one
 * is built from a render none of the arms is.
 *
 * Tagged `@gpu`, and `?xr=off` so `isSessionSupported('immersive-vr')` does not
 * start this machine's OpenXR runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  blobStats,
  compareDecoded,
  type DecodedPng,
  decodePng,
  maskFrom,
} from '../../tools/perf/png-diff.mjs'
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
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.SEAT_PHOTO_DIR ?? 'perf-out/dev245'
const MISSION = process.env.SEAT_PHOTO_MISSION ?? 'adv_02_jumpSeat'
const EDITION = process.env.SEAT_PHOTO_EDITION ?? 'anniversary'

/** The mission seconds to sweep. One page load and one test each. */
const AT: number[] = (process.env.SEAT_PHOTO_AT ?? '15,30,45')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0)

/**
 * ONE WORN EYE, the way `perf-trace.spec.ts` and `hud-upload-pixels.spec.ts`
 * take it — a CSS viewport at half and a `deviceScaleFactor` of 2, because a
 * headed Chromium window cannot be 2016 px wide on this display and the backing
 * store is what matters. 2016 is wave 4's own per-eye figure, so a look
 * judgement taken here is taken at the pixel count every measurement in §3.5
 * was taken at, and the frame's aspect is the headset's own rather than a
 * monitor's.
 */
const EYE_PX = Number(process.env.SEAT_PHOTO_PX ?? '2016')
const DPR = 2

test.use({
  viewport: { width: Math.round(EYE_PX / DPR), height: Math.round(EYE_PX / DPR) },
  deviceScaleFactor: DPR,
})

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
  vertices: number
  directBytes: number
}

/** The arm, through the same route the within-run A-B-A takes. */
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

interface SeatPose {
  /** `mission.elapsed` at the freeze, in seconds. */
  readonly elapsed: number
  /** The eye, in WORLD space — `camera.position` is local in the cockpit. */
  readonly eye: readonly [number, number, number]
  /** Where it is looking, world space, unit. */
  readonly forward: readonly [number, number, number]
  /** Degrees between the view direction and the direction TO the sun. */
  readonly sunDeg: number
  /** The sun's own elevation above the horizon, degrees — 4 on simonet. */
  readonly sunElevationDeg: number
  /** How many terrain chunk meshes are in the scene and visible. */
  readonly chunks: number
}

/**
 * Where the eye is and what it is pointing at, from the LIVE transforms.
 *
 * The world eye is the camera's own `matrixWorld` translation and not
 * `camera.position`: in the cockpit the camera is a child of the XR rig, so
 * `camera.position` is the head pose INSIDE the rig — the origin until you lean
 * — while the rig carries the altitude (trap 18). Reading the local one is the
 * bug that put a pink line of fog across the terrain at eye level, and it is
 * invisible under `?view=cam`, where local and world are the same thing.
 *
 * The sun is read off the live directional light rather than out of
 * `content/levels/*.json`, for `draw-order-pixels.spec.ts`'s reason:
 * `applyLighting` sets `light.position` to minus the authored direction times
 * 10,000 with the target at the origin, so the light's own position IS the
 * bearing to the sun AFTER whatever the composition did to it.
 */
const seatPose = (page: Page): Promise<SeatPose> =>
  page.evaluate(() => {
    interface Node {
      name?: string
      visible?: boolean
      isDirectionalLight?: boolean
      position?: { x: number; y: number; z: number }
      matrixWorld?: { elements: number[] }
      updateMatrixWorld?: (force?: boolean) => void
      traverse?: (f: (o: Node) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2?: {
        render: { scene: Node; camera: Node }
        mission?: { elapsed?: number }
      }
    }
    const render = w.__ff2?.render
    if (!render) throw new Error('baked-rung-seat-photos: no __ff2.render')
    const camera = render.camera
    // `matrixWorld` is recomputed inside `render()` and this runs between
    // frames — the same staleness CLAUDE.md records for `grip.matrixWorld`.
    camera.updateMatrixWorld?.(true)
    const e = camera.matrixWorld?.elements ?? []
    const eye: [number, number, number] = [
      (e[12] as number) ?? 0,
      (e[13] as number) ?? 0,
      (e[14] as number) ?? 0,
    ]
    // three's camera looks down its own local -z, so the third basis column
    // negated is the world view direction. Read out of the matrix rather than
    // built from a quaternion: a basis column is true whatever the rig did.
    const fl = Math.hypot((e[8] as number) ?? 0, (e[9] as number) ?? 0, (e[10] as number) ?? 1) || 1
    const forward: [number, number, number] = [
      -((e[8] as number) ?? 0) / fl,
      -((e[9] as number) ?? 0) / fl,
      -((e[10] as number) ?? 1) / fl,
    ]

    let sx = 1
    let sy = 0
    let sz = 0
    let foundSun = false
    let chunks = 0
    render.scene.traverse?.((o) => {
      if (!foundSun && o.isDirectionalLight === true && o.position) {
        foundSun = true
        sx = o.position.x
        sy = o.position.y
        sz = o.position.z
      }
      const n = o.name ?? ''
      if ((/^chunk_-?\d+_-?\d+$/.test(n) || n.startsWith('chunks_batch_')) && o.visible !== false) {
        chunks++
      }
    })
    const sl = Math.hypot(sx, sy, sz) || 1
    const dot = Math.max(
      -1,
      Math.min(1, (forward[0] * sx + forward[1] * sy + forward[2] * sz) / sl),
    )
    return {
      elapsed: w.__ff2?.mission?.elapsed ?? 0,
      eye,
      forward,
      sunDeg: (Math.acos(dot) * 180) / Math.PI,
      sunElevationDeg: (Math.asin(Math.max(-1, Math.min(1, sy / sl))) * 180) / Math.PI,
      chunks,
    }
  })

/**
 * Show or hide the terrain CHUNK meshes, and say how many moved.
 *
 * The chunks and not `world-terrain`: the props and the dressing hang under
 * that group too (DEV-089) and no rung touches their materials, so hiding the
 * whole group would put props into a mask that claims to be the baked surface.
 * `chunk_x_z` is what `boot/render-census.ts`'s `rowKey` matches and
 * `chunks_batch_N` is what `render/chunk-batch.ts` names a folded band, so both
 * spellings are covered — and the count is returned so a mask taken over ZERO
 * hidden meshes is caught rather than silently being a mask of the noise.
 */
const setChunksVisible = (page: Page, visible: boolean): Promise<number> =>
  page.evaluate((show: boolean) => {
    interface Node {
      name?: string
      visible?: boolean
      traverse?: (f: (o: Node) => void) => void
    }
    const w = globalThis as unknown as { __ff2?: { render: { scene: Node } } }
    const scene = w.__ff2?.render.scene
    if (!scene) throw new Error('baked-rung-seat-photos: no scene')
    let moved = 0
    scene.traverse?.((o) => {
      const n = o.name ?? ''
      if (!/^chunk_-?\d+_-?\d+$/.test(n) && !n.startsWith('chunks_batch_')) return
      o.visible = show
      moved++
    })
    return moved
  }, visible)

/** One arm's numbers against `off`, whole-frame and over the land. */
interface ArmStats {
  readonly mean: number
  readonly movedShare: number
  readonly whereMean: number
  readonly blobShare: number
  readonly landMean: number
  readonly landMovedShare: number
  readonly landBlobShare: number
}

/**
 * Every statistic for one pair, whole-frame and restricted to `land`.
 *
 * `whereMean` is CONDITIONAL — the mean over the pixels that moved — and it is
 * labelled as such wherever it is printed, because conditioning on the
 * comparison is exactly the shape DEV-241 got caught by. It is safe here only
 * because the control pair is put through the identical conditioning, so the
 * two numbers are the same statistic of two different things rather than one
 * number and its own definition.
 */
const statsFor = (a: DecodedPng, b: DecodedPng, land: Uint8Array | null): ArmStats => {
  const whole = compareDecoded(a, b)
  const moved = maskFrom(a, b)
  if (!whole || !moved) throw new Error('baked-rung-seat-photos: the frames are not the same size')
  const blob = blobStats(moved.keep, a.w, a.h)
  const conditional = compareDecoded(a, b, moved.keep)
  const landMoved = land ? new Uint8Array(land.length) : null
  let landKept = 0
  let landMovedCount = 0
  if (land && landMoved) {
    for (let p = 0; p < land.length; p++) {
      if (!land[p]) continue
      landKept++
      if (moved.keep[p]) {
        landMoved[p] = 1
        landMovedCount++
      }
    }
  }
  const landWhole = land ? compareDecoded(a, b, land) : null
  const landBlob = landMoved ? blobStats(landMoved, a.w, a.h) : null
  return {
    mean: whole.mean,
    // `compareDecoded`'s `over` is a share of CHANNELS; `maskFrom`'s is of
    // PIXELS, and a pixel is what a person sees. Both exist; this is the one
    // printed, and saying which is half of DEV-027's rule.
    movedShare: moved.share,
    whereMean: moved.share > 0 ? (conditional?.mean ?? 0) : 0,
    blobShare: blob?.largestShare ?? 0,
    landMean: landWhole?.mean ?? 0,
    landMovedShare: landKept > 0 ? landMovedCount / landKept : 0,
    landBlobShare: landBlob?.largestShare ?? 0,
  }
}

const row = (label: string, s: ArmStats): string =>
  `${label.padEnd(9)} mean ${s.mean.toFixed(2).padStart(6)} · moved ` +
  `${(100 * s.movedShare).toFixed(2).padStart(6)} % · where ${s.whereMean.toFixed(1).padStart(5)} ` +
  `· blob ${(100 * s.blobShare).toFixed(2).padStart(6)} %  ||  LAND mean ` +
  `${s.landMean.toFixed(2).padStart(6)} · moved ${(100 * s.landMovedShare).toFixed(2).padStart(6)} ` +
  `% · blob ${(100 * s.landBlobShare).toFixed(2).padStart(6)} %`

/**
 * A page that puts the four arms SIDE BY SIDE with their numbers under them.
 *
 * Written beside the frames because that is the deliverable: *"a small set of
 * frames a person can look at and decide from, plus the numbers under them."*
 * A folder of seven PNGs and a log somewhere else is not that — somebody has
 * to build the comparison in their head, which is where a look decision goes
 * wrong. The sheet references the sibling files relatively, so the folder can
 * be zipped or dropped anywhere and still open.
 *
 * `summary.json` beside it holds the same numbers as data, for anything that
 * wants to read them back rather than look at them.
 */
const contactSheet = (
  title: string,
  pose: string,
  tier: string,
  landShare: number,
  arms: readonly { label: string; file: string; caption: string; stats: ArmStats | null }[],
): string => {
  const cell = (a: (typeof arms)[number]) => `    <figure>
      <img src="${a.file}" alt="${a.label}">
      <figcaption><b>${a.label}</b><br>${a.caption}</figcaption>
    </figure>`
  return `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #14161a; color: #d8dde3;
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.pose { margin: 0 0 20px; color: #8e99a6; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          gap: 20px; }
  figure { margin: 0; }
  img { width: 100%; display: block; background: #000; border: 1px solid #2a2f37; }
  figcaption { margin-top: 8px; color: #a9b3bf; font-size: 12px; }
  b { color: #f0f3f6; }
</style>
<h1>${title}</h1>
<p class="pose">${pose}<br>${tier}<br>land mask ${(100 * landShare).toFixed(1)} % of the frame</p>
<div class="grid">
${arms.map(cell).join('\n')}
</div>
`
}

test.describe('@measure @gpu DEV-245: the rungs from the pilot’s eye', () => {
  test.setTimeout(900_000)

  for (const at of AT) {
    test(`${MISSION} @ ${at}s: four rungs and a control, one seat`, async ({ page }, testInfo) => {
      const problems = watchPageErrors(page)
      const dir = path.join(OUT, `${MISSION}-t${at}`)
      fs.mkdirSync(dir, { recursive: true })

      await page.goto(
        `/?xr=off&ride=0&mission=${MISSION}&edition=${EDITION}&autopilot=1&snap=${at}&${PINNED}`,
      )
      await firstPress(page)
      await missionReady(page, 240_000)
      await focusCanvas(page)
      // The launch. The autopilot flies from here on the same code a player
      // does; holding Enter is what a player does to leave the elevator.
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
          { timeout: 300_000, intervals: [250] },
        )
        .toBe(true)
      // The render settles on the frozen state. The wave and the particles run
      // on wall time and a frame or two after the freeze is fine.
      await page.waitForTimeout(1_500)

      const pose = await seatPose(page)
      expect(pose.elapsed, 'the snap fired before the ship was flying').toBeGreaterThanOrEqual(at)
      expect(pose.chunks, 'no terrain chunks in the scene').toBeGreaterThan(0)
      console.info(
        `\n  ${MISSION} @ ${at}s — the seat\n` +
          `    eye ${pose.eye.map((n) => n.toFixed(0)).join(', ')} · ` +
          `looking ${pose.forward.map((n) => n.toFixed(2)).join(', ')}\n` +
          `    ${pose.sunDeg.toFixed(0)}° off the direction TO the sun ` +
          `(${pose.sunDeg < 60 ? 'INTO the sun' : pose.sunDeg > 120 ? 'up-sun, light behind' : 'the sun across'}` +
          `), sun ${pose.sunElevationDeg.toFixed(1)}° above the horizon · ` +
          `${pose.chunks} chunk meshes visible`,
      )

      // ── The tier, read at every shot and compared at the end ──────────
      //
      // The pin is in the URL above; this is the proof it held. Collected per
      // shot and asserted AFTER all of them, so a drift reports which shot it
      // happened on and what moved — rather than throwing on the second frame
      // and leaving the other three unshot, which is DEV-241's own mistake and
      // the one `hud-upload-pixels.spec.ts` had to be rewritten for.
      const tiers: { label: string; state: DrawState }[] = []

      const shoot = async (label: string): Promise<Buffer> => {
        const state = await drawState(page)
        tiers.push({ label, state })
        const shot = await page.locator('#viewport').screenshot()
        const file = path.join(dir, `${label}.png`)
        fs.writeFileSync(file, shot)
        await testInfo.attach(`${MISSION}-t${at}-${label}.png`, {
          body: shot,
          contentType: 'image/png',
        })
        return shot
      }

      const arm = async (label: string, on: boolean, want: Rung | null): Promise<Buffer> => {
        const report = await setArm(page, on, want ?? undefined)
        if (want === null) {
          expect(report.on, 'the OFF arm is baked').toBe(false)
          expect(report.defines, 'the OFF arm carries a define').toEqual([])
        } else {
          expect(report.on, `${label} did not reach the terrain`).toBe(true)
          expect(report.liveRung, `${label} is carrying another rung`).toBe(want)
          expect(report.baked, `${label} baked no chunk`).toBeGreaterThan(0)
        }
        expect(report.refusals, 'the bake was offered a geometry it could not use').toBe(0)
        // `needsUpdate` drops the program reference, so the first frame after an
        // arm moves is the compile.
        await page.waitForTimeout(1_500)
        return shoot(label)
      }

      const off0 = await arm('off', false, null)
      const rung1 = await arm('rung1', true, 1)
      const rung3 = await arm('rung3', true, 3)
      const split = await arm('split', true, 'split')
      // ...and back, so the run leaves the page as it found it AND the pair of
      // `off` frames is this reading's own noise floor.
      const off1 = await arm('off-control', false, null)
      const back = await setArm(page, false)
      expect(back.defines, 'the OFF arm did not come back').toEqual([])
      expect(back.directBytes, 'the split rung left its attribute behind').toBe(0)

      // ── THE LAND MASK, last, from a render ───────────────────────────
      const hidden = await setChunksVisible(page, false)
      expect(hidden, 'no chunk mesh answered to the hide').toBeGreaterThan(0)
      await page.waitForTimeout(700)
      const landless = await shoot('mask-no-land')
      const shown = await setChunksVisible(page, true)
      expect(shown, 'the chunks did not come back').toBe(hidden)
      await page.waitForTimeout(700)
      const off2 = await shoot('off-after-mask')

      // ── DID THE PIN HOLD? Before a single statistic is read ───────────
      //
      // A tier drop moves MSAA, the framebuffer scale, the shadow map and the
      // prop LOD, and every one of them is in the picture — so a run where it
      // moved has photographed two builds and none of the numbers below mean
      // anything. This throws rather than annotating, and it throws before the
      // comparison so nobody can read a table that a tier change wrote.
      const baseTier = tiers[0] as { label: string; state: DrawState }
      console.info(`    ${drawStateLine(baseTier.state)}  (at ${baseTier.label})`)
      const drifted = tiers.slice(1).flatMap(({ label, state }) => {
        const moved = drawStateDiff(baseTier.state, state)
        return moved.length > 0 ? [`${baseTier.label} -> ${label}: ${moved.join(', ')}`] : []
      })
      expect(
        drifted,
        'the quality tier MOVED between two shots of this pose, so the frames are of two ' +
          'different builds. `?adaptive=0&quality=high` is in the URL, so either the pin did ' +
          'not reach the runtime or something else on this box starved the frame ' +
          '(CLAUDE.md §3a-quater: an unquiet box does not mismeasure the build, it CHANGES it)',
      ).toEqual([])

      // Decoded ONCE: eleven pairs come off these seven frames and every decode
      // is a 2016 x 2016 zlib inflate plus five filters (`png-diff.mjs`).
      const px = {
        off0: decodePng(off0),
        rung1: decodePng(rung1),
        rung3: decodePng(rung3),
        split: decodePng(split),
        off1: decodePng(off1),
        off2: decodePng(off2),
        landless: decodePng(landless),
      }
      const land = maskFrom(px.off1, px.landless)
      expect(land, 'the mask render is a different size from the frames').not.toBeNull()
      const keep = land?.keep ?? null
      console.info(
        `    land mask ${(100 * (land?.share ?? 0)).toFixed(1)} % of the frame, ` +
          `from ${hidden} hidden chunk meshes`,
      )

      const rows: string[] = []
      const push = (label: string, s: ArmStats) => {
        const line = row(label, s)
        console.info(`    ${line}`)
        rows.push(line)
      }
      console.info(
        `\n    against the first OFF frame — mean/where are levels of 255, ` +
          `blob is the largest connected region`,
      )
      const s1 = statsFor(px.off0, px.rung1, keep)
      const s3 = statsFor(px.off0, px.rung3, keep)
      const sSplit = statsFor(px.off0, px.split, keep)
      const control = statsFor(px.off0, px.off1, keep)
      const controlB = statsFor(px.off1, px.off2, keep)
      push('rung1', s1)
      push('rung3', s3)
      push('split', sSplit)
      push('CONTROL', control)
      push('control2', controlB)

      // The verdict, stated per arm against the run's OWN control rather than
      // against a constant. `where` and `blob` are the two that say whether a
      // person could see it: a change spread thinly over the whole frame has a
      // big `moved` and a small `blob`, and the control has exactly that shape.
      for (const [label, s] of [
        ['rung1', s1],
        ['rung3', s3],
        ['split', sSplit],
      ] as const) {
        const verdict =
          s.landBlobShare > 4 * Math.max(control.landBlobShare, 1e-6) &&
          s.landMean > 2 * control.landMean
            ? 'VISIBLE on the land'
            : s.landMean > 2 * control.landMean
              ? 'measurable, but scattered — no region'
              : 'inside this run’s own noise'
        const line = `${MISSION} @ ${at}s, ${pose.sunDeg.toFixed(0)}° off-sun — ${label}: ${verdict}`
        console.info(`    ${line}`)
        testInfo.annotations.push({ type: 'dev-245', description: line })
      }
      for (const r of rows) testInfo.annotations.push({ type: 'dev-245', description: r })

      // ── The deliverable: the four arms side by side, with the numbers ──
      const poseLine =
        `${MISSION} @ ${at}s · eye ${pose.eye.map((n) => n.toFixed(0)).join(', ')} · ` +
        `${pose.sunDeg.toFixed(0)}° off the direction to the sun, which is ` +
        `${pose.sunElevationDeg.toFixed(1)}° above the horizon`
      const caption = (s: ArmStats | null) =>
        s === null
          ? 'the shipped build — every other frame is measured against this one'
          : `land ${s.landMean.toFixed(2)} levels of 255 · ` +
            `${(100 * s.landMovedShare).toFixed(1)} % of the land moved · ` +
            `largest region ${(100 * s.landBlobShare).toFixed(2)} % of frame`
      const sheet: {
        label: string
        file: string
        caption: string
        stats: ArmStats | null
      }[] = [
        { label: 'off — shipped', file: 'off.png', caption: caption(null), stats: null },
        { label: 'rung 1', file: 'rung1.png', caption: caption(s1), stats: s1 },
        { label: 'rung 3', file: 'rung3.png', caption: caption(s3), stats: s3 },
        { label: 'rung split', file: 'split.png', caption: caption(sSplit), stats: sSplit },
        {
          label: 'off again — THE CONTROL',
          file: 'off-control.png',
          caption: `${caption(control)} — this is the noise floor every row above is read against`,
          stats: control,
        },
      ]
      fs.writeFileSync(
        path.join(dir, 'contact.html'),
        contactSheet(
          `${MISSION} @ ${at}s — the baked-light rungs from the seat`,
          poseLine,
          drawStateLine(baseTier.state),
          land?.share ?? 0,
          sheet,
        ),
      )
      fs.writeFileSync(
        path.join(dir, 'summary.json'),
        `${JSON.stringify(
          {
            mission: MISSION,
            edition: EDITION,
            at,
            pose,
            tier: baseTier.state,
            landShare: land?.share ?? 0,
            arms: Object.fromEntries(sheet.map((a) => [a.label, a.stats])),
            control2: controlB,
          },
          null,
          2,
        )}\n`,
      )

      // A split or rung-1 shader that failed to compile lands here, and nowhere
      // else: a three program that does not link logs and draws the material
      // black. Asked BEFORE the skip below, which must not excuse it.
      expect(problems.list(), 'page errors — a failed shader compile lands here').toEqual([])

      // ── Does this frame hold anything the rungs disagree about? ─────────
      //
      // The two subjects that separate the rungs are named in the header: a
      // terrain CAST shadow, and a sunlit face read INTO the sun. A frame with
      // neither cannot rank them, and the comparison below would be a coin
      // toss. `adv_02_jumpSeat` at 45 s is that frame (2026-09-23): the nose
      // is on a sunlit wall with the sun 158° BEHIND the eye, and all three
      // rungs brighten it by the same 5.81 levels to three decimals.
      //
      // Decided from RUNG 1 ALONE, never from the split: a split shader broken
      // into a copy of rung 1 ties everywhere, and a guard on the tie would
      // skip every moment and never fail. Rung 1 moves 20 % and 43 % of the
      // land at 15 s and 30 s, and 0.16 % at 45 s; below 1 % it drew no region.
      test.skip(
        s1.landMovedShare < 0.01,
        `${MISSION} @ ${at}s: rung 1 moved ${(100 * s1.landMovedShare).toFixed(2)} % of the land ` +
          `(${pose.sunDeg.toFixed(0)}° off-sun), so this frame holds neither a cast shadow nor ` +
          `a face into the sun and cannot rank the rungs`,
      )

      // The one assertion about the ARMS, and it is DEV-240's: the split rung
      // sits nearer the shipped picture than rung 1 does. A comparison between
      // two frames of this same run, not a threshold — the only form that
      // cannot be voided by the clouds having moved. It held from 900 m; this
      // is whether it holds from the seat.
      expect(
        sSplit.landMean,
        `the split rung is further from the shipped build than rung 1 on the land ` +
          `(${sSplit.landMean.toFixed(2)} vs ${s1.landMean.toFixed(2)} levels)`,
      ).toBeLessThan(s1.landMean)
    })
  }
})
