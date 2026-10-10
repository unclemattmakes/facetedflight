// tests/unit/hangar-symmetry.test.ts: the hangar is square to the seated eye. DEV-858.
//
// Matt, 2026-10-08, an OCD pass: *"the hangar menus are not centred, the chair
// seems to be at an odd angle. close, but not right."* Measured from the seated
// eye's RESTING LINE (`SEAT_REST_BEARING`, 15 degrees left of the room's
// forward), what stood off it, in degrees, before this change:
//
//   the chair                    15.0  (square to the room's forward, not to its sitter's eye)
//   the left / right page plate  -5 / +35  (20 either side of the room's forward, not of the eye)
//   the first step's four doors  centroid +11.5, OPTIONS 80 left of the line
//
// Geometry, not rotation (the orientation lesson): every figure below is an
// angle or a distance measured in the eye's own frame, never a quaternion read
// back, and the test that cannot see the old failure is not trusted: each
// check has its negative control (the old numbers) asserted to FAIL it.

import fs from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  ARROW_BEARING,
  ARROW_REACH,
  arrowBearing,
  arrowLocal,
  DOORS_BEARING_STEP,
  doorsBearings,
  restingSlot,
  SEAT_REST_BEARING,
  seatEyeLocal,
  seatPitchLocal,
  seatYawLocal,
  stepBearings,
  TABLE_BEARING_STEP,
  TABLE_TOP,
  tableBearings,
  tableLocal,
} from '@/render/hangar'
import { chairMatrix, ROOM_EMBLEM } from '@/render/hangar-art'
import { optionsPlatePose } from '@/render/hangar-options-plate'
import { panelHeight, TITLE_M, TOP_LOCAL_Y } from '@/render/pause'
import { hangarSpecFor } from '@/sim/hangar'

const DEG = Math.PI / 180
const SPEC = hangarSpecFor()
const seat = seatEyeLocal(SPEC)

/** A bearing (radians right of the room's forward) as a unit direction on the floor. */
const away = (bearing: number): THREE.Vector3 =>
  new THREE.Vector3(Math.sin(bearing), 0, -Math.cos(bearing))

/** Degrees right of the EYE's resting line that a floor point stands, seen from the seat. */
const offEye = (x: number, z: number): number => {
  const bearing = Math.atan2(x - seat.x, -(z - seat.z))
  return (((bearing - SEAT_REST_BEARING) / DEG + 540) % 360) - 180
}

/** A point in the eye's frame: lateral (right of the line) and along it, metres. */
const inEyeFrame = (x: number, z: number): { lat: number; along: number } => {
  const dx = x - seat.x
  const dz = z - seat.z
  const a = away(SEAT_REST_BEARING)
  return {
    along: dx * a.x + dz * a.z,
    lat: dx * Math.cos(SEAT_REST_BEARING) + dz * Math.sin(SEAT_REST_BEARING),
  }
}

describe('the eye line, and what is square to it', () => {
  it('the seat yaw looks along the resting bearing, as three turns it', () => {
    const o = new THREE.Object3D()
    o.rotation.y = seatYawLocal()
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(o.quaternion)
    expect(forward.angleTo(away(SEAT_REST_BEARING)) / DEG).toBeLessThan(1e-9)
  })

  it('the chair faces the eye line: its look is 0 degrees off it (it was 15)', () => {
    // 2016's own chair facts (commander-chair.glb): the eye, and the resting
    // look in the chair's frame (azimuth about 91 degrees, not along -z).
    const facts = { eye: [-0.162, 1.043, 0.005] as const, look: [-0.999, 0, 0.033] as const }
    const eye = away(SEAT_REST_BEARING)
    const lookOf = (m: THREE.Matrix4) => new THREE.Vector3(...facts.look).transformDirection(m)
    const squared = chairMatrix(facts, seat, SEAT_REST_BEARING)
    expect(lookOf(squared).angleTo(eye) / DEG).toBeLessThan(1e-6)
    // And the point of it: the chair's eye still lands on the seat.
    const at = new THREE.Vector3(...facts.eye).applyMatrix4(squared)
    expect(at.distanceTo(new THREE.Vector3(seat.x, seat.y, seat.z))).toBeLessThan(1e-9)
    // The negative control: the chair as it stood was 15 degrees askew.
    const old = chairMatrix(facts, seat)
    expect(lookOf(old).angleTo(eye) / DEG).toBeCloseTo(15, 6)
  })
})

