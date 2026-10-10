/**
 * `src/sim/glider.ts` — DEV-145.
 *
 * ── What these tests are FOR ──────────────────────────────────────────────
 *
 * The glider is the one vehicle in this port with no 2016 behaviour behind it:
 * every number is Anniversary design, so there is no oracle to diff against and
 * "matches the prefab" is not available. What IS available is the thing
 * CLAUDE.md keeps asking for — compare against something OUTSIDE the module:
 *
 *   · the CONSTANTS SHEET, for gravity and the tick, so the model cannot
 *     quietly be tuned against Earth gravity
 *   · `stepHoverJet`, which shipped, for the sign of the pitch axis — the exact
 *     class of bug that let the keyboard climb while the stick dived (DEV-069,
 *     DEV-071)
 *   · MEASUREMENT: fly it and read the result, rather than restating the
 *     algebra the implementation already used (trap 24)
 *
 * Every steady-state number below was produced by running the model, not by
 * solving it on paper. Three of them contradicted the paper and two of those
 * were real bugs: a separate lift and drag scale (which makes Cl/Cd not the
 * glide ratio), and a weathervane sign taken from intuition instead of from the
 * right-hand rule. Both flew into the sea from every initial condition.
 */
import { describe, expect, it } from 'vitest'
import { FIXED_DT, GRAVITY } from '@/sim/constants'
import {
  createGlider,
  type Glider,
  type GliderInput,
  groundEffectAt,
  liftAuthorityAt,
  minimumLevelSpeed,
  noGliderInput,
  PROTOTYPE_GLIDER,
  stepGlider,
} from '@/sim/glider'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { quat, rotateVec3, setQ } from '@/sim/math/quat'
import { set, v3 } from '@/sim/math/vec3'

const T = PROTOTYPE_GLIDER

/** Pitch the body, NOSE UP positive. A +X rotation carries the nose (+Z) to -Y. */
const pitchQuat = (a: number) => setQ(quat(), Math.sin(-a / 2), 0, 0, Math.cos(-a / 2))

const secs = (s: number) => Math.round(s / FIXED_DT)

/** A glider at `speed` on a flight path `pitch` radians from level, nose aligned. */
const launch = (speed: number, pitch = 0, y = 10_000): Glider => {
  const g = createGlider(T)
  g.body.orientation = pitchQuat(pitch)
  set(g.body.velocity, 0, speed * Math.sin(pitch), speed * Math.cos(pitch))
  set(g.body.position, 0, y, 0)
  return g
}

const run = (g: Glider, seconds: number, input: GliderInput = noGliderInput()): Glider => {
  for (let i = 0; i < secs(seconds); i++) stepGlider(g, input)
  return g
}

/** Specific energy, J/kg. The currency the whole vehicle trades in. */
const specificEnergy = (g: Glider): number =>
  0.5 * g.airspeed ** 2 + Math.abs(GRAVITY.y) * g.body.position.y

describe('glider — the tuning is data, and it agrees with itself', () => {
  it('tunes against the game gravity, not Earth gravity', () => {
    // 2016's world is (0, -32, 0). Every mass and force in this game was tuned
    // against it (CLAUDE.md), and the 2016 glider prototypes were NOT — both
    // `Glider_04` and `Glider_05` hard-code `gravity = 9.8f`. If this ever
    // reads -9.81 the whole vehicle is silently rescaled.
    expect(GRAVITY.y).toBe(-32)
    // `minimumLevelSpeed` is derived from gravity, so it moves if gravity does.
    expect(minimumLevelSpeed(T)).toBeCloseTo(36, 1)
  })

  it('puts the aerodynamic minimum speed INSIDE the stall band', () => {
    // The design intent, and the only arrangement where a player feels both
    // halves: the wing runs out of lift (36.0 m/s) while the stall is already
    // fading in (32 -> 42). Outside the band, one of the two is decoration.
    const vMin = minimumLevelSpeed(T)
    expect(vMin).toBeGreaterThan(T.stallSpeed)
    expect(vMin).toBeLessThan(T.stallSpeed + T.stallWidth)
  })

  it('cannot ask for a glide ratio the dive speed forbids', () => {
    // With ONE `aeroScale`, the best glide available at cruise is exactly
    // (terminal / cruise)^2. This is the relationship the first draft violated:
    // it asked for 12.8 where 9.55 was the ceiling, and the model answered by
    // falling out of the sky. Asserted as a RELATIONSHIP, not as a value
    // (trap 24) — it stays true when someone retunes.
    const weight = T.mass * Math.abs(GRAVITY.y)
    const terminal = Math.sqrt(weight / (T.aeroScale * T.parasiteDrag))
    const clTrim = T.liftSlope * T.trimAngleOfAttack
    const cruise = Math.sqrt(weight / (T.aeroScale * clTrim))
    const glide = clTrim / (T.parasiteDrag + T.inducedDrag * clTrim * clTrim)
    expect(glide).toBeLessThan((terminal / cruise) ** 2)
  })
})

