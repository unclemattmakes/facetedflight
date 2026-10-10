/**
 * tests/e2e/lift-judder.spec.ts — the deck you ride holds still under you (DEV-445).
 *
 * Matt, 2026-09-27: *"the "elevator" model is very jittery during the elevator
 * ride up."*
 *
 * ── What judder IS here, as a number ─────────────────────────────────────
 *
 * The eye rides the ship, and the ship rides the deck. So on a smooth ride the
 * height of the eye above the deck is a CONSTANT, frame after frame, whatever
 * the lift's speed; judder is that height moving. Measured per rendered frame,
 * in WORLD space (the camera is a child of the rig: CLAUDE.md, trap 18), from
 * the press to the release: the eye (`render.camera`), the rig, the ship's
 * group, the lift's group (`elevator-platform`), 2016's deck
 * (`elevator-deck-2016`, DEV-438), the generated deck it hides, the static
 * shaft, and the sim's own `launch.rise`. The assertion is on the largest
 * frame-to-frame change of eye minus deck.
 *
 * ── The frame rate is the variable, so the harness names it ──────────────
 *
 * The sim steps at 81.967 Hz (`FIXED_DT`, D4) and the render interpolates.
 * Something drawn at the sim's CURRENT step beside something drawn at the
 * interpolated pose disagrees by `(1 - alpha)` of a step — and `alpha` holds
 * still only when the display runs at the sim's rate. At 60, 90 and 120 Hz it
 * beats against the step, so the disagreement saws; at 81.967 Hz it does not.
 * A judder present at the three beating rates and absent at the sim's own is
 * that signature, and nothing else produces it.
 *
 * This box's display runs at its own rate, so a PACER stands between the page
 * and the display: an init script that hands `requestAnimationFrame`'s
 * callbacks a clock advancing exactly `1000 / hz` ms per frame, one frame per
 * real frame. The game runs the same code on the same path; the only thing
 * that changes is the clock its frames arrive with, which is exactly what a
 * display of that rate changes. The last case runs with no pacer at all, from
 * the title, the way a player gets there — the display's own rate on the route
 * a human takes (AGENT-NOTES §8).
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/lift-judder.spec.ts
 *
 * `LIFT_JUDDER_OUT=<dir>` writes every frame of every ride as CSV.
 *
 * `@gpu`: a real world and hydrated `public/assets`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady, missionReady } from './fixtures/boot'
import { dropFocus, focusCanvas } from './fixtures/canvas'
import { board, hangarAim, hold, INT_01_HOVERJET, throughDoors } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

test.describe.configure({ timeout: 420_000 })

const MISSION = 'int_01_hoverJet'

/**
 * The largest frame-to-frame change in the eye's height over the deck, metres.
 *
 * On a correct ride the two are placed from one interpolated number and the
 * change is float noise (1e-12 m). The bug moves it by up to one sim step of
 * the lift, up to 0.20 m at the clip's 16.6 m/s peak. A
 * millimetre sits four orders of magnitude from both.
 */
const JUDDER_BOUND_M = 0.001

/** The sim's own rate: one step per frame, so `alpha` never moves. The control. */
const SIM_HZ = 1000 / 12.1999998

/** Installed before any page script. See the header. */
const installPacer = () => {
  const realRaf = window.requestAnimationFrame.bind(window)
  const queue = new Map<number, FrameRequestCallback>()
  let nextId = 1
  let pending = 0
  let hz = 0
  let synth = 0
  let last = 0
  const pace = {
    set(rate: number) {
      hz = rate
      synth = last
    },
    after: null as ((time: number) => void) | null,
  }
  const tick = (real: number) => {
    pending = 0
    synth = hz > 0 ? synth + 1000 / hz : real
    const time = synth
    last = time
    const due = [...queue.values()]
    queue.clear()
    for (const cb of due) {
      try {
        cb(time)
      } catch (error) {
        setTimeout(() => {
          throw error
        })
      }
    }
    pace.after?.(time)
    // ONE real request outstanding, ever. A callback that re-requests (three's
    // loop does, every frame) has already made it; a second here would double
    // the ticks every frame until the page stops.
    if (!pending && (queue.size > 0 || pace.after)) pending = realRaf(tick)
  }
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++
    queue.set(id, cb)
    if (!pending) pending = realRaf(tick)
    return id
  }
  window.cancelAnimationFrame = (id: number) => {
    queue.delete(id)
  }
  ;(globalThis as unknown as { __pace: typeof pace }).__pace = pace
}

/** One rendered frame: the page's clock, then world heights. */
type Row = [
  time: number,
  phase: string,
  rise: number,
  eye: number,
  rig: number,
  ship: number,
  lift: number,
  deck2016: number,
  deckGenerated: number,
  shaft: number,
  anchor: number,
]

const COLUMNS =
  'time_ms,phase,sim_rise,eye_y,rig_y,ship_y,lift_y,deck2016_y,deck_generated_y,shaft2016_y,anchor_y'

