// tests/unit/comfort-vignette.test.ts — the vignette answers to the right
// signal, at the right rate, with the right geometry.
//
// **What these tests cannot say.** Nothing here shows the vignette helps anyone.
// `docs/vr-testing.md` is explicit that comfort is untestable by construction —
// paths 1 and 2 cannot reach it and *"no amount of green CI substitutes for
// putting the headset on."* PORT_PLAN §2.9 item 6 puts three external testers on
// M5a's exit for exactly this, and it is the only mitigation in the plan that
// cannot be done by writing code.
//
// **What they can say**, and it is not nothing: a vignette driven by the WRONG
// signal is worse than none — it is a second thing moving in your peripheral
// vision, uncorrelated with what your body is doing. So: is it reading the
// angular rate off the body rather than differencing frames; is roll the
// dominant term; does it hold still through ordinary flying; is it frame-rate
// independent; and is the quad the shape it claims to be.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { resolveVariant } from '@/content/load-aircraft'
import { jumpSeatFor } from '@/game/jumpseat-flight'
import { HOVERJET } from '@/generated/constants.generated'
import {
  ATTACK_TAU,
  apertureRadius,
  createVignette,
  HOVERJET_FULL_ROLL_RATE,
  JUMPSEAT_FULL_ROLL_RATE,
  LINEAR_FULL,
  LINEAR_OPEN,
  linearToDemand,
  nauseogenicRate,
  OPEN_FRACTION,
  R_CLOSED_LIGHT,
  R_CLOSED_STRONG,
  R_OPEN,
  RELEASE_TAU,
  rateToDemand,
  smoothLevel,
  type VignetteInput,
} from '@/render/vignette'
import { FIXED_DT } from '@/sim/constants'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { createJumpSeat, noJumpSeatInput, stepJumpSeat } from '@/sim/jumpseat'
import { quat } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { fullStickRate } from '@/sim/rigidbody'
import { buildHeightField } from '@/sim/terrain/height-field'
import { SPIDER_READY } from './helpers/spider-ready'

const ANNIVERSARY_EDITION = { gameplay: { variants: { enabled: true } } }

/** A ship at `orientation`, turning at `w` rad/s in WORLD space. */
const state = (w: { x: number; y: number; z: number }, orientation = quat()): VignetteInput => ({
  angularVelocity: v3(w.x, w.y, w.z),
  orientation,
})

/** A quaternion about an axis, built without three so the sim types line up. */
const about = (ax: number, ay: number, az: number, angle: number) => {
  const s = Math.sin(angle / 2)
  return quat(ax * s, ay * s, az * s, Math.cos(angle / 2))
}

