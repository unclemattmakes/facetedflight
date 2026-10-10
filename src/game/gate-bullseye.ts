// src/game/gate-bullseye.ts — where to aim, drawn at the size the rule uses.
// DEV-153.
//
// ── What Matt asked for ───────────────────────────────────────────────────
//
// 2026-09-16, having flown G1/G2: *"love the new gate scoring and feedback.
// makes me [want] 'bullseye target' art inside the gates to show players where
// to aim."*
//
// ── 2016 had nothing there, so this is ANNIVERSARY ONLY ───────────────────
//
// `Checkpoint_Ring.prefab` is 34 GameObjects and 19 MeshRenderers, and every
// one of the 19 is on the RIM: `jumpGate_diamond` plus 18 built-in cubes under
// `highlightCubes`, all at |x| 9.1–9.6 or |y| 14.3–15.5 in prefab space. No
// plane, no disc, no sprite, no decal. The only object at (0, 0, 0) is
// `ringIdle`, a ParticleSystem whose `EmissionModule.enabled` is 0 with
// `maxNumParticles: 1`. `TriggerCheckpoint`'s own `checkpointArt` field is
// `{fileID: 0}` on this prefab, and the two variants (`_small`, `_Race`) carry
// a frame and nothing else. The shipped scene agrees: `int_01_hoverJet.unity`
// holds exactly 21 of each prefab object and no gate-related name the prefab
// does not have. The video frames agree too — every gate in them is an open
// outline you can see the mountain through.
//
// So: Classic draws the bare frame 2016 drew, this is behind
// `gameplay.gateBullseye.enabled`, and it is zeroed twice over in the house
// style — see `radiusFor` below.
//
// ── THE RADIUS IS NOT A NUMBER WE PICKED ──────────────────────────────────
//
// Matt asked for art to *"show players where to aim"*, and the game already has
// a rule about where to aim: G2's CLEAN (DEV-110). `sim/gate-quality.ts` scores
// `centredness = 1 − distance / radius` against the gate's OWN trigger radius,
// and `gameplay.gateEvents.cleanCentredness` is the bar. So the circle a player
// is being asked to hit has a radius, in metres, already:
//
//     cleanRadius = trigger.radius × (1 − cleanCentredness)
//
// 22.62 × 0.4 = **9.05 m** on `int_01`. That is what this draws, and drawing it
// is the same posture as the chain meter one flag over: *"no numbers of its own
// on purpose — it draws what `sim/speed-chain.ts` already holds, so it cannot
// disagree with the mechanic it is reporting."* A course with tighter rings gets
// a tighter reticle for free, and if anyone ever re-tunes `cleanCentredness` the
// art follows without being re-authored.
//
// **And it is in the `gameplay` block rather than beside the render flags** for
// exactly the reason `chainMeter` is: it changes no score, and a player who can
// see where CLEAN is flies differently, which is a change to the game even when
// the arithmetic is untouched.
//
// ── Why FOUR BARS AND A PIP rather than a disc or a ring ──────────────────
//
// 1. **You fly through it.** A filled disc across a 24 × 35 m hole is a wall in
//    the one place the player is looking, and the gate's whole silhouette is
//    "an opening you can see the far side of".
// 2. **It has to survive being small.** A gate is a few degrees wide at the
//    distance you commit to a line from, and DEV-044's lesson is that a thing
//    too small has not been reviewed, it has been rendered. A thin torus is
//    exactly the shape that aliases away first. Four chunky marks hold their
//    pixels and merge into a suggestion of a circle at range.
// 3. **The gate is ALREADY MADE OF BARS.** 18 white-teal bars on a green frame
//    is the object's own vocabulary; four more, in the same material, cannot
//    read as a foreign thing bolted on. Nothing new is imported, nothing is
//    derived from bought geometry, and no Unity shader is translated — the
//    marks are `BoxGeometry` and the colour is the one the sheet already has
//    for the studs (hard rule 7).
// 4. **It does not fight what else is on a gate.** DEV-108's pulse is pinned at
//    or outside 0.3 UV radius, i.e. the periphery — the centre of the view is
//    the one place it never touches, which makes the middle of a gate the
//    CHEAPEST place to put something for a head rather than the worst.
//    DEV-124's next-gate arrow hides once the target is inside its cone, so it
//    vacates the centre exactly when this appears. DEV-123's finish banner owns
//    the top edge. Nothing already occupies the aperture.
//
// ── The CENTRE is the trigger's, not the frame's ──────────────────────────
//
// `trigger_checkpoint` sits at prefab-local (−0.069, −0.571, −0.728) under its
// own rotation, so the sphere the rule measures from is NOT at the middle of the
// hole you look through. `gateCentredness` is measured against `gate.centre` —
// `ring.trigger.pos` in the level JSON — so a reticle drawn at the frame's
// visual centre would be showing the player the wrong point to aim at, by
// whatever that offset works out to in world metres. It is drawn at the
// trigger's centre for that reason, and `gate-bullseye.test.ts` prints the
// offset rather than assuming it is negligible.
//
// SIM-FREE but three-aware: this is `src/game/`, the same layer `rings.ts` is.

