// src/render/gate-pulse.ts — S6, the gate pass as an EVENT.
//
// ── What this is ──────────────────────────────────────────────────────────
//
// A schedule, not a surface, exactly like `fade.ts`. It produces two numbers
// per render frame — a 0..1 level and a phase angle — and `boot/app.ts` hands
// them to `vignette.setPulse`, which owns the only full-screen quad in the
// game. It draws nothing, holds no GPU resource and keeps no clock of its own:
// it is fed `dtSeconds` and it is tested in node
// (`tests/unit/gate-pulse.test.ts`). The one thing it reaches for outside
// itself is `srgbToLinear`, a scalar, because a second copy of a colour
// transform is a bug with a six-month fuse.
//
// ── What the proposal asks for, and what R7 allows ────────────────────────
//
// ANNIVERSARY.md §2.5 S6, in full: *"The ring burst exists; add the whoosh
// (S4), a one-frame brightening of the frame, and a 0.2 s peripheral streak
// pulse. Research 05 §R7 allows peripheral-only effects on boost."*
//
// The whoosh landed with S4 (DEV-084) and fires from the same call site. This
// is the other half, and the two halves of S6 — the brightening and the streak
// pulse — are ONE dial rather than two features: `innerRadius` is the UV radius
// at which the band begins, so 0 is a flash over the whole frame and the
// shipped value keeps it at the edge. R7 is why it ships at the edge:
//
//   *"chromatic/vignette pulses at the periphery only"* — 05 §R7, which is the
//   section that also says never to write `camera.fov` while presenting.
//
// **The band starts no further in than the STRONG vignette closes to.**
// `innerRadius` is pinned at or outside `R_CLOSED_STRONG` — 0.3, the aperture
// the comfort layer's strongest setting shuts to, blacking out everything
// beyond it — so by construction this can only ever brighten a pixel the
// comfort system already treats as peripheral. That is a RELATIONSHIP rather than a number, which is
// what trap 24 asks for, and `gate-pulse.test.ts` asserts it against the
// shipped JSON rather than restating 0.3.
//
// ── Why it rides on the vignette's quad ───────────────────────────────────
//
// Three properties, all of which a second surface would have to re-earn:
//
//  1. **Per-eye correct for free.** The vertex shader writes clip space
//     directly, so each XR sub-camera's viewport gets its own centred copy and
//     there is no z to clip against the 0.08 near plane. PORT_PLAN §2.1 caught
//     a real bug in the head-locked alternative.
//  2. **Outside the bloom and outside ACES.** `vignette.ts`'s material is
//     `toneMapped: false`, which is the predicate `bloom.ts`'s `isUiObject`
//     classifies on, so the quad draws in the UI pass straight to the canvas.
//     A bright overlay inside the composer would be bloomed — a halo crawling
//     off a comfort effect — and would take ACES on the flat build and not in
//     the headset, so the same number would mean two brightnesses.
//  3. **Black wins.** The compositing in the fragment shader puts the pulse
//     UNDER the vignette and the fade: a run being blacked out for a death
//     cannot be lit up by the gate you took on the way into the water.
//
// ── DEV-027: say what each number is the ... OF ───────────────────────────
//
// `level` is a 0..1 fraction of `strength`, which is itself an OVERLAY ALPHA at
// the outermost pixel — not a luminance and not a gain. `seconds` is wall-clock
// and is fed frame deltas, never the fixed step (D4: nothing here is sim).
// `gainBySpeed` is keyed on **forward speed in m/s**, the same quantity
// `audio/speed-curves.ts` keys the whoosh on and the same one
// `Ship_HoverShip.ForwardSpeed` gates 2016's particles on — deliberately the
// same x, because the ear and the eye are being given one event.

import { sampleCurve } from '@/audio/speed-curves'
import type { EditionGatePulse } from '@/content/edition-schema'
import { PROPS } from '@/generated/constants.generated'
import { srgbToLinear } from '@/render/unity-space'

/**
 * The pulse's colour, LINEAR rgb: the gate's own glow, brought `tint` of the
 * way toward white.
 *
 * **The colour is extracted, not tuned.** `props.checkpointRing.frameGlowColor`
 * is (0.537, 1, 0.559, 0.378) on the sheet — 2016's colour for the glow of the
 * thing you just flew through — and DEV-069's lesson is that a generated
 * constant nobody reads is documentation rather than a guard. The alpha is
 * dropped: it is the material's own opacity on a mesh in the world, and this is
 * an overlay whose alpha is the pulse level.
 *
 * Toward white rather than toward the frame, because at the periphery a
 * saturated hue over an already warm sunset reads as a fault in the display.
 * `tint` 0 is the gate's colour exactly and 1 is plain white.
 */
export const pulseColorLinear = (tint: number): readonly [number, number, number] => {
  const t = tint < 0 ? 0 : tint > 1 ? 1 : tint
  const glow = PROPS.checkpointRing.frameGlowColor
  return [0, 1, 2].map((i) => {
    const c = srgbToLinear(glow[i] as number)
    return c + (1 - c) * t
  }) as unknown as readonly [number, number, number]
}