describe('the vignette is calibrated against the ship that flies', () => {
  it('re-derives the full-stick roll rate by stepping the REAL integrator', () => {
    // DEV-027, in full: "a DERIVED number needs the same provenance discipline
    // as an extracted one ... nothing guards a number you compute yourself in a
    // scratch script, and those get quoted in comments and built on as if they
    // were measured."
    //
    // `fullStickRate` is an algebraic claim about `sim/rigidbody.ts`. This does
    // not restate the algebra; it runs the shipped integrator with the stick
    // pinned and measures where it ends up.
    //
    // **It has already earned its keep.** The first version of `fullStickRate`
    // was the continuous-time answer, `rollRate / angularDrag` = 1.5385 — which
    // is what you get if you solve `dw/dt = tau - d*w` instead of the
    // recurrence the integrator actually runs. The real fixed point is
    // `(tau/d) * (1 - d*dt)` = 1.5019, and the 2.4 % gap would have capped the
    // vignette at 98 % of full closure at any roll rate reachable in the game.
    // Nothing else in the suite would have noticed.
    const jet = createHoverJet()
    const stick = { ...noInput(), roll: 1 }
    // 1,000 ticks is 12.2 s. The per-tick decay is 0.9762, so the remaining
    // transient is 0.9762^1000 ~ 4e-11 — comfortably below the tolerance, which
    // 400 ticks was NOT (it left 1e-4 and looked like a real disagreement).
    for (let i = 0; i < 1000; i++) stepHoverJet(jet, stick, FIXED_DT)
    const w = jet.body.angularVelocity
    expect(Math.hypot(w.x, w.y, w.z)).toBeCloseTo(HOVERJET_FULL_ROLL_RATE, 9)
  })

  it('reads that rate off the constants sheet, not out of a comment', () => {
    expect(HOVERJET_FULL_ROLL_RATE).toBe(
      fullStickRate(HOVERJET.ship.rollRate, HOVERJET.rigidbody.angularDrag),
    )
    // 86.0 deg/s. Stated in degrees because nobody can picture 1.5 rad/s, and
    // pinned here so the continuous-time 88.1 cannot creep back in unnoticed.
    expect((HOVERJET_FULL_ROLL_RATE * 180) / Math.PI).toBeCloseTo(86.05, 2)
  })

  it('re-derives the JumpSeat-s the same way, against ITS integrator', () => {
    // The same measurement on the other vehicle, because the two share nothing
    // but a formula: the seat's torque comes from `ShipOrientationManager` and
    // its drag is 1.75, not 1.95. A calibration that is right for one vehicle
    // and silently wrong for the other is the shape of bug the "agreement
    // lesson" is about.
    const seat = createJumpSeat()
    const stick = { ...noJumpSeatInput(), roll: 1 }
    for (let i = 0; i < 1000; i++) stepJumpSeat(seat, stick, [], FIXED_DT)
    const w = seat.body.angularVelocity
    expect(Math.hypot(w.x, w.y, w.z)).toBeCloseTo(JUMPSEAT_FULL_ROLL_RATE, 9)
    expect((JUMPSEAT_FULL_ROLL_RATE * 180) / Math.PI).toBeCloseTo(25.63, 2)
  })

  it('gives the JumpSeat its own number, because it is a third of the jet-s', () => {
    // Calibrating both vehicles against the HoverJet would leave the JumpSeat's
    // vignette permanently open: full stick on the seat is 26 deg/s, which is
    // inside the HoverJet's DEADBAND. A shared constant would have looked fine
    // in every HoverJet test in the suite.
    expect(JUMPSEAT_FULL_ROLL_RATE).toBeLessThan(HOVERJET_FULL_ROLL_RATE * OPEN_FRACTION * 1.6)
    expect(rateToDemand(JUMPSEAT_FULL_ROLL_RATE, HOVERJET_FULL_ROLL_RATE)).toBeLessThan(0.2)
    expect(rateToDemand(JUMPSEAT_FULL_ROLL_RATE, JUMPSEAT_FULL_ROLL_RATE)).toBe(1)
  })
})

describe('the signal is the angular rate, decomposed on BODY axes', () => {
  it('weights ROLL above yaw above pitch', () => {
    // PORT_PLAN §2.9: "Roll rate is the nauseogenic term." The ORDER is what
    // the corpus settles; the three weights themselves are chosen, and the
    // header says so.
    const r = nauseogenicRate(state({ x: 0, y: 0, z: 1 }))
    const y = nauseogenicRate(state({ x: 0, y: 1, z: 0 }))
    const p = nauseogenicRate(state({ x: 1, y: 0, z: 0 }))
    expect(r).toBeGreaterThan(y)
    expect(y).toBeGreaterThan(p)
  })

  it('is BODY-relative — the case where body axes and world axes disagree', () => {
    // "A rule tested only where two explanations agree has not been tested."
    // At identity orientation, "decompose on the body axes" and "read the world
    // components" give the same answer for every input, so every test above
    // passes under both. This is the case that separates them.
    //
    // Pitch the ship 90 degrees nose-up. Its forward axis (body +Z) now points
    // along world +Y, and its up axis (body +Y) along world −Z. So a world
    // angular velocity of (0, 1, 0) is a pure ROLL and (0, 0, 1) is a pure YAW
    // — which is the exact reverse of what the world components say, and the
    // reverse is what makes this a test rather than a restatement.
    const noseUp = about(1, 0, 0, -Math.PI / 2)
    const worldY = nauseogenicRate(state({ x: 0, y: 1, z: 0 }, noseUp))
    const worldZ = nauseogenicRate(state({ x: 0, y: 0, z: 1 }, noseUp))
    // W_ROLL = 1, W_YAW = 0.7.
    expect(worldY).toBeCloseTo(1, 6)
    expect(worldZ).toBeCloseTo(0.7, 6)
    // Reading the world components naively — z is roll, y is yaw — would have
    // given 0.7 and 1.0: the same two numbers, swapped. A ship on its side or
    // inverted (which is most of a barrel roll) would then get the vignette for
    // the manoeuvre it is NOT doing.
    const naiveY = 0.7
    const naiveZ = 1
    expect(worldY).not.toBeCloseTo(naiveY, 6)
    expect(worldZ).not.toBeCloseTo(naiveZ, 6)
  })

  it('is zero for a ship that is not turning, however fast it is going', () => {
    // §2.9's actual complaint about the obvious alternative: "a speed-driven
    // vignette is wide open during the worst manoeuvre in the game." The
    // converse is the one a test can see — `VignetteInput` has no velocity in
    // it at all, so 179.6 m/s in a straight line vignettes nothing.
    expect(nauseogenicRate(state({ x: 0, y: 0, z: 0 }))).toBe(0)
  })

  it('does not leak one call-s scratch vector into the next (trap 19)', () => {
    // `nauseogenicRate` rotates through a module-level scratch. It returns a
    // number rather than the vector, so it is safe by construction — this is the
    // test that keeps it that way if someone ever returns the components.
    const a = nauseogenicRate(state({ x: 0, y: 0, z: 1 }))
    nauseogenicRate(state({ x: 5, y: -3, z: 9 }))
    expect(nauseogenicRate(state({ x: 0, y: 0, z: 1 }))).toBe(a)
  })
})

