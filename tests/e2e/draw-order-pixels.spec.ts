/**
 * tests/e2e/draw-order-pixels.spec.ts — DEV-241. The two order defaults move
 * SUBMISSION ORDER and nothing else, photographed.
 *
 *   E2E_PORT=<yours> PHOTO_DIR=perf-out/dev241 \
 *     pnpm exec playwright test tests/e2e/draw-order-pixels.spec.ts --workers 1 --retries 0
 *
 * ── The claim, and why a picture is the only thing that can settle it ────
 *
 * Wave 4 §3.5 measured both switches as savings and wrote *"and not a pixel
 * moved"*. That sentence was an argument, not an observation. It rests on two
 * depth facts — the sea is opaque with `depthWrite` and `depthTest` on either
 * way, and the dome at `z = w` with `depthWrite` off passes `LEQUAL` only where
 * the buffer is still at its cleared 1.0 — and both are true and neither is a
 * measurement. A reorder is precisely the class of change that is invisible to
 * every count this project owns: the same draws, the same triangles, the same
 * programs, in a different sequence. `tests/e2e/draw-order.spec.ts` proves the
 * sequence moved. This proves the frame did not.
 *
 * ── Why there is a CONTROL, and why "zero pixels" is not on offer ────────
 *
 * `?snap=` freezes the SIM. It does not freeze this frame. The wave and the
 * cloud drift run on RENDER time — `boot/app.ts`'s `setWaveTime(time / 1000)`,
 * and `boot/snap.ts`'s own caveat says so — and under `?view=cam` there is no
 * flight for `?snap=` to freeze in the first place (`resolveViewpoint` returns
 * a viewpoint, `wantsFly` goes false, the mission clock never reaches the
 * mark). So two shots of the SAME build, seconds apart, differ: the sea has
 * heaved and the clouds have moved. `tools/perf/png-diff.mjs`'s header is the
 * record of somebody finding that out the expensive way — 60 % of a frame
 * "regressed" and the same build against itself said the same thing.
 *
 * So every arm is bracketed: **A · arm · A · arm · A · arm · A**, a shipped
 * shot between every one, each pair separated by exactly the same settle.
 * `A_k → arm` and `A_k → A_k+1` are then the same interval of the same moving
 * frame, one with the arm in it and one without, and the verdict is
 * png-diff's own: **a pair is evidence only when it moves the frame more than
 * 1.5x what two runs of the same build move it.**
 *
 * ── THE FIRST VERSION OF THIS SPEC WAS WRONG, AND ITS OWN CONTROL SAID SO ─
 *
 * It shot A1, the three arms, then A2; built a mask from the pixels where
 * `|A1 - A2| <= 24`; asserted the arm moved **zero** pixels inside it; and
 * guarded the mask with `expect(controlMoved).toBe(0)`. **That guard cannot
 * fail.** The mask is DEFINED as the pixels where A1 and A2 agree, so the
 * control's count inside it is zero by construction — the comment said as much
 * and then used it as evidence. The arm's count is not zero by construction at
 * all: a pixel moving 23 levels between A1 and A2 is inside the mask and can
 * move 25 between A1 and the arm, because the arm is a different instant of a
 * frame that is still moving. The number being asserted was a count of pixels
 * straddling a threshold, not a difference.
 *
 * **`int_02_hoverJet` is why that was caught in one run.** Alpine has no water
 * terrain, so `no-ocean-order` there changes nothing whatsoever — and it read
 * 23 moved pixels. An arm that provably did nothing produced a non-zero
 * number, so the number was the instrument. The negative control earned its
 * place before it had measured anything about the change.
 *
 * The quiet mask survives, with a smaller job: it comes from the WIDEST
 * bracket (the first shipped shot against the last), it is the most
 * conservative claim available about which pixels are not moving on their own,
 * and BOTH counts are then taken over it — so neither is definitional. A
 * derived number needs an extracted one's provenance (DEV-027): the mask is
 * the set of pixels two same-build frames agree on to within 24 levels, and
 * the share of the frame it keeps is printed, so a mask that found nothing
 * cannot pass as a mask that found nothing wrong.
 *
 * ── Where to stand, derived rather than believed ─────────────────────────
 *
 * Four missions across three environments, and only one of them (Simonet) has
 * ever been photographed by this port. DEV-041's lesson is the rule the stands
 * follow: **prefer a placement that cannot be wrong over a score that is
 * usually right.** Both are computed in the page from the live terrain's own
 * bounding box:
 *
 *   `over-land`   above the world's highest point, looking diagonally across
 *                 it at the far edge. Land in the near field, sea beyond it
 *                 where there is one, horizon and sky above. This is the
 *                 frame the ocean's order could change, because it is the one
 *                 where the island is in front of the sea.
 *   `horizon`     at the same height over the middle, looking LEVEL along the
 *                 mission's own sun bearing. Sky, clouds and `horizon-geo`
 *                 fill it, which is the frame the dome's far-plane pin could
 *                 change — and the clouds sit at real world positions while
 *                 the dome is now pinned at the far plane, so if the pin ever
 *                 put the sky in FRONT of a cloud this is where it shows.
 *
 * Above everything in both cases, so occlusion is impossible rather than
 * unlikely. `PHOTO_STANDS=int_01_hoverJet/horizon` shoots one of them; the
 * stands themselves are not overridable on purpose, because a stand somebody
 * typed in is a stand that can be wrong on the three environments nobody has
 * looked at.
 *
 * ── The arms ─────────────────────────────────────────────────────────────
 *
 * `__ff2.drawOrderSwitch(which, false)` — the OFF arm, which is the
 * pre-DEV-241 frame. The two are thrown together and separately, because the
 * sky's is the one that can leave a seam and the sea's is the one that cannot,
 * and a combined-only reading could not tell which had.
 *
 * **The sky arm COMPILES.** Removing `FF2_SKY_FAR_PIN` is a program key with
 * no warmed variant (DEV-177(b)), so every shot waits after the switch moves.
 * A black dome would land in `page.on('pageerror')` and in the numbers alike.
 *
 * Tagged `@gpu`, `?xr=off` so `isSessionSupported('immersive-vr')` does not
 * start this machine's OpenXR runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import { comparePng, decodePng } from '../../tools/perf/png-diff.mjs'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.PHOTO_DIR ?? 'perf-out/dev241'
const EDITION = process.env.PHOTO_EDITION ?? 'anniversary'
/** Only these stands, comma separated — `PHOTO_STANDS=int_01_hoverJet/horizon`. */
const ONLY = (process.env.PHOTO_STANDS ?? '').split(',').filter((s) => s.length > 0)