describe('the first step is an even arc about the eye line', () => {
  const off = (n: number) => doorsBearings(n).map((b) => (b - SEAT_REST_BEARING) / DEG)

  it('five doors stand at -2, -1, 0, +1, +2 steps, symmetric, evenly spaced, SINGLE PLAYER dead ahead', () => {
    const o = off(5)
    const step = DOORS_BEARING_STEP / DEG
    o.forEach((d, i) => {
      expect(d, `door ${i}`).toBeCloseTo((i - 2) * step, 9)
      expect(d, `door ${i} mirrors door ${4 - i}`).toBeCloseTo(-(o[4 - i] as number), 9)
    })
    expect(o.reduce((a, b) => a + b, 0) / o.length, 'centroid off the eye line').toBeCloseTo(0, 9)
  })

  it('three, four and five doors are all symmetric, evenly spaced, FLY the middle or right-middle', () => {
    for (const n of [3, 4, 5]) {
      const b = doorsBearings(n)
      expect(b.reduce((x, y) => x + y, 0) / n, `n=${n}: centroid`).toBeCloseTo(SEAT_REST_BEARING, 9)
      for (let i = 1; i < n; i++)
        expect((b[i] as number) - (b[i - 1] as number), `n=${n}`).toBeCloseTo(DOORS_BEARING_STEP, 9)
    }
    // OPTIONS, QUICK RACE, FLY, ...: FLY is index 2 on four and five, 1 on three.
    expect(off(5)[2]).toBeCloseTo(0, 9)
    expect(off(4)[2]).toBeCloseTo(DOORS_BEARING_STEP / DEG / 2, 9)
    expect(off(3)[1]).toBeCloseTo(0, 9)
  })

  it('negative control: the old layout had OPTIONS 80 degrees out and a centroid 11.5 right', () => {
    const old = [-80, -23, 0, 23, 46]
    expect(old.reduce((a, b) => a + b, 0) / old.length).not.toBeCloseTo(0, 1)
    expect(Math.max(...old.map(Math.abs))).toBeGreaterThan(60)
  })
})

describe('the first step in a flat frame (DEV-879): which doors fit', () => {
  // The outer EDGES of each table, through the default flat camera: the table's
  // footprint is a 0.27 m circle (the frame's farthest side is 0.248 m,
  // hangar-tables.test.ts; the real-GLB version of this measurement is its
  // DEV-578 describe), eight points around it at table-top height.
  const fovOf = (): number => {
    const src = fs.readFileSync('src/render/renderer.ts', 'utf8')
    const m = /new THREE\.PerspectiveCamera\(\s*(\d+(?:\.\d+)?)/.exec(src)
    expect(m, 'the renderer builds its camera with a literal field of view').not.toBeNull()
    return Number((m as RegExpExecArray)[1])
  }
  const maxNdcX = (bearings: readonly number[], w: number, h: number): number => {
    const camera = new THREE.PerspectiveCamera(fovOf(), w / h, 0.05, 100)
    camera.position.set(seat.x, seat.y, seat.z)
    camera.rotation.order = 'YXZ'
    camera.rotation.set(seatPitchLocal(), seatYawLocal(), 0)
    camera.updateMatrixWorld(true)
    let worst = 0
    for (const b of bearings) {
      const c = tableLocal(SPEC, b)
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4
        const p = new THREE.Vector3(
          c.x + Math.cos(a) * 0.27,
          c.y + TABLE_TOP,
          c.z + Math.sin(a) * 0.27,
        )
        worst = Math.max(worst, Math.abs(p.project(camera).x))
      }
    }
    return worst
  }
  const FRAMES = [
    [1280, 720],
    [915, 412],
  ] as const

  it('five doors sit wholly inside a flat 1280 x 720 frame and a phone in landscape', () => {
    for (const [w, h] of FRAMES)
      expect(maxNdcX(doorsBearings(5), w, h), `${w} x ${h}`).toBeLessThan(1)
  })

  it('six doors: the inner four are in frame; the outer two stand past its edge, and why', () => {
    // MEASURED on 2016's table (scratch of 2026-10-08, hangar-tables' real GLB): at the doors'
    // 23-degree step the neighbours clear by 1.8 cm and the outer table's edge is at NDC 1.36
    // (flat 1280) and 1.09 (phone). A step that fits the flat frame (19 degrees, NDC 0.99)
    // overlaps neighbours by 7.6 cm; 22 degrees already touches (-0.5 cm). Nearer the seat
    // makes the tables angularly BIGGER, so they overlap sooner; farther would fit but moves
    // every step off 2016's 1.35 to 1.56 m ring. So 23 degrees stays and the two outer doors
    // (OPTIONS, FF-TV) are a turn away. This asserts that is still the situation: the day a
    // layout puts them in frame this goes red on purpose, and the row is updated.
    const six = doorsBearings(6)
    for (const [w, h] of FRAMES) {
      expect(maxNdcX(six.slice(1, 5), w, h), `inner four, ${w} x ${h}`).toBeLessThan(1)
      expect(maxNdcX(six, w, h), `outer two, ${w} x ${h}`).toBeGreaterThan(1)
    }
    // The camera yaws on the eye line, so the two overhang alike.
    const left = maxNdcX([six[0] as number], 1280, 720)
    const right = maxNdcX([six[5] as number], 1280, 720)
    expect(Math.abs(left - right) / left, 'left and right overhang alike').toBeLessThan(0.02)
  })
})