describe('the deadband, so ordinary flying does not dim the periphery', () => {
  it('is fully open below the deadband and fully closed at full stick', () => {
    const full = HOVERJET_FULL_ROLL_RATE
    expect(rateToDemand(0, full)).toBe(0)
    expect(rateToDemand(full * OPEN_FRACTION * 0.99, full)).toBe(0)
    expect(rateToDemand(full, full)).toBe(1)
    expect(rateToDemand(full * 10, full)).toBe(1)
  })

  it('puts the deadband at a DELIBERATE input, not a correction', () => {
    // 0.2 of full stick on the HoverJet is 17.6 deg/s. Named in degrees for the
    // same reason as above: nobody can picture 0.31 rad/s.
    const deadband = (HOVERJET_FULL_ROLL_RATE * OPEN_FRACTION * 180) / Math.PI
    expect(deadband).toBeGreaterThan(10)
    expect(deadband).toBeLessThan(25)
  })

  it('never divides by zero on a degenerate vehicle', () => {
    expect(rateToDemand(5, 0)).toBe(0)
    expect(rateToDemand(5, -1)).toBe(0)
  })
})

describe('the smoothing — fast in, slow out, and frame-rate independent', () => {
  it('opens more slowly than it closes', () => {
    // Asymmetric on purpose. A symmetric filter turns a flick-roll-and-centre
    // into an aperture slamming open and shut inside a third of a second, which
    // is its own motion cue and worse than no vignette.
    expect(RELEASE_TAU).toBeGreaterThan(ATTACK_TAU * 3)
    const closing = smoothLevel(0, 1, 0.1)
    const opening = 1 - smoothLevel(1, 0, 0.1)
    expect(closing).toBeGreaterThan(opening)
  })

  it('reaches the same place at 72 Hz and at 144 Hz', () => {
    // The headset runs at 72 and the desk at 144, and a per-frame lerp would
    // make the vignette twice as fast on the desk — i.e. tuned in a headset and
    // wrong everywhere else, or the reverse. `1 - exp(-dt/tau)` is what makes
    // these agree.
    let slow = 0
    let fast = 0
    for (let i = 0; i < 72; i++) slow = smoothLevel(slow, 1, 1 / 72)
    for (let i = 0; i < 144; i++) fast = smoothLevel(fast, 1, 1 / 144)
    expect(slow).toBeCloseTo(fast, 4)
    // ...and after one second of full demand it is most of the way there.
    expect(slow).toBeGreaterThan(0.99)
  })

  it('hits 63 percent of the way in one time constant, which is what tau MEANS', () => {
    // Guards against the classic off-by-a-reciprocal: `exp(-dt*tau)` instead of
    // `exp(-dt/tau)` is still a smooth curve, still monotone, still passes
    // every "does it go up" assertion, and is 100x too slow.
    let level = 0
    const steps = 200
    for (let i = 0; i < steps; i++) level = smoothLevel(level, 1, ATTACK_TAU / steps)
    expect(level).toBeCloseTo(1 - Math.exp(-1), 3)
  })

  it('ignores a backgrounded tab-s enormous first delta', () => {
    // Without the clamp, one frame after the tab comes back slams the aperture
    // shut on the strength of a delta measured in minutes.
    expect(smoothLevel(0, 1, 600)).toBeLessThan(0.93)
    expect(smoothLevel(0.5, 1, -1)).toBe(0.5)
  })
})