/**
 * The decay, as a fraction of the peak. `u` is elapsed / `seconds`.
 *
 * Instant attack — the peak IS the frame the gate was crossed, which is the
 * "one-frame brightening" half of S6 — then `(1 - u) ^ shape` down to nothing.
 * `shape` above 1 spends most of the window already dim, which reads as a flash
 * with a tail; 1 is a linear fade, which is what the preset ships and what
 * DEV-108 §3's photograph argues for — the gate that fires the pulse fills the
 * periphery for the first ~0.09 s of it, so light spent early is light spent
 * behind the thing that spent it.
 *
 * Total rather than guarded: `u` outside 0..1 answers 0, so a caller that
 * over-runs the window by a long frame gets darkness, not a negative base
 * raised to a fractional power.
 */
export const pulseEnvelope = (u: number, shape: number): number => {
  if (!(u > 0)) return u === 0 ? 1 : 0
  if (u >= 1) return 0
  return (1 - u) ** shape
}

/** Peak overlay alpha for one pass: `strength` × the speed curve × the slider. */
export const pulsePeak = (block: EditionGatePulse, speed: number, speedFx: number): number => {
  if (!block.enabled) return 0
  const gain = sampleCurve(block.gainBySpeed, speed)
  const peak = block.strength * gain * speedFx
  return peak > 0 ? (peak > 1 ? 1 : peak) : 0
}

/**
 * How far the wedge pattern turns between consecutive gates, in radians.
 *
 * The golden angle, which is an irrational fraction of a turn, so the sequence
 * never repeats and the driver needs neither a seed nor a PRNG.
 *
 * **What that buys is a CONSECUTIVE difference, and the claim is scoped to
 * that on purpose.** The picture repeats every wedge, not every turn, so the
 * separation that matters is the step taken modulo `2π / streaks`. At the
 * shipped fourteen wedges, measured: gates one apart land **0.348 of a wedge**
 * from each other and gates two apart 0.305 — both near the 0.5 maximum — while
 * gates **three** apart land 0.043 apart, which is the same picture. So two
 * gates in a row never stamp the same wedges, and two gates 1.6 km and nine
 * seconds of flying apart sometimes do.
 *
 * That is the honest statement and the first version of this comment did not
 * make it: it said "no two gates on a 21-gate course", which the golden angle
 * cannot deliver against a wedge modulus and which twenty-one points inside one
 * wedge cannot satisfy at any step by the pigeonhole principle. The test is
 * what found it, because it asserted the sentence rather than the code.
 */
export const PHASE_STEP = Math.PI * (3 - Math.sqrt(5))

/** What `boot/app.ts` holds and what `vignette.setPulse` is fed from. */
export interface GatePulse {
  /** 0..1 overlay alpha at the outermost pixel. 0 means "draw nothing". */
  readonly level: number
  /** Radians. Turns by `PHASE_STEP` per pass so consecutive gates differ. */
  readonly phase: number
  /**
   * A ring was crossed at `speed` m/s.
   *
   * **MAX against what is already on screen, never a sum.** `int_01`'s rings
   * are ~540 m apart, which is over 3 s at the boosted terminal — but that is a
   * property of one course, and a sum is a rule that fails on the first course
   * that puts two rings close. The one thing a comfort-adjacent overlay must
   * not do is get brighter the more of the game you play well.
   *
   * `scale` multiplies the peak (DEV-638: a CLEAN gate is stronger than a plain
   * one). It is applied BEFORE the clamp to 1, so no scale can make an overlay
   * brighter than the full pulse; absent is 1, which is every caller before it.
   */
  fire(block: EditionGatePulse, speed: number, speedFx: number, scale?: number): void
  /** Advance one RENDER frame. */
  update(dtSeconds: number): void
  /** Back to nothing. A restart, a mission end, a preset flip. */
  reset(): void
}

export const createGatePulse = (): GatePulse => {
  let peak = 0
  let elapsed = 0
  let seconds = 0
  let shape = 1
  let phase = 0

  return {
    get level() {
      if (!(peak > 0) || !(seconds > 0)) return 0
      return peak * pulseEnvelope(elapsed / seconds, shape)
    },
    get phase() {
      return phase
    },
    fire(block, speed, speedFx, scale = 1) {
      const raw = pulsePeak(block, speed, speedFx) * (scale > 0 ? scale : 1)
      const next = raw > 1 ? 1 : raw
      if (!(next > 0) || !(block.seconds > 0)) return
      // The live level, read BEFORE the window is replaced — otherwise the max
      // below compares the new peak against the old one's peak rather than
      // against what is actually on screen, and a late, dim gate would relight
      // a pulse that had already decayed away.
      const live = peak > 0 && seconds > 0 ? peak * pulseEnvelope(elapsed / seconds, shape) : 0
      peak = next > live ? next : live
      elapsed = 0
      seconds = block.seconds
      shape = block.decayShape
      phase = (phase + PHASE_STEP) % (Math.PI * 2)
    },
    update(dtSeconds) {
      if (!(peak > 0)) return
      // A backgrounded tab hands back a delta of seconds; the clamp is the same
      // gesture `vignette.smoothLevel` makes, for the same reason.
      const step = dtSeconds < 0 ? 0 : dtSeconds > 0.25 ? 0.25 : dtSeconds
      elapsed += step
      if (elapsed >= seconds) peak = 0
    },
    reset() {
      peak = 0
      elapsed = 0
    },
  }
}