import * as THREE from 'three'

/** Everything the reticle is tuned by — `edition.gameplay.gateBullseye`. */
export interface GateBullseyeSpec {
  readonly enabled: boolean
  /**
   * The mark's length along the radius, as a FRACTION of the clean radius.
   * A fraction rather than metres so a course with tighter rings scales.
   */
  readonly markLength: number
  /** The mark's cross-section, as a fraction of the clean radius. */
  readonly markThickness: number
  /** The centre pip's side, as a fraction of the clean radius. 0 draws no pip. */
  readonly pipSize: number
  /** Emissive intensity. The studs' own is 2; this sits beside them. */
  readonly emissive: number
}

/** How many boxes one gate's reticle costs. Four marks and a pip. */
export const BULLSEYE_INSTANCES = 5

/**
 * The radius the rule uses, in METRES: `trigger.radius × (1 − cleanCentredness)`.
 *
 * **Zeroed twice over, in the house style.** Classic's `cleanCentredness` is 1 —
 * a gate taken through the mathematical centre, which nothing reaches — and 1
 * makes this 0, so even a hand-edited preset that flips only the `enabled`
 * boolean draws a reticle of no size. A non-finite or out-of-range threshold
 * answers 0 for the same reason rather than throwing in a loader.
 */
export const cleanRadius = (triggerRadius: number, cleanCentredness: number): number => {
  if (!Number.isFinite(triggerRadius) || !Number.isFinite(cleanCentredness)) return 0
  const r = triggerRadius * (1 - cleanCentredness)
  return r > 0 ? r : 0
}

/**
 * The five poses of one reticle in a RETICLE-LOCAL frame: origin at the aim
 * point, x and y spanning the gate's aperture, z the axis you fly along, and
 * one unit = one metre.
 *
 * Local rather than world so the caller composes them the way `rings.ts`
 * already composes the studs — and so DEV-122's shrink, which scales in the
 * gate's own frame, carries the reticle along for free instead of needing a
 * second rule.
 *
 * The four marks point INWARD from the clean radius: each is a bar
 * `markLength × radius` long along the radius it lies on and `markThickness ×
 * radius` across, with its OUTER end ON the circle. So the gap between opposite
 * marks IS the circle's diameter — the eye reads the ring the marks are the
 * ends of, which is the thing the rule is about, without a ring being drawn.
 *
 * ALWAYS five, even when `pipSize` is 0: the fifth is then a zero-scale box,
 * which is a degenerate triangle set that draws nothing. DEV-122 already
 * relies on that being true, and a stable instance count means the caller never
 * has to keep a second bookkeeping array in step with a spec.
 */
export const bullseyePoses = (radius: number, spec: GateBullseyeSpec): THREE.Matrix4[] => {
  const r = radius > 0 ? radius : 0
  const len = spec.markLength * r
  const thick = spec.markThickness * r
  // 12, 3, 6 and 9 o'clock in the aperture plane.
  const at = r - len / 2
  const dirs: readonly [number, number][] = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ]
  const out = dirs.map(([dx, dy]) => {
    const alongX = dx !== 0
    return new THREE.Matrix4().compose(
      new THREE.Vector3(dx * at, dy * at, 0),
      new THREE.Quaternion(),
      // The bar is LONG along the radius it lies on, and that is expressed as a
      // SCALE rather than as a rotation: a unit box scaled (len, thick, thick)
      // is the same object as one scaled (thick, len, thick) and turned 90°,
      // and a scale cannot be wrong about which way round it is. The
      // orientation lesson — test the geometry, not the rotation.
      new THREE.Vector3(alongX ? len : thick, alongX ? thick : len, thick),
    )
  })
  const pip = spec.pipSize > 0 ? spec.pipSize * r : 0
  out.push(
    new THREE.Matrix4().compose(
      new THREE.Vector3(),
      new THREE.Quaternion(),
      new THREE.Vector3(pip, pip, pip),
    ),
  )
  return out
}