/** Record every frame from now until the lift lets go, then a few more. */
const recordRide = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const ff = (globalThis as any).__ff2
    // biome-ignore lint/suspicious/noExplicitAny: the pacer's handle
    const pace = (globalThis as any).__pace
    const scene = ff.render.scene
    // biome-ignore lint/suspicious/noExplicitAny: scene nodes
    const find = (name: string): any => {
      // biome-ignore lint/suspicious/noExplicitAny: scene nodes
      let hit: any = null
      // biome-ignore lint/suspicious/noExplicitAny: scene nodes
      scene.traverse((o: any) => {
        if (!hit && o.name === name) hit = o
      })
      return hit
    }
    const lift = find('elevator-platform')
    const deck2016 = find('elevator-deck-2016')
    const shaft = find('elevator-shaft-2016')
    const anchor = find('launch-anchor')
    // The generated slab is the platform's first unnamed mesh (`createElevator`).
    // biome-ignore lint/suspicious/noExplicitAny: scene nodes
    const deckGenerated = lift?.children.find((c: any) => c.isMesh && c.name === '') ?? null
    const ship = ff.flight()?.object
    const camera = ff.render.camera
    const rig = ff.render.rig
    if (!lift || !anchor || !ship || !camera) return false
    const v = camera.position.clone()
    // biome-ignore lint/suspicious/noExplicitAny: scene nodes
    const y = (o: any): number => (o ? o.getWorldPosition(v).y : Number.NaN)
    const rows: unknown[][] = []
    let tail = -1
    ;(globalThis as unknown as { __ride: unknown[][] }).__ride = rows
    pace.after = (time: number) => {
      const l = ff.launch()
      rows.push([
        time,
        l.phase,
        l.rise,
        y(camera),
        y(rig),
        y(ship),
        y(lift),
        y(deck2016),
        y(deckGenerated),
        y(shaft),
        y(anchor),
      ])
      if (l.phase === 'flying' && tail < 0) tail = 10
      if (tail > 0 && --tail === 0) pace.after = null
    }
    return true
  })

const rideRows = async (page: Page): Promise<Row[]> => {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          // biome-ignore lint/suspicious/noExplicitAny: the pacer's handle
          return (globalThis as any).__pace.after === null
        }),
      { timeout: 180_000, intervals: [250] },
    )
    .toBe(true)
  return page.evaluate(() => (globalThis as unknown as { __ride: Row[] }).__ride)
}

interface Judder {
  /** Frames the lift held the ship and was moving, of all recorded. */
  readonly frames: number
  /** 2016's deck and the generated one were both found and measured on every held frame. */
  readonly bothDecks: boolean
  /** Largest frame-to-frame change of eye minus 2016's deck, metres. */
  readonly eyeOverDeck: number
  /** The same against the generated deck (DEV-438's fallback, hidden). */
  readonly eyeOverGenerated: number
  /** The same against the lift's group, which carries both. */
  readonly eyeOverLift: number
  /** Largest |deck's rendered rise - the sim's rise|: 0 when the deck is drawn at the step. */
  readonly deckVsSim: number
  /** Largest |ship's rendered rise - the sim's rise|: the interpolation's lag. */
  readonly shipVsSim: number
  /** Largest frame-to-frame change of eye minus rig (the camera is the rig's child). */
  readonly eyeOverRig: number
  /** The shaft's travel over the ride. It is static; this is 0. */
  readonly shaftTravel: number
  /** Rendered rise at the first and last held frame. */
  readonly span: readonly [number, number]
}

const judderOf = (rows: readonly Row[]): Judder => {
  // Held and moving: from the first frame the sim has left the floor to the
  // last frame before the release. The countdown holds at the top and is in.
  const held = rows.filter(([, phase, rise]) => phase !== 'flying' && rise > 0)
  const maxStep = (f: (r: Row) => number): number => {
    let worst = 0
    for (let i = 1; i < held.length; i++) {
      worst = Math.max(worst, Math.abs(f(held[i] as Row) - f(held[i - 1] as Row)))
    }
    return worst
  }
  // The heights over the anchor AT REST, from a frame on the floor before the
  // press: nothing is moving, so nothing is interpolated, and both read exact.
  const rest = rows.find(([, phase]) => phase === 'waiting')
  const first = held[0]
  const lift0 = rest ? rest[6] - rest[10] : Number.NaN
  const ship0 = rest ? rest[5] - rest[10] : Number.NaN
  let deckVsSim = 0
  let shipVsSim = 0
  let shaftLo = Number.POSITIVE_INFINITY
  let shaftHi = Number.NEGATIVE_INFINITY
  for (const r of held) {
    deckVsSim = Math.max(deckVsSim, Math.abs(r[6] - r[10] - lift0 - r[2]))
    shipVsSim = Math.max(shipVsSim, Math.abs(r[5] - r[10] - ship0 - r[2]))
    if (Number.isFinite(r[9])) {
      shaftLo = Math.min(shaftLo, r[9])
      shaftHi = Math.max(shaftHi, r[9])
    }
  }
  const last = held.at(-1)
  return {
    frames: held.length,
    bothDecks: held.every((r) => Number.isFinite(r[7]) && Number.isFinite(r[8])),
    eyeOverDeck: maxStep((r) => r[3] - r[7]),
    eyeOverGenerated: maxStep((r) => r[3] - r[8]),
    eyeOverLift: maxStep((r) => r[3] - r[6]),
    deckVsSim,
    shipVsSim,
    eyeOverRig: maxStep((r) => r[3] - r[4]),
    shaftTravel: Number.isFinite(shaftHi) ? shaftHi - shaftLo : Number.NaN,
    span: [first ? first[5] - first[10] - ship0 : 0, last ? last[5] - last[10] - ship0 : 0],
  }
}

