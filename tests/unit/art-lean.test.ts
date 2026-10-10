// tests/unit/art-lean.test.ts — the cockpit lean, bugs included.

import { describe, expect, it } from 'vitest'
import { HOVERJET, JUMPSEAT } from '@/generated/constants.generated'
import { type ArtLeanTuning, createArtLean, evaluateCurve, stepArtLean } from '@/sim/art-lean'
import { FIXED_DT } from '@/sim/constants'

const rotator = HOVERJET.artRotator

const tuning: ArtLeanTuning = {
  rollMax: rotator.rollMax,
  pitchMax: rotator.pitchMax,
  speed: rotator.speed,
  inputTime: rotator.inputTime,
  resetTime: rotator.resetTime,
  inputCurve: rotator.inputCurve,
  transitionCurve: rotator.transitionCurve,
  resetPitch: rotator.shipInput.ref !== null,
}

const hold = (roll: number, pitch: number, seconds: number) => {
  const lean = createArtLean(tuning)
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) stepArtLean(lean, roll, pitch, FIXED_DT)
  return lean
}

describe('the tuning comes from the sheet', () => {
  it('is the shipped Rotator_Input on art_pivot', () => {
    expect(rotator.gameObject).toBe('art_pivot')
    expect(rotator.componentEnabled).toBe(true)
    expect(tuning.rollMax).toBeCloseTo(5.25, 5)
    expect(tuning.pitchMax).toBeCloseTo(4.8, 5)
  })
})

describe('curve evaluation', () => {
  it('clamps outside the key range', () => {
    expect(evaluateCurve(tuning.inputCurve, -1)).toBeCloseTo(0, 6)
    expect(evaluateCurve(tuning.inputCurve, 99)).toBeCloseTo(1, 6)
  })

  it('eases rather than running straight', () => {
    // The whole reason the curve is reproduced instead of lerped: a straight
    // line through the same endpoints would read 0.5 at the midpoint.
    const mid = evaluateCurve(tuning.inputCurve, 0.5)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(Math.abs(mid - 0.5)).toBeGreaterThan(0.02)
  })

  it('decays the transition curve from 1 to 0', () => {
    expect(evaluateCurve(tuning.transitionCurve, 0)).toBeCloseTo(1, 2)
    expect(evaluateCurve(tuning.transitionCurve, 1)).toBeCloseTo(0, 2)
    expect(evaluateCurve(tuning.transitionCurve, 0.58)).toBeLessThan(0.3)
  })
})

describe('leaning', () => {
  it('banks INTO a roll, and the sign is negated like the original', () => {
    // `goalRoll = ... * -rollValue`. Stick right, art rolls left in Unity's
    // z-euler, which is what banks it into the turn.
    const right = hold(1, 0, 0.6)
    expect(right.roll).toBeLessThan(0)
    const left = hold(-1, 0, 0.6)
    expect(left.roll).toBeGreaterThan(0)
  })

  it('reaches full deflection after inputTime, and no further', () => {
    const lean = hold(1, 0, 1.5)
    // Not exact: the timer advances in whole 0.0122 s steps and stops on the
    // step that crosses `inputTime`, so it lands a hair short of the maximum.
    expect(Math.abs(lean.roll)).toBeCloseTo(tuning.rollMax, 1)
    expect(Math.abs(lean.roll)).toBeLessThanOrEqual(tuning.rollMax)
    // The lean is SMALL. If this ever reads tens of degrees the pivot has been
    // confused with the ship itself.
    expect(Math.abs(lean.currentRoll)).toBeLessThan(6)
  })

  it('pitches with the stick, unnegated', () => {
    expect(hold(0, 1, 0.6).pitch).toBeGreaterThan(0)
    expect(hold(0, -1, 0.6).pitch).toBeLessThan(0)
  })

  it('settles toward the goal rather than snapping to it', () => {
    const lean = createArtLean(tuning)
    stepArtLean(lean, 1, 0, FIXED_DT)
    // One step in, the goal has moved but the rendered pose has barely.
    expect(Math.abs(lean.currentRoll)).toBeLessThan(Math.abs(lean.roll) + 1e-9)
  })
})

describe('the three bugs, reproduced on purpose', () => {
  it('resets pitch to a constant, because the timer cancels itself out', () => {
    // `inputCurve.Evaluate(resetTimerPitch * 0.5f / resetTimerPitch)` is
    // `inputCurve(0.5)` at every timer value. Releasing pitch from ANY
    // deflection lands on the same number.
    const expected = evaluateCurve(tuning.inputCurve, 0.5)

    for (const held of [0.2, 1]) {
      const lean = createArtLean(tuning)
      for (let i = 0; i < 40; i++) stepArtLean(lean, 0, held, FIXED_DT)
      stepArtLean(lean, 0, 0, FIXED_DT)
      expect(lean.pitch).toBeCloseTo(expected, 6)
    }
  })

  it('resets roll from ~1 degree, not from the angle actually held', () => {
    // The reset assigns `transitionCurve(t)` with no `* rollMax`, so a 5.25
    // degree bank returns from about 1.
    const lean = createArtLean(tuning)
    for (let i = 0; i < 60; i++) stepArtLean(lean, 1, 0, FIXED_DT)
    expect(Math.abs(lean.roll)).toBeCloseTo(tuning.rollMax, 1)
    stepArtLean(lean, 0, 0, FIXED_DT)
    expect(lean.roll).toBeCloseTo(1, 0)
    expect(lean.roll).toBeLessThan(tuning.rollMax)
  })

  it('freezes rather than settling when both goals are exactly zero', () => {
    const lean = createArtLean(tuning)
    lean.currentRoll = 3
    lean.currentPitch = 2
    lean.roll = 0
    lean.pitch = 0
    // `if (goalRotation != Vector3.zero)` — no lerp, so nothing moves.
    stepArtLean(lean, 0, 0, 0)
    expect(lean.currentRoll).toBe(3)
    expect(lean.currentPitch).toBe(2)
  })
})

