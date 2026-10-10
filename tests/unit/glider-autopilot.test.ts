/**
 * `src/sim/glider-autopilot.ts` — DEV-145.
 *
 * ── The signs, pinned by measurement ──────────────────────────────────────
 *
 * Four sign errors were found in this branch and every one of them was found
 * by FLYING the thing, not by reading it. Three were in the controller's two
 * rotational loops, and they are the reason this file leads with measurements
 * rather than with behaviour:
 *
 *   · which way a positive roll input banks the aircraft
 *   · which way a bank turns the flight path
 *   · which way a positive pitch input moves the nose
 *
 * Each is asserted here as an OBSERVATION of `stepGlider` — a quantity that is
 * true whatever anyone believes — and the controller is then asserted to agree
 * with it. That is the orientation lesson applied to a controller instead of to
 * a mesh: test the geometry, not the rotation.
 *
 * The third one is worth its own note, because the FIRST measurement of it was
 * a lie. Hold full roll for six seconds, read the heading at the end, and it
 * says a positive bank turns right. It does not: by then the aircraft has
 * rolled through 180 degrees and is turning the other way. **Measure a sign
 * before the thing being measured changes sign** — hence the one-second window
 * below, and hence the assertion that the aircraft has NOT rolled past
 * knife-edge inside it, which is what makes the window trustworthy.
 */
import { describe, expect, it } from 'vitest'
import { FIXED_DT } from '@/sim/constants'
import {
  createGlider,
  type Glider,
  noGliderInput,
  PROTOTYPE_GLIDER,
  stepGlider,
} from '@/sim/glider'
import {
  bestGlideRatio,
  DEFAULT_GLIDER_AUTOPILOT,
  gliderAutopilotActions,
} from '@/sim/glider-autopilot'
import { rotateVec3, setQ } from '@/sim/math/quat'
import { length, set, v3 } from '@/sim/math/vec3'

const T = PROTOTYPE_GLIDER
const secs = (s: number) => Math.round(s / FIXED_DT)

const level = (speed = 60): Glider => {
  const g = createGlider(T)
  setQ(g.body.orientation, 0, 0, 0, 1)
  set(g.body.velocity, 0, 0, speed)
  set(g.body.position, 0, 5000, 0)
  return g
}

/** The angle the wings make with the horizon, the way the controller reads it. */
const bankOf = (g: Glider): number => {
  const right = rotateVec3(v3(), g.body.orientation, v3(1, 0, 0))
  const up = rotateVec3(v3(), g.body.orientation, v3(0, 1, 0))
  return Math.atan2(right.y, up.y)
}

const headingOf = (g: Glider): number => Math.atan2(g.body.velocity.x, g.body.velocity.z)

/**
 * The airspeed the CALLER hands the controller. In the game it is
 * `glider.airspeed`, written by the previous `stepGlider`; on a glider that has
 * never been stepped that field is still 0, and the controller's own
 * "standing still, no opinion" early-out then makes every assertion below read
 * zero and pass for the wrong reason. Taken from the velocity instead.
 */
const speedOf = (g: Glider): number => length(g.body.velocity)

describe('glider-autopilot — the measured facts it is built on', () => {
  it('a positive roll input banks the aircraft positively', () => {
    const g = level()
    for (let i = 0; i < secs(1); i++) stepGlider(g, { ...noGliderInput(), roll: 1 })
    expect(bankOf(g)).toBeGreaterThan(0)
  })

  it('a positive bank turns the FLIGHT PATH toward a negative heading', () => {
    const g = level()
    const before = headingOf(g)
    for (let i = 0; i < secs(1); i++) stepGlider(g, { ...noGliderInput(), roll: 1 })
    // The window is only trustworthy while the aircraft is still the right way
    // up — past knife-edge the turn reverses and the measurement inverts. This
    // is the assertion that makes the one above safe to read.
    expect(Math.abs(bankOf(g))).toBeLessThan(Math.PI / 2)
    expect(headingOf(g)).toBeLessThan(before)
  })

  it('and the mirror image, so neither is an accident of one direction', () => {
    const g = level()
    const before = headingOf(g)
    for (let i = 0; i < secs(1); i++) stepGlider(g, { ...noGliderInput(), roll: -1 })
    expect(bankOf(g)).toBeLessThan(0)
    expect(Math.abs(bankOf(g))).toBeLessThan(Math.PI / 2)
    expect(headingOf(g)).toBeGreaterThan(before)
  })
})