const report = (label: string, rows: readonly Row[], j: Judder): void => {
  const mm = (m: number) => `${(m * 1000).toFixed(3)} mm`
  console.log(
    `[DEV-445] ${label}: ${j.frames} held frames of ${rows.length}, rise ${j.span[0].toFixed(2)}..${j.span[1].toFixed(2)} m · ` +
      `eye-over-deck step max ${mm(j.eyeOverDeck)} (2016 deck) · ${mm(j.eyeOverGenerated)} (generated deck) · ${mm(j.eyeOverLift)} (lift group) · ` +
      `deck vs sim ${mm(j.deckVsSim)} · ship vs sim ${mm(j.shipVsSim)} · eye vs rig ${mm(j.eyeOverRig)} · shaft travel ${mm(j.shaftTravel)}`,
  )
  const dir = process.env.LIFT_JUDDER_OUT
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `lift-judder-${label.replace(/[^a-z0-9.-]+/gi, '_')}.csv`)
    fs.writeFileSync(file, `${COLUMNS}\n${rows.map((r) => r.join(',')).join('\n')}\n`)
  }
}

const assertSmooth = (label: string, j: Judder): void => {
  expect(j.frames, `${label}: the ride was recorded`).toBeGreaterThan(200)
  expect(j.span[1], `${label}: it reached the top`).toBeGreaterThan(106)
  // A deck that is not there measures NaN, and a NaN compares false against
  // any bound; so presence first, or an unloaded deck would read as smooth.
  expect(j.bothDecks, `${label}: 2016's deck stood and the generated one is still carried`).toBe(
    true,
  )
  // What this row is: the eye holds its height over the deck, frame to frame.
  expect(
    j.eyeOverDeck,
    `${label}: eye over 2016's deck, largest frame-to-frame change`,
  ).toBeLessThan(JUDDER_BOUND_M)
  expect(
    j.eyeOverGenerated,
    `${label}: eye over the generated deck, largest frame-to-frame change`,
  ).toBeLessThan(JUDDER_BOUND_M)
  // The other things that ride: the camera is the rig's, and the shaft stands.
  expect(j.eyeOverRig, `${label}: the camera rides the rig`).toBeLessThan(JUDDER_BOUND_M)
  expect(j.shaftTravel, `${label}: the shaft does not move`).toBeLessThan(JUDDER_BOUND_M)
}

test.describe('@gpu the lift ride holds the deck under the eye (DEV-445)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installPacer)
  })

  for (const [label, hz] of [
    ['60 Hz', 60],
    ['90 Hz', 90],
    ['120 Hz', 120],
    ['81.967 Hz (the sim)', SIM_HZ],
  ] as const) {
    test(`${MISSION} ridden at ${label}`, async ({ page }) => {
      await page.goto(`/?mission=${MISSION}&xr=off&title=0&menu=0&${PINNED}`)
      await firstPress(page)
      await missionReady(page, 240_000)
      await focusCanvas(page)
      await page.waitForTimeout(2_000)
      await page.evaluate((rate) => {
        // biome-ignore lint/suspicious/noExplicitAny: the pacer's handle
        ;(globalThis as any).__pace.set(rate)
      }, hz)
      expect(await recordRide(page), 'the lift, the ship and the eye are in the scene').toBe(true)
      await hold(page, 'Enter', 100)
      const rows = await rideRows(page)
      const j = judderOf(rows)
      report(`${MISSION} ${label}`, rows, j)
      assertSmooth(label, j)
    })
  }

  test(`${MISSION} ridden from the title at the display's own rate`, async ({ page }) => {
    await page.goto(`/?xr=off&${PINNED}`)
    await firstPress(page)
    await bootReady(page, 240_000)
    await dropFocus(page)
    await page.waitForTimeout(1_200)
    await hold(page, 'Enter')
    await throughDoors(page) // DEV-558: SINGLE PLAYER, to the aircraft
    expect((await hangarAim(page))?.view, 'in the room').toBe('vehicles')
    await board(page, INT_01_HOVERJET)
    await page.waitForTimeout(1_500)
    expect(await recordRide(page), 'the lift, the ship and the eye are in the scene').toBe(true)
    await hold(page, 'Enter', 100)
    const rows = await rideRows(page)
    const j = judderOf(rows)
    const gaps = rows.slice(1).map((r, i) => r[0] - (rows[i] as Row)[0])
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0
    report(`${MISSION} from the title, display ${(1000 / median).toFixed(1)} Hz`, rows, j)
    assertSmooth('the display', j)
  })
})
