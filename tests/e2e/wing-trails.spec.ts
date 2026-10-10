/**
 * tests/e2e/wing-trails.spec.ts — wing-tip trails at speed, on the player and
 * on the racers. DEV-358.
 *
 * Matt, 2026-09-24, on third person: *"particle trails on the wing-tips once
 * we're at a decent speed (show them on the ai racers as well)."*
 *
 * ── Why here and not only in `wing-trails.test.ts` ──────────────────────
 *
 * The unit file proves the fade, the slider, the tip rule and the batch. What
 * it cannot see is the BUILD: that the flight and the racers were each given a
 * batch, that the batches are in the scene the frame draws, that on
 * Anniversary both draw at speed with the player in third person, that on
 * Classic neither draws, and what the frame pays for them. A flag has been
 * green in a unit test while it was dead in the frame here before
 * (AGENT-NOTES §4), so this reads the live scene graph.
 *
 * ── A frozen frame shows them, on purpose ────────────────────────────────
 *
 * `?snap=` holds the sim, and the trails' clock is the SIM's (a held frame
 * hands them no time), so the vapour made on the way to the mark is still
 * there to read and to photograph. `?camera=third` boots with CHANGE VIEW
 * already pressed: the player's own trails are made only while you are
 * looking at your own ship, so V pressed AFTER the freeze would find none.
 *
 * ── What it costs, as a count of ONE frame ───────────────────────────────
 *
 * The frozen frame drawn with the flag on, then off: the difference in draw
 * calls and triangles is the trails and nothing else, and it is checked
 * against the two batches' own geometry, so a batch that drew nothing, or
 * drew twice, cannot pass. A count of a frame is immune to a busy box where a
 * millisecond is not (AGENT-NOTES §1).
 *
 *   WING_DIR=<dir> E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/wing-trails.spec.ts --workers 1
 *
 * PINNED (DEV-245), with the pin in every file name. `@gpu`, headed, hydrated.
 *
 * ── The follow-up's arm: a player who never boosts ───────────────────────
 *
 * Matt asked for *"a trail to the player in third person"* after DEV-358 had
 * given him one, and the reason is that every arm here flew the AUTOPILOT,
 * which boosts. A player who does not hold boost flies at the unboosted
 * terminal speed, where DEV-358's fade was exactly zero. The last arm flies
 * that player (no autopilot; the throttle held, the boost never touched) and
 * measures whether the trail READS: how much brighter the frame is along the
 * trail's own projected centre line than the same frame with the trails off,
 * against the same samples across two frames with them on. Along the LINE and
 * not over the frame, because the sea is animated on a held sim and moves
 * ~80,000 pixels between two identical frames.
 */

import path from 'node:path'
import { decodePng } from '../../tools/perf/png-diff.mjs'
import { missionReady } from './fixtures/boot'
import { focusCanvas, pointerIsLocked } from './fixtures/canvas'
import { flyToFreeze, hold, isFrozen } from './fixtures/freeze'
import { knownRed } from './fixtures/known-red'
import { firstPress } from './fixtures/landing'
import { viewportPhotographer } from './fixtures/photo'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.WING_DIR ?? path.join('test-results', 'wing-trails')
const MISSION = 'int_01_hoverJet'
/** Mission seconds: past 180 m/s (DEV-351 measured 4.3 s) with the pack still near. */
const SNAP_AT = Number(process.env.WING_AT ?? '6')
const PIN_PARAMS: Readonly<Record<string, string>> = Object.fromEntries(new URLSearchParams(PINNED))
const PIN_TAG = PINNED.replace(/[=&]/g, '')
/**
 * The cruise arm's bars for "reads", in the units of the frame (0-255, mean
 * over RGB): how many of the trail's centre-line points must be on screen, how
 * far the median of them must rise over the same frame with the trails off,
 * and the rise a sample must clear to count as brightened. Set from the first
 * measured run; the DEVIATIONS row has the reading they were set against.
 */