type Vec = readonly [number, number, number]

/**
 * The four missions, and every one of them is here for a reason a count cannot
 * supply.
 *
 * `adv_02_jumpSeat` is where both order arms were measured (queue D) and where
 * the ocean's −0.46 ms lives. `int_01_hoverJet` is the RELEASE mission and the
 * one where the ocean order measured a wash — same environment, different line,
 * which is the pair that says the ocean lever is mission-shaped rather than
 * environment-shaped. `hoverJet_kauai_beg` is the second island, the other half
 * of the ocean's evidence (−0.19). `int_02_hoverJet` is alpine and **has no
 * ocean at all** — the negative control, where the sea arm must reach nothing
 * and the sky arm must still work, because the sky's saving does not need water
 * and the whole argument for making it a default rests on that.
 */
const MISSIONS = [
  { id: 'adv_02_jumpSeat', hasOcean: true, why: 'queue D’s own mission — simonet' },
  { id: 'int_01_hoverJet', hasOcean: true, why: 'the RELEASE mission — simonet' },
  { id: 'hoverJet_kauai_beg', hasOcean: true, why: 'the second island — kauai' },
  { id: 'int_02_hoverJet', hasOcean: false, why: 'alpine, and alpine has NO ocean' },
] as const

interface Stand {
  readonly name: string
  readonly eye: Vec
  readonly look: Vec
  /** What the page found, for the log — a stand nobody can see is not a stand. */
  readonly note: string
}

/**
 * Compute the two stands from the LIVE world, in the page.
 *
 * The terrain's bounding box is read off the meshes three is about to draw, so
 * it is right on an environment this port has never photographed — which is
 * three of the four here. `__ff2.render.scene` is the same handle
 * `snap.spec.ts` reads.
 */
