// tests/unit/helpers/variant-flight.ts — one scripted flight per aircraft,
// fingerprinted to the BIT. DEV-380.
//
// Two tests stand on this, and they need different things from one flight:
//
//  - `variant-standard.test.ts` holds `standard` to 2016 bit for bit. Its
//    expectation is a fingerprint RECORDED from the code as it was before
//    DEV-380 touched the vehicle constructors (commit f08e12e), stored in
//    `tests/unit/fixtures/variant-standard-trajectory.json`. Re-deriving the
//    expectation by running `createHoverJet()` beside `createHoverJet(view)`
//    would be trap 24: both sides go through the same new code, so a refactor
//    that moved every bit would still agree with itself.
//  - `variant-data.test.ts` asks the question DEV-069 taught: does every key
//    a variant may scale actually MOVE its vehicle? A whitelisted key nothing
//    reads is a menu that lies. So this script has to touch every whitelisted
//    key: a spool, a boost long enough to run the Anniversary tank dry, rolls,
//    pitches and yaws hard enough to swing the velocity off the nose (that is
//    the bleed), an airbrake, a gate chain; for the seat, a ramp, a boost, a
//    coast high enough for the DragHack's free-fall drag, and a hover inside
//    the cushion's reach.
//
// The fingerprint is a sha256 over every state variable on EVERY tick, packed
// as float64, plus a handful of samples for a readable failure message. A hash
// is the only compact form of "every bit of every tick"; the samples say where
// a divergence starts. Both vehicles run through their real step functions and
// nothing here is a model of them.
//
// **The script is FROZEN.** The recorded fingerprints are only a statement
// about THIS script. Changing a single input here re-records nothing and turns
// the standard test red — correctly, because the recording is then a statement
// about a flight nobody flies. Change the script only together with a new
// recording made from a commit whose vehicle code you trust, and say which in
// the fixture's `recordedAt`.

import { createHash } from 'node:crypto'
import { JUMPSEAT } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import { createEnergy, type EnergySpec, type EnergyState, stepEnergy } from '@/sim/energy'
import { createEnergyRace, type EnergyRaceSpec, payGate, stepEnergyRace } from '@/sim/energy-race'
import { type HoverJet, stepHoverJet } from '@/sim/hoverjet'
import { type JumpSeat, stepJumpSeat } from '@/sim/jumpseat'
import { chainGate } from '@/sim/speed-chain'
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

/** Ticks in each scripted flight: 24.4 s at the shipped step. */
export const SCRIPT_TICKS = 2000
/** A sample every this many ticks, for the failure message. */
const SAMPLE_EVERY = 250

export interface Fingerprint {
  /** sha256 of every state variable on every tick, float64, little-endian. */
  readonly sha256: string
  /** A few ticks' state, for a readable failure. Non-finite values as strings. */
  readonly samples: readonly (readonly (number | string)[])[]
}

const finish = (buffer: Float64Array, samples: (number | string)[][]): Fingerprint => ({
  sha256: createHash('sha256').update(new Uint8Array(buffer.buffer)).digest('hex'),
  samples,
})

// -0 and +0 are one number to every consumer of a trajectory, and JSON cannot
// carry the difference; fold it so the samples round-trip. The HASH is taken
// over the raw bits and keeps it, which is the stricter of the two.
const sampleValue = (x: number): number | string =>
  Number.isFinite(x) ? (x === 0 ? 0 : x) : String(x)

// ── HoverJet ──────────────────────────────────────────────────────────────

/**
 * The Anniversary tank's recharge multiplier, as a LITERAL: the recording is a
 * statement about this number, not about whatever the edition file says on the
 * day the test runs. (0.16 was `anniversary.json`'s value when recorded.)
 */
export const SCRIPT_RECHARGE_SCALE = 0.16
/** The energy race's two edition numbers, frozen for the same reason. */
export const SCRIPT_RACE_DRAIN = 0.2
export const SCRIPT_RACE_PAY = 0.35

const inWindow = (i: number, from: number, to: number): boolean => i >= from && i < to

/**
 * Fly a HoverJet through the frozen script. The caller builds the jet and the
 * two tank specs, so the same script serves the pre-DEV-380 code (no sheet
 * argument anywhere) and the view-taking code after it.
 */