// DEV-864: 8 to 10 points land on screen from run to run (committed points follow frame timing), so the floor sits below that range; the brightness checks carry the claim.
const MIN_LINE_SAMPLES = 5
const MIN_MEDIAN_RISE = 40
const RISE = 30

interface Batch {
  readonly found: boolean
  readonly visible: boolean
  readonly triangles: number
  /** The strongest alpha among the vertices the draw range reaches. */
  readonly peakAlpha: number
  readonly fog: boolean
  /** The material colour's red channel: the glow, an HDR scalar. */
  readonly glow: number
  /** The distinct centre-line colours drawn, `r,g,b` to two places: one per craft's tint. */
  readonly tints: string[]
}

interface Facts {
  readonly player: Batch
  readonly racers: Batch
  readonly racerCount: number
}

const facts = (page: Page): Promise<Facts> =>
  page.evaluate(() => {
    type Attr = {
      getX(i: number): number
      getY(i: number): number
      getZ(i: number): number
      getW(i: number): number
    }
    type O = {
      name?: string
      visible?: boolean
      geometry?: {
        drawRange: { count: number }
        index: Attr | null
        getAttribute(n: string): Attr | undefined
      }
      material?: { fog?: boolean; color?: { r: number } }
      traverse?: (fn: (o: O) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2?: { render: { scene: O }; racers: () => { count: number } | null }
    }
    const h = w.__ff2
    if (!h) throw new Error('wing-trails: no __ff2')
    const across = 5
    const centre = 2
    const read = (name: string): Batch => {
      let out: Batch = {
        found: false,
        visible: false,
        triangles: 0,
        peakAlpha: 0,
        fog: false,
        glow: 0,
        tints: [],
      }
      h.render.scene.traverse?.((o) => {
        if (o.name !== name || !o.geometry) return
        const g = o.geometry
        const colour = g.getAttribute('color')
        let peak = 0
        const tints = new Set<string>()
        for (let i = 0; g.index && colour && i < g.drawRange.count; i++) {
          const v = g.index.getX(i)
          peak = Math.max(peak, colour.getW(v))
          if (v % across === centre) {
            tints.add(
              [colour.getX(v), colour.getY(v), colour.getZ(v)].map((c) => c.toFixed(2)).join(','),
            )
          }
        }
        out = {
          found: true,
          visible: o.visible === true,
          triangles: g.drawRange.count / 3,
          peakAlpha: peak,
          fog: o.material?.fog === true,
          glow: o.material?.color?.r ?? 0,
          tints: [...tints].sort(),
        }
      })
      return out
    }
    return {
      player: read('wing-trails:player'),
      racers: read('wing-trails:racers'),
      racerCount: h.racers()?.count ?? 0,
    }
  })

const shoot = viewportPhotographer(OUT, PIN_TAG)

interface Frame {
  readonly w: number
  readonly h: number
  readonly ch: number
  readonly data: Uint8Array
}

/**
 * Pixels that moved by more than 24 levels on some channel, and by how much
 * the brightest of them rose. 24 is `png-diff.mjs`'s own bar, the units the
 * rest of the repo argues pixels in (`hover-glow.spec.ts`).
 */
const moved = (on: Frame, off: Frame): { pixels: number; brighter: number; peakRise: number } => {
  if (on.w !== off.w || on.h !== off.h) throw new Error('wing-trails: frame sizes differ')
  const rgb = Math.min(3, on.ch, off.ch)
  let pixels = 0
  let brighter = 0
  let peakRise = 0
  for (let p = 0; p < on.w * on.h; p++) {
    let d = 0
    let rise = 0
    for (let k = 0; k < rgb; k++) {
      const a = on.data[p * on.ch + k] as number
      const b = off.data[p * off.ch + k] as number
      d = Math.max(d, Math.abs(a - b))
      rise += a - b
    }
    if (d > 24) {
      pixels++
      if (rise > 0) brighter++
      peakRise = Math.max(peakRise, rise / rgb)
    }
  }
  return { pixels, brighter, peakRise }
}

/**
 * A batch's centre-line vertices (the third of every five across), projected
 * through the scene camera into the screenshot's pixels. On screen, in front of
 * the camera, and inset 2 px from the edges so a 3 x 3 sample fits.
 */
const centreLineOnScreen = (page: Page, name: string): Promise<[number, number][]> =>
  page.evaluate((batch) => {
    type Attr = { getX(i: number): number; getY(i: number): number; getZ(i: number): number }
    type V = {
      set(x: number, y: number, z: number): V
      project(c: unknown): V
      x: number
      y: number
      z: number
    }
    type O = {
      name?: string
      position?: { constructor: new () => V }
      geometry?: { drawRange: { count: number }; index: Attr | null; getAttribute(n: string): Attr }
      traverse?: (fn: (o: O) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2: { render: { scene: O; camera: unknown; renderer: { domElement: HTMLCanvasElement } } }
    }
    const { scene, camera, renderer } = w.__ff2.render
    const width = renderer.domElement.clientWidth
    const height = renderer.domElement.clientHeight
    const out: [number, number][] = []
    scene.traverse?.((o) => {
      if (o.name !== batch || !o.geometry || !o.position) return
      const g = o.geometry
      const pos = g.getAttribute('position')
      const seen = new Set<number>()
      for (let i = 0; g.index && i < g.drawRange.count; i++) {
        const v = g.index.getX(i)
        if (v % 5 !== 2 || seen.has(v)) continue
        seen.add(v)
        const p = new o.position.constructor().set(pos.getX(v), pos.getY(v), pos.getZ(v))
        p.project(camera)
        if (p.z < -1 || p.z > 1) continue
        const x = Math.round(((p.x + 1) / 2) * width)
        const y = Math.round(((1 - p.y) / 2) * height)
        if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) continue
        out.push([x, y])
      }
    })
    return out
  }, name)

/**
 * How much brighter frame `a` is than frame `b` along `points`: at each point
 * the largest mean-RGB rise in its 3 x 3 neighbourhood (a line a few pixels
 * wide lands within a pixel of its projected centre). Median, and the share
 * of points that rose by `RISE` or more.
 */
const riseAlong = (
  a: Frame,
  b: Frame,
  points: readonly (readonly [number, number])[],
): { median: number; brighterShare: number } => {
  const lum = (f: Frame, x: number, y: number): number => {
    const o = (y * f.w + x) * f.ch
    return ((f.data[o] as number) + (f.data[o + 1] as number) + (f.data[o + 2] as number)) / 3
  }
  const rises = points.map(([x, y]) => {
    let best = Number.NEGATIVE_INFINITY
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++)
        best = Math.max(best, lum(a, x + dx, y + dy) - lum(b, x + dx, y + dy))
    }
    return best
  })
  if (rises.length === 0) return { median: 0, brighterShare: 0 }
  const sorted = [...rises].sort((p, q) => p - q)
  return {
    median: sorted[Math.floor(sorted.length / 2)] as number,
    brighterShare: rises.filter((r) => r >= RISE).length / rises.length,
  }
}