const standsFor = (page: Page): Promise<Stand[]> =>
  page.evaluate(() => {
    interface Box {
      min: { x: number; y: number; z: number }
      max: { x: number; y: number; z: number }
    }
    interface Node {
      name?: string
      visible?: boolean
      children?: Node[]
      geometry?: { boundingBox: Box | null; computeBoundingBox: () => void }
      /** three's own world matrix. `elements[12..14]` is the translation. */
      matrixWorld?: { elements: number[] }
      updateWorldMatrix?: (parents: boolean, children: boolean) => void
      traverse?: (f: (o: Node) => void) => void
    }
    interface SunLight extends Node {
      isDirectionalLight?: boolean
      position?: { x: number; y: number; z: number }
    }
    const w = globalThis as unknown as {
      __ff2?: {
        render: { scene: Node & { getObjectByName: (n: string) => Node | undefined } }
      }
    }
    const scene = w.__ff2?.render.scene
    if (!scene) throw new Error('draw-order-pixels: no __ff2.render.scene')
    const land = scene.getObjectByName('world-terrain')
    if (!land) throw new Error('draw-order-pixels: no world-terrain in the scene')

    // The world box, from the geometry rather than from the sheet: the terrain
    // transform is the map's CORNER and the offset you are missing is a PARENT
    // (DEV-042), and no single offset rule covers all three environments. A
    // bounding box composed from world positions has no rule to get wrong.
    const lo = {
      x: Number.POSITIVE_INFINITY,
      y: Number.POSITIVE_INFINITY,
      z: Number.POSITIVE_INFINITY,
    }
    const hi = {
      x: Number.NEGATIVE_INFINITY,
      y: Number.NEGATIVE_INFINITY,
      z: Number.NEGATIVE_INFINITY,
    }
    land.traverse?.((o) => {
      const g = o.geometry
      if (!g) return
      if (!g.boundingBox) g.computeBoundingBox()
      const b = g.boundingBox
      if (!b) return
      // The translation out of three's own `matrixWorld`, not
      // `getWorldPosition()` — that one writes into a `Vector3` and a plain
      // object handed to it has no `setFromMatrixPosition` to call. Refreshed
      // first, because `matrixWorld` is only recomputed inside `render()` and
      // this runs between frames (the same staleness CLAUDE.md records for
      // `grip.matrixWorld` in an XR callback).
      o.updateWorldMatrix?.(true, false)
      const e = o.matrixWorld?.elements
      const px = e ? (e[12] as number) : 0
      const py = e ? (e[13] as number) : 0
      const pz = e ? (e[14] as number) : 0
      // The chunk generator writes WORLD coordinates into the vertices (see
      // `load-terrain.ts`: *"Vertices are already in world space"*), so the
      // translation here is the ocean's bob and the props' own placement, and
      // the box is otherwise already where it looks.
      lo.x = Math.min(lo.x, b.min.x + px)
      lo.y = Math.min(lo.y, b.min.y + py)
      lo.z = Math.min(lo.z, b.min.z + pz)
      hi.x = Math.max(hi.x, b.max.x + px)
      hi.y = Math.max(hi.y, b.max.y + py)
      hi.z = Math.max(hi.z, b.max.z + pz)
    })
    if (!Number.isFinite(lo.x)) throw new Error('draw-order-pixels: the terrain has no geometry')

    const cx = (lo.x + hi.x) / 2
    const cz = (lo.z + hi.z) / 2
    const halfX = (hi.x - lo.x) / 2
    const halfZ = (hi.z - lo.z) / 2
    // Above EVERYTHING, which is the placement that cannot be wrong (DEV-041):
    // four attempts to put a camera by walking sightlines over the height field
    // all landed inside a hillside, because `heightField` is not what you see.
    const top = hi.y + Math.max(300, (halfX + halfZ) * 0.15)

    // The sun's bearing, so the horizon stand is a frame with the sky's own
    // gradient and the sun disc in it rather than an arbitrary compass point.
    //
    // Read off the LIVE light rather than off the level JSON, and the two are
    // not the same claim: `applyLighting` sets `light.position` to minus the
    // authored direction times 10,000 with the target at the origin, so the
    // light's own position IS the bearing to the sun after whatever the
    // composition did to it. The sun is per-MISSION here (CLAUDE.md), which is
    // exactly why this is asked of the scene and not of a constant.
    let sx = 1
    let sz = 0
    let foundSun = false
    scene.traverse?.((o) => {
      const l = o as SunLight
      if (foundSun || l.isDirectionalLight !== true || !l.position) return
      foundSun = true
      sx = l.position.x
      sz = l.position.z
    })
    const sl = Math.hypot(sx, sz) || 1

    return [
      {
        name: 'over-land',
        // A corner, looking diagonally across the world at the far edge: land
        // in the near field, whatever is beyond the far edge behind it.
        eye: [cx + halfX * 0.85, top, cz + halfZ * 0.85] as const,
        look: [cx - halfX * 0.6, lo.y + (hi.y - lo.y) * 0.25, cz - halfZ * 0.6] as const,
        note:
          `world box x ${lo.x.toFixed(0)}..${hi.x.toFixed(0)} ` +
          `y ${lo.y.toFixed(0)}..${hi.y.toFixed(0)} z ${lo.z.toFixed(0)}..${hi.z.toFixed(0)}`,
      },
      {
        name: 'horizon',
        // Level, into the sun, from the middle: sky, clouds and horizon-geo.
        eye: [cx, top, cz] as const,
        look: [cx + (sx / sl) * 20000, top, cz + (sz / sl) * 20000] as const,
        note: `sun bearing ${(sx / sl).toFixed(3)}, ${(sz / sl).toFixed(3)} — level, into the sun`,
      },
    ]
  }) as Promise<Stand[]>

