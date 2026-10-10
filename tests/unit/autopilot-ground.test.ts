// tests/unit/autopilot-ground.test.ts — the autopilot flew into a hill at 185 m/s.
//
// Matt: *"fix the autopilot stall at gate 6 — record telemetry of what is
// currently going on to understand what the bug is, then fix it."*
//
// ── What the telemetry said ───────────────────────────────────────────────
//
// Half a second per row, through the stall:
//
//     t     dist speed  aim  clear  pitch  thr   y
//     18.1   125   188  0.92    92   1.00  0.92  516   diving at the gate
//     18.6    45   185  0.90   -55  -1.00  0.90  466   clearance NEGATIVE, full pull-up
//     19.1    48   146 -0.71  -202  -1.00  0.35  394   still 202 m below its own path
//     19.6    95    11 -0.45     0  -1.00  0.35  353   185 -> 11 m/s
//
// 185 to 11 m/s in one second is 270 m/s^2. Drag cannot do that; a hillside can.
// So it was never a navigation bug — the autopilot knew, pulled up, saturated at
// pitch -1, and went in anyway, because at 185 m/s a pitch rate cannot bend the
// path fast enough. The twenty seconds were spent climbing back out.
//
// ── The fix, and why it is about SPEED ────────────────────────────────────
//
// Pulling up harder was not available — it was already at the stop. Slowing down
// is what buys the pull-up time, and it compounds: `lookAheadSeconds` is a TIME,
// so a slower ship also samples the ground ahead more finely.
//
// These tests are on the control law itself, with a synthetic ridge, because
// that is deterministic. A browser run is not: `autopilotTerrain` holds whatever
// chunks have STREAMED IN, so the same course gives different clearance readings
// depending on load timing — which is why the stall came and went between runs
// and why a screenshot could never have settled this.

import { describe, expect, it } from 'vitest'
import { type AutopilotBody, autopilotActions, DEFAULT_AUTOPILOT } from '@/sim/autopilot'
import { noInput } from '@/sim/hoverjet'
import { v3 } from '@/sim/math/vec3'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'