describe('glider — the stall', () => {
  it('has NO lift at or below the stall speed, and full lift above the band', () => {
    expect(liftAuthorityAt(T, T.stallSpeed)).toBe(0)
    expect(liftAuthorityAt(T, T.stallSpeed - 10)).toBe(0)
    expect(liftAuthorityAt(T, T.stallSpeed + T.stallWidth)).toBe(1)
    expect(liftAuthorityAt(T, T.stallSpeed + T.stallWidth / 2)).toBeCloseTo(0.5, 6)
  })

  it('stalls when flown too slowly, and makes no lift while it does', () => {
    const g = launch(20)
    stepGlider(g, noGliderInput())
    expect(g.liftAuthority).toBe(0)
    expect(Math.abs(g.lift)).toBe(0)
  })

  it('drops the nose and recovers on its own, with no input at all', () => {
    // The honest stall: it costs altitude and it is survivable. Recovery
    // requires nothing from the pilot because the weathervane pitches the nose
    // toward the airflow, which in a stall is coming from below.
    const g = launch(15, 0, 5000)
    const hands = noGliderInput()
    let recoveredAt = -1
    for (let i = 0; i < secs(20); i++) {
      stepGlider(g, hands)
      if (recoveredAt < 0 && g.liftAuthority >= 1) recoveredAt = i * FIXED_DT
    }
    expect(recoveredAt).toBeGreaterThan(0)
    expect(recoveredAt).toBeLessThan(3)
    // And it cost real height.
    expect(5000 - g.body.position.y).toBeGreaterThan(150)
  })

  it('keeps a quarter of the stick in a full stall, and all of it when flying', () => {
    // `stalledControl`, felt rather than read: roll response with the wing
    // stalled against roll response at cruise.
    //
    // ONE tick, not three seconds. An earlier version flew each case for 3 s
    // and reported a ratio of 0.99 — because a glider released at 20 m/s has
    // recovered to flying speed long before three seconds are up, so the test
    // was comparing two unstalled gliders and would have stayed green with
    // `stalledControl` set to 1.
    const rollRateAfterOneTick = (speed: number) => {
      const g = launch(speed)
      stepGlider(g, { ...noGliderInput(), roll: 1 })
      expect(g.liftAuthority).toBe(speed < T.stallSpeed ? 0 : 1)
      return Math.abs(g.body.angularVelocity.z)
    }
    const stalled = rollRateAfterOneTick(20)
    const flying = rollRateAfterOneTick(60)
    expect(stalled).toBeGreaterThan(0)
    expect(stalled / flying).toBeCloseTo(T.stalledControl, 3)
  })
})

