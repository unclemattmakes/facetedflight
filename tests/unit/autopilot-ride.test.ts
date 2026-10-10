// tests/unit/autopilot-ride.test.ts — what the autopilot feels like from the seat. DEV-394.
//
// Matt, 2026-09-25: *"autopilot is a lil wonky in general (my observation from
// riding along in the cockpit and observing)"*. The other autopilot tests hold
// the OUTCOME — every ring, in order, in time. This file holds the RIDE: the
// things a rider feels whether or not the lap is completed.
//
//   the weave      the line follower swinging from side to side of the line
//   the rocking    the roll rate reversing, which is the wings see-sawing
//   the hunting    boost switching on and off, heard and felt as a surge
//   the loop       the nose pitched through the vertical, the rider upside down
//   the overshoot  arriving at a target too fast to turn onto it
//
// Each bound was measured, with the law as DEV-394 left it and with every
// DEV-394 term at its old value (`BEFORE`, below). The old law was flown
// through the same harness, so each bound is shown to SEPARATE the two laws,
// not just to hold today: every `it` asserts the new law is inside its bound
// and the old one outside it. DEV-394's row in `docs/DEVIATIONS.md` has the
// full table, over the real ground, on every course and variant.
//
// The flights are the player's autopilot as `boot/app.ts` flies it — the line,
// the velocity profile, the Anniversary tank, the speed chain — over NO ground,
// so the file runs on CI. The ground is what the full table adds.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { aircraftFor } from '@/content/load-aircraft'
import { HOVERJET_LAT_ACCEL_MEASURED as SHIP_LAT_ACCEL } from '@/game/measured'
import { courseGates } from '@/game/mission'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { gateArcLengths, runIsOver } from '@/sim/ai-racer'
import {
  type AutopilotTuning,
  autopilotActions,
  DEFAULT_AUTOPILOT,
  nextGate,
  playerRouteOptions,
} from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { createCourse, seedCourse, stepCourse } from '@/sim/course'
import { createEnergy, energySpec, stepEnergy } from '@/sim/energy'
import {
  createHoverJet,
  type HoverJetSheet,
  hoverJetView,
  noInput,
  speedProfileModel,
  stepHoverJet,
} from '@/sim/hoverjet'
import { rotateVec3, rotateVec3Inverse } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import {
  createRoute,
  createRouteCursor,
  routeArcThrough,
  routeAt,
  routeGuidance,
  routeRightAt,
  speedLimitAt,
  withSpeedProfile,
} from '@/sim/route'
import { chainGate } from '@/sim/speed-chain'
import int01 from '../../content/levels/int_01_hoverJet.json'

const LEVEL = int01 as unknown as Level

const ANNIVERSARY = JSON.parse(
  fs.readFileSync('content/editions/anniversary.json', 'utf8'),
) as Edition

/**
 * Every DEV-394 term at the value it had before DEV-394: the law as Matt rode
 * it. (The profile is the new, measured one for both — the old 5.3 m/s² model
 * is gone, and `route.test.ts` holds the new one to a flight.)
 */
const BEFORE: AutopilotTuning = {
  ...DEFAULT_AUTOPILOT,
  yawGain: 2.6,
  routeLeadSeconds: 0.9,
  profileLookSeconds: 2.5,
  slipGain: 0,
  attitudeLeadSeconds: 0,
  trustRamp: 0,
  trustedProbeToAim: 0,
  trustedClearance: DEFAULT_AUTOPILOT.minClearance,
  turnReach: false,
  pitchLimit: 0,
  speedGain: 0,
  boostHysteresis: 0,
}

const sheetOf = (id: string): HoverJetSheet => {
  const v = aircraftFor('hoverjet').variants.find((x) => x.id === id)
  if (!v) throw new Error(`no HoverJet variant ${id}`)
  return hoverJetView(v.scale)
}