describe('glider-autopilot — it agrees with those facts', () => {
  const steer = (target: ReturnType<typeof v3>, g = level()) => {
    const out = noGliderInput()
    gliderAutopilotActions(g.body, target, speedOf(g), g.fuel, T, out)
    return out
  }

  it('banks the way that turns toward a target off to one side', () => {
    // Flying along +z. A target at -x needs a heading MORE negative, and a
    // negative heading change comes from a POSITIVE bank — so positive roll.
    const left = steer(v3(-800, 5000, 800))
    expect(left.roll).toBeGreaterThan(0)
    const right = steer(v3(800, 5000, 800))
    expect(right.roll).toBeLessThan(0)
  })

  it('holds the stick still when it is already pointing at the target', () => {
    const out = steer(v3(0, 5000, 800))
    expect(Math.abs(out.roll)).toBeLessThan(0.05)
  })

  it('pushes the nose DOWN at a target below and up at one above', () => {
    // `GliderInput.pitch` is positive for nose-down, matching `stepHoverJet`.
    expect(steer(v3(0, 4000, 800)).pitch).toBeGreaterThan(0)
    expect(steer(v3(0, 5600, 800)).pitch).toBeLessThan(0)
  })

  it('puts the nose down when too slow, whatever the target is doing', () => {
    // The speed floor outranks the course. A target high above would otherwise
    // command full back-stick into a stall.
    const slow = level(T.stallSpeed - 5)
    const out = noGliderInput()
    gliderAutopilotActions(slow.body, v3(0, 6000, 400), speedOf(slow), slow.fuel, T, out)
    expect(out.pitch).toBeGreaterThan(0)
  })

  it('never uses the rudder', () => {
    // Deliberate: this airframe yaws at 17 deg/s and pays for the sideslip.
    expect(steer(v3(-800, 4000, 800)).yaw).toBe(0)
    expect(steer(v3(800, 6000, 800)).yaw).toBe(0)
  })
})

describe('glider-autopilot — the rocket rule', () => {
  const rocketFor = (targetY: number, horizontal: number) => {
    const g = level()
    const out = noGliderInput()
    gliderAutopilotActions(g.body, v3(0, targetY, horizontal), speedOf(g), g.fuel, T, out)
    return out.rocket
  }

  it('is silent when the glide reaches', () => {
    // 700 m out, 5000 m up: gliding at 7 : 1 arrives 100 m low, and the target
    // is 100 m below, so it arrives level. No rocket.
    expect(rocketFor(4900, 700)).toBe(false)
  })

  it('fires when the glide arrives short by more than the margin', () => {
    expect(rocketFor(4990, 700)).toBe(true)
  })

  it('does not fire on a close gate that merely LOOKS steep', () => {
    // 270 m out and 11 m below demands 24 : 1 by the naive metric, which reads
    // as hopeless. Gliding there at 7 : 1 arrives 39 m low — fine for a 55 m
    // ring. The naive rule fired here, dumped the tank, and lost the run.
    expect(rocketFor(4989, 270)).toBe(false)
  })

  it('never fires with an empty tank', () => {
    const g = level()
    g.fuel = 0
    const out = noGliderInput()
    gliderAutopilotActions(g.body, v3(0, 5200, 700), speedOf(g), 0, T, out)
    expect(out.rocket).toBe(false)
  })
})

describe('glider-autopilot — unusual attitude recovery', () => {
  it('rolls wings level and ignores the course when it is on its back', () => {
    const g = level()
    // Inverted: 180 degrees of roll.
    setQ(g.body.orientation, 0, 0, 1, 0)
    const out = noGliderInput()
    gliderAutopilotActions(g.body, v3(900, 4000, 100), speedOf(g), g.fuel, T, out)
    // The stick is hard over — it is getting the wings back under it — and it
    // is NOT burning fuel into an attitude that cannot use it.
    expect(Math.abs(out.roll)).toBe(1)
    expect(out.rocket).toBe(false)
  })

  it('does not engage in normal flight', () => {
    const g = level()
    const out = noGliderInput()
    gliderAutopilotActions(g.body, v3(0, 4000, 800), speedOf(g), g.fuel, T, out)
    expect(Math.abs(out.roll)).toBeLessThan(1)
  })
})

describe('glider-autopilot — derived, not stated', () => {
  it('computes the airframe best glide from the tuning the physics reads', () => {
    // 7.00 : 1. Not a constant in this file — if the vehicle is retuned the
    // pilot's rocket decision follows it, instead of believing in a glide the
    // vehicle no longer has (DEV-069).
    expect(bestGlideRatio(T)).toBeCloseTo(7, 2)
  })

  it('caps the bank it will ask for', () => {
    // A target dead behind commands a turn, not a barrel roll.
    const g = level()
    const out = noGliderInput()
    gliderAutopilotActions(g.body, v3(0, 5000, -800), speedOf(g), g.fuel, T, out)
    expect(DEFAULT_GLIDER_AUTOPILOT.maxBank).toBeLessThan(Math.PI / 2)
    expect(Number.isFinite(out.roll)).toBe(true)
  })
})