/** The player ship's forward speed, m/s: the quantity the trails' fade reads. */
const playerForwardSpeed = (page: Page): Promise<number> =>
  page.evaluate(() => {
    type Body = {
      orientation: { x: number; y: number; z: number; w: number }
      velocity: { x: number; y: number; z: number }
    }
    const w = globalThis as unknown as { __ff2: { flight: () => { jet: { body: Body } } | null } }
    const b = w.__ff2.flight()?.jet.body
    if (!b) return Number.NaN
    const { x, y, z, w: qw } = b.orientation
    return (
      2 * (x * z + qw * y) * b.velocity.x +
      2 * (y * z - qw * x) * b.velocity.y +
      (1 - 2 * (x * x + y * y)) * b.velocity.z
    )
  })

/**
 * A player who never boosts, frozen at `SNAP_AT`: `flyToFreeze`'s steps, by
 * hand, because a player has to hold the THROTTLE (Space, `input/keyboard.ts`)
 * and the fixture only launches. No boost key is ever pressed. `menu=0`:
 * without the autopilot, boot is the title and the hangar, and this player has
 * already picked the course (`racer-livery.spec.ts` loads a hand-flown grid
 * the same way). `extra` is the view: `camera=third`, or nothing for the seat.
 */
const flyAtCruise = async (page: Page, extra: Readonly<Record<string, string>>): Promise<void> => {
  const query = new URLSearchParams({
    ...PIN_PARAMS,
    xr: 'off',
    snap: String(SNAP_AT),
    edition: 'anniversary',
    mission: MISSION,
    menu: '0',
    ride: '0',
    ...extra,
  })
  await page.goto(`/?${query.toString()}`)
  await firstPress(page)
  await missionReady(page, 240_000)
  await focusCanvas(page)
  await hold(page, 'Enter')
  await page.keyboard.down('Space')
  await expect.poll(() => isFrozen(page), { timeout: 180_000, intervals: [250] }).toBe(true)
  await page.keyboard.up('Space')
  await page.waitForTimeout(5_000)
}