describe('the aperture geometry', () => {
  it('touches no pixel when fully open, corners included', () => {
    // A viewport corner is at UV radius sqrt(0.5) = 0.7071. `R_OPEN` sits
    // outside it so "open" and "off" are the same image — which is what lets
    // the mesh be hidden entirely at rest and cost nothing on a Quest.
    expect(R_OPEN).toBeGreaterThan(Math.SQRT1_2)
    expect(apertureRadius('light', 0)).toBe(R_OPEN)
    expect(apertureRadius('strong', 0)).toBe(R_OPEN)
    expect(apertureRadius('off', 1)).toBe(R_OPEN)
  })

  it('closes further on STRONG than on LIGHT, at every level', () => {
    // The reason there are three settings and not a boolean: "tolerance varies
    // enormously between people" (§2.9).
    for (const l of [0.25, 0.5, 0.75, 1]) {
      expect(apertureRadius('strong', l)).toBeLessThan(apertureRadius('light', l))
    }
    expect(apertureRadius('light', 1)).toBeCloseTo(R_CLOSED_LIGHT, 12)
    expect(apertureRadius('strong', 1)).toBeCloseTo(R_CLOSED_STRONG, 12)
  })

  it('still shows the centre of the view at maximum strength', () => {
    // A tunnel you cannot fly a gate through is a tunnel people switch off. At
    // 0.30 UV the open circle is 60 percent of the viewport-s height.
    expect(R_CLOSED_STRONG).toBeGreaterThan(0.2)
    expect(apertureRadius('light', 1)).toBeGreaterThan(0.4)
  })

  it('is monotone in level, with no overshoot at the ends', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let l = 0; l <= 1.0001; l += 0.05) {
      const r = apertureRadius('strong', l)
      expect(r).toBeLessThanOrEqual(previous + 1e-12)
      previous = r
    }
    expect(apertureRadius('strong', 5)).toBe(apertureRadius('strong', 1))
    expect(apertureRadius('strong', -5)).toBe(apertureRadius('strong', 0))
  })
})

