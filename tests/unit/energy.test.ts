// tests/unit/energy.test.ts — DEV-143, the boost tank.
//
// ── What is worth asserting here, and what is not ─────────────────────────
//
// "Does the tank lose 32 a second" is the implementation written twice
// (CLAUDE.md, trap 24). What these assert instead:
//
//  1. **Against something OUTSIDE the port.** Classic's preset number, run
//     through the sheet, has to reproduce `derived.energy.netWhileBoosting` —
//     +68/s, the figure the extractor computed from the shipped prefab and
//     whose own note says "boost is effectively free". If those two ever
//     disagree, one of them has drifted.
//  2. **The Classic invariant, as an OBSERVATION and not as a flag read.** Fly
//     a full lap's worth of ticks on Classic's number with boost held down and
//     the tank must still be full. That is the "byte-for-byte unchanged"
//     promise in the only form that can fail.
//  3. **The design sentence.** Anniversary is "you may boost half the lap".
//     The test measures the sustainable duty cycle by stepping the sim, not by
//     dividing the two constants the way `energySpec` does.
//  4. **Trap 19.** Step a SECOND tank and assert the first did not move.
//
// SIM LAYER: no DOM, no clock.

import { describe, expect, it } from 'vitest'
import { DERIVED, HOVERJET } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import {
  boostAvailable,
  createEnergy,
  energyFraction,
  energySpec,
  refillEnergy,
  stepEnergy,
} from '@/sim/energy'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const ANNIVERSARY_SCALE = anniversary.gameplay.energy.rechargeScale
const CLASSIC_SCALE = classic.gameplay.energy.rechargeScale

/** Hold boost for `seconds` and answer how long it was actually LIT. */
const holdBoost = (scale: number, seconds: number) => {
  const spec = energySpec(scale)
  const state = createEnergy(spec)
  let litSeconds = 0
  let firstOutAt: number | null = null
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) {
    const lit = stepEnergy(state, spec, true, FIXED_DT)
    if (lit) litSeconds += FIXED_DT
    else if (firstOutAt === null) firstOutAt = i * FIXED_DT
  }
  return { state, spec, litSeconds, firstOutAt }
}

describe('the sheet says boost is free, and Classic keeps it that way', () => {
  it("Classic's rechargeScale reproduces the sheet's own netWhileBoosting", () => {
    // NOT `expect(scale).toBe(1)` — that is the preset read back to itself. The
    // relationship is the thing: Classic's number, through the sheet's recharge
    // rate, minus the sheet's burn, must equal the figure the EXTRACTOR
    // computed off the shipped prefab. Two independent derivations, one answer.
    const spec = energySpec(CLASSIC_SCALE)
    expect(spec.rechargePerSecond - spec.burnPerSecond).toBe(DERIVED.energy.netWhileBoosting)
    expect(DERIVED.energy.netWhileBoosting).toBeGreaterThan(0)
    // And the sheet's own answer to "how long can you boost": null, meaning
    // never runs out. If that ever becomes a number the preset has to move too.
    expect(DERIVED.energy.secondsOfBoostFromFull).toBeNull()
  })

  it('burns nothing over three minutes of held boost — 2016 exactly', () => {
    // 180 s is `timer.timeLimit` on all thirteen missions: a whole run with the
    // trigger welded down. Boost must never have gone out for a single tick.
    const { state, spec, litSeconds, firstOutAt } = holdBoost(CLASSIC_SCALE, 180)
    expect(firstOutAt).toBeNull()
    expect(litSeconds).toBeCloseTo(180, 1)
    expect(boostAvailable(state)).toBe(true)

    // ── And the tank sits ONE TICK'S BURN below full, not AT it ──────────
    //
    // 99.6096, not 100, and that is 2016's own arithmetic rather than a
    // rounding slip. `Recharge()` is guarded on `currentEnergy < maxEnergy` and
    // clamps at the top; `Burn()` is unguarded. So a full tank recharges by
    // nothing and then burns, the next tick recharges past the ceiling and is
    // clamped back to it, and then burns again — a sawtooth of exactly
    // `burnPerSecond x dt` deep, for ever, that never falls further.
    //
    // Asserted as the RELATIONSHIP, so a change to dt or to either rate moves
    // both sides: the floor of the sawtooth, and nothing below it.
    const tick = spec.burnPerSecond * FIXED_DT
    expect(state.energy).toBeGreaterThanOrEqual(spec.maxEnergy - tick - 1e-9)
    expect(energyFraction(state, spec)).toBeGreaterThan(0.99)
  })
})