/** Sign changes of a signal, counted only across ±`h`, so noise at zero is not one. */
class Reversals {
  private state = 0
  count = 0
  constructor(private readonly h: number) {}
  push(x: number): void {
    const s = x > this.h ? 1 : x < -this.h ? -1 : 0
    if (s === 0) return
    if (this.state !== 0 && s !== this.state) this.count++
    this.state = s
  }
}

interface Ride {
  readonly finished: boolean
  readonly seconds: number
  /** Roll-rate reversals across ±0.1 rad/s, per second. */
  readonly rollFlipsPerSecond: number
  /** Sign changes of the signed error from the line across ±3 m, per km flown on it. */
  readonly swingsPerKm: number
  /** 95th percentile of the distance from the line, metres, while flying it. */
  readonly lateralP95: number
  /** The autopilot's boost demand switching, per minute. */
  readonly boostTogglesPerMinute: number
}

const _w = v3()
const _foot = v3()
const _right = v3()

/** The player's autopilot round `int_01`, as `boot/app.ts` flies it, over no ground. */
const flyLap = (tuning: AutopilotTuning, sheet: HoverJetSheet): Ride => {
  const gates = courseGates(LEVEL)
  const f = LEVEL.finish
  const finish = f
    ? { x: f.pos[0] as number, y: f.pos[1] as number, z: -(f.pos[2] as number), radius: f.radius }
    : null
  const jet = createHoverJet(sheet)
  jet.launched = true
  threeTupleToUnity(jet.body.position, LEVEL.spawn.pos as number[])
  threeQuatTupleToUnity(jet.body.orientation, LEVEL.spawn.quat as number[])
  jet.body.position.y += LEVEL.spawn.launch?.rise ?? 0
  const course = createCourse(gates)
  seedCourse(course, jet.body.position)
  const route = createRoute((LEVEL as { route?: number[][] }).route as number[][])
  withSpeedProfile(route, speedProfileModel(sheet, SHIP_LAT_ACCEL))
  const gateArc = gateArcLengths(route, gates)
  const homeArc = finish ? routeArcThrough(route, finish, finish.radius) : Number.NaN
  const tank = energySpec(ANNIVERSARY.gameplay.energy.rechargeScale, jet.sheet)
  const energy = createEnergy(tank)
  const cursor = createRouteCursor()
  const aim = v3()
  const beyond = v3()
  const input = noInput()
  const roll = new Reversals(0.1)
  const swing = new Reversals(3)
  const lateral: number[] = []
  let onLineMetres = 0
  let toggles = 0
  let lastBoost: boolean | null = null
  let tick = 0
  let finished = false
  const cap = Math.round(LEVEL.timer.timeLimit / FIXED_DT)
  for (; tick < cap && !finished; tick++) {
    const body = jet.body
    const v = body.velocity
    const speed = Math.hypot(v.x, v.y, v.z)
    const target = nextGate(gates, course.passed)
    const centre = target >= 0 ? (gates[target] as (typeof gates)[number]).centre : finish
    if (!centre) break
    let at = centre
    let offset = Number.POSITIVE_INFINITY
    let cornerRef = target >= 0 ? (gates[target + 1]?.centre ?? finish) : null
    let want = Number.POSITIVE_INFINITY
    if (target >= 0 || Number.isFinite(homeArc)) {
      const onLine = routeGuidance(
        route,
        cursor,
        body.position,
        // DEV-524: the player's own options, the ones `boot/app.ts` passes.
        playerRouteOptions(
          tuning,
          speed,
          target >= 0 ? (gateArc[target] ?? Number.POSITIVE_INFINITY) : homeArc,
          centre,
          beyond,
        ),
        aim,
      )
      at = aim
      if (onLine) {
        offset = cursor.offset
        cornerRef = beyond
        want = speedLimitAt(route, cursor.s + speed * tuning.profileLookSeconds)
        if (target >= 0) {
          routeAt(route, cursor.s, _foot)
          routeRightAt(route, cursor.s, _right)
          const e = (body.position.x - _foot.x) * _right.x + (body.position.z - _foot.z) * _right.z
          lateral.push(Math.abs(e))
          swing.push(e)
          onLineMetres += speed * FIXED_DT
        }
      }
    }
    autopilotActions(body, at, input, tuning, [], offset, cornerRef, want, jet)
    if (lastBoost !== null && input.boost !== lastBoost) toggles++
    lastBoost = input.boost
    input.boost = stepEnergy(energy, tank, input.boost, FIXED_DT)
    stepHoverJet(jet, input)
    rotateVec3Inverse(_w, body.orientation, body.angularVelocity)
    roll.push(_w.z)
    if (stepCourse(course, body.position) >= 0) chainGate(jet.chain)
    finished = runIsOver(finish, body.position, course.passed)
  }
  const seconds = tick * FIXED_DT
  lateral.sort((a, b) => a - b)
  return {
    finished,
    seconds,
    rollFlipsPerSecond: roll.count / seconds,
    swingsPerKm: swing.count / (onLineMetres / 1000),
    lateralP95: lateral[Math.floor(lateral.length * 0.95)] ?? 0,
    boostTogglesPerMinute: toggles / (seconds / 60),
  }
}