describe('the pass itself', () => {
  it('is a quad whose positions ARE normalised device coordinates', () => {
    // The vertex shader writes `gl_Position = vec4(position.xy, 0, 1)` — no
    // camera matrices at all, which is what makes it fill each XR eye-s own
    // viewport and what makes it immune to near-plane clipping (PORT_PLAN
    // §2.1). That only works if the geometry spans exactly +/-1. A
    // `PlaneGeometry(1, 1)` would render the whole effect at quarter size in
    // the middle of the screen and look like a floating dark square — so the
    // span is asserted rather than the constructor argument.
    const vignette = createVignette()
    const mesh = vignette.object as THREE.Mesh
    const box = new THREE.Box3().setFromBufferAttribute(
      mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
    )
    expect(box.min.x).toBeCloseTo(-1, 12)
    expect(box.max.x).toBeCloseTo(1, 12)
    expect(box.min.y).toBeCloseTo(-1, 12)
    expect(box.max.y).toBeCloseTo(1, 12)
    vignette.dispose()
  })

  it('is never frustum-culled, and draws last', () => {
    // `frustumCulled = false` is a correctness requirement here, not an
    // optimisation: the mesh lives in the scene with a meaningless transform, so
    // a bounding sphere at the origin would cull the whole overlay the moment
    // you flew a kilometre away — and it would come back when you flew home,
    // which is the shape of a bug nobody can reproduce.
    const vignette = createVignette()
    expect(vignette.object.frustumCulled).toBe(false)
    // Above the pause plate (12) and the results panel (11).
    expect(vignette.object.renderOrder).toBeGreaterThan(12)
    const material = (vignette.object as THREE.Mesh).material as THREE.ShaderMaterial
    expect(material.depthTest).toBe(false)
    expect(material.depthWrite).toBe(false)
    expect(material.transparent).toBe(true)
    vignette.dispose()
  })

  it('draws nothing at rest and something during a roll', () => {
    const vignette = createVignette({ setting: 'light' })
    vignette.update(state({ x: 0, y: 0, z: 0 }), 1 / 72)
    expect(vignette.object.visible).toBe(false)

    const rolling = state({ x: 0, y: 0, z: HOVERJET_FULL_ROLL_RATE })
    for (let i = 0; i < 72; i++) vignette.update(rolling, 1 / 72)
    expect(vignette.object.visible).toBe(true)
    expect(vignette.level).toBeGreaterThan(0.9)

    // And it retracts when the roll stops, over the longer time constant.
    for (let i = 0; i < 216; i++) vignette.update(state({ x: 0, y: 0, z: 0 }), 1 / 72)
    expect(vignette.level).toBeLessThan(0.01)
    expect(vignette.object.visible).toBe(false)
    vignette.dispose()
  })

  it('RETRACTS when you turn it off mid-roll rather than snapping', () => {
    // Turning the vignette off while it is closed must not itself be a motion
    // cue — which is what `setting === 'off' -> demand 0` and the release time
    // constant buy, as against forcing the level to zero.
    const vignette = createVignette({ setting: 'strong' })
    const rolling = state({ x: 0, y: 0, z: HOVERJET_FULL_ROLL_RATE })
    for (let i = 0; i < 72; i++) vignette.update(rolling, 1 / 72)
    const closed = vignette.level
    vignette.setSetting('off')
    vignette.update(rolling, 1 / 72)
    expect(vignette.level).toBeLessThan(closed)
    expect(vignette.level).toBeGreaterThan(closed * 0.9)
    vignette.dispose()
  })

  it('carries the screen fade on the same draw call, clamped', () => {
    // PORT_PLAN §2.1 caught a real bug in revision 1: the screen fade specified
    // as a head-locked quad at z = 0.11 against a 0.1 near plane, "1 cm of
    // margin, in stereo, with per-eye off-axis projection". Its second fix was
    // "implement the fade as a full-screen material pass rather than a
    // head-locked quad" — which is this pass, and it has no z to clip at.
    const vignette = createVignette({ setting: 'off' })
    vignette.setFade(0.5)
    expect(vignette.object.visible).toBe(true)
    vignette.setFade(0)
    expect(vignette.object.visible).toBe(false)
    const material = (vignette.object as THREE.Mesh).material as THREE.ShaderMaterial
    vignette.setFade(9)
    expect(material.uniforms.uFade?.value).toBe(1)
    vignette.setFade(-9)
    expect(material.uniforms.uFade?.value).toBe(0)
    vignette.dispose()
  })

  it('RELEASES on a null input, which is what makes the pause menu readable', () => {
    // Pausing freezes the sim, so `angularVelocity` keeps whatever it had. A run
    // paused mid-roll would leave the comfort menu — the one you opened because
    // the roll made you queasy — being read down a closed tunnel. `app.ts`
    // already zeroes the stick on the same frames; this is the same gesture,
    // and it is the whole reason `update` takes a nullable.
    const vignette = createVignette({ setting: 'strong' })
    const rolling = state({ x: 0, y: 0, z: HOVERJET_FULL_ROLL_RATE })
    for (let i = 0; i < 72; i++) vignette.update(rolling, 1 / 72)
    expect(vignette.level).toBeGreaterThan(0.9)
    for (let i = 0; i < 216; i++) vignette.update(null, 1 / 72)
    expect(vignette.level).toBeLessThan(0.01)
    expect(vignette.object.visible).toBe(false)
    vignette.dispose()
  })

  it('can be recalibrated for a second vehicle', () => {
    // `loadFlight` dispatches on `level.vehicle`; the vignette has to follow.
    const vignette = createVignette({ setting: 'light', fullRate: JUMPSEAT_FULL_ROLL_RATE })
    const seatFullStick = state({ x: 0, y: 0, z: JUMPSEAT_FULL_ROLL_RATE })
    for (let i = 0; i < 72; i++) vignette.update(seatFullStick, 1 / 72)
    expect(vignette.level).toBeGreaterThan(0.9)
    vignette.dispose()
  })
})

// ── DEV-383: a vertical launch is a vection spike the angular rate cannot see ──
//
// AIRCRAFT-VARIANTS §4.5 item 3. The jumping spider leaves a pad at up to
// 200 m/s inside 0.12 s, straight up, with zero angular rate, so the vignette
// above reads nothing at all. The linear term reads the body's vertical
// velocity change over the last FIXED step (`Flight.verticalAcceleration`), and
// the larger of the two terms closes the aperture.
//
// Proved red against today's angular-only vignette: `update` taking
// `rateToDemand` alone, the spider's launch leaves the aperture open.

