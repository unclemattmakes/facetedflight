/**
 * tests/e2e/jumpseat-arrow.spec.ts — the arrow to the next pad, on a JumpSeat.
 * DEV-360 follow-up.
 *
 * Matt, 2026-09-25, on DEV-360's fuel dome: *"JumpSeat gauge only, and the
 * arrow to the next pad must be there."* DEV-360 took the JumpSeat's readout
 * down to 2016's one instrument, and the question was whether the next-target
 * arrow (DEV-124, `render/next-gate-arrow.ts`; the nearest open pad on this
 * vehicle, `game/next-target.ts`) went with the rows. It did not: it is its own
 * object on the ship, and `jumpseat-flight.ts` builds and mounts it. This spec
 * is the proof on the frame, not in the scene graph alone:
 *
 *   1. On a JumpSeat course, Anniversary, frozen mid-run: the arrow's node is
 *      drawn and whole (grown past the cone), and its base and tip project ON
 *      the screen. Which pad, and the aim, are the unit files' (below).
 *   2. It is SEEN: the frame with the arrow and the same frame with the
 *      Anniversary flag off differ around its projected position, far above
 *      the same box across two frames with it on. A node that is "visible"
 *      and hidden behind the cowl, or under the dome, would pass (1) and fail
 *      this.
 *
 * Why unit tests are not enough: `next-target.test.ts` proves which pad is
 * next, and `next-gate-arrow.test.ts` proves the aim. Neither can see the
 * cockpit, the dome (a `depthTest: false` panel drawn after everything) or the
 * orange cowl, which are the three things DEV-360 moved around the arrow.
 *
 *   JUMPSEAT_ARROW_DIR=<dir> E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/jumpseat-arrow.spec.ts --workers 1
 *
 * PINNED (DEV-245), with the pin in every file name. `@gpu`, headed, hydrated.
 */

import path from 'node:path'
import { decodePng } from '../../tools/perf/png-diff.mjs'
import { flyToFreeze } from './fixtures/freeze'
import { viewportPhotographer } from './fixtures/photo'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.JUMPSEAT_ARROW_DIR ?? path.join('test-results', 'jumpseat-arrow')
const PIN_PARAMS: Readonly<Record<string, string>> = Object.fromEntries(new URLSearchParams(PINNED))
const PIN_TAG = PINNED.replace(/[=&]/g, '')
/**
 * The courses and the mission second to freeze each at. A moment where the
 * next pad is well off the nose, so the arrow is grown and lies ACROSS the
 * view rather than along it (an arrow aimed down the sightline is a diamond:
 * still there, just not a picture of an arrow).
 */
const CASES: readonly (readonly [string, number])[] = [
  ['rookie_01_jumpSeat', 12],
  ['int_01_jumpSeat', 8],
]

interface Frame {
  readonly w: number
  readonly h: number
  readonly ch: number
  readonly data: Uint8Array
}

interface ArrowFacts {
  readonly found: boolean
  readonly visible: boolean
  /** The group's scale: `lengthMetres` times the growth, so whole is the preset's length. */
  readonly scale: number
  /** Base and tip in canvas pixels, or null off screen / behind the camera. */
  readonly base: readonly [number, number] | null
  readonly tip: readonly [number, number] | null
  /** The preset's `lengthMetres`: what `scale` is when the arrow is whole. */
  readonly lengthMetres: number
}