const PARAMS = {
  terrainSize: 4096,
  terrainHeight: 600,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

/** Flat ground at 0, with a wall of rock from u = 0.55 onward. */
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

const RIDGE = buildHeightField(ridgeMap(), PARAMS, { position: [0, 0, 0], scale: [1, 1, 1] })

/** Flying flat and fast at the ridge, `metres` short of it. */
const closing = (metres: number, speed: number): AutopilotBody => ({
  position: v3(0.55 * 4096 - metres, 300, 500),
  velocity: v3(speed, 0, 0),
  orientation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
})

/** The gate is straight ahead and LOW, which is what makes it dive. */
const lowGate = v3(0.55 * 4096 + 400, 120, 500)

describe('the ground response', () => {
  it('reads the ridge as a hazard at all', () => {
    // The fixture has to bite, or every test below is vacuous.
    const out = noInput()
    autopilotActions(closing(300, 185), lowGate, out, DEFAULT_AUTOPILOT, [RIDGE])
    expect(out.pitch, 'should be pulling up').toBeLessThan(0)
  })

  it('RELEASES BOOST when it is about to hit something', () => {
    // The single biggest thing the controller can do: boost is worth roughly
    // twice the speed. This is the half of the fix that was missing entirely —
    // the old law held boost through the strike.
    const clear = noInput()
    const hazard = noInput()
    autopilotActions(closing(3000, 185), lowGate, clear, DEFAULT_AUTOPILOT, [RIDGE])
    autopilotActions(closing(250, 185), lowGate, hazard, DEFAULT_AUTOPILOT, [RIDGE])
    expect(clear.boost, 'clear air').toBe(true)
    expect(hazard.boost, 'closing on a ridge').toBe(false)
  })

  it('EASES THE THROTTLE as the pull-up gets urgent', () => {
    // The SAME body and the SAME gate, two tunings. Throttle is also driven by
    // alignment, so comparing a near body against a far one measures the aim and
    // not the brake — the first version of this test did exactly that and passed
    // with `clearanceBrake: 0`. Holding the geometry fixed leaves only the brake.
    const body = closing(200, 185)
    const braked = noInput()
    const unbraked = noInput()
    autopilotActions(body, lowGate, braked, DEFAULT_AUTOPILOT, [RIDGE])
    autopilotActions(body, lowGate, unbraked, { ...DEFAULT_AUTOPILOT, clearanceBrake: 0 }, [RIDGE])
    expect(braked.throttle).toBeLessThan(unbraked.throttle)
    // And it is the taper doing it, in proportion.
    expect(braked.throttle).toBeCloseTo(unbraked.throttle * (1 - 0.6), 1)
  })

  it('never cuts the throttle to nothing — it still has to fly', () => {
    // A controller that closes the throttle stalls into the hill it is avoiding.
    // 0.6 of the taper leaves 40 %.
    const out = noInput()
    autopilotActions(closing(40, 250), lowGate, out, DEFAULT_AUTOPILOT, [RIDGE])
    expect(out.throttle).toBeGreaterThan(0.1)
  })

  it('does NOT brake in clear air, or every run is slow', () => {
    // The other failure mode, and the one that would be invisible: a controller
    // that is permanently cautious just loses the race quietly.
    const out = noInput()
    autopilotActions(closing(3000, 185), lowGate, out, DEFAULT_AUTOPILOT, [RIDGE])
    expect(out.boost).toBe(true)
    expect(out.throttle).toBeGreaterThan(0.9)
  })

  it('samples finely enough not to STEP OVER a ridge', () => {
    // At 185 m/s a 2.5 s lookahead is 462 m. Six samples put them 77 m apart —
    // wide enough to land either side of a crest and report the valleys. The
    // terrain's own quads are 8 m.
    const coarse = { ...DEFAULT_AUTOPILOT, clearanceSamples: 2 }
    const fine = noInput()
    const blunt = noInput()
    // A body positioned so a 2-sample probe brackets the ridge face.
    const body = closing(430, 185)
    autopilotActions(body, lowGate, blunt, coarse, [RIDGE])
    autopilotActions(body, lowGate, fine, DEFAULT_AUTOPILOT, [RIDGE])
    expect(DEFAULT_AUTOPILOT.clearanceSamples).toBeGreaterThanOrEqual(12)
    // The fine probe must see at least as much danger as the coarse one.
    expect(fine.pitch).toBeLessThanOrEqual(blunt.pitch)
  })
})

// ── The gate ORBIT, which was the twenty seconds ──────────────────────────
//
// The strike was only half of it. Telemetry of the ten seconds after:
//
//     t     dist  agl  speed  pitch
//     20.04   97   1.2   30.8  -1.00
//     22.09   56  84.8   86.9  -1.00
//     24.14   47  95.9   49.1   0.63
//     26.19   37  24.8   63.6  -1.00
//     29.27   28  64.0   50.9  -1.00
//
// Pitch at the -1.00 stop for **30 of 39 samples**, distance oscillating between
// 23 and 98 m and never closing. `int_01`'s gate 6 sits **23 to 112 m above the
// terrain** against a `minClearance` of 60, so closing on it raises the urgency
// to 1 and the `Math.min` priority pins the nose up. The ship orbited it.
//
// A gate is a certified-clear waypoint — 2016 put a ring there — so inside
// `gateOverrideMetres` the pull-up goes back to being a nudge.
describe('a gate low on a ridge', () => {
  /** Dead level, closing on a gate that sits just above the ridge top. */
  const onFinals = (metres: number): AutopilotBody => ({
    position: v3(0.55 * 4096 + 150 - metres, 560, 500),
    velocity: v3(120, 0, 0),
    orientation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
  })
  // Ridge top is 0.9 * 600 = 540. A gate 20 m above it is inside minClearance,
  // and inside DEV-394's `trustedClearance` (40 m), the floor trusted air
  // holds: at 40 m above the ridge this fixture raised no urgency on final
  // approach at all, and had nothing left to nudge.
  const ridgeGate = v3(0.55 * 4096 + 150, 560, 500)

  it('still raises the urgency — the fixture has to bite', () => {
    const far = noInput()
    autopilotActions(onFinals(400), ridgeGate, far, DEFAULT_AUTOPILOT, [RIDGE])
    expect(far.pitch, 'far out, the priority rule governs').toBeLessThan(0)
  })

  it('does NOT pin the nose up on final approach', () => {
    // The bug, stated as a test. At full urgency the old law wrote -1 here and
    // the seek could not answer, so the ship flew over the gate for ever.
    const near = noInput()
    autopilotActions(onFinals(60), ridgeGate, near, DEFAULT_AUTOPILOT, [RIDGE])
    expect(near.pitch).toBeGreaterThan(-0.99)
  })

  it('is the OVERRIDE doing it, not the geometry', () => {
    // Same body, same gate, override switched off. If this were the approach
    // angle rather than the rule, both would agree.
    const body = onFinals(60)
    const withOverride = noInput()
    const without = noInput()
    autopilotActions(body, ridgeGate, withOverride, DEFAULT_AUTOPILOT, [RIDGE])
    autopilotActions(body, ridgeGate, without, { ...DEFAULT_AUTOPILOT, gateOverrideMetres: 0 }, [
      RIDGE,
    ])
    // The gate sits 20 m above the ridge against a 60 m minClearance, so the
    // urgency here is (60-20)/60 = 0.67 and the priority rule writes exactly
    // -0.67. Asserting -1 was wrong about the fixture, not about the rule.
    expect(without.pitch).toBeCloseTo(-2 / 3, 2)
    expect(withOverride.pitch).toBeGreaterThan(without.pitch)
    // And the override is a NUDGE off the seek, not a second priority rule: it
    // must still bend the pitch DOWN relative to seeking with no ground term.
    //
    // Compared against `gateOverrideNudge: 0` rather than against a number
    // computed FROM the constant. The first version derived its expected value
    // from `DEFAULT_AUTOPILOT.gateOverrideNudge`, so setting that to zero moved
    // the assertion with it and the mutation passed.
    const noNudge = noInput()
    autopilotActions(body, ridgeGate, noNudge, { ...DEFAULT_AUTOPILOT, gateOverrideNudge: 0 }, [
      RIDGE,
    ])
    expect(withOverride.pitch).toBeLessThan(noNudge.pitch)
    expect(DEFAULT_AUTOPILOT.gateOverrideNudge).toBeGreaterThan(0)
  })

  it('keeps the priority rule BETWEEN gates, where it earns its keep', () => {
    // The override must be local to the approach. Out in open country a dive at
    // a distant gate still has to lose to the ground.
    const out = noInput()
    autopilotActions(closing(250, 185), lowGate, out, DEFAULT_AUTOPILOT, [RIDGE])
    expect(out.pitch).toBeLessThanOrEqual(-0.5)
  })
})

// ── Slowing for the corner, before arriving in it ─────────────────────────
//
// Matt: *"don't forget to adjust speed on approach to the gate if the following
// gate exceeds a threshold where full speed makes them crash."*
//
// Nothing in this controller looked past the gate it was flying at, so it
// arrived at every ring at whatever the preceding straight allowed and then
// discovered the turn. `int_01`'s legs are 500 m apart and three of its corners
// are 76, 94 and 99 degrees.
describe('corner braking', () => {
  /** Flying straight along +x at `speed`. The gate's distance is in `gate()`. */
  const approach = (_metres: number, speed: number): AutopilotBody => ({
    position: v3(0, 500, 0),
    velocity: v3(speed, 0, 0),
    orientation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
  })
  const gate = (metres: number) => v3(metres, 500, 0)
  /** The gate AFTER the target, placed to make a turn of `deg`. */
  const nextGateAt = (metres: number, deg: number) => {
    const r = (deg * Math.PI) / 180
    return v3(metres + Math.cos(r) * 500, 500, Math.sin(r) * 500)
  }

  it('does EXACTLY nothing for a bend under the threshold', () => {
    // `int_01` is mostly 7 to 38 degrees and the ship carries those flat out. A
    // controller that lifts for them is just slow.
    //
    // Compared against `nextTarget: null`, which is by definition zero corner
    // braking — an exact equality rather than "> 0.9". The loose version passed
    // with the threshold set to ZERO, because at 300 m the proximity weight is
    // 0.12 and a gentle bend costs under a percent either way; put the bend
    // CLOSE and the threshold is the only thing standing between them.
    const gentle = noInput()
    const none = noInput()
    autopilotActions(
      approach(90, 200),
      gate(90),
      gentle,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      nextGateAt(90, 25),
    )
    autopilotActions(
      approach(90, 200),
      gate(90),
      none,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      null,
    )
    expect(gentle.throttle).toBeCloseTo(none.throttle, 9)
    expect(gentle.boost).toBe(true)
  })

  it('lifts and drops boost for a hairpin', () => {
    const out = noInput()
    autopilotActions(
      approach(150, 200),
      gate(150),
      out,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      nextGateAt(150, 99),
    )
    expect(out.boost, 'boost goes first').toBe(false)
    // Against the gentle bend rather than a magic number. At 150 m and 200 m/s
    // the maths gives 0.849 — turn 0.55, proximity 0.56, so a quarter of the
    // 0.6 ceiling — and asserting "< 0.8" was a guess about that arithmetic
    // rather than a statement about the behaviour.
    const gentle = noInput()
    autopilotActions(
      approach(150, 200),
      gate(150),
      gentle,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      nextGateAt(150, 20),
    )
    expect(out.throttle).toBeLessThan(gentle.throttle - 0.1)
  })

  it('brakes MORE the closer the corner is, not on a flat threshold', () => {
    const far = noInput()
    const near = noInput()
    const a = nextGateAt(400, 99)
    autopilotActions(
      approach(400, 200),
      gate(400),
      far,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      a,
    )
    const b = nextGateAt(80, 99)
    autopilotActions(
      approach(80, 200),
      gate(80),
      near,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      b,
    )
    expect(near.throttle).toBeLessThan(far.throttle)
  })

  it('starts earlier the faster you are going, because it is a TIME', () => {
    // Same geometry, two speeds. A distance threshold would brake at the same
    // place regardless, which is the wrong shape: stopping distance is not
    // constant.
    const slow = noInput()
    const fast = noInput()
    const a = nextGateAt(300, 99)
    autopilotActions(
      approach(300, 80),
      gate(300),
      slow,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      a,
    )
    autopilotActions(
      approach(300, 240),
      gate(300),
      fast,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      a,
    )
    expect(fast.throttle).toBeLessThan(slow.throttle)
  })

  it('does nothing at all on the LAST gate, which has no next', () => {
    const out = noInput()
    autopilotActions(
      approach(100, 200),
      gate(100),
      out,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      null,
    )
    expect(out.throttle).toBeGreaterThan(0.9)
    expect(out.boost).toBe(true)
  })

  it('never closes the throttle — it still has to reach the gate', () => {
    const out = noInput()
    autopilotActions(
      approach(5, 260),
      gate(5),
      out,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      nextGateAt(5, 179),
    )
    expect(out.throttle).toBeGreaterThan(0.05)
  })
})
