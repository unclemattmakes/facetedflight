// tests/unit/level-select.test.ts — you choose the table you are looking at.
//
// The failure mode of a gaze menu is not that it looks wrong. It renders
// perfectly either way; you find out in a headset when you aim at "Rookie 1"
// and board "Advanced 2". `render/pause.ts` has the same hazard and the same
// answer — export the geometry, test the geometry — and this file is that
// applied to four tables on an arc instead of three rows on a plate.
//
// **Every assertion here is a distance or an angle**, never a quaternion and
// never a bearing constant read back to itself. The orientation lesson §4: *a
// rotation test says "this is the number I believed when I wrote it"; a
// geometry test says "the arm ends where the bar is", and that is true or false
// independently of what anyone believed.* So the separation between two tables
// is MEASURED from their positions rather than asserted to be the 30-degree
// bearing step — and it is not: both rays are pitched 22.5 degrees down, and
// yaw separation shrinks with pitch. The real figure is 27.7.
//
// The suite is `environment: 'node'`: nothing here builds a mesh, touches a
// canvas or imports three.

import { describe, expect, it } from 'vitest'
import {
  ARROW_GAZE_RADIUS,
  advanceDwell,
  arrowBearing,
  arrowLocal,
  GAZE_RADIUS,
  HANGAR_VIEWS,
  HOLO_REACH,
  labelLocal,
  labelYaw,
  MODEL_SIZE,
  PAGE_DWELL_SECONDS,
  pickNearestSphere,
  SEAT_EYE_HEIGHT,
  SEAT_REST_BEARING,
  seatEyeLocal,
  seatPitchLocal,
  seatYawLocal,
  stepBearings,
  TABLE_BEARING_STEP,
  TABLE_TOP,
  TABLES_PER_PAGE,
  tableBearings,
  tableGazeLocal,
  tableLocal,
  wrapPage,
} from '@/render/hangar'
import { type HangarSpec, hangarSpecFor } from '@/sim/hangar'

/** `int_01`'s real numbers: a 9.35 x 9.28 m platform, 12 m shaft segments. */
const SPEC: HangarSpec = hangarSpecFor(9.35 / 2, 12)

type P = { x: number; y: number; z: number }
const eye = (): P => seatEyeLocal(SPEC)

const sub = (a: P, b: P): [number, number, number] => [a.x - b.x, a.y - b.y, a.z - b.z]
const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}
const dot = (a: readonly number[], b: readonly number[]) =>
  (a[0] as number) * (b[0] as number) +
  (a[1] as number) * (b[1] as number) +
  (a[2] as number) * (b[2] as number)
const deg = (r: number) => (r * 180) / Math.PI
/** Angle between the look directions from the eye to two points, in degrees. */
const apart = (a: P, b: P) =>
  deg(Math.acos(Math.min(1, Math.max(-1, dot(norm(sub(a, eye())), norm(sub(b, eye())))))))
/** Slant range from the eye to a point. */
const range = (p: P) => Math.hypot(...sub(p, eye()))

const centres = (count = TABLES_PER_PAGE): [number, number, number][] =>
  tableBearings(count).map((b) => {
    const c = tableGazeLocal(SPEC, b)
    return [c.x, c.y, c.z]
  })

/** A ray from the eye towards a point. */
const rayAt = (target: P, count = TABLES_PER_PAGE, radius = GAZE_RADIUS) => {
  const e = eye()
  const d = norm(sub(target, e))
  return pickNearestSphere(e.x, e.y, e.z, d[0], d[1], d[2], centres(count), radius)
}