export const flyHoverJetScript = (
  jet: HoverJet,
  energySpec: EnergySpec,
  raceSpec: EnergyRaceSpec,
): Fingerprint => {
  const PER_TICK = 19
  const out = new Float64Array(SCRIPT_TICKS * PER_TICK)
  const samples: (number | string)[][] = []
  const energy: EnergyState = createEnergy(energySpec)
  const race = createEnergyRace(raceSpec)
  const b = jet.body
  for (let i = 0; i < SCRIPT_TICKS; i++) {
    const throttle = i < 1000 ? 1 : i < 1100 ? 0 : 0.7
    const boostHeld = inWindow(i, 200, 900) || inWindow(i, 1500, 1700)
    // Energy first, as `boot/app.ts` does: the tank decides whether the boost
    // the stick asks for is lit, and the jet is handed the answer.
    const lit = stepEnergy(energy, energySpec, boostHeld, FIXED_DT)
    stepEnergyRace(race, raceSpec, throttle > 0, lit, FIXED_DT)
    if (i % 400 === 399) payGate(race, raceSpec)
    if (i === 250 || i === 500 || i === 750) chainGate(jet.chain)
    stepHoverJet(jet, {
      throttle,
      boost: lit,
      brake: inWindow(i, 1000, 1100),
      roll: inWindow(i, 300, 450)
        ? 1
        : inWindow(i, 450, 600)
          ? -0.5
          : inWindow(i, 1200, 1400)
            ? 0.6
            : 0,
      pitch: inWindow(i, 350, 500)
        ? 0.8
        : inWindow(i, 600, 750)
          ? -1
          : inWindow(i, 1400, 1600)
            ? 0.4
            : 0,
      yaw: inWindow(i, 500, 700) ? 1 : inWindow(i, 1600, 1800) ? -0.7 : 0,
    })
    const row = [
      b.position.x,
      b.position.y,
      b.position.z,
      b.orientation.x,
      b.orientation.y,
      b.orientation.z,
      b.orientation.w,
      b.velocity.x,
      b.velocity.y,
      b.velocity.z,
      b.angularVelocity.x,
      b.angularVelocity.y,
      b.angularVelocity.z,
      jet.currentThrust,
      jet.chain.stacks,
      jet.chain.sinceGate,
      energy.energy,
      energy.lockout,
      race.energy,
    ]
    out.set(row, i * PER_TICK)
    if (i % SAMPLE_EVERY === SAMPLE_EVERY - 1) samples.push([i, ...row.map(sampleValue)])
  }
  return finish(out, samples)
}

// ── JumpSeat ──────────────────────────────────────────────────────────────

const flatMap = (g: number): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(_u: number, _v: number, rgb: Rgb): Rgb {
      rgb.r = g
      rgb.g = g
      rgb.b = g
      return rgb
    },
  }) as unknown as MapSampler

/** Flat ground at y = 50 over a 1 km square: `jumpseat-legs.test.ts`'s own. */
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

/**
 * The ground rule `game/jumpseat-flight.ts` applies, copied as
 * `jumpseat-legs.test.ts` copies it. The hull is geometry, not a variant key.
 */
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
 * Fly a JumpSeat through the frozen script: standing on its gear at the middle
 * of the flat square, dead for 100 ticks, then a full-throttle ramp, a boost, a
 * coast out of the cushion's reach (the DragHack's free-fall drag), and a long
 * part-throttle stretch with the stick moving, down into the cushion.
 */
export const flyJumpSeatScript = (seat: JumpSeat): Fingerprint => {
  const PER_TICK = 20
  const out = new Float64Array(SCRIPT_TICKS * PER_TICK)
  const samples: (number | string)[][] = []
  const collision = createTerrainCollision()
  const b = seat.body
  b.position.x = 500
  b.position.y = GROUND + 1.5
  b.position.z = 500
  for (let i = 0; i < SCRIPT_TICKS; i++) {
    if (i === 100) seat.live = true
    const throttle = inWindow(i, 100, 450)
      ? 1
      : inWindow(i, 450, 550)
        ? 1
        : inWindow(i, 550, 750)
          ? 0
          : inWindow(i, 750, 1600)
            ? 0.66
            : inWindow(i, 1600, 1800)
              ? 0.5
              : 0
    stepJumpSeat(
      seat,
      {
        throttle,
        boost: inWindow(i, 450, 550) ? 1 : 0,
        roll: inWindow(i, 800, 900) ? 0.7 : inWindow(i, 1300, 1400) ? -0.6 : 0,
        pitch: inWindow(i, 900, 1000) ? -0.8 : inWindow(i, 1400, 1500) ? 0.5 : 0,
        yaw: inWindow(i, 1000, 1150) ? 1 : 0,
      },
      [FLAT],
      FIXED_DT,
    )
    stepTerrainCollision(collision, b, [FLAT], COLLISION, FIXED_DT)
    b.angularDrag = collisionAngularDrag(collision, COLLISION, seat.tuning.angularDrag)
    const row = [
      b.position.x,
      b.position.y,
      b.position.z,
      b.orientation.x,
      b.orientation.y,
      b.orientation.z,
      b.orientation.w,
      b.velocity.x,
      b.velocity.y,
      b.velocity.z,
      b.angularVelocity.x,
      b.angularVelocity.y,
      b.angularVelocity.z,
      seat.fuel,
      seat.curveTime,
      seat.adjustedThrustForce,
      seat.appliedThrust,
      b.drag,
      seat.hover.distance,
      seat.legs?.totalLoad ?? 0,
    ]
    out.set(row, i * PER_TICK)
    if (i % SAMPLE_EVERY === SAMPLE_EVERY - 1) samples.push([i, ...row.map(sampleValue)])
  }
  return finish(out, samples)
}
