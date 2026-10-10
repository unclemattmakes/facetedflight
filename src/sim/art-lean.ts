// src/sim/art-lean.ts — `Rotator_Input`, the thing that loosens the cockpit.
//
// The HoverJet's art hangs off an `art_pivot` node that the camera does NOT
// inherit, and this leans that pivot into the pilot's input. Up to 5.25 degrees
// of roll and 4.8 of pitch — small, and the whole difference between a cockpit
// bolted to your face and a machine you are sitting in. Matt, remembering it:
// "we could not only manoeuvre the entity, but also slightly rotate the ship to
// loosen the cockpit a bit."
//
// It is also, incidentally, a comfort mechanism. Rotating the WORLD around a
// player's head is what makes people ill in VR; rotating the vehicle around a
// stationary head is the opposite of that (DEV-010, PORT_PLAN §2.9).
//
// ── Faithful, including three bugs ────────────────────────────────────────
//
// `Rotator_Input.cs` is 210 lines with real defects in it, and they are in the
// feel, so they are reproduced rather than fixed:
//
//  1. **The pitch reset is a constant.** On release the original computes
//     `inputCurve.Evaluate(resetTimerPitch * 0.5f / resetTimerPitch)` — the
//     timer cancels, so it is always `inputCurve(0.5)`. It was meant to sweep.
//  2. **The roll reset is unscaled.** It assigns `transitionCurve(t)` straight
//     to `goalRoll` without multiplying by `rollMax`, so the art returns from a
//     fixed ~1 degree rather than from wherever it actually was.
//  3. **The lerp is skipped at exactly zero.** `if (goalRotation != Vector3
//     .zero)` means the art freezes at its last pose when both goals reach 0,
//     instead of settling.
//
// Confirmed dead and NOT implemented: `yawMax`, `goalTime`, `goalYaw`,
// `resetTimePitch`. `goalRotation` hard-codes yaw to 0 and the reset loop tests
// `resetTime`, so all four are serialised, tuned, and read by nothing. The
// extractor's own dead-field pass flags the same four independently.
//
// ── One deliberate improvement ────────────────────────────────────────────
//
// 2016 runs this in `Update()` on `Time.deltaTime`, so the lean is frame-rate
// dependent — a 30 fps machine leans at a different rate from a 120 fps one.
// Here it runs on the fixed step like everything else, which makes it identical
// on every machine and lets a ghost replay it exactly. DEV-011.
//
// SIM LAYER: no three, no DOM, no clock, no randomness.

/** One Unity `AnimationCurve` keyframe. */
export interface CurveKey {
  readonly time: number
  readonly value: number
  readonly inSlope: number
  readonly outSlope: number
}

export interface Curve {
  readonly keys: readonly CurveKey[]
}

/**
 * Evaluate a Unity `AnimationCurve`: cubic Hermite between keys, using each
 * key's tangents, clamped to the end values outside the range.
 *
 * Written out rather than approximated with a lerp because the curve IS the
 * feel — `inputCurve` is what makes the lean ease in instead of snapping, and a
 * straight line through the same endpoints gives a lean of the right size with
 * the wrong character.
 */
export const evaluateCurve = (curve: Curve, time: number): number => {
  const keys = curve.keys
  if (keys.length === 0) return 0
  const first = keys[0] as CurveKey
  const last = keys[keys.length - 1] as CurveKey
  if (time <= first.time) return first.value
  if (time >= last.time) return last.value

  let i = 0
  while (i < keys.length - 2 && (keys[i + 1] as CurveKey).time < time) i++
  const a = keys[i] as CurveKey
  const b = keys[i + 1] as CurveKey

  const dt = b.time - a.time
  if (dt <= 0) return a.value
  const t = (time - a.time) / dt
  const t2 = t * t
  const t3 = t2 * t

  // Hermite basis.
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2

  return h00 * a.value + h10 * dt * a.outSlope + h01 * b.value + h11 * dt * b.inSlope
}