describe('the level select, as seen from the chair', () => {
  it('puts four tables on a 90-degree arc, all the same distance away', () => {
    // The arc is centred on the eye's own vertical axis, which is what makes
    // every number below hold for all four tables instead of for the middle
    // two. If a future layout moves one table nearer, the angular sizes stop
    // being comparable and the dead-band test below stops meaning anything.
    const bearings = tableBearings(TABLES_PER_PAGE)
    expect(bearings).toHaveLength(4)
    // DEV-858: symmetric about the EYE's resting line, so -45 and +45 off it.
    expect(deg((bearings[0] as number) - SEAT_REST_BEARING)).toBeCloseTo(-45, 6)
    expect(deg((bearings[3] as number) - SEAT_REST_BEARING)).toBeCloseTo(45, 6)
    const ranges = bearings.map((b) => range(tableGazeLocal(SPEC, b)))
    for (const r of ranges) expect(r).toBeCloseTo(ranges[0] as number, 6)
    // 1.551 m — INSIDE 2016's "holotables ring the seat at 1.35-1.56 m", which
    // is the measurement this whole arrangement is anchored to. The band is a
    // SLANT range to a table below the eye, so it is checked as one: the
    // single-table build met the horizontal reach and missed the band by 0.09 m.
    const drop = eye().y - tableGazeLocal(SPEC, 0).y
    expect(drop, 'eye to model centre').toBeCloseTo(0.6, 6)
    expect(drop).toBeLessThan(SEAT_EYE_HEIGHT - TABLE_TOP)
    expect(ranges[0] as number).toBeCloseTo(Math.hypot(HOLO_REACH, drop), 6)
    expect(ranges[0] as number).toBeGreaterThan(1.35)
    expect(ranges[0] as number).toBeLessThan(1.56)
  })

  it('leaves a DEAD BAND wider than the pause menu can hold', () => {
    // THE number. The pause menu sized its rows at 6 degrees because "a head
    // can hold 6 degrees comfortably and cannot reliably hold 3". Looking
    // between two tables must therefore be a thing a head can do on purpose.
    //
    // Measured, not assumed: the separation is the angle between the two look
    // directions, which is 27.7 and not the 30 of the bearing step.
    const bearings = tableBearings(TABLES_PER_PAGE)
    const a = tableGazeLocal(SPEC, bearings[1] as number)
    const b = tableGazeLocal(SPEC, bearings[2] as number)
    const separation = apart(a, b)
    expect(separation).toBeGreaterThan(27)
    expect(separation).toBeLessThan(28)
    // And it is NOT the bearing step, which is the mistake this guards.
    expect(separation).toBeLessThan(deg(TABLE_BEARING_STEP) - 1)

    const window = 2 * deg(Math.asin(GAZE_RADIUS / range(a)))
    expect(separation - window, 'dead band, degrees').toBeGreaterThan(6)
  })

  it('is FORGIVING — the window is wider than the model it guards', () => {
    // 2016's cast is a 0.125 m sphere, deliberately fat, "because a head is not
    // a mouse and an exact ray makes a small target unhittable". A window
    // NARROWER than the thing you can see would make the visible edges of the
    // model dead.
    const a = tableGazeLocal(SPEC, tableBearings(TABLES_PER_PAGE)[0] as number)
    const window = 2 * deg(Math.asin(GAZE_RADIUS / range(a)))
    const model = 2 * deg(Math.atan(MODEL_SIZE / 2 / range(a)))
    expect(window).toBeGreaterThan(model)
    // But not so fat it swallows the gap: half the neighbour spacing is the
    // ceiling, above which two windows overlap.
    const bearings = tableBearings(TABLES_PER_PAGE)
    const p = tableGazeLocal(SPEC, bearings[0] as number)
    const q = tableGazeLocal(SPEC, bearings[1] as number)
    const spacing = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
    expect(GAZE_RADIUS).toBeLessThan(spacing / 2)
  })

  it('picks the table you are looking at — all four of them', () => {
    // The round trip. A nearest-miss pick over four spheres has exactly one way
    // to go wrong that a single-table test cannot see: an off-by-one in which
    // sphere index maps to which mission, which renders perfectly and boards
    // the wrong ship.
    const bearings = tableBearings(TABLES_PER_PAGE)
    for (let i = 0; i < bearings.length; i++) {
      expect(rayAt(tableGazeLocal(SPEC, bearings[i] as number)), `table ${i}`).toBe(i)
    }
  })

  it('picks NOTHING when you look between two tables', () => {
    // Half way between neighbours, at the same height — the gap a player rests
    // in while deciding. If this comes back with an index, every glance across
    // the row selects something and "press A" becomes a trap.
    const bearings = tableBearings(TABLES_PER_PAGE)
    for (let i = 0; i + 1 < bearings.length; i++) {
      const mid = tableGazeLocal(SPEC, ((bearings[i] as number) + (bearings[i + 1] as number)) / 2)
      expect(rayAt(mid), `between ${i} and ${i + 1}`).toBe(-1)
    }
  })

  it('picks NOTHING behind you, and nothing above the tables', () => {
    const e = eye()
    // Straight back over your shoulder.
    expect(pickNearestSphere(e.x, e.y, e.z, 0, 0, 1, centres(), GAZE_RADIUS)).toBe(-1)
    // At the parked ship, which is level and dead ahead — the composition the
    // room is built around, and it must not be a button.
    expect(pickNearestSphere(e.x, e.y, e.z, 0, 0, -1, centres(), GAZE_RADIUS)).toBe(-1)
  })

  it('sits you down ON a table, for every page size a page can be', () => {
    // ── the sign, which is the only interesting thing here ────────────────
    //
    // `seatYawLocal` is a THREE YAW and `tableBearings` are BEARINGS, and one
    // is the negative of the other: `rotation.y = psi` sends three's forward
    // `(0, 0, -1)` to `(-sin psi, 0, -cos psi)`, while a table at bearing theta
    // sits at `(+sin theta, ., -cos theta)`. Orientation lesson §5b — not every
    // orientation bug is a wrong number; this species is two live conventions
    // in one file, both correct.
    //
    // So the guard is a MISS DISTANCE, not an equality: the resting ray is
    // built from three's convention and has to LAND on a table. Get the sign
    // wrong and it lands 30 degrees away and this fails by missing — which is
    // a fact about the geometry, not about what I believed the sign was.
    const e = eye()
    const psi = seatYawLocal()
    const pitch = seatPitchLocal()
    const dir: [number, number, number] = [
      -Math.sin(psi) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(psi) * Math.cos(pitch),
    ]
    // It is pointed DOWN at a table, not level at the ship.
    expect(deg(pitch)).toBeLessThan(-15)
    expect(deg(pitch)).toBeGreaterThan(-30)
    // DEV-858: an odd page lands the pointer on a table, dead centre; an even one
    // has the eye line BETWEEN its middle two (15 degrees from each, a ray no
    // table window takes), and the room's rest default takes the right-middle one
    // (`REST_GAP_RADIUS`, asserted in hangar-doors.test.ts).
    for (let count = 1; count <= TABLES_PER_PAGE; count++) {
      const hit = pickNearestSphere(e.x, e.y, e.z, ...dir, centres(count), GAZE_RADIUS)
      if (count % 2 === 1) {
        expect(hit, `a page of ${count} leaves the pointer on nothing`).toBeGreaterThanOrEqual(0)
        const c = tableGazeLocal(SPEC, tableBearings(count)[hit] as number)
        const off = deg(Math.acos(Math.min(1, dot(dir, norm(sub(c, e))))))
        expect(off, `page of ${count}: off centre by`).toBeLessThan(0.5)
      } else {
        expect(hit, `a page of ${count}: the pointer is in the gap`).toBe(-1)
        for (const k of [count / 2 - 1, count / 2]) {
          const c = tableGazeLocal(SPEC, tableBearings(count)[k] as number)
          const off = deg(Math.acos(Math.min(1, dot(dir, norm(sub(c, e))))))
          expect(off, `page of ${count}, middle table ${k}`).toBeGreaterThan(13)
          expect(off, `page of ${count}, middle table ${k}`).toBeLessThan(15.5)
        }
      }
    }
  })

  it('keeps the arc SYMMETRIC on a full page despite resting half a step left', () => {
    // The two requirements pull against each other: an even arc centred on the
    // forward has a gap in the middle, and the resting pointer would sit in it.
    // Offsetting the home bearing by half a step satisfies both — but only if
    // the half step is applied ONCE, which is why `tableBearings` floors.
    // DEV-858: about the EYE's line (-15 off the room's forward).
    const bearings = tableBearings(TABLES_PER_PAGE).map((b) => deg(b - SEAT_REST_BEARING))
    expect(bearings).toHaveLength(4)
    expect(bearings[0] as number).toBeCloseTo(-45, 6)
    expect(bearings[3] as number).toBeCloseTo(45, 6)
    expect((bearings[0] as number) + (bearings[3] as number)).toBeCloseTo(0, 6)
  })

  it('puts a page of ONE under the pointer rather than off at -45', () => {
    // Kauai ships a single mission. A layout that always used the four-table
    // bearings would hang it at the left-hand end of an empty arc.
    const solo = tableBearings(1)
    expect(solo).toHaveLength(1)
    expect(solo[0]).toBe(-seatYawLocal())
    expect(rayAt(tableGazeLocal(SPEC, solo[0] as number), 1)).toBe(0)
  })

  it('keeps the plinths out of each other — 0.11 m of floor between them', () => {
    // Geometry, not appearance: the plinth is 0.24 m at the top (0.48 across)
    // and neighbours are 0.75 m apart, so four tables read as four tables. The
    // single table's 0.46 m plinth would have overlapped by 0.17 m and read as
    // one bench.
    const bearings = tableBearings(TABLES_PER_PAGE)
    const a = tableLocal(SPEC, bearings[0] as number)
    const b = tableLocal(SPEC, bearings[1] as number)
    const gap = Math.hypot(a.x - b.x, a.z - b.z) - 2 * 0.24
    expect(gap).toBeGreaterThan(0.08)
  })

  it('keeps the PAGE PLATES three dead bands away from every table', () => {
    // The plates turn the page on a dwell, so a plate you can graze while
    // scanning the row turns pages by accident. They live low and close — in
    // your lap — and the guard is the angle, because that is what a head moves
    // through.
    //
    // EVERY bearing a step can lay a table at, not only the full page's: since
    // the DEV-379 follow-up the flight-plan step lays its arc centred on the
    // resting pointer (`stepBearings`), half a step left of the others.
    const bearings = [
      ...new Set(
        HANGAR_VIEWS.flatMap((view) =>
          Array.from({ length: TABLES_PER_PAGE }, (_, i) => stepBearings(view, i + 1)).flat(),
        ),
      ),
    ]
    expect(bearings.length, 'the premise: the plan step adds positions').toBeGreaterThan(
      TABLES_PER_PAGE,
    )
    for (const side of [-1, 1] as const) {
      const plate = arrowLocal(SPEC, side)
      // Well below the row: a deliberate look down, not a glance along it.
      expect(
        deg(Math.atan2(plate.y - eye().y, Math.hypot(plate.x, plate.z - eye().z))),
      ).toBeLessThan(-40)
      for (let i = 0; i < bearings.length; i++) {
        const table = tableGazeLocal(SPEC, bearings[i] as number)
        const separation = apart(plate, table)
        const halves =
          deg(Math.asin(ARROW_GAZE_RADIUS / range(plate))) +
          deg(Math.asin(GAZE_RADIUS / range(table)))
        expect(separation - halves, `plate ${side} vs table ${i}`).toBeGreaterThan(6)
      }
    }
    // And the two plates do not reach each other either.
    const l = arrowLocal(SPEC, -1)
    const r = arrowLocal(SPEC, 1)
    const gap = apart(l, r) - 2 * deg(Math.asin(ARROW_GAZE_RADIUS / range(l)))
    expect(gap, 'dead band between the plates').toBeGreaterThan(6)
  })

  it('wraps pages in BOTH directions', () => {
    // `%` is not modulo in JavaScript: `-1 % 4` is `-1`. The naive form makes
    // the page before the first unreachable and indexes the array with a
    // negative, which is `undefined` and an empty arc.
    expect(wrapPage(0, -1, 4)).toBe(3)
    expect(wrapPage(3, 1, 4)).toBe(0)
    expect(wrapPage(0, -5, 4)).toBe(3)
    expect(wrapPage(0, 0, 0)).toBe(0)
  })

  it('does not turn pages while you are flying', () => {
    // THE trap-19 case, and the reason `advanceDwell` takes `gazed` at all.
    // `boot/app.ts` calls `update()` every frame of the game and `gaze()` only
    // while the menu is up, so a dwell that ignored the difference would keep
    // filling for a whole mission against the aim the last menu frame left
    // behind. The guard is "run a frame with no gaze and assert nothing moved".
    let held = 0
    for (let i = 0; i < 200; i++) {
      const step = advanceDwell(held, 1 / 90, true, false)
      held = step.held
      expect(step.turn, `frame ${i} turned a page with no gaze`).toBe(false)
      expect(held).toBe(0)
    }
  })

  it('turns ONE page per dwell, not one per frame after the first', () => {
    // A dwell that did not consume itself would page through all thirteen
    // missions in the two frames after it fills.
    let held = 0
    let turns = 0
    const frames = Math.ceil((PAGE_DWELL_SECONDS * 90) / 1) + 2
    for (let i = 0; i < frames; i++) {
      const step = advanceDwell(held, 1 / 90, true, true)
      held = step.held
      if (step.turn) turns++
    }
    expect(turns).toBe(1)
    // And looking away resets it, so a glance never accumulates towards a turn.
    expect(advanceDwell(PAGE_DWELL_SECONDS - 0.01, 1 / 90, false, true).held).toBe(0)
  })

  it('points every LABEL at the chair — the bug a screenshot found', () => {
    // Shipped wrong for exactly one screenshot: the panels were yawed by
    // +bearing where facing the seat needs -bearing. The two inner labels came
    // out 30 degrees askew and read as a font problem; the two OUTER ones were
    // 90 degrees off and vanished, which reads as "the label did not render".
    // Symmetry hid it in the middle of the arc and could not hide it at the
    // ends — orientation lesson §1, in one picture.
    //
    // So the guard is the DIRECTION the face points, not the number in the
    // yaw. `labelYaw` is fed through three's own convention — `rotation.y` sends
    // a plane's local +z to `(sin psi, 0, cos psi)` — and the result has to
    // agree with the direction from the label to the chair, which is measured
    // from the positions. `expect(yaw).toBe(-bearing)` would be my belief
    // written twice; this is false if either half is wrong.
    const e = eye()
    for (let count = 1; count <= TABLES_PER_PAGE; count++) {
      for (const bearing of tableBearings(count)) {
        const psi = labelYaw(bearing)
        const facing: [number, number, number] = [Math.sin(psi), 0, Math.cos(psi)]
        const base = tableLocal(SPEC, bearing)
        const at = labelLocal(bearing, TABLE_TOP + 0.4)
        const toSeat = norm([e.x - (base.x + at.x), 0, e.z - (base.z + at.z)])
        expect(
          deg(Math.acos(Math.min(1, dot(facing, toSeat)))),
          `label at ${deg(bearing).toFixed(0)} deg faces away by`,
        ).toBeLessThan(1)
      }
    }
  })

  it('stands the label towards the seat, never behind its own island', () => {
    // The offset has to be on the SEAT side of the table's axis, or the model
    // sits between you and the words. Measured as a distance, so it is true
    // whichever way the panel happens to be turned.
    for (const bearing of tableBearings(TABLES_PER_PAGE)) {
      const base = tableLocal(SPEC, bearing)
      const at = labelLocal(bearing, TABLE_TOP + 0.4)
      const e = eye()
      const centreDist = Math.hypot(base.x - e.x, base.z - e.z)
      const labelDist = Math.hypot(base.x + at.x - e.x, base.z + at.z - e.z)
      expect(labelDist, `label at ${deg(bearing).toFixed(0)} deg`).toBeLessThan(centreDist)
    }
  })

  it('draws a model big enough to READ: 14 degrees, not 4 pixels', () => {
    // Orientation lesson §5c: the title jets flew backwards for a whole session
    // because they were four pixels across. A menu you choose from by looking
    // at a shape has to render the shape at a size a human can resolve.
    //
    // A Quest 3 is roughly 20 pixels per degree at the centre. 14 degrees is
    // ~285 px of island. The smallest thing on a level table since DEV-354 took
    // its rings off is the craft (`craftScale` 1.8 on `size * 0.028`), 0.7
    // degrees, ~14 px long. Both are above the "I can see that" floor; the
    // single table's proportion would have put the craft at 4.
    const r = range(tableGazeLocal(SPEC, 0))
    const model = 2 * deg(Math.atan(MODEL_SIZE / 2 / r))
    // 18.3 degrees until DEV-627 shrank the island to sit inside its table.
    expect(model).toBeGreaterThan(13)
    const craftLength = MODEL_SIZE * 0.028 * 1.8
    expect(deg(Math.atan(craftLength / r)) * 20, 'craft pixels on a Quest 3').toBeGreaterThan(12)
  })
})