/**
 * The player's ribbons as the SEAT sees them: each centre-line point's
 * distance from the eye, its bearing off the ship's nose (the rig's forward,
 * which the free look does not move), and how wide the whole glow is there, in
 * degrees at the eye. World space, off the batch the frame drew.
 */
const seatGeometry = (
  page: Page,
): Promise<{
  points: number
  nearestM: number
  bearingDeg: { min: number; max: number }
  widestDeg: number
}> =>
  page.evaluate(() => {
    type Attr = { getX(i: number): number; getY(i: number): number; getZ(i: number): number }
    type M = { elements: number[] }
    type O = {
      name?: string
      parent?: O | null
      matrixWorld: M
      geometry?: { drawRange: { count: number }; index: Attr | null; getAttribute(n: string): Attr }
      traverse?: (fn: (o: O) => void) => void
    }
    const w = globalThis as unknown as { __ff2: { render: { scene: O; camera: O } } }
    const { scene, camera } = w.__ff2.render
    const e = camera.matrixWorld.elements
    const eye = [e[12] as number, e[13] as number, e[14] as number]
    // The nose: the RIG's -z. The rig carries the ship's heading; the camera
    // under it carries the free look, which is the thing about to move.
    const r = (camera.parent ?? camera).matrixWorld.elements
    const nose = [-(r[8] as number), -(r[9] as number), -(r[10] as number)]
    const nl = Math.hypot(nose[0] as number, nose[1] as number, nose[2] as number)
    let points = 0
    let nearestM = Number.POSITIVE_INFINITY
    let minB = Number.POSITIVE_INFINITY
    let maxB = 0
    let widestDeg = 0
    scene.traverse?.((o) => {
      if (o.name !== 'wing-trails:player' || !o.geometry) return
      const g = o.geometry
      const pos = g.getAttribute('position')
      const seen = new Set<number>()
      for (let i = 0; g.index && i < g.drawRange.count; i++) {
        const v = g.index.getX(i)
        if (v % 5 !== 2 || seen.has(v)) continue
        seen.add(v)
        const d = [
          pos.getX(v) - (eye[0] as number),
          pos.getY(v) - (eye[1] as number),
          pos.getZ(v) - (eye[2] as number),
        ]
        const dist = Math.hypot(d[0] as number, d[1] as number, d[2] as number)
        const cos =
          ((d[0] as number) * (nose[0] as number) +
            (d[1] as number) * (nose[1] as number) +
            (d[2] as number) * (nose[2] as number)) /
          (dist * nl)
        const bearing = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
        const edge = Math.hypot(
          pos.getX(v - 2) - pos.getX(v + 2),
          pos.getY(v - 2) - pos.getY(v + 2),
          pos.getZ(v - 2) - pos.getZ(v + 2),
        )
        points++
        nearestM = Math.min(nearestM, dist)
        minB = Math.min(minB, bearing)
        maxB = Math.max(maxB, bearing)
        widestDeg = Math.max(widestDeg, (edge / dist) * (180 / Math.PI))
      }
    })
    return { points, nearestM, bearingDeg: { min: minB, max: maxB }, widestDeg }
  })