export interface ArtLeanTuning {
  /** Degrees. 5.25 on both shipped vehicles. */
  readonly rollMax: number
  /** Degrees. 4.8. */
  readonly pitchMax: number
  /** Lerp rate toward the goal, per second. 2.5. */
  readonly speed: number
  /** Seconds to reach full lean while an axis is held. 0.5. */
  readonly inputTime: number
  /** Seconds the release sweep runs for. 1.5. */
  readonly resetTime: number
  readonly inputCurve: Curve
  readonly transitionCurve: Curve
  /**
   * Does the art pitch RETURN to level when the stick is released?
   *
   * On the HoverJet, yes. On the JumpSeat, no — and that is shipped behaviour
   * rather than a port bug.
   *
   * `Rotator_Input.SlowRotatePitch()` has two halves. The INPUT half runs under
   * either source: it tests `shipInput` and `inputManager` in two sibling `if`s
   * (`Rotator_Input.cs:141` and `:151`). The RESET half does not — the whole
   * `pitchValue == 0` block, including a duplicate of itself nested inside
   * `if (inputManager != null)`, sits inside one `if (shipInput != null)` at
   * `:164`. So a vehicle with no `Input_Ship` leans on pitch and then holds that
   * lean until the next pitch input.
   *
   * Which vehicle is which is a fact the sheet already carries, so this is
   * DERIVED, never typed:
   *
   *     HOVERJET.artRotator.shipInput.ref   PlayerShip_SR14_Photon.Input_Ship
   *     JUMPSEAT.artRotator.shipInput.ref   null
   *
   * and `Start()` cannot fill the JumpSeat's in: `:50-53` only resolves it from
   * a `ShipLogic`-tagged object's `Input_Ship`, and `jumpseat.hasInputShip` is
   * false.
   *
   * The ROLL reset is unaffected — `SlowRotateRoll()` duplicates the whole
   * thing, reset included, under each source (`:82` and `:108`). Pitch is the
   * one that was only written once.
   */
  readonly resetPitch: boolean
}

export interface ArtLean {
  readonly tuning: ArtLeanTuning
  /** Degrees, UNITY convention: pitch about x, roll about z, yaw always 0. */
  pitch: number
  roll: number
  /** The smoothed pose the renderer uses, in degrees. */
  currentPitch: number
  currentRoll: number
  timer: number
  resetTimer: number
  timerPitch: number
  resetTimerPitch: number
}

export const createArtLean = (tuning: ArtLeanTuning): ArtLean => ({
  tuning,
  pitch: 0,
  roll: 0,
  currentPitch: 0,
  currentRoll: 0,
  timer: 0,
  resetTimer: 0,
  timerPitch: 0,
  resetTimerPitch: 0,
})

/**
 * Advance one FIXED step.
 *
 * `roll` and `pitch` are the pilot's raw axes, -1..1 — the same values the
 * flight model gets. Note the roll SIGN: the original negates it
 * (`* -shipInput.rollValue`), so the art banks INTO the turn.
 */
export const stepArtLean = (lean: ArtLean, roll: number, pitch: number, dt: number): void => {
  const t = lean.tuning

  // ── roll ────────────────────────────────────────────────────────────────
  if (lean.timer < t.inputTime && roll !== 0) {
    lean.resetTimer = 0
    lean.roll = evaluateCurve(t.inputCurve, lean.timer / t.inputTime) * t.rollMax * -roll
    lean.timer += dt
  }
  if (roll === 0) {
    lean.timer = 0
    if (lean.resetTimer < t.resetTime) {
      // Bug 2: not multiplied by rollMax. Returns from ~1 degree, not from the
      // angle actually held.
      lean.roll = evaluateCurve(t.transitionCurve, lean.resetTimer / t.resetTime)
      lean.resetTimer += dt
    }
  }

  // ── pitch ───────────────────────────────────────────────────────────────
  if (lean.timerPitch < t.inputTime && pitch !== 0) {
    lean.resetTimerPitch = 0
    lean.pitch = evaluateCurve(t.inputCurve, lean.timerPitch / t.inputTime) * t.pitchMax * pitch
    lean.timerPitch += dt
  }
  if (pitch === 0) {
    lean.timerPitch = 0.01
    // `resetPitch` is false on the JumpSeat and the whole block below is what
    // 2016 skips for it. Not an optimisation: leaving it out is the port.
    if (t.resetPitch && lean.resetTimerPitch < t.resetTime) {
      if (lean.resetTimerPitch === 0) lean.resetTimerPitch = 0.01
      // Bug 1: `resetTimerPitch * 0.5 / resetTimerPitch` is 0.5, always. The
      // timer cancels itself out. Kept, because it is what shipped.
      lean.pitch = evaluateCurve(t.inputCurve, 0.5)
      lean.resetTimerPitch += dt * 0.25
    }
  }

  // ── settle ──────────────────────────────────────────────────────────────
  // Bug 3: the original skips this entirely when both goals are exactly zero,
  // freezing the art at its last pose rather than letting it settle.
  if (lean.pitch !== 0 || lean.roll !== 0) {
    const k = Math.min(1, dt * t.speed)
    lean.currentPitch += (lean.pitch - lean.currentPitch) * k
    lean.currentRoll += (lean.roll - lean.currentRoll) * k
  }
}