// Flown once each and shared: every flight is a few hundred milliseconds.
const rides = new Map<string, Ride>()
const ride = (law: 'after' | 'before', variant: string): Ride => {
  const key = `${law}/${variant}`
  let r = rides.get(key)
  if (!r) {
    r = flyLap(law === 'after' ? DEFAULT_AUTOPILOT : BEFORE, sheetOf(variant))
    rides.set(key, r)
  }
  return r
}

const VARIANTS = ['standard', 'speed'] as const

describe('the ride, round int_01 (DEV-394)', () => {
  it('finishes, on both laws — the rest is about how', () => {
    if (process.env.RIDE_PRINT === '1')
      for (const v of VARIANTS)
        for (const law of ['after', 'before'] as const)
          process.stdout.write(`RIDE ${law} ${v} ${JSON.stringify(ride(law, v))}
`)
    for (const v of VARIANTS) {
      expect(ride('after', v).finished, v).toBe(true)
      expect(ride('before', v).finished, v).toBe(true)
    }
  })

  it('does not WEAVE: the line follower swings under 2 times per km, p95 under 15 m', () => {
    for (const v of VARIANTS) {
      const now = ride('after', v)
      const was = ride('before', v)
      const where = `${v}: now ${now.swingsPerKm.toFixed(2)}/km ${now.lateralP95.toFixed(1)} m, was ${was.swingsPerKm.toFixed(2)}/km ${was.lateralP95.toFixed(1)} m`
      expect(now.swingsPerKm, where).toBeLessThan(2)
      expect(now.lateralP95, where).toBeLessThan(15)
      // The bound separates the laws: the one Matt rode fails it.
      expect(was.swingsPerKm, where).toBeGreaterThan(2)
    }
  })

  it('does not ROCK: roll-rate reversals under 0.3 a second', () => {
    for (const v of VARIANTS) {
      const now = ride('after', v)
      const was = ride('before', v)
      const where = `${v}: now ${now.rollFlipsPerSecond.toFixed(2)}/s, was ${was.rollFlipsPerSecond.toFixed(2)}/s`
      expect(now.rollFlipsPerSecond, where).toBeLessThan(0.3)
      expect(was.rollFlipsPerSecond, where).toBeGreaterThan(0.3)
    }
  })

  it('does not HUNT its boost: under 40 switches a minute', () => {
    for (const v of VARIANTS) {
      const now = ride('after', v)
      const was = ride('before', v)
      const where = `${v}: now ${now.boostTogglesPerMinute.toFixed(1)}/min, was ${was.boostTogglesPerMinute.toFixed(1)}/min`
      expect(now.boostTogglesPerMinute, where).toBeLessThan(40)
      expect(was.boostTogglesPerMinute, where).toBeGreaterThan(40)
    }
  })
})

// ── The loop and the overshoot: a controller property, at one instant ───────