describe('the linear term: a vertical launch closes it (DEV-383)', () => {
  it('is nothing below LINEAR_OPEN, everything from LINEAR_FULL, and either sign', () => {
    expect(linearToDemand(0)).toBe(0)
    expect(linearToDemand(LINEAR_OPEN)).toBe(0)
    expect(linearToDemand(LINEAR_FULL)).toBe(1)
    expect(linearToDemand(-LINEAR_FULL * 2)).toBe(1)
    expect(linearToDemand((LINEAR_OPEN + LINEAR_FULL) / 2)).toBeCloseTo(0.5, 12)
    // A seat in free fall accelerates at |g|: that is not a launch.
    expect(linearToDemand(32)).toBe(0)
  })

  const seatWithJump = () => {
    const seat = jumpSeatFor(resolveVariant('jumpseat', 'spider', ANNIVERSARY_EDITION))
    seat.live = true
    seat.legs = null
    return seat
  }

  // NOT READY TO SHIP (Matt, 2026-09-25, DEV-403): the spider is `listed: false`,
  // and its tests skip on `SPIDER_READY` until it is ready (`variant-listed.test.ts`).
  it.skipIf(!SPIDER_READY)(
    "closes on the spider's jump, with the angular rate zero throughout",
    () => {
      const seat = seatWithJump()
      // Stand it on its own cushion over a flat floor, charge, release.
      const floor = buildHeightField(
        {
          width: 256,
          height: 256,
          sample(_u: number, _v: number, out: { r: number; g: number; b: number }) {
            out.r = 0.5
            out.g = 0.5
            out.b = 0.5
            return out
          },
        } as unknown as Parameters<typeof buildHeightField>[0],
        {
          terrainSize: 1024,
          terrainHeight: 100,
          baseResolution: 8,
          chunkSize: 256,
          randomOffset: 0,
          seed: 1,
        } as unknown as Parameters<typeof buildHeightField>[1],
        { position: [0, 0, 0], scale: [1, 1, 1] },
      )
      seat.body.position.x = 500
      seat.body.position.y = 51
      seat.body.position.z = 500
      for (let i = 0; i < 400; i++) stepJumpSeat(seat, noJumpSeatInput(), [floor], FIXED_DT)
      const vignette = createVignette({ setting: 'light' })
      const still = v3()
      let peak = 0
      let peakAngular = 0
      const fly = (throttle: number, boost: number, n: number): void => {
        for (let i = 0; i < n; i++) {
          const before = seat.body.velocity.y
          stepJumpSeat(seat, { ...noJumpSeatInput(), throttle, boost }, [floor], FIXED_DT)
          const input: VignetteInput = {
            angularVelocity: still,
            orientation: seat.body.orientation,
            verticalAcceleration: (seat.body.velocity.y - before) / FIXED_DT,
          }
          peakAngular = Math.max(peakAngular, nauseogenicRate(input))
          vignette.update(input, FIXED_DT)
          peak = Math.max(peak, vignette.level)
        }
      }
      fly(1, 1, Math.round(1 / FIXED_DT))
      expect(peak, 'charging on the cushion does not close it').toBeLessThan(0.05)
      fly(1, 0, Math.round(1 / FIXED_DT))
      expect(seat.jump?.jumps).toBe(1)
      expect(peakAngular).toBe(0)
      expect(peak, 'the launch closes it').toBeGreaterThan(0.5)
      vignette.dispose()
    },
  )

  it("does not move for 2016's seat climbing, boosting and falling in free air", () => {
    const seat = createJumpSeat()
    seat.live = true
    seat.legs = null
    seat.body.position.y = 10_000
    let worst = 0
    const fly = (throttle: number, boost: number, seconds: number): void => {
      for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
        const before = seat.body.velocity.y
        stepJumpSeat(seat, { ...noJumpSeatInput(), throttle, boost }, [], FIXED_DT)
        worst = Math.max(worst, linearToDemand((seat.body.velocity.y - before) / FIXED_DT))
      }
    }
    fly(1, 0, 3)
    fly(1, 1, 3)
    fly(0, 0, 3)
    fly(1, 1, 3)
    expect(worst).toBe(0)
  })
})