describe('EVERY step is symmetric about the eye line (Matt: "the hangar menus are not centred")', () => {
  const VIEWS = [
    'doors',
    'multiplayer',
    'options',
    'credits',
    'vehicles',
    'variants',
    'modes',
    'ranks',
    'courses',
  ] as const

  it('every view, every width the game draws: the mean bearing is the eye line and the arc mirrors itself', () => {
    for (const view of VIEWS) {
      for (const n of [1, 2, 3, 4, 5]) {
        const b = stepBearings(view, n)
        expect(b, `${view} ${n}`).toHaveLength(n)
        const mean = b.reduce((x, y) => x + y, 0) / n
        // The credits and options views are one-table steps laid from their own
        // bearing (the seat turns to face them: `stepStartYaw`), so they are not arcs.
        if (view === 'credits' || view === 'options') continue
        expect(mean, `${view} ${n}: centroid off the eye line, degrees`).toBeCloseTo(
          SEAT_REST_BEARING,
          9,
        )
        for (let i = 0; i < n; i++)
          expect(
            (b[i] as number) - SEAT_REST_BEARING,
            `${view} ${n}: ${i} mirrors ${n - 1 - i}`,
          ).toBeCloseTo(-((b[n - 1 - i] as number) - SEAT_REST_BEARING), 9)
      }
    }
  })

  it('an odd arc has its middle table ON the line; an even one straddles it by half a step each way', () => {
    for (const n of [1, 3, 5]) {
      const b = tableBearings(n)
      expect(b[(n - 1) / 2], `n=${n}`).toBeCloseTo(SEAT_REST_BEARING, 12)
    }
    for (const n of [2, 4]) {
      const b = tableBearings(n)
      const lo = b[n / 2 - 1] as number
      const hi = b[n / 2] as number
      expect(hi - SEAT_REST_BEARING, `n=${n}`).toBeCloseTo(TABLE_BEARING_STEP / 2, 12)
      expect(SEAT_REST_BEARING - lo, `n=${n}`).toBeCloseTo(TABLE_BEARING_STEP / 2, 12)
    }
  })

  it('the resting look takes the right-middle table of an even arc', () => {
    expect(restingSlot(2)).toBe(1)
    expect(restingSlot(4)).toBe(2)
    // And the slot it names is the one just right of the line.
    for (const n of [2, 4])
      expect((tableBearings(n)[restingSlot(n)] as number) > SEAT_REST_BEARING).toBe(true)
  })

  it('negative control: the old four-wide arc stood 15 degrees right of the eye line', () => {
    const old = [-45, -15, 15, 45].map((x) => x * DEG)
    const meanOff = old.reduce((x, y) => x + y, 0) / 4 - SEAT_REST_BEARING
    expect(meanOff / DEG).toBeCloseTo(15, 9)
  })
})

describe('the page plates are symmetric about the eye line', () => {
  it('one at -30 and one at +30 degrees from it, at one reach (they were -5 and +35)', () => {
    const l = arrowLocal(SPEC, -1)
    const r = arrowLocal(SPEC, 1)
    expect(offEye(l.x, l.z)).toBeCloseTo(-30, 9)
    expect(offEye(r.x, r.z)).toBeCloseTo(30, 9)
    expect(Math.hypot(l.x - seat.x, l.z - seat.z)).toBeCloseTo(ARROW_REACH, 12)
    expect(Math.hypot(r.x - seat.x, r.z - seat.z)).toBeCloseTo(ARROW_REACH, 12)
    expect(arrowBearing(-1) + arrowBearing(1)).toBeCloseTo(2 * SEAT_REST_BEARING, 12)
    expect(ARROW_BEARING / DEG).toBeCloseTo(30, 9)
  })
})