// DEV-410: these run Anniversary's RECHARGE under 2016's lockout
// (`energySpec`'s default `lockoutScale` of 1). The mechanism is still the one
// a preset gets at 1. Anniversary itself runs no lockout; that has its own
// describe at the bottom of this file.
describe("Anniversary's recharge makes boost a resource, under 2016's lockout", () => {
  it('empties in 6.25 s of held boost, measured by stepping', () => {
    // The design sentence's first consequence. Measured, not divided: the
    // assertion is on when the sim stops lighting the boost.
    const { firstOutAt } = holdBoost(ANNIVERSARY_SCALE, 30)
    expect(firstOutAt).not.toBeNull()
    expect(firstOutAt as number).toBeCloseTo(6.25, 1)
  })

  it('locks boost out for RebootTime, the sheet’s own answer to an empty tank', () => {
    const spec = energySpec(ANNIVERSARY_SCALE)
    const state = createEnergy(spec)
    // Drain it.
    while (boostAvailable(state)) stepEnergy(state, spec, true, FIXED_DT)
    expect(state.energy).toBe(0)
    // The lockout is the prefab's RebootTime and this asserts the RELATIONSHIP
    // rather than the number 3 — a re-extraction that moved it moves both.
    expect(state.lockout).toBeCloseTo(HOVERJET.energy.RebootTime, 6)

    // Hold boost right through the lockout and MEASURE how long it stays out —
    // counting ticks rather than asserting a step count, so the answer is the
    // lockout's duration and not my arithmetic about it.
    //
    // Measured as "how long until a tick LIGHTS again", which is the thing the
    // player experiences, rather than by counting steps I worked out myself.
    // Note the boundary: the tick that consumes the last of the lockout is also
    // the tick that lights, so the lockout is over the instant it expires and
    // not a tick later — 12 ms either way, and worth pinning rather than
    // leaving to whichever order a future edit lands in.
    let lockedSeconds = 0
    while (lockedSeconds < 30) {
      const lit = stepEnergy(state, spec, true, FIXED_DT)
      if (lit) break
      lockedSeconds += FIXED_DT
    }
    // Within one tick of the prefab's RebootTime. The tick is the resolution of
    // the fixed step, so this is exact to the only precision there is.
    expect(lockedSeconds).toBeGreaterThanOrEqual(HOVERJET.energy.RebootTime - FIXED_DT)
    expect(lockedSeconds).toBeLessThanOrEqual(HOVERJET.energy.RebootTime + FIXED_DT)
    // Three seconds of recharge at half the burn rate is three seconds of boost
    // back. The point of recharging through the lockout: coming back is worth
    // something. Asserted as "more than a second of boost", which is the claim.
    expect(state.energy).toBeGreaterThan(spec.burnPerSecond)
    expect(boostAvailable(state)).toBe(true)
  })

  it('sustains boost for HALF the run, in steady state', () => {
    // "You may boost half the lap", measured by a greedy pilot who holds boost
    // whenever it is available. Nothing here divides the two constants; it
    // counts the ticks the sim lit.
    //
    // The first 30 s are DISCARDED and that is the point rather than a fudge:
    // the run starts on a full tank, which is 6.25 s of boost nobody paid for,
    // and averaging it in would report a duty cycle the pilot cannot sustain.
    // What the design sentence claims is the STEADY state — after the opening
    // tank, the greedy cycle is 3 s of burn from a 48-unit tank and 3 s of
    // lockout, which is a half exactly.
    const spec = energySpec(ANNIVERSARY_SCALE)
    const state = createEnergy(spec)
    const settle = Math.round(30 / FIXED_DT)
    const measure = Math.round(150 / FIXED_DT)
    for (let i = 0; i < settle; i++) stepEnergy(state, spec, true, FIXED_DT)
    let litSeconds = 0
    for (let i = 0; i < measure; i++) {
      if (stepEnergy(state, spec, true, FIXED_DT)) litSeconds += FIXED_DT
    }
    expect(litSeconds / (measure * FIXED_DT)).toBeCloseTo(0.5, 2)
  })

  it('and the OPENING tank is worth more than the steady state', () => {
    // The other half of the sentence above, said as its own claim so it cannot
    // be lost in a tolerance: the first cycle is longer than every one after
    // it, because it starts full rather than at what three seconds of lockout
    // bought. That is what makes the opening lap feel different.
    const first = holdBoost(ANNIVERSARY_SCALE, 30).firstOutAt as number
    expect(first).toBeGreaterThan(HOVERJET.energy.RebootTime)
  })

  it('does not burn when the stick is not held, and refills', () => {
    const spec = energySpec(ANNIVERSARY_SCALE)
    const state = createEnergy(spec)
    for (let i = 0; i < 500; i++) stepEnergy(state, spec, false, FIXED_DT)
    expect(state.energy).toBe(spec.maxEnergy)
    expect(state.lit).toBe(false)

    // Half-drain it, let go, and it comes back to full.
    for (let i = 0; i < 200; i++) stepEnergy(state, spec, true, FIXED_DT)
    expect(energyFraction(state, spec)).toBeLessThan(0.8)
    for (let i = 0; i < 1000; i++) stepEnergy(state, spec, false, FIXED_DT)
    expect(energyFraction(state, spec)).toBe(1)
  })

  it('never lets the tank go negative', () => {
    // The JumpSeat's tank DOES go negative by design (`sim/jumpseat.ts`); this
    // one must not, or a lockout would get longer the harder you leaned on it.
    const spec = energySpec(ANNIVERSARY_SCALE)
    const state = createEnergy(spec)
    for (let i = 0; i < 4000; i++) {
      stepEnergy(state, spec, true, FIXED_DT)
      expect(state.energy).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('an empty tank and a locked-out tank are different states', () => {
  it('reports unavailable while the lockout runs even as the tank fills', () => {
    const spec = energySpec(ANNIVERSARY_SCALE)
    const state = createEnergy(spec)
    while (boostAvailable(state)) stepEnergy(state, spec, true, FIXED_DT)
    // One second into the lockout: there IS energy, and boost still will not
    // light. If these two ever agree, the HUD's muted state is undrawable and
    // the player has no way to tell "empty" from "waiting".
    for (let i = 0; i < Math.round(1 / FIXED_DT); i++) stepEnergy(state, spec, false, FIXED_DT)
    expect(state.energy).toBeGreaterThan(0)
    expect(boostAvailable(state)).toBe(false)
  })
})

describe('trap 19 — a second tank leaves the first alone', () => {
  it('steps two states independently', () => {
    const spec = energySpec(ANNIVERSARY_SCALE)
    const a = createEnergy(spec)
    const b = createEnergy(spec)
    for (let i = 0; i < 300; i++) stepEnergy(a, spec, true, FIXED_DT)
    const aEnergy = a.energy
    const aLit = a.lit
    for (let i = 0; i < 900; i++) stepEnergy(b, spec, true, FIXED_DT)
    expect(a.energy).toBe(aEnergy)
    expect(a.lit).toBe(aLit)
    expect(b.energy).not.toBe(aEnergy)
  })
})

// ── DEV-410: no lockout, and a ring refills the tank ──────────────────────
//
// Matt, 2026-09-25: *"i'd expect each ring to build up my boost bar a bit, and
// if i'm boosting through a chain, it should be able to continuously refill
// the boost."* These read the PRESET's own numbers, never a copy of them.
describe('DEV-410 — Anniversary: no lockout, and rings refill the tank', () => {
  const energy = anniversary.gameplay.energy
  const annSpec = () =>
    energySpec(energy.rechargeScale, undefined, energy.lockoutScale, energy.reengage)
  /** int_01's legs, ring to ring in the course's order, as CHORDS in metres. */
  const int01Legs = (): number[] => {
    const route = int01.routes[0]
    if (!route) throw new Error('int_01_hoverJet has no route')
    const rings = [...route.rings].sort((a, b) => a.order - b.order)
    const legs: number[] = []
    for (let i = 1; i < rings.length; i++) {
      const a = rings[i - 1]?.pos ?? []
      const b = rings[i]?.pos ?? []
      // A missing coordinate is a NaN, which fails every assertion loudly.
      legs.push(Math.hypot(...b.map((v, k) => v - (a[k] ?? Number.NaN))))
    }
    return legs
  }

  // The MECHANISM at `reengage` 0, which is where "no lockout" alone leads.
  // Anniversary itself waits (the describe below); this keeps the half-power
  // path honest for any preset that asks for it.
  it('at reengage 0: never locks out, and an empty tank boosts on what the recharge pays', () => {
    const spec = energySpec(energy.rechargeScale, undefined, energy.lockoutScale, 0)
    const state = createEnergy(spec)
    // Past the opening tank, well into the empty steady state.
    for (let i = 0; i < Math.round(20 / FIXED_DT); i++) stepEnergy(state, spec, true, FIXED_DT)
    let unlit = 0
    let power = 0
    const measure = Math.round(20 / FIXED_DT)
    for (let i = 0; i < measure; i++) {
      if (!stepEnergy(state, spec, true, FIXED_DT)) unlit++
      expect(state.lockout).toBe(0)
      power += state.power
    }
    // Lit on every tick, so the engine note and the particles never flicker…
    expect(unlit).toBe(0)
    // …at a power the recharge can actually pay, MEASURED as the tank's own
    // throughput: the energy recharged over the window must cover the energy
    // burned. So this is not free boost, which is what "no lockout" becomes
    // without `power` (the header says why).
    const burned = (power / measure) * spec.burnPerSecond
    expect(burned).toBeLessThanOrEqual(spec.rechargePerSecond + 1e-9)
    expect(burned).toBeCloseTo(spec.rechargePerSecond, 6)
    expect(power / measure).toBeGreaterThan(0)
    expect(power / measure).toBeLessThan(1)
  })

  it('pays the whole boost while the tank holds a tick, so the opening is 2016 exactly', () => {
    const spec = annSpec()
    const state = createEnergy(spec)
    for (let i = 0; i < Math.round(5 / FIXED_DT); i++) {
      stepEnergy(state, spec, true, FIXED_DT)
      expect(state.power).toBe(1)
    }
  })

  it("carries a chain at full boost through int_01, ring to ring, off the level's own rings", () => {
    // The derivation the preset's note gives, re-done from the level JSON and
    // the sheet rather than copied: the legs are CHORDS between consecutive
    // rings (a lower bound on the flown path), flown at the sheet's boosted
    // terminal speed with boost held the whole way, refilled at every ring.
    const legs = int01Legs()
    expect(legs.length).toBeGreaterThan(10)
    const speed = DERIVED.hoverjet.terminalSpeedBoost
    const spec = annSpec()
    const state = createEnergy(spec)
    let lowest = state.energy
    let lowestPower = 1
    for (const leg of legs) {
      const ticks = Math.ceil(leg / speed / FIXED_DT)
      for (let t = 0; t < ticks; t++) {
        stepEnergy(state, spec, true, FIXED_DT)
        lowest = Math.min(lowest, state.energy)
        lowestPower = Math.min(lowestPower, state.power)
      }
      refillEnergy(state, spec, energy.ringRefill)
    }
    // Never dry, never short of a whole boost: that is "continuously refill".
    expect(lowest).toBeGreaterThan(0)
    expect(lowestPower).toBe(1)
  })

  it('is the smallest round half-tank that covers the longest leg', () => {
    // The other half of the derivation: 0.5 is not generous by accident. The
    // longest leg's net drain must fit inside one refill, and a refill a
    // tenth of a tank smaller must not cover it. That is what "derived"
    // means here.
    const longest = Math.max(...int01Legs())
    const spec = annSpec()
    const drain =
      ((spec.burnPerSecond - spec.rechargePerSecond) * longest) /
      DERIVED.hoverjet.terminalSpeedBoost
    expect(energy.ringRefill * spec.maxEnergy).toBeGreaterThanOrEqual(drain)
    expect((energy.ringRefill - 0.1) * spec.maxEnergy).toBeLessThan(drain)
  })

  it('refills clamped at the top, and leaves a running lockout alone', () => {
    const spec = energySpec(ANNIVERSARY_SCALE) // 2016's lockout, to have one to leave alone
    const state = createEnergy(spec)
    refillEnergy(state, spec, 0.5)
    expect(state.energy).toBe(spec.maxEnergy)
    while (boostAvailable(state)) stepEnergy(state, spec, true, FIXED_DT)
    const lockout = state.lockout
    expect(lockout).toBeGreaterThan(0)
    refillEnergy(state, spec, 0.5)
    expect(state.lockout).toBe(lockout)
    expect(state.energy).toBeCloseTo(spec.maxEnergy * 0.5, 6)
  })

  it("Classic's numbers are identities: 2016's lockout, no wait, and a ring pays nothing", () => {
    const c = classic.gameplay.energy
    const spec = energySpec(c.rechargeScale, undefined, c.lockoutScale, c.reengage)
    expect(spec.lockoutSeconds).toBe(HOVERJET.energy.RebootTime)
    expect(spec.reengageEnergy).toBe(0)
    const state = createEnergy(spec)
    for (let i = 0; i < 100; i++) stepEnergy(state, spec, true, FIXED_DT)
    const before = state.energy
    refillEnergy(state, spec, c.ringRefill)
    expect(state.energy).toBe(before)
  })
})

// ── DEV-410 follow-up: an empty tank is NOTHING ───────────────────────────
//
// Matt, 2026-09-26, asked whether an empty tank should give half power:
// *"nothing - i think part of the problem is not realizing the boost bar is
// filling / emptying"*. Measured by stepping, against the preset's own number.
describe('DEV-410 follow-up — Anniversary: a dry tank is nothing until it refills', () => {
  const energy = anniversary.gameplay.energy
  const spec = () =>
    energySpec(energy.rechargeScale, undefined, energy.lockoutScale, energy.reengage)
  const drain = () => {
    const s = spec()
    const state = createEnergy(s)
    while (!state.drained) stepEnergy(state, s, true, FIXED_DT)
    return { s, state }
  }

  it('waits', () => {
    expect(energy.reengage).toBeGreaterThan(0)
  })

  it('lights nothing, and reads unavailable, until the tank holds reengage again', () => {
    const { s, state } = drain()
    let out = 0
    while (!stepEnergy(state, s, true, FIXED_DT)) {
      expect(boostAvailable(state), 'the HUD says EMPTY the whole time').toBe(false)
      expect(state.power).toBe(0)
      out += FIXED_DT
      if (out > 30) throw new Error('never came back')
    }
    // Out for as long as the recharge takes to put reengage back, to a tick.
    const want = s.reengageEnergy / s.rechargePerSecond
    expect(out).toBeGreaterThanOrEqual(want - 2 * FIXED_DT)
    expect(out).toBeLessThanOrEqual(want + 2 * FIXED_DT)
    // No lockout: the wait is the tank, which the player can see.
    expect(state.lockout).toBe(0)
  })

  it('a ring ends the wait at once', () => {
    const { s, state } = drain()
    stepEnergy(state, s, true, FIXED_DT)
    expect(boostAvailable(state)).toBe(false)
    refillEnergy(state, s, energy.ringRefill)
    expect(boostAvailable(state)).toBe(true)
    expect(stepEnergy(state, s, true, FIXED_DT)).toBe(true)
    expect(state.power).toBe(1)
  })
})

// ── DEV-630: Anniversary starts the run EMPTY ─────────────────────────────
//
// Matt, 2026-10-04: *"boost should be empty at the start"*. 2016's `Awake()`
// fills the tank, which `?rules=classic` keeps. The VALUES are pinned here on
// purpose (CLAUDE.md, a shipped default): changing one is an edit to this line.
describe('DEV-630: the tank a run starts with', () => {
  const a = anniversary.gameplay.energy
  const c = classic.gameplay.energy

  it('Anniversary starts empty; Classic (2016) starts full', () => {
    expect(a.startFill).toBe(0)
    expect(c.startFill).toBe(1)
    expect(createEnergy(energySpec(c.rechargeScale), c.startFill).energy).toBe(
      HOVERJET.energy.maxEnergy,
    )
  })

  it('an empty start is a DRY tank: EMPTY on the HUD until reengage, then BOOST READY', () => {
    const s = energySpec(a.rechargeScale, undefined, a.lockoutScale, a.reengage)
    const state = createEnergy(s, a.startFill)
    expect(state.energy).toBe(0)
    expect(boostAvailable(state)).toBe(false)
    let out = 0
    while (!stepEnergy(state, s, true, FIXED_DT)) {
      expect(state.power).toBe(0)
      out += FIXED_DT
      if (out > 30) throw new Error('never lit')
    }
    const want = s.reengageEnergy / s.rechargePerSecond
    expect(out).toBeGreaterThanOrEqual(want - 2 * FIXED_DT)
    expect(out).toBeLessThanOrEqual(want + 2 * FIXED_DT)
  })

  it('a first ring lights it at once', () => {
    const s = energySpec(a.rechargeScale, undefined, a.lockoutScale, a.reengage)
    const state = createEnergy(s, a.startFill)
    refillEnergy(state, s, a.ringRefill)
    expect(boostAvailable(state)).toBe(true)
  })

  it('the default is 2016: no argument is a full tank', () => {
    expect(createEnergy(energySpec(a.rechargeScale)).energy).toBe(HOVERJET.energy.maxEnergy)
  })
})
