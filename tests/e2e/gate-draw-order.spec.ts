/**
 * tests/e2e/gate-draw-order.spec.ts — DEV-422. A gate that is BEHIND another
 * gate must not be drawn over it.
 *
 *   E2E_PORT=<yours> GATE_ORDER_DIR=<dir> \
 *     pnpm exec playwright test tests/e2e/gate-draw-order.spec.ts --workers 1 --retries 0
 *
 * ── What Matt saw, and what it turned out to be ──────────────────────────
 *
 * *"check draw order on ring and arrow material - it seems to draw on top of
 * other things?"* — 2026-09-26. The ring frame and the turn indicator's arrow
 * wear ONE material, `checkpoint_enabled`: translucent, and with `depthWrite`
 * off. Against terrain, props and the ship it depth-tests correctly — photographed
 * adversarially, with the render terrain between the eye and the gate, and
 * the gate was hidden every time. What it gets wrong is every OTHER translucent
 * thing, and the mechanism is three's, not a guess about it:
 *
 *  · three draws the transparent list back to front by ONE point per object,
 *    and an `InstancedMesh` sorts at its instances' bounding-sphere centre.
 *    All 21 ring frames are one `InstancedMesh`, so they sort as one point
 *    near the middle of the course, wherever the gate you are looking at is.
 *  · neither the frames nor their translucent neighbours write depth, so
 *    whichever draws SECOND paints over the other, in front or not.
 *
 * ── The frame this spec photographs, and why it is adversarial ───────────
 *
 * The orange FINISH frame is a separate mesh, sorted at its own centre, and it
 * stands 237.6 m past the last green ring on `int_01_hoverJet`. From 117 m
 * behind that ring, on the line through both, the two appear the SAME SIZE
 * (the finish is ~3x a ring and ~3x as far) and concentric, so their bars cross
 * all round. Every crossing pixel has the ring NEARER, by construction. Before
 * DEV-422 the finish drew second and its orange ran over the green; a draw-order
 * bug is invisible where nothing overlaps, which is why the pose is this one.
 *
 * ── How "which is on top" is read ─────────────────────────────────────────
 *
 * Five frames of one page: everything, the ring hidden, the finish frame
 * hidden, both hidden, and everything again. Hidden means a layer the camera
 * does not see — the game's own objects, only not drawn — so the harness takes
 * no other path. Pixels that moved between the two shots of the unchanged page
 * (the sea, the sparkles) are dropped first.
 *
 * The CROSSING is found without the order under test: pixels where the ring,
 * alone (finish hidden), makes the frame GREENER, and the finish, alone (ring
 * hidden), makes it REDDER. A direction of hue rather than a size of change,
 * because the sea and the near-field motes move between shots seconds apart,
 * and a size test counted them as both frames at once — a shoreline and a
 * scatter of specks that diluted the answer to nothing.
 *
 * Over the crossing, the SCORE is where the full frame's green-minus-red sits
 * between the finish alone (0) and the ring alone (1):
 *
 *   · the finish painted over the ring (the bug) — near 0: it measured 0.08 on
 *     Anniversary and 0.22 on Classic, whose 29 % of ring under 71 % of orange
 *     is still a little green;
 *   · the ring over the finish, both translucent — about 0.71;
 *   · the ring over the finish and writing depth (the fix) — about 1.
 *
 * The ring is on top above 0.5. Two earlier metrics are on the record in
 * DEV-422's row, because each was wrong in an instructive way: the first read
 * pixels BOTH frames changed in the full frame, and the fix emptied that set
 * (a nearer bar that writes depth leaves the finish nothing to change); the
 * second measured how much the finish still changed the frame, which ACES
 * made a question about colour distances rather than about order.
 *
 * Tagged `@gpu`: it reads rendered pixels.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../../tools/perf/png-diff.mjs'
import { missionReady } from './fixtures/boot'
import type { Ff2Global } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.GATE_ORDER_DIR ?? 'test-results/gate-draw-order'
const MISSION = 'int_01_hoverJet'

type Vec = [number, number, number]
const readJson = (...parts: string[]) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8'))
const level = readJson('content', 'levels', `${MISSION}.json`) as {
  routes: { rings: { pos: Vec; scale: Vec }[] }[]
  finish: { art: { frame: { pos: Vec; scale: Vec } } }
}
/** `jumpGate_diamond`'s own scale inside `Checkpoint_Ring.prefab`, off the sheet. */
const RING_FRAME_SCALE = (
  readJson('src', 'generated', 'constants.generated.json') as {
    props: { checkpointRing: { frame: { scale: Vec } } }
  }
).props.checkpointRing.frame.scale[0]

