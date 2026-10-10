// tests/unit/surface-proximity.test.ts — the NEAREST surface, not just the one
// under the belly (DEV-112).
//
// Matt: *"flying low IS fun - and intense. we should also score near misses and
// whatnot, so hugging a wall scores higher."*
//
// The order is the order these would hurt in:
//
//  1. **A wall beside the ship reads as NEAR** while the belly is clear. This is
//     the whole change; without it the file is `hullClearance` with extra steps.
//  2. **Where there is no wall, nothing changed.** The belly reading is the
//     probe that needs no march, equal to `hullClearance` to the bit, and a
//     reach of 0 collapses the module to exactly the number the port had.
//  3. **A second ship does not move the first's readings** — trap 19, the
//     shared-scratch bug DEV-032 paid for.
//  4. **Deterministic**, run to run.
//  5. **The sample budget is what the header says it is**, counted rather than
//     believed.
//  6. An autopilot lap of `int_01` over the real island, printing the
//     distribution the way DEV-110 §4 did — because a threshold nobody has
//     measured against a real lap is a guess wearing a number.
//
// The synthetic field is `autopilot-ground.test.ts`'s ridge: flat sea floor at
// 0 with a wall of rock from `u = 0.55`, 540 m high. On an 8 m grid the face is
// a single bilinear cell, 2248..2256 m in x, so at any height below 540 the face
// is at a known x and the geometry can be asserted as a DISTANCE, not as a
// belief about which way is which (the orientation lesson).