const UP = v3(0, 1, 0)
const FORWARD = v3(0, 0, 1)
const _up = v3()
const _nose = v3()

describe('never a loop (DEV-394)', () => {
  /**
   * Level at 150 m/s, the target 150 m below and 40 m behind: the shape of a
   * ring overflown, or a pad start that climbed past the first ring. Pursuit
   * pitches at it; past the vertical, that is an outside loop.
   */
  const chase = (tuning: AutopilotTuning): { steepest: number; lowestUp: number } => {
    const jet = createHoverJet()
    jet.launched = true
    jet.body.velocity.z = 150
    const target = v3(0, -150, -40)
    const input = noInput()
    let steepest = 0
    let lowestUp = 1
    for (let i = 0; i < Math.round(4 / FIXED_DT); i++) {
      autopilotActions(
        jet.body,
        target,
        input,
        tuning,
        [],
        Number.POSITIVE_INFINITY,
        null,
        Number.POSITIVE_INFINITY,
        jet,
      )
      stepHoverJet(jet, input)
      rotateVec3(_nose, jet.body.orientation, FORWARD)
      rotateVec3(_up, jet.body.orientation, UP)
      steepest = Math.max(steepest, Math.abs(Math.asin(Math.max(-1, Math.min(1, _nose.y)))))
      lowestUp = Math.min(lowestUp, _up.y)
    }
    return { steepest, lowestUp }
  }

  it('does not pitch through the vertical to reach a target below and behind', () => {
    const now = chase(DEFAULT_AUTOPILOT)
    const was = chase(BEFORE)
    const where = `now ${((now.steepest * 180) / Math.PI).toFixed(0)}° up.y ${now.lowestUp.toFixed(2)}, was ${((was.steepest * 180) / Math.PI).toFixed(0)}° up.y ${was.lowestUp.toFixed(2)}`
    expect(now.lowestUp, where).toBeGreaterThan(0)
    expect(now.steepest, where).toBeLessThan(Math.PI / 2)
    expect(was.lowestUp, where).toBeLessThan(0)
  })
})

describe('no overshoot it can see coming (DEV-394)', () => {
  /**
   * A chained jet at 290 m/s and a target 200 m away, 45° off its path: the arc
   * onto it has a radius of 200 / (2 sin 45°) = 141 m, which the jet's
   * full-stick turn rate (1.25 rad/s) flies at 177 m/s at most. Flown for four
   * seconds; the answer is how close it gets. (Scanned over 200-800 m and
   * 30-80°: from 500 m out both laws make it, and the rule changes nothing.)
   */
  const closest = (turnReach: boolean): number => {
    const jet = createHoverJet()
    jet.launched = true
    for (let i = 0; i < 20; i++) chainGate(jet.chain)
    jet.body.velocity.z = 290
    jet.currentThrust = jet.tuning.maxSpeed * jet.tuning.boostMultiplier
    const angle = Math.PI / 4
    const target = v3(200 * Math.sin(angle), 0, 200 * Math.cos(angle))
    const tuning = { ...DEFAULT_AUTOPILOT, turnReach }
    const input = noInput()
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < Math.round(4 / FIXED_DT); i++) {
      autopilotActions(
        jet.body,
        target,
        input,
        tuning,
        [],
        Number.POSITIVE_INFINITY,
        null,
        Number.POSITIVE_INFINITY,
        jet,
      )
      stepHoverJet(jet, input)
      const p = jet.body.position
      best = Math.min(best, Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z))
    }
    return best
  }

  it('slows for a target it could not turn onto, and reaches it rather than sailing past', () => {
    const now = closest(true)
    const was = closest(false)
    const where = `closest now ${now.toFixed(1)} m, without the rule ${was.toFixed(1)} m`
    // A ring's trigger is 22.6 m on int_01: inside it, against well outside it.
    expect(now, where).toBeLessThan(22.6)
    expect(was, where).toBeGreaterThan(22.6)
  })
})