describe('the BACK plate does not lie over the floor logo (DEV-839)', () => {
  type Rect = { lat: number; along: number; axis: number; hu: number; hv: number }
  /** Separating-axis overlap of two rectangles in the eye frame. `axis` is the angle of the first half-extent. */
  const overlaps = (a: Rect, b: Rect): boolean => {
    const corners = (r: Rect) => {
      const u = { x: Math.cos(r.axis), y: Math.sin(r.axis) }
      const v = { x: -Math.sin(r.axis), y: Math.cos(r.axis) }
      return [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ].map(([i, j]) => ({
        x: r.lat + (i as number) * r.hu * u.x + (j as number) * r.hv * v.x,
        y: r.along + (i as number) * r.hu * u.y + (j as number) * r.hv * v.y,
      }))
    }
    const ca = corners(a)
    const cb = corners(b)
    for (const r of [a, b]) {
      for (const ax of [r.axis, r.axis + Math.PI / 2]) {
        const n = { x: Math.cos(ax), y: Math.sin(ax) }
        const pa = ca.map((p) => p.x * n.x + p.y * n.y)
        const pb = cb.map((p) => p.x * n.x + p.y * n.y)
        if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false
      }
    }
    return true
  }
  /** The emblem's footprint, conservatively a 0.5 m square, on the eye line at its distance. */
  const emblem: Rect = {
    lat: 0,
    along: ROOM_EMBLEM.distance,
    axis: 0,
    hu: ROOM_EMBLEM.widthM / 2,
    hv: ROOM_EMBLEM.widthM / 2,
  }
  /** The BACK word of a plate `degrees` right of the eye line: 0.3 x 0.075 m, 0.15 m beyond the plate, tangent to the seat. */
  const word = (degrees: number): Rect => {
    const a = degrees * DEG
    const reach = ARROW_REACH + 0.15
    return { lat: Math.sin(a) * reach, along: Math.cos(a) * reach, axis: -a, hu: 0.15, hv: 0.0375 }
  }
  /** The plate itself: 0.2 m square, one side to the seat. */
  const plate = (degrees: number): Rect => {
    const a = degrees * DEG
    return {
      lat: Math.sin(a) * ARROW_REACH,
      along: Math.cos(a) * ARROW_REACH,
      axis: -a,
      hu: 0.1,
      hv: 0.1,
    }
  }

  it('measures the plates where the room lays them: clear of the logo, either side', () => {
    for (const side of [-1, 1] as const) {
      const p = arrowLocal(SPEC, side)
      const at = inEyeFrame(p.x, p.z)
      const degrees = (Math.atan2(at.lat, at.along) * 180) / Math.PI
      expect(overlaps(word(degrees), emblem), `side ${side}: the word`).toBe(false)
      expect(overlaps(plate(degrees), emblem), `side ${side}: the plate`).toBe(false)
    }
  })

  it('negative control: the old left plate, 5 degrees left of the eye, lay over it', () => {
    expect(overlaps(word(-5), emblem)).toBe(true)
  })
})

describe('the hangar OPTIONS plate stands square in front of the chair (DEV-857)', () => {
  const FOV_HALF = 35 // the flat frame's vertical half angle at the default lens, degrees

  it('is on the eye line (no sideways offset) and its edges stay in the flat frame, 3 to 8 rows and the credits body', () => {
    for (const [rows, body] of [
      [3, 0],
      [5, 0],
      [7, 0],
      [8, 0],
      [1, 0.4],
    ] as const) {
      const { position, scale } = optionsPlatePose(rows, body)
      expect(position[0], `${rows} rows: centred on the line`).toBe(0)
      const distance = -position[2]
      const topY = position[1] + TOP_LOCAL_Y * scale
      const bottomY = topY - panelHeight(rows, TITLE_M + body) * scale
      // Degrees off the view centre: the seat pitches down by -seatPitchLocal() (it is negative).

      const topFromCentre = -(Math.atan2(topY, distance) / DEG) - -seatPitchLocal() / DEG
      const bottomFromCentre = -(Math.atan2(bottomY, distance) / DEG) - -seatPitchLocal() / DEG
      expect(Math.abs(topFromCentre), `${rows} rows: top edge`).toBeLessThan(FOV_HALF)
      expect(Math.abs(bottomFromCentre), `${rows} rows: bottom edge`).toBeLessThan(FOV_HALF)
    }
  })
})