describe('DEV-011: fixed step instead of frame time', () => {
  it('gives the same lean at any frame rate', () => {
    // 2016 ran this in Update() on Time.deltaTime, so the lean depended on the
    // machine. Here the step is fixed, so two runs of the same duration agree —
    // which is what lets a ghost replay it exactly.
    const a = hold(1, 0, 0.9)
    const b = hold(1, 0, 0.9)
    expect(a.currentRoll).toBeCloseTo(b.currentRoll, 12)
    expect(a.roll).toBeCloseTo(b.roll, 12)
  })
})

describe("the pitch reset is the HoverJet's alone", () => {
  // ── What this is, and why it is not a bug in the port ────────────────────
  //
  // `Rotator_Input.SlowRotatePitch()` is written asymmetrically. The INPUT half
  // handles both input sources — `shipInput` at `Rotator_Input.cs:141` and
  // `inputManager` at `:151`, two sibling `if`s. The RESET half handles only
  // one: the entire `pitchValue == 0` block at `:164`, INCLUDING a duplicate of
  // itself nested inside `if (inputManager != null)`, sits under a single
  // `if (shipInput != null)`.
  //
  // `SlowRotateRoll()` is not written that way. It duplicates the whole thing,
  // reset included, under each source (`:82` and `:108`). So the asymmetry is
  // in one method, on one axis, and it is what shipped.
  //
  // Which vehicle gets which is a fact the sheet carries, so nothing here is
  // typed by hand:
  //
  //     HOVERJET.artRotator.shipInput.ref   PlayerShip_SR14_Photon.Input_Ship
  //     JUMPSEAT.artRotator.shipInput.ref   null
  //
  // and `Start():50-53` cannot fill the JumpSeat's in — it resolves only from a
  // `ShipLogic`-tagged object's `Input_Ship`, and `jumpseat.hasInputShip` is
  // false.

  it('reads which vehicle resets from the sheet, not from a literal', () => {
    expect(HOVERJET.artRotator.shipInput.ref).not.toBeNull()
    expect(JUMPSEAT.artRotator.shipInput.ref).toBeNull()
    expect(JUMPSEAT.hasInputShip).toBe(false)
  })

  it('returns the HoverJet art to level, and leaves the JumpSeat leaning', () => {
    // Pitch held for half a second, then released. The assertion is the ANGLE,
    // which is true independently of which branch ran.
    const run = (resetPitch: boolean) => {
      const lean = createArtLean({ ...tuning, resetPitch })
      const hold = Math.round(0.5 / FIXED_DT)
      for (let i = 0; i < hold; i++) stepArtLean(lean, 0, 1, FIXED_DT)
      // The GOAL at release, not the pose — `currentPitch` lags it by the
      // 2.5/s settle lerp, so the pose is still climbing toward it when the
      // stick comes back. That lag is why this test asserts the goal.
      const goalAtRelease = lean.pitch
      // Five seconds, not two: the settle lerp is 2.5/s, so after two the pose
      // is still 0.013 deg short of its goal and "settled" would be a claim
      // about the lerp rate rather than about the reset. The HoverJet is still
      // sweeping at five — `resetTimerPitch += dt * 0.25` takes SIX seconds of
      // real time to cover a `resetTime` of 1.5 — which is fine, because its
      // sweep value is the same constant throughout (bug 1).
      const release = Math.round(5 / FIXED_DT)
      for (let i = 0; i < release; i++) stepArtLean(lean, 0, 0, FIXED_DT)
      return { goalAtRelease, goalAfter: lean.pitch, poseAfter: lean.currentPitch }
    }
    const hoverjet = run(true)
    const jumpseat = run(false)
    // Both lean the same on the way in — the input half is shared.
    expect(jumpseat.goalAtRelease).toBeCloseTo(hoverjet.goalAtRelease, 12)
    expect(hoverjet.goalAtRelease).toBeGreaterThan(1)
    // The JumpSeat's goal is FROZEN: nothing writes it after release, so it is
    // still the goal the last input tick set, and the pose has settled onto it.
    expect(jumpseat.goalAfter).toBe(jumpseat.goalAtRelease)
    expect(jumpseat.poseAfter).toBeCloseTo(jumpseat.goalAfter, 4)
    // The HoverJet's goal moved to the reset sweep's value, which is
    // `inputCurve.Evaluate(0.5)` — bug 1, the timer that cancels itself out.
    expect(hoverjet.goalAfter).not.toBe(hoverjet.goalAtRelease)
    expect(hoverjet.goalAfter).toBeCloseTo(evaluateCurve(tuning.inputCurve, 0.5), 12)
  })

  it('leaves ROLL alone on both, because SlowRotateRoll is symmetric', () => {
    const run = (resetPitch: boolean) => {
      const lean = createArtLean({ ...tuning, resetPitch })
      const hold = Math.round(0.5 / FIXED_DT)
      for (let i = 0; i < hold; i++) stepArtLean(lean, 1, 0, FIXED_DT)
      const release = Math.round(2 / FIXED_DT)
      for (let i = 0; i < release; i++) stepArtLean(lean, 0, 0, FIXED_DT)
      return lean.currentRoll
    }
    expect(run(false)).toBeCloseTo(run(true), 10)
  })
})