/* ═════════════════ THE FIXED SLOTS, as a direction from the eye ══════════ */

/**
 * DEV-203, measured where a player experiences it: **the same option is in the
 * same DIRECTION from the chair, every time you see it.**
 *
 * ── What was happening, and it was not random ───────────────────────────
 *
 * `tableBearings(count)` is `SEAT_REST_BEARING + (i - floor((count-1)/2)) *
 * TABLE_BEARING_STEP`, and `count` used to be **how many tables the page
 * happened to hold**. Four gave -45/-15/+15/+45 and one gave -15, so the same
 * rank moved 30 degrees when a cell's size changed. `restFirst` then rotated
 * the page so whatever you had arrived in sat under the pointer, moving
 * everything else by a different amount on every visit. Compose the two and a
 * table's bearing was a function of the page's contents and the session's
 * history — deterministic, and unlearnable.
 *
 * `count` is now `slotCount(order)`: how many distinct keys the CONTENT offers
 * that step. It does not move when a cell is smaller, and nothing rotates.
 *
 * Every assertion below is an ANGLE BETWEEN TWO DIRECTIONS, never a bearing
 * compared to a number I chose — orientation lesson §4. And each one is paired
 * with the COUNTERFACTUAL it has to be able to tell apart, because *a rule
 * tested only where two explanations agree has not been tested*.
 */
