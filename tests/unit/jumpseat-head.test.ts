// tests/unit/jumpseat-head.test.ts — 2016's JumpSeat death: the head touches anything. DEV-403.
//
// `JumpSeat_Photon.prefab`'s `collider_head` carries `Trigger_Reset`, and any
// contact with a collider not tagged Player fades the screen, waits a second
// and reloads the scene. `sim/jumpseat-head.ts` is the rule; this pins it in
// four layers:
//
//   · the BOX, derived here from the prefab's own transform rather than read
//     back out of the sheet the code reads (trap 24: a test that re-derives
//     its expectation the way the code does has not tested the code);
//   · the contact: land, a pad and its underside, and a tree;
//   · the clock, and "one death at a time" against DEV-342's stranded tank;
//   · the real flight model: landings never touch the head, and a seat on
//     its back does — which is the measurement the rule was cleared on.
//
// And the autopilot's head guard, which is what lets the six missions finish
// with the rule on (`jumpseat-autopilot-missions.test.ts` flies them).

import { describe, expect, it } from 'vitest'
import { resolveVariant } from '@/content/load-aircraft'
import {
  HEAD_STRIKE,
  headStrikeApplies,
  jumpSeatFor,
  jumpSeatHeadBox,
  padFieldsFor,
  STRANDED,
} from '@/game/jumpseat-flight'
import { livePads } from '@/game/targets'
import { JUMPSEAT } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import {
  createJumpSeat,
  type JumpSeat,
  noJumpSeatInput,
  stepJumpSeat,
  updateJumpSeatFootProbes,
} from '@/sim/jumpseat'
import {
  DEFAULT_JUMPSEAT_AUTOPILOT,
  type JumpSeatWaypoint,
  jumpSeatHeadThreat,
  jumpSeatHeadUnderPad,
  keepOutsideTheRim,
} from '@/sim/jumpseat-autopilot'
import {
  createHead,
  headDepth,
  headTouches,
  resetHead,
  stepJumpSeatDeaths,
} from '@/sim/jumpseat-head'
import { createRefuel, type RefuelSphere, stepJumpSeatRefuel } from '@/sim/jumpseat-refuel'
import { createStranded } from '@/sim/jumpseat-stranded'
import { rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { buildPadField } from '@/sim/pad-surface'
import { buildPropColliders, type PropCollisionSpec } from '@/sim/props/collision'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { belowField, buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import {
  collisionAngularDrag,
  createTerrainCollision,
  hullFromColliders,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'
import { JUMPSEAT_MISSIONS, loadJumpSeatLevel } from './helpers/jumpseat-run'
import { SPIDER_READY } from './helpers/spider-ready'

const BOX = jumpSeatHeadBox(
  JUMPSEAT.shipCollisionColliders as unknown as Parameters<typeof jumpSeatHeadBox>[0],
)

const ticks = (seconds: number): number => Math.ceil(seconds / FIXED_DT - 1e-9)

// ── the box ───────────────────────────────────────────────────────────────

describe('DEV-403: the head box is 2016’s collider_head', () => {
  it('matches the prefab’s own transform, derived here and not read from the sheet', () => {
    // `JumpSeat_Photon.prefab`, GameObject `collider_head` (&174574), Transform
    // &427000: localPosition (0, 1.53, 0) under `offset`, which sits at
    // (0, 0.42, 0.04) in ship-root space; localRotation x 0.075058, w 0.997179;
    // localScale (1.009493, 0.876637, 1.575224) on a unit BoxCollider
    // (&6575790, size 1, centre 0). Written from the YAML, so a sheet that
    // drifted from the prefab would fail here.
    const centre = { x: 0, y: 0.42 + 1.53, z: 0.04 }
    const half = { x: 1.009493 / 2, y: 0.876637 / 2, z: 1.575224 / 2 }
    const angle = 2 * Math.asin(0.075058)
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    // A box turned about x: its y reach is hy·cos + hz·sin, its z reach
    // hz·cos + hy·sin, and its x reach is untouched.
    const reachY = half.y * c + half.z * s
    const reachZ = half.z * c + half.y * s
    const ys = BOX.points.map((p) => p.y)
    const zs = BOX.points.map((p) => p.z)
    const xs = BOX.points.map((p) => p.x)
    expect(BOX.points).toHaveLength(27)
    expect(Math.min(...ys)).toBeCloseTo(centre.y - reachY, 3)
    expect(Math.max(...ys)).toBeCloseTo(centre.y + reachY, 3)
    expect(Math.min(...zs)).toBeCloseTo(centre.z - reachZ, 3)
    expect(Math.max(...zs)).toBeCloseTo(centre.z + reachZ, 3)
    expect(Math.min(...xs)).toBeCloseTo(-half.x, 3)
    expect(Math.max(...xs)).toBeCloseTo(half.x, 3)
    // The lattice plus the INSCRIBED sphere, for the props.
    expect(BOX.spheres).toHaveLength(28)
    expect(BOX.spheres[27]?.radius).toBeCloseTo(half.y, 3)
  })

  it('is the box, not the hull’s sphere: its corners reach past it', () => {
    // `hullFromColliders` keeps the inscribed sphere, which is what stops the
    // head on the ground. The rule is on the collider 2016 reset on.
    const r = BOX.spheres[27]?.radius as number
    const farthest = Math.max(
      ...BOX.points.map((p) =>
        Math.hypot(p.x - BOX.centre.x, p.y - BOX.centre.y, p.z - BOX.centre.z),
      ),
    )
    expect(farthest - r).toBeGreaterThan(0.5)
  })

  it('takes 2016’s one second, and the stranded tank borrows it', () => {
    // `Trigger_Reset.cs:62`, `WaitForSeconds(1f)`. One number, two deaths.
    expect(HEAD_STRIKE).toEqual({ holdSeconds: 1 })
    expect(STRANDED.holdSeconds).toBe(HEAD_STRIKE.holdSeconds)
  })
})

// ── the contact ───────────────────────────────────────────────────────────

const flatMap = (g: number): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(_u: number, _v: number, out: Rgb): Rgb {
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

/** Flat ground at y = 50 over a 1 km square, as `jumpseat-stranded.test.ts` builds it. */
const FLAT: HeightField = buildHeightField(
  flatMap(0.5),
  {
    terrainSize: 1024,
    terrainHeight: 100,
    baseResolution: 8,
    chunkSize: 256,
    randomOffset: 0,
    seed: 1,
  } as unknown as FacetedTerrainParams,
  { position: [0, 0, 0], scale: [1, 1, 1] },
)
const GROUND = 50
const LAND: readonly HeightField[] = [FLAT]

/** A seat at (512, y, 512), turned `angle` radians about the given body axis. */
const seatAt = (y: number, angle = 0, axis: 'x' | 'z' = 'z'): JumpSeat => {
  const seat = createJumpSeat()
  seat.live = true
  seat.body.position.x = 512
  seat.body.position.y = y
  seat.body.position.z = 512
  seat.body.orientation[axis] = Math.sin(angle / 2)
  seat.body.orientation.w = Math.cos(angle / 2)
  return seat
}

const lowestHeadY = (): number => Math.min(...BOX.points.map((p) => p.y))
const highestHeadY = (): number => Math.max(...BOX.points.map((p) => p.y))

describe('DEV-403: what the head touches', () => {
  it('upright, the head is its lowest corner above the ground', () => {
    const seat = seatAt(GROUND + 1)
    expect(headDepth(seat.body, BOX, LAND)).toBeCloseTo(-(1 + lowestHeadY()), 3)
    expect(headTouches(seat.body, BOX, LAND, null)).toBe(false)
  })

  it('on its back, the top of the head touches as the ground reaches it', () => {
    const clear = seatAt(GROUND + highestHeadY() + 0.01, Math.PI)
    expect(headTouches(clear.body, BOX, LAND, null)).toBe(false)
    const touching = seatAt(GROUND + highestHeadY() - 0.01, Math.PI)
    expect(headTouches(touching.body, BOX, LAND, null)).toBe(true)
  })

  it('a pad is a slab: inside it is a touch, under its underside is air', () => {
    // A 20 m pad whose surface is 10 m above its root, and whose underside is
    // 4 m under that — the shape of 2016's `jumpPad_04_collider`, which a head
    // passing under a floating pad's rim never touches.
    const pad = buildPadField({
      centre: v3(512, GROUND + 60, 512),
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      symmetry: 8,
      profile: [
        [0, 10],
        [20, 10],
      ],
      outer: 20,
      bottom: 6,
    })
    const surfaces: HeightField[] = [...LAND, pad]
    const top = GROUND + 70
    // In the slab: the head's centre 1 m under the pad's top.
    const inSlab = seatAt(top - 1 - BOX.centre.y)
    expect(headTouches(inSlab.body, BOX, surfaces, null)).toBe(true)
    // Under it: the whole head below the underside.
    const under = seatAt(GROUND + 66 - highestHeadY() - 1)
    expect(headTouches(under.body, BOX, surfaces, null)).toBe(false)
    // And the land still counts under a pad.
    const onLand = seatAt(GROUND + highestHeadY() - 0.01, Math.PI)
    expect(headTouches(onLand.body, BOX, surfaces, null)).toBe(true)
  })

  it('a tree counts — including one between the lattice points', () => {
    const spec: PropCollisionSpec = {
      breakSpeed: 45,
      breakSlowdown: 0.06,
      bounceRestitution: 0.25,
      radiusFraction: 0.3,
      cellMetres: 64,
      racerStuckSeconds: 0.25,
    }
    // A thin trunk (0.09 m) standing through the head, off every lattice point:
    // only the inscribed sphere can see it.
    const trunk = { x: 512.25, z: 512.43 }
    const props = buildPropColliders(
      [
        {
          x: trunk.x,
          y: GROUND,
          z: trunk.z,
          scale: 0.3,
          dims: { height: 20, base: 0, width: 1 },
          kind: 'tree',
        },
      ],
      { x: 0, y: 0, z: 0 },
      spec,
    )
    const seat = seatAt(GROUND + 1)
    const radius = props.radius[0] as number
    // The premise: no lattice point is inside the trunk.
    const w = v3()
    for (const p of BOX.points) {
      rotateVec3(w, seat.body.orientation, p)
      const d = Math.hypot(
        seat.body.position.x + w.x - trunk.x,
        seat.body.position.z + w.z - trunk.z,
      )
      expect(d).toBeGreaterThan(radius)
    }
    expect(headTouches(seat.body, BOX, LAND, props)).toBe(true)
    // No props — Classic, or props that did not load — and nothing is there.
    expect(headTouches(seat.body, BOX, LAND, null)).toBe(false)
    // And a tree beside the seat is not a touch.
    const beside = seatAt(GROUND + 1)
    beside.body.position.x = 520
    expect(headTouches(beside.body, BOX, LAND, props)).toBe(false)
  })

  it('the seam’s pads carry their undersides, where the head reads them, on all six', () => {
    // The head asks the pads DEV-383's question (`belowField`), of the same
    // fields the hull collides with — so the underside is defined once. This is
    // the head's end of that: every live pad the seam builds is air below
    // `solid.pos[1] + solid.bottom` and solid just above it.
    for (const id of JUMPSEAT_MISSIONS) {
      const level = loadJumpSeatLevel(id)
      const fields = padFieldsFor(level)
      const solids = livePads(level)
        .map((p) => p.solid)
        .filter((s) => s?.live)
      expect(solids.length, id).toBe(fields.length)
      solids.forEach((solid, i) => {
        if (!solid) return
        const field = fields[i] as HeightField
        const underside = solid.pos[1] + solid.bottom
        expect(belowField(field, underside - 0.01), `${id} pad ${i}: air below`).toBe(true)
        expect(belowField(field, underside + 0.01), `${id} pad ${i}: slab above`).toBe(false)
        // The underside is below every height the top surface has — which is
        // what `bottom` is and what the schema once said it was not.
        const lowestTop = Math.min(...solid.profile.map((p) => p[1]))
        expect(solid.bottom, `${id} pad ${i}`).toBeLessThan(lowestTop)
      })
    }
  })
})

// ── the clock, and one death at a time ────────────────────────────────────

const FAR_PAD: RefuelSphere = { centre: v3(100, 50, 100), radius: 19.707, rate: 10 }

/** A live seat with a lit thruster: the stranded rule has nothing to say about it. */
const litSeat = (): JumpSeat => seatAt(200)

/** A dry, grounded seat far from every pad: the stranded rule counts. */
const drySeat = (): JumpSeat => {
  const seat = seatAt(200)
  seat.burnsFuel = true
  seat.fuel = -3
  seat.thrusterEnabled = false
  return seat
}

describe('DEV-403: the head strike’s clock', () => {
  it('a touch dies for holdSeconds, then restarts the run ONCE', () => {
    const seat = litSeat()
    const refuel = createRefuel([FAR_PAD])
    const head = createHead()
    const stranded = createStranded()
    const restarts: number[] = []
    for (let i = 0; i < ticks(HEAD_STRIKE.holdSeconds) + 50; i++) {
      // Touching on the first tick only: `triggered` latches, and what the
      // head does afterwards changes nothing.
      const cause = stepJumpSeatDeaths(
        head,
        stranded,
        i === 0,
        seat,
        refuel,
        HEAD_STRIKE,
        STRANDED,
        FIXED_DT,
      )
      if (cause) restarts.push(i)
      if (cause) expect(cause).toBe('head')
      if (i === 0) expect(head.phase).toBe('dying')
    }
    expect(restarts).toEqual([ticks(HEAD_STRIKE.holdSeconds)])
  })

  it('no touch, lit thruster: nothing happens', () => {
    const head = createHead()
    const stranded = createStranded()
    for (let i = 0; i < 500; i++) {
      expect(
        stepJumpSeatDeaths(
          head,
          stranded,
          false,
          litSeat(),
          createRefuel([FAR_PAD]),
          HEAD_STRIKE,
          STRANDED,
          FIXED_DT,
        ),
      ).toBeNull()
    }
    expect(head).toEqual(createHead())
  })

  it('a head strike while the tank is only COUNTING takes over, and clears the count', () => {
    const seat = drySeat()
    const refuel = createRefuel([FAR_PAD])
    const head = createHead()
    const stranded = createStranded()
    for (let i = 0; i < ticks(1); i++) {
      stepJumpSeatDeaths(head, stranded, false, seat, refuel, HEAD_STRIKE, STRANDED, FIXED_DT)
    }
    expect(stranded.phase).toBe('stranding')
    stepJumpSeatDeaths(head, stranded, true, seat, refuel, HEAD_STRIKE, STRANDED, FIXED_DT)
    expect(head.phase).toBe('dying')
    expect(stranded).toEqual(createStranded())
    // And it is the head that ends the run, a second later — not the tank.
    let cause = null
    for (let i = 0; i < ticks(HEAD_STRIKE.holdSeconds) + 2 && !cause; i++) {
      cause = stepJumpSeatDeaths(
        head,
        stranded,
        false,
        seat,
        refuel,
        HEAD_STRIKE,
        STRANDED,
        FIXED_DT,
      )
    }
    expect(cause).toBe('head')
    expect(stranded.phase, 'the tank rule was frozen while the head died').toBe('ok')
  })

  it('a tank already dying ignores the head: the curtain is already coming down', () => {
    const seat = drySeat()
    const refuel = createRefuel([FAR_PAD])
    const head = createHead()
    const stranded = createStranded()
    for (let i = 0; i < ticks(STRANDED.restSeconds); i++) {
      stepJumpSeatDeaths(head, stranded, false, seat, refuel, HEAD_STRIKE, STRANDED, FIXED_DT)
    }
    expect(stranded.phase).toBe('dying')
    const causes: string[] = []
    for (let i = 0; i < ticks(STRANDED.holdSeconds) + 2; i++) {
      const cause = stepJumpSeatDeaths(
        head,
        stranded,
        true,
        seat,
        refuel,
        HEAD_STRIKE,
        STRANDED,
        FIXED_DT,
      )
      if (cause) causes.push(cause)
    }
    expect(causes).toEqual(['fuel'])
    expect(head).toEqual(createHead())
  })

  it('a zero hold restarts on the touch itself', () => {
    const cause = stepJumpSeatDeaths(
      createHead(),
      createStranded(),
      true,
      litSeat(),
      createRefuel([FAR_PAD]),
      { holdSeconds: 0 },
      STRANDED,
      FIXED_DT,
    )
    expect(cause).toBe('head')
  })

  it('resetHead is the respawn, and trap 19: a SECOND state does not move', () => {
    const a = createHead()
    const b = createHead()
    const seat = litSeat()
    const refuel = createRefuel([FAR_PAD])
    const sa = createStranded()
    const sb = createStranded()
    for (let i = 0; i < 20; i++) {
      stepJumpSeatDeaths(a, sa, false, seat, refuel, HEAD_STRIKE, STRANDED, FIXED_DT)
      stepJumpSeatDeaths(b, sb, true, seat, refuel, HEAD_STRIKE, STRANDED, FIXED_DT)
    }
    expect(a).toEqual(createHead())
    expect(b.phase).toBe('dying')
    resetHead(b)
    expect(b).toEqual(createHead())
  })
})

// ── the real flight model ─────────────────────────────────────────────────

/** `game/jumpseat-flight.ts`'s own contact numbers, as the other JumpSeat suites copy them. */
const COLLISION: TerrainCollisionSpec = {
  hull: hullFromColliders(
    JUMPSEAT.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
  ),
  restitution: 0,
  friction: 0.6,
  flashSeconds: 0.3,
  flashAngularDrag: 3,
}

/**
 * Drop a live seat onto FLAT in the seam's own order — flight model, the head
 * where that put it, collision, feet, refuel, then both deaths — and report
 * the closest the head came and whether the run was lost.
 */
const drop = (options: {
  height: number
  vy?: number
  angle?: number
  axis?: 'x' | 'z'
  seconds?: number
}): { minHead: number; touchedAt: number | null; restartAt: number | null } => {
  const seat = seatAt(GROUND + options.height, options.angle ?? 0, options.axis ?? 'z')
  seat.body.velocity.y = options.vy ?? 0
  const collision = createTerrainCollision()
  const baseAngularDrag = seat.body.angularDrag
  const refuel = createRefuel([FAR_PAD])
  const head = createHead()
  const stranded = createStranded()
  const input = noJumpSeatInput()
  let minHead = Number.POSITIVE_INFINITY
  let touchedAt: number | null = null
  let restartAt: number | null = null
  for (let i = 0; i < ticks(options.seconds ?? 8) && restartAt === null; i++) {
    stepJumpSeat(seat, input, [FLAT], FIXED_DT)
    const touching = headTouches(seat.body, BOX, LAND, null)
    minHead = Math.min(minHead, -headDepth(seat.body, BOX, LAND))
    if (touching && touchedAt === null) touchedAt = i
    stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
    seat.body.angularDrag = collisionAngularDrag(collision, COLLISION, baseAngularDrag)
    updateJumpSeatFootProbes(seat)
    stepJumpSeatRefuel(refuel, seat, seat.body.position, FIXED_DT)
    const cause = stepJumpSeatDeaths(
      head,
      stranded,
      touching,
      seat,
      refuel,
      HEAD_STRIKE,
      STRANDED,
      FIXED_DT,
    )
    if (cause === 'head') restartAt = i
  }
  return { minHead, touchedAt, restartAt }
}

describe('DEV-403: in the real flight model, landings never touch the head', () => {
  it('upright, from a hover to a 60 m/s drop: the legs take it and the head stays 1.5 m+ clear', () => {
    // Measured when the rule was cleared: 2.01 m at rest, whatever the speed.
    for (const vy of [0, -10, -20, -40, -60]) {
      const r = drop({ height: 6, vy })
      expect(r.touchedAt, `vy ${vy}`).toBeNull()
      expect(r.minHead, `vy ${vy}`).toBeGreaterThan(1.5)
    }
  })

  it('landing leaned 40 degrees either way does not touch it either', () => {
    // The port's contact applies no torque, so a leaned landing STAYS leaned
    // rather than toppling as PhysX's would — noted in the row. The head only
    // reaches flat ground past ~110 degrees.
    for (const axis of ['x', 'z'] as const) {
      for (const angle of [-0.7, 0.7]) {
        expect(drop({ height: 4, angle, axis }).touchedAt, `${axis} ${angle}`).toBeNull()
      }
    }
  })

  it('on its back, the head touches, and the run restarts a second later', () => {
    const r = drop({ height: 4, angle: Math.PI })
    expect(r.touchedAt).not.toBeNull()
    expect(r.restartAt).toBe((r.touchedAt as number) + ticks(HEAD_STRIKE.holdSeconds))
  })
})

// ── the autopilot's head guard ────────────────────────────────────────────

describe('DEV-403: the autopilot keeps its head out of things', () => {
  /** A pad-sized wall 20 m ahead (+x), its top 30 m above the seat: a column to the guard. */
  const wall = buildPadField({
    centre: v3(560, GROUND, 512),
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    symmetry: 8,
    profile: [
      [0, 80],
      [20, 80],
    ],
    outer: 20,
  })
  const guard = {
    box: BOX,
    // No `bottom`: solid all the way down, a wall.
    surfaces: [...LAND, wall],
  }

  it('fires on a head that LEADS into something: leaning into its travel at 30 m/s', () => {
    // Leaning 40 degrees towards +x, moving at +x, the wall's face about 26 m
    // off the head: at 30 m/s it arrives inside the one-second look.
    const seat = seatAt(GROUND + 30, -0.7, 'z')
    seat.body.velocity.x = 30
    const up = v3()
    rotateVec3(up, seat.body.orientation, v3(0, 1, 0))
    expect(up.x, 'the premise: the seat leans towards +x').toBeGreaterThan(0.5)
    const when = jumpSeatHeadThreat(seat, guard, DEFAULT_JUMPSEAT_AUTOPILOT)
    expect(when).toBeGreaterThanOrEqual(0)
    expect(when).toBeLessThan(1)
  })

  it('does not fire on a seat coming down onto a surface, leaning into the approach', () => {
    // The case the cheaper "does the head point along the velocity" test got
    // wrong, and it cost the missions their bullseyes: the head DOES point
    // along it here, but the splayed feet (2.2 m out, 1.2 m down) reach
    // further, so the feet meet the ground first and it is a landing, however
    // close the ground.
    const seat = seatAt(GROUND + 2, -0.35, 'z')
    seat.body.velocity.x = 15
    seat.body.velocity.y = -3
    const w = v3()
    const headReach = Math.max(
      ...BOX.points.map((p) => {
        rotateVec3(w, seat.body.orientation, p)
        return w.x * 15 + w.y * -3
      }),
    )
    expect(headReach, 'the premise: the head points along the velocity').toBeGreaterThan(0)
    expect(jumpSeatHeadThreat(seat, guard, DEFAULT_JUMPSEAT_AUTOPILOT)).toBe(-1)
  })

  it('a tree fires it whether the head leads or not: nobody lands on a tree', () => {
    // The feet-led descent above, with a trunk standing in its path: the land
    // and the pads are judged only when the head leads, because they are what a
    // seat lands on; a prop is always an obstacle (DEV-345 clears the pads).
    const seat = seatAt(GROUND + 12, -0.35, 'z')
    seat.body.velocity.x = 15
    seat.body.velocity.y = -3
    const props = buildPropColliders(
      [
        {
          x: 512 + 10,
          y: GROUND,
          z: 512,
          scale: 6,
          dims: { height: 5, base: 0, width: 1 },
          kind: 'tree',
        },
      ],
      { x: 0, y: 0, z: 0 },
      {
        breakSpeed: 45,
        breakSlowdown: 0.06,
        bounceRestitution: 0.25,
        radiusFraction: 0.3,
        cellMetres: 64,
        racerStuckSeconds: 0.25,
      },
    )
    expect(jumpSeatHeadThreat(seat, guard, DEFAULT_JUMPSEAT_AUTOPILOT), 'no forest').toBe(-1)
    const when = jumpSeatHeadThreat(seat, { ...guard, props }, DEFAULT_JUMPSEAT_AUTOPILOT)
    expect(when).toBeGreaterThanOrEqual(0)
    expect(when).toBeLessThan(1)
  })

  it('does not fire when the head trails: leaning away from its travel', () => {
    const seat = seatAt(GROUND + 30, 0.7, 'z')
    seat.body.velocity.x = 30
    expect(jumpSeatHeadThreat(seat, guard, DEFAULT_JUMPSEAT_AUTOPILOT)).toBe(-1)
  })
})

// ── never cross a pad's rim below its top ────────────────────────────────

describe('DEV-403: the pilot keeps outside a pad it is below', () => {
  // A stop shaped like the shipped pads, relative to its plate: top 3.96 above,
  // underside 0.21 below, 20.3 m across the rim.
  const PLATE = v3(512, GROUND + 100, 512)
  const stop: JumpSeatWaypoint = {
    centre: PLATE,
    axes: [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)],
    half: v3(7, 1.3, 7),
    pad: 0,
    points: 100,
    padTop: 3.96,
    padRadius: 20.3,
    padBottom: -0.21,
  } as unknown as JumpSeatWaypoint
  const T = DEFAULT_JUMPSEAT_AUTOPILOT
  const aimFor = (
    x: number,
    y: number,
    z: number,
  ): { moved: boolean; aim: ReturnType<typeof v3> } => {
    const seat = createJumpSeat()
    seat.body.position.x = x
    seat.body.position.y = y
    seat.body.position.z = z
    const aim = v3(PLATE.x, PLATE.y + 50, PLATE.z)
    keepOutsideTheRim(aim, seat, stop, T)
    return { moved: aim.y !== PLATE.y + 50, aim }
  }

  it('beside it and below its top: climb where you are, above the top', () => {
    // 40 m out, 20 m below the plate: the straight line at the aim crosses the
    // rim below its top, which is `adv_02_jumpSeat`'s strike.
    const { moved, aim } = aimFor(PLATE.x + 40, PLATE.y - 20, PLATE.z)
    expect(moved).toBe(true)
    expect(aim.x).toBeCloseTo(PLATE.x + 40, 6)
    expect(aim.y).toBeCloseTo(PLATE.y + 3.96 + T.padApproachClearance, 6)
  })

  it('far out: come no closer than standoffMetres beyond the rim', () => {
    const { aim } = aimFor(PLATE.x + 500, PLATE.y - 20, PLATE.z)
    expect(aim.x).toBeCloseTo(PLATE.x + 20.3 + T.standoffMetres, 6)
  })

  it('under it: out sideways first, at the seat’s own height', () => {
    const { moved, aim } = aimFor(PLATE.x + 5, PLATE.y - 30, PLATE.z)
    expect(moved).toBe(true)
    expect(aim.y).toBeCloseTo(PLATE.y - 30, 6)
    expect(aim.x).toBeCloseTo(PLATE.x + 20.3 + T.padApproachClearance, 6)
  })

  it('in the bowl, or above the top: untouched — a landing and a refuel hold are never moved', () => {
    expect(aimFor(PLATE.x + 2, PLATE.y + 1.5, PLATE.z).moved, 'in the bowl').toBe(false)
    expect(aimFor(PLATE.x + 60, PLATE.y + 10, PLATE.z).moved, 'above the top').toBe(false)
  })
})

describe('DEV-403: under a pad, the guard does not climb', () => {
  const pad = buildPadField({
    centre: v3(512, GROUND + 60, 512),
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    symmetry: 8,
    profile: [
      [0, 10],
      [20, 10],
    ],
    outer: 20,
    bottom: 6,
  })
  const guard = { box: BOX, surfaces: [...LAND, pad] }

  it('reads UNDER a floating pad as under it, and beside or above it as not', () => {
    const T = DEFAULT_JUMPSEAT_AUTOPILOT
    expect(jumpSeatHeadUnderPad(seatAt(GROUND + 30), guard, T), 'under').toBe(true)
    const beside = seatAt(GROUND + 30)
    beside.body.position.x = 560
    expect(jumpSeatHeadUnderPad(beside, guard, T), 'beside').toBe(false)
    expect(jumpSeatHeadUnderPad(seatAt(GROUND + 80), guard, T), 'above').toBe(false)
  })
})

describe('who the rule applies to', () => {
  const ANNIVERSARY = { gameplay: { variants: { enabled: true } } }

  it('every seat that climbs: the standard seat and the overclocked one', () => {
    expect(headStrikeApplies(jumpSeatFor())).toBe(true)
    const overclocked = resolveVariant('jumpseat', 'overclocked', ANNIVERSARY)
    expect(overclocked.id).toBe('overclocked')
    expect(headStrikeApplies(jumpSeatFor(overclocked))).toBe(true)
  })

  // NOT READY TO SHIP (Matt, 2026-09-25, DEV-403): the spider is `listed: false`,
  // and its tests skip on `SPIDER_READY` until it is ready (`variant-listed.test.ts`).
  it.skipIf(!SPIDER_READY)(
    'NOT the jumping spider, YET: a temporary deviation, to be flipped here on purpose',
    () => {
      // Matt, 2026-09-25: land the rule for the seats that climb, and exempt the
      // spider until its hop planner finishes all six with it on (DEV-403's row;
      // `docs/plan/JUMPSEAT-HEAD-CRASH.md` §9). When it does, this expectation
      // turns, and `tests/unit/variant-spider.test.ts` is the proof it may.
      const spider = resolveVariant('jumpseat', 'spider', ANNIVERSARY)
      expect(spider.id).toBe('spider')
      expect(headStrikeApplies(jumpSeatFor(spider))).toBe(false)
    },
  )
})