const triple = (v: Vec) => v.map((n) => n.toFixed(2)).join(',')

/** The ring's drawables, and the finish FRAME alone (its studs and banner stay). */
const RING = ['rings', 'ring-studs', 'ring-bullseye']
const FINISH = ['finish-gate']

/** Put the named MESHES on a layer the camera does not see, or back on 0. */
const hide = (page: Page, names: readonly string[], hidden: boolean): Promise<number> =>
  page.evaluate(
    ({ names, hidden }) => {
      const w = globalThis as unknown as Ff2Global
      let n = 0
      w.__ff2.stage().traverse((o) => {
        if (!names.includes(o.name) || !(o as import('three').Mesh).isMesh) return
        o.layers.set(hidden ? 31 : 0)
        n++
      })
      return n
    },
    { names: [...names], hidden },
  )

interface Img {
  w: number
  h: number
  ch: number
  data: Uint8Array
}

const shot = async (page: Page, name: string): Promise<Img> => {
  await page.waitForTimeout(400)
  const png = await page.locator('#viewport').screenshot()
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name), png)
  return decodePng(png) as Img
}

const diff = (a: Img, b: Img, i: number): number =>
  Math.max(
    Math.abs((a.data[i * a.ch] as number) - (b.data[i * b.ch] as number)),
    Math.abs((a.data[i * a.ch + 1] as number) - (b.data[i * b.ch + 1] as number)),
    Math.abs((a.data[i * a.ch + 2] as number) - (b.data[i * b.ch + 2] as number)),
  )

/** Green minus red: what the ring's frame adds to a pixel. */
const greenness = (a: Img, i: number): number =>
  (a.data[i * a.ch + 1] as number) - (a.data[i * a.ch] as number)

/** Red minus blue: what the finish's orange adds to a pixel over sea, rock or sky. */
const redness = (a: Img, i: number): number =>
  (a.data[i * a.ch] as number) - (a.data[i * a.ch + 2] as number)

/** How far a frame alone must move a pixel's hue to count as present there. */
const HUE_STEP = 25