import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { courseGates, medalFor, NO_LEVERS, startMission, stepMission } from '@/game/mission'
import { HOVERJET } from '@/generated/constants.generated'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { autopilotActions, DEFAULT_AUTOPILOT, nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { createCourse, stepCourse } from '@/sim/course'
import { createHoverMotor, type HoverMotorSpec, stepHoverMotor } from '@/sim/hover-motor'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { type Quat, quat, rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { createProximity, proximityBonus, proximityDemand } from '@/sim/proximity'
import type { RigidBody } from '@/sim/rigidbody'
import {
  createSurfaceProximity,
  marchSteps,
  PROBE_NAMES,
  PROBES,
  probeSurface,
  type SurfaceProximity,
  sampleBudget,
} from '@/sim/surface-proximity'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import {
  buildHeightField,
  type HeightField,
  outsideField,
  terrainHeightAt,
} from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import {
  createTerrainCollision,
  type HullSphere,
  hullClearance,
  hullFromColliders,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'
import anniversaryJson from '../../content/editions/anniversary.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import int02 from '../../content/levels/int_02_hoverJet.json'
import rookie01 from '../../content/levels/rookie_01_hoverJet.json'
import { fieldFor, haveMaps, oceanFieldFor } from './helpers/terrain-field'

const anniversary = anniversaryJson as unknown as Edition
const PROX = anniversary.gameplay.proximity
const EVENTS = anniversary.gameplay.gateEvents
/** The reach the game passes: the far end of G1's ramp. */
const REACH = PROX.farMetres

// ── the synthetic world ─────────────────────────────────────────────────────

const PARAMS = {
  terrainSize: 4096,
  terrainHeight: 600,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

const ridgeMap = (): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(u: number, _v: number, out: Rgb): Rgb {
      const g = u > 0.55 ? 0.9 : 0
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const flatMap = (): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(_u: number, _v: number, out: Rgb): Rgb {
      out.r = 0
      out.g = 0
      out.b = 0
      return out
    },
  }) as unknown as MapSampler

const RIDGE = buildHeightField(ridgeMap(), PARAMS, { position: [0, 0, 0], scale: [1, 1, 1] })
const FLAT = buildHeightField(flatMap(), PARAMS, { position: [0, 0, 0], scale: [1, 1, 1] })

/** First grid column at 0.9: `u > 0.55` with u = x / 512, so column 282 — 2256 m. */
const WALL_TOP_X = 282 * 8
/** The face is one bilinear cell wide: 0 at 2248, 540 at 2256. */
const faceXAt = (height: number): number => WALL_TOP_X - 8 + (8 * height) / 540

/** The HoverJet's own hull, the way `game/flight.ts` builds it. */
const HULL: HullSphere[] = hullFromColliders(
  HOVERJET.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
)
/** One sphere at the origin, for the arithmetic tests where a hull would only add offsets. */
const R = 1.5
const POINT: HullSphere[] = [{ x: 0, y: 0, z: 0, radius: R }]

const bodyAt = (x: number, y: number, z: number, orientation: Quat = quat()): RigidBody =>
  ({
    position: v3(x, y, z),
    orientation,
    velocity: v3(),
    angularVelocity: v3(),
    mass: 4,
    drag: 0,
    angularDrag: 0,
  }) as unknown as RigidBody

/** Yaw +90° about y: ship +z faces world +x, ship +x faces world −z. */
const FACING_X: Quat = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
/** Roll +90° about z: ship −y (its belly) faces world +x. */
const KNIFE_EDGE_RIGHT: Quat = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }

describe('DEV-112 — a wall beside the ship reads as NEAR', () => {
  it('sees a cliff 10 m off the wingtip while the belly is 300 m clear', () => {
    // Level, facing +z, so the ship's +x (its RIGHT probe) points at the face.
    const gap = 10
    const cx = faceXAt(300) - gap - R
    const out = probeSurface(bodyAt(cx, 300, 1000), [RIDGE], POINT, REACH, createSurfaceProximity())
    expect(out.below, 'the belly is clear').toBeCloseTo(300 - R, 6)
    // Within one facet of the true gap: the root is interpolated between the
    // last clear sample and the first buried one, and the face is a ramp, not
    // a step, so the bracket is linear-in-h only inside one cell.
    expect(out.nearest).toBeGreaterThan(gap - 8)
    expect(out.nearest).toBeLessThan(gap + 8)
    expect(out.nearest).toBeLessThan(out.below)
    expect(PROBE_NAMES[out.probe]).toBe('right')
  })

  it('and it is under the near-miss threshold when the wall is that close', () => {
    // The point of the exercise: a pass 4 m off a cliff is a CLOSE.
    const gap = 4
    const cx = faceXAt(300) - gap - R
    const out = probeSurface(bodyAt(cx, 300, 1000), [RIDGE], POINT, REACH, createSurfaceProximity())
    expect(out.nearest).toBeLessThanOrEqual(EVENTS.nearMissMetres)
    expect(out.below).toBeGreaterThan(PROX.farMetres)
  })

  it('the ridge AHEAD is seen by forward-down before the belly reaches it', () => {
    // Facing the wall, 20 m short of it, 40 m up. The 45° forward-down line
    // meets the face before the vertical meets the floor.
    const body = bodyAt(faceXAt(0) - 20, 40, 1000, FACING_X)
    const out = probeSurface(body, [RIDGE], POINT, REACH, createSurfaceProximity())
    expect(PROBE_NAMES[out.probe]).toBe('forward-down')
    expect(out.nearest).toBeLessThan(out.below)
    expect(out.below).toBeCloseTo(40 - R, 6)
  })

  it('in a knife-edge bank the BELLY probe faces the wall, not the floor', () => {
    // Rolled 90° right so the ship's own down points at the face. World-down
    // still reads the floor (that is `below`); the ship-frame `down` probe
    // reads the wall, and that is the one that wins.
    const gap = 6
    const body = bodyAt(faceXAt(200) - gap - R, 200, 1000, KNIFE_EDGE_RIGHT)
    const out = probeSurface(body, [RIDGE], POINT, REACH, createSurfaceProximity())
    expect(PROBE_NAMES[out.probe]).toBe('down')
    expect(out.nearest).toBeLessThan(gap + 8)
    expect(out.below).toBeCloseTo(200 - R, 6)
  })

  it('reads BOTH fields — the sea counts as a surface the way the land does', () => {
    // Open water: the land field is at 0 and a second "sea" field sits at 100.
    // A ship 5 m over the sea must read 5, not 105.
    const SEA = buildHeightField(flatMap(), PARAMS, { position: [0, 100, 0], scale: [1, 1, 1] })
    const out = probeSurface(
      bodyAt(500, 105 + R, 500),
      [FLAT, SEA],
      POINT,
      REACH,
      createSurfaceProximity(),
    )
    expect(out.nearest).toBeCloseTo(5, 9)
    expect(out.below).toBeCloseTo(5, 9)
  })

  it('answers Infinity OUTSIDE every field, and nothing points UP or AFT', () => {
    // Beyond the footprint — no ground under it and none within reach. Inside
    // the footprint the vertical is unbounded by design, so "in the clear" is
    // a large number rather than Infinity; that case is the next describe's.
    const out = probeSurface(
      bodyAt(-200, 2000, 500),
      [RIDGE],
      POINT,
      REACH,
      createSurfaceProximity(),
    )
    expect(out.nearest).toBe(Number.POSITIVE_INFINITY)
    expect(out.below).toBe(Number.POSITIVE_INFINITY)
    expect(out.probe).toBe(-1)
    expect(out.samples).toBe(0)
    for (const d of PROBES) {
      expect(d.y, 'no probe looks up').toBeLessThanOrEqual(0)
      expect(d.z, 'no probe looks aft').toBeGreaterThanOrEqual(0)
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 12)
    }
  })
})

describe('DEV-112 — where there is no wall, nothing changed', () => {
  const SPEC: TerrainCollisionSpec = {
    hull: HULL,
    restitution: 0,
    friction: 0.6,
    flashSeconds: 0.3,
    flashAngularDrag: 3,
  }
  const attitudes: Quat[] = [
    quat(),
    FACING_X,
    KNIFE_EDGE_RIGHT,
    { x: 0.2, y: 0.3, z: -0.1, w: Math.sqrt(1 - 0.04 - 0.09 - 0.01) },
  ]

  it('`below` IS `hullClearance`, to the bit, at every attitude', () => {
    // Not `toBeCloseTo`: the operand order is the same on purpose, so that G1's
    // meter fed by this module and by the collision hull cannot disagree by an
    // ulp somewhere a threshold happens to sit.
    for (const q of attitudes) {
      const body = bodyAt(900, 250, 900, q)
      const out = probeSurface(body, [RIDGE, FLAT], HULL, REACH, createSurfaceProximity())
      expect(out.below).toBe(hullClearance(body, [RIDGE, FLAT], SPEC))
    }
  })

  it('`nearest` equals the belly wherever no probe reaches anything else', () => {
    // 900 m from the face, well over a flat floor. The fan reaches 90 m; the
    // only thing in range is the floor, and every lateral probe meets it at a
    // shallower angle than the vertical does, so the belly wins.
    //
    // `toBeCloseTo`, and this is the one place in the file that is not exact,
    // for a reason worth having in writing: a LEVEL ship's own `down` probe is
    // the vertical line re-marched, and its interpolated root lands within
    // 1e-13 of the exact one — on either side. When it lands under, that probe
    // "wins" by rounding. Harmless: both levers read `nearest`, it is ONE
    // number either way, and `below` is the exact one (the test above). It is
    // recorded rather than papered over with a tolerance in the module.
    const world = v3()
    for (const q of attitudes) {
      const body = bodyAt(900, 50, 900, q)
      const out = probeSurface(body, [RIDGE], HULL, REACH, createSurfaceProximity())
      expect(out.nearest).toBeCloseTo(out.below, 9)
      if (out.probe >= 0) {
        // Whichever probe it was — `down` when level, `left` in a knife-edge
        // bank — its WORLD direction is the vertical line, so it measured the
        // same thing the exact reading did.
        rotateVec3(world, q, PROBES[out.probe] as Vec3)
        expect(Math.hypot(world.x, world.z)).toBeLessThan(1e-9)
        expect(world.y).toBeCloseTo(-1, 12)
      }
    }
    // And a tilted ship, whose `down` is a genuinely different line, has the
    // belly winning outright.
    const tilted = probeSurface(
      bodyAt(900, 50, 900, attitudes[3] as Quat),
      [RIDGE],
      HULL,
      REACH,
      createSurfaceProximity(),
    )
    expect(tilted.probe).toBe(-1)
    expect(tilted.nearest).toBe(tilted.below)
  })

  it('in the clear inside the footprint, the fan finds nothing under 90 m', () => {
    const out = probeSurface(
      bodyAt(500, 2000, 500),
      [RIDGE],
      POINT,
      REACH,
      createSurfaceProximity(),
    )
    expect(out.below).toBeCloseTo(2000 - R, 9)
    expect(out.nearest).toBeCloseTo(out.below, 9)
  })

  it('a reach of 0 is the belly line the port had, even beside the wall', () => {
    const body = bodyAt(faceXAt(300) - 4 - R, 300, 1000)
    const out = probeSurface(body, [RIDGE], POINT, 0, createSurfaceProximity())
    expect(out.nearest).toBe(out.below)
    expect(out.nearest).toBeCloseTo(300 - R, 6)
    expect(out.samples, 'one sample per sphere per field, nothing more').toBe(1)
  })

  it('keeps the SIGNED vertical while buried, and does not march from inside', () => {
    const body = bodyAt(900, -3, 900)
    const out = probeSurface(body, [RIDGE], POINT, REACH, createSurfaceProximity())
    expect(out.below).toBeCloseTo(-3 - R, 9)
    expect(out.nearest).toBe(out.below)
    expect(out.samples).toBe(1)
  })
})

describe('DEV-112 — trap 19: a second ship does not move the first', () => {
  it('two ships, two readings, the first untouched by the second', () => {
    const a = probeSurface(
      bodyAt(faceXAt(300) - 10 - R, 300, 1000),
      [RIDGE],
      POINT,
      REACH,
      createSurfaceProximity(),
    )
    const before: SurfaceProximity = { ...a }
    const b = probeSurface(bodyAt(-200, 2000, 500), [RIDGE], POINT, REACH, createSurfaceProximity())
    expect(b.nearest).toBe(Number.POSITIVE_INFINITY)
    expect(a).toEqual(before)
    expect(a.nearest).not.toBe(b.nearest)
  })

  it('is deterministic across two runs', () => {
    const run = () => {
      const outs: SurfaceProximity[] = []
      for (let i = 0; i < 40; i++) {
        const body = bodyAt(faceXAt(300) - 3 * i - R, 300 - 5 * i, 1000 + 20 * i, attitudeFor(i))
        outs.push(probeSurface(body, [RIDGE, FLAT], HULL, REACH, createSurfaceProximity()))
      }
      return outs
    }
    expect(run()).toEqual(run())
  })
})

const attitudeFor = (i: number): Quat => {
  const a = (i * 0.37) % (2 * Math.PI)
  return { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }
}

describe('DEV-112 — the sample budget, counted', () => {
  it('is the header’s formula: spheres × fields × (1 + 6 × ceil(reach / pitch))', () => {
    expect(marchSteps(RIDGE, REACH)).toBe(12)
    expect(sampleBudget(HULL.length, [RIDGE, FLAT], REACH)).toBe(HULL.length * 2 * (1 + 6 * 12))
    // The number the header quotes, for the real hull over two 8 m fields.
    expect(HULL.length).toBe(5)
    expect(sampleBudget(5, [RIDGE, FLAT], 90)).toBe(730)
  })

  it('never exceeds it, and in open air over both fields spends exactly it', () => {
    // Open air INSIDE both footprints, nothing within reach: no march exits
    // early, so the count is the bound itself. Beside the wall it is less.
    const clear = probeSurface(
      bodyAt(900, 2000, 900),
      [RIDGE, FLAT],
      HULL,
      REACH,
      createSurfaceProximity(),
    )
    expect(clear.samples).toBe(sampleBudget(HULL.length, [RIDGE, FLAT], REACH))
    const near = probeSurface(
      bodyAt(faceXAt(300) - 10, 300, 1000),
      [RIDGE, FLAT],
      HULL,
      REACH,
      createSurfaceProximity(),
    )
    expect(near.samples).toBeLessThan(clear.samples)
    expect(near.samples).toBeLessThanOrEqual(sampleBudget(HULL.length, [RIDGE, FLAT], REACH))
  })
})

// ── The lap ───────────────────────────────────────────────────────────────
//
// `autopilot.test.ts`'s harness with the ground put back: the mission's own land
// and ocean fields under the hull (`stepHoverMotor`, `stepTerrainCollision`),
// the fan measured every tick, and `stepMission` fed the levers the way
// `app.ts` feeds them. Printed, because DEV-110 §6 says the autopilot never
// triggered a near miss and the only way to know whether that is still true
// with walls counted is to count.
//
// Disk work inside the `it`, never above the guard: `describe.skipIf` skips the
// tests, not the body (CLAUDE.md), and the loud counterpart below says so when
// the maps are absent.

const LEVEL = int01 as unknown as Level

interface Lap {
  gates: number
  seconds: number
  nearMisses: number
  nearMissPoints: number
  gateBonus: number
  /** DEV-154's line channel: what the pool gained that neither other channel claimed. */
  linePoints: number
  /** `Σ level · dt` over the lap, accumulated here — the line channel's own oracle. */
  levelIntegral: number
  pool: number
  score: number
  /** Ticks binned by `nearest`: <8, 8–12, 12–30, 30–60, 60–90, ≥90/∞. */
  bins: number[]
  /** Ticks where a LATERAL probe won by more than 2 m over the belly — the wall doing work. */
  wallTicks: number
  /** Which probe won those ticks. */
  wallProbes: Record<string, number>
  minNearest: number
  maxSamples: number
  budget: number
}

const BIN_EDGES = [8, 12, 30, 60, 90]

/** One lap, the fan reaching `reach` metres — 0 is the belly line DEV-110 shipped. */
const lap = (reach: number): Lap => {
  const land = fieldFor(LEVEL as unknown as { environment: string; worldOffset: number[] })
  const ocean = oceanFieldFor(LEVEL as unknown as { environment: string; worldOffset: number[] })
  const fields: HeightField[] = ocean ? [land, ocean] : [land]

  const jet = createHoverJet()
  jet.launched = true
  threeTupleToUnity(jet.body.position, LEVEL.spawn.pos as number[])
  threeQuatTupleToUnity(jet.body.orientation, LEVEL.spawn.quat as number[])
  jet.body.position.y += LEVEL.spawn.launch?.rise ?? 0

  const HOVER: HoverMotorSpec = {
    hoverForce: HOVERJET.hoverMotor.hoverForce,
    hoverHeight: HOVERJET.hoverMotor.hoverHeight,
  }
  const COLLISION: TerrainCollisionSpec = {
    hull: HULL,
    restitution: 0,
    friction: 0.6,
    flashSeconds: 0.3,
    flashAngularDrag: 3,
  }
  const hover = createHoverMotor()
  const collision = createTerrainCollision()
  const course = createCourse(courseGates(LEVEL))
  const mission = startMission(LEVEL)
  const surface = createSurfaceProximity()
  const input = noInput()
  const fwd = v3()
  const FORWARD: Vec3 = v3(0, 0, 1)

  const out: Lap = {
    gates: 0,
    seconds: 0,
    nearMisses: 0,
    nearMissPoints: 0,
    gateBonus: 0,
    linePoints: 0,
    levelIntegral: 0,
    pool: 0,
    score: 0,
    bins: new Array(BIN_EDGES.length + 1).fill(0),
    wallTicks: 0,
    wallProbes: {},
    minNearest: Number.POSITIVE_INFINITY,
    maxSamples: 0,
    budget: sampleBudget(HULL.length, fields, reach),
  }

  // Until the LAST GATE, as `autopilot.test.ts` does — not until the clock. The
  // autopilot has no target past ring 21 and holds a frozen stick; the first
  // version of this lap let it run on, and it flew into a hillside at 103 s and
  // ground along the island for the remaining 77 s (704 strikes, 5,983 ticks
  // under 8 m). That was the harness measuring itself. A player crosses the
  // finish 234 m on (DEV-045) and the run ends.
  const steps = Math.ceil(LEVEL.timer.timeLimit / FIXED_DT)
  for (let i = 0; i < steps && !mission.finished && course.passedCount < course.gates.length; i++) {
    const target = nextGate(course.gates, course.passed)
    const gate = course.gates[target]
    if (!gate) break
    const after = course.gates[target + 1]?.centre ?? null
    autopilotActions(
      jet.body,
      gate.centre,
      input,
      DEFAULT_AUTOPILOT,
      fields,
      Number.POSITIVE_INFINITY,
      after,
    )
    stepHoverJet(jet, input)
    stepHoverMotor(hover, jet.body, fields, HOVER)
    const struck = stepTerrainCollision(collision, jet.body, fields, COLLISION, FIXED_DT)
    probeSurface(jet.body, fields, HULL, reach, surface)
    if (surface.samples > out.maxSamples) out.maxSamples = surface.samples
    rotateVec3(fwd, jet.body.orientation, FORWARD)
    const v = jet.body.velocity
    const speed = fwd.x * v.x + fwd.y * v.y + fwd.z * v.z
    stepCourse(course, jet.body.position)
    const poolBefore = mission.proximity.bonus
    stepMission(mission, LEVEL, jet.body.position, FIXED_DT, {
      clearance: surface.nearest,
      speed,
      struck,
      proximity: PROX,
      gateEvents: EVENTS,
    })
    // What the pool gained that neither the gate nor the near miss claimed is
    // DEV-154's line channel, by an accounting identity rather than by asking
    // the module to say. `levelIntegral` is its independent oracle.
    out.linePoints +=
      mission.proximity.bonus -
      poolBefore -
      mission.event.proximityBonus -
      mission.event.nearMissPoints
    out.levelIntegral += mission.proximity.level * FIXED_DT
    const n = surface.nearest
    if (n < out.minNearest) out.minNearest = n
    let bin = BIN_EDGES.findIndex((edge) => n < edge)
    if (bin < 0) bin = BIN_EDGES.length
    out.bins[bin] = (out.bins[bin] ?? 0) + 1
    if (surface.probe >= 0 && surface.below - n > 2) {
      out.wallTicks++
      const name = PROBE_NAMES[surface.probe] ?? '?'
      out.wallProbes[name] = (out.wallProbes[name] ?? 0) + 1
    }
    if (mission.event.nearMiss) out.nearMisses++
    out.nearMissPoints += mission.event.nearMissPoints
    out.gateBonus += mission.event.proximityBonus
  }
  out.gates = mission.ringsPassed
  out.seconds = mission.elapsed
  out.pool = mission.proximity.bonus
  out.score = mission.score
  return out
}

describe.skipIf(!haveMaps)('DEV-112 — an autopilot lap of int_01, with the walls counted', () => {
  it('prints the clearance distribution, fan against belly, on the same flying', () => {
    const fan = lap(REACH)
    const belly = lap(0)
    const labels = ['<8', '8-12', '12-30', '30-60', '60-90', '>=90']
    const line = (name: string, r: Lap) =>
      [
        `DEV-112 lap of int_01, ${name}: ${r.gates}/21 gates in ${r.seconds.toFixed(1)} s`,
        `  nearest-surface ticks: ${labels.map((l, i) => `${l}: ${r.bins[i]}`).join('  ')}  (${r.bins.reduce((a, b) => a + b, 0)})`,
        `  min nearest ${r.minNearest.toFixed(1)} m; wall ticks (lateral won by >2 m): ${r.wallTicks} ${JSON.stringify(r.wallProbes)}`,
        `  near misses ${r.nearMisses} = +${r.nearMissPoints}; gate bonus +${r.gateBonus}; line +${r.linePoints} (meter integral ${r.levelIntegral.toFixed(1)} s); pool ${r.pool}; score ${r.score}`,
        `  samples/tick max ${r.maxSamples} of budget ${r.budget}`,
      ].join('\n')
    console.info(`${line(`fan ${REACH} m`, fan)}\n${line('belly only', belly)}`)

    for (const r of [fan, belly]) {
      expect(r.gates).toBe(21)
      // The pool is the sum of its THREE channels and nothing else — the gate
      // bonus, the near miss, and DEV-154's line rate.
      expect(r.pool).toBe(r.gateBonus + r.nearMissPoints + r.linePoints)
      expect(r.nearMissPoints).toBe(r.nearMisses * EVENTS.nearMissPoints)
      // The line channel against its own oracle: `perSecond` times the integral
      // of the meter, accumulated here as a sum of products rather than by
      // replaying `proximity.ts`'s carry (trap 24). The RELATIONSHIP, not a
      // tolerance: whole points are banked and the remainder carried, so the
      // banked total is the FLOOR of the accrual and lands in a one-point
      // half-open interval — an assertion a rounding bug cannot satisfy.
      const accrued = PROX.perSecond * r.levelIntegral
      expect(r.linePoints).toBeLessThanOrEqual(accrued)
      expect(r.linePoints).toBeGreaterThan(accrued - 1)
      // And it is the channel that fixes DEV-110 §6: it pays on the LINE rather
      // than at 21 instants, so it is a real share of a lap the autopilot flies
      // at 60 m minimum — a controller that is TRYING to stay away from the
      // ground.
      expect(r.linePoints).toBeGreaterThan(0)
      // And the medal's number did not see any of it: 21 gates at 100 is the
      // score whatever the pool did — platinum IS a perfect run (DEV-110 §2).
      expect(r.score).toBe(2100)
      expect(r.maxSamples).toBeLessThanOrEqual(r.budget)
    }
    // Same flying, so the fan's number is never ABOVE the belly's: it is a
    // minimum over a set that contains the belly. Therefore the meter is never
    // lower and the pool is never smaller — "hugging a wall scores higher",
    // stated as the inequality it is, on a real course.
    expect(fan.minNearest).toBeLessThanOrEqual(belly.minNearest)
    expect(fan.pool).toBeGreaterThanOrEqual(belly.pool)
    // The belly harness cannot register a wall tick by construction.
    expect(belly.wallTicks).toBe(0)
    // The walls are REAL on this course: the authored line runs close enough
    // to rock that the fan wins on a sizeable share of ticks, and comes inside
    // the ramp's near band. The exact counts are printed, not pinned — they
    // are a controller's habits, not a property of the module.
    expect(fan.wallTicks).toBeGreaterThan(0.1 * fan.bins.reduce((a, b) => a + b, 0))
    expect(fan.minNearest).toBeLessThan(PROX.farMetres / 3)
    // The budget on the real island: the ocean plate's pitch is 256 m world
    // (32 x 8), so its march is one sample, and the bound is 5 x (73 + 7).
    expect(fan.budget).toBe(400)
  })

  it('the medal is the same with the lever on and off', () => {
    // The invariant, on a real flight rather than a synthetic one. Two missions
    // stepped on one lap: `medalFor` reads `state.score`, and the pool is not
    // in it.
    const level = LEVEL
    const on = startMission(level)
    const off = startMission(level)
    const at = v3(0, 5000, 0)
    for (let i = 0; i < 200; i++) {
      stepMission(on, level, at, FIXED_DT, {
        ...NO_LEVERS,
        clearance: 2,
        speed: 300,
        gateEvents: EVENTS,
        proximity: PROX,
      })
      stepMission(off, level, at, FIXED_DT)
    }
    expect(on.proximity.bonus).toBeGreaterThan(0)
    expect(medalFor(on, level)).toBe(medalFor(off, level))
    expect(on.score).toBe(off.score)
  })
})

describe.skipIf(!haveMaps)(
  'DEV-154 — the gates are NOT LOW, which is why a gate channel alone cannot pay',
  () => {
    it('no ring course has a single gate centre within `nearMetres` of the surface', () => {
      // THE MEASUREMENT THE WHOLE ROW RESTS ON. Matt, 2026-09-16: *"i've yet to
      // see scoring influenced by flying near objects/terrain."* G1's only inlet
      // was `bankProximity`, on a gate — so the most the lever could ever pay is
      // decided by how high 2016 hung its rings, which is a fact about the
      // extracted level data and nothing to do with this port's arithmetic.
      //
      // Disk work INSIDE the `it`, never above the guard (CLAUDE.md).
      const courses = [
        ['int_01_hoverJet', int01 as unknown as Level],
        ['rookie_01_hoverJet', rookie01 as unknown as Level],
        ['int_02_hoverJet', int02 as unknown as Level],
      ] as const
      for (const [id, lv] of courses) {
        const land = fieldFor(lv as unknown as { environment: string; worldOffset: number[] })
        const ocean = oceanFieldFor(lv as unknown as { environment: string; worldOffset: number[] })
        const fields: HeightField[] = ocean ? [land, ocean] : [land]
        const gates = courseGates(lv)
        expect(gates.length).toBeGreaterThan(0)
        const heights = gates.map((g) => {
          let best = Number.POSITIVE_INFINITY
          for (const f of fields) {
            if (outsideField(f, g.centre.x, g.centre.z)) continue
            const d = g.centre.y - terrainHeightAt(f, g.centre.x, g.centre.z)
            if (d < best) best = d
          }
          return best
        })
        // The ideal nobody can fly: the ship sitting exactly at every gate centre.
        const ceiling = heights.reduce(
          (a, c) =>
            a +
            proximityBonus(
              100,
              { ...createProximity(), level: proximityDemand(c, PROX.minSpeed, PROX) },
              PROX,
            ),
          0,
        )
        const nominal = gates.length * 100 * PROX.maxBonus
        console.info(
          `DEV-154 ${id}: ${gates.length} gates, centres ${Math.min(...heights).toFixed(1)}–${Math.max(
            ...heights,
          ).toFixed(1)} m above the surface; ` +
            `${heights.filter((h) => h < PROX.nearMetres).length} within nearMetres; ` +
            `best possible gate bonus +${ceiling} of ${nominal} (${((100 * ceiling) / nominal).toFixed(0)} %)`,
        )
        // Not ONE gate is low enough to fill the meter, on any of the three. So
        // `maxBonus` can never pay what it advertises however well anyone flies,
        // and that is a property of 2016's course, not of a threshold we picked.
        expect(
          heights.filter((h) => h < PROX.nearMetres),
          `${id}: a gate within nearMetres would make a full meter reachable`,
        ).toEqual([])
        // And the reachable ceiling is a small fraction of the nominal one. A
        // BOUND rather than the measured figure: the exact percentage is a
        // property of the course and would move if anyone re-authored it; that it
        // is nowhere near 100 % is the finding.
        expect(ceiling).toBeLessThan(nominal / 2)
      }
    })

    it('and the LINE channel pays on the same lap regardless', () => {
      // The fix, stated against the same courses: `perSecond` needs no gate, so
      // what it pays is decided by the flying rather than by where 2016 hung its
      // rings. Measured on the lap above — this is the cross-reference.
      expect(PROX.perSecond).toBeGreaterThan(0)
      expect(PROX.awardStep).toBeGreaterThan(0)
      const fan = lap(REACH)
      expect(fan.linePoints).toBeGreaterThan(0)
      // The autopilot holds `minClearance` 60 m — a controller TRYING to stay
      // away from the ground — and the line channel is still the same order as
      // the gate channel on its lap. A player who chooses to go down gets more of
      // it; a player who never does still sees it move, which is the whole point.
      expect(fan.linePoints).toBeGreaterThan(fan.gateBonus / 4)
    })
  },
)

describe.skipIf(haveMaps)('DEV-112/DEV-154 lap — terrain maps not present', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(haveMaps).toBe(false)
  })
})