/** Point the fixed camera. `?view=cam` places it once and leaves it alone. */
const aim = (page: Page, eye: Vec, look: Vec): Promise<void> =>
  page.evaluate(
    ([e, l]) => {
      const w = globalThis as unknown as {
        __ff2?: {
          render: {
            camera: {
              position: { set: (x: number, y: number, z: number) => void }
              lookAt: (x: number, y: number, z: number) => void
              updateMatrixWorld: (force?: boolean) => void
            }
          }
        }
      }
      const c = w.__ff2?.render.camera
      if (!c) throw new Error('draw-order-pixels: no __ff2.render.camera')
      const eye = e as readonly number[]
      const look = l as readonly number[]
      c.position.set(eye[0] as number, eye[1] as number, eye[2] as number)
      c.lookAt(look[0] as number, look[1] as number, look[2] as number)
      c.updateMatrixWorld(true)
    },
    [eye, look] as const,
  )

interface SwitchReport {
  which: string
  moved: number
  seen: number
  on: boolean
}

const setSwitch = (page: Page, which: 'ocean' | 'sky', on: boolean): Promise<SwitchReport | null> =>
  page.evaluate(
    ([w, o]) => {
      const g = globalThis as unknown as {
        __ff2?: { drawOrderSwitch?: (which: string, on?: boolean) => SwitchReport }
      }
      return g.__ff2?.drawOrderSwitch?.(w as string, o as boolean) ?? null
    },
    [which, on] as const,
  )

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
      // `as number`: `noUncheckedIndexedAccess` widens every index to
      // `| undefined`, and these two are the same size (checked above) with
      // `ch` samples each, so every index below is in range by construction.
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
 * How many pixels of `mask` differ between two frames by more than 24 levels
 * on any channel — a COUNT of pixels, not of channel samples.
 *
 * `comparePng`'s own `over` is a share of channel samples and is the right
 * quantity for a mean; this row's deliverable is *"how many pixels moved"*, so
 * it is counted here and the units are said out loud (DEV-027).
 */