describe('an option is in the same DIRECTION however many others are on the arc', () => {
  /** Where the table in slot `at` of a `width`-wide arc is, as a point. */
  const slotAt = (width: number, at: number): P =>
    tableGazeLocal(SPEC, tableBearings(width)[at] as number)

  it('is a 30-degree question, so the assertions below can tell the two apart', () => {
    // The counterfactual first, because a test that cannot distinguish the two
    // explanations has not tested either. HoverJet · Ring Attack offers three
    // ranks and HoverJet · Free Flight offers one; under the OLD rule those
    // pages drew a 3-slot and a 1-slot arc, and Beginner — slot 0 of each —
    // came out 30 degrees apart. So "it did not move" is a claim with teeth.
    //
    // (The composed end-to-end version, against the real thirteen, is in
    // `level-steps.test.ts`: it needs the content this file deliberately has
    // none of. What is here is the geometry that claim rests on.)
    expect(
      apart(slotAt(1, 0), slotAt(3, 0)),
      'slot 0 of a 1-arc and of a 3-arc really are different directions',
    ).toBeGreaterThan(25)
    expect(apart(slotAt(2, 0), slotAt(4, 0))).toBeGreaterThan(25)
    // And the arcs the game actually draws never disagree with themselves: a
    // slot index means one direction for a given width, which is what makes a
    // width that is a property of the STEP enough to fix the layout.
    for (const width of [2, 3, 4]) {
      expect(tableBearings(width)).toHaveLength(width)
      // DEV-858: symmetric about the eye line, whatever the width.
      const mean = tableBearings(width).reduce((a, b) => a + b, 0) / width
      expect(mean).toBeCloseTo(SEAT_REST_BEARING, 12)
    }
  })

  it('separates every pair of slots on every arc the game draws', () => {
    // The four arcs: 2 aircraft, 3 plans, 3 ranks, 4 places. Neighbours have to
    // stay a dead band apart on all of them, which is the property the whole
    // 90-degree layout was sized for and which a narrower arc could quietly
    // break. Measured, not assumed — the separation is 27.7 degrees and not the
    // 30 of the bearing step, because both rays are pitched down.
    for (const width of [2, 3, 4]) {
      for (let at = 0; at + 1 < width; at++) {
        const a = slotAt(width, at)
        const b = slotAt(width, at + 1)
        const window =
          deg(Math.asin(GAZE_RADIUS / range(a))) + deg(Math.asin(GAZE_RADIUS / range(b)))
        expect(apart(a, b) - window, `arc of ${width}, slots ${at}/${at + 1}`).toBeGreaterThan(6)
      }
      // And the whole arc stays inside what a seated head can turn to.
      const ends = tableBearings(width)
      for (const bearing of ends)
        expect(Math.abs(deg(bearing - SEAT_REST_BEARING))).toBeLessThanOrEqual(45)
    }
  })

  it('hovers NOTHING at a dead plate bearing, and its neighbours at theirs', () => {
    // ── Requirement 2, as geometry ────────────────────────────────────────
    //
    // Matt chose a dimmed plate over an empty position, with the risk stated:
    // *"A dead table is still a thing you try to press."* So the plate is
    // drawn and the SPHERE is not — `gaze()` builds its list from
    // `slotAimable`, so a dead plate contributes nothing for the nearest-miss
    // search to find, and no flag downstream has to remember it exists.
    //
    // The assertion is a ray aimed DEAD CENTRE at each slot's own bearing.
    // That is true or false independently of how the plate is drawn, which is
    // the point: a test of the colour would go green on a plate that is dim
    // and pressable, which is the one outcome nobody wants.
    const e = eye()
    const bearings = tableBearings(3)
    // A three-slot arc with the MIDDLE dead — the HoverJet's flight-plan page,
    // exactly: Ring Attack, [Target Practice], Free Flight.
    const liveCentres: [number, number, number][] = [0, 2].map((at) => {
      const c = tableGazeLocal(SPEC, bearings[at] as number)
      return [c.x, c.y, c.z] as [number, number, number]
    })
    const rayTo = (at: number) => {
      const c = tableGazeLocal(SPEC, bearings[at] as number)
      const d = norm(sub(c, e))
      return pickNearestSphere(e.x, e.y, e.z, d[0], d[1], d[2], liveCentres, GAZE_RADIUS)
    }
    expect(rayTo(0), 'the live plate at slot 0 is takeable').toBe(0)
    expect(rayTo(1), 'the DEAD plate at slot 1 hovers nothing').toBe(-1)
    expect(rayTo(2), 'the live plate at slot 2 is takeable').toBe(1)
    // And the miss is not an accident of the ray being short: the same three
    // rays with the middle sphere PRESENT all land, so what changed is the
    // sphere and not the aim.
    const allCentres: [number, number, number][] = [0, 1, 2].map((at) => {
      const c = tableGazeLocal(SPEC, bearings[at] as number)
      return [c.x, c.y, c.z] as [number, number, number]
    })
    for (const at of [0, 1, 2]) {
      const c = tableGazeLocal(SPEC, bearings[at] as number)
      const d = norm(sub(c, e))
      expect(
        pickNearestSphere(e.x, e.y, e.z, d[0], d[1], d[2], allCentres, GAZE_RADIUS),
        `slot ${at} with every sphere present`,
      ).toBe(at)
    }
  })

  it('leaves the resting pointer on NOTHING when its position is empty', () => {
    // The new failure mode, and it has to be this one. With fixed slots a
    // position can be empty — Free Flight × Intermediate holds no course — and
    // the resting pointer sits on `floor((count-1)/2)`, which on a 3-arc is
    // slot 1. If the empty middle made the ray fall through to a NEIGHBOUR, a
    // blind press would take an option the player never looked at, which is the
    // 2016-shaped bug `restFirst` was written for wearing new clothes.
    const e = eye()
    const psi = seatYawLocal()
    const pitch = seatPitchLocal()
    const dir: [number, number, number] = [
      -Math.sin(psi) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(psi) * Math.cos(pitch),
    ]
    // A 3-slot arc with only the OUTER two filled — which is exactly what the
    // JumpSeat's plan page is, mirrored.
    const outer: [number, number, number][] = [0, 2].map((at) => {
      const c = slotAt(3, at)
      return [c.x, c.y, c.z] as [number, number, number]
    })
    expect(pickNearestSphere(e.x, e.y, e.z, ...dir, outer, GAZE_RADIUS)).toBe(-1)
    // Fill the middle and the very same ray lands on it, dead centre — so the
    // miss above is about the HOLE and not about the ray.
    const middle = slotAt(3, 1)
    expect(
      pickNearestSphere(e.x, e.y, e.z, ...dir, [[middle.x, middle.y, middle.z]], GAZE_RADIUS),
    ).toBe(0)
  })

  it('puts a KNOWN identity under the resting pointer on each of the four steps', () => {
    // With fixed slots, "what rests under the pointer" is a deliberate choice
    // per step rather than whatever the page's ordering produced. Stated here so
    // a diff that changes it has to argue with a line of prose:
    //
    //   vehicles  2 slots, home 0 -> HoverJet
    //   modes     3 slots, home 1 -> Target Practice
    //   ranks     3 slots, home 1 -> Intermediate
    //   courses   4 slots, home 1 -> Mesa Canyon
    //
    // The geometry half: the home slot of every arc the game draws really is
    // the one the resting ray lands on.
    const e = eye()
    const psi = seatYawLocal()
    const pitch = seatPitchLocal()
    const dir: [number, number, number] = [
      -Math.sin(psi) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(psi) * Math.cos(pitch),
    ]
    // DEV-858: only an ODD arc has a table under the resting pointer now (3: the middle
    // one); an even one rests in the gap and the room's default takes slot width / 2.
    for (const width of [2, 3, 4]) {
      const hit = pickNearestSphere(e.x, e.y, e.z, ...dir, centres(width), GAZE_RADIUS)
      if (width % 2 === 0) {
        expect(hit, `an arc of ${width} rests in the gap`).toBe(-1)
        continue
      }
      const home = (width - 1) / 2
      expect(hit, `an arc of ${width} rests on nothing`).toBe(home)
      const off = deg(Math.acos(Math.min(1, dot(dir, norm(sub(slotAt(width, home), e))))))
      expect(off, `arc of ${width}: off centre by`).toBeLessThan(0.5)
    }
  })

  it('can only reach a LAP PLATE by looking down from near its own bearing', () => {
    // ── The property a red spec cost four probe runs to find ──────────────
    //
    // `menu-light-compile.spec.ts` climbed back out of the room by sweeping
    // PITCH until the BACK plate lit up, and after DEV-203 it stopped working.
    // A probe drove the pitch to its limit and swept the whole range down,
    // seventy notches, logging the aim at every one: nothing at any height.
    //
    // This is why, and it is a fact about the ROOM rather than about the spec.
    // A pitch sweep holds yaw and varies pitch, so it traces one meridian; the
    // plate is a sphere of `ARROW_GAZE_RADIUS` at bearing ∓20 degrees, and a
    // meridian 25 degrees away in yaw never enters it. It used to work because
    // the old arc ROTATED the wanted table to the resting bearing, so the seat
    // was always within 5 degrees of the left plate. Fixed slots mean the walk
    // has to turn, and half the arc's positions are blind.
    //
    // Asserted as a MISS DISTANCE against the plate's own window, swept over
    // pitch — not as a bearing difference I chose, which would be the belief
    // written twice.
    const e = eye()
    /** The closest a pure pitch sweep at `yaw` ever comes to `target`. */
    const closestOverPitch = (yaw: number, target: P): number => {
      let best = Infinity
      for (let p = -89; p <= 89; p += 0.1) {
        const pr = (p * Math.PI) / 180
        const d: [number, number, number] = [
          Math.sin(yaw) * Math.cos(pr),
          Math.sin(pr),
          -Math.cos(yaw) * Math.cos(pr),
        ]
        const off = deg(Math.acos(Math.min(1, Math.max(-1, dot(d, norm(sub(target, e)))))))
        if (off < best) best = off
      }
      return best
    }
    const plateWindow = (side: -1 | 1) =>
      deg(Math.asin(ARROW_GAZE_RADIUS / range(arrowLocal(SPEC, side))))

    // The inner positions reach a plate; the outer ones cannot, at any pitch.
    const reachable = (bearing: number) =>
      ([-1, 1] as const).some(
        (side) => closestOverPitch(bearing, arrowLocal(SPEC, side)) < plateWindow(side),
      )
    const bearings = tableBearings(TABLES_PER_PAGE)
    // DEV-858: the plates lie ARROW_BEARING either side of the EYE's resting line
    // (-45 and +15 from the room's forward), under the outer positions of a
    // four-wide arc, so the plate-side positions see one and the others cannot.
    // The plates lie 30 off the eye line, where the THREE-wide arc's outer tables stand
    // (the four-wide arc's -45/-15/+15/+45 all miss both: 15 degrees is past a window).
    const three = tableBearings(3)
    expect(reachable(three[0] as number), 'a three-wide left end can see the left plate').toBe(true)
    expect(reachable(three[2] as number), 'a three-wide right end can see the right plate').toBe(
      true,
    )
    expect(reachable(three[1] as number), 'the middle one is BLIND to both').toBe(false)
    for (const b of bearings) expect(reachable(b), 'no four-wide position sees one').toBe(false)

    // And the number that says how far off you may be, so a helper that wants
    // to know has it: about 12 degrees of yaw either side of the plate.
    let widest = 0
    for (let off = 0; off <= 40; off += 0.25) {
      const yaw = arrowBearing(-1) + (off * Math.PI) / 180
      if (closestOverPitch(yaw, arrowLocal(SPEC, -1)) >= plateWindow(-1)) break
      widest = off
    }
    expect(widest, 'yaw tolerance for a pitch-only search, degrees').toBeGreaterThan(10)
    expect(widest, 'and it is nowhere near the 25 an outer table sits at').toBeLessThan(15)
  })

  it('still lands a SINGLE table under the pointer — the placeholder', () => {
    // `tableBearings(1)` is no longer a step; it is the one table the room shows
    // while the thirteen level JSONs are in flight. It has to be aimable, or the
    // first thing a player sees is a table they cannot press.
    const solo = tableBearings(1)
    expect(solo).toHaveLength(1)
    expect(solo[0]).toBe(-seatYawLocal())
    expect(rayAt(tableGazeLocal(SPEC, solo[0] as number), 1)).toBe(0)
  })
})