describe('glider — the energy trade', () => {
  it('settles hands-off at its designed cruise speed and glide ratio', () => {
    // MEASURED, not solved. The phugoid takes about 45 s to die, so the
    // measurement window starts at 90 s — measuring through the oscillation is
    // what made an earlier run report 4.73 : 1 for a model that glides at 7.
    const g = run(launch(55), 90)
    const y0 = g.body.position.y
    const z0 = g.body.position.z
    run(g, 60)
    const dropped = y0 - g.body.position.y
    const travelled = g.body.position.z - z0

    expect(g.airspeed).toBeCloseTo(54.7, 0)
    expect(travelled / dropped).toBeCloseTo(7.0, 1)
    expect(dropped / 60).toBeCloseTo(7.74, 1)
  })

  it('converts height into speed at better than 95 % of specific energy', () => {
    // Down is the cheap direction: a dive is nearly lossless.
    const g = launch(55, -0.7)
    const before = specificEnergy(g)
    run(g, 6)
    expect(g.airspeed).toBeGreaterThan(100)
    expect(specificEnergy(g) / before).toBeGreaterThan(0.95)
  })

  it('converts speed into height at a real loss — the asymmetry is the point', () => {
    // Up is the expensive direction, because induced drag goes as Cl squared.
    // 140 m/s traded losslessly down to cruise would be +259 m; the model gives
    // about +106 m. If this ever approaches the lossless figure the induced
    // term has been broken and the glider is a perpetual-motion machine.
    const g = launch(140, 0, 1000)
    const pull = { ...noGliderInput(), pitch: -0.35 }
    let apex = g.body.position.y
    for (let i = 0; i < secs(20); i++) {
      stepGlider(g, pull)
      if (g.body.position.y > apex) apex = g.body.position.y
      if (g.airspeed < 45) pull.pitch = 0
    }
    const gained = apex - 1000
    const lossless = (140 ** 2 / 2 - 55 ** 2 / 2) / Math.abs(GRAVITY.y)
    expect(gained).toBeGreaterThan(60)
    expect(gained).toBeLessThan(lossless * 0.6)
  })

  it('terminates a held dive well short of the zero-lift asymptote', () => {
    const weight = T.mass * Math.abs(GRAVITY.y)
    const asymptote = Math.sqrt(weight / (T.aeroScale * T.parasiteDrag))
    const g = run(launch(40, -Math.PI / 2), 40, { ...noGliderInput(), pitch: 1 })
    expect(g.airspeed).toBeCloseTo(145, -1)
    expect(g.airspeed).toBeLessThan(asymptote)
  })
})

describe('glider — the rocket is a resource', () => {
  it('burns the budget, and only while held', () => {
    const g = launch(55)
    expect(g.fuel).toBe(T.rocketSeconds)
    run(g, 1, { ...noGliderInput(), rocket: true })
    expect(g.fuel).toBeCloseTo(T.rocketSeconds - 1, 1)
    // Released, it refills — slowly.
    run(g, 1)
    expect(g.fuel).toBeCloseTo(T.rocketSeconds - 1 + T.rocketRecharge, 1)
  })

  it('runs dry, and stops pushing when it does', () => {
    const g = launch(55)
    const held = { ...noGliderInput(), rocket: true }
    run(g, T.rocketSeconds + 1, held)
    expect(g.fuel).toBe(0)
    expect(g.burning).toBe(false)
    // And it STAYS dry while the button is down — no micro-bursting.
    run(g, 5, held)
    expect(g.fuel).toBe(0)
    // With the tank empty the glider is a glider again, and a glider has no
    // way to ADD energy. Asserted on specific energy rather than on airspeed:
    // airspeed alone goes both ways, because a dry glider that stalls will
    // trade height back into speed and look like it accelerated.
    const before = specificEnergy(g)
    run(g, 4, held)
    expect(specificEnergy(g)).toBeLessThan(before)
  })

  it('is worth holding: a full burn from cruise roughly doubles the speed', () => {
    const g = run(launch(55), T.rocketSeconds, { ...noGliderInput(), rocket: true })
    expect(g.airspeed).toBeCloseTo(144, -1)
  })

  it('takes rocketSeconds / rocketRecharge to refill, which is 12 s here', () => {
    const g = launch(55)
    run(g, T.rocketSeconds, { ...noGliderInput(), rocket: true })
    expect(g.fuel).toBe(0)
    run(g, T.rocketSeconds / T.rocketRecharge)
    expect(g.fuel).toBe(T.rocketSeconds)
  })
})

