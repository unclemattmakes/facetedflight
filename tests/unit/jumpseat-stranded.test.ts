// tests/unit/jumpseat-stranded.test.ts — a dry seat no pad can reach. DEV-342.
//
// The soft-lock: the thruster LATCHES off at an empty tank and only a pad's
// refuel sphere relights it, so a seat that runs dry anywhere no sphere can
// reach it falls, lands, and sits there for ever with the run still open.
// Found on `int_01_jumpSeat` by the autopilot, 2 runs of 2: dry at ~101 s over
// the sea, floating at about 1 km/h, `crash().phase` still "flying", no clock
// ending in Target Practice. 2016 had it too (its sea is a solid
// `TerrainCollider`); Matt's call is that such a run RESTARTS.
//
// Two halves. The RULE, pinned one condition at a time on a seat whose state is
// set by hand — and then the rule inside the REAL flight model, dropping a dry
// seat onto flat ground (the Simonet sea is a flat plate) with the seam's own
// collision spec, because a rule that is right about a hand-set velocity and
// wrong about what the seat actually does after landing is the bug this row
// exists to close. The second half found that it WAS wrong about it: a seat
// that lands tilted sails on its hover motor at 4.2 m/s for ever, which is why
// "supported" is judged on the vertical alone.

import { describe, expect, it } from 'vitest'
import { STRANDED } from '@/game/jumpseat-flight'
import { JUMPSEAT } from '@/generated/constants.generated'
import { FIXED_DT, GRAVITY } from '@/sim/constants'
import {
  createJumpSeat,
  type JumpSeat,
  noJumpSeatInput,
  stepJumpSeat,
  updateJumpSeatFootProbes,
} from '@/sim/jumpseat'
import { createRefuel, type RefuelSphere, stepJumpSeatRefuel } from '@/sim/jumpseat-refuel'
import {
  createStranded,
  resetStranded,
  type StrandedPhase,
  type StrandedSpec,
  stepJumpSeatStranded,
  strandedNow,
} from '@/sim/jumpseat-stranded'
import { v3 } from '@/sim/math/vec3'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import {
  collisionAngularDrag,
  createTerrainCollision,
  hullFromColliders,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'

// ── a seat in a known state ───────────────────────────────────────────────

/** Live, burning, thruster latched off, at rest in the open: stranded in every respect. */
const drySeat = (): JumpSeat => {
  const seat = createJumpSeat()
  seat.legs = null
  seat.live = true
  seat.burnsFuel = true
  seat.fuel = -3
  seat.thrusterEnabled = false
  seat.body.position.x = 0
  seat.body.position.y = 50
  seat.body.position.z = 0
  return seat
}

/**
 * A pad's sphere, 19.707 m and 10 units/s like every shipped one, somewhere
 * else — 580 m from both the hand-set seat at the origin and the drop point at
 * (512, 512) below. (Its first position was 17 m from the drop point, inside its
 * own radius, and the "dry" seat relit on landing; `farFromEverySeat` guards it.)
 */
const FAR_PAD: RefuelSphere = { centre: v3(100, 50, 100), radius: 19.707, rate: 10 }
const noPads = () => createRefuel([FAR_PAD])

const ticks = (seconds: number): number => Math.ceil(seconds / FIXED_DT - 1e-9)

// ── the shipped numbers ───────────────────────────────────────────────────

describe('DEV-342: the stranded numbers', () => {
  it('are the three the row names — edit this on purpose or not at all', () => {
    // `restSeconds` is Matt's (2026-09-24), `verticalSpeed` is derived below,
    // and `holdSeconds` is 2016's own JumpSeat death: `Trigger_Reset.cs:62`,
    // `WaitForSeconds(1f)` between the fade and the reload.
    expect(STRANDED).toEqual({ restSeconds: 3, verticalSpeed: 2, holdSeconds: 1 })
  })

  it('a free fall cannot stay inside the vertical band for anything like restSeconds', () => {
    // The premise of judging "carried" on the vertical: with the thruster gone,
    // gravity changes v.y by |g| every second, so the band ±verticalSpeed is
    // crossed in 2 x verticalSpeed / |g|. If that were anywhere near
    // restSeconds, a slow fall past a pad could be judged stranded mid-air.
    const crossing = (2 * STRANDED.verticalSpeed) / Math.abs(GRAVITY.y)
    expect(crossing).toBeLessThan(STRANDED.restSeconds / 10)
  })
})

// ── the rule, one condition at a time ─────────────────────────────────────

describe('DEV-342: stranded is four facts at once', () => {
  it('a dry, live, burning seat at rest outside every sphere IS stranded', () => {
    expect(strandedNow(drySeat(), noPads(), STRANDED)).toBe(true)
  })

  it('not before GO — there is no thruster yet to be out', () => {
    const seat = drySeat()
    seat.live = false
    expect(strandedNow(seat, noPads(), STRANDED)).toBe(false)
  })

  it('not in Free Flight — a tank that cannot empty strands nobody', () => {
    const seat = drySeat()
    seat.burnsFuel = false
    expect(strandedNow(seat, noPads(), STRANDED)).toBe(false)
  })

  it('not while the thruster is lit, however low the tank', () => {
    const seat = drySeat()
    seat.thrusterEnabled = true
    seat.fuel = 0.5
    expect(strandedNow(seat, noPads(), STRANDED)).toBe(false)
  })

  it('not inside a sphere — a negative tank there is a pad paying it off', () => {
    const seat = drySeat()
    seat.body.position.x = FAR_PAD.centre.x + 10
    seat.body.position.y = FAR_PAD.centre.y
    seat.body.position.z = FAR_PAD.centre.z
    expect(strandedNow(seat, noPads(), STRANDED)).toBe(false)
  })

  it('not while falling — the fall may yet end in a sphere', () => {
    const seat = drySeat()
    seat.body.velocity.y = -(STRANDED.verticalSpeed + 0.01)
    expect(strandedNow(seat, noPads(), STRANDED)).toBe(false)
  })

  it('SAILING still counts: horizontal speed is not the question', () => {
    // A tilted dry seat sails on its hover motor (measured below, 4.2 m/s).
    const seat = drySeat()
    seat.body.velocity.x = 4.2
    expect(strandedNow(seat, noPads(), STRANDED)).toBe(true)
  })
})

describe('DEV-342: the clock the rule keeps', () => {
  it('counts restSeconds unbroken, then dies for holdSeconds, then restarts ONCE', () => {
    const seat = drySeat()
    const refuel = noPads()
    const state = createStranded()
    const phases: StrandedPhase[] = []
    const restartTicks: number[] = []
    const total = ticks(STRANDED.restSeconds + STRANDED.holdSeconds) + 50
    for (let i = 0; i < total; i++) {
      if (stepJumpSeatStranded(state, seat, refuel, STRANDED, FIXED_DT)) restartTicks.push(i)
      phases.push(state.phase)
    }
    expect(phases[0]).toBe('stranding')
    // The tick that completes restSeconds is the first `dying` one.
    expect(phases.indexOf('dying')).toBe(ticks(STRANDED.restSeconds) - 1)
    expect(phases[ticks(STRANDED.restSeconds) - 2]).toBe('stranding')
    // Exactly one restart, holdSeconds after that — and none after it, even
    // though nobody reset the state: a caller that is slow to respawn cannot
    // restart the run twice.
    expect(restartTicks).toEqual([ticks(STRANDED.restSeconds) - 1 + ticks(STRANDED.holdSeconds)])
  })

  it('any tick that breaks a condition starts the count again', () => {
    const seat = drySeat()
    const refuel = noPads()
    const state = createStranded()
    for (let i = 0; i < ticks(STRANDED.restSeconds) - 5; i++) {
      stepJumpSeatStranded(state, seat, refuel, STRANDED, FIXED_DT)
    }
    expect(state.phase).toBe('stranding')
    // One tick of falling — a slide off a ledge.
    seat.body.velocity.y = -10
    stepJumpSeatStranded(state, seat, refuel, STRANDED, FIXED_DT)
    expect(state.phase).toBe('ok')
    expect(state.restFor).toBe(0)
    seat.body.velocity.y = 0
    for (let i = 0; i < ticks(STRANDED.restSeconds) - 2; i++) {
      stepJumpSeatStranded(state, seat, refuel, STRANDED, FIXED_DT)
    }
    expect(state.phase, 'the count began again from zero').toBe('stranding')
  })

  it('a lost run stays lost: dying does not look back', () => {
    const seat = drySeat()
    const refuel = noPads()
    const state = createStranded()
    for (let i = 0; i < ticks(STRANDED.restSeconds); i++) {
      stepJumpSeatStranded(state, seat, refuel, STRANDED, FIXED_DT)
    }
    expect(state.phase).toBe('dying')
    seat.thrusterEnabled = true
    let restarted = false
    for (let i = 0; i < ticks(STRANDED.holdSeconds) + 2; i++) {
      restarted ||= stepJumpSeatStranded(state, seat, refuel, STRANDED, FIXED_DT)
    }
    expect(restarted).toBe(true)
  })

  it('resetStranded is the respawn: back to ok with nothing counted', () => {
    const seat = drySeat()
    const state = createStranded()
    for (let i = 0; i < ticks(STRANDED.restSeconds); i++) {
      stepJumpSeatStranded(state, seat, noPads(), STRANDED, FIXED_DT)
    }
    resetStranded(state)
    expect(state).toEqual(createStranded())
  })

  it('trap 19: stepping a SECOND state does not move the first', () => {
    const a = createStranded()
    const b = createStranded()
    const dry = drySeat()
    const flying = drySeat()
    flying.thrusterEnabled = true
    for (let i = 0; i < 100; i++) {
      stepJumpSeatStranded(a, flying, noPads(), STRANDED, FIXED_DT)
      stepJumpSeatStranded(b, dry, noPads(), STRANDED, FIXED_DT)
    }
    expect(a).toEqual(createStranded())
    expect(b.phase).toBe('stranding')
  })
})

// ── the rule inside the real flight model ─────────────────────────────────

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

/** Flat ground at y = 50 over a 1 km square — a stand-in for the Simonet sea, which is a flat plate. */
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

interface DropResult {
  readonly restartAt: number | null
  readonly everDying: boolean
  readonly landedAt: number | null
  readonly speedAtEnd: number
  readonly horizontalAtEnd: number
  readonly lit: boolean
}

/**
 * The seam's own order, from `game/jumpseat-flight.ts`'s `step()`: flight model,
 * terrain collision, feet, refuel, and THEN the stranded rule.
 */
const drop = (
  spheres: readonly RefuelSphere[],
  options: { tilt?: number; seconds?: number; spec?: StrandedSpec } = {},
): DropResult => {
  const seat = createJumpSeat()
  seat.live = true
  seat.fuel = -1
  seat.thrusterEnabled = false
  seat.body.position.x = 512
  seat.body.position.y = GROUND + 150
  seat.body.position.z = 512
  const half = (options.tilt ?? 0) / 2
  seat.body.orientation.x = Math.sin(half)
  seat.body.orientation.w = Math.cos(half)
  const collision = createTerrainCollision()
  const baseAngularDrag = seat.body.angularDrag
  const refuel = createRefuel(spheres)
  const state = createStranded()
  const input = noJumpSeatInput()
  const spec = options.spec ?? STRANDED
  let restartAt: number | null = null
  let everDying = false
  let landedAt: number | null = null
  const steps = ticks(options.seconds ?? 20)
  for (let i = 0; i < steps && restartAt === null; i++) {
    stepJumpSeat(seat, input, [FLAT], FIXED_DT)
    stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
    seat.body.angularDrag = collisionAngularDrag(collision, COLLISION, baseAngularDrag)
    updateJumpSeatFootProbes(seat)
    stepJumpSeatRefuel(refuel, seat, seat.body.position, FIXED_DT)
    if (stepJumpSeatStranded(state, seat, refuel, spec, FIXED_DT)) restartAt = (i + 1) * FIXED_DT
    if (state.phase === 'dying') everDying = true
    if (landedAt === null && seat.body.position.y < GROUND + 10) landedAt = (i + 1) * FIXED_DT
  }
  const v = seat.body.velocity
  return {
    restartAt,
    everDying,
    landedAt,
    speedAtEnd: Math.hypot(v.x, v.y, v.z),
    horizontalAtEnd: Math.hypot(v.x, v.z),
    lit: seat.thrusterEnabled,
  }
}

describe('DEV-342: a dry seat dropped onto flat ground, in the real flight model', () => {
  it('farFromEverySeat: the "far" pad really is out of reach of the drop', () => {
    const d = Math.hypot(512 - FAR_PAD.centre.x, 512 - FAR_PAD.centre.z)
    expect(d).toBeGreaterThan(FAR_PAD.radius * 10)
    expect(Math.hypot(FAR_PAD.centre.x, FAR_PAD.centre.z)).toBeGreaterThan(FAR_PAD.radius * 5)
  })

  it('lands level, creeps, and is restarted restSeconds + holdSeconds after it settles', () => {
    const r = drop([FAR_PAD])
    expect(r.landedAt, 'it reached the ground').not.toBeNull()
    expect(r.restartAt, 'the run restarted').not.toBeNull()
    const after = (r.restartAt as number) - (r.landedAt as number)
    // Settling takes a moment — the legs and the hover cushion — and then the
    // two windows run back to back. Bounded both ways so a rule that fired
    // mid-fall, or never quite settled, cannot pass.
    expect(after).toBeGreaterThanOrEqual(STRANDED.restSeconds + STRANDED.holdSeconds)
    expect(after).toBeLessThan(STRANDED.restSeconds + STRANDED.holdSeconds + 2)
  })

  it('lands TILTED and sails for ever — and is still restarted', () => {
    // The case that made the rule vertical. Measured when it was written: a
    // 0.2 rad landing sails at a steady ~4.2 m/s on the hover motor, with no
    // input and no thrust. A "slower than X" test misses it; this one does not.
    const r = drop([FAR_PAD], { tilt: 0.2 })
    expect(r.horizontalAtEnd, 'the premise: it is still sailing when the run ends').toBeGreaterThan(
      2,
    )
    expect(r.restartAt).not.toBeNull()
  })

  it('the one rescue 2016 offers still works: falling INTO a sphere relights it', () => {
    // A dry seat over a pad falls into the pad's sphere, the pad pays off the
    // deficit at 10 units/s, and the latch comes off. Never stranded, never dying.
    const pad: RefuelSphere = { centre: v3(512, GROUND + 2, 512), radius: 19.707, rate: 10 }
    const r = drop([pad])
    expect(r.lit, 'the pad relit the thruster').toBe(true)
    expect(r.everDying).toBe(false)
    expect(r.restartAt).toBeNull()
  })

  it('without the rule the same seat would sit there for ever — the soft-lock, pinned', () => {
    // The whole reason for DEV-342, measured rather than asserted: switch the
    // rule off (a rest window no run can fill) and the dry seat is still out of
    // every sphere and still dark after a long minute, with nothing that could
    // ever change either.
    const never: StrandedSpec = { ...STRANDED, restSeconds: Number.POSITIVE_INFINITY }
    const r = drop([FAR_PAD], { spec: never, seconds: 60 })
    expect(r.restartAt).toBeNull()
    expect(r.lit).toBe(false)
    expect(r.speedAtEnd).toBeLessThan(1)
  })
})