test.describe('@gpu DEV-422 — a nearer gate is not drawn over by a farther one', () => {
  test.setTimeout(300_000)
  const rings = level.routes[0]?.rings ?? []
  const lastRing = rings[rings.length - 1]
  if (!lastRing) throw new Error(`${MISSION} has no rings`)
  const last = lastRing.pos
  const finish = level.finish.art.frame.pos
  const away: Vec = [last[0] - finish[0], last[1] - finish[1], last[2] - finish[2]]
  const gap = Math.hypot(...away)
  // How far behind the last ring the two frames look the SAME SIZE: the frame
  // is one mesh at two world scales, so equal size is `(d + gap) / d = ratio`.
  // On int_01 that is 116.9 m, with the finish 3.03x the ring.
  const ratio = level.finish.art.frame.scale[0] / (lastRing.scale[0] * RING_FRAME_SCALE)
  const back = gap / (ratio - 1)
  const eye: Vec = [
    last[0] + (away[0] / gap) * back,
    last[1] + (away[1] / gap) * back,
    last[2] + (away[2] / gap) * back,
  ]

  // Anniversary twice: as shipped on a monitor, through the bloom composer, and
  // on the DIRECT render path — the DEV-263 pin `render.bloom:off` — which is
  // the path a headset always takes, because the composer never runs while
  // presenting (`render/bloom.ts`, "Never in VR"). The order under test is
  // decided before any post pass, so both must agree.
  const arms = [
    ['classic', 'classic', ''],
    ['anniversary', 'anniversary', ''],
    ['anniversary-direct', 'anniversary', '&feature=render.bloom:off'],
  ] as const
  for (const [arm, edition, pin] of arms) {
    test(`${arm}: the last ring stays over the finish behind it`, async ({ page }) => {
      await page.goto(
        `/?xr=off&ride=0&mission=${MISSION}&${PINNED}&view=cam&edition=${edition}${pin}` +
          `&eye=${triple(eye)}&look=${triple(finish)}`,
      )
      await firstPress(page)
      await missionReady(page, 180_000)
      await page.waitForTimeout(2_500)

      const tag = `int01-last-ring-over-finish-${arm}-adaptive0-qhigh`
      const a1 = await shot(page, `${tag}-A1.png`)
      expect(await hide(page, RING, true), 'the ring drawables were found').toBe(RING.length)
      const noRing = await shot(page, `${tag}-no-ring.png`)
      expect(await hide(page, FINISH, true), 'the finish frame was found').toBe(1)
      const noBoth = await shot(page, `${tag}-no-ring-no-finish.png`)
      await hide(page, RING, false)
      const noFinish = await shot(page, `${tag}-no-finish.png`)
      await hide(page, FINISH, false)
      const a2 = await shot(page, `${tag}-A2.png`)

      // Where each frame IS, each judged ALONE (the other hidden) and by the
      // direction it moves the hue, so neither the order under test nor the
      // moving sea can put a pixel in the crossing.
      let crossing = 0
      let ringPx = 0
      let finishPx = 0
      let toward = 0
      let span = 0
      for (let i = 0; i < a1.w * a1.h; i++) {
        if (diff(a1, a2, i) > 12) continue
        const base = greenness(noBoth, i)
        const ringHere = greenness(noFinish, i) - base > HUE_STEP
        const finishHere = redness(noRing, i) - redness(noBoth, i) > HUE_STEP
        if (ringHere) ringPx++
        if (finishHere) finishPx++
        if (!(ringHere && finishHere)) continue
        crossing++
        // 0 = the full frame looks like the finish alone, 1 = like the ring alone.
        toward += greenness(a1, i) - greenness(noRing, i)
        span += greenness(noFinish, i) - greenness(noRing, i)
      }
      const score = toward / span
      const line =
        `${arm}: ring ${ringPx} px, finish ${finishPx} px, crossing ${crossing} px; ` +
        `ring-vs-finish hue span ${(span / crossing).toFixed(1)} levels; ` +
        `score ${score.toFixed(3)} (0 = the finish on top, ~0.71 ring over it translucent, ` +
        `~1 ring over it writing depth)`
      console.log(line)
      fs.writeFileSync(path.join(OUT, `${tag}.txt`), `${line}\n`)

      // The positive controls first: a frame where the two do not cross, or do
      // not differ in hue, cannot say which is on top.
      expect(ringPx, 'the ring is on screen').toBeGreaterThan(300)
      expect(finishPx, 'the finish frame is on screen').toBeGreaterThan(300)
      // 200, not 300, since DEV-922 made the gates single-sided and opaque: the
      // back faces no longer draw, so the Anniversary stand's overlap fell from
      // 472 px to 282 (2026-10-12, same stand, score 0.979 then, 0.993 now).
      // 200 px is still a crossing a hue average can be read over.
      expect(crossing, 'the two frames cross on screen').toBeGreaterThan(200)
      expect(span / crossing, 'the ring and the finish differ in hue there').toBeGreaterThan(40)
      // And the claim.
      expect(score, 'the NEARER ring is the top layer where the two cross').toBeGreaterThan(0.5)
    })
  }
})