describe('glider — ground effect', () => {
  it('is 1 above the ceiling and 1 + gain on the deck', () => {
    expect(groundEffectAt(T, Number.POSITIVE_INFINITY)).toBe(1)
    expect(groundEffectAt(T, T.groundEffectHeight)).toBe(1)
    expect(groundEffectAt(T, 0)).toBeCloseTo(1 + T.groundEffectGain, 6)
    expect(groundEffectAt(T, T.groundEffectHeight / 2)).toBeCloseTo(1 + T.groundEffectGain / 2, 6)
  })

  it('makes terrain-hugging pay: measurably less sink at the same speed', () => {
    const free = run(launch(55), 30)
    const low = launch(55)
    const hands = noGliderInput()
    for (let i = 0; i < secs(30); i++) {
      low.clearance = 5
      stepGlider(low, hands)
    }
    const freeSink = 10_000 - free.body.position.y
    const lowSink = 10_000 - low.body.position.y
    expect(lowSink).toBeLessThan(freeSink * 0.85)
  })

  it('does nothing when the caller never sets a clearance', () => {
    // `clearance` starts at Infinity on purpose: a caller that does not know
    // how far the ground is gets no ground effect rather than a made-up one.
    const g = createGlider(T)
    expect(g.clearance).toBe(Number.POSITIVE_INFINITY)
    expect(groundEffectAt(T, g.clearance)).toBe(1)
  })
})

describe('glider — agrees with the ship about which way is up', () => {
  /**
   * The bug class that has bitten this port three times: two devices that each
   * make sense alone and disagree with each other. Rather than assert a
   * quaternion — which is a belief written twice (the orientation lesson) —
   * this flies BOTH vehicles with the same stick and asks a geometric question:
   * did the nose end up higher or lower than it started?
   */
  /** World-space Y of the nose direction — body +Z rotated out. Up is positive. */
  const noseUp = (q: Parameters<typeof rotateVec3>[1]): number => rotateVec3(v3(), q, v3(0, 0, 1)).y

  const jetNoseAfter = (pitch: number): number => {
    const jet = createHoverJet()
    const input = { ...noInput(), pitch }
    for (let i = 0; i < secs(1); i++) stepHoverJet(jet, input)
    return noseUp(jet.body.orientation)
  }

  const gliderNoseAfter = (pitch: number): number => {
    const g = launch(60)
    const input = { ...noGliderInput(), pitch }
    for (let i = 0; i < secs(1); i++) stepGlider(g, input)
    return noseUp(g.body.orientation)
  }

  it('sends the nose the SAME way on a positive pitch input', () => {
    const jet = jetNoseAfter(1)
    const glider = gliderNoseAfter(1)
    expect(Math.sign(jet)).toBe(Math.sign(glider))
    // And that shared direction is DOWN, which is what body +X torque does.
    expect(jet).toBeLessThan(0)
  })

  it('sends the nose the same way on a negative pitch input too', () => {
    expect(Math.sign(jetNoseAfter(-1))).toBe(Math.sign(gliderNoseAfter(-1)))
    expect(jetNoseAfter(-1)).toBeGreaterThan(0)
  })

  it('rolls the same way as the ship on a positive roll input', () => {
    const jet = createHoverJet()
    for (let i = 0; i < secs(1); i++) stepHoverJet(jet, { ...noInput(), roll: 1 })
    const g = launch(60)
    for (let i = 0; i < secs(1); i++) stepGlider(g, { ...noGliderInput(), roll: 1 })
    expect(Math.sign(jet.body.angularVelocity.z)).toBe(Math.sign(g.body.angularVelocity.z))
  })
})

describe('glider — no shared scratch between instances', () => {
  it('stepping a second glider does not move the first (trap 19)', () => {
    // `ai-racer.ts` shared one input object across every racer and a finished
    // racer flew on with another racer's stick. Module-level scratch vectors
    // are the same hazard from the other side, and a single-object test cannot
    // see it: with one glider there is nobody to inherit from.
    const a = launch(60)
    const b = launch(60)
    run(a, 2)
    const snapshot = { ...a.body.position }
    const airspeed = a.airspeed
    run(b, 2, { ...noGliderInput(), roll: 1, pitch: 1, rocket: true })
    expect(a.body.position).toEqual(snapshot)
    expect(a.airspeed).toBe(airspeed)
  })

  it('gives each glider its own fuel tank', () => {
    const a = launch(60)
    const b = launch(60)
    run(b, 2, { ...noGliderInput(), rocket: true })
    expect(a.fuel).toBe(T.rocketSeconds)
    expect(b.fuel).toBeLessThan(T.rocketSeconds)
  })
})