const pixelsMoved = (a: Buffer, b: Buffer, mask: Uint8Array): number => {
  const x = decodePng(a)
  const y = decodePng(b)
  // Throws rather than returning 0. An out-of-range read on a `Uint8Array`
  // gives `undefined`, `Math.abs(NaN) > 24` is false, and a size mismatch would
  // therefore report *"nothing moved"* — which is this spec's PASS. A guard
  // whose failure mode is a pass is not a guard.
  if (x.w !== y.w || x.h !== y.h) {
    throw new Error(`draw-order-pixels: ${x.w}x${x.h} against ${y.w}x${y.h} — the window moved`)
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
 * The longest HORIZONTAL run of consecutive changed pixels inside the mask —
 * the statistic that tells a SEAM from scatter, and the one that says this
 * instrument could have seen one.
 *
 * A mean and a count cannot answer the question that was asked of this row
 * ("zero, or a bounded count at the far-plane seam"), because a seam and the
 * same number of scattered pixels give the same mean. A seam does not scatter:
 * the dome meets the world along the horizon, so a depth relationship that
 * failed at the pin would draw a LINE, and a line is a run the width of the
 * feature.
 *
 * Measured over every frame this spec captured, 2026-09-20: the largest run
 * anywhere is **81 px of 1280**, and it is in a CONTROL — two shots of the same
 * build on `adv_02_jumpSeat`'s horizon stand, where the sun's glint band heaves
 * across open water. The largest in any ARM is 50. So the wave produces runs of
 * TENS and a horizon-spanning seam would produce runs of HUNDREDS, and the bar
 * below sits at a quarter of the frame width: **four times the worst thing the
 * wave has ever done here, and a fifth of what a seam would do.** That is a
 * choice and it is said out loud as one (DEV-027) — derived from what the
 * control measures rather than from what looks safe.
 */
const longestRun = (a: Buffer, b: Buffer, mask: Uint8Array): number => {
  const x = decodePng(a)
  const y = decodePng(b)
  if (x.w !== y.w || x.h !== y.h) {
    throw new Error(`draw-order-pixels: ${x.w}x${x.h} against ${y.w}x${y.h} — the window moved`)
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

/** A seam spans its feature. A quarter of the frame is 4x the worst control run seen. */
const SEAM_SHARE_OF_WIDTH = 0.25

/**
 * The arms, in the order they are shot. `both` last, so a stand that only
 * differs under the pair has already been read apart.
 */
const ARMS = [
  { name: 'no-ocean-order', ocean: false, sky: true },
  { name: 'no-sky-order', ocean: true, sky: false },
  { name: 'neither', ocean: false, sky: false },
] as const

test.describe('@gpu DEV-241 — the order defaults move no pixel', () => {
  test.setTimeout(900_000)

  for (const mission of MISSIONS) {
    test(`${mission.id}: the arms against their own control`, async ({ page }, testInfo) => {
      const problems = watchPageErrors(page)
      fs.mkdirSync(OUT, { recursive: true })
      /** Every stand x arm, collected so the whole table prints before any of it is judged. */
      const verdicts: {
        stand: string
        arm: string
        mean: number
        controlMean: number
        moved: number
        movedControl: number
        runPair: number
        runControl: number
        verdict: string
      }[] = []

      await page.goto(
        // A boot viewpoint, so `resolveViewpoint` returns one and the camera is
        // placed ONCE and left alone (`app.ts`'s VIEWPOINT branch does nothing
        // per frame). `aim` then moves it to each stand. Not straight down: a
        // `lookAt` parallel to the up vector has no answer.
        // `?adaptive=0&quality=high` — DEV-245. `render/quality.ts` drops a
        // tier on a starved frame and a tier drop moves MSAA, the framebuffer
        // scale, the shadow map and the prop LOD, all of which are in a
        // screenshot; no photo spec in this project carried the pin before
        // then. See `fixtures/quality-pin.ts`.
        `/?xr=off&ride=0&mission=${mission.id}&edition=${EDITION}&view=cam&${PINNED}` +
          '&eye=0,4000,0&look=200,0,200',
      )
      await firstPress(page)
      await missionReady(page, 240_000)
      // The streamer settles and the LOD ring stops moving; a chunk arriving
      // between two shots is a difference that is nothing to do with the arm.
      await page.waitForTimeout(6_000)

      console.info(`\n  ${mission.id} — ${mission.why}`)
      const stands = await standsFor(page)

      for (const stand of stands) {
        const key = `${mission.id}/${stand.name}`
        if (ONLY.length > 0 && !ONLY.includes(key) && !ONLY.includes(stand.name)) continue
        await aim(page, stand.eye, stand.look)
        await page.waitForTimeout(1_500)
        console.info(
          `  ${stand.name}: eye ${stand.eye.map((n) => n.toFixed(0)).join(',')} ` +
            `look ${stand.look.map((n) => n.toFixed(0)).join(',')} — ${stand.note}`,
        )

        const shoot = async (label: string): Promise<Buffer> => {
          const shot = await page.locator('#viewport').screenshot()
          const file = path.join(OUT, `${mission.id}-${stand.name}-${label}.png`)
          fs.writeFileSync(file, shot)
          await testInfo.attach(`${mission.id}-${stand.name}-${label}.png`, {
            body: shot,
            contentType: 'image/png',
          })
          return shot
        }

        // A1 — the shipped frame. Asserted rather than assumed: a page that
        // had already been armed would make every number below a comparison
        // between two arms.
        const shippedOcean = await setSwitch(page, 'ocean', true)
        const shippedSky = await setSwitch(page, 'sky', true)
        expect(shippedSky?.on, 'the sky default is not in force on the A frame').toBe(true)
        expect(shippedSky?.seen, 'no dome in the scene').toBeGreaterThan(0)
        if (mission.hasOcean) {
          expect(shippedOcean?.seen, 'no ocean on an environment that has one').toBeGreaterThan(0)
        } else {
          expect(
            shippedOcean?.seen,
            `${mission.id} is alpine and has no water terrain — an ocean here means this ` +
              'spec is measuring something it does not understand',
          ).toBe(0)
        }
        await page.waitForTimeout(1_200)

        // ── A · arm · A · arm · A · arm · A ────────────────────────────────
        //
        // A shipped shot BETWEEN every arm, and the reason is the first run of
        // this spec, which failed on all four missions and was wrong.
        //
        // That version shot A1, the three arms, then A2, built the mask from
        // |A1 - A2| <= 24, and asserted that the arm moved ZERO pixels inside
        // it — with `expect(controlMoved).toBe(0)` as the guard that the mask
        // was sound. **That guard cannot fail.** The mask is DEFINED as the
        // pixels where A1 and A2 agree, so the control's count inside it is
        // zero by construction, and the comment even said so before using it
        // as evidence. Meanwhile the arm's count is not zero by construction at
        // all: a pixel moving 23 levels between A1 and A2 is inside the mask
        // and can move 25 between A1 and the arm, because the arm is a
        // different instant of a frame whose sea heaves and whose clouds drift.
        // So the number being asserted was a threshold-straddling count, not a
        // difference.
        //
        // **The negative control said so in one line and that is why it was
        // there.** `int_02_hoverJet` is alpine, has no water terrain at all, and
        // `no-ocean-order` on it changes nothing whatsoever — and it moved 23
        // stable pixels. An arm that provably did nothing produced a non-zero
        // reading, so the reading was the instrument.
        //
        // What is measured now: each arm sits between two shipped shots taken
        // with exactly the same settle, so `A_k -> arm` and `A_k -> A_{k+1}`
        // are the same interval of the same moving frame, one with the arm in
        // it and one without. The mask comes from the WIDEST bracket (the first
        // shipped shot against the last), which is the most conservative claim
        // about which pixels are quiet. Both numbers are then MEASURED, neither
        // is definitional, and the bar is `tools/perf/png-diff.mjs`'s own —
        // a pair is evidence only when it moves the frame further than two runs
        // of the same build do.
        const shipped: Buffer[] = [await shoot('A0-shipped')]
        const rows: { name: string; report: string; arm: Buffer; before: number }[] = []
        for (const [i, arm] of ARMS.entries()) {
          const o = await setSwitch(page, 'ocean', arm.ocean)
          const s = await setSwitch(page, 'sky', arm.sky)
          // The sky arm is the one that compiles (the far-plane pin is IN the
          // shipped program now), so give it frames before reading pixels.
          await page.waitForTimeout(1_800)
          const shot = await shoot(arm.name)
          // ...and straight back, which closes this arm's own bracket.
          await setSwitch(page, 'ocean', true)
          await setSwitch(page, 'sky', true)
          await page.waitForTimeout(1_800)
          shipped.push(await shoot(`A${i + 1}-shipped`))
          rows.push({
            name: arm.name,
            report: `ocean ${o?.on} (${o?.moved}/${o?.seen}) · sky ${s?.on} (${s?.moved}/${s?.seen})`,
            arm: shot,
            before: i,
          })
        }

        const first = shipped[0] as Buffer
        const last = shipped[shipped.length - 1] as Buffer
        const mask = stableMask(first, last)
        expect(
          mask,
          'the shipped shots are different sizes — the window moved mid-stand',
        ).not.toBeNull()
        const keep = mask?.keep as Uint8Array
        console.info(
          `    quiet mask keeps ${(100 * (mask?.share ?? 0)).toFixed(1)} % of the frame ` +
            `(first shipped shot against the last, ${shipped.length} of them)`,
        )
        // A mask that kept almost nothing would let every arm below pass. It
        // happens if the wave and the clouds fill the frame, which is a real
        // answer about the stand rather than about the change — so it fails
        // loudly instead of reading as a clean result.
        expect(
          mask?.share ?? 0,
          'two same-build frames agree on less than a fifth of this stand — there is ' +
            'nothing quiet enough here to judge an arm against',
        ).toBeGreaterThan(0.2)

        for (const row of rows) {
          const a = shipped[row.before] as Buffer
          const b = shipped[row.before + 1] as Buffer
          const pair = comparePng(a, row.arm)
          const control = comparePng(a, b)
          const movedPair = pixelsMoved(a, row.arm, keep)
          const movedControl = pixelsMoved(a, b, keep)
          const runPair = longestRun(a, row.arm, keep)
          const runControl = longestRun(a, b, keep)
          const width = decodePng(a).w
          // Two ways to fail, and they are different shapes.
          //
          // DIFFERS is png-diff's own bar, and the repo's: a pair is evidence
          // only when it moves the frame more than 1.5x what two runs of the
          // same build move it. Deliberately generous, because the case it
          // exists to catch is the one where the control is the WHOLE signal —
          // which, on a frame whose wave runs on wall time, it is.
          //
          // SEAM is the shape a mean cannot see. See `longestRun`.
          const seam = runPair > width * SEAM_SHARE_OF_WIDTH
          const verdict = seam
            ? 'SEAM'
            : pair && control && pair.mean > control.mean * 1.5
              ? 'DIFFERS'
              : 'inside the noise'
          console.info(
            `    ${row.name.padEnd(16)} ${row.report}\n` +
              `      mean ${pair?.mean.toFixed(2).padStart(6)} vs control ` +
              `${control?.mean.toFixed(2).padStart(6)}  ·  quiet px ` +
              `${String(movedPair).padStart(6)} vs ${String(movedControl).padStart(6)}` +
              `  ·  run ${String(runPair).padStart(4)} vs ${String(runControl).padStart(4)}` +
              ` of ${width}  ·  ${verdict}`,
          )
          verdicts.push({
            stand: key,
            arm: row.name,
            mean: pair?.mean ?? Number.NaN,
            controlMean: control?.mean ?? Number.NaN,
            moved: movedPair,
            movedControl,
            runPair,
            runControl,
            verdict,
          })
        }
      }

      // ── Every stand printed BEFORE anything is asserted ────────────────
      //
      // The first run threw inside the loop on the first stand of each mission
      // and never reached the second, so the `horizon` stand — the one the
      // sky's far-plane pin is actually aimed at — produced no data at all on
      // the run that was supposed to price it. A table you cannot read because
      // its first row failed is the same mistake as a filtered `pnpm e2e`.
      const bad = verdicts.filter((v) => v.verdict !== 'inside the noise')
      expect(
        bad.map(
          (v) =>
            `${v.stand}/${v.arm}: ${v.verdict} — mean ${v.mean.toFixed(2)} vs ` +
            `${v.controlMean.toFixed(2)}, longest run ${v.runPair} vs ${v.runControl}`,
        ),
        'an order arm either moved the frame further than two runs of the same build move ' +
          'it (DIFFERS) or drew a LINE where the control draws scatter (SEAM). Submission ' +
          'order is the only thing these switches change, so either is a depth relationship ' +
          'nobody accounted for — find it before writing a ledger row.',
      ).toEqual([])

      // A shader that failed to link logs and draws black; the sky arm builds a
      // program no warm-up covers, so this is where that would land.
      expect(problems.list(), 'page errors — a failed shader compile lands here').toEqual([])
    })
  }

  /**
   * THE MENU ROOM — what a dome drawn last does to it, and what this CANNOT say.
   *
   * ── The concern (DEV-241 §5b) ────────────────────────────────────────
   *
   * `render/medal.ts`'s outline shell is the one object in `src/` that breaks
   * the rule a dome drawn last depends on — *an opaque object submitted before
   * the dome must write depth.* It is opaque on Anniversary
   * (`transparent: block.opacity < 1`, and `anniversary.json` gives
   * `opacity: 1`) and carries `depthWrite: false`; and its
   * `holder.renderOrder = -1` is set on a **Group**, which three does not
   * inherit — `projectObject` pushes each drawable with its OWN `renderOrder` —
   * so its meshes sit at 0. Against room geometry it is safe, because the walls
   * write depth and the dome is rejected. Against open sky it would be
   * overpainted.
   *
   * ── What this test establishes ───────────────────────────────────────
   *
   * That moving the dome changes nothing in the menu room as it stands: no
   * opaque object currently in that frame is drawn before the dome without
   * writing depth. That is a real negative over a whole room, and it is the
   * room the medal lives in — `hangar.ts`'s `attachMedal` is the only call site
   * of `createMedal` in `src/`.
   *
   * ── AND WHAT IT DOES NOT, WHICH IS THE POINT OF THE ASSERTION BELOW ──
   *
   * **There is no medal in this frame.** A holotable wears one only for a
   * course with a stored best (`slot.mission.medal !== null`), and a fresh
   * profile has none — so this run cannot exercise the one object the concern
   * is about. Putting one there means seeding `localStorage` and walking four
   * menu steps with gaze and held confirms, which is
   * `holotable-medal.spec.ts`'s harness and not this one's.
   *
   * So the absence is ASSERTED rather than assumed. If a future default, a
   * seeded profile or a changed boot page ever puts a medal in this frame, this
   * test goes red and says so — because at that moment its claim would silently
   * become much stronger than it is, and a test that quietly starts proving
   * more than it says is the same failure as one that quietly proves less.
   * DEV-241 §5b stays open until a medal is in a photograph.
   */
  test('the menu room: the dome puts no pixel in it (and carries no medal)', async ({
    page,
  }, testInfo) => {
    const problems = watchPageErrors(page)
    fs.mkdirSync(OUT, { recursive: true })

    // Pinned for DEV-245's reason, the same as the stands above.
    await page.goto(`/?xr=off&title=0&edition=${EDITION}&${PINNED}`)
    await firstPress(page)
    await missionReady(page, 240_000)
    await page.waitForTimeout(6_000)

    const shoot = async (label: string): Promise<Buffer> => {
      const shot = await page.locator('#viewport').screenshot()
      const file = path.join(OUT, `menu-room-${label}.png`)
      fs.writeFileSync(file, shot)
      await testInfo.attach(`menu-room-${label}.png`, { body: shot, contentType: 'image/png' })
      return shot
    }

    // The premise, checked. See the header: this is the loud counterpart, not
    // a formality.
    const medals = await page.evaluate(() => {
      interface N {
        name?: string
        traverse?: (f: (o: N) => void) => void
      }
      const scene = (globalThis as unknown as { __ff2?: { render: { scene: N } } }).__ff2?.render
        .scene
      const found: string[] = []
      scene?.traverse?.((o) => {
        if (o.name?.startsWith('medal')) found.push(o.name)
      })
      return found
    })
    expect(
      medals,
      'a medal is in the menu frame now, so this test can finally exercise DEV-241 §5b — ' +
        'read the numbers below against the shell and close the row',
    ).toEqual([])

    const on = await setSwitch(page, 'sky', true)
    expect(on?.seen, 'no dome in the menu scene — then this test proves nothing').toBeGreaterThan(0)
    expect(on?.on, 'the sky default is not in force').toBe(true)
    await page.waitForTimeout(1_200)

    // Four shipped shots and one arm, so the mask comes from a WIDER bracket
    // than the control pair. Three would repeat the first version of this
    // file's mistake: a mask defined by the control makes the control's count
    // inside it zero by construction, and the arm's count a measure of which
    // pixels happen to straddle a threshold.
    const a0 = await shoot('A0-shipped')
    await page.waitForTimeout(1_800)
    const a1 = await shoot('A1-shipped')

    const off = await setSwitch(page, 'sky', false)
    expect(off?.on).toBe(false)
    expect(off?.moved, 'the OFF arm moved nothing, so it was already off').toBeGreaterThan(0)
    await page.waitForTimeout(1_800)
    const armed = await shoot('sky-first')

    await setSwitch(page, 'sky', true)
    await page.waitForTimeout(1_800)
    const a2 = await shoot('A2-shipped')

    const mask = stableMask(a0, a2)
    const keep = mask?.keep as Uint8Array
    const pair = comparePng(a1, armed)
    const control = comparePng(a0, a1)
    const movedPair = pixelsMoved(a1, armed, keep)
    const movedControl = pixelsMoved(a0, a1, keep)
    const runPair = longestRun(a1, armed, keep)
    const runControl = longestRun(a0, a1, keep)
    console.info(
      `\n  menu room — quiet mask ${(100 * (mask?.share ?? 0)).toFixed(1)} % of the frame\n` +
        `    sky FIRST vs shipped: mean ${pair?.mean.toFixed(2)} (control ` +
        `${control?.mean.toFixed(2)})  ·  quiet px ${movedPair} vs ${movedControl}` +
        `  ·  run ${runPair} vs ${runControl}`,
    )

    // The claim: the dome contributes no pixel to this room that moving it can
    // change. Same bar as every other row in this file.
    expect(
      pair && control ? pair.mean > control.mean * 1.5 : true,
      'moving the dome changed the MENU ROOM, so something in here is drawn before it ' +
        'without writing depth. DEV-241 §5b names the candidate: the medal outline shell ' +
        '(opaque, depthWrite false, and renderOrder 0 on its meshes because the -1 is set ' +
        'on a Group three does not inherit from).',
    ).toBe(false)

    expect(problems.list(), 'page errors').toEqual([])
  })
})