const setWing = (page: Page, enabled: boolean) =>
  page.evaluate((on) => {
    const w = globalThis as unknown as {
      __ff2: { edition: { current: unknown; setPreset(e: unknown): void } }
    }
    const next = structuredClone(w.__ff2.edition.current) as {
      fx: { wingTrails: { enabled: boolean } }
    }
    next.fx.wingTrails.enabled = on
    w.__ff2.edition.setPreset(next)
  }, enabled)

test.describe('@gpu DEV-358: wing-tip trails at speed', () => {
  test.setTimeout(600_000)

  for (const edition of ['anniversary', 'classic'] as const) {
    test(`a frozen frame at ${SNAP_AT} s, third person · ${edition}`, async ({ page }) => {
      knownRed('KR-10', edition === 'anniversary')
      await flyToFreeze(page, {
        mission: MISSION,
        edition,
        snapAt: SNAP_AT,
        params: { ...PIN_PARAMS, camera: 'third' },
      })
      const pinned = await drawState(page)
      const f = await facts(page)
      console.info(
        `wing-trails ${edition} @ ${SNAP_AT}s: player ${JSON.stringify(f.player)} · ` +
          `racers ${JSON.stringify(f.racers)} (${f.racerCount} racers) · ${drawStateLine(pinned)}`,
      )
      // The premise, loud: both batches were BUILT, on both presets — a flip
      // to Anniversary mid-run is one press, so Classic carries them hidden.
      expect(f.player.found, "the player's batch is in the scene").toBe(true)
      expect(f.racers.found, "the racers' batch is in the scene").toBe(true)
      expect(f.racerCount, 'racers on the grid').toBeGreaterThanOrEqual(2)
      if (edition === 'anniversary') {
        expect(f.player.visible, "the player's trails draw in third person").toBe(true)
        expect(f.player.triangles).toBeGreaterThan(0)
        expect(f.player.peakAlpha).toBeGreaterThan(0)
        expect(f.racers.visible, "the racers' trails draw at speed").toBe(true)
        expect(f.racers.triangles).toBeGreaterThan(0)
        // Through the fog's door, which turns three's own fog off.
        expect(f.player.fog, 'fog door, not three fog').toBe(false)
        // DEV-358 follow-up: they GLOW (an HDR material colour) and each craft
        // wears its own tint. The player's is the orange: red over green over
        // blue, all of it light. The racers' batch holds more than one tint.
        expect(f.player.glow, 'the glow is HDR').toBeGreaterThan(1)
        expect(f.player.tints, 'one tint on the player').toHaveLength(1)
        const [r, g, b] = (f.player.tints[0] as string).split(',').map(Number) as [
          number,
          number,
          number,
        ]
        expect(r, 'orange: red leads').toBeGreaterThan(g)
        expect(g, 'orange: then green').toBeGreaterThan(b)
        expect(b, 'lightly: not the livery itself').toBeGreaterThan(0.25)
        expect(f.racers.tints.length, 'the racers wear different tints').toBeGreaterThan(1)
      } else {
        expect(f.player.visible, 'Classic draws no trails').toBe(false)
        expect(f.racers.visible, 'Classic draws no trails').toBe(false)
        expect(f.player.triangles + f.racers.triangles).toBe(0)
      }
      await shoot(page, `frozen-third-${edition}-${SNAP_AT}s`)
      expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])

      if (edition !== 'anniversary') return
      // ── the cost of ONE frame: drawn with the batches, without, with ────
      //
      // All three in ONE synchronous evaluate, so no game frame runs between
      // them and the only difference is the two meshes. Both ON draws must
      // agree, or something else moved and the difference means nothing.
      const cost = await page.evaluate(() => {
        type Info = { render: { calls: number; triangles: number } }
        type O = { name?: string; visible: boolean; traverse(fn: (o: O) => void): void }
        const w = globalThis as unknown as {
          __ff2: {
            render: {
              renderer: { info: Info; render(s: unknown, c: unknown): void }
              scene: O
              camera: unknown
            }
          }
        }
        const { renderer, scene, camera } = w.__ff2.render
        const batches: O[] = []
        scene.traverse((o) => {
          if (o.name?.startsWith('wing-trails:')) batches.push(o)
        })
        const draw = () => {
          renderer.render(scene, camera)
          return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }
        }
        const on = draw()
        const was = batches.map((b) => b.visible)
        for (const b of batches) b.visible = false
        const off = draw()
        batches.forEach((b, i) => {
          b.visible = was[i] as boolean
        })
        return { on, off, again: draw(), batches: batches.length }
      })
      console.info(
        `wing-trails cost @ ${SNAP_AT}s: ON ${cost.on.calls} calls / ${cost.on.triangles} tris · ` +
          `OFF ${cost.off.calls} / ${cost.off.triangles} · ON ${cost.again.calls} / ${cost.again.triangles} · ` +
          `batches ${f.player.triangles} + ${f.racers.triangles} tris`,
      )
      expect(cost.batches, 'two batches: the player, and every racer').toBe(2)
      expect(cost.again, 'the two ON draws agree').toEqual(cost.on)
      // Two batches, one draw each, and exactly their own triangles.
      expect(cost.on.calls - cost.off.calls, 'one draw per batch').toBe(2)
      expect(cost.on.triangles - cost.off.triangles, "the batches' own triangles").toBe(
        f.player.triangles + f.racers.triangles,
      )

      // ── and the flag, through the route the Edition page takes ─────────
      await setWing(page, false)
      // The batches hide on the game's next frame, not on the flip.
      await page.waitForTimeout(500)
      const hidden = await facts(page)
      expect(hidden.player.visible || hidden.racers.visible, 'the flag hides both').toBe(false)
    })
  }

  // ── DEV-358 follow-up: the player Matt could not see ─────────────────────
  //
  // Matt: *"add a trail to the player in third person."* The player already
  // had one — and a player who does not hold boost flies at the unboosted
  // terminal speed, where DEV-358's fade gave exactly nothing. So this arm is
  // that player: NO autopilot, no input after the launch press, which is a
  // ship flying straight at cruise. Everything above uses the autopilot, which
  // boosts, and would pass whatever the fade said about cruise.
  //
  // What it measures is whether the trail READS: the frozen frame with the
  // trails, the same frame again (the noise floor: motes and water move on a
  // held sim), and the frame with the flag off. The trails are the pixels the
  // flag moves, and they must be many, bright, and far above the floor.
  test(`a player who never boosts, at cruise, third person · anniversary`, async ({ page }) => {
    await flyAtCruise(page, { camera: 'third' })
    const pinned = await drawState(page)
    const speed = await playerForwardSpeed(page)
    const f = await facts(page)
    console.info(
      `wing-trails cruise @ ${SNAP_AT}s: forward ${speed.toFixed(1)} m/s · player ${JSON.stringify(f.player)} · ${drawStateLine(pinned)}`,
    )
    // The premise: this IS a ship at its own cruising speed, not a boosted one.
    expect(speed, 'flying at the unboosted terminal speed').toBeGreaterThan(80)
    expect(speed, 'and not boosting').toBeLessThan(100)
    expect(f.player.visible, "the player's trails draw at cruise").toBe(true)
    expect(f.player.peakAlpha, 'whole at cruise, at the default slider').toBeGreaterThan(0.4)

    // WHERE the trail is on screen: its centre line, projected through the
    // camera that drew the frame. Read before the flag goes off, because the
    // flag drops the ribbon's history.
    const line = await centreLineOnScreen(page, 'wing-trails:player')
    const on = decodePng(await shoot(page, `cruise-third-on-${SNAP_AT}s`)) as Frame
    await page.waitForTimeout(500)
    const again = decodePng(await shoot(page, `cruise-third-control-${SNAP_AT}s`)) as Frame
    await setWing(page, false)
    await page.waitForTimeout(500)
    expect((await facts(page)).player.visible, 'the flag hid them').toBe(false)
    const off = decodePng(await shoot(page, `cruise-third-off-${SNAP_AT}s`)) as Frame
    // Sampled ON the line, not over the frame: the sea is animated on a held
    // sim and moves tens of thousands of pixels between two identical frames.
    const trail = riseAlong(on, off, line)
    const noise = riseAlong(on, again, line)
    const whole = moved(on, off)
    console.info(
      `wing-trails cruise pixels: ${line.length} centre-line samples on screen · ` +
        `rise over the flag-off frame: median ${trail.median.toFixed(0)}/255, ` +
        `${(100 * trail.brighterShare).toFixed(0)} % of samples up by ${RISE}+ · ` +
        `same samples, two ON frames: median ${noise.median.toFixed(0)} · ` +
        `whole frame: ${whole.pixels} px moved (sea included)`,
    )
    expect(line.length, 'the trail is on screen').toBeGreaterThan(MIN_LINE_SAMPLES)
    expect(trail.median, 'the trail brightens the line it draws').toBeGreaterThan(MIN_MEDIAN_RISE)
    expect(trail.brighterShare, 'along most of its length').toBeGreaterThan(0.6)
    expect(Math.abs(noise.median), 'and the frame itself did not move there').toBeLessThan(RISE / 2)
    expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])
  })

  // ── DEV-358 follow-up, 2026-09-25: from the SEAT ──────────────────────────
  //
  // Matt: *"i wanna see the wing tip trails from the cockpit."* The same player
  // at cruise, in the cockpit (no `camera=third`), so the premise is the one
  // the flag decides: the player's batch draws from the seat at all. With
  // `fromCockpit` false it is hidden here, whatever the speed.
  //
  // Then whether it dazzles (it cannot: behind the beam, capped at the preset's
  // 0.8 degrees, metres from the eye) and what READS. The tips' trailing
  // corners are beside and behind the eye, so from the seat the trail is over
  // the shoulder: this arm LOOKS for it the way a flat player does, with the
  // mouse (pointer captured by a click on the canvas's left edge, then dragged
  // right towards the free look's yaw clamp; a one-pixel nudge before each shot
  // resets the look's return timer). What it finds is a short bright stub at
  // the tip: the cockpit's sill hides the rest of the ribbon from the eye.
  test(`a player who never boosts, at cruise, FROM THE SEAT · anniversary`, async ({ page }) => {
    await flyAtCruise(page, {})
    const pinned = await drawState(page)
    const speed = await playerForwardSpeed(page)
    const f = await facts(page)
    const seat = await seatGeometry(page)
    console.info(
      `wing-trails seat @ ${SNAP_AT}s: forward ${speed.toFixed(1)} m/s · player ${JSON.stringify(f.player)} · ` +
        `seat ${JSON.stringify(seat)} · ${drawStateLine(pinned)}`,
    )
    expect(speed, 'flying at the unboosted terminal speed').toBeGreaterThan(80)
    expect(speed, 'and not boosting').toBeLessThan(100)
    // THE premise: the flag this follow-up turned on.
    expect(f.player.visible, "the player's trails draw from the seat").toBe(true)
    expect(f.player.peakAlpha, 'whole at cruise, at the default slider').toBeGreaterThan(0.4)
    // Where they are from the seat: behind the beam, never in the forward view.
    expect(seat.points, 'centre-line points').toBeGreaterThan(MIN_LINE_SAMPLES)
    expect(seat.bearingDeg.min, 'the head of the trail is abeam or behind').toBeGreaterThan(80)
    // No dazzle: never wider than the preset's cap at the eye (a hair over,
    // for the float arithmetic), and never close enough for the near fade.
    expect(seat.widestDeg, 'the width cap holds from the seat').toBeLessThanOrEqual(0.8 * 1.01)
    expect(seat.nearestM, 'the trail keeps its distance from the eye').toBeGreaterThan(2)

    // ── look over the right shoulder, and photograph it ────────────────
    const box = await page.locator('#viewport').boundingBox()
    if (!box) throw new Error('wing-trails: no canvas box')
    const y = box.y + box.height / 2
    // The click that captures the pointer is a player's click; it is spent by
    // the capture (`input/look.ts`), and with the ship flying A means nothing.
    await page.mouse.click(box.x + 12, y)
    await expect.poll(() => pointerIsLocked(page), { timeout: 5_000 }).toBe(true)
    let x = box.x + 12
    for (let i = 0; i < 12; i++) {
      x += (box.width - 40) / 12
      await page.mouse.move(x, y)
    }
    const nudge = async (): Promise<void> => {
      x += 1
      await page.mouse.move(x, y)
      await page.waitForTimeout(120)
    }
    await nudge()
    // The capture held through the sweep. A window that loses OS focus loses
    // its capture, and with it the rest of the sweep: four headed windows
    // contend for that focus (four-wide, this spec has failed to take the
    // capture at all). The 0.21.0 gate read 18 and -15 degrees four-wide, and
    // the clamp alone at 9da78f59 and at 0.21.0 (w43-triage). Checked here, so
    // a lost capture says so rather than reading as a look that turns less.
    expect(await pointerIsLocked(page), 'the capture held through the sweep').toBe(true)
    // How far right the free look actually turned, in degrees (its yaw is the
    // camera's LOCAL rotation under the rig; negative is right).
    const lookYawDeg = await page.evaluate(
      () =>
        (-(globalThis as unknown as { __ff2: { render: { camera: { rotation: { y: number } } } } })
          .__ff2.render.camera.rotation.y *
          180) /
        Math.PI,
    )
    const line = await centreLineOnScreen(page, 'wing-trails:player')
    const on = decodePng(await shoot(page, `cruise-seat-on-${SNAP_AT}s`)) as Frame
    await nudge()
    const again = decodePng(await shoot(page, `cruise-seat-control-${SNAP_AT}s`)) as Frame
    await setWing(page, false)
    await nudge()
    await page.waitForTimeout(300)
    await nudge()
    expect((await facts(page)).player.visible, 'the flag hid them').toBe(false)
    const off = decodePng(await shoot(page, `cruise-seat-off-${SNAP_AT}s`)) as Frame
    const trail = riseAlong(on, off, line)
    const noise = riseAlong(on, again, line)
    console.info(
      `wing-trails seat pixels: looking ${lookYawDeg.toFixed(1)} deg right · ` +
        `${line.length} centre-line samples in view · ` +
        `rise over the flag-off frame: median ${trail.median.toFixed(0)}/255, ` +
        `${Math.round(trail.brighterShare * line.length)} of them up by ${RISE}+ · ` +
        `same samples, two ON frames: median ${noise.median.toFixed(0)}`,
    )
    // What the seat SEES, and it is less than the flag promises: the ribbon's
    // head at the tip reads, as a short bright stub, and then the cockpit's own
    // sill is between the eye and the rest of it (the samples in view that do
    // not brighten are behind it; the photographs show it). So the claim is the
    // stub, not the line: at least one sample in view is brightened, and the
    // two ON frames agree there.
    expect(lookYawDeg, 'the look reached over the shoulder').toBeGreaterThan(60)
    expect(line.length, 'the head of the trail is in view').toBeGreaterThan(0)
    expect(trail.brighterShare * line.length, 'the stub at the tip reads').toBeGreaterThanOrEqual(1)
    expect(Math.abs(noise.median), 'and the view held still between shots').toBeLessThan(RISE / 2)
    expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])
  })
})