const arrowFacts = (page: Page): Promise<ArrowFacts> =>
  page.evaluate(() => {
    type V = {
      set(x: number, y: number, z: number): V
      setFromMatrixPosition(m: unknown): V
      project(c: unknown): V
      x: number
      y: number
      z: number
    }
    type O = {
      name?: string
      visible?: boolean
      scale?: { x: number }
      position: { constructor: new () => V }
      matrixWorld: unknown
      children?: O[]
      traverse?: (fn: (o: O) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2: {
        render: { scene: O; camera: unknown; renderer: { domElement: HTMLCanvasElement } }
        edition: { current: { hud: { nextGateArrow: { lengthMetres: number } } } }
      }
    }
    const { scene, camera, renderer } = w.__ff2.render
    const lengthMetres = w.__ff2.edition.current.hud.nextGateArrow.lengthMetres
    let arrow: O | null = null
    scene.traverse?.((o) => {
      if (o.name === 'next-gate-arrow') arrow = o
    })
    const a = arrow as O | null
    if (!a) return { found: false, visible: false, scale: 0, base: null, tip: null, lengthMetres }
    const child = (n: string) => a.children?.find((c) => c.name === n) ?? null
    const Vec = a.position.constructor
    const width = renderer.domElement.clientWidth
    const height = renderer.domElement.clientHeight
    const screen = (o: O | null): [number, number] | null => {
      if (!o) return null
      const p = new Vec().setFromMatrixPosition(o.matrixWorld).project(camera)
      if (p.z < -1 || p.z > 1) return null
      const x = ((p.x + 1) / 2) * width
      const y = ((1 - p.y) / 2) * height
      return x < 0 || y < 0 || x >= width || y >= height ? null : [x, y]
    }
    return {
      found: true,
      visible: a.visible === true,
      scale: a.scale?.x ?? 0,
      base: screen(child('base')),
      tip: screen(child('tip')),
      lengthMetres,
    }
  })

const setArrow = (page: Page, enabled: boolean) =>
  page.evaluate((on) => {
    const w = globalThis as unknown as {
      __ff2: { edition: { current: unknown; setPreset(e: unknown): void } }
    }
    const next = structuredClone(w.__ff2.edition.current) as {
      hud: { nextGateArrow: { enabled: boolean } }
    }
    next.hud.nextGateArrow.enabled = on
    w.__ff2.edition.setPreset(next)
  }, enabled)

const photograph = viewportPhotographer(OUT, PIN_TAG)
const shoot = async (page: Page, name: string): Promise<Frame> =>
  decodePng(await photograph(page, name)) as Frame

/** Pixels inside `box` that moved by more than 24 levels on some channel (`png-diff.mjs`'s bar). */
const movedIn = (
  a: Frame,
  b: Frame,
  box: { x0: number; y0: number; x1: number; y1: number },
): number => {
  let n = 0
  for (let y = Math.max(0, box.y0); y < Math.min(a.h, box.y1); y++) {
    for (let x = Math.max(0, box.x0); x < Math.min(a.w, box.x1); x++) {
      const o = (y * a.w + x) * a.ch
      let d = 0
      for (let k = 0; k < 3; k++) {
        d = Math.max(d, Math.abs((a.data[o + k] as number) - (b.data[o + k] as number)))
      }
      if (d > 24) n++
    }
  }
  return n
}

test.describe('@gpu DEV-360 follow-up: the arrow to the next pad, on a JumpSeat', () => {
  test.setTimeout(600_000)

  for (const [mission, snapAt] of CASES) {
    test(`${mission}, frozen at ${snapAt} s · anniversary`, async ({ page }) => {
      await flyToFreeze(page, {
        mission,
        edition: 'anniversary',
        snapAt,
        params: { ...PIN_PARAMS },
      })
      const pinned = await drawState(page)
      const f = await arrowFacts(page)
      console.info(
        `jumpseat-arrow ${mission} @ ${snapAt}s: ${JSON.stringify(f)} · ${drawStateLine(pinned)}`,
      )

      // (1) Drawn, whole, and on screen.
      expect(f.found, 'the arrow is built on the JumpSeat').toBe(true)
      expect(f.visible, 'and drawn: a pad is open and off the nose').toBe(true)
      expect(f.scale, 'grown past the cone: the whole length').toBeCloseTo(f.lengthMetres, 6)
      expect(f.base, 'its base is on screen').not.toBeNull()
      expect(f.tip, 'its tip is on screen').not.toBeNull()
      const base = f.base as readonly [number, number]
      const tip = f.tip as readonly [number, number]
      const lengthPx = Math.hypot(tip[0] - base[0], tip[1] - base[1])

      // (2) SEEN: the box around it, with the arrow, without, and with again.
      const box = {
        x0: Math.floor(Math.min(base[0], tip[0])) - 16,
        y0: Math.floor(Math.min(base[1], tip[1])) - 16,
        x1: Math.ceil(Math.max(base[0], tip[0])) + 16,
        y1: Math.ceil(Math.max(base[1], tip[1])) + 16,
      }
      const on = await shoot(page, `${mission}-${snapAt}s-arrow-on`)
      await page.waitForTimeout(300)
      const again = await shoot(page, `${mission}-${snapAt}s-arrow-control`)
      await setArrow(page, false)
      await page.waitForTimeout(500)
      expect((await arrowFacts(page)).visible, 'the flag hid it').toBe(false)
      const off = await shoot(page, `${mission}-${snapAt}s-arrow-off`)
      const arrowPx = movedIn(on, off, box)
      const noisePx = movedIn(on, again, box)
      console.info(
        `jumpseat-arrow ${mission} pixels: ${lengthPx.toFixed(0)} px base to tip on screen · ` +
          `box ${box.x1 - box.x0} x ${box.y1 - box.y0} · ${arrowPx} px moved with the arrow off · ` +
          `${noisePx} px across two frames with it on`,
      )
      expect(arrowPx, 'the arrow is SEEN, not only in the graph').toBeGreaterThan(40)
      expect(noisePx, 'and the frame held still there').toBeLessThan(arrowPx / 4)
      expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])
    })
  }
})
